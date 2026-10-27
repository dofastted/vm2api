import test from 'node:test'
import assert from 'node:assert/strict'
import {
  prepareCliHopBody,
  prepareOutboundEnvelope,
  stripCliOwnedSystem,
} from '../../src/lib/protocol/outbound-attempt.mjs'
import {
  applyCrsUnofficialPersona,
  CRS_OFFICIAL_SYSTEM,
  CRS_OFFICIAL_CLI_SYSTEM,
  parkableSystemText,
} from '../../src/lib/identity/crs-persona.mjs'
import { CRS_OFFICIAL_AGENT_PROMPT } from '../../src/lib/identity/official-cc-system-2.1.241.mjs'

test('prepareCliHopBody drops metadata and CLI-owned system but keeps official agent leftover', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    max_tokens: 256,
    metadata: { user_id: '{"device_id":"abc"}' },
    system: [
      {
        type: 'text',
        text: "x-anthropic-billing-header: cc_version=2.8.4; prompt_version=You are a Claude agent, built on Anthropic's Claude Agent SDK.;",
      },
      { type: 'text', text: CRS_OFFICIAL_SYSTEM },
      { type: 'text', text: CRS_OFFICIAL_AGENT_PROMPT },
      { type: 'text', text: '# Environment\nTime zone: America/New_York' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(body.metadata, undefined)
  assert.equal(body.system[0].text, CRS_OFFICIAL_CLI_SYSTEM)
  assert.equal(body.system[0].cache_control.ttl, '1h')
  assert.match(body.system[1].text, /You are an interactive agent/)
  assert.equal(body.model, 'claude-sonnet-5')
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ])
  assert.equal(body.stream, true)
})

