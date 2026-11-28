import assert from 'node:assert/strict'
import test from 'node:test'
import { CRS_OFFICIAL_CLI_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'
import {
  isAssistantEndingInServerToolResult,
  isLegalCrag321Request,
  rectifyCrag321Request,
} from '../../src/lib/protocol/crag-321-rectifier.mjs'
import { prepareCragRequest } from '../../src/lib/protocol/kernel-request.mjs'
import { handleUserCountTokens } from '../../src/lib/protocol/user-count-tokens.mjs'
import { prepareWorkerPayload } from '../../src/lib/transport/go-worker-client.mjs'

const V4_CAPS = [
  'generation_controls_v3',
  'headless_claude_bridge_v1',
  'count_tokens_v1',
  'native_handoff_v1',
  'provider_result_v2',
  'provider_managed_tools_v1',
  'request_safeguards',
  'request_speed',
]

function makeExec(capabilities = V4_CAPS) {
  return {
    vmId: 'vm-crag-321',
    homeDir: '/tmp/vm-crag-321',
    vm: {
      id: 'vm-crag-321',
      dataplane: 'crag',
      crag_kernel_version: 'v2',
      claude: {},
    },
    workerStatus: {
      ok: true,
      dataplane: 'crag',
      kernel_version: 'v2',
      runtime_variant: 'crag-v2',
      capabilities,
    },
  }
}

function makeOfficialCcHeaders(sessionId = '11111111-1111-4111-8111-111111111111') {
  return {
    'user-agent': 'claude-cli/2.1.328 (external, cli)',
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-beta': 'claude-code-20250219',
    'x-app': 'cli',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'Linux',
    'x-stainless-arch': 'x64',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': 'v24.3.0',
    'x-stainless-package-version': '0.128.0',
    'x-stainless-retry-count': '0',
    'x-stainless-timeout': '600',
    'x-claude-code-session-id': sessionId,
  }
}

function assert21321Invariants(body, { strictPassthrough = false } = {}) {
  assert.equal(
    isLegalCrag321Request(body, { strictPassthrough }),
    true,
    `rectified body must satisfy 2.1.321 invariants: ${JSON.stringify(body)}`,
  )
  // Idempotence: second pass returns the exact same reference (0 mutations).
  const again = rectifyCrag321Request(body, { strictPassthrough })
  assert.equal(again, body, 'second rectification pass must hit zero-mutation fast path')
}

test('zero-mutation fast path preserves valid 2.1.321 bodies verbatim (strictPassthrough and non-strict)', () => {
  const validStrict = {
    model: 'claude-opus-5-5',
    max_tokens: 16,
    temperature: 0.7,
    thinking: { type: 'adaptive', display: 'updates' },
    safeguards: { mode: 'strict', custom: true },
    output_config: { effort: 'high' },
    future_official_flag: { enabled: true },
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.321.abc; cc_entrypoint=cli; cch=00000;' },
      { type: 'text', text: 'Official prompt', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          { type: 'future_block', payload: { k: 1 } },
        ],
      },
      { role: 'system', content: 'mid-conversation system turn', clear_at: 2 },
      { role: 'system', content: [], output_config: { effort: 'max' } },
      {
        role: 'assistant',
        content: [
          { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } },
          { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] },
        ],
      },
      { role: 'system', content: [{ type: 'text', text: 'post-server-tool reminder' }] },
      { role: 'user', content: 'continue' },
    ],
  }

  assert.equal(isAssistantEndingInServerToolResult(validStrict.messages[3]), true)
  assert.equal(isLegalCrag321Request(validStrict, { strictPassthrough: true }), true)
  assert.equal(rectifyCrag321Request(validStrict, { strictPassthrough: true }), validStrict)

  // Directive-only empty system turn is legal at messages[0] and after plain assistant on Opus 5.5
  const directiveValid = {
    model: 'claude-opus-5-5',
    messages: [
      { role: 'system', content: [], output_config: { effort: 'high' } },
      { role: 'user', content: [{ type: 'text', text: 'turn 1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] },
      { role: 'system', content: [], output_config: { effort: 'medium' } },
      { role: 'user', content: [{ type: 'text', text: 'turn 2' }] },
    ],
  }
  assert.equal(rectifyCrag321Request(directiveValid, { strictPassthrough: true }), directiveValid)
  assert.equal(rectifyCrag321Request(directiveValid, { strictPassthrough: false }), directiveValid)

  // Non-strict prepareCragRequest still preserves messages reference identity for canonical clean history
  const cleanCanonical = {
    model: 'claude-opus-5-5',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Read file' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    ],
  }
  const prepared = prepareCragRequest(cleanCanonical, { capabilities: V4_CAPS })
  assert.equal(prepared.messages, cleanCanonical.messages)
})

test('leading messages[0] role=system tool_addition/tool_removal/text/clear_at rectifies to valid 2.1.321 on both strict and non-strict paths', () => {
  const inbound = {
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    future_official_flag: { keep: true },
    tools: [{ name: 'existing_tool', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'tool', name: 'lookup_doc' },
    messages: [
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Leading prompt text' },
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: {
                name: 'lookup_doc',
                description: 'Look up docs',
                input_schema: { type: 'object', properties: { q: { type: 'string' } } },
              },
            },
          },
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: {
                name: 'existing_tool',
                description: 'Override existing tool after user',
                input_schema: { type: 'object', properties: {} },
              },
            },
          },
          { type: 'tool_removal', tool: { type: 'tool_reference', name: 'old_tool' } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Find config' }] },
    ],
  }
  const snapshot = structuredClone(inbound)

  // Strict passthrough (e.g. version-skewed official client)
  const strictOut = prepareCragRequest(inbound, { capabilities: V4_CAPS }, { strictPassthrough: true })
  assert.deepEqual(inbound, snapshot, 'input must never be mutated')
  assert21321Invariants(strictOut, { strictPassthrough: true })
  assert.deepEqual(strictOut.future_official_flag, { keep: true })
  assert.deepEqual(
    strictOut.tools.map((t) => t.name),
    ['existing_tool', 'lookup_doc'],
  )
  assert.deepEqual(strictOut.system, [{ type: 'text', text: 'Leading prompt text' }])
  assert.deepEqual(
    strictOut.messages.map((m) => m.role),
    ['user', 'system'],
  )
  // Duplicate-name tool_addition and tool_removal stay deferred after the first user turn
  assert.equal(strictOut.messages[1].content.length, 2)
  assert.equal(strictOut.messages[1].content[0].type, 'tool_addition')
  assert.equal(strictOut.messages[1].content[0].tool.definition.name, 'existing_tool')
  assert.equal(strictOut.messages[1].content[1].type, 'tool_removal')
  assert.equal(strictOut.messages[1].content[1].tool.name, 'old_tool')

  // Non-strict path (third-party / relayed)
  const nonStrictOut = prepareCragRequest(
    {
      model: 'claude-opus-5-5',
      tools: [{ name: 'existing_tool', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'tool', name: 'lookup_doc' },
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'tool_addition',
              tool: {
                type: 'tool_definition',
                definition: { name: 'lookup_doc', input_schema: { type: 'object', properties: {} } },
              },
            },
          ],
        },
        { role: 'user', content: 'Find config' },
      ],
    },
    { capabilities: V4_CAPS },
    { strictPassthrough: false },
  )
  assert21321Invariants(nonStrictOut, { strictPassthrough: false })
  assert.deepEqual(
    nonStrictOut.tools.map((t) => t.name),
    ['existing_tool', 'lookup_doc'],
  )
  assert.deepEqual(nonStrictOut.tool_choice, { type: 'tool', name: 'lookup_doc' })
  assert.deepEqual(
    nonStrictOut.messages.map((m) => m.role),
    ['user'],
  )

  // Leading ephemeral clear_at text stays out of permanent top-level system[] and defers after first user
  const leadingClearAt = prepareCragRequest(
    {
      model: 'claude-opus-5-5',
      messages: [
        { role: 'system', clear_at: 2, content: 'Ephemeral notice' },
        { role: 'user', content: 'hello' },
      ],
    },
    { capabilities: V4_CAPS },
    { strictPassthrough: true },
  )
  assert21321Invariants(leadingClearAt, { strictPassthrough: true })
  assert.equal(leadingClearAt.system, undefined)
  assert.deepEqual(
    leadingClearAt.messages.map((m) => m.role),
    ['user', 'system'],
  )
  assert.equal(leadingClearAt.messages[1].clear_at, 2)
  assert.equal(leadingClearAt.messages[1].content[0].text, 'Ephemeral notice')
})

