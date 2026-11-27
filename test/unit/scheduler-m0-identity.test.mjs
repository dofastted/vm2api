import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  agentSessionId,
  applyCrsIdentityReplace,
  extractMachineIdentity,
  resolveInboundIdentity,
  resolveSchedulerIdentity,
} from '../../src/lib/identity/identity-rewrite.mjs'
import { createHandleProtocol, prepareInboundProtocolContext } from '../../src/lib/protocol/handle-protocol.mjs'
import { prepareOutboundEnvelope } from '../../src/lib/protocol/outbound-attempt.mjs'
import { defaultSeedPolicy, sanitizeInboundBody, sanitizeOutboundHeaders } from '../../src/lib/protocol/seed-policy.mjs'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FORBIDDEN_SESSION_PREFIX_RE = /(?:auto_sess_|auto_conv_|#agent:)/i

test('machine_id priority: headers x-machine-id > x-kin-machine-id > x-kin-device-id > metadata > body', () => {
  const baseBody = {
    machine_id: 'top-machine',
    meachine_id: 'top-meachine',
    device_id: 'top-device',
    metadata: {
      user_id: JSON.stringify({
        machine_id: 'meta-machine',
        device_id: 'meta-device',
        session_id: '11111111-1111-4111-8111-111111111111',
      }),
    },
  }

  // 1a. x-machine-id wins over all other headers, metadata, and top-level body.
  const h1 = resolveInboundIdentity({
    inbound: baseBody,
    headers: {
      'X-Machine-Id': 'hdr-machine',
      'x-kin-machine-id': 'hdr-kin-machine',
      'x-kin-device-id': 'hdr-kin-device',
    },
  })
  assert.equal(h1.machineId, 'hdr-machine')
  assert.equal(h1.machineSource, 'header:x-machine-id')
  assert.equal(Object.hasOwn(h1, 'machineId'), true)
  // Legacy enumerable contract stays 100% backward-compatible for existing callers.
  assert.deepEqual(h1, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    deviceId: 'meta-device',
    source: 'metadata',
  })

  // 1b. x-kin-machine-id beats x-kin-device-id and metadata.
  const h2 = extractMachineIdentity({
    inbound: baseBody,
    headers: {
      'X-Kin-Machine-Id': 'hdr-kin-machine',
      'x-kin-device-id': 'hdr-kin-device',
    },
  })
  assert.deepEqual(h2, { machineId: 'hdr-kin-machine', machineSource: 'header:x-kin-machine-id' })

  // 1c. x-kin-device-id beats metadata and top-level body.
  const h3 = extractMachineIdentity({
    inbound: baseBody,
    headers: { 'X-Kin-Device-Id': 'hdr-kin-device' },
  })
  assert.deepEqual(h3, { machineId: 'hdr-kin-device', machineSource: 'header:x-kin-device-id' })

  // 2a. metadata.user_id machine_id / machineId / meachine_id beats device_id and top-level body.
  const m1 = extractMachineIdentity({ inbound: baseBody })
  assert.deepEqual(m1, { machineId: 'meta-machine', machineSource: 'metadata:machine_id' })

  const mCamel = extractMachineIdentity({
    inbound: {
      machine_id: 'top-machine',
      metadata: { user_id: { machineId: 'meta-camel-machine', deviceId: 'meta-dev' } },
    },
  })
  assert.deepEqual(mCamel, { machineId: 'meta-camel-machine', machineSource: 'metadata:machine_id' })

  const mTypo = extractMachineIdentity({
    inbound: {
      machine_id: 'top-machine',
      metadata: { user_id: JSON.stringify({ meachine_id: 'meta-meachine', device_id: 'meta-dev' }) },
    },
  })
  assert.deepEqual(mTypo, { machineId: 'meta-meachine', machineSource: 'metadata:machine_id' })

  // 2b. metadata.user_id device_id beats top-level body machine_id.
  const mDev = extractMachineIdentity({
    inbound: {
      machine_id: 'top-machine',
      metadata: { user_id: 'user_legacy-dev_account_acc-1_session_sess-1' },
    },
  })
  assert.deepEqual(mDev, { machineId: 'legacy-dev', machineSource: 'metadata:device_id' })

  // 2c. Direct metadata.machine_id / metadata.meachine_id (before sanitizeInboundBody strips it).
  const mDirect = extractMachineIdentity({
    inbound: {
      machine_id: 'top-machine',
      metadata: { meachine_id: 'direct-meta-meachine' },
    },
  })
  assert.deepEqual(mDirect, { machineId: 'direct-meta-meachine', machineSource: 'metadata:machine_id' })

  // 3a. Top-level machine_id / meachine_id beats top-level device_id.
  const b1 = extractMachineIdentity({
    inbound: { machine_id: 'top-machine', meachine_id: 'top-meachine', device_id: 'top-device' },
  })
  assert.deepEqual(b1, { machineId: 'top-machine', machineSource: 'body:machine_id' })

  const bTypo = extractMachineIdentity({
    inbound: { meachine_id: 'top-meachine', device_id: 'top-device' },
  })
  assert.deepEqual(bTypo, { machineId: 'top-meachine', machineSource: 'body:machine_id' })

  // 3b. Top-level device_id fallback.
  const bDev = extractMachineIdentity({
    inbound: { device_id: 'top-device' },
  })
  assert.deepEqual(bDev, { machineId: 'top-device', machineSource: 'body:device_id' })
})

