import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { RefusalDeviceBlocksRepo } from '../../src/lib/db/repos/refusal-device-blocks-repo.mjs'
import { RefusalSessionBlocksRepo } from '../../src/lib/db/repos/refusal-session-blocks-repo.mjs'
import { sanitizeErrorDetailsForLog } from '../../src/lib/core/errors.mjs'
import {
  REFUSAL_SESSION_BLOCK_SETTING,
  UPSTREAM_400_CATEGORIES,
  UPSTREAM_400_SESSION_BLOCK_MS,
  UPSTREAM_400_SESSION_REASON,
  UPSTREAM_500_SESSION_REASON,
  UPSTREAM_ERROR_CATEGORIES,
  UPSTREAM_ERROR_REPEAT_WINDOW_MS,
  applyRefusalGuardPatch,
  classifyUpstream400,
  classifyUpstreamErrorForSessionBlock,
  matchRefusalSession,
  refusalGuardPolicy,
  refusalSessionId,
  upstream400CategoryFromReason,
  upstream400ReasonFor,
  upstreamErrorCategoryFromReason,
  upstreamErrorReasonFor,
} from '../../src/lib/core/refusal-guard.mjs'
import { createGeminiPublicHandler } from '../../src/lib/gemini/routes.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import {
  clearUpstreamSessionErrorStrikes,
  commitProtocolBlock,
  evaluateProtocolIntercept,
  observeUpstreamRisk,
  recordUpstream400SessionBlock,
  recordUpstreamErrorSessionBlock,
  runProtocolIntercept,
} from '../../src/lib/protocol/intercept-gate.mjs'

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

test('recoverable upstream 400 blocks session for 10m on 2nd consecutive hit, counts intercepted hits, isolates tenants/devices, and expires cleanly', async () => {
  await withDb(async (db) => {
    const devices = new RefusalDeviceBlocksRepo(db)
    const start = Date.parse('2026-11-28T10:00:00.000Z')
    const headers = { 'x-claude-code-session-id': SESSION, 'x-machine-id': 'dev-400-1' }
    const inbound = req('turn causing upstream 400')
    const policyOff = { enabled: false, device_block_enabled: false, session_block_enabled: true }
    const identity = { deviceId: 'dev-400-1', sessionId: '', principal: 'user:tenant-a' }

    // 1st hit of a Tier-2 recoverable error (tool_pair_broken) records strike 1/2 without blocking yet.
    const logBag1 = {}
    const reason1 = observeUpstreamRisk({
      inbound,
      body: inbound,
      headers,
      identity,
      result: { status: 400, body: { error: { type: 'invalid_request_error', message: 'invalid tool_use_id' } } },
      logBag: logBag1,
      requestId: 'req-400-1',
      policy: policyOff,
      devices,
      now: start,
    })
    assert.equal(reason1, '')
    assert.equal(logBag1.audit_upstream_400, true)
    assert.equal(logBag1.error_details.upstream_400_category, 'tool_pair_broken')
    assert.equal(logBag1.error_details.upstream_error_category, 'tool_pair_broken')
    assert.equal(logBag1.error_details.upstream_400_action, 'strike_1_of_2')
    assert.equal(logBag1.error_details.upstream_error_action, 'strike_1_of_2')
    assert.equal(devices.findBan({ ...identity, sessionId: SESSION }, start), null)

    // 2nd consecutive hit within 5m persists the 10m session block.
    const secondAt = start + 1_000
    const logBag2 = {}
    const reason2 = observeUpstreamRisk({
      inbound,
      body: inbound,
      headers,
      identity,
      result: { status: 400, body: { error: { type: 'invalid_request_error', message: 'invalid tool_use_id' } } },
      logBag: logBag2,
      requestId: 'req-400-1b',
      policy: policyOff,
      devices,
      now: secondAt,
    })
    assert.equal(reason2, '')
    assert.equal(logBag2.audit_upstream_400, true)
    assert.equal(logBag2.error_details.punishment, 'session_10m_400')
    assert.equal(logBag2.error_details.upstream_400_category, 'tool_pair_broken')
    assert.equal(logBag2.error_details.upstream_400_action, 'session_10m')

    const stored = devices.findBan({ ...identity, sessionId: SESSION }, secondAt)
    assert.ok(stored)
    assert.equal(stored.subject_kind, 'session')
    assert.equal(stored.reason, upstream400ReasonFor('tool_pair_broken'))
    assert.equal(stored.violations, 1)
    assert.equal(stored.hit_count, 0)
    assert.equal(stored.expires_at, new Date(secondAt + UPSTREAM_400_SESSION_BLOCK_MS).toISOString())

    // Subsequent retries (including sub-agent hops) are blocked even with refusal guard / device block disabled,
    // and each intercepted attempt increments hit_count.
    const d1 = await runProtocolIntercept({
      inbound: req('client retry #1'),
      body: req('client retry #1'),
      headers,
      identity,
      policy: policyOff,
      devices,
      requestId: 'req-400-2',
      now: secondAt + 5_000,
    })
    assert.equal(d1.action, 'block')
    assert.equal(d1.final_state, 'refusal_session')
    assert.equal(d1.error.status, 400)
    assert.equal(d1.error.body.error.code, 'refusal_guard')
    assert.equal(d1.error.body.error.details.blocked_by, 'session')
    assert.equal(d1.error.body.error.details.upstream_400_category, 'tool_pair_broken')
    assert.equal(d1.error.body.error.details.upstream_error_category, 'tool_pair_broken')
    assert.match(d1.error.body.error.message, /工具调用历史配对损坏/)
    assert.equal(d1.error.body.error.details.retryable, false)
    assert.equal(d1.error.body.error.details.expires_at, stored.expires_at)
    assert.equal(devices.get(stored.device_id).hit_count, 1)

    const dSub = await runProtocolIntercept({
      inbound: req('sub-agent retry #2'),
      body: req('sub-agent retry #2'),
      headers: { ...headers, 'x-claude-code-agent-id': 'agent-sub-9' },
      identity,
      policy: policyOff,
      devices,
      requestId: 'req-400-3',
      now: secondAt + UPSTREAM_400_SESSION_BLOCK_MS - 1,
    })
    assert.equal(dSub.action, 'block')
    assert.equal(dSub.final_state, 'refusal_session')
    assert.equal(devices.get(stored.device_id).hit_count, 2)

    // Same device with a different session passes; different tenant with the same session passes.
    const otherSession = await runProtocolIntercept({
      inbound: req('fresh session'),
      body: req('fresh session'),
      headers: { 'x-claude-code-session-id': 'ffffffff-1111-4222-8333-444444444444', 'x-machine-id': 'dev-400-1' },
      identity,
      policy: policyOff,
      devices,
      requestId: 'req-other-sess',
      now: secondAt + 10_000,
    })
    assert.equal(otherSession.action, 'pass')

    const otherTenant = await runProtocolIntercept({
      inbound: req('same session on other tenant'),
      body: req('same session on other tenant'),
      headers,
      identity: { deviceId: 'dev-400-1', sessionId: '', principal: 'user:tenant-b' },
      policy: policyOff,
      devices,
      requestId: 'req-other-tenant',
      now: secondAt + 10_000,
    })
    assert.equal(otherTenant.action, 'pass')

    // Disabling session_block_enabled lets the session pass.
    const disabled = await runProtocolIntercept({
      inbound: req('session block off'),
      body: req('session block off'),
      headers,
      identity,
      policy: { enabled: false, device_block_enabled: false, session_block_enabled: false },
      devices,
      requestId: 'req-disabled',
      now: secondAt + 10_000,
    })
    assert.equal(disabled.action, 'pass')

    // At exactly +10m, the temporary block expires automatically.
    const afterExpiry = await runProtocolIntercept({
      inbound: req('after 10m'),
      body: req('after 10m'),
      headers,
      identity,
      policy: policyOff,
      devices,
      requestId: 'req-after-expiry',
      now: secondAt + UPSTREAM_400_SESSION_BLOCK_MS,
    })
    assert.equal(afterExpiry.action, 'pass')

    // A Tier-1 immediate 400 after expiry re-blocks immediately for 10m and increments violations (1 -> 2), keeping hit_count.
    const reblockedAt = secondAt + UPSTREAM_400_SESSION_BLOCK_MS + 1_000
    const reblocked = recordUpstream400SessionBlock({
      inbound,
      body: inbound,
      headers,
      identity,
      result: { status: 400, body: { error: { code: 'item_not_found', message: "Item with id 'rs_999' not found" } } },
      policy: policyOff,
      devices,
      requestId: 'req-400-again',
      now: reblockedAt,
    })
    assert.equal(reblocked.violations, 2)
    assert.equal(reblocked.hit_count, 2)
    assert.equal(reblocked.reason, upstream400ReasonFor('state_reference_invalid'))
    assert.equal(reblocked.expires_at, new Date(reblockedAt + UPSTREAM_400_SESSION_BLOCK_MS).toISOString())
  })
})