test('mid-conversation non-directive role=system after plain assistant defers past next user and merges consecutive system turns', () => {
  const midAfterPlainAssistant = {
    model: 'claude-opus-5-5',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Inspect repo' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Checking now.' }] },
      {
        role: 'system',
        clear_at: 4,
        output_config: { effort: 'high' },
        content: [
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: { name: 'mcp__relay_grep', input_schema: { type: 'object' } },
            },
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      },
      {
        role: 'system',
        clear_at: 5,
        output_config: { effort: 'max' },
        content: [{ type: 'tool_removal', tool: { type: 'tool_reference', name: 'mcp__relay_grep' } }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Continue', cache_control: { type: 'ephemeral', ttl: '5m' } }],
      },
    ],
  }

  for (const strictPassthrough of [true, false]) {
    const out = prepareCragRequest(midAfterPlainAssistant, { capabilities: V4_CAPS }, { strictPassthrough })
    assert21321Invariants(out, { strictPassthrough })
    assert.deepEqual(
      out.messages.map((m) => m.role),
      ['user', 'assistant', 'user', 'system'],
    )
    const deferred = out.messages[3]
    assert.equal(deferred.clear_at, 5)
    assert.deepEqual(deferred.output_config, { effort: 'max' })
    assert.equal(deferred.content.length, 2)
    assert.equal(deferred.content[0].type, 'tool_addition')
    assert.equal(deferred.content[1].type, 'tool_removal')
    // Deferring the 1h system block after a 5m user block must ALSO fix the 5m -> 1h TTL inversion
    assert.deepEqual(deferred.content[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  }

  // Trailing non-directive role=system after plain assistant inserts a user("continue") anchor
  const trailing = prepareCragRequest(
    {
      model: 'claude-opus-5-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Step 1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Done 1' }] },
        {
          role: 'system',
          content: [{ type: 'tool_removal', tool: { type: 'tool_reference', name: 'old_tool' } }],
        },
      ],
    },
    { capabilities: V4_CAPS },
    { strictPassthrough: true },
  )
  assert21321Invariants(trailing, { strictPassthrough: true })
  assert.deepEqual(
    trailing.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'system'],
  )
  assert.equal(trailing.messages[2].content[0].text, 'continue')
  assert.equal(trailing.messages[3].content[0].type, 'tool_removal')

  // Assistant -> system -> assistant (no user between) also gets a legal user anchor before system
  const betweenAssistants = prepareCragRequest(
    {
      model: 'claude-opus-5-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Start' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'A1' }] },
        { role: 'system', content: [{ type: 'text', text: 'reminder' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'A2' }] },
      ],
    },
    { capabilities: V4_CAPS },
    { strictPassthrough: true },
  )
  assert21321Invariants(betweenAssistants, { strictPassthrough: true })
  assert.deepEqual(
    betweenAssistants.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'system', 'assistant'],
  )
})