test('missing machine_id is never forged from IP, UA, API key, or message content', () => {
  const input = {
    inbound: {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Explain how TCP congestion control works in detail.' }],
    },
    headers: {
      authorization: 'Bearer sk-secret',
      'x-api-key': 'sk-secret-2',
      'x-forwarded-for': '203.0.113.42',
      'x-real-ip': '203.0.113.42',
      'user-agent': 'claude-cli/2.1.241 (external, sdk-cli)',
    },
  }
  const legacy = resolveInboundIdentity(input)
  assert.equal(legacy.machineId, '')
  assert.equal(legacy.machineSource, 'none')
  assert.deepEqual(legacy, { sessionId: '', deviceId: '', source: 'none' })

  const sched = resolveSchedulerIdentity({ ...input, poolId: 'pool_a', apiKeyId: 'key_1' })
  assert.equal(sched.machineId, null)
  assert.equal(sched.machineSource, 'none')
  assert.equal(sched.deviceId, null)
})

test('explicit session_id honors official order and excludes transient request-id headers', () => {
  const fromMeta = resolveSchedulerIdentity({
    inbound: {
      session_id: 'body-sess',
      metadata: { user_id: JSON.stringify({ session_id: 'meta-sess', machine_id: 'mac-1' }) },
    },
    headers: { 'x-claude-code-session-id': 'hdr-cc-sess', 'x-session-id': 'hdr-sess' },
  })
  assert.equal(fromMeta.sessionId, 'meta-sess')
  assert.equal(fromMeta.sessionSource, 'explicit')
  assert.equal(fromMeta.generated, false)
  assert.equal(fromMeta.parentSessionId, null)

  const fromCcHeader = resolveSchedulerIdentity({
    inbound: { conversation_id: 'body-conv' },
    headers: { 'x-claude-code-session-id': '22222222-2222-4222-8222-222222222222' },
  })
  assert.equal(fromCcHeader.sessionId, '22222222-2222-4222-8222-222222222222')
  assert.equal(fromCcHeader.sessionSource, 'explicit')

  const fromBody = resolveSchedulerIdentity({
    inbound: { prompt_cache_key: 'cache-key-sess' },
  })
  assert.equal(fromBody.sessionId, 'cache-key-sess')
  assert.equal(fromBody.sessionSource, 'explicit')

  // Transient x-request-id / x-client-request-id must NEVER be used as session_id.
  const transientOnly = resolveSchedulerIdentity({
    inbound: { messages: [{ role: 'user', content: 'A single-turn message with transient request ids only.' }] },
    headers: {
      'x-request-id': 'req-transient-1',
      'x-client-request-id': 'creq-transient-2',
    },
  })
  assert.notEqual(transientOnly.sessionId, 'req-transient-1')
  assert.notEqual(transientOnly.sessionId, 'creq-transient-2')
  assert.match(transientOnly.sessionId, UUID_V4_RE)
  assert.equal(transientOnly.generated, true)
  assert.equal(transientOnly.sessionSource, 'generated_random')
})

