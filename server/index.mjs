import express from 'express'
import { auth } from 'express-oauth2-jwt-bearer'
import { createIntegrations } from './integrations.mjs'
import { createProposalService, FlowError } from './proposals.mjs'

const config = {
  domain: process.env.VITE_AUTH0_DOMAIN, audience: process.env.AUTH0_AUDIENCE,
  vaultClientId: process.env.TOKEN_VAULT_CLIENT_ID, vaultClientSecret: process.env.TOKEN_VAULT_CLIENT_SECRET,
  cibaClientId: process.env.CIBA_CLIENT_ID, cibaClientSecret: process.env.CIBA_CLIENT_SECRET,
  connection: process.env.VITE_GITHUB_CONNECTION || 'github-veto',
  repo: process.env.GITHUB_DEMO_REPO || 'guraove/auth0-veto-agent',
  issueNumber: Number(process.env.GITHUB_DEMO_ISSUE_NUMBER), expiry: Number(process.env.CIBA_REQUESTED_EXPIRY || 300),
}
if (!config.domain || !config.audience) throw new Error('Auth0 domain and API audience are required.')
if (!/^[a-zA-Z0-9.-]+$/.test(config.domain)) throw new Error('Invalid Auth0 domain.')
if (!/^[\w.-]+\/[\w.-]+$/.test(config.repo)) throw new Error('Invalid demo repository.')
const ready = !!(config.vaultClientId && config.vaultClientSecret && config.cibaClientId && config.cibaClientSecret
  && Number.isSafeInteger(config.issueNumber) && config.issueNumber > 0 && config.expiry > 0 && config.expiry <= 259200)
const integrations = createIntegrations(config)
const proposals = createProposalService({ ...config, ...integrations })
const app = express()
app.disable('x-powered-by')
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
app.use('/api', auth({ issuerBaseURL: `https://${config.domain}/`, audience: config.audience, tokenSigningAlg: 'RS256' }))
app.use('/api', (req, _res, next) => {
  if (!req.auth?.payload.sub) return next(new FlowError('A user subject is required.', 401))
  next()
})
app.get('/api/config', (_req, res) => res.json({ ready, repo: config.repo, issueNumber: config.issueNumber || null,
  channel: config.expiry > 300 ? 'email' : 'guardian-push' }))
app.use('/api', (_req, _res, next) => ready ? next() : next(new FlowError('Setup required: Token Vault, CIBA client, channel and demo issue.', 503)))
const bearer = req => req.headers.authorization.slice(7)
// No client-supplied repository, issue, subject, approval decision or authorization details are accepted.
app.get('/api/issue', async (req, res) => res.json(await integrations.readIssue(bearer(req))))
app.post('/api/proposals', async (req, res) => {
  const issue = await integrations.readIssue(bearer(req))
  if (issue.state !== 'open') throw new FlowError('The demo issue is already closed.', 409)
  res.status(202).json(await proposals.start(req.auth.payload.sub))
})
app.post('/api/proposals/:id/poll', async (req, res) => res.json(await proposals.poll(req.params.id, req.auth.payload.sub, bearer(req))))
app.use((err, _req, res, _next) => res.status(err.status || 500).json({
  error: err.status === 401 ? 'A valid Auth0 user access token is required.' : err instanceof FlowError ? err.message : 'Service request failed.',
}))
app.listen(3001, '127.0.0.1', () => console.log(`Veto API http://127.0.0.1:3001 — integrations ${ready ? 'configured' : 'awaiting setup'}`))