test('tool_addition and tool_removal illegally placed inside user or assistant messages are extracted to legal role=system turns', () => {
  const misplacedInUserAndAssistant = {
    model: 'claude-opus-5-5',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: { name: 'inline_a', input_schema: { type: 'object', properties: {} } },
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Working' },
          { type: 'tool_removal', tool: { type: 'tool_reference', name: 'inline_a' } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Next step' }] },
    ],
  }

  for (const strictPassthrough of [true, false]) {
    const out = prepareCragRequest(misplacedInUserAndAssistant, { capabilities: V4_CAPS }, { strictPassthrough })
    assert21321Invariants(out, { strictPassthrough })
    assert.deepEqual(
      out.messages.map((m) => m.role),
      ['user', 'system', 'assistant', 'user', 'system'],
    )
    assert.deepEqual(out.messages[0].content, [{ type: 'text', text: 'Hello' }])
    assert.equal(out.messages[1].content[0].type, 'tool_addition')
    assert.deepEqual(out.messages[2].content, [{ type: 'text', text: 'Working' }])
    assert.deepEqual(out.messages[3].content, [{ type: 'text', text: 'Next step' }])
    assert.equal(out.messages[4].content[0].type, 'tool_removal')
  }

  // Non-strict fast-path reuse (tool_reference inside user) still cannot smuggle tool_addition in role=user
  const smuggledRef = prepareCragRequest(
    {
      model: 'claude-opus-5-5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Run it' },
            { type: 'tool_addition', tool: { type: 'tool_reference', name: 'Bash' } },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
        { role: 'user', content: [{ type: 'text', text: 'More' }] },
      ],
    },
    { capabilities: V4_CAPS },
    { strictPassthrough: false },
  )
  assert21321Invariants(smuggledRef, { strictPassthrough: false })
  assert.deepEqual(
    smuggledRef.messages.map((m) => m.role),
    ['user', 'system', 'assistant', 'user'],
  )
  assert.equal(smuggledRef.messages[1].content[0].type, 'tool_addition')
})