test('sub-agent session derives pure UUIDv4 via agentSessionId() and preserves parentSessionId', () => {
  const rootSession = '33333333-3333-4333-8333-333333333333'
  const agentA = resolveSchedulerIdentity({
    inbound: {
      metadata: { user_id: JSON.stringify({ device_id: 'dev-1', session_id: rootSession }) },
    },
    headers: {
      'x-claude-code-agent-id': 'agent-alpha',
    },
  })
  const agentA2 = resolveSchedulerIdentity({
    inbound: {
      metadata: { user_id: JSON.stringify({ device_id: 'dev-1', session_id: rootSession }) },
    },
    headers: {
      'X-Claude-Code-Agent-Id': 'agent-alpha',
    },
  })
  const agentB = resolveSchedulerIdentity({
    inbound: {
      metadata: { user_id: JSON.stringify({ device_id: 'dev-1', session_id: rootSession }) },
    },
    headers: {
      'x-claude-code-agent-id': 'agent-beta',
    },
  })

  assert.equal(agentA.sessionId, agentSessionId(rootSession, 'agent-alpha'))
  assert.equal(agentA.sessionId, agentA2.sessionId)
  assert.notEqual(agentA.sessionId, rootSession)
  assert.notEqual(agentA.sessionId, agentB.sessionId)
  assert.match(agentA.sessionId, UUID_V4_RE)
  assert.match(agentB.sessionId, UUID_V4_RE)
  assert.equal(FORBIDDEN_SESSION_PREFIX_RE.test(agentA.sessionId), false)
  assert.equal(agentA.parentSessionId, rootSession)
  assert.equal(agentB.parentSessionId, rootSession)
  assert.equal(agentA.sessionSource, 'subagent')
  assert.equal(agentA.agentId, 'agent-alpha')
  assert.equal(agentA.generated, false)
})

test('missing session_id: multi-turn deterministic pure UUIDv4 with zero cross-machine/pool/key collision', () => {
  const reminder = '<system-reminder>Date: 2026-11-27; cwd: /work/app</system-reminder>'
  const turn2 = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: reminder },
          { type: 'text', text: 'Design a lock-free session gate in Rust.' },
        ],
      },
      { role: 'assistant', content: 'Here is a DashMap entry design.' },
    ],
  }
  const turn3 = {
    messages: [...turn2.messages, { role: 'user', content: 'Now add RAII Drop cancellation safety.' }],
  }

  const sTurn2 = resolveSchedulerIdentity({
    inbound: turn2,
    headers: { 'x-machine-id': 'mac-A' },
    poolId: 'pool_1',
    apiKeyId: 'key_shared',
  })
  const sTurn3 = resolveSchedulerIdentity({
    inbound: turn3,
    headers: { 'x-machine-id': 'mac-A' },
    poolId: 'pool_1',
    apiKeyId: 'key_shared',
  })
  const sOtherMachine = resolveSchedulerIdentity({
    inbound: turn2,
    headers: { 'x-machine-id': 'mac-B' },
    poolId: 'pool_1',
    apiKeyId: 'key_shared',
  })
  const sNoMachine = resolveSchedulerIdentity({
    inbound: turn2,
    headers: {},
    poolId: 'pool_1',
    apiKeyId: 'key_shared',
  })
  const sOtherPool = resolveSchedulerIdentity({
    inbound: turn2,
    headers: { 'x-machine-id': 'mac-A' },
    poolId: 'pool_2',
    apiKeyId: 'key_shared',
  })
  const sOtherKey = resolveSchedulerIdentity({
    inbound: turn2,
    headers: { 'x-machine-id': 'mac-A' },
    poolId: 'pool_1',
    apiKeyId: 'key_other',
  })

  for (const item of [sTurn2, sTurn3, sOtherMachine, sNoMachine, sOtherPool, sOtherKey]) {
    assert.match(item.sessionId, UUID_V4_RE)
    assert.equal(FORBIDDEN_SESSION_PREFIX_RE.test(item.sessionId), false)
    assert.equal(item.sessionSource, 'derived_multi_turn')
    assert.equal(item.generated, true)
    assert.equal(item.isEphemeralProbe, false)
  }

  // Same machine + pool + key + first user anchor stays deterministic across turns.
  assert.equal(sTurn2.sessionId, sTurn3.sessionId)
  // Different machine_id on the same API key never collides.
  assert.notEqual(sTurn2.sessionId, sOtherMachine.sessionId)
  assert.notEqual(sTurn2.sessionId, sNoMachine.sessionId)
  assert.notEqual(sOtherMachine.sessionId, sNoMachine.sessionId)
  // Different pool or API key never collides.
  assert.notEqual(sTurn2.sessionId, sOtherPool.sessionId)
  assert.notEqual(sTurn2.sessionId, sOtherKey.sessionId)
})