test('upstream 400 session block handles Codex prompt_cache_key, skips non-upstream/classifier cases, and never downgrades permanent bans', async () => {
  await withDb(async (db) => {
    const devices = new RefusalDeviceBlocksRepo(db)
    const start = Date.parse('2026-11-28T11:00:00.000Z')
    const codexBody = {
      model: 'gpt-5.4',
      prompt_cache_key: 'codex-cache-session-001',
      input: [{ role: 'user', content: 'hi' }],
    }
    const policy = { enabled: false, session_block_enabled: true }
    const principalIdentity = { principal: 'user:codex' }

    // Non-upstream / skipped cases must NOT create a block.
    assert.equal(
      recordUpstream400SessionBlock({
        inbound: codexBody,
        identity: principalIdentity,
        result: { status: 400, upstreamExecutions: 0 },
        policy,
        devices,
        now: start,
      }),
      null,
    )
    assert.equal(
      recordUpstream400SessionBlock({
        inbound: codexBody,
        identity: principalIdentity,
        result: { status: 400, transportError: true },
        policy,
        devices,
        now: start,
      }),
      null,
    )
    assert.equal(
      recordUpstream400SessionBlock({
        inbound: codexBody,
        identity: principalIdentity,
        result: { status: 400, via: 'kernel-preflight' },
        policy,
        devices,
        now: start,
      }),
      null,
    )
    assert.equal(
      recordUpstream400SessionBlock({
        inbound: codexBody,
        identity: principalIdentity,
        result: { status: 400 },
        classifier: { purpose: 'auto_mode_classifier' },
        policy,
        devices,
        now: start,
      }),
      null,
    )
    assert.equal(devices.count(), 0)

    // Real Tier-1 upstream 400 on Codex blocks immediately via prompt_cache_key.
    const ban = recordUpstream400SessionBlock({
      inbound: codexBody,
      identity: principalIdentity,
      result: {
        ok: false,
        status: 400,
        body: { error: { code: 'previous_response_not_found', message: 'previous_response_id resp_abc not found' } },
      },
      policy,
      devices,
      requestId: 'codex-400-1',
      now: start,
    })
    assert.equal(ban.subject_kind, 'session')
    assert.equal(ban.session_id, 'codex-cache-session-001')
    assert.equal(ban.reason, upstream400ReasonFor('state_reference_invalid'))

    const blocked = await runProtocolIntercept({
      inbound: codexBody,
      body: codexBody,
      identity: principalIdentity,
      policy,
      devices,
      requestId: 'codex-400-2',
      now: start + 1_000,
    })
    assert.equal(blocked.action, 'block')
    assert.equal(blocked.final_state, 'refusal_session')
    assert.equal(devices.get(ban.device_id).hit_count, 1)

    // Permanent session ban must never be downgraded to a 10m cooldown by a subsequent 400.
    const permIdentity = { deviceId: 'dev-perm', sessionId: 'perm-session-001', principal: 'user:perm' }
    devices.recordViolation(permIdentity, {
      requestId: 'perm-1',
      reason: 'jev:usage_policy',
      steps: [10, 60, 0],
      now: start,
    })
    const before = devices.findBan(permIdentity, start)
    assert.equal(before.subject_kind, 'session')
    assert.equal(before.expires_at, null)

    const permLogBag = {}
    const after = recordUpstream400SessionBlock({
      inbound: req('follow-up 400'),
      identity: permIdentity,
      result: { ok: false, status: 400, body: { error: { message: 'bad request' } } },
      logBag: permLogBag,
      policy,
      devices,
      requestId: 'perm-400',
      now: start + 2_000,
    })
    assert.equal(after.expires_at, null)
    assert.equal(after.reason, 'jev:usage_policy')
    assert.equal(permLogBag.error_details.upstream_400_action, 'permanent_kept')
  })
})

