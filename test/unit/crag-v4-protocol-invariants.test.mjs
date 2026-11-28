import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CRS_OFFICIAL_CLI_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import {
  restoreToolNames,
  restoreToolNamesInSSELine,
  scrubUpstreamClientBody,
  toStandardAnthropicBody,
} from '../../src/lib/protocol/anthropic-policy.mjs'
import { sanitizeCragBodyWhitelist } from '../../src/lib/protocol/crag-whitelist.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { prepareCragRequest } from '../../src/lib/protocol/kernel-request.mjs'
import { validateToolChoice } from '../../src/lib/protocol/model-policy.mjs'
import { foldThirdPartyRoleSystemMessages, prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { dropEmptySystemControlTurns, normalizeAnthropicMessages } from '../../src/lib/protocol/sanitize.mjs'
import { extractThirdPartySystemMessages } from '../../src/lib/protocol/third-party-system.mjs'
import { handleUserCountTokens, sanitizeThirdPartyCountTokensBody } from '../../src/lib/protocol/user-count-tokens.mjs'
import { clearRustHealthCache, rememberRustHealth } from '../../src/lib/transport/kernel-router.mjs'
import { createFailoverMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'

const HEADLESS_V4_CAPS = [
  'generation_controls_v3',
  'headless_claude_bridge_v1',
  'count_tokens_v1',
  'native_handoff_v1',
  'provider_result_v2',
  'provider_managed_tools_v1',
  'request_safeguards',
  'request_speed',
]

function makeCragHealth(capabilities = HEADLESS_V4_CAPS) {
  return {
    ok: true,
    ready: true,
    status: 'ready',
    cli_pid: 22222,
    ready_slots: 10,
    runtime_variant: 'crag-v2',
    transport: capabilities.includes('headless_claude_bridge_v1') ? 'headless_bridge' : 'print',
    capabilities,
  }
}

function makeResponse() {
  const res = {
    headersSent: false,
    statusCode: 0,
    status: 0,
    headers: {},
    body: null,
    chunks: [],
    writableEnded: false,
    destroyed: false,
    setHeader(k, v) {
      res.headers[String(k).toLowerCase()] = v
    },
    writeHead(status, headers = {}) {
      res.statusCode = status
      res.status = status
      res.headersSent = true
      for (const [k, v] of Object.entries(headers)) res.headers[String(k).toLowerCase()] = v
    },
    write(chunk) {
      res.headersSent = true
      res.chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk) res.write(chunk)
      res.headersSent = true
      res.writableEnded = true
    },
    on() {},
    once() {},
    off() {},
  }
  return res
}

function createProtocolHarness(t, { routing, vm, health, onCallAttempt } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-v4-inv-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  clearRustHealthCache()
  t.after(() => clearRustHealthCache())

  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))

  const exec = { vmId: vm.id, vm, homeDir: root, workerStatus: health }
  if (health) rememberRustHealth(exec, { ok: true, health })

  const scheduler = {
    async selectAndReserve() {
      return {
        ok: true,
        vmId: vm.id,
        accountId: vm.id,
        vm,
        exec,
        release() {},
      }
    },
    markSuccess() {},
    markCooldown() {},
    releaseAccountSessions() {},
  }
  const schedulerRuntime = createFailoverMockSchedulerRuntime({ scheduler })
  const runner = new FailoverRunner({
    scheduler,
    schedulerRuntime,
    config: { max_same_account_retries: 0 },
  })

  return async function invoke({ body, headers, apiKeyRecord = { id: 'key_inv' }, protocol = 'anthropic.messages' }) {
    const res = makeResponse()
    const captured = []
    const handler = createHandleProtocol({
      json(_res, status, payload) {
        res.status = status
        res.statusCode = status
        res.body = payload
        return payload
      },
      writeSSEHeaders(_res, extraHeaders = {}) {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...(extraHeaders || {}) })
      },
      readBody: async () => structuredClone(body),
      requireAuth: () => true,
      cfg: {
        rewrite: { enabled: false },
        intercept: { rules: [] },
        distill: { enabled: false },
        limits: { max_body_bytes: 2 * 1024 * 1024, upstream_timeout_ms: 2000 },
        paths: { data: root, project: root },
      },
      vms: [vm],
      requestLog: { start: () => ({ request_id: 'crag-v4-inv-req' }), finish() {} },
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
        run(opts) {
          return runner.run({
            ...opts,
            async callAttempt(callCtx) {
              captured.push({
                hopBody: structuredClone(callCtx.body),
                attemptMeta: callCtx.attemptMeta,
              })
              if (onCallAttempt) return onCallAttempt(callCtx, { exec, routing, headers })
              return {
                ok: true,
                status: 200,
                terminalState: 'verified',
                body: {
                  id: 'msg_inv_ok',
                  type: 'message',
                  role: 'assistant',
                  model: body.model,
                  content: [{ type: 'text', text: 'ok' }],
                  stop_reason: 'end_turn',
                  usage: { input_tokens: 10, output_tokens: 2 },
                },
              }
            },
          })
        },
      },
    })

    await handler.handleProtocol(
      {
        method: 'POST',
        url: '/v1/messages',
        headers,
        apiKeyKind: 'managed',
        apiKeyRecord,
        once() {},
        off() {},
      },
      res,
      protocol,
      '/v1/messages',
    )
    return { res, captured }
  }
}

