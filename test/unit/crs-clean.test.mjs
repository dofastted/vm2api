import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeAnthropicBody, normalizeAnthropicMessages } from '../../src/lib/protocol/sanitize.mjs'
import { officialMessagesBody } from '../../src/lib/protocol/anthropic-messages.mjs'
import {
  toClaudeMessages,
  fromClaudeToOpenAICompletions,
  fromClaudeToOpenAIChat,
  fromClaudeToResponses,
} from '../../src/lib/protocol/convert.mjs'
import { applyCrsIdentityReplace, uuidFromSeed } from '../../src/lib/identity/identity-rewrite.mjs'
import {
  applyCrsUnofficialPersona,
  CRS_OFFICIAL_CLI_SYSTEM,
  CRS_OFFICIAL_SYSTEM,
} from '../../src/lib/identity/crs-persona.mjs'
import { hidePersonaUsage, personaHideInputTokens } from '../../src/lib/identity/crs-persona-usage.mjs'
import {
  TEST14_FEATURES,
  TEST14_OPENAI_INBOUND,
  extractCaseFeatures,
  matchesTest14Features,
  officialSystemKinds,
} from '../../src/lib/protocol/case-features.mjs'

test('sanitize keeps official context_management and maps stop → stop_sequences', () => {
  const out = sanitizeAnthropicBody({
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 32,
    stop: ['END'],
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
    settings: { theme: 'light' },
  })
  assert.deepEqual(out.stop_sequences, ['END'])
  assert.equal(out.stop, undefined)
  assert.equal(out.settings, undefined)
  assert.equal(out.context_management.edits[0].keep, 'all')
})

test('sanitize passthrough keeps output_config and drops OpenAI leftovers', () => {
  const out = sanitizeAnthropicBody({
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 32,
    output_config: {
      format: { type: 'json_schema', schema: { type: 'object', properties: { price: { type: 'number' } } } },
      effort: 'medium',
    },
    output_format: { type: 'json_schema' },
    container: { id: 'cntr_1' },
    mcp_servers: [{ name: 'files', type: 'url', url: 'https://example.invalid' }],
    service_tier: 'auto',
    extra_body: { should_drop: true },
    settings: { theme: 'light' },
    n: 1,
    response_format: { type: 'json_object' },
  })
  assert.equal(out.output_config.effort, 'medium')
  assert.equal(out.output_config.format.type, 'json_schema')
  assert.equal(out.output_format.type, 'json_schema')
  assert.equal(out.container.id, 'cntr_1')
  assert.equal(out.mcp_servers[0].name, 'files')
  assert.equal(out.service_tier, 'auto')
  assert.equal(out.extra_body, undefined)
  assert.equal(out.settings, undefined)
  assert.equal(out.n, undefined)
  assert.equal(out.response_format, undefined)
})

test('sanitize drops OpenAI annotations leftover on text blocks', () => {
  const out = sanitizeAnthropicBody({
    model: 'claude-fable-5',
    max_tokens: 64,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'ok',
            annotations: [],
            cache_control: { type: 'ephemeral', ttl: '5m' },
          },
        ],
      },
    ],
  })
  assert.equal(out.messages[1].content[0].text, 'ok')
  assert.equal(out.messages[1].content[0].annotations, undefined)
  assert.deepEqual(out.messages[1].content[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.ok(!JSON.stringify(out).includes('annotations'))
})

test('officialMessagesBody drops annotations after role remap', () => {
  const out = officialMessagesBody({
    model: 'claude-fable-5',
    max_tokens: 64,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: [{ type: 'text', text: 'result' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'next', annotations: [] }] },
    ],
  })
  assert.equal(out.messages[0].role, 'user')
  assert.equal(out.messages[1].role, 'assistant')
  assert.equal(out.messages[1].content[0].text, 'next')
  assert.equal(out.messages[1].content[0].annotations, undefined)
})

test('sanitize remaps unknown Anthropic roles to user (sub2api admin→user)', () => {
  const out = sanitizeAnthropicBody({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    messages: [{ role: 'admin', content: 'x' }],
  })
  assert.deepEqual(out.messages, [{ role: 'user', content: [{ type: 'text', text: 'x' }] }])
})

test('sanitize keeps mid-conversation role:system after a user turn', () => {
  const out = sanitizeAnthropicBody({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 32,
    system: [
      { type: 'text', text: 'billing' },
      { type: 'text', text: 'official' },
      { type: 'text', text: 'expansion' },
    ],
    messages: [
      { role: 'user', content: '你好呀。' },
      { role: 'system', content: [{ type: 'text', text: '你是一个高速收费员。' }] },
    ],
  })
  assert.equal(out.system[0].text, 'billing')
  assert.equal(out.messages[0].role, 'user')
  assert.equal(out.messages[1].role, 'system')
  assert.equal(out.messages[1].content[0].text, '你是一个高速收费员。')
})