test('every cli-hop system becomes the identity plus the caller body', () => {
  const billing = 'x-anthropic-billing-header: cc_version=2.1.280.096; cc_entrypoint=cli; cch=bdff0;'
  const body = prepareCliHopBody(
    {
      model: 'claude-opus-5-5',
      max_tokens: 32,
      system: [
        { type: 'text', text: billing },
        { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: 'text', text: 'RFC 2119 keywords', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      messages: [{ role: 'user', content: 'ping' }],
    },
    { preserveSystem: true },
  )
  assert.equal(body.system.length, 2)
  assert.equal(body.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.")
  assert.equal(body.system[1].text, 'RFC 2119 keywords')
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(body.system[1].cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('cli-hop normalizes mixed caller markers to the official template', () => {
  const input = {
    model: 'claude-opus-5-5',
    max_tokens: 128,
    tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    system: [{ type: 'text', text: 'caller', cache_control: { type: 'ephemeral', ttl: '5m', scope: 'global' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first', cache_control: { type: 'ephemeral' } }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'answer', cache_control: { type: 'ephemeral', ttl: '5m' } }],
      },
      { role: 'user', content: [{ type: 'text', text: 'last' }] },
    ],
  }
  const body = prepareCliHopBody(input, { preserveSystem: true, cacheTtl: '1h' })
  assert.equal(body.system[0].text, CRS_OFFICIAL_CLI_SYSTEM)
  assert.equal(body.system[1].text, 'caller')
  assert.deepEqual(body.system[1].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(body.messages[0].content[0].cache_control, undefined)
  assert.equal(body.messages[1].content[0].cache_control, undefined)
  assert.deepEqual(body.messages[2].content[0].cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('caller environment stays behind the official identity', () => {
  const caller = '  # Environment\n - Timezone: Pacific/Auckland\n - Caller-only fact: KEEP_ME\n '
  const body = prepareCliHopBody(
    { model: 'claude-opus-5-5', system: [{ type: 'text', text: caller }], messages: [{ role: 'user', content: 'hi' }] },
    { preserveCallerEnvironment: true },
  )
  assert.equal(body.system[0].text, CRS_OFFICIAL_CLI_SYSTEM)
  assert.equal(body.system[1].text, caller)
})

test('environment opt-out prevents HTTP slot selection from overwriting caller timezone', () => {
  const caller = '# Environment\n - Timezone: Pacific/Auckland\n - Caller-only fact: KEEP_ME'
  const { body } = prepareOutboundEnvelope({
    canonicalBody: {
      model: 'claude-opus-5-5',
      system: [{ type: 'text', text: caller }],
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 128,
    },
    identity: { timezone: 'Asia/Tokyo' },
    preserveCallerEnvironment: true,
    credentialMode: 'api-key',
  })
  assert.deepEqual(body.system, [{ type: 'text', text: caller }])
})

test('cli-hop passthrough rejects invalid caller markers instead of repairing them', () => {
  const request = (content) => ({
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content }],
  })
  const marker = (ttl) => ({ type: 'text', text: 'anchor', cache_control: { type: 'ephemeral', ...ttl } })
  for (const content of [
    Array.from({ length: 5 }, () => marker({ ttl: '5m' })),
    [marker({}), marker({ ttl: '1h' })],
    [marker({ ttl: 'bad' })],
    [{ type: 'thinking', thinking: 'private', cache_control: { type: 'ephemeral' } }],
    [{ type: 'redacted_thinking', data: 'private', cache_control: { type: 'ephemeral' } }],
  ]) {
    const input = request(content)
    const before = structuredClone(input)
    assert.throws(
      () => prepareCliHopBody(input, { preserveSystem: true }),
      (error) => {
        assert.equal(error.status, 400)
        assert.equal(error.body.error.code, 'invalid_cache_control')
        return true
      },
    )
    assert.deepEqual(input, before)
  }
})

test('prepareCliHopBody keeps caller leftover system and tools', () => {
  const body = prepareCliHopBody({
    model: 'claude-opus-5',
    max_tokens: 1024,
    system: [
      { type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM },
      { type: 'text', text: '你是一个高速收费员。' },
    ],
    tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: {} } }],
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: '你好呀。' }],
  })
  assert.equal(body.metadata, undefined)
  assert.equal(body.system[0].text, CRS_OFFICIAL_CLI_SYSTEM)
  assert.equal(body.system[1].text, '你是一个高速收费员。')
  assert.equal(body.tools[0].name, 'get_weather')
  assert.equal(body.thinking.type, 'disabled')
})

test('stripCliOwnedSystem leaves empty inbound system absent', () => {
  assert.equal(stripCliOwnedSystem(undefined), undefined)
  assert.equal(stripCliOwnedSystem(''), undefined)
  assert.equal(stripCliOwnedSystem([{ type: 'text', text: '' }]), undefined)
})

test('prepareCliHopBody applies display but leaves model policy and sampling to cli-node', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    thinking: { type: 'adaptive' },
    temperature: 0.2,
    context_management: { edits: [] },
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
  assert.equal(body.output_config, undefined)
  assert.deepEqual(body.context_management, { edits: [] })
  assert.equal(body.temperature, 0.2)
  assert.equal(body.metadata, undefined)
})

test('prepareCliHopBody keeps caller thinking disabled', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    max_tokens: 256,
    thinking: { type: 'disabled' },
    context_management: { edits: [] },
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(body.thinking.type, 'disabled')
  assert.deepEqual(body.context_management, { edits: [] })
})

test('prepareCliHopBody strips unsigned dummy and short thinking history', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    max_tokens: 256,
    thinking: { type: 'adaptive' },
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'keep-me', signature: 'sig_real_1234567890abcdef' },
          { type: 'thinking', thinking: 'no-sig' },
          { type: 'thinking', thinking: '', signature: 'sig_empty_text_still_long_enough' },
          { type: 'thinking', thinking: 'dummy', signature: 'skip_thought_signature_validator' },
          { type: 'thinking', thinking: 'short', signature: 'abc' },
          { type: 'text', text: 'hello' },
        ],
      },
      { role: 'user', content: 'again' },
    ],
  })
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
  assert.equal(body.temperature, undefined)
  assert.deepEqual(body.messages[1].content, [
    { type: 'thinking', thinking: 'keep-me', signature: 'sig_real_1234567890abcdef' },
    { type: 'thinking', thinking: '', signature: 'sig_empty_text_still_long_enough' },
    { type: 'text', text: 'hello' },
  ])
})
test('prepareCliHopBody drops thinking without a usable signature on the preserve path', () => {
  const body = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      max_tokens: 256,
      thinking: { type: 'adaptive' },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'existing', signature: 'sig_real_1234567890abcdef' },
            { type: 'thinking', thinking: 'short', signature: 'abc' },
            { type: 'thinking', thinking: 'missing' },
            { type: 'redacted_thinking', data: '' },
            { type: 'text', text: 'hello' },
          ],
        },
      ],
    },
    { preserveThinkingBlocks: true },
  )
  assert.equal(body.messages[1].content.at(-1).text, 'hello')
  assert.equal(body.messages[1].content.at(-1).cache_control, undefined)
})