/** Invariant 1: every tool_addition / tool_removal block MUST live inside role === "system". */
function assertToolChangeRoleInvariant(messages, label = '') {
  assert.ok(Array.isArray(messages), `${label}: messages must be an array`)
  for (const [index, msg] of messages.entries()) {
    if (!Array.isArray(msg?.content)) continue
    for (const [blockIndex, block] of msg.content.entries()) {
      if (block?.type === 'tool_addition' || block?.type === 'tool_removal') {
        assert.equal(
          msg.role,
          'system',
          `${label}: messages[${index}].content[${blockIndex}] (${block.type}) leaked into role="${msg.role}"`,
        )
      }
    }
  }
}

/** Invariant 2: all tool references and tool_choice close over tools[] U inline tool_definition, and reverse-map cleanly. */
function assertToolNameClosureInvariant(body, reverse = {}, label = '') {
  const declared = new Set()
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (typeof tool?.name === 'string' && tool.name) declared.add(tool.name)
  }
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!Array.isArray(msg?.content)) continue
    for (const block of msg.content) {
      if (
        block?.type === 'tool_addition' &&
        block.tool?.type === 'tool_definition' &&
        typeof block.tool.definition?.name === 'string'
      ) {
        declared.add(block.tool.definition.name)
      }
    }
  }
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!Array.isArray(msg?.content)) continue
    for (const block of msg.content) {
      if (block?.type === 'tool_use') {
        assert.ok(declared.has(block.name), `${label}: tool_use "${block.name}" not in declared set`)
      }
      if (
        (block?.type === 'tool_addition' || block?.type === 'tool_removal') &&
        block.tool?.type === 'tool_reference'
      ) {
        assert.ok(declared.has(block.tool.name), `${label}: ${block.type} ref "${block.tool.name}" not in declared set`)
      }
      if (block?.type === 'tool_result' && Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner?.type === 'tool_reference') {
            assert.ok(
              declared.has(inner.tool_name),
              `${label}: tool_result tool_reference "${inner.tool_name}" not in declared set`,
            )
          }
        }
      }
      if (block?.type === 'tool_search_tool_result' && Array.isArray(block.tool_references)) {
        for (const ref of block.tool_references) {
          assert.ok(
            declared.has(ref.tool_name),
            `${label}: tool_search_tool_result ref "${ref.tool_name}" not in declared set`,
          )
        }
      }
    }
  }
  if (body.tool_choice?.type === 'tool') {
    assert.ok(
      declared.has(body.tool_choice.name),
      `${label}: tool_choice.name "${body.tool_choice.name}" not in declared set`,
    )
  }
  for (const [wire, client] of Object.entries(reverse || {})) {
    const jsonRestored = restoreToolNames(
      {
        type: 'message',
        content: [{ type: 'tool_use', id: `tu_${wire}`, name: wire, input: {} }],
      },
      reverse,
    )
    assert.equal(jsonRestored.content[0].name, client, `${label}: JSON restore failed for ${wire}`)
    const sseRestored = restoreToolNamesInSSELine(
      `data: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: `tu_${wire}`, name: wire, input: {} },
      })}`,
      reverse,
    )
    assert.equal(
      JSON.parse(sseRestored.slice(5)).content_block.name,
      client,
      `${label}: SSE restore failed for ${wire}`,
    )
  }
}

/** Invariant 3: relocated third-party text moves into the first user turn and leaves every role=system turn. */
function assertThirdPartySystemTextIsolation(messages, expectedMovedTexts, label = '') {
  const firstUser = messages.find((m) => m?.role === 'user')
  assert.ok(firstUser, `${label}: expected a user turn`)
  const firstUserSerialized = JSON.stringify(firstUser.content)
  const systemSerialized = JSON.stringify(messages.filter((m) => m?.role === 'system' || m?.role === 'developer'))
  for (const text of expectedMovedTexts) {
    assert.ok(firstUserSerialized.includes(text), `${label}: expected "${text}" in first user turn`)
    assert.equal(systemSerialized.includes(text), false, `${label}: "${text}" must not stay in role=system`)
  }
}