test('sanitize lifts system/developer turns and merges consecutive users', () => {
  const out = sanitizeAnthropicBody({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 32,
    system: 'base',
    messages: [
      { role: 'system', content: 'extra rule' },
      { role: 'developer', content: 'dev note' },
      { role: 'user', content: 'one' },
      { role: 'admin', content: 'two' },
      { role: 'assistant', content: 'ok' },
    ],
  })
  assert.deepEqual(out.system, [
    { type: 'text', text: 'base' },
    { type: 'text', text: 'extra rule' },
    { type: 'text', text: 'dev note' },
  ])
  assert.deepEqual(out.messages, [
    { role: 'user', content: [{ type: 'text', text: 'one\ntwo' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  ])
})

test('sanitize drops empty content and prefixes assistant-first history', () => {
  const out = sanitizeAnthropicBody({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 16,
    messages: [
      { role: 'admin', content: '   ' },
      { role: 'assistant', content: 'hello' },
    ],
  })
  assert.equal(out.messages[0].role, 'user')
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: '.' }])
  assert.equal(out.messages[1].role, 'assistant')
  assert.deepEqual(out.messages[1].content, [{ type: 'text', text: 'hello' }])
})

test('toClaudeMessages anthropic passthrough remaps admin role', () => {
  const { claude, mode } = toClaudeMessages('anthropic.messages', {
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    messages: [{ role: 'admin', content: 'x' }],
  })
  assert.equal(mode, 'passthrough')
  assert.equal(claude.messages[0].role, 'user')
  assert.deepEqual(claude.messages[0].content, [{ type: 'text', text: 'x' }])
})

test('officialMessagesBody remaps admin before the worker hop', () => {
  const out = officialMessagesBody({
    model: 'claude-sonnet-5',
    max_tokens: 64,
    messages: [{ role: 'admin', content: 'x' }],
  })
  assert.equal(out.messages[0].role, 'user')
})

test('normalizeAnthropicMessages is idempotent for legal turns', () => {
  const body = {
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'yo' }] },
    ],
  }
  normalizeAnthropicMessages(body)
  normalizeAnthropicMessages(body)
  assert.deepEqual(body.messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'yo' }] },
  ])
})

// e358143c: caller system no longer joins top-level system; it is wrapped in <system-reminder>
// at the front of the first user turn, and Environment rides as a role=system message.
function assertOfficialHead(out) {
  assert.match(out.system[0].text, /^x-anthropic-billing-header: /)
  assert.equal(out.system[1].text, CRS_OFFICIAL_CLI_SYSTEM)
}

test('OpenAI chat unofficial rewrite keeps the official head and moves caller --system into the first user turn', () => {
  const { claude } = toClaudeMessages('openai.chat', {
    model: 'claude-haiku-4-5-20251001',
    messages: [
      { role: 'system', content: 'you are a linter' },
      { role: 'user', content: 'hi' },
    ],
    stop: 'END',
    max_tokens: 16,
  })
  assert.deepEqual(claude.stop_sequences, ['END'])
  const cleaned = applyCrsUnofficialPersona(claude, { officialClient: false })
  assertOfficialHead(cleaned)
  assert.equal(JSON.stringify(cleaned.system).includes('you are a linter'), false)
  const first = JSON.stringify(cleaned.messages[0].content)
  assert.match(first, /MANDATORY constraints for this turn/)
  assert.ok(first.includes('<system-reminder>\\nyou are a linter\\n</system-reminder>'))
  assert.ok(first.includes('hi'))
})

test('empty unofficial system without tools still writes the official head and no messages', () => {
  const out = applyCrsUnofficialPersona({ messages: [] }, { officialClient: false })
  assertOfficialHead(out)
  assert.equal(out.messages.length, 0)
})

test('official Claude Code system is not replaced or appended', () => {
  const body = { system: [{ type: 'text', text: 'x'.repeat(200) }], messages: [] }
  const out = applyCrsUnofficialPersona(body, { officialClient: true })
  assert.equal(out.system[0].text.length, 200)
  assert.equal(out.system.length, 1)
})