test('strictPassthrough rectifies role=developer, empty system shells, legacy per-message effort, thinking.budgetTokens, output_config schema, annotations, and illegal cache_control', () => {
  const versionSkewedOfficial = {
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    future_official_flag: { v: '2.1.400' },
    thinking: { type: 'enabled', budgetTokens: '2048' },
    output_config: {
      effort: '  ',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            nested: { type: 'object', properties: { ok: { type: 'boolean' } } },
          },
        },
      },
    },
    system: [
      { type: 'text', text: 'System A', annotations: [{ x: 1 }], cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'System B', cache_control: { type: 'ephemeral', ttl: '5m' } },
    ],
    messages: [
      { role: 'developer', content: 'Leading developer instruction' },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hi', annotations: [], cache_control: { type: 'ephemeral', ttl: '1h' } }],
      },
      { role: 'system', content: [], clear_at: 2 },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'thought',
            signature: 'sig_1',
            cache_control: { type: 'ephemeral', ttl: '5m' },
          },
          { type: 'text', text: 'Answer', cache_control: { type: 'ephemeral', ttl: '5m' } },
        ],
      },
      { role: 'developer', content: 'Mid developer notice' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Follow up', cache_control: { type: 'ephemeral', ttl: '5m' } },
          { type: 'text', text: 'Extra marker', cache_control: { type: 'ephemeral', ttl: '5m' } },
        ],
      },
      { role: 'system', content: [], output_config: { effort: 'HIGH' } },
    ],
  }

  const prepared = prepareWorkerPayload({
    body: versionSkewedOfficial,
    reqHeaders: {},
    exec: makeExec(),
    routing: { compatibility: { crag_strict_passthrough: true } },
    cliHop: true,
    cragPrint: true,
    strictPassthrough: true,
  })
  const out = prepared.gated
  assert21321Invariants(out, { strictPassthrough: true })

  // Future official flag preserved untouched
  assert.deepEqual(out.future_official_flag, { v: '2.1.400' })
  // thinking.budgetTokens -> numeric budget_tokens
  assert.deepEqual(out.thinking, { type: 'enabled', budget_tokens: 2048 })
  // Trailing empty effort directive on claude-sonnet-4-6 dropped & lifted (lowercased) to top-level output_config
  assert.equal(out.output_config.effort, 'high')
  // JSON schema filled with additionalProperties: false recursively
  assert.equal(out.output_config.format.schema.additionalProperties, false)
  assert.equal(out.output_config.format.schema.properties.nested.additionalProperties, false)
  // Leading developer lifted into system[]; annotations stripped
  assert.equal(out.system.length, 3)
  assert.equal('annotations' in out.system[0], false)
  assert.equal(out.system[2].text, 'Leading developer instruction')
  // Messages: empty clear_at shell dropped, mid developer after plain assistant deferred after user as role=system
  assert.deepEqual(
    out.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'system'],
  )
  assert.equal('annotations' in out.messages[0].content[0], false)
  assert.equal(out.messages[3].content, 'Mid developer notice')
  // Thinking cache_control stripped; <= 4 total breakpoints; no 5m -> 1h inversion
  assert.equal('cache_control' in out.messages[1].content[0], false)
  const markers = []
  for (const b of out.system) if (b.cache_control) markers.push(b.cache_control)
  for (const m of out.messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) if (b.cache_control) markers.push(b.cache_control)
    }
  }
  assert.ok(markers.length <= 4, `expected <= 4 markers, got ${markers.length}`)
  let seen5m = false
  for (const cc of markers) {
    if (seen5m) assert.notEqual(cc.ttl, '1h', '1h must never follow 5m')
    if (cc.ttl !== '1h') seen5m = true
  }

  // Completely empty messages (only empty system shell) still fail closed with 400
  assert.throws(
    () =>
      prepareCragRequest(
        { model: 'claude-opus-5-5', messages: [{ role: 'system', content: [] }] },
        { capabilities: V4_CAPS },
        { strictPassthrough: true },
      ),
    (err) => err.status === 400 && /user turn/.test(err.message),
  )
})

