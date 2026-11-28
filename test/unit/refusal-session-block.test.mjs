import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { RefusalDeviceBlocksRepo } from '../../src/lib/db/repos/refusal-device-blocks-repo.mjs'
import { RefusalSessionBlocksRepo } from '../../src/lib/db/repos/refusal-session-blocks-repo.mjs'
import {
  REFUSAL_SESSION_BLOCK_SETTING,
  UPSTREAM_400_SESSION_BLOCK_MS,
  UPSTREAM_400_SESSION_REASON,
  applyRefusalGuardPatch,
  matchRefusalSession,
  refusalGuardPolicy,
  refusalSessionId,
} from '../../src/lib/core/refusal-guard.mjs'
import { createGeminiPublicHandler } from '../../src/lib/gemini/routes.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import {
  commitProtocolBlock,
  evaluateProtocolIntercept,
  observeUpstreamRisk,
  recordUpstream400SessionBlock,
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

test('any upstream HTTP 400 blocks only that session for 10m, counts intercepted hits, isolates tenants/devices, and expires cleanly', async () => {
  await withDb(async (db) => {
    const devices = new RefusalDeviceBlocksRepo(db)
    const start = Date.parse('2026-11-28T10:00:00.000Z')
    const headers = { 'x-claude-code-session-id': SESSION, 'x-machine-id': 'dev-400-1' }
    const inbound = req('turn causing upstream 400')
    const policyOff = { enabled: false, device_block_enabled: false, session_block_enabled: true }
    const identity = { deviceId: 'dev-400-1', sessionId: '', principal: 'user:tenant-a' }

    const logBag = {}
    const reason = observeUpstreamRisk({
      inbound,
      body: inbound,
      headers,
      identity,
      result: { status: 400, body: { error: { type: 'invalid_request_error', message: 'invalid tool_use_id' } } },
      logBag,
      requestId: 'req-400-1',
      policy: policyOff,
      devices,
      now: start,
    })
    assert.equal(reason, '')
    assert.equal(logBag.audit_upstream_400, true)
    assert.equal(logBag.error_details.punishment, 'session_10m_400')

    const stored = devices.findBan({ ...identity, sessionId: SESSION }, start)
    assert.ok(stored)
    assert.equal(stored.subject_kind, 'session')
    assert.equal(stored.reason, UPSTREAM_400_SESSION_REASON)
    assert.equal(stored.violations, 1)
    assert.equal(stored.hit_count, 0)
    assert.equal(stored.expires_at, new Date(start + UPSTREAM_400_SESSION_BLOCK_MS).toISOString())

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
      now: start + 5_000,
    })
    assert.equal(d1.action, 'block')
    assert.equal(d1.final_state, 'refusal_session')
    assert.equal(d1.error.status, 400)
    assert.equal(d1.error.body.error.code, 'refusal_guard')
    assert.equal(d1.error.body.error.details.blocked_by, 'session')
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
      now: start + UPSTREAM_400_SESSION_BLOCK_MS - 1,
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
      now: start + 10_000,
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
      now: start + 10_000,
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
      now: start + 10_000,
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
      now: start + UPSTREAM_400_SESSION_BLOCK_MS,
    })
    assert.equal(afterExpiry.action, 'pass')

    // Another upstream 400 after expiry re-blocks for 10m and increments violations (1 -> 2), keeping hit_count.
    const reblocked = recordUpstream400SessionBlock({
      inbound,
      body: inbound,
      headers,
      identity,
      result: { status: 400, body: { error: { message: 'another bad request' } } },
      policy: policyOff,
      devices,
      requestId: 'req-400-again',
      now: start + UPSTREAM_400_SESSION_BLOCK_MS + 1_000,
    })
    assert.equal(reblocked.violations, 2)
    assert.equal(reblocked.hit_count, 2)
    assert.equal(
      reblocked.expires_at,
      new Date(start + UPSTREAM_400_SESSION_BLOCK_MS + 1_000 + UPSTREAM_400_SESSION_BLOCK_MS).toISOString(),
    )
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

    // Real upstream 400 on Codex blocks via prompt_cache_key.
    const ban = recordUpstream400SessionBlock({
      inbound: codexBody,
      identity: principalIdentity,
      result: { ok: false, status: 400, body: { error: { code: 'invalid_request_error', message: 'bad schema' } } },
      policy,
      devices,
      requestId: 'codex-400-1',
      now: start,
    })
    assert.equal(ban.subject_kind, 'session')
    assert.equal(ban.session_id, 'codex-cache-session-001')

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

    const after = recordUpstream400SessionBlock({
      inbound: req('follow-up 400'),
      identity: permIdentity,
      result: { ok: false, status: 400, body: { error: { message: 'bad request' } } },
      policy,
      devices,
      requestId: 'perm-400',
      now: start + 2_000,
    })
    assert.equal(after.expires_at, null)
    assert.equal(after.reason, 'jev:usage_policy')
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