test('missing session_id: OpenAI Responses input[] and Gemini contents[] multi-turn deterministic UUIDv4', () => {
  const responsesTurn2 = {
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '<system-reminder>cwd: /tmp</system-reminder>' },
          { type: 'input_text', text: 'Summarize PostgreSQL WAL checkpoints.' },
        ],
      },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Checkpoints flush dirty pages.' }] },
    ],
  }
  const responsesTurn3 = {
    input: [...responsesTurn2.input, { role: 'user', content: 'What about checkpoint_completion_target?' }],
  }
  const r2 = resolveSchedulerIdentity({
    inbound: responsesTurn2,
    headers: { 'x-machine-id': 'mac-resp-1' },
    poolId: 'pool_openai',
    apiKeyId: 'key_1',
  })
  const r3 = resolveSchedulerIdentity({
    inbound: responsesTurn3,
    headers: { 'x-machine-id': 'mac-resp-1' },
    poolId: 'pool_openai',
    apiKeyId: 'key_1',
  })
  const rOtherMac = resolveSchedulerIdentity({
    inbound: responsesTurn2,
    headers: { 'x-machine-id': 'mac-resp-2' },
    poolId: 'pool_openai',
    apiKeyId: 'key_1',
  })
  assert.match(r2.sessionId, UUID_V4_RE)
  assert.equal(r2.sessionSource, 'derived_multi_turn')
  assert.equal(r2.sessionId, r3.sessionId)
  assert.notEqual(r2.sessionId, rOtherMac.sessionId)

  const geminiTurn2 = {
    contents: [
      {
        role: 'user',
        parts: [{ text: '<system-reminder>date: 2026-11-27</system-reminder>' }, { text: 'Compare Gemini models.' }],
      },
      { role: 'model', parts: [{ text: 'Gemini Pro and Flash differ in latency.' }] },
    ],
  }
  const geminiTurn3 = {
    contents: [...geminiTurn2.contents, { role: 'user', parts: [{ text: 'Which supports longer context?' }] }],
  }
  const g2 = resolveSchedulerIdentity({
    inbound: geminiTurn2,
    headers: { 'x-machine-id': 'mac-gem-1' },
    poolId: 'pool_google',
    apiKeyId: 'key_1',
  })
  const g3 = resolveSchedulerIdentity({
    inbound: geminiTurn3,
    headers: { 'x-machine-id': 'mac-gem-1' },
    poolId: 'pool_google',
    apiKeyId: 'key_1',
  })
  const gOtherMac = resolveSchedulerIdentity({
    inbound: geminiTurn2,
    headers: { 'x-machine-id': 'mac-gem-2' },
    poolId: 'pool_google',
    apiKeyId: 'key_1',
  })
  assert.match(g2.sessionId, UUID_V4_RE)
  assert.equal(g2.sessionSource, 'derived_multi_turn')
  assert.equal(g2.sessionId, g3.sessionId)
  assert.notEqual(g2.sessionId, gOtherMac.sessionId)
})