test('live production repro: Go-http-client/2.0 relayed CC on opus-5-5 keeps mid & leading role=system tool_addition/tool_removal/output_config/clear_at intact while relocating mixed text', async (t) => {
  const vm = {
    id: 'vm-35',
    node_id: 'node-ph24',
    dataplane: 'wrap',
    official_cc_inference: 'cli-hop',
    timezone: 'Asia/Shanghai',
    locale: 'en_US.UTF-8',
  }
  const routing = {
    sticky: { outbound_session: 'passthrough' },
    compatibility: {
      persona_preset: 'official_full',
      crag_persona_preset: 'official_full',
      official_cc_passthrough: false,
      claude_code_only: false,
      crag_strict_passthrough: false,
    },
  }
  const relayHeaders = {
    authorization: 'Bearer sk-relay',
    'user-agent': 'Go-http-client/2.0',
    'anthropic-version': '2023-06-01',
  }
  const invokeCrag = createProtocolHarness(t, {
    routing,
    vm,
    health: makeCragHealth(HEADLESS_V4_CAPS),
  })

  // Case A: Mid-conversation mixed role=system turns (messages[0] is user)
  const midBody = {
    model: 'claude-opus-5-5',
    max_tokens: 16384,
    stream: false,
    thinking: { type: 'adaptive', display: 'summarized' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Inspect the repo' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Checking now.' }] },
      {
        role: 'system',
        clear_at: 4,
        output_config: { effort: 'high' },
        content: [
          { type: 'text', text: 'Mid-turn third-party relay instruction A.' },
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: {
                name: 'relay_grep',
                description: 'OpenCode grep helper',
                input_schema: { type: 'object', properties: { pattern: { type: 'string' } } },
              },
            },
          },
        ],
      },
      {
        role: 'system',
        clear_at: 5,
        output_config: { effort: 'max' },
        content: [
          { type: 'text', text: 'Mid-turn third-party relay instruction B.' },
          { type: 'tool_removal', tool: { type: 'tool_reference', name: 'relay_grep' } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
    ],
  }

  const midRes = await invokeCrag({ body: midBody, headers: relayHeaders })
  assert.equal(midRes.res.status, 200, JSON.stringify(midRes.res.body))
  assert.equal(midRes.captured[0].attemptMeta.officialTraffic, false)
  const midHop = midRes.captured[0].hopBody
  const midReverse = midRes.captured[0].attemptMeta.toolNames

  assertToolChangeRoleInvariant(midHop.messages, 'mid-repro')
  assertToolNameClosureInvariant(midHop, midReverse, 'mid-repro')
  assertThirdPartySystemTextIsolation(
    midHop.messages,
    ['Mid-turn third-party relay instruction A.', 'Mid-turn third-party relay instruction B.'],
    'mid-repro',
  )
  assert.equal(midHop.messages[0].role, 'user')
  const midSysTurns = midHop.messages.filter((m) => m.role === 'system')
  assert.equal(midSysTurns.length, 2, 'consecutive role=system turns with controls must remain separate')
  assert.equal(midSysTurns[0].clear_at, 4)
  assert.deepEqual(midSysTurns[0].output_config, { effort: 'high' })
  assert.equal(midSysTurns[0].content[0].type, 'tool_addition')
  assert.equal(midSysTurns[0].content[0].tool.definition.name, 'mcp__relay_grep')
  assert.equal(midSysTurns[0].content[0].tool.definition.description, 'Claude Code grep helper')
  assert.equal(midSysTurns[1].clear_at, 5)
  assert.deepEqual(midSysTurns[1].output_config, { effort: 'max' })
  assert.equal(midSysTurns[1].content[0].type, 'tool_removal')
  assert.equal(midSysTurns[1].content[0].tool.name, 'mcp__relay_grep')
  // Whitelist boundary must accept the final outbound payload cleanly.
  assert.doesNotThrow(() => prepareCragRequest(midHop, { capabilities: HEADLESS_V4_CAPS }))

  // Case B: Leading role=system carrying mixed text + tool_addition + output_config + clear_at,
  // plus mid-conversation role=system carrying mixed text + tool_removal.
  const leadingBody = {
    model: 'claude-opus-5-5',
    max_tokens: 16384,
    stream: false,
    thinking: { type: 'adaptive', display: 'summarized' },
    messages: [
      {
        role: 'system',
        clear_at: 2,
        output_config: { effort: 'high' },
        content: [
          { type: 'text', text: 'Leading relay persona prompt.' },
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: {
                name: 'inline_search',
                description: 'Cherry Studio search tool',
                input_schema: { type: 'object', properties: { q: { type: 'string' } } },
              },
            },
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Find bugs' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'inline_search', input: { q: '400' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'matched line 306' }],
      },
      {
        role: 'system',
        clear_at: 6,
        output_config: { effort: 'max' },
        content: [
          { type: 'text', text: 'Mid relay cleanup note.' },
          { type: 'tool_removal', tool: { type: 'tool_reference', name: 'inline_search' } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Summarize' }] },
    ],
  }

  const leadRes = await invokeCrag({ body: leadingBody, headers: relayHeaders })
  assert.equal(leadRes.res.status, 200, JSON.stringify(leadRes.res.body))
  const leadHop = leadRes.captured[0].hopBody
  const leadReverse = leadRes.captured[0].attemptMeta.toolNames

  assertToolChangeRoleInvariant(leadHop.messages, 'leading-repro')
  assertToolNameClosureInvariant(leadHop, leadReverse, 'leading-repro')
  assertThirdPartySystemTextIsolation(
    leadHop.messages,
    ['Leading relay persona prompt.', 'Mid relay cleanup note.'],
    'leading-repro',
  )
  // Leading system control turn must stay at index 0 with NO fake `{ role: 'user', content: '.' }` prepended.
  assert.equal(leadHop.messages[0].role, 'system')
  assert.equal(leadHop.messages[0].clear_at, 2)
  assert.deepEqual(leadHop.messages[0].output_config, { effort: 'high' })
  assert.equal(leadHop.messages[0].content.length, 1)
  assert.equal(leadHop.messages[0].content[0].type, 'tool_addition')
  assert.equal(leadHop.messages[0].content[0].tool.definition.name, 'mcp__inline_search')
  assert.equal(leadHop.messages[0].content[0].tool.definition.description, 'Claude Code search tool')
  assert.equal(leadHop.messages[1].role, 'user')
  assert.equal(leadHop.messages[2].content[0].name, 'mcp__inline_search')
  const trailingSys = leadHop.messages[4]
  assert.equal(trailingSys.role, 'system')
  assert.equal(trailingSys.clear_at, 6)
  assert.deepEqual(trailingSys.output_config, { effort: 'max' })
  assert.equal(trailingSys.content[0].type, 'tool_removal')
  assert.equal(trailingSys.content[0].tool.name, 'mcp__inline_search')
  assert.doesNotThrow(() => prepareCragRequest(leadHop, { capabilities: HEADLESS_V4_CAPS }))

  // Also verify cli-hop path (prepareCliHopBody with officialTraffic=false) satisfies invariants.
  const cliHopOut = prepareCliHopBody(structuredClone(leadingBody), { officialTraffic: false })
  assertToolChangeRoleInvariant(cliHopOut.messages, 'cli-hop-repro')
  assertThirdPartySystemTextIsolation(
    cliHopOut.messages,
    ['Leading relay persona prompt.', 'Mid relay cleanup note.'],
    'cli-hop-repro',
  )
  assert.equal(cliHopOut.messages[0].role, 'system')
  assert.equal(cliHopOut.messages[0].clear_at, 2)
  assert.deepEqual(cliHopOut.messages[0].output_config, { effort: 'high' })
})

test('SSOT extractThirdPartySystemMessages & foldThirdPartyRoleSystemMessages preserve reference stability, clear_at, and leading protocol turns', () => {
  // 1. Pure protocol-only system turn -> foldThirdPartyRoleSystemMessages returns exact original body reference
  const protocolOnly = {
    model: 'claude-opus-5-5',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'system',
        clear_at: 3,
        output_config: { effort: 'max' },
        content: [
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: { name: 'inline_only', input_schema: { type: 'object' } },
            },
          },
        ],
      },
    ],
  }
  assert.equal(foldThirdPartyRoleSystemMessages(protocolOnly), protocolOnly)

  // 2. String content with clear_at preserves the control turn in-place while extracting text
  const clearAtString = extractThirdPartySystemMessages([
    { role: 'system', content: 'Ephemeral third-party prompt', clear_at: 7 },
    { role: 'user', content: 'hi' },
  ])
  assert.deepEqual(clearAtString.moved, [{ type: 'text', text: 'Ephemeral third-party prompt' }])
  assert.deepEqual(clearAtString.messages, [
    { role: 'system', content: [], clear_at: 7 },
    { role: 'user', content: 'hi' },
  ])

  // 3. Consecutive retained system control turns are not collapsed into one when folding
  const consecutiveControls = foldThirdPartyRoleSystemMessages({
    model: 'claude-opus-5-5',
    messages: [
      { role: 'user', content: 'hello' },
      {
        role: 'system',
        cache_control: { type: 'ephemeral' },
        content: [
          { type: 'text', text: 'Extra prose 1' },
          { type: 'tool_addition', tool: { type: 'tool_reference', name: 'tool_a' } },
        ],
      },
      {
        role: 'system',
        clear_at: 4,
        content: [
          { type: 'text', text: 'Extra prose 2' },
          { type: 'tool_removal', tool: { type: 'tool_reference', name: 'tool_a' } },
        ],
      },
    ],
  })
  assertToolChangeRoleInvariant(consecutiveControls.messages, 'consecutive-controls')
  assertThirdPartySystemTextIsolation(
    consecutiveControls.messages,
    ['Extra prose 1', 'Extra prose 2'],
    'consecutive-controls',
  )
  assert.equal(consecutiveControls.messages.length, 3)
  assert.deepEqual(consecutiveControls.messages[1].cache_control, { type: 'ephemeral' })
  assert.equal(consecutiveControls.messages[2].clear_at, 4)

  // 4. normalizeAnthropicMessages preserves leading role=system/developer protocol blocks without fake user turn and is idempotent
  const leadingNormalized = normalizeAnthropicMessages({
    model: 'claude-opus-5-5',
    messages: [
      {
        role: 'developer',
        clear_at: 1,
        content: [
          { type: 'text', text: 'Leading lifted rule' },
          { type: 'tool_addition', tool: { type: 'tool_reference', name: 'Read' } },
        ],
      },
      { role: 'user', content: 'hello' },
    ],
  })
  assert.deepEqual(leadingNormalized.system, [{ type: 'text', text: 'Leading lifted rule' }])
  assert.equal(leadingNormalized.messages[0].role, 'system')
  assert.equal(leadingNormalized.messages[0].clear_at, 1)
  assert.deepEqual(leadingNormalized.messages[0].content, [
    { type: 'tool_addition', tool: { type: 'tool_reference', name: 'Read' } },
  ])
  assert.equal(leadingNormalized.messages[1].role, 'user')
  // Idempotent on second normalization pass
  assert.deepEqual(normalizeAnthropicMessages(structuredClone(leadingNormalized)), leadingNormalized)

  // Leading role=system containing tool_reference stays in-place (not dropped) while lifting sibling text
  const leadingToolRef = normalizeAnthropicMessages({
    model: 'claude-opus-5-5',
    messages: [
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Leading ref note' },
          { type: 'tool_reference', tool_name: 'Read' },
        ],
      },
      { role: 'user', content: 'hello' },
    ],
  })
  assert.deepEqual(leadingToolRef.system, [{ type: 'text', text: 'Leading ref note' }])
  assert.equal(leadingToolRef.messages[0].role, 'system')
  assert.deepEqual(leadingToolRef.messages[0].content, [{ type: 'tool_reference', tool_name: 'Read' }])
  assert.equal(leadingToolRef.messages[1].role, 'user')
  assert.deepEqual(normalizeAnthropicMessages(structuredClone(leadingToolRef)), leadingToolRef)
})