test('/v1/messages/count_tokens rectifies illegal 2.1.321 structures before countTokensViaKernel (both official and third-party)', async () => {
  const capture = () => {
    const calls = []
    return { calls, json: (_res, status, body) => calls.push({ status, body }) }
  }

  const illegalBody = {
    model: 'claude-opus-5-5',
    system: [{ type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM }],
    messages: [
      {
        role: 'system',
        content: [
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: { name: 'inline_probe', input_schema: { type: 'object', properties: {} } },
            },
          },
        ],
      },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'working' },
      { role: 'system', content: [{ type: 'tool_removal', tool: { type: 'tool_reference', name: 'inline_probe' } }] },
      { role: 'user', content: 'next' },
    ],
  }

  // 1. Official CC traffic (strict)
  const capOfficial = capture()
  let seenOfficial = null
  await handleUserCountTokens(
    { headers: makeOfficialCcHeaders() },
    {},
    {
      json: capOfficial.json,
      requireAuth: () => true,
      readBody: async () => structuredClone(illegalBody),
      cfg: { limits: { max_body_bytes: 1024 * 1024 } },
      getRoutingConfig: () => ({ compatibility: { count_tokens: true, claude_code_only: true } }),
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
        return { ok: true, status: 200, body: { input_tokens: 42 } }
      },
    },
  )
  assert.equal(capOfficial.calls[0].status, 200)
  assert21321Invariants(seenOfficial.body, { strictPassthrough: true })
  assert.deepEqual(
    seenOfficial.body.tools.map((t) => t.name),
    ['inline_probe'],
  )
  assert.deepEqual(
    seenOfficial.body.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'system'],
  )

  // 2. Third-party / relayed traffic
  const capThirdParty = capture()
  let seenThirdParty = null
  await handleUserCountTokens(
    { headers: { 'user-agent': 'Go-http-client/2.0' } },
    {},
    {
      json: capThirdParty.json,
      requireAuth: () => true,
      readBody: async () => structuredClone(illegalBody),
      cfg: { limits: { max_body_bytes: 1024 * 1024 } },
      getRoutingConfig: () => ({ compatibility: { count_tokens: true, claude_code_only: false } }),
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
        seenThirdParty = args
        return { ok: true, status: 200, body: { input_tokens: 43 } }
      },
    },
  )
  assert.equal(capThirdParty.calls[0].status, 200)
  assert21321Invariants(seenThirdParty.body, { strictPassthrough: false })
  assert.deepEqual(
    seenThirdParty.body.tools.map((t) => t.name),
    ['mcp__inline_probe'],
  )
  assert.deepEqual(
    seenThirdParty.body.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'system'],
  )
})