test('missing session_id: single-turn or reminder-only uses crypto.randomUUID() pure UUIDv4', () => {
  const singleTurn = {
    messages: [{ role: 'user', content: 'Please write a thorough analysis of B-tree vs LSM-tree storage engines.' }],
  }
  const a = resolveSchedulerIdentity({
    inbound: singleTurn,
    headers: { 'x-machine-id': 'mac-1' },
    poolId: 'pool_1',
    apiKeyId: 'key_1',
  })
  const b = resolveSchedulerIdentity({
    inbound: singleTurn,
    headers: { 'x-machine-id': 'mac-1' },
    poolId: 'pool_1',
    apiKeyId: 'key_1',
  })
  assert.match(a.sessionId, UUID_V4_RE)
  assert.match(b.sessionId, UUID_V4_RE)
  assert.notEqual(a.sessionId, b.sessionId)
  assert.equal(a.sessionSource, 'generated_random')
  assert.equal(a.generated, true)
  assert.equal(a.isEphemeralProbe, false)
  assert.equal(FORBIDDEN_SESSION_PREFIX_RE.test(a.sessionId), false)

  // Multi-turn whose first user turn has only <system-reminder> (no real user anchor) falls back to randomUUID().
  const reminderOnlyMultiTurn = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: '<system-reminder>only context</system-reminder>' }] },
      { role: 'assistant', content: 'ready' },
    ],
  }
  const r1 = resolveSchedulerIdentity({ inbound: reminderOnlyMultiTurn, poolId: 'pool_1', apiKeyId: 'key_1' })
  const r2 = resolveSchedulerIdentity({ inbound: reminderOnlyMultiTurn, poolId: 'pool_1', apiKeyId: 'key_1' })
  assert.match(r1.sessionId, UUID_V4_RE)
  assert.match(r2.sessionId, UUID_V4_RE)
  assert.notEqual(r1.sessionId, r2.sessionId)
  assert.equal(r1.sessionSource, 'generated_random')
})

test('isEphemeralProbe flags short tool-less probes and clears normal/multi-turn/tool requests', () => {
  const probe = resolveSchedulerIdentity({
    inbound: { messages: [{ role: 'user', content: 'ping' }] },
  })
  assert.equal(probe.isEphemeralProbe, true)

  const withTools = resolveSchedulerIdentity({
    inbound: {
      messages: [{ role: 'user', content: 'ping' }],
      tools: [{ name: 'bash', input_schema: { type: 'object' } }],
    },
  })
  assert.equal(withTools.isEphemeralProbe, false)

  const longSingle = resolveSchedulerIdentity({
    inbound: { messages: [{ role: 'user', content: 'x'.repeat(80) }] },
  })
  assert.equal(longSingle.isEphemeralProbe, false)

  const multiTurnShort = resolveSchedulerIdentity({
    inbound: {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    },
  })
  assert.equal(multiTurnShort.isEphemeralProbe, false)
})