test('third-party tool_name_rewrite closes over inline tool_definition, tool_use, tool_removal, tool_choice, and reverse-maps JSON & SSE', async (t) => {
  // 1. Unit level: scrubUpstreamClientBody with inline tool_definition + Anthropic server tool + collision + tool_choice
  const input = {
    model: 'claude-sonnet-4-6',
    thinking: { type: 'disabled' },
    tools: [{ name: 'top_tool', description: 'OpenCode top tool', input_schema: { type: 'object' } }],
    tool_choice: { type: 'tool', name: 'inline_lookup' },
    messages: [
      { role: 'user', content: 'Use inline lookup' },
      {
        role: 'system',
        content: [
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: {
                name: 'inline_lookup',
                description: 'Hermes Agent inline lookup powered by OpenCode',
                input_schema: { type: 'object', properties: { id: { type: 'string' } } },
              },
            },
          },
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: {
                name: 'mcp__collide',
                description: 'Pre-prefixed inline tool',
                input_schema: { type: 'object' },
              },
            },
          },
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: {
                name: 'collide',
                description: 'Colliding inline tool',
                input_schema: { type: 'object' },
              },
            },
          },
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: {
                type: 'web_search_20250305',
                name: 'web_search',
                max_uses: 3,
              },
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'inline_lookup', input: { id: '42' } },
          { type: 'tool_use', id: 'tu_2', name: 'collide', input: {} },
          {
            type: 'tool_search_tool_result',
            tool_use_id: 'srv_1',
            tool_references: [{ type: 'tool_reference', tool_name: 'inline_lookup' }],
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: [{ type: 'tool_reference', tool_name: 'inline_lookup' }],
          },
        ],
      },
      {
        role: 'system',
        content: [{ type: 'tool_removal', tool: { type: 'tool_reference', name: 'inline_lookup' } }],
      },
    ],
  }

  const scrubbed = scrubUpstreamClientBody(input, { official: false, rewriteTools: true })
  assertToolChangeRoleInvariant(scrubbed.body.messages, 'scrub-inline')
  assertToolNameClosureInvariant(scrubbed.body, scrubbed.reverse, 'scrub-inline')
  assert.equal(scrubbed.body.tools[0].name, 'mcp__top_tool')
  assert.equal(scrubbed.body.tools[0].description, 'Claude Code top tool')
  assert.equal(scrubbed.body.messages[1].content[0].tool.definition.name, 'mcp__inline_lookup')
  assert.equal(
    scrubbed.body.messages[1].content[0].tool.definition.description,
    'Claude Code inline lookup powered by Claude Code',
  )
  assert.equal(scrubbed.body.messages[1].content[1].tool.definition.name, 'mcp__collide')
  assert.equal(scrubbed.body.messages[1].content[2].tool.definition.name, 'mcp__collide_2')
  assert.equal(
    scrubbed.body.messages[1].content[3].tool.definition.name,
    'web_search',
    'Anthropic server tools must not be renamed',
  )
  assert.equal(scrubbed.body.messages[2].content[0].name, 'mcp__inline_lookup')
  assert.equal(scrubbed.body.messages[2].content[1].name, 'mcp__collide_2')
  assert.equal(scrubbed.body.messages[2].content[2].tool_references[0].tool_name, 'mcp__inline_lookup')
  assert.equal(scrubbed.body.messages[3].content[0].content[0].tool_name, 'mcp__inline_lookup')
  assert.equal(scrubbed.body.messages[4].content[0].tool.name, 'mcp__inline_lookup')
  assert.equal(scrubbed.body.tool_choice.name, 'mcp__inline_lookup')
  assert.equal(scrubbed.reverse.mcp__inline_lookup, 'inline_lookup')
  assert.equal(scrubbed.reverse.mcp__collide_2, 'collide')
  assert.equal(scrubbed.reverse.web_search, undefined)

  // 2. End-to-end handleProtocol with forced tool_choice referencing an inline-only tool_definition (no top-level tools)
  const vm = { id: 'vm-inline-tc', node_id: 'node-1', dataplane: 'wrap', official_cc_inference: 'cli-hop' }
  const routing = {
    sticky: { outbound_session: 'passthrough' },
    compatibility: {
      persona_preset: 'official_full',
      crag_persona_preset: 'official_full',
      official_cc_passthrough: false,
      claude_code_only: false,
    },
  }
  const invoke = createProtocolHarness(t, {
    routing,
    vm,
    health: makeCragHealth(HEADLESS_V4_CAPS),
    onCallAttempt({ body, attemptMeta }) {
      const wireResp = {
        id: 'msg_inline_tc',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'tool_use', id: 'tu_inline', name: 'mcp__inline_lookup', input: { id: '99' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 40, output_tokens: 10 },
      }
      return {
        ok: true,
        status: 200,
        terminalState: 'verified',
        body: restoreToolNames(wireResp, attemptMeta?.toolNames || {}),
      }
    },
  })

  const e2eBody = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    stream: false,
    thinking: { type: 'disabled' },
    tool_choice: { type: 'tool', name: 'inline_lookup' },
    messages: [
      { role: 'user', content: 'Call inline_lookup' },
      {
        role: 'system',
        content: [
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: {
                name: 'inline_lookup',
                description: 'OpenCode inline lookup',
                input_schema: { type: 'object', properties: { id: { type: 'string' } } },
              },
            },
          },
        ],
      },
    ],
  }
  const e2eRes = await invoke({
    body: e2eBody,
    headers: { authorization: 'Bearer sk-inline', 'user-agent': 'Go-http-client/2.0' },
  })
  assert.equal(e2eRes.res.status, 200, JSON.stringify(e2eRes.res.body))
  const sent = e2eRes.captured[0].hopBody
  const reverse = e2eRes.captured[0].attemptMeta.toolNames
  assertToolChangeRoleInvariant(sent.messages, 'e2e-inline-tc')
  assertToolNameClosureInvariant(sent, reverse, 'e2e-inline-tc')
  assert.equal(sent.tool_choice.name, 'mcp__inline_lookup')
  assert.equal(e2eRes.res.body.content[0].name, 'inline_lookup')
  assert.doesNotThrow(() => prepareCragRequest(sent, { capabilities: HEADLESS_V4_CAPS }))
})

