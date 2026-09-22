import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareCliHopBody, stripCliOwnedSystem } from '../../src/lib/protocol/outbound-attempt.mjs'
import { CRS_OFFICIAL_SYSTEM, CRS_OFFICIAL_CLI_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'
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
  assert.equal(body.system.length, 1)
  assert.equal(body.system[0].text, CRS_OFFICIAL_AGENT_PROMPT)
  assert.equal(body.model, 'claude-sonnet-5')
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'hi' }])
  assert.equal(body.stream, true)
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
  assert.equal(body.system.length, 1)
  assert.equal(body.system[0].text, '你是一个高速收费员。')
  assert.equal(body.tools[0].name, 'get_weather')
  assert.equal(body.thinking.type, 'disabled')
})

test('stripCliOwnedSystem leaves empty inbound system absent', () => {
  assert.equal(stripCliOwnedSystem(undefined), undefined)
  assert.equal(stripCliOwnedSystem(''), undefined)
  assert.equal(stripCliOwnedSystem([{ type: 'text', text: '' }]), undefined)
})

test('prepareCliHopBody fills 2.1.263 thinking effort and context_management', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'omitted' })
  assert.equal(body.output_config.effort, 'high')
  assert.equal(body.context_management.edits[0].type, 'clear_thinking_20251015')
  assert.equal(body.metadata, undefined)
  assert.equal(body.system, undefined)
})

test('prepareCliHopBody does not overwrite caller thinking disabled', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    max_tokens: 256,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(body.thinking.type, 'disabled')
  assert.equal(body.context_management, undefined)
})

test('prepareCliHopBody strips unsigned empty dummy and short thinking history', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    max_tokens: 256,
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
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'omitted' })
  assert.equal(body.temperature, 1)
  assert.deepEqual(body.messages[1].content, [
    { type: 'thinking', thinking: 'keep-me', signature: 'sig_real_1234567890abcdef' },
    { type: 'text', text: 'hello' },
  ])
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

test('prepareCliHopBody disables thinking on Haiku so wrap CLI cannot inherit adaptive', () => {
  const body = prepareCliHopBody({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(body.thinking?.type, 'disabled')
  assert.equal(body.output_config, undefined)
  assert.equal(body.context_management, undefined)
})

test('prepareCliHopBody disables Haiku adaptive thinking', () => {
  const body = prepareCliHopBody({
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    thinking: { type: 'adaptive', display: 'omitted' },
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(body.thinking.type, 'disabled')
})

test('cli-hop keeps caller system and message anchors and fills the last tool', () => {
  const body = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      max_tokens: 256,
      tools: [
        { name: 'Read', input_schema: { type: 'object', properties: {} } },
        {
          name: 'Write',
          input_schema: { type: 'object', properties: {} },
          cache_control: { type: 'ephemeral', ttl: '5m' },
        },
      ],
      system: [
        {
          type: 'text',
          text: CRS_OFFICIAL_AGENT_PROMPT,
          cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' },
        },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      ],
    },
    { cacheTtl: '5m' },
  )
  assert.equal(body.tools[0].cache_control, undefined)
  assert.deepEqual(body.tools[1].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '5m' })
})

test('cli-hop does not invent a message breakpoint the caller did not send', () => {
  const body = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      max_tokens: 256,
      tools: [
        {
          name: 'Write',
          input_schema: { type: 'object', properties: {} },
          cache_control: { type: 'ephemeral', ttl: '5m' },
        },
      ],
      system: [{ type: 'text', text: CRS_OFFICIAL_AGENT_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    },
    { cacheTtl: '5m' },
  )
  assert.deepEqual(body.tools[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.equal(body.messages[0].content[0].cache_control, undefined)
})

test('cli-hop disabled keeps caller breakpoints and their ttl', () => {
  const body = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      max_tokens: 256,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'u1', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { role: 'user', content: [{ type: 'text', text: 'u2', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
        { role: 'user', content: [{ type: 'text', text: 'u3', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      ],
    },
    { cacheBreakpoints: { enabled: false } },
  )
  assert.equal(body.messages[0].content[0].cache_control.ttl, '1h')
  assert.equal(body.messages[2].content[0].cache_control.ttl, '1h')
  assert.equal(body.messages[4].content[0].cache_control.ttl, '1h')
})

test('cli-hop rewrite wins over routing fill when inbound already stamped last user', () => {
  const body = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      max_tokens: 256,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'u1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { role: 'user', content: [{ type: 'text', text: 'u2' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
        {
          role: 'user',
          content: [{ type: 'text', text: 'u3', cache_control: { type: 'ephemeral', ttl: '5m' } }],
        },
      ],
    },
    {
      cacheBreakpoints: {
        enabled: true,
        preserve_client: true,
        system_tail: true,
        tools_tail: true,
        messages: 'fill',
      },
    },
  )
  assert.equal(body.messages[0].content[0].cache_control, undefined)
  assert.equal(body.messages[2].content[0].cache_control, undefined)
  assert.deepEqual(body.messages[4].content[0].cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('cli-hop rewrite writes 5m on the Node-owned boundary', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    max_tokens: 256,
    messages: [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ],
  })
  assert.equal(body.messages[2].content[0].cache_control, undefined)
  assert.equal(body.messages[4].content[0].cache_control, undefined)
})

test('cli-hop writes the console 1h onto Node markers', () => {
  const body = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      max_tokens: 256,
      tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '5m' } }],
      system: [{ type: 'text', text: 'caller system', cache_control: { type: 'ephemeral', ttl: '5m' } }],
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'u3' },
      ],
    },
    { cacheTtl: '1h' },
  )
  assert.deepEqual(body.tools[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(body.messages[2].content[0].cache_control, undefined)
  assert.equal(body.messages[4].content[0].cache_control, undefined)
})