function makeMockRes() {
  const res = new EventEmitter()
  res.headers = {}
  res.statusCode = 200
  res.body = null
  res.headersSent = false
  res.writableEnded = false
  res.destroyed = false
  res.closed = false
  res.setHeader = (k, v) => {
    res.headers[String(k).toLowerCase()] = v
  }
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status
    res.headersSent = true
    for (const [k, v] of Object.entries(headers)) res.headers[String(k).toLowerCase()] = v
  }
  res.write = () => {
    res.headersSent = true
    return true
  }
  res.end = () => {
    res.headersSent = true
    res.writableEnded = true
    res.closed = true
    res.emit('finish')
    res.emit('close')
  }
  return res
}

function respondJsonWithRetryHeader(res, status, payload) {
  res.statusCode = status
  res.body = payload
  const headers = { 'content-type': 'application/json; charset=utf-8' }
  if (payload?.error?.details?.retryable === false) headers['x-should-retry'] = 'false'
  res.writeHead(status, headers)
  res.end()
  return payload
}

test('handleProtocol enforces 3-tier 400/500 blocking, clears strikes on HTTP 200, and immediately blocks poison_abort', async () => {
  await withDb(async (db) => {
    const devices = new RefusalDeviceBlocksRepo(db)
    const sessions = new RefusalSessionBlocksRepo(db)
    const settings = memorySettings({ refusal_guard_enabled: false, refusal_device_block_enabled: false })
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-proto-400-'))
    let upstreamRuns = 0
    let mode = 'repair_succeeds'

    const okResponse = (attemptCount = 1) => ({
      ok: true,
      status: 200,
      upstreamStatus: 200,
      attemptCount,
      finalState: 'verified',
      body: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })

    try {
      const { handleProtocol } = createHandleProtocol({
        cfg: {
          paths: { project: projectDir },
          limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 5000, stream_idle_timeout_ms: 5000 },
          rewrite: { enabled: false },
          intercept: { rules: [] },
          distill: null,
        },
        stats: { requests: 0, errors: 0, by_route: {} },
        requestLog: { start: () => ({ request_id: `req-${upstreamRuns}`, t0: Date.now() }), finish: () => {} },
        requireAuth: () => true,
        readBody: async (r) => r.body,
        json: respondJsonWithRetryHeader,
        writeSSEHeaders: () => {},
        getRouting: () => ({}),
        settings,
        refusalDevices: devices,
        refusalSessions: sessions,
        failoverRunner: {
          async run({ onUpstreamRisk }) {
            upstreamRuns += 1
            if (mode === 'repair_succeeds') {
              const first400 = {
                ok: false,
                status: 400,
                upstreamStatus: 400,
                body: { error: { type: 'invalid_request_error', message: 'unexpected tool_use_id' } },
              }
              onUpstreamRisk?.(first400)
              const recovered = okResponse(2)
              onUpstreamRisk?.(recovered)
              return recovered
            }
            if (mode === 'ok_200') {
              return okResponse(1)
            }
            if (mode === 'terminal_400') {
              const terminal400 = {
                ok: false,
                status: 400,
                upstreamStatus: 400,
                attemptCount: 1,
                finalState: 'upstream_error',
                body: {
                  error: {
                    type: 'invalid_request_error',
                    message: 'prompt is too long: 212345 tokens > 200000 maximum',
                  },
                },
              }
              onUpstreamRisk?.(terminal400)
              return terminal400
            }
            if (mode === 'poison_abort') {
              return {
                ok: false,
                status: 422,
                upstreamStatus: 422,
                attemptCount: 3,
                finalState: 'poison_abort',
                body: { error: { code: 'poison_abort', message: 'Request aborted after poisoning multiple slots' } },
              }
            }
            if (mode === 'terminal_500') {
              return {
                ok: false,
                status: 500,
                upstreamStatus: 500,
                attemptCount: 2,
                finalState: 'upstream_error',
                body: { error: { type: 'api_error', message: 'Internal server error' } },
              }
            }
            if (mode === 'terminal_503') {
              return {
                ok: false,
                status: 503,
                upstreamStatus: 503,
                attemptCount: 2,
                finalState: 'upstream_error',
                body: { error: { code: 'slot_busy', message: 'All slots busy' } },
              }
            }
            return okResponse(1)
          },
        },
        stickyRouter: null,
        apiKeyStore: { acquire: () => ({ ok: true }), release: () => {} },
        accountQuota: { ingestHeaders: () => {} },
        groupsRepo: { rateMultiplier: () => 1 },
      })

      const makeReq = (sessionId, text = 'hello') =>
        Object.assign(new EventEmitter(), {
          method: 'POST',
          url: '/v1/messages',
          headers: { 'x-claude-code-session-id': sessionId },
          body: { model: 'claude-sonnet-4-6', max_tokens: 64, messages: [{ role: 'user', content: text }] },
          apiKeyKind: 'managed',
          apiKeyRecord: { id: 'key-proto-1', group_id: 1, group_type: 'anthropic' },
        })

      // 1. Intermediate 400 that recovers to 200 must NOT block the session.
      const resOk1 = makeMockRes()
      await handleProtocol(makeReq('session-recover-0001'), resOk1, 'anthropic.messages', '/v1/messages')
      assert.equal(resOk1.statusCode, 200)
      assert.equal(upstreamRuns, 1)
      assert.equal(devices.count(), 0)

      // 2. Single recoverable prompt_too_long followed by /compact HTTP 200 clears the strike and never blocks.
      mode = 'terminal_400'
      const resCompactFail1 = makeMockRes()
      await handleProtocol(makeReq('session-compact-0001'), resCompactFail1, 'anthropic.messages', '/v1/messages')
      assert.equal(resCompactFail1.statusCode, 400)
      assert.equal(devices.findBan({ principal: 'key:key-proto-1', sessionId: 'session-compact-0001' }), null)

      mode = 'ok_200'
      const resCompactOk = makeMockRes()
      await handleProtocol(
        makeReq('session-compact-0001', '/compact'),
        resCompactOk,
        'anthropic.messages',
        '/v1/messages',
      )
      assert.equal(resCompactOk.statusCode, 200)

      // Because HTTP 200 cleared strike 1, another isolated prompt_too_long still allows recovery instead of blocking.
      mode = 'terminal_400'
      const resCompactFail2 = makeMockRes()
      await handleProtocol(
        makeReq('session-compact-0001', 'long again'),
        resCompactFail2,
        'anthropic.messages',
        '/v1/messages',
      )
      assert.equal(resCompactFail2.statusCode, 400)
      assert.equal(devices.findBan({ principal: 'key:key-proto-1', sessionId: 'session-compact-0001' }), null)

      // 3. Two consecutive terminal prompt_too_long errors without recovery block the session for 10m.
      const resLoop1 = makeMockRes()
      await handleProtocol(makeReq('session-terminal-0001', 'turn 1'), resLoop1, 'anthropic.messages', '/v1/messages')
      assert.equal(resLoop1.statusCode, 400)
      assert.equal(devices.findBan({ principal: 'key:key-proto-1', sessionId: 'session-terminal-0001' }), null)

      const resLoop2 = makeMockRes()
      await handleProtocol(makeReq('session-terminal-0001', 'turn 2'), resLoop2, 'anthropic.messages', '/v1/messages')
      assert.equal(resLoop2.statusCode, 400)
      const ban400 = devices.findBan({ principal: 'key:key-proto-1', sessionId: 'session-terminal-0001' })
      assert.ok(ban400)
      assert.equal(ban400.reason, upstream400ReasonFor('context_too_long'))
      assert.equal(ban400.hit_count, 0)
      const runsAfter400Block = upstreamRuns

      const resBlocked1 = makeMockRes()
      await handleProtocol(
        makeReq('session-terminal-0001', 'retry 1'),
        resBlocked1,
        'anthropic.messages',
        '/v1/messages',
      )
      assert.equal(resBlocked1.statusCode, 400)
      assert.equal(resBlocked1.headers['x-should-retry'], 'false')
      assert.equal(resBlocked1.body.error.code, 'refusal_guard')
      assert.equal(resBlocked1.body.error.details.blocked_by, 'session')
      assert.equal(upstreamRuns, runsAfter400Block)
      assert.equal(devices.get(ban400.device_id).hit_count, 1)

      const resBlocked2 = makeMockRes()
      await handleProtocol(
        makeReq('session-terminal-0001', 'retry 2'),
        resBlocked2,
        'anthropic.messages',
        '/v1/messages',
      )
      assert.equal(resBlocked2.statusCode, 400)
      assert.equal(upstreamRuns, runsAfter400Block)
      assert.equal(devices.get(ban400.device_id).hit_count, 2)

      // 4. Multi-slot poison_abort (422) blocks the session IMMEDIATELY on hit 1.
      mode = 'poison_abort'
      const resPoison = makeMockRes()
      await handleProtocol(makeReq('session-poison-0001'), resPoison, 'anthropic.messages', '/v1/messages')
      assert.equal(resPoison.statusCode, 422)
      const poisonBan = devices.findBan({ principal: 'key:key-proto-1', sessionId: 'session-poison-0001' })
      assert.ok(poisonBan)
      assert.equal(poisonBan.reason, upstreamErrorReasonFor('poison_abort'))
      const runsAfterPoison = upstreamRuns

      const resPoisonBlocked = makeMockRes()
      await handleProtocol(
        makeReq('session-poison-0001', 'retry after poison'),
        resPoisonBlocked,
        'anthropic.messages',
        '/v1/messages',
      )
      assert.equal(resPoisonBlocked.statusCode, 400)
      assert.equal(resPoisonBlocked.headers['x-should-retry'], 'false')
      assert.match(resPoisonBlocked.body.error.message, /上游 500 错误（跨多槽位 5xx 毒请求熔断）/)
      assert.equal(upstreamRuns, runsAfterPoison)
      assert.equal(devices.get(poisonBan.device_id).hit_count, 1)

      // 5. Terminal upstream HTTP 500 blocks on 2nd consecutive hit; 3rd attempt is intercepted pre-dispatch.
      mode = 'terminal_500'
      const res500a = makeMockRes()
      await handleProtocol(makeReq('session-500-0001', '500 #1'), res500a, 'anthropic.messages', '/v1/messages')
      assert.equal(res500a.statusCode, 500)
      assert.equal(devices.findBan({ principal: 'key:key-proto-1', sessionId: 'session-500-0001' }), null)

      const res500b = makeMockRes()
      await handleProtocol(makeReq('session-500-0001', '500 #2'), res500b, 'anthropic.messages', '/v1/messages')
      assert.equal(res500b.statusCode, 500)
      const ban500 = devices.findBan({ principal: 'key:key-proto-1', sessionId: 'session-500-0001' })
      assert.ok(ban500)
      assert.equal(ban500.reason, upstreamErrorReasonFor('internal_server_error'))
      const runsAfter500 = upstreamRuns

      const res500Blocked = makeMockRes()
      await handleProtocol(
        makeReq('session-500-0001', '500 retry'),
        res500Blocked,
        'anthropic.messages',
        '/v1/messages',
      )
      assert.equal(res500Blocked.statusCode, 400)
      assert.equal(res500Blocked.headers['x-should-retry'], 'false')
      assert.match(res500Blocked.body.error.message, /上游 500 错误（上游 500 服务端内部错误）/)
      assert.equal(upstreamRuns, runsAfter500)
      assert.equal(devices.get(ban500.device_id).hit_count, 1)

      // 6. Infrastructure 503/529 NEVER blocks session even after repeated failures.
      mode = 'terminal_503'
      for (let i = 0; i < 3; i += 1) {
        const res503 = makeMockRes()
        await handleProtocol(makeReq('session-503-0001', `try ${i}`), res503, 'anthropic.messages', '/v1/messages')
        assert.equal(res503.statusCode, 529)
      }
      assert.equal(devices.findBan({ principal: 'key:key-proto-1', sessionId: 'session-503-0001' }), null)
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })
})