test('crag-whitelist and validateToolChoice accept tool_choice referencing inline tool_definition and reject unknown or ref-only tools', () => {
  const inlineOnlyBody = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    tool_choice: { type: 'tool', name: 'mcp__inline_exec' },
    messages: [
      { role: 'user', content: 'run it' },
      {
        role: 'system',
        content: [
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: {
                name: 'mcp__inline_exec',
                input_schema: { type: 'object', properties: { cmd: { type: 'string' } } },
              },
            },
          },
        ],
      },
    ],
  }

  assert.doesNotThrow(() => validateToolChoice(inlineOnlyBody))
  assert.doesNotThrow(() => validateToolChoice({ ...inlineOnlyBody, tool_choice: { type: 'auto' } }))
  assert.doesNotThrow(() => validateToolChoice({ ...inlineOnlyBody, tool_choice: { type: 'any' } }))
  const sanitized = sanitizeCragBodyWhitelist(inlineOnlyBody, { capabilities: HEADLESS_V4_CAPS })
  assert.deepEqual(sanitized.body.tool_choice, { type: 'tool', name: 'mcp__inline_exec' })

  // Still accepts when top-level tools exist alongside an inline tool_definition
  const mixedToolsBody = {
    ...inlineOnlyBody,
    tools: [{ name: 'mcp__other_tool', input_schema: { type: 'object' } }],
  }
  assert.doesNotThrow(() => validateToolChoice(mixedToolsBody))
  assert.doesNotThrow(() => sanitizeCragBodyWhitelist(mixedToolsBody, { capabilities: HEADLESS_V4_CAPS }))

  // Rejects unknown tool_choice.name
  assert.throws(
    () =>
      sanitizeCragBodyWhitelist(
        { ...inlineOnlyBody, tool_choice: { type: 'tool', name: 'missing_tool' } },
        { capabilities: HEADLESS_V4_CAPS },
      ),
    (err) => err.status === 400 && /supplied tool/.test(err.message),
  )

  // Rejects tool_choice targeting a tool_reference that has no definition anywhere
  assert.throws(
    () =>
      sanitizeCragBodyWhitelist(
        {
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          tool_choice: { type: 'tool', name: 'ref_only' },
          messages: [
            { role: 'user', content: 'run it' },
            {
              role: 'system',
              content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'ref_only' } }],
            },
          ],
        },
        { capabilities: HEADLESS_V4_CAPS },
      ),
    (err) => err.status === 400 && /supplied tool/.test(err.message),
  )
})