test('handleProtocol blocks session for 10m only on terminal upstream 400 and not when failover retry succeeds', async () => {
  await withDb(async (db) => {
    const devices = new RefusalDeviceBlocksRepo(db)
    const sessions = new RefusalSessionBlocksRepo(db)
    const settings = memorySettings({ refusal_guard_enabled: false, refusal_device_block_enabled: false })
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-proto-400-'))
    let upstreamRuns = 0
    let mode = 'repair_succeeds'

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
              const recovered = {
                ok: true,
                status: 200,
                upstreamStatus: 200,
                attemptCount: 2,
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
              }
              onUpstreamRisk?.(recovered)
              return recovered
            }
            const terminal400 = {
              ok: false,
              status: 400,
              upstreamStatus: 400,
              attemptCount: 1,
              finalState: 'upstream_error',
              body: { error: { type: 'invalid_request_error', message: 'invalid request payload' } },
            }
            onUpstreamRisk?.(terminal400)
            return terminal400
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

      const resOk2 = makeMockRes()
      await handleProtocol(makeReq('session-recover-0001', 'second turn'), resOk2, 'anthropic.messages', '/v1/messages')
      assert.equal(resOk2.statusCode, 200)
      assert.equal(upstreamRuns, 2)

      // 2. Terminal upstream 400 blocks that session for 10m; subsequent turns never hit upstream and increment hit_count.
      mode = 'terminal_400'
      const resFail = makeMockRes()
      await handleProtocol(makeReq('session-terminal-0001'), resFail, 'anthropic.messages', '/v1/messages')
      assert.equal(resFail.statusCode, 400)
      assert.equal(upstreamRuns, 3)
      const ban = devices.findBan({ principal: 'key:key-proto-1', sessionId: 'session-terminal-0001' })
      assert.ok(ban)
      assert.equal(ban.reason, UPSTREAM_400_SESSION_REASON)
      assert.equal(ban.hit_count, 0)

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
      assert.equal(upstreamRuns, 3)
      assert.equal(devices.get(ban.device_id).hit_count, 1)

      const resBlocked2 = makeMockRes()
      await handleProtocol(
        makeReq('session-terminal-0001', 'retry 2'),
        resBlocked2,
        'anthropic.messages',
        '/v1/messages',
      )
      assert.equal(resBlocked2.statusCode, 400)
      assert.equal(upstreamRuns, 3)
      assert.equal(devices.get(ban.device_id).hit_count, 2)
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })
})

test('Gemini public route blocks session for 10m on upstream 400 and intercepts subsequent requests with hit_count', async () => {
  await withDb(async (db) => {
    const devices = new RefusalDeviceBlocksRepo(db)
    const sessions = new RefusalSessionBlocksRepo(db)
    let streamCalls = 0
    const scheduler = {
      async catalog() {
        return { models: [{ id: 'gemini-4-neon', object: 'model' }], accounts: [{ id: 'env-1' }] }
      },
      async stream() {
        streamCalls += 1
        if (streamCalls === 1) {
          const err = new Error('Invalid argument from Gemini upstream')
          err.code = 'gemini_invalid_request'
          err.status = 400
          err.upstreamStatus = 400
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

    const res1 = makeMockRes()
    await handler(makeGemReq('gem-session-400-01'), res1)
    assert.equal(res1.statusCode, 400)
    assert.equal(streamCalls, 1)
    const ban = devices.findBan({ principal: 'key:key-gem-400', sessionId: 'gem-session-400-01' })
    assert.ok(ban)
    assert.equal(ban.reason, UPSTREAM_400_SESSION_REASON)
    assert.equal(ban.hit_count, 0)

    const res2 = makeMockRes()
    await handler(makeGemReq('gem-session-400-01', 'retry on blocked session'), res2)
    assert.equal(res2.statusCode, 400)
    assert.equal(res2.headers['x-should-retry'], 'false')
    assert.match(String(res2.body?.error?.message || ''), /上游 400 错误已临时封禁/)
    assert.equal(streamCalls, 1)
    assert.equal(devices.get(ban.device_id).hit_count, 1)

    const resOther = makeMockRes()
    await handler(makeGemReq('gem-session-400-02', 'different session'), resOther)
    assert.equal(resOther.statusCode, 200)
    assert.equal(streamCalls, 2)
  })
})
