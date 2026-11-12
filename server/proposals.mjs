import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export class FlowError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

// The browser never receives auth_req_id, tokens, client credentials, or an approve endpoint.
export function createProposalService({ repo, issueNumber, requestApproval, pollApproval,
  verifyApprovalToken, executeClose, now = Date.now }) {
  const proposals = new Map()
  const terminal = new Set(['closed', 'denied', 'expired', 'failed', 'execution_unknown'])
  function view(p) {
    return { id: p.id, repo, issueNumber, state: p.state, message: p.message,
      expiresAt: p.expiresAt, nextPollAt: p.nextPollAt, issueUrl: `https://github.com/${repo}/issues/${issueNumber}` }
  }
  function expire(p) {
    if (!terminal.has(p.state) && !p.busy && p.expiresAt && now() >= p.expiresAt) {
      p.state = 'expired'; p.message = 'Approval expired. No GitHub write was sent.'
    }
  }
  return {
    async start(sub) {
      for (const old of proposals.values()) {
        expire(old)
        if (old.sub === sub && !terminal.has(old.state)) return view(old)
      }
      // Bound memory in this single-process development demo.
      for (const [id, old] of proposals) {
        if (terminal.has(old.state) && now() - old.createdAt > 86400000) proposals.delete(id)
      }
      if (proposals.size >= 1000) throw new FlowError('Proposal capacity reached.', 429)
      const id = randomUUID()
      const details = [{ type: 'github_issue_close', actions: ['close'], repo,
        issue_number: issueNumber, proposal_id: id }]
      const p = { id, sub, details, createdAt: now(), state: 'requesting', busy: true,
        message: 'Requesting an out-of-band approval.' }
      proposals.set(id, p)
      try {
        const result = await requestApproval({ sub, details, bindingMessage: `Close issue ${issueNumber}:${id.slice(0, 8)}` })
        if (!result.auth_req_id || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Error('Invalid approval response')
        p.authReqId = result.auth_req_id
        p.interval = Math.max(5, Number(result.interval) || 5) * 1000
        p.expiresAt = now() + result.expires_in * 1000
        p.nextPollAt = now() + p.interval
        p.state = 'pending'; p.message = 'Waiting for approval outside this conversation.'
      } catch {
        p.state = 'failed'; p.message = 'Auth0 could not start CIBA. Check tenant/channel configuration.'
      } finally { p.busy = false }
      return view(p)
    },
    async poll(id, sub, callerToken) {
      const p = proposals.get(id)
      if (!p || p.sub !== sub) throw new FlowError('Proposal not found.', 404)
      expire(p)
      if (terminal.has(p.state) || p.busy || now() < p.nextPollAt) return view(p)
      p.busy = true
      p.nextPollAt = now() + p.interval
      try {
        const result = await pollApproval(p.authReqId)
        if (now() >= p.expiresAt) { p.state = 'expired'; p.message = 'Approval expired. No GitHub write was sent.'; return view(p) }
        if (result.error === 'authorization_pending') return view(p)
        if (result.error === 'slow_down') { p.interval += 5000; p.nextPollAt = now() + p.interval; return view(p) }
        if (result.error) {
          p.state = result.error === 'access_denied' ? 'denied' : result.error === 'expired_token' ? 'expired' : 'failed'
          p.message = 'Approval did not succeed. No GitHub write was sent.'
          return view(p)
        }
        const claims = await verifyApprovalToken(result.access_token)
        if (claims.sub !== p.sub || !isDeepStrictEqual(result.authorization_details, p.details)) {
          throw new Error('Approval subject or operation mismatch')
        }
        if (now() >= p.expiresAt) { p.state = 'expired'; p.message = 'Approval expired. No GitHub write was sent.'; return view(p) }
        // Claim exactly once before a potentially ambiguous network write. Never retry it automatically.
        p.state = 'executing'; p.message = 'Approved by Auth0. Closing the configured demo issue.'
        try {
          const issue = await executeClose(callerToken)
          if (issue.number !== issueNumber || issue.state !== 'closed') throw new Error('Unexpected GitHub result')
          p.state = 'closed'; p.message = 'The demo issue was closed after out-of-band approval.'
        } catch {
          p.state = 'execution_unknown'; p.message = 'GitHub result is uncertain. Inspect the issue; this proposal will not send another write.'
        }
      } catch {
        p.state = 'failed'; p.message = 'Approval validation failed. No GitHub write was sent.'
      } finally { p.busy = false }
      return view(p)
    },
  }
}