test('outbound sanitization strips 100% of machine_id/meachine_id/device_id and identity headers', () => {
  const rawBody = {
    model: 'claude-sonnet-4-6',
    machine_id: 'top-mac',
    machineId: 'top-mac-camel',
    meachine_id: 'top-meac',
    meachineId: 'top-meac-camel',
    device_id: 'top-dev',
    deviceId: 'top-dev-camel',
    user: 'caller-user',
    user_id: 'caller-uid',
    metadata: {
      user_id: JSON.stringify({ machine_id: 'meta-mac', device_id: 'meta-dev', session_id: 'meta-sess' }),
      machine_id: 'meta-direct-mac',
      machineId: 'meta-direct-mac-camel',
      meachine_id: 'meta-direct-meac',
      meachineId: 'meta-direct-meac-camel',
      device_id: 'meta-direct-dev',
      custom_keep: 'ok',
    },
    messages: [{ role: 'user', content: 'hello world' }],
  }

  const sanitized = sanitizeInboundBody(rawBody, defaultSeedPolicy())
  for (const key of [
    'machine_id',
    'machineId',
    'meachine_id',
    'meachineId',
    'device_id',
    'deviceId',
    'user',
    'user_id',
  ]) {
    assert.equal(Object.hasOwn(sanitized, key), false, `expected top-level ${key} stripped`)
  }
  assert.deepEqual(sanitized.metadata, { custom_keep: 'ok' })

  const rawHeaders = {
    'x-machine-id': 'hdr-mac',
    'X-Machine-Id': 'hdr-mac-mixed',
    'x-kin-machine-id': 'hdr-kin-mac',
    'X-KIN-MACHINE-ID': 'hdr-kin-mac-upper',
    'x-kin-device-id': 'hdr-kin-dev',
    'X-Kin-Device-Id': 'hdr-kin-dev-mixed',
    'x-claude-code-session-id': '44444444-4444-4444-8444-444444444444',
    'anthropic-version': '2023-06-01',
  }
  const cleanHeaders = sanitizeOutboundHeaders(rawHeaders)
  const lowerKeys = Object.keys(cleanHeaders).map((k) => k.toLowerCase())
  assert.equal(lowerKeys.includes('x-machine-id'), false)
  assert.equal(lowerKeys.includes('x-kin-machine-id'), false)
  assert.equal(lowerKeys.includes('x-kin-device-id'), false)
  assert.equal(cleanHeaders['x-claude-code-session-id'], '44444444-4444-4444-8444-444444444444')
  assert.equal(cleanHeaders['anthropic-version'], '2023-06-01')

  // applyCrsIdentityReplace + prepareOutboundEnvelope also strip machine_id / meachine_id.
  const slotIdentity = {
    vmId: 'vm-01',
    deviceId: 'slot-dev',
    accountUuid: 'slot-acc',
    sessionId: 'slot-sess',
  }
  const replaced = applyCrsIdentityReplace(rawBody, slotIdentity, rawBody, cleanHeaders, { officialClient: false })
  for (const key of ['machine_id', 'machineId', 'meachine_id', 'meachineId', 'device_id', 'deviceId']) {
    assert.equal(Object.hasOwn(replaced, key), false)
  }
  assert.equal(replaced.metadata.machine_id, undefined)
  assert.equal(replaced.metadata.meachine_id, undefined)
  assert.equal(replaced.metadata.custom_keep, 'ok')

  const envelope = prepareOutboundEnvelope({
    canonicalBody: sanitized,
    inbound: rawBody,
    identity: slotIdentity,
    unofficial: false,
    officialClient: true,
    reqHeaders: cleanHeaders,
  })
  const envHeaderKeys = Object.keys(envelope.headers).map((k) => k.toLowerCase())
  assert.equal(envHeaderKeys.includes('x-machine-id'), false)
  assert.equal(envHeaderKeys.includes('x-kin-machine-id'), false)
  assert.equal(envHeaderKeys.includes('x-kin-device-id'), false)
  assert.equal(envelope.body.machine_id, undefined)
  assert.equal(envelope.body.meachine_id, undefined)
})

test('prepareInboundProtocolContext extracts frozen ctx.inboundIdentity BEFORE sanitizeInboundBody', () => {
  const inbound = {
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    meachine_id: 'top-meachine',
    metadata: {
      machine_id: 'meta-only-machine',
      meachine_id: 'meta-meachine',
      user_id: JSON.stringify({ session_id: '55555555-5555-4555-8555-555555555555' }),
    },
    messages: [{ role: 'user', content: 'Analyze the protocol pipeline ordering.' }],
  }
  const headers = {
    'X-Kin-Machine-Id': 'hdr-kin-mac',
    'x-machine-id': 'hdr-mac',
    'x-kin-device-id': 'hdr-dev',
    'user-agent': 'claude-cli/2.1.241',
  }

  const { ctx } = prepareInboundProtocolContext({
    inbound,
    headers,
    pathName: '/v1/messages',
    protocol: 'anthropic.messages',
    poolId: 'pool_01',
    apiKeyId: 'key_01',
  })

  assert.equal(Object.isFrozen(ctx.inboundIdentity), true)
  assert.throws(() => {
    ctx.inboundIdentity.machineId = 'tampered'
  }, TypeError)
  assert.equal(ctx.inboundIdentity.machineId, 'hdr-mac')
  assert.equal(ctx.inboundIdentity.machineSource, 'header:x-machine-id')
  assert.equal(ctx.inboundIdentity.sessionId, '55555555-5555-4555-8555-555555555555')

  // Body & headers on ctx are already 100% sanitized.
  assert.equal(ctx.body.meachine_id, undefined)
  assert.equal(ctx.body.metadata, undefined)
  assert.equal(ctx.headers['x-machine-id'], undefined)
  assert.equal(ctx.headers['X-Kin-Machine-Id'], undefined)
  assert.equal(ctx.headers['x-kin-device-id'], undefined)

  // Verify metadata-only machine_id (which sanitizeInboundBody strips) survives into ctx.inboundIdentity.
  const metaOnly = prepareInboundProtocolContext({
    inbound: {
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      metadata: { machine_id: 'meta-stripped-mac', user_id: JSON.stringify({ session_id: 'sess-meta-only' }) },
      messages: [{ role: 'user', content: 'Check metadata extraction timing.' }],
    },
    headers: {},
    pathName: '/v1/messages',
    protocol: 'anthropic.messages',
  })
  assert.equal(metaOnly.ctx.inboundIdentity.machineId, 'meta-stripped-mac')
  assert.equal(metaOnly.ctx.inboundIdentity.machineSource, 'metadata:machine_id')
  assert.equal(metaOnly.ctx.body.metadata, undefined)
})