test('Xcode unofficial system is moved into the first user turn after the official head', () => {
  // A mid-conversation-system model keeps Environment as a role=system turn (069ed942).
  const body = {
    model: 'claude-opus-5-5',
    system: 'You are currently in Xcode. Help with Swift.',
    messages: [{ role: 'user', content: 'hi' }],
  }
  const out = applyCrsUnofficialPersona(body, { officialClient: false })
  assertOfficialHead(out)
  assert.equal(JSON.stringify(out.system).includes('Xcode'), false)
  const first = String(out.messages[0].content)
  assert.equal(out.messages[0].role, 'user')
  assert.match(first, /MANDATORY constraints for this turn/)
  assert.ok(first.includes('<system-reminder>\nYou are currently in Xcode. Help with Swift.\n</system-reminder>'))
  assert.ok(first.endsWith('hi'))
  assert.deepEqual(
    out.messages.slice(1).map((message) => message.role),
    ['system'],
  )
  assert.match(JSON.stringify(out.messages[1].content), /# Environment/)
})

test('legacy user_id: device becomes VM, unofficial session is minted, account from OAuth', () => {
  const inbound = { metadata: { user_id: 'user_devA_account__session_sess9' } }
  const out = applyCrsIdentityReplace(
    { model: 'x' },
    {
      accountUuid: 'acc-1',
      deviceId: 'vm',
      vmId: 'vm-01',
      metadataUserId: JSON.stringify({ device_id: 'vm', account_uuid: 'acc-1', session_id: 'vm-sess' }),
    },
    inbound,
  )
  const uid = JSON.parse(out.metadata.user_id)
  assert.equal(uid.device_id, 'vm')
  assert.equal(uid.account_uuid, 'acc-1')
  assert.notEqual(uid.session_id, 'sess9')
  assert.match(uid.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('legacy user_id: official Claude Code keeps caller session under passthrough', () => {
  const inbound = { metadata: { user_id: 'user_devA_account__session_sess9' } }
  const out = applyCrsIdentityReplace(
    { model: 'x' },
    {
      accountUuid: 'acc-1',
      deviceId: 'vm',
      vmId: 'vm-01',
    },
    inbound,
    {},
    { officialClient: true, mode: 'passthrough' },
  )
  const uid = JSON.parse(out.metadata.user_id)
  assert.equal(uid.session_id, 'sess9')
})

test('openai.completions prompt converts to Claude user message', () => {
  const { claude } = toClaudeMessages('openai.completions', {
    model: 'claude-haiku-4-5-20251001',
    prompt: 'Complete this: hello',
    max_tokens: 16,
    stop: ['\n'],
  })
  assert.equal(claude.messages[0].role, 'user')
  assert.match(JSON.stringify(claude.messages[0].content), /Complete this: hello/)
  assert.deepEqual(claude.stop_sequences, ['\n'])
  const back = fromClaudeToOpenAICompletions(
    {
      content: [{ type: 'text', text: 'world' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 1 },
    },
    'claude-haiku-4-5-20251001',
  )
  assert.equal(back.object, 'text_completion')
  assert.equal(back.choices[0].text, 'world')
  assert.equal(back.choices[0].finish_reason, 'stop')
})

test('OpenAI chat usage carries prompt_tokens_details cache breakdown', () => {
  const claude = {
    id: 'msg_1',
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 7,
    },
  }
  const out = fromClaudeToOpenAIChat(claude, 'claude-haiku-4-5-20251001', 'vm-1', 'convert')
  assert.equal(out.usage.prompt_tokens, 20)
  assert.equal(out.usage.completion_tokens, 4)
  assert.equal(out.usage.total_tokens, 24)
  assert.deepEqual(out.usage.prompt_tokens_details, { cached_tokens: 3, cache_creation_tokens: 7 })
})

test('OpenAI chat usage omits details when no cache tokens', () => {
  const claude = {
    id: 'msg_1',
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 4 },
  }
  const out = fromClaudeToOpenAIChat(claude, 'claude-haiku-4-5-20251001', 'vm-1', 'convert')
  assert.equal(out.usage.prompt_tokens_details, undefined)
})

test('OpenAI responses usage carries input_tokens_details cache breakdown', () => {
  const claude = {
    id: 'msg_1',
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
  }
  const out = fromClaudeToResponses(claude, 'claude-haiku-4-5-20251001', 'vm-1', 'convert')
  assert.equal(out.usage.input_tokens, 12)
  assert.equal(out.usage.total_tokens, 16)
  assert.deepEqual(out.usage.input_tokens_details, { cached_tokens: 2 })
})

test('OpenAI response_format.json_schema maps to output_config', () => {
  const { claude } = toClaudeMessages('openai.chat', {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'color' }],
    max_tokens: 64,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'colors',
        schema: { type: 'object', properties: { top_left: { type: 'string' } } },
      },
    },
  })
  assert.equal(claude.output_config.format.type, 'json_schema')
  assert.equal(claude.output_config.format.name, 'colors')
  assert.equal(claude.output_config.format.schema.properties.top_left.type, 'string')
})

