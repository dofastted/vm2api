import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { RefusalSessionBlocksRepo } from '../../src/lib/db/repos/refusal-session-blocks-repo.mjs'
import {
  REFUSAL_SESSION_BLOCK_SETTING,
  applyRefusalGuardPatch,
  matchRefusalSession,
  refusalGuardPolicy,
  refusalSessionId,
} from '../../src/lib/core/refusal-guard.mjs'
import { commitProtocolBlock, evaluateProtocolIntercept } from '../../src/lib/protocol/intercept-gate.mjs'

const SESSION = '2a3dcf96-1acf-47e6-b905-6ad739f8a010'

function req(text, extra = {}) {
  return {
    model: 'claude-opus-5-5',
    max_tokens: 64,
    messages: [{ role: 'user', content: text }],
    ...extra,
  }
}

async function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refusal-session-'))
  const db = createDatabase({ dataDir: dir })
  try {
    return await fn(db)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function memorySettings(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    set: (key, value) => store.set(key, value),
  }
}

test('session id comes from the Claude Code session header', () => {
  assert.equal(refusalSessionId({ inbound: req('hi'), headers: { 'x-claude-code-session-id': SESSION } }), SESSION)
})

test('a sub-agent hop maps back to its root session', () => {
  const headers = { 'x-claude-code-session-id': SESSION, 'x-claude-code-agent-id': 'agent-7' }
  assert.equal(refusalSessionId({ inbound: req('hi'), headers }), SESSION)
})

test('no session or a too-short id yields no key', () => {
  assert.equal(refusalSessionId({ inbound: req('hi'), headers: {} }), '')
  assert.equal(refusalSessionId({ inbound: req('hi'), headers: { 'x-claude-code-session-id': 'abc' } }), '')
})

test('session block policy defaults on and is independent of the prompt guard switch', () => {
  const policy = refusalGuardPolicy(memorySettings({ refusal_guard_enabled: false }).get)
  assert.equal(policy.enabled, false)
  assert.equal(policy.session_block_enabled, true)
  const off = refusalGuardPolicy(memorySettings({ [REFUSAL_SESSION_BLOCK_SETTING]: false }).get)
  assert.equal(off.session_block_enabled, false)
})

test('panel patch toggles the session block and rejects non-booleans', () => {
  const settings = memorySettings()
  assert.equal(applyRefusalGuardPatch(settings, { session_block_enabled: false }).ok, true)
  assert.equal(settings.get(REFUSAL_SESSION_BLOCK_SETTING), false)
  assert.equal(applyRefusalGuardPatch(settings, { session_block_enabled: 'no' }).ok, false)
})

test('a blocked session is refused before any other layer, with a new prompt and the prompt guard off', async () => {
  await withDb(async (db) => {
    const sessions = new RefusalSessionBlocksRepo(db)
    sessions.block({ sessionId: SESSION, requestId: 'r1', model: 'claude-opus-5-5', preview: 'museum layout' })
    const headers = { 'x-claude-code-session-id': SESSION }
    const inbound = req('a completely different follow-up turn')
    const policy = { enabled: false, session_block_enabled: true }
    const decision = await evaluateProtocolIntercept({
      inbound,
      body: inbound,
      headers,
      policy,
      sessions,
      requestId: 'r2',
    })
    assert.equal(decision.action, 'block')
    assert.equal(decision.kind, 'session')
    assert.equal(decision.final_state, 'refusal_session')
    assert.equal(decision.error.status, 400)
    assert.equal(decision.error.body.error.details.blocked_by, 'session')
    assert.equal(decision.error.body.error.details.retryable, false)
    commitProtocolBlock(decision, { sessions, policy, requestId: 'r2' })
    assert.equal(sessions.get(SESSION).hit_count, 1)
  })
})

test('sub-agent hops of a blocked session are blocked too; other sessions pass', async () => {
  await withDb(async (db) => {
    const sessions = new RefusalSessionBlocksRepo(db)
    sessions.block({ sessionId: SESSION })
    const inbound = req('sub-agent task')
    const policy = { enabled: false, session_block_enabled: true }
    const sub = await evaluateProtocolIntercept({
      inbound,
      body: inbound,
      headers: { 'x-claude-code-session-id': SESSION, 'x-claude-code-agent-id': 'agent-1' },
      policy,
      sessions,
      requestId: 'r3',
    })
    assert.equal(sub.kind, 'session')
    const other = matchRefusalSession({
      inbound,
      headers: { 'x-claude-code-session-id': 'ffffffff-1111-4222-8333-444444444444' },
      sessions,
    })
    assert.equal(other, null)
  })
})

test('switching the session block off lets the session through', async () => {
  await withDb(async (db) => {
    const sessions = new RefusalSessionBlocksRepo(db)
    sessions.block({ sessionId: SESSION })
    const inbound = req('next turn')
    const decision = await evaluateProtocolIntercept({
      inbound,
      body: inbound,
      headers: { 'x-claude-code-session-id': SESSION },
      policy: { enabled: false, session_block_enabled: false },
      sessions,
      requestId: 'r4',
    })
    assert.notEqual(decision.kind, 'session')
  })
})

test('repo keeps the first source, counts hits, removes and clears', async () => {
  await withDb((db) => {
    const sessions = new RefusalSessionBlocksRepo(db)
    sessions.block({ sessionId: SESSION, requestId: 'first', accountId: 'acct-1' })
    sessions.block({ sessionId: SESSION, requestId: 'second', accountId: 'acct-2' })
    const row = sessions.get(SESSION)
    assert.equal(row.source_request_id, 'first')
    assert.equal(row.account_id, 'acct-1')
    sessions.hit(SESSION)
    assert.equal(sessions.get(SESSION).hit_count, 1)
    assert.equal(sessions.count(), 1)
    assert.equal(sessions.remove(SESSION), true)
    assert.equal(sessions.get(SESSION), null)
    sessions.block({ sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })
    assert.equal(sessions.clear(), 1)
  })
})

test('an auto-mode classifier refusal stays on that request; the conversation itself still blocks', async () => {
  const { refusalSessionBlockDecision } = await import('../../src/lib/protocol/handle-protocol.mjs')
  const classifier = { purpose: 'auto_mode_classifier', format: 'xml', stage: 'xml_s2' }
  for (const reason of ['upstream:usage_policy', 'upstream:flagged_session']) {
    assert.deepEqual(refusalSessionBlockDecision(reason, classifier), { block: false, skipped: 'auto_mode_classifier' })
    assert.deepEqual(refusalSessionBlockDecision(reason, null), { block: true })
  }
  for (const reason of ['', 'upstream:billing_refusal', 'upstream:configured_policy']) {
    assert.deepEqual(refusalSessionBlockDecision(reason, classifier), { block: false })
    assert.deepEqual(refusalSessionBlockDecision(reason, null), { block: false })
  }
})