test('Gemini public route enforces 2-strike 400 blocking, immediate poison_abort blocking, and hit_count tracking', async () => {
  await withDb(async (db) => {
    const devices = new RefusalDeviceBlocksRepo(db)
    const sessions = new RefusalSessionBlocksRepo(db)
    let streamCalls = 0
    let behavior = 'err_400'
    const scheduler = {
      async catalog() {
        return { models: [{ id: 'gemini-4-neon', object: 'model' }], accounts: [{ id: 'env-1' }] }
      },
      async stream() {
        streamCalls += 1
        if (behavior === 'err_400') {
          const err = new Error('Invalid argument from Gemini upstream')
          err.code = 'gemini_invalid_request'
          err.status = 400
          err.upstreamStatus = 400
          throw err
        }
        if (behavior === 'poison_abort') {
          const err = new Error('Request aborted after poisoning multiple slots')
          err.code = 'poison_abort'
          err.status = 422
          err.finalState = 'poison_abort'
          throw err
        }
        return {
          model: 'gemini-4-neon',
          text: 'ok',
          parts: [{ kind: 'text', text: 'ok' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      },
    }
    const handler = createGeminiPublicHandler({
      json: respondJsonWithRetryHeader,
      readBody: async (r) => r.body,
      scheduler,
      settings: memorySettings({ refusal_guard_enabled: false, refusal_device_block_enabled: false }),
      refusalDevices: devices,
      refusalSessions: sessions,
    })

    const makeGemReq = (sessionId, text = 'hello') =>
      Object.assign(new EventEmitter(), {
        method: 'POST',
        url: '/v1beta/models/gemini-4-neon:generateContent',
        headers: { 'x-session-id': sessionId },
        body: { contents: [{ role: 'user', parts: [{ text }] }] },
        apiKeyKind: 'managed',
        apiKeyRecord: { id: 'key-gem-400', group_type: 'gemini', group_id: 1 },
      })

    // 1st recoverable 400 allows recovery; 2nd consecutive 400 blocks for 10m; 3rd is intercepted pre-dispatch.
    const res1 = makeMockRes()
    await handler(makeGemReq('gem-session-400-01', 'turn 1'), res1)
    assert.equal(res1.statusCode, 400)
    assert.equal(streamCalls, 1)
    assert.equal(devices.findBan({ principal: 'key:key-gem-400', sessionId: 'gem-session-400-01' }), null)

    const res2 = makeMockRes()
    await handler(makeGemReq('gem-session-400-01', 'turn 2'), res2)
    assert.equal(res2.statusCode, 400)
    assert.equal(streamCalls, 2)
    const ban = devices.findBan({ principal: 'key:key-gem-400', sessionId: 'gem-session-400-01' })
    assert.ok(ban)
    assert.equal(ban.reason, upstream400ReasonFor('unknown'))
    assert.equal(ban.hit_count, 0)

    const res3 = makeMockRes()
    await handler(makeGemReq('gem-session-400-01', 'retry on blocked session'), res3)
    assert.equal(res3.statusCode, 400)
    assert.equal(res3.headers['x-should-retry'], 'false')
    assert.match(String(res3.body?.error?.message || ''), /上游 400 错误已临时封禁/)
    assert.equal(streamCalls, 2)
    assert.equal(devices.get(ban.device_id).hit_count, 1)

    // Other session succeeds cleanly.
    behavior = 'ok'
    const resOther = makeMockRes()
    await handler(makeGemReq('gem-session-400-02', 'different session'), resOther)
    assert.equal(resOther.statusCode, 200)
    assert.equal(streamCalls, 3)

    // Gemini poison_abort blocks immediately on hit 1.
    behavior = 'poison_abort'
    const resPoison = makeMockRes()
    await handler(makeGemReq('gem-session-poison-01', 'poison turn'), resPoison)
    assert.equal(resPoison.statusCode, 422)
    assert.equal(streamCalls, 4)
    const poisonBan = devices.findBan({ principal: 'key:key-gem-400', sessionId: 'gem-session-poison-01' })
    assert.ok(poisonBan)
    assert.equal(poisonBan.reason, upstreamErrorReasonFor('poison_abort'))

    const resPoisonRetry = makeMockRes()
    await handler(makeGemReq('gem-session-poison-01', 'retry after poison'), resPoisonRetry)
    assert.equal(resPoisonRetry.statusCode, 400)
    assert.equal(resPoisonRetry.headers['x-should-retry'], 'false')
    assert.match(
      String(resPoisonRetry.body?.error?.message || ''),
      /上游 500 错误（跨多槽位 5xx 毒请求熔断）已临时封禁/,
    )
    assert.equal(streamCalls, 4)
    assert.equal(devices.get(poisonBan.device_id).hit_count, 1)
  })
})

test('classifyUpstreamErrorForSessionBlock enforces 3-tier classification across 400, 500, poison_abort, and 502-529 exclusions', () => {
  const mk = (message, { status = 400, code, type, extra = {} } = {}) => ({
    ok: false,
    status,
    upstreamStatus: status,
    body: { error: { ...(type ? { type } : {}), ...(code ? { code } : {}), message } },
    ...extra,
  })

  // --- Tier 3: Cleaned / Excluded (NEVER block caller session) ---
  const skippedCases = [
    ['account_disabled', mk('This organization has been disabled.')],
    ['account_disabled', mk('OAuth authentication is currently not allowed for this organization.')],
    ['account_disabled', mk('Country, region, or territory not supported')],
    ['auth_credential', mk('OAuth token has been revoked', { code: 'token_revoked' })],
    ['auth_credential', mk('Invalid x-api-key provided', { type: 'authentication_error' })],
    ['auth_credential', mk('Refresh failed', { extra: { credential_ensure_failed: true } })],
    ['billing_credit', mk('Your credit balance is too low to access the Anthropic API.')],
    ['billing_credit', mk('Extra usage required to access this model.')],
    ['billing_credit', mk("You've hit your limit for this billing period.")],
    ['model_unavailable', mk("The model 'claude-99-ghost' does not exist or you do not have access to it.")],
    ['model_unavailable', mk('Unknown model id', { code: 'model_not_found' })],
    ['gateway_local', mk('Kernel rejected envelope', { code: 'invalid_kernel_request' })],
    ['gateway_local', mk('License expired', { code: 'license_expired' })],
    ['upstream_502_bad_gateway', mk('Bad gateway from upstream proxy', { status: 502 })],
    ['upstream_502_bad_gateway', mk('Stream cut short', { status: 500, code: 'incomplete_response' })],
    ['upstream_503_unavailable', mk('Service temporarily unavailable', { status: 503 })],
    ['upstream_503_unavailable', mk('All slots busy', { status: 503, code: 'slot_busy' })],
    ['upstream_504_timeout', mk('Gateway timeout waiting for upstream', { status: 504 })],
    ['upstream_504_timeout', mk('Upstream timed out', { status: 500, code: 'upstream_timeout' })],
    ['upstream_529_overloaded', mk('Overloaded', { status: 529, type: 'overloaded_error' })],
    ['upstream_529_overloaded', mk('Anthropic API is overloaded', { status: 500, type: 'overloaded_error' })],
    ['worker_local_5xx', mk('Worker process exited unexpectedly', { status: 500, code: 'process_error' })],
    ['worker_local_5xx', mk('Local wrap socket closed', { status: 500, code: 'wrap_connection_error' })],
  ]
  for (const [expectedCategory, result] of skippedCases) {
    const verdict = classifyUpstreamErrorForSessionBlock(result)
    assert.equal(verdict.category, expectedCategory, `expected ${expectedCategory} for ${JSON.stringify(result)}`)
    assert.equal(verdict.tier, 'skip')
    assert.equal(verdict.threshold, 0)
    assert.equal(verdict.blockSession, false)
    assert.equal(verdict.group, 'skip')
    assert.equal(verdict.reason, '')
  }

  // --- Tier 1: Immediate 10m session block (threshold = 1) ---
  const immediateCases = [
    [
      'third_party_client',
      'upstream_400:third_party_client',
      mk(
        'Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage.',
      ),
    ],
    [
      'policy_refusal',
      'upstream_400:policy_refusal',
      mk('API Error: unable to respond to this request under our Usage Policy'),
    ],
    [
      'state_reference_invalid',
      'upstream_400:state_reference_invalid',
      mk("Item with id 'rs_123' not found", { code: 'item_not_found' }),
    ],
    ['state_reference_invalid', 'upstream_400:state_reference_invalid', mk('previous_response_id resp_abc not found')],
    [
      'poison_abort',
      'upstream_500:poison_abort',
      mk('Request aborted after poisoning multiple slots', {
        status: 422,
        code: 'poison_abort',
        extra: { finalState: 'poison_abort' },
      }),
    ],
  ]
  for (const [expectedCategory, expectedReason, result] of immediateCases) {
    const verdict = classifyUpstreamErrorForSessionBlock(result)
    assert.equal(verdict.category, expectedCategory, `expected ${expectedCategory} for ${JSON.stringify(result)}`)
    assert.equal(verdict.tier, 'immediate')
    assert.equal(verdict.threshold, 1)
    assert.equal(verdict.blockSession, true)
    assert.equal(verdict.group, 'session_block')
    assert.equal(verdict.reason, expectedReason)
    assert.equal(upstreamErrorCategoryFromReason(verdict.reason), expectedCategory)
    assert.ok(UPSTREAM_ERROR_CATEGORIES[expectedCategory].label.length > 0)
  }

  // --- Tier 2: Recoverable / Repeat 10m session block (threshold = 2 within 5m, reset on 200) ---
  const repeatCases = [
    ['context_too_long', 'upstream_400:context_too_long', mk('prompt is too long: 212345 tokens > 200000 maximum')],
    [
      'context_too_long',
      'upstream_400:context_too_long',
      mk('This model maximum context length is 128000 tokens', { code: 'context_length_exceeded' }),
    ],
    [
      'context_too_long',
      'upstream_400:context_too_long',
      mk('The input token count exceeds the maximum number of tokens allowed 1048576.'),
    ],
    [
      'param_range_invalid',
      'upstream_400:param_range_invalid',
      mk('max_tokens: 99999 > 64000, which is the maximum allowed number of output tokens for claude-opus-4-6'),
    ],
    ['param_range_invalid', 'upstream_400:param_range_invalid', mk('`temperature` is deprecated for this model')],
    [
      'param_range_invalid',
      'upstream_400:param_range_invalid',
      mk('top_p must be between 0 and 1', { code: 'max_tokens_exceeded' }),
    ],
    [
      'beta_or_header_invalid',
      'upstream_400:beta_or_header_invalid',
      mk('Unexpected value(s) `foo-2026` for the anthropic-beta header'),
    ],
    [
      'tool_pair_broken',
      'upstream_400:tool_pair_broken',
      mk('messages.4.content.0: unexpected `tool_use_id` found in `tool_result` blocks'),
    ],
    [
      'tool_pair_broken',
      'upstream_400:tool_pair_broken',
      mk('tool_use ids were found without tool_result blocks immediately after: toolu_01abc'),
    ],
    ['tool_pair_broken', 'upstream_400:tool_pair_broken', mk('No tool output found for function call call_abc123')],
    [
      'tool_pair_broken',
      'upstream_400:tool_pair_broken',
      mk('Please ensure that function response turn comes immediately after a function call turn.'),
    ],
    ['thinking_history_broken', 'upstream_400:thinking_history_broken', mk('Invalid signature in thinking block')],
    [
      'thinking_history_broken',
      'upstream_400:thinking_history_broken',
      mk('thinking.budget_tokens must be at least 1024', { code: 'thinking_incompatible' }),
    ],
    [
      'thinking_history_broken',
      'upstream_400:thinking_history_broken',
      mk('Function call is missing a thought_signature in functionCall parts'),
    ],
    [
      'search_or_cache_invalid',
      'upstream_400:search_or_cache_invalid',
      mk('A maximum of 4 blocks with cache_control may be provided.'),
    ],
    [
      'search_or_cache_invalid',
      'upstream_400:search_or_cache_invalid',
      mk('Invalid encrypted_content in search_result block'),
    ],
    [
      'media_invalid',
      'upstream_400:media_invalid',
      mk('image dimensions exceed max allowed size for many-image requests: 2000 pixels'),
    ],
    ['media_invalid', 'upstream_400:media_invalid', mk('Could not process image: invalid base64 data')],
    [
      'message_structure_invalid',
      'upstream_400:message_structure_invalid',
      mk('messages: roles must alternate between "user" and "assistant"'),
    ],
    [
      'message_structure_invalid',
      'upstream_400:message_structure_invalid',
      mk('messages.2.content: text content blocks must be non-empty'),
    ],
    [
      'message_structure_invalid',
      'upstream_400:message_structure_invalid',
      mk('Please ensure that multiturn requests alternate between user and model.'),
    ],
    [
      'tool_schema_invalid',
      'upstream_400:tool_schema_invalid',
      mk("Invalid schema for 'tools[0].parameters': Unsatisfiable schema", { code: 'invalid_json_schema' }),
    ],
    [
      'tool_schema_invalid',
      'upstream_400:tool_schema_invalid',
      mk('tools.0.input_schema: extra inputs are not permitted'),
    ],
    [
      'tool_schema_invalid',
      'upstream_400:tool_schema_invalid',
      mk('Invalid JSON payload received. Unknown name "foo" at contents[0]'),
    ],
    ['unknown', 'upstream_400:unknown', mk('Some brand-new upstream 400 error wording')],
    [
      'internal_server_error',
      'upstream_500:internal_server_error',
      mk('Internal server error', { status: 500, type: 'api_error' }),
    ],
    [
      'internal_server_error',
      'upstream_500:internal_server_error',
      mk('An unexpected error occurred while processing your request.', { status: 500, code: 'server_error' }),
    ],
  ]
  for (const [expectedCategory, expectedReason, result] of repeatCases) {
    const verdict = classifyUpstreamErrorForSessionBlock(result)
    assert.equal(verdict.category, expectedCategory, `expected ${expectedCategory} for ${JSON.stringify(result)}`)
    assert.equal(verdict.tier, 'repeat')
    assert.equal(verdict.threshold, 2)
    assert.equal(verdict.blockSession, true)
    assert.equal(verdict.group, 'session_repeat_block')
    assert.equal(verdict.reason, expectedReason)
    assert.equal(upstreamErrorCategoryFromReason(verdict.reason), expectedCategory)
    assert.ok(UPSTREAM_400_CATEGORIES[expectedCategory].label.length > 0)
  }

  // Backward compatibility: classifyUpstream400 still classifies 400s and ignores 500s; bare reasons resolve safely.
  assert.equal(classifyUpstream400(mk('Internal server error', { status: 500 })), null)
  assert.equal(upstream400CategoryFromReason(UPSTREAM_400_SESSION_REASON), 'unknown')
  assert.equal(upstreamErrorCategoryFromReason(UPSTREAM_500_SESSION_REASON), 'internal_server_error')
})

test('PR #2081 review regressions: recoverable 400s and 500s allow self-recovery, reset on HTTP 200 or 5m expiry, and share strikes across repo instances', async () => {
  await withDb(async (db) => {
    const start = Date.parse('2026-11-28T13:00:00.000Z')
    const policy = { enabled: false, session_block_enabled: true }
    const identity = { principal: 'user:reviewer' }

    const reviewerRecoverableCases = [
      [
        'context_too_long',
        400,
        'invalid_request_error: prompt is too long: 212345 tokens > 200000 maximum',
        'sess-review-compact-01',
      ],
      [
        'param_range_invalid',
        400,
        'invalid_request_error: max_tokens: 99999 > 64000, which is the maximum allowed number of output tokens',
        'sess-review-maxtokens-01',
      ],
      [
        'tool_pair_broken',
        400,
        'tool_use ids were found without tool_result blocks immediately after: toolu_01xyz',
        'sess-review-toolpair-01',
      ],
      ['internal_server_error', 500, 'Internal server error', 'sess-review-500-01'],
    ]

    for (const [expectedCategory, status, message, sessionId] of reviewerRecoverableCases) {
      const headers = { 'x-claude-code-session-id': sessionId }
      const repo1 = new RefusalDeviceBlocksRepo(db)
      const repo2 = new RefusalDeviceBlocksRepo(db)

      // 1st hit: strike_1_of_2, NOT blocked so client can /compact, fix max_tokens, or repair tool_result.
      const bag1 = {}
      const ban1 = recordUpstreamErrorSessionBlock({
        inbound: req('turn 1'),
        headers,
        identity,
        result: { ok: false, status, upstreamStatus: status, body: { error: { message } } },
        logBag: bag1,
        policy,
        devices: repo1,
        requestId: `req-${expectedCategory}-1`,
        now: start,
      })
      assert.equal(ban1, null)
      assert.equal(bag1.error_details.upstream_error_category, expectedCategory)
      assert.equal(bag1.error_details.upstream_error_action, 'strike_1_of_2')
      const sanitizedStrike = sanitizeErrorDetailsForLog(bag1.error_details, { status })
      assert.equal(sanitizedStrike.upstream_error_category, expectedCategory)
      assert.equal(sanitizedStrike.upstream_error_action, 'strike_1_of_2')
      assert.equal(repo2.findBan({ ...identity, sessionId }, start), null)

      // HTTP 200 clears the strike across separate repo instances.
      assert.equal(
        clearUpstreamSessionErrorStrikes({ inbound: req('recovered'), headers, identity, devices: repo2 }),
        true,
      )

      // After HTTP 200 recovery, another single hit starts back at strike 1/2 (still NOT blocked).
      const bag2 = {}
      const ban2 = recordUpstreamErrorSessionBlock({
        inbound: req('turn 2'),
        headers,
        identity,
        result: { ok: false, status, upstreamStatus: status, body: { error: { message } } },
        logBag: bag2,
        policy,
        devices: repo2,
        requestId: `req-${expectedCategory}-2`,
        now: start + 10_000,
      })
      assert.equal(ban2, null)
      assert.equal(bag2.error_details.upstream_error_action, 'strike_1_of_2')

      // After the 5-minute window expires, the stale strike resets instead of blocking.
      const afterWindow = start + 10_000 + UPSTREAM_ERROR_REPEAT_WINDOW_MS + 1_000
      const bag3 = {}
      const ban3 = recordUpstreamErrorSessionBlock({
        inbound: req('turn 3 after 5m'),
        headers,
        identity,
        result: { ok: false, status, upstreamStatus: status, body: { error: { message } } },
        logBag: bag3,
        policy,
        devices: repo1,
        requestId: `req-${expectedCategory}-3`,
        now: afterWindow,
      })
      assert.equal(ban3, null)
      assert.equal(bag3.error_details.upstream_error_action, 'strike_1_of_2')

      // Consecutive 2nd failure within 5m across fresh repo instance triggers the 10m DB block.
      const bag4 = {}
      const ban4 = recordUpstreamErrorSessionBlock({
        inbound: req('turn 4 blind loop'),
        headers,
        identity,
        result: { ok: false, status, upstreamStatus: status, body: { error: { message } } },
        logBag: bag4,
        policy,
        devices: repo2,
        requestId: `req-${expectedCategory}-4`,
        now: afterWindow + 5_000,
      })
      assert.ok(ban4)
      assert.equal(ban4.reason, upstreamErrorReasonFor(expectedCategory))
      assert.equal(bag4.error_details.upstream_error_action, 'session_10m')
      assert.equal(bag4.error_details.punishment, status === 500 ? 'session_10m_500' : 'session_10m_400')
    }
  })
})

test('recordUpstreamErrorSessionBlock skips non-session 400s and infrastructure 5xx without banning and logs sanitized details', async () => {
  await withDb(async (db) => {
    const devices = new RefusalDeviceBlocksRepo(db)
    const start = Date.parse('2026-11-28T12:00:00.000Z')
    const headers = { 'x-claude-code-session-id': SESSION }
    const identity = { principal: 'user:clean' }
    const policy = { enabled: false, session_block_enabled: true }

    for (const [expectedCategory, status, message, code] of [
      ['account_disabled', 400, 'This organization has been disabled.', undefined],
      ['billing_credit', 400, 'Your credit balance is too low to access the Anthropic API.', undefined],
      ['auth_credential', 400, 'OAuth token has been revoked', 'token_revoked'],
      ['model_unavailable', 400, "The model 'claude-unknown' does not exist.", undefined],
      ['upstream_502_bad_gateway', 502, 'Bad gateway', undefined],
      ['upstream_503_unavailable', 503, 'Service unavailable', 'slot_busy'],
      ['upstream_504_timeout', 504, 'Gateway timeout', 'upstream_timeout'],
      ['upstream_529_overloaded', 529, 'Overloaded', undefined],
      ['worker_local_5xx', 500, 'Worker process crashed', 'process_error'],
    ]) {
      // Even repeated 5 times, Tier-3 exclusions must never block the session.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const logBag = {}
        const ban = recordUpstreamErrorSessionBlock({
          inbound: req('hello'),
          headers,
          identity,
          result: {
            ok: false,
            status,
            upstreamStatus: status,
            body: { error: { ...(code ? { code } : {}), message } },
          },
          logBag,
          policy,
          devices,
          requestId: `req-skip-${expectedCategory}-${attempt}`,
          now: start + attempt * 1_000,
        })
        assert.equal(ban, null)
        assert.equal(devices.count(), 0)
        assert.equal(logBag.risk_session_block_skipped, expectedCategory)
        assert.equal(logBag.error_details.upstream_error_category, expectedCategory)
        assert.equal(logBag.error_details.upstream_error_action, 'skipped')
        const sanitized = sanitizeErrorDetailsForLog(logBag.error_details, { status })
        assert.equal(sanitized.upstream_error_category, expectedCategory)
        assert.equal(sanitized.upstream_error_action, 'skipped')
        if (status === 400) {
          assert.equal(sanitized.upstream_400_category, expectedCategory)
          assert.equal(sanitized.upstream_400_action, 'skipped')
        }
      }
    }

    // Missing session id logs upstream_error_action = 'no_session' without failing.
    const noSessBag = {}
    const noSessBan = recordUpstream400SessionBlock({
      inbound: req('hello'),
      headers: {},
      identity: { principal: 'user:clean' },
      result: { ok: false, status: 400, body: { error: { message: 'prompt is too long: 210000 > 200000' } } },
      logBag: noSessBag,
      policy,
      devices,
      now: start,
    })
    assert.equal(noSessBan, null)
    assert.equal(noSessBag.error_details.upstream_400_category, 'context_too_long')
    assert.equal(noSessBag.error_details.upstream_400_action, 'no_session')
    assert.equal(noSessBag.error_details.upstream_error_category, 'context_too_long')
    assert.equal(noSessBag.error_details.upstream_error_action, 'no_session')
  })
})