test('prepareCliHopBody keeps a short non-dummy signature on Opus 5.5', () => {
  const body = prepareCliHopBody({
    model: 'claude-opus-5.5',
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    messages: [
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'draft only', signature: 'abc' }],
      },
      { role: 'user', content: 'continue' },
    ],
  })
  assert.equal(body.model, 'claude-opus-5.5')
  assert.deepEqual(
    body.messages.map((message) => message.role),
    ['user', 'assistant', 'user'],
  )
  assert.deepEqual(body.messages[1].content, [{ type: 'thinking', thinking: 'draft only', signature: 'abc' }])
})

test('prepareCliHopBody repaired does not refill thinking after signature downgrade', () => {
  const body = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'plan' },
            { type: 'text', text: 'hello' },
          ],
        },
        { role: 'user', content: 'again' },
      ],
    },
    { repaired: true },
  )
  assert.equal(body.thinking, undefined)
  assert.equal(body.context_management, undefined)
  assert.deepEqual(body.messages[1].content, [
    { type: 'text', text: 'plan' },
    { type: 'text', text: 'hello' },
  ])
})

test('prepareCliHopBody leaves Haiku thinking and context management untouched', () => {
  const body = prepareCliHopBody({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    thinking: { type: 'adaptive', display: 'omitted' },
    context_management: { edits: [{ type: 'clear_thinking_20251015' }] },
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(body.thinking.type, 'adaptive')
  assert.deepEqual(body.context_management, { edits: [{ type: 'clear_thinking_20251015' }] })
  assert.equal(body.output_config, undefined)
})

function withoutMessageCache(body) {
  return {
    ...body,
    messages: (body.messages || []).map((message) => {
      if (!Array.isArray(message?.content)) return message
      return {
        ...message,
        content: message.content.map((block) => {
          if (!block || typeof block !== 'object' || !block.cache_control) return block
          const { cache_control: _drop, ...rest } = block
          return rest
        }),
      }
    }),
  }
}

function messageMarkers(body) {
  const hits = []
  for (const [index, message] of (body.messages || []).entries()) {
    if (!Array.isArray(message?.content)) continue
    for (const [blockIndex, block] of message.content.entries()) {
      if (!block?.cache_control) continue
      hits.push({ index, blockIndex, type: block.type, ttl: block.cache_control.ttl })
    }
  }
  return hits
}

test('cli-hop drops caller system/tools markers and restamps last plus penultimate user', () => {
  const body = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      max_tokens: 256,
      tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '5m' } }],
      system: [{ type: 'text', text: 'caller', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      cache_control: { type: 'ephemeral', ttl: '5m' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'u1', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1', cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: [{ type: 'text', text: 'u2' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      ],
    },
    { cacheTtl: '5m' },
  )
  assert.equal(body.cache_control, undefined)
  assert.equal(body.tools[0].cache_control, undefined)
  assert.equal(body.system[0].text, CRS_OFFICIAL_CLI_SYSTEM)
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(messageMarkers(body), [
    { index: 0, blockIndex: 0, type: 'text', ttl: '5m' },
    { index: 2, blockIndex: 0, type: 'text', ttl: '5m' },
  ])
})

test('cli-hop short history only marks the last message', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    max_tokens: 256,
    messages: [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ],
  })
  assert.deepEqual(
    body.messages.map((message) => message.role),
    ['user', 'assistant', 'user'],
  )
  assert.deepEqual(messageMarkers(body), [{ index: 2, blockIndex: 0, type: 'text', ttl: '1h' }])
})

test('cli-hop does not mark thinking blocks', () => {
  const body = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      max_tokens: 256,
      thinking: { type: 'adaptive' },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'answer' },
            { type: 'thinking', thinking: 'hidden', signature: 'sig_real_1234567890abcdef' },
          ],
        },
      ],
    },
    { cacheTtl: '1h' },
  )
  assert.equal(body.messages.at(-1).content[0].cache_control, undefined)
  assert.equal(body.messages.at(-1).content[1].type, 'thinking')
  assert.equal(body.messages.at(-1).content[1].cache_control, undefined)
})

test('cli-hop uses the inbound session TTL on both message anchors', () => {
  const body = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
      ],
    },
    { cacheTtl: '1h' },
  )
  assert.deepEqual(
    messageMarkers(body).map((hit) => hit.ttl),
    ['1h', '1h'],
  )
})