test('handleProtocol extracts identity before sanitizeInboundBody, strips upstream leaks, and adds zero custom response headers', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-m0-identity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routing = {
    sticky: { outbound_session: 'passthrough' },
    compatibility: { persona_preset: 'official_full', overlay_preset: 'off' },
  }
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))

  let capturedRunOpts = null
  const responseHeaders = {}
  let responseStatus = 0
  let responseBody = null

  const handler = createHandleProtocol({
    json(res, status, body) {
      responseStatus = status
      responseBody = body
      res.statusCode = status
      res.emit('finish')
      return body
    },
    writeSSEHeaders() {},
    readBody: async (req) => structuredClone(req.body),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'req-m0-1' }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {}, recordUsage() {} },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: {
      async run(opts) {
        capturedRunOpts = opts
        return {
          ok: true,
          status: 200,
          vmId: 'vm-1',
          accountId: 'acc-1',
          attemptCount: 1,
          finalState: 'verified',
          body: {
            id: 'msg_01',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        }
      },
    },
  })

  const req = Object.assign(new EventEmitter(), {
    headers: {
      'x-machine-id': 'hdr-e2e-mac',
      'x-kin-machine-id': 'hdr-kin-mac',
      'x-kin-device-id': 'hdr-kin-dev',
    },
    apiKeyKind: 'managed',
    apiKeyRecord: { id: 'key_e2e', group_type: 'anthropic' },
    body: {
      model: 'claude-sonnet-4-6',
      max_tokens: 128,
      stream: false,
      machine_id: 'top-e2e-mac',
      meachine_id: 'top-e2e-meac',
      metadata: {
        machine_id: 'meta-e2e-mac',
        meachine_id: 'meta-e2e-meac',
      },
      messages: [
        { role: 'user', content: 'Implement M0 identity chain with official UUIDv4 sessions.' },
        { role: 'assistant', content: 'Sure, let us review the requirements.' },
      ],
    },
  })
  const res = Object.assign(new EventEmitter(), {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    closed: false,
    setHeader(name, value) {
      responseHeaders[String(name).toLowerCase()] = value
    },
  })

  await handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages')

  assert.equal(responseStatus, 200)
  assert.ok(capturedRunOpts, 'expected failoverRunner.run to execute')
  assert.equal(Object.isFrozen(capturedRunOpts.inboundIdentity), true)
  assert.equal(capturedRunOpts.inboundIdentity.machineId, 'hdr-e2e-mac')
  assert.equal(capturedRunOpts.inboundIdentity.machineSource, 'header:x-machine-id')
  assert.match(capturedRunOpts.inboundIdentity.sessionId, UUID_V4_RE)
  assert.equal(capturedRunOpts.inboundIdentity.sessionSource, 'derived_multi_turn')
  assert.equal(FORBIDDEN_SESSION_PREFIX_RE.test(capturedRunOpts.inboundIdentity.sessionId), false)

  // Canonical outbound body contains zero machine_id / meachine_id / metadata leak.
  assert.equal(capturedRunOpts.canonicalBody.machine_id, undefined)
  assert.equal(capturedRunOpts.canonicalBody.meachine_id, undefined)
  assert.equal(capturedRunOpts.canonicalBody.metadata, undefined)

  // Client response contains ZERO custom session headers or custom body properties (D3).
  assert.deepEqual(Object.keys(responseHeaders), [])
  assert.equal(responseHeaders['x-vm2api-session-id'], undefined)
  assert.equal(Object.hasOwn(responseBody, 'session_id'), false)
  assert.equal(Object.hasOwn(responseBody, 'machine_id'), false)
})