test('/v1/messages/count_tokens preserves role=system tool_addition for third-party/relayed traffic and forwards allowlisted caller headers for officialTraffic=true', async () => {
  const relayedBody = {
    model: 'claude-opus-5-5',
    system: [{ type: 'text', text: 'You are OpenCode, a coding agent.' }],
    messages: [
      {
        role: 'system',
        clear_at: 2,
        output_config: { effort: 'high' },
        content: [
          { type: 'text', text: 'Leading count_tokens third-party rule.' },
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: {
                name: 'inline_count_tool',
                description: 'OpenCode inline count tool',
                input_schema: { type: 'object', properties: {} },
              },
            },
          },
        ],
      },
      { role: 'user', content: 'Count tokens please' },
      {
        role: 'system',
        clear_at: 4,
        content: [
          { type: 'text', text: 'Mid count_tokens third-party rule.' },
          { type: 'tool_removal', tool: { type: 'tool_reference', name: 'inline_count_tool' } },
        ],
      },
    ],
  }

  // 1. Direct sanitizeThirdPartyCountTokensBody invariant checks
  const sanitized = sanitizeThirdPartyCountTokensBody(relayedBody, { routing: {} })
  assert.equal('max_tokens' in sanitized, false)
  assertToolChangeRoleInvariant(sanitized.messages, 'count-tokens-direct')
  assertToolNameClosureInvariant(sanitized, { mcp__inline_count_tool: 'inline_count_tool' }, 'count-tokens-direct')
  assertThirdPartySystemTextIsolation(
    sanitized.messages,
    [
      'You are OpenCode, a coding agent.',
      'Leading count_tokens third-party rule.',
      'Mid count_tokens third-party rule.',
    ],
    'count-tokens-direct',
  )
  assert.equal(sanitized.messages[0].role, 'system')
  assert.equal(sanitized.messages[0].clear_at, 2)
  assert.deepEqual(sanitized.messages[0].output_config, { effort: 'high' })
  assert.equal(sanitized.messages[0].content[0].tool.definition.name, 'mcp__inline_count_tool')
  assert.equal(sanitized.messages[0].content[0].tool.definition.description, 'Claude Code inline count tool')
  assert.equal(sanitized.messages[2].role, 'system')
  assert.equal(sanitized.messages[2].clear_at, 4)
  assert.equal(sanitized.messages[2].content[0].tool.name, 'mcp__inline_count_tool')

  // 2. End-to-end handleUserCountTokens for relayed/third-party traffic -> headers stay empty {}, role=system preserved
  const relayedCalls = []
  let seenRelayed = null
  await handleUserCountTokens(
    {
      headers: {
        authorization: 'Bearer sk-secret',
        'user-agent': 'Go-http-client/2.0',
        'x-claude-code-session-id': 'spoof-session',
        'anthropic-beta': 'evil-beta',
      },
    },
    {},
    {
      json: (_res, status, body) => relayedCalls.push({ status, body }),
      requireAuth: () => true,
      readBody: async () => structuredClone(relayedBody),
      cfg: { limits: { max_body_bytes: 1024 * 1024 } },
      getRoutingConfig: () => ({ compatibility: { count_tokens: true } }),
      stickyRouter: { extractPoolKey: () => null },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          vmId: 'vm-crag',
          accountId: 'acc-1',
          vm: { credential_mode: 'oauth' },
          workerStatus: { capabilities: ['count_tokens_v1'] },
          exec: { vmId: 'vm-crag' },
        }),
      }),
      countTokensViaKernel: async (_exec, args) => {
        seenRelayed = args
        return { ok: true, status: 200, body: { input_tokens: 123 } }
      },
    },
  )
  assert.equal(relayedCalls[0].status, 200)
  assert.equal(relayedCalls[0].body.input_tokens, 123)
  assert.deepEqual(seenRelayed.headers, {})
  assertToolChangeRoleInvariant(seenRelayed.body.messages, 'count-tokens-relayed')

  // 3. End-to-end handleUserCountTokens for verified official CC -> forwards allowlisted caller headers only
  const sessionId = '44444444-4444-4444-8444-444444444444'
  const officialCalls = []
  let seenOfficial = null
  await handleUserCountTokens(
    {
      headers: {
        authorization: 'Bearer sk-secret-must-not-forward',
        'x-api-key': 'secret-key-must-not-forward',
        cookie: 'session=secret',
        'user-agent': 'claude-cli/2.1.321 (external, cli)',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'anthropic-beta': 'claude-code-20250219',
        'x-app': 'cli',
        'x-client-request-id': 'req_ct_trace_01',
        'x-stainless-lang': 'js',
        'x-stainless-os': 'Linux',
        'x-stainless-arch': 'x64',
        'x-stainless-runtime': 'node',
        'x-stainless-runtime-version': 'v24.3.0',
        'x-stainless-package-version': '0.128.0',
        'x-stainless-retry-count': '0',
        'x-stainless-timeout': '600',
        'x-claude-code-session-id': sessionId,
        'x-claude-code-workload': 'interactive',
      },
    },
    {},
    {
      json: (_res, status, body) => officialCalls.push({ status, body }),
      requireAuth: () => true,
      readBody: async () => ({
        model: 'claude-opus-5-5',
        system: [{ type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM }],
        tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'hi' }],
      }),
      cfg: { limits: { max_body_bytes: 1024 * 1024 } },
      getRoutingConfig: () => ({ compatibility: { count_tokens: true } }),
      stickyRouter: { extractPoolKey: () => null },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          vmId: 'vm-crag',
          accountId: 'acc-1',
          vm: { credential_mode: 'oauth' },
          workerStatus: { capabilities: ['count_tokens_v1'] },
          exec: { vmId: 'vm-crag' },
        }),
      }),
      countTokensViaKernel: async (_exec, args) => {
        seenOfficial = args
        return { ok: true, status: 200, body: { input_tokens: 77 } }
      },
    },
  )
  assert.equal(officialCalls[0].status, 200)
  assert.equal(officialCalls[0].body.input_tokens, 77)
  assert.deepEqual(seenOfficial.headers, {
    'user-agent': 'claude-cli/2.1.321 (external, cli)',
    'x-app': 'cli',
    'x-client-request-id': 'req_ct_trace_01',
    'x-claude-code-session-id': sessionId,
    'x-claude-code-workload': 'interactive',
    'anthropic-beta': 'claude-code-20250219',
  })
  assert.equal('authorization' in seenOfficial.headers, false)
  assert.equal('x-api-key' in seenOfficial.headers, false)
  assert.equal('cookie' in seenOfficial.headers, false)
  assert.equal('x-stainless-lang' in seenOfficial.headers, false)
})