test('cli-hop writes the Node-owned boundary at 5m when the console asks for 5m', () => {
  const body = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'u3' },
      ],
    },
    { cacheTtl: '5m' },
  )
  assert.equal(body.messages[2].content[0].cache_control, undefined)
  assert.equal(body.messages[4].content[0].cache_control, undefined)
})

test('missing console TTL defaults mixed client breakpoints to 1h', () => {
  const body = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      max_tokens: 256,
      system: [{ type: 'text', text: CRS_OFFICIAL_AGENT_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'u1', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: [{ type: 'text', text: 'u2', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
      ],
    },
    { cacheTtl: null },
  )
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(body.messages[2].content[0].cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('cli-hop rewrite keeps sub2api penultimate user after dropping CLI last-user stamp', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    max_tokens: 256,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'u1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'u2', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
    ],
  })
  assert.equal(body.messages[0].content[0].cache_control, undefined)
  assert.deepEqual(body.messages[2].content[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(body.messages[3].content[0].cache_control, undefined)
})

test('unofficial cli-hop rewrite matches official penultimate-user leftover', () => {
  const inbound = {
    model: 'claude-sonnet-5',
    max_tokens: 256,
    messages: [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ],
  }
  const unofficial = prepareCliHopBody(inbound, { unofficial: true })
  const official = prepareCliHopBody(structuredClone(inbound), { unofficial: false })
  assert.equal(unofficial.messages[0].content[0].cache_control, undefined)
  assert.equal(unofficial.messages[2].content[0].cache_control, undefined)
  assert.equal(unofficial.messages[4].content[0].cache_control, undefined)
  assert.deepEqual(
    unofficial.messages.map((message) => message.content?.[0]?.cache_control),
    official.messages.map((message) => message.content?.[0]?.cache_control),
  )
})

test('cli-hop lift mode ends the hop on a user turn by lifting trailing system constraints', () => {
  withSystemMode('lift', () => {
    const leftover = {
      model: 'claude-sonnet-5',
      max_tokens: 256,
      system: [{ type: 'text', text: 'persona system prefix' }],
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'system', content: 'caller constraint after current user' },
      ],
    }
    const firstTurn = prepareCliHopBody(leftover, { unofficial: true })
    assert.equal(firstTurn.messages.length, 1)
    assert.equal(firstTurn.messages[0].role, 'user')
    assert.equal(firstTurn.messages[0].content[0].text, 'u1')
    assert.equal(firstTurn.system.at(-1).text, 'caller constraint after current user')
    assert.equal(firstTurn.messages[0].content[0].cache_control, undefined)
    assert.ok(firstTurn.system.every((block) => block.cache_control == null))

    const later = prepareCliHopBody({
      ...leftover,
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'system', content: 'historical constraint' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'system', content: 'current constraint' },
      ],
    })
    assert.equal(later.messages[1].role, 'system')
    assert.equal(later.messages.at(-1).role, 'user')
    assert.equal(later.messages.at(-1).content[0].text, 'u2')
    assert.equal(later.system.at(-1).text, 'current constraint')
    assert.equal(later.messages[0].content[0].cache_control, undefined)
    assert.equal(later.messages[1].content[0].cache_control, undefined)
    assert.equal(later.messages.at(-1).content[0].cache_control, undefined)
    assert.ok(later.system.every((block) => block.cache_control == null))
  })
})

