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
  applyRefusalGuardPatch,
  classifyUpstream400,
  matchRefusalSession,
  refusalGuardPolicy,
  refusalSessionId,
  upstream400CategoryFromReason,
  upstream400ReasonFor,
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
    assert.equal(stored.reason, upstream400ReasonFor('tool_pair_broken'))
    assert.equal(stored.violations, 1)
    assert.equal(stored.hit_count, 0)
    assert.equal(stored.expires_at, new Date(start + UPSTREAM_400_SESSION_BLOCK_MS).toISOString())
    assert.equal(logBag.error_details.upstream_400_category, 'tool_pair_broken')
    assert.equal(logBag.error_details.upstream_400_action, 'session_10m')

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
    assert.equal(d1.error.body.error.details.upstream_400_category, 'tool_pair_broken')
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
      assert.equal(ban.reason, upstream400ReasonFor('unknown'))
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
    assert.equal(ban.reason, upstream400ReasonFor('unknown'))
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

test('classifyUpstream400 separates non-session exclusions from session-blocking categories across Claude, Codex, and Gemini', () => {
  const mk = (message, { code, type, extra = {} } = {}) => ({
    ok: false,
    status: 400,
    upstreamStatus: 400,
    body: { error: { ...(type ? { type } : {}), ...(code ? { code } : {}), message } },
    ...extra,
  })

  // 1. Cleaned / Excluded categories — MUST NOT block caller session.
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
  ]
  for (const [expectedCategory, result] of skippedCases) {
    const verdict = classifyUpstream400(result)
    assert.equal(verdict.category, expectedCategory, `expected ${expectedCategory} for ${JSON.stringify(result)}`)
    assert.equal(verdict.blockSession, false)
    assert.equal(verdict.group, 'skip')
    assert.equal(verdict.reason, '')
  }

  // 2. Session-poisoned / deterministic loop categories — MUST block session for 10m.
  const blockCases = [
    [
      'third_party_client',
      mk(
        'Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage.',
      ),
    ],
    ['policy_refusal', mk('API Error: unable to respond to this request under our Usage Policy')],
    ['context_too_long', mk('prompt is too long: 215000 tokens > 200000 maximum')],
    ['context_too_long', mk('This model maximum context length is 128000 tokens', { code: 'context_length_exceeded' })],
    ['context_too_long', mk('The input token count exceeds the maximum number of tokens allowed 1048576.')],
    ['tool_pair_broken', mk('messages.4.content.0: unexpected `tool_use_id` found in `tool_result` blocks')],
    ['tool_pair_broken', mk('No tool output found for function call call_abc123')],
    ['tool_pair_broken', mk('Please ensure that function response turn comes immediately after a function call turn.')],
    ['thinking_history_broken', mk('Invalid signature in thinking block')],
    ['thinking_history_broken', mk('thinking.budget_tokens must be at least 1024', { code: 'thinking_incompatible' })],
    ['thinking_history_broken', mk('Function call is missing a thought_signature in functionCall parts')],
    ['search_or_cache_invalid', mk('A maximum of 4 blocks with cache_control may be provided.')],
    ['search_or_cache_invalid', mk('Invalid encrypted_content in search_result block')],
    ['media_invalid', mk('image dimensions exceed max allowed size for many-image requests: 2000 pixels')],
    ['media_invalid', mk('Could not process image: invalid base64 data')],
    ['message_structure_invalid', mk('messages: roles must alternate between "user" and "assistant"')],
    ['message_structure_invalid', mk('messages.2.content: text content blocks must be non-empty')],
    ['message_structure_invalid', mk('Please ensure that multiturn requests alternate between user and model.')],
    [
      'tool_schema_invalid',
      mk("Invalid schema for 'tools[0].parameters': Unsatisfiable schema", { code: 'invalid_json_schema' }),
    ],
    ['tool_schema_invalid', mk('tools.0.input_schema: extra inputs are not permitted')],
    ['tool_schema_invalid', mk('Invalid JSON payload received. Unknown name "foo" at contents[0]')],
    ['state_reference_invalid', mk("Item with id 'rs_123' not found", { code: 'item_not_found' })],
    ['state_reference_invalid', mk('previous_response_id resp_abc not found')],
    ['beta_or_header_invalid', mk('Unexpected value(s) `foo-2026` for the anthropic-beta header')],
    ['beta_or_header_invalid', mk('`temperature` is deprecated for this model')],
    ['unknown', mk('Some brand-new upstream 400 error wording')],
  ]
  for (const [expectedCategory, result] of blockCases) {
    const verdict = classifyUpstream400(result)
    assert.equal(verdict.category, expectedCategory, `expected ${expectedCategory} for ${JSON.stringify(result)}`)
    assert.equal(verdict.blockSession, true)
    assert.equal(verdict.group, 'session_block')
    assert.equal(verdict.reason, `upstream_400:${expectedCategory}`)
    assert.equal(upstream400CategoryFromReason(verdict.reason), expectedCategory)
    assert.ok(UPSTREAM_400_CATEGORIES[expectedCategory].label.length > 0)
  }

  // Legacy bare 'upstream_400' reason remains backward compatible.
  assert.equal(upstream400CategoryFromReason(UPSTREAM_400_SESSION_REASON), 'unknown')
})

test('recordUpstream400SessionBlock skips non-session 400s without banning and logs sanitized category/action details', async () => {
  await withDb(async (db) => {
    const devices = new RefusalDeviceBlocksRepo(db)
    const start = Date.parse('2026-11-28T12:00:00.000Z')
    const headers = { 'x-claude-code-session-id': SESSION }
    const identity = { principal: 'user:clean' }
    const policy = { enabled: false, session_block_enabled: true }

    for (const [expectedCategory, message] of [
      ['account_disabled', 'This organization has been disabled.'],
      ['billing_credit', 'Your credit balance is too low to access the Anthropic API.'],
      ['auth_credential', 'OAuth token has been revoked'],
      ['model_unavailable', "The model 'claude-unknown' does not exist."],
    ]) {
      const logBag = {}
      const ban = recordUpstream400SessionBlock({
        inbound: req('hello'),
        headers,
        identity,
        result: { ok: false, status: 400, body: { error: { message } } },
        logBag,
        policy,
        devices,
        requestId: `req-skip-${expectedCategory}`,
        now: start,
      })
      assert.equal(ban, null)
      assert.equal(devices.count(), 0)
      assert.equal(logBag.risk_session_block_skipped, expectedCategory)
      assert.equal(logBag.error_details.upstream_400_category, expectedCategory)
      assert.equal(logBag.error_details.upstream_400_action, 'skipped')
      const sanitized = sanitizeErrorDetailsForLog(logBag.error_details, { status: 400 })
      assert.equal(sanitized.upstream_400_category, expectedCategory)
      assert.equal(sanitized.upstream_400_action, 'skipped')
    }

    // Missing session id logs upstream_400_action = 'no_session' without failing.
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
  })
})