test('V9 regression: plain third-party text in messages[].role=system|developer still relocates completely into messages[0]', async (t) => {
  const vm = { id: 'vm-v9-reg', node_id: 'node-1', dataplane: 'wrap', official_cc_inference: 'cli-hop' }
  const routing = {
    sticky: { outbound_session: 'passthrough' },
    compatibility: {
      persona_preset: 'official_full',
      crag_persona_preset: 'official_full',
      official_cc_passthrough: false,
      claude_code_only: false,
    },
  }
  const invoke = createProtocolHarness(t, {
    routing,
    vm,
    health: makeCragHealth(HEADLESS_V4_CAPS),
  })
  const body = {
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    stream: false,
    messages: [
      { role: 'system', content: 'You are OpenCode leading prompt.' },
      { role: 'user', content: 'Part 1' },
      { role: 'developer', content: [{ type: 'text', text: 'You are OpenCode mid prompt.' }] },
      { role: 'user', content: 'Part 2' },
    ],
  }

  const { res, captured } = await invoke({
    body,
    headers: { authorization: 'Bearer sk-v9', 'user-agent': 'OpenCode/2.0' },
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const hopBody = captured[0].hopBody
  assert.equal(
    hopBody.messages.some((m) => m.role === 'system' || m.role === 'developer'),
    false,
    'plain text-only third-party system/developer turns must be completely removed',
  )
  assert.equal(hopBody.messages.length, 1, 'adjacent user turns after system removal must merge')
  assert.equal(hopBody.messages[0].role, 'user')
  assertThirdPartySystemTextIsolation(
    hopBody.messages,
    ['You are OpenCode leading prompt.', 'You are OpenCode mid prompt.'],
    'v9-regression',
  )
  assert.equal('system' in hopBody, false)

  // Direct foldThirdPartyRoleSystemMessages check
  const directFolded = foldThirdPartyRoleSystemMessages(body)
  assert.equal(directFolded.messages.length, 1)
  assert.equal(directFolded.messages[0].role, 'user')
  assertThirdPartySystemTextIsolation(
    directFolded.messages,
    ['You are OpenCode leading prompt.', 'You are OpenCode mid prompt.'],
    'v9-direct-fold',
  )
  // Direct toStandardAnthropicBody preserves standard shape cleanly
  const std = toStandardAnthropicBody(directFolded, { official: false })
  assert.equal(std.body.messages.length, 1)
  assert.equal(std.body.messages[0].role, 'user')
})

test('leading clear_at text-only system turns stay intact, remain idempotent, and never emit empty shells or assistant-first histories', () => {
  // Repro 1: leading non-empty clear_at before user stays intact in-place (never lifts to permanent system[] or emits empty shell)
  const leadingBeforeUser = normalizeAnthropicMessages({
    model: 'claude-opus-5-5',
    messages: [
      { role: 'system', clear_at: 2, content: 'Leading ephemeral text' },
      { role: 'user', content: 'hello' },
    ],
  })
  assert.equal(leadingBeforeUser.system, undefined)
  assert.deepEqual(leadingBeforeUser.messages, [
    { role: 'system', clear_at: 2, content: 'Leading ephemeral text' },
    { role: 'user', content: 'hello' },
  ])
  // Idempotent on Pass 2 and preserved by dropEmptySystemControlTurns
  assert.deepEqual(normalizeAnthropicMessages(structuredClone(leadingBeforeUser)), leadingBeforeUser)
  assert.deepEqual(dropEmptySystemControlTurns(structuredClone(leadingBeforeUser)), leadingBeforeUser)

  // Repro 2a: leading non-empty clear_at before assistant stays at messages[0] and survives dropEmptySystemControlTurns
  const leadingBeforeAssistant = normalizeAnthropicMessages({
    model: 'claude-opus-5-5',
    messages: [
      { role: 'system', clear_at: 2, content: 'Leading ephemeral text' },
      { role: 'assistant', content: 'prev reply' },
    ],
  })
  assert.equal(leadingBeforeAssistant.system, undefined)
  assert.equal(leadingBeforeAssistant.messages[0].role, 'system')
  assert.equal(leadingBeforeAssistant.messages[0].clear_at, 2)
  assert.equal(leadingBeforeAssistant.messages[0].content, 'Leading ephemeral text')
  assert.equal(leadingBeforeAssistant.messages[1].role, 'assistant')
  assert.deepEqual(normalizeAnthropicMessages(structuredClone(leadingBeforeAssistant)), leadingBeforeAssistant)
  const afterDropNonEmpty = dropEmptySystemControlTurns(structuredClone(leadingBeforeAssistant))
  assert.equal(afterDropNonEmpty.messages[0].role, 'system')
  assert.notEqual(afterDropNonEmpty.messages[0].role, 'assistant')

  // Repro 2b: empty clear_at turn (no effort) before assistant is dropped and replaced with leading user guard
  const emptyClearAtBeforeAssistant = normalizeAnthropicMessages({
    model: 'claude-opus-5-5',
    messages: [
      { role: 'system', clear_at: 2, content: [] },
      { role: 'assistant', content: 'prev reply' },
    ],
  })
  assert.deepEqual(
    emptyClearAtBeforeAssistant.messages.map((m) => m.role),
    ['user', 'assistant'],
  )
  assert.equal(
    emptyClearAtBeforeAssistant.messages.some((m) => m.clear_at != null),
    false,
  )

  // Third-party extraction of leading text-only clear_at (no effort): text moves to user, empty shell is dropped on standard/count_tokens paths
  const thirdPartyLeadingClearAt = {
    model: 'claude-opus-5-5',
    messages: [
      { role: 'system', clear_at: 2, content: 'You are OpenCode ephemeral instruction.' },
      { role: 'user', content: 'hello' },
    ],
  }
  const folded = foldThirdPartyRoleSystemMessages(thirdPartyLeadingClearAt)
  assert.deepEqual(folded.messages[0], { role: 'system', clear_at: 2, content: [] })
  const stdAfterFold = toStandardAnthropicBody(folded, { official: false }).body
  assert.equal(stdAfterFold.messages.length, 1)
  assert.equal(stdAfterFold.messages[0].role, 'user')
  assert.equal(
    stdAfterFold.messages.some((m) => m.clear_at != null),
    false,
  )
  assertThirdPartySystemTextIsolation(
    stdAfterFold.messages,
    ['You are OpenCode ephemeral instruction.'],
    'third-party-clear-at-std',
  )
  const ctAfterFold = sanitizeThirdPartyCountTokensBody(thirdPartyLeadingClearAt, { routing: {} })
  assert.equal(ctAfterFold.messages.length, 1)
  assert.equal(ctAfterFold.messages[0].role, 'user')
  assert.equal(
    ctAfterFold.messages.some((m) => m.clear_at != null),
    false,
  )

  // Third-party leading clear_at WITH output_config.effort on opus-5-5 keeps valid empty effort control
  const thirdPartyClearAtEffort = {
    model: 'claude-opus-5-5',
    messages: [
      { role: 'system', clear_at: 2, output_config: { effort: 'high' }, content: 'Third-party effort note.' },
      { role: 'user', content: 'hello' },
    ],
  }
  const stdEffort = toStandardAnthropicBody(foldThirdPartyRoleSystemMessages(thirdPartyClearAtEffort), {
    official: false,
  }).body
  assert.deepEqual(stdEffort.messages[0], {
    role: 'system',
    clear_at: 2,
    output_config: { effort: 'high' },
    content: [],
  })
  assert.equal(stdEffort.messages[1].role, 'user')
  assert.deepEqual(dropEmptySystemControlTurns(structuredClone(stdEffort)), stdEffort)
})