test('Claude Code turns stay a content prefix of the next one, from turn 1 on', () => {
  const reminder = (text) => ({ role: 'system', content: text })
  const budget = (left) => reminder(`<total_tokens>${left} tokens left</total_tokens>`)
  const turn = (messages) =>
    prepareCliHopBody({
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      system: [{ type: 'text', text: 'main prompt' }],
      messages,
    })
  const turns = [
    [{ role: 'user', content: 'u1' }, reminder('SessionStart hook context')],
    [{ role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' }, budget(14930105)],
    [{ role: 'assistant', content: 'a2' }, { role: 'user', content: 'u3' }, budget(14928642)],
  ]
  let history = []
  let previous = null
  for (const added of turns) {
    history = [...history, ...added]
    const body = turn(history)
    assert.equal(body.messages.at(-1).role, 'system')
    if (previous) {
      assert.deepEqual(body.system, previous.system)
      assert.deepEqual(
        withoutMessageCache(body).messages.slice(0, previous.messages.length),
        withoutMessageCache(previous).messages,
      )
    }
    previous = body
  }
})

test('cli-hop lifts role=system turns for models that reject them', () => {
  const body = prepareCliHopBody({
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    messages: [
      { role: 'user', content: 'u1' },
      { role: 'system', content: 'reminder' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ],
  })
  assert.ok(body.messages.every((message) => message.role !== 'system'))
  assert.equal(body.system.at(-1).text, 'reminder')
})

test('sonnet-5 lift keeps one context-budget reminder so the system tail stays stable', () => {
  const budget = (left) => ({
    role: 'system',
    content: `<system-reminder>\n<total_tokens>${left} tokens left</total_tokens>\n</system-reminder>`,
  })
  const env = {
    role: 'system',
    content: '<system-reminder>\n# Environment\n - Primary working directory: /tmp\n</system-reminder>',
  }
  const base = {
    model: 'claude-sonnet-5',
    max_tokens: 256,
    system: [{ type: 'text', text: 'main prompt' }],
  }
  const first = prepareCliHopBody({
    ...base,
    messages: [{ role: 'user', content: 'u1' }, env, budget(14930105)],
  })
  const second = prepareCliHopBody({
    ...base,
    messages: [
      { role: 'user', content: 'u1' },
      env,
      budget(14930105),
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      budget(14928642),
    ],
  })
  const reminders = (body) => JSON.stringify(body.system).match(/<total_tokens>/g)?.length || 0
  assert.equal(reminders(first), 1)
  assert.equal(reminders(second), 1)
  assert.deepEqual(second.system, first.system)
  assert.ok(second.messages.every((message) => message.role !== 'system'))
  const persona = (body) =>
    applyCrsUnofficialPersona(body, {
      mode: 'official_full',
      park: false,
      forceConfigured: true,
      model: 'claude-sonnet-5',
      sessionId: '11111111-2222-4333-8444-555555555555',
    })
  const renderedFirst = persona(first)
  const renderedSecond = persona(second)
  assert.deepEqual(renderedSecond.system, renderedFirst.system)
  assert.equal(JSON.stringify(renderedSecond.system).includes('14928642'), false)
})

test('a later budget drop leaves a mixed system-reminder wrapper intact', () => {
  const only = '<system-reminder>\n<total_tokens>2 tokens left</total_tokens>\n</system-reminder>'
  const mixed = '<system-reminder>\nKEEP\n<total_tokens>1 tokens left</total_tokens>\n</system-reminder>'
  const joined = parkableSystemText([
    { type: 'text', text: only },
    { type: 'text', text: mixed },
  ])
  assert.equal(joined.split('<system-reminder>').length, joined.split('</system-reminder>').length)
  assert.match(joined, /<system-reminder>\nKEEP\n\n?<\/system-reminder>/)
  assert.equal(joined.match(/<total_tokens>/g)?.length, 1)
  assert.match(joined, /<total_tokens>2 tokens left<\/total_tokens>/)
  assert.doesNotMatch(joined, /<total_tokens>1 tokens left<\/total_tokens>/)
})

test('cli-hop leaves Opus model policy for cli-node', () => {
  const body = prepareCliHopBody({
    model: 'claude-opus-5.5',
    thinking: { type: 'enabled', budget_tokens: 8000, display: 'summarized' },
    output_config: { effort: 'high' },
    tool_choice: { type: 'tool', name: 'get_weather' },
    tools: [
      { name: 'get_weather', input_schema: { type: 'object' } },
      { type: 'computer_20251124', name: 'computer' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(body.model, 'claude-opus-5.5')
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 8000, display: 'summarized' })
  assert.equal(body.output_config.effort, 'high')
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'get_weather' })
  assert.equal(body.tools.find((tool) => tool.name === 'get_weather').strict, undefined)
  assert.equal(body.tools.find((tool) => tool.name === 'computer').type, 'computer_20251124')
})