test('cli-hop lift mode freezes the lifted 2.1.278 context budget so the next turn can read', () => {
  withSystemMode('lift', () => {
    const budget = (n) => `<system-reminder>\n<total_tokens>${n} tokens left</total_tokens>\n</system-reminder>`
    const stable = budget(15000000)
    const first = prepareCliHopBody({
      model: 'claude-sonnet-5',
      max_tokens: 256,
      system: [{ type: 'text', text: 'persona' }],
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'system', content: budget(14955783) },
      ],
    })
    const second = prepareCliHopBody({
      model: 'claude-sonnet-5',
      max_tokens: 256,
      system: [{ type: 'text', text: 'persona' }],
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'system', content: budget(14955783) },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'u3' },
        { role: 'system', content: budget(14947383) },
      ],
    })
    assert.equal(first.system.at(-1).text, stable)
    assert.equal(second.system.at(-1).text, stable)
    assert.deepEqual(
      first.system.map((block) => block.text),
      second.system.map((block) => block.text),
    )
    assert.equal(second.messages[3].role, 'system')
    assert.equal(second.messages[3].content[0].text, stable)
    assert.equal(second.messages[2].content[0].cache_control, undefined)
    assert.deepEqual(
      second.messages.slice(0, 3).map((message) => message.content[0].text),
      first.messages.map((message) => message.content[0].text),
    )
  })
})

