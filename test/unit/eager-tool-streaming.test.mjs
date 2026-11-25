import test from 'node:test'
import assert from 'node:assert/strict'
import { applyEagerToolStreaming } from '../../src/lib/protocol/eager-tool-streaming.mjs'
import { officialMessagesBody } from '../../src/lib/protocol/anthropic-messages.mjs'
import { toClaudeMessages } from '../../src/lib/protocol/convert.mjs'
import { prepareCliHopBody, prepareCliPersonaInput } from '../../src/lib/protocol/outbound-attempt.mjs'

const schema = { type: 'object', properties: {} }
const body = () => ({
  model: 'claude-opus-5-5',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [
    { name: 'Write', description: 'w', input_schema: schema },
    { name: 'Edit', description: 'e', input_schema: schema, eager_input_streaming: false },
    { name: 'Bash', description: 'b', input_schema: schema },
    { type: 'web_search_20250305', name: 'web_search' },
  ],
})
const on = { failover: { eager_tool_streaming: true } }
const off = { failover: { eager_tool_streaming: false } }

function byName(tools) {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]))
}

test('applyEagerToolStreaming defaults to on when unset or omitted in routing', () => {
  const unset = applyEagerToolStreaming(body(), {})
  const emptyFailover = applyEagerToolStreaming(body(), { failover: {} })
  assert.equal(byName(unset.tools).Write.eager_input_streaming, true)
  assert.equal(byName(emptyFailover.tools).Write.eager_input_streaming, true)
  assert.equal(byName(applyEagerToolStreaming(body(), on).tools).Write.eager_input_streaming, true)
})

test('applyEagerToolStreaming respects explicit false', () => {
  const input = body()
  assert.equal(applyEagerToolStreaming(input, off), input)
})

test('applyEagerToolStreaming marks every custom tool and keeps caller booleans', () => {
  const out = applyEagerToolStreaming(body(), on)
  const tools = byName(out.tools)
  assert.equal(tools.Write.eager_input_streaming, true)
  assert.equal(tools.Bash.eager_input_streaming, true)
  assert.equal(tools.Edit.eager_input_streaming, false)
  // Server tools reject unknown fields.
  assert.equal(tools.web_search.eager_input_streaming, undefined)
})

test('the eager flag survives outbound tool sanitizing when the panel enables it', () => {
  const out = officialMessagesBody(applyEagerToolStreaming(body(), on))
  assert.equal(out.tools.find((tool) => tool.name === 'Write').eager_input_streaming, true)
})

test('OpenAI chat and responses tools get eager on the outbound Anthropic body', () => {
  for (const protocol of ['openai.chat', 'openai.responses']) {
    const inbound = {
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'hi' }],
      input: protocol === 'openai.responses' ? 'hi' : undefined,
      tools: [
        { type: 'function', function: { name: 'Write', description: 'w', parameters: schema } },
        {
          type: 'function',
          function: { name: 'Edit', parameters: schema, eager_input_streaming: false },
        },
        { type: 'web_search_20250305', name: 'web_search' },
      ],
    }
    const converted = toClaudeMessages(protocol, inbound)
    const out = officialMessagesBody(applyEagerToolStreaming(converted.claude, on))
    const tools = byName(out.tools)
    assert.equal(tools.Write.eager_input_streaming, true)
    assert.equal(tools.Edit.eager_input_streaming, false)
    assert.equal(tools.web_search.eager_input_streaming, undefined)
  }
})

test('applyEagerToolStreaming marks leftover OpenAI function tools before sanitizing', () => {
  const openaiBody = {
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'Write', parameters: schema } }],
  }
  const marked = applyEagerToolStreaming(openaiBody, on)
  assert.equal(marked.tools[0].eager_input_streaming, true)
  assert.equal(marked.tools[0].function.eager_input_streaming, true)
  const out = officialMessagesBody(marked)
  assert.equal(out.tools[0].name, 'Write')
  assert.equal(out.tools[0].eager_input_streaming, true)
})

for (const preset of ['official_full', 'zero']) {
  test(`CLI ${preset} preserves eager flags through persona preparation and final assembly`, () => {
    for (const routing of [on, off]) {
      const input = body()
      input.tools[0].cache_control = { type: 'ephemeral', ttl: '1h' }
      input.tools[2].eager_input_streaming = true
      const before = structuredClone(input)
      const prepared = prepareCliPersonaInput(input, preset)
      const staged = byName(prepared.tools)
      assert.equal(staged.Edit.eager_input_streaming, false)
      assert.equal(staged.Bash.eager_input_streaming, true)
      assert.deepEqual(staged.Write.cache_control, preset === 'zero' ? input.tools[0].cache_control : undefined)
      const output = prepareCliHopBody(prepared, { routing, personaPreset: preset })
      const tools = byName(output.tools)
      assert.equal(tools.Write.eager_input_streaming, routing === on ? true : undefined)
      assert.equal(tools.Edit.eager_input_streaming, false)
      assert.equal(tools.Bash.eager_input_streaming, true)
      assert.equal(tools.web_search.eager_input_streaming, undefined)
      assert.deepEqual(input, before)
    }
  })
}