test('OpenAI chat maps Anthropic refusal instead of silent stop', () => {
  const out = fromClaudeToOpenAIChat(
    {
      content: [{ type: 'refusal', refusal: 'no' }],
      stop_reason: 'refusal',
      usage: { input_tokens: 8, output_tokens: 0 },
    },
    'claude-opus-5',
    'vm-1',
    'convert',
  )
  assert.equal(out.choices[0].finish_reason, 'content_filter')
  assert.equal(out.choices[0].message.refusal, 'no')
  assert.equal(out.choices[0].message.content, 'no')
})

test('OpenAI response_format survives Anthropic sanitize as output_config', () => {
  const native = officialMessagesBody({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'json' }],
    max_tokens: 32,
    response_format: { type: 'json_object' },
  })
  assert.equal(native.output_config.format.type, 'json_schema')
  assert.equal(native.response_format, undefined)
})

test('officialMessagesBody keeps a caller max_tokens and fills a missing one from the model', () => {
  const kept = officialMessagesBody({
    model: 'claude-haiku-5-5',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(kept.max_tokens, 64)
  const sonnet = officialMessagesBody({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(sonnet.max_tokens, 64000)
  const haiku = officialMessagesBody({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(haiku.max_tokens, 100000)
})

test('test14 OpenAI tools on /v1/messages convert to Anthropic get_weather', () => {
  const { claude, mode } = toClaudeMessages('anthropic.messages', TEST14_OPENAI_INBOUND)
  assert.equal(mode, 'convert')
  assert.ok(matchesTest14Features(extractCaseFeatures(claude)))
  assert.equal(claude.tools[0].name, 'get_weather')
  assert.equal(claude.tool_choice.type, 'tool')
  assert.equal(claude.tool_choice.name, 'get_weather')
})

test('test14 OpenAI chat records features and converts to official 4-block', () => {
  const { claude } = toClaudeMessages('openai.chat', TEST14_OPENAI_INBOUND)
  const features = extractCaseFeatures(claude)
  assert.ok(matchesTest14Features(features))
  assert.equal(features.user_text, TEST14_FEATURES.inbound.user_text)
  assert.deepEqual(features.tool_names, ['get_weather'])
  const after = applyCrsUnofficialPersona(claude, { officialClient: false, mode: 'rewrite' })
  assert.equal(after.system.length, TEST14_FEATURES.official_outbound.system_block_count)
  // rewrite parks billing after the agent cache breakpoint; cch changes every turn.
  assert.deepEqual(officialSystemKinds(after.system), ['identity', 'agent_prompt', 'billing', 'environment'])
  const cacheAt = after.system.findLastIndex((block) => block?.cache_control)
  const billingAt = after.system.findIndex((block) => /x-anthropic-billing-header:/i.test(String(block?.text || '')))
  assert.ok(cacheAt >= 0 && billingAt > cacheAt)
  assert.deepEqual(after.tools, claude.tools)
  assert.deepEqual(after.tool_choice, claude.tool_choice)
  assert.ok(String(extractCaseFeatures(after).user_text).includes(TEST14_FEATURES.inbound.user_text))
  const hide = personaHideInputTokens(claude, after)
  assert.equal(hide.wipeCache, false)
  assert.ok(!String(after.system[3]?.text || '').includes('# auto memory'))
  assert.ok(hide.official > 80)
  assert.ok(hide.official < 500)
  assert.ok(hide.overlay > 0)
  assert.equal(hide.tools, 0)
  const userKeep = 80
  const hidden = hidePersonaUsage(
    {
      input_tokens: hide.uncached + hide.overlay + userKeep,
      cache_creation_input_tokens: 9078,
      output_tokens: 24,
      total_tokens: hide.uncached + hide.overlay + userKeep + 9078 + 24,
    },
    hide,
  )
  assert.equal(hidden.input_tokens, userKeep)
  assert.equal(hidden.cache_creation_input_tokens, 9078)
  const back = fromClaudeToOpenAIChat(
    {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_weather',
          name: 'get_weather',
          input: { city: '东京', unit: 'celsius' },
        },
      ],
      stop_reason: 'tool_use',
      usage: hidden,
    },
    'claude-sonnet-5',
    'vm-1',
    'convert',
  )
  assert.equal(back.choices[0].finish_reason, 'tool_calls')
  assert.equal(back.choices[0].message.tool_calls[0].function.name, 'get_weather')
  assert.equal(back.usage.prompt_tokens, userKeep + 9078)
  assert.deepEqual(back.usage.prompt_tokens_details, { cache_creation_tokens: 9078 })
})
