import test from 'node:test'
import assert from 'node:assert/strict'
import { createProposalService } from '../server/proposals.mjs'

function fixture(overrides = {}) {
  let time = 100000, details, writes = 0, polls = 0, starts = 0
  const deps = {
    repo: 'owner/demo', issueNumber: 7, now: () => time,
    requestApproval: async input => { details = input.details; starts++; return { auth_req_id: 'private-request-id', expires_in: 30, interval: 5 } },
    pollApproval: async () => { polls++; return { error: 'authorization_pending' } },
    verifyApprovalToken: async () => ({ sub: 'user-a' }),
    executeClose: async token => { assert.equal(token, 'caller-token'); writes++; return { number: 7, state: 'closed' } },
    ...overrides,
  }
  return { service: createProposalService(deps), advance: ms => { time += ms },
    details: () => details, counts: () => ({ writes, polls, starts }) }
}
// Dependencies are captured when the service is created, so use a mutable response for approval tests.
function approvalFixture(overrides = {}) {
  let response = { error: 'authorization_pending' }, requested
  const f = fixture({ requestApproval: async input => { requested = input.details; return { auth_req_id: 'private', expires_in: 30, interval: 5 } },
    pollApproval: async () => response, ...overrides })
  return { ...f, respond: value => { response = value }, approve: () => { response = { access_token: 'ciba-token', authorization_details: requested } }, details: () => requested }
}
test('pending does not write; private request and identity are not in browser result', async () => {
  const f = fixture(), p = await f.service.start('user-a')
  assert.equal(p.state, 'pending'); assert.equal(JSON.stringify(p).includes('private-request-id'), false)
  assert.equal(JSON.stringify(p).includes('user-a'), false)
  f.advance(5000)
  assert.equal((await f.service.poll(p.id, 'user-a', 'caller-token')).state, 'pending')
  assert.equal(f.counts().writes, 0)
})
test('server enforces minimum poll interval and collapses duplicate start', async () => {
  const f = fixture(), p = await f.service.start('user-a')
  assert.equal((await f.service.start('user-a')).id, p.id)
  await f.service.poll(p.id, 'user-a', 'caller-token')
  assert.deepEqual(f.counts(), { starts: 1, polls: 0, writes: 0 })
})
test('proposal ownership is mandatory', async () => {
  const f = fixture(), p = await f.service.start('user-a')
  await assert.rejects(f.service.poll(p.id, 'user-b', 'caller-token'), { status: 404 })
})
for (const [error, state] of [['access_denied', 'denied'], ['expired_token', 'expired'], ['invalid_grant', 'failed']]) {
  test(`${error} is terminal and never writes`, async () => {
    const f = approvalFixture(), p = await f.service.start('user-a')
    f.respond({ error }); f.advance(5000)
    assert.equal((await f.service.poll(p.id, 'user-a', 'caller-token')).state, state)
    f.approve(); f.advance(5000); await f.service.poll(p.id, 'user-a', 'caller-token')
    assert.equal(f.counts().writes, 0)
  })
}
test('local expiry prevents polling and execution', async () => {
  const f = approvalFixture(), p = await f.service.start('user-a')
  f.approve(); f.advance(30000)
  assert.equal((await f.service.poll(p.id, 'user-a', 'caller-token')).state, 'expired')
  assert.equal(f.counts().writes, 0)
})
test('expiry during token verification still prevents the write', async () => {
  const f = approvalFixture({ verifyApprovalToken: async () => { f.advance(30000); return { sub: 'user-a' } } })
  const p = await f.service.start('user-a'); f.approve(); f.advance(5000)
  assert.equal((await f.service.poll(p.id, 'user-a', 'caller-token')).state, 'expired')
  assert.equal(f.counts().writes, 0)
})
test('slow_down increases the server poll interval', async () => {
  const f = approvalFixture(), p = await f.service.start('user-a')
  f.respond({ error: 'slow_down' }); f.advance(5000)
  const slowed = await f.service.poll(p.id, 'user-a', 'caller-token')
  assert.equal(slowed.nextPollAt, 115000)
})
test('a valid approval closes once; replay is inert', async () => {
  const f = approvalFixture(), p = await f.service.start('user-a')
  f.approve(); f.advance(5000)
  const result = await f.service.poll(p.id, 'user-a', 'caller-token')
  assert.equal(result.state, 'closed'); assert.equal(f.counts().writes, 1)
  await f.service.poll(p.id, 'user-a', 'caller-token')
  assert.equal(f.counts().writes, 1)
})
test('a different approval subject never writes', async () => {
  const f = approvalFixture({ verifyApprovalToken: async () => ({ sub: 'user-b' }) }), p = await f.service.start('user-a')
  f.approve(); f.advance(5000)
  assert.equal((await f.service.poll(p.id, 'user-a', 'caller-token')).state, 'failed')
  assert.equal(f.counts().writes, 0)
})
for (const field of ['repo', 'issue_number', 'proposal_id', 'actions']) {
  test(`a changed ${field} never writes`, async () => {
    const f = approvalFixture(), p = await f.service.start('user-a')
    f.respond({ access_token: 'ciba-token', authorization_details: [{ ...f.details()[0], [field]: 'tampered' }] })
    f.advance(5000)
    assert.equal((await f.service.poll(p.id, 'user-a', 'caller-token')).state, 'failed')
    assert.equal(f.counts().writes, 0)
  })
}
test('invalid JWT verification never writes', async () => {
  const f = approvalFixture({ verifyApprovalToken: async () => { throw new Error('bad signature') } }), p = await f.service.start('user-a')
  f.approve(); f.advance(5000)
  assert.equal((await f.service.poll(p.id, 'user-a', 'caller-token')).state, 'failed')
  assert.equal(f.counts().writes, 0)
})
test('an uncertain GitHub response is terminal and never retried', async () => {
  let attempts = 0
  const f = approvalFixture({ executeClose: async () => { attempts++; throw new Error('timeout') } }), p = await f.service.start('user-a')
  f.approve(); f.advance(5000)
  assert.equal((await f.service.poll(p.id, 'user-a', 'caller-token')).state, 'execution_unknown')
  await f.service.poll(p.id, 'user-a', 'caller-token'); assert.equal(attempts, 1)
})
test('concurrent polls cannot execute twice', async () => {
  let release, attempts = 0
  const gate = new Promise(resolve => { release = resolve })
  const f = approvalFixture({ executeClose: async () => { attempts++; await gate; return { number: 7, state: 'closed' } } }), p = await f.service.start('user-a')
  f.approve(); f.advance(5000)
  const first = f.service.poll(p.id, 'user-a', 'caller-token')
  await Promise.resolve(); await Promise.resolve()
  const second = await f.service.poll(p.id, 'user-a', 'caller-token')
  assert.equal(second.state, 'executing'); release(); await first; assert.equal(attempts, 1)
})
test('CIBA request failure is a visible terminal result', async () => {
  const f = fixture({ requestApproval: async () => { throw new Error('unavailable') } })
  assert.equal((await f.service.start('user-a')).state, 'failed'); assert.equal(f.counts().writes, 0)
})
