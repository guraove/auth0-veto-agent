import { createRemoteJWKSet, jwtVerify } from 'jose'
import { FlowError } from './proposals.mjs'

export function createIntegrations(config) {
  const issuer = `https://${config.domain}/`
  const jwks = createRemoteJWKSet(new URL('.well-known/jwks.json', issuer))
  async function auth0Token(body) {
    const response = await fetch(new URL('oauth/token', issuer), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    })
    const result = await response.json()
    if (!response.ok && !result.error) throw new Error('Auth0 token endpoint unavailable')
    return result
  }
  async function providerToken(callerToken) {
    const result = await auth0Token({ client_id: config.vaultClientId, client_secret: config.vaultClientSecret,
      grant_type: 'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token',
      subject_token: callerToken, subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      requested_token_type: 'http://auth0.com/oauth/token-type/federated-connection-access-token', connection: config.connection })
    if (!result.access_token) throw new FlowError('Token Vault exchange failed. Connect GitHub and check the Custom API Client configuration.', 502)
    return result.access_token
  }
  async function github(callerToken, method) {
    const token = await providerToken(callerToken)
    const response = await fetch(`https://api.github.com/repos/${config.repo}/issues/${config.issueNumber}`, {
      method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28', ...(method === 'PATCH' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'PATCH' ? { body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) } : {}),
      signal: AbortSignal.timeout(15000), redirect: 'error',
    })
    if (!response.ok) throw new FlowError('GitHub request failed. Check the configured demo issue and connected account permissions.', 502)
    const data = await response.json()
    if (data.pull_request || data.number !== config.issueNumber) throw new FlowError('Target is not the configured demo issue.', 409)
    return { number: data.number, title: data.title, state: data.state, html_url: data.html_url }
  }
  return {
    readIssue: token => github(token, 'GET'),
    executeClose: token => github(token, 'PATCH'),
    async requestApproval({ sub, details, bindingMessage }) {
      const body = new URLSearchParams({ client_id: config.cibaClientId, client_secret: config.cibaClientSecret,
        login_hint: JSON.stringify({ format: 'iss_sub', iss: issuer, sub }), audience: config.audience,
        scope: 'openid', binding_message: bindingMessage, requested_expiry: String(config.expiry),
        authorization_details: JSON.stringify(details) })
      const response = await fetch(new URL('bc-authorize', issuer), { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new FlowError('Auth0 rejected the CIBA request.', 502)
      return response.json()
    },
    pollApproval: authReqId => auth0Token({ client_id: config.cibaClientId, client_secret: config.cibaClientSecret,
      grant_type: 'urn:openid:params:grant-type:ciba', auth_req_id: authReqId }),
    async verifyApprovalToken(token) {
      if (typeof token !== 'string') throw new Error('Missing approval token')
      const { payload } = await jwtVerify(token, jwks, { issuer, audience: config.audience,
        algorithms: ['RS256'], requiredClaims: ['sub', 'iat', 'exp'] })
      return payload
    },
  }
}