test('cli-hop strips Claude Code last tool_use/tool_result markers', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    max_tokens: 256,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'u1' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'x', signature: 'sig' },
          { type: 'tool_use', id: 't1', name: 'Read', input: {}, cache_control: { type: 'ephemeral' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', cache_control: { type: 'ephemeral' } }],
      },
    ],
  })
  const asstBlocks = body.messages[1].content
  const userBlocks = body.messages[2].content
  assert.deepEqual(asstBlocks.find((b) => b.type === 'tool_use')?.cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(userBlocks.find((b) => b.type === 'tool_result')?.cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('prepareCliHopBody clamps small max_tokens to 1024 for automated probe tests', () => {
  const probe1 = prepareCliHopBody({
    model: 'claude-haiku-4-5',
    max_tokens: 1,
    messages: [{ role: 'user', content: '.' }],
  })
  assert.equal(probe1.max_tokens, 1024)

  const probe32 = prepareCliHopBody({
    model: 'claude-haiku-4-5',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'ping' }],
  })
  assert.equal(probe32.max_tokens, 1024)

  const normal = prepareCliHopBody({
    model: 'claude-haiku-4-5',
    max_tokens: 4096,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(normal.max_tokens, 4096)
})

function withSystemMode(mode, fn) {
  const prev = process.env.KIN_CLI_HOP_SYSTEM_MODE
  if (mode === undefined) delete process.env.KIN_CLI_HOP_SYSTEM_MODE
  else process.env.KIN_CLI_HOP_SYSTEM_MODE = mode
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.KIN_CLI_HOP_SYSTEM_MODE
    else process.env.KIN_CLI_HOP_SYSTEM_MODE = prev
  }
}

test('cli-hop keeps mid-conversation system turns on non-Haiku models', () => {
  withSystemMode(undefined, () => {
    const body = prepareCliHopBody(
      {
        model: 'claude-sonnet-5',
        max_tokens: 256,
        system: [{ type: 'text', text: 'persona' }],
        messages: [
          { role: 'user', content: 'u1' },
          { role: 'assistant', content: 'a1' },
          { role: 'user', content: 'u2' },
          { role: 'system', content: '<total_tokens>14955783 tokens left</total_tokens>' },
        ],
      },
      { cacheTtl: '1h' },
    )
    // Official shape: the live counter stays at the tail of messages...
    assert.equal(body.messages.at(-1).role, 'system')
    assert.equal(body.messages.at(-1).content[0].text, '<total_tokens>15000000 tokens left</total_tokens>')
    assert.equal(body.system.length, 1)
    assert.equal(body.system[0].text, 'persona')
  })
})

test('cli-hop keeps the live counter inside the replay prefix', () => {
  withSystemMode(undefined, () => {
    const live = (n) => ({ role: 'system', content: `<system-reminder>live state ${n} alpha</system-reminder>` })
    const first = prepareCliHopBody(
      {
        model: 'claude-sonnet-5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'u1' }, live(7)],
      },
      { cacheTtl: '1h' },
    )
    const later = prepareCliHopBody(
      {
        model: 'claude-sonnet-5',
        max_tokens: 256,
        messages: [
          { role: 'user', content: 'u1' },
          live(7),
          { role: 'assistant', content: 'a1' },
          { role: 'user', content: 'u2' },
          live(8),
        ],
      },
      { cacheTtl: '1h' },
    )
    // Replayed history keeps the same bytes (markers aside): first request is a prefix.
    const plain = (message) =>
      JSON.stringify({
        role: message.role,
        content: (Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }]).map(
          ({ cache_control: _marker, ...block }) => block,
        ),
      })
    assert.equal(plain(first.messages[0]), plain(later.messages[0]))
    assert.equal(plain(first.messages[1]), plain(later.messages[1]))
    assert.equal(later.messages.at(-1).role, 'system')
  })
})

test('cli-hop still lifts for Haiku, which has no mid-conversation system', () => {
  withSystemMode(undefined, () => {
    const body = prepareCliHopBody(
      {
        model: 'claude-haiku-4-5',
        max_tokens: 256,
        messages: [
          { role: 'user', content: 'u1' },
          { role: 'system', content: '<total_tokens>14955783 tokens left</total_tokens>' },
        ],
      },
      { cacheTtl: '5m' },
    )
    assert.equal(body.messages.at(-1).role, 'user')
    assert.equal(body.messages.at(-1).content[0].text, 'u1')
    assert.equal(body.system.at(-1).text, '<total_tokens>15000000 tokens left</total_tokens>')
  })
})

test('cli-hop system mode fold moves every system turn into user content', () => {
  withSystemMode('fold', () => {
    const body = prepareCliHopBody(
      {
        model: 'claude-sonnet-5',
        max_tokens: 256,
        messages: [
          { role: 'user', content: 'u1' },
          { role: 'system', content: 'mid reminder' },
          { role: 'assistant', content: 'a1' },
          { role: 'user', content: 'u2' },
          { role: 'system', content: 'tail reminder' },
        ],
      },
      { cacheTtl: '1h' },
    )
    assert.ok(body.messages.every((message) => message.role !== 'system'))
    assert.ok(body.messages[0].content.some((block) => block.text === 'mid reminder'))
    assert.ok(body.messages.at(-1).content.some((block) => block.text === 'tail reminder'))
  })
})

test('cli-hop system mode lift keeps upstream lift+pin when forced', () => {
  withSystemMode('lift', () => {
    const body = prepareCliHopBody(
      {
        model: 'claude-sonnet-5',
        max_tokens: 256,
        messages: [
          { role: 'user', content: 'u1' },
          { role: 'system', content: '<total_tokens>14955783 tokens left</total_tokens>' },
        ],
      },
      { cacheTtl: '1h' },
    )
    assert.equal(body.messages.at(-1).role, 'user')
    assert.equal(body.system.at(-1).text, '<total_tokens>15000000 tokens left</total_tokens>')
  })
})
