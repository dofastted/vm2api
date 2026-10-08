import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chatToCodexResponses,
  responsesToolChoice,
  createChatSseState,
  normalizeCodexResponsesInput,
  responsesSseToChatChunk,
  responsesSseToAnthropicEvents,
  createAnthropicSseState,
  createResponsesSseEventNamer,
  assembleCodexBodyFromSse,
  codexBodyToAnthropicMessage,
  stripCodexIdentity,
  toCodexResponses,
} from '../../src/lib/protocol/codex-convert.mjs'

test('strips client identity fields', () => {
  const out = stripCodexIdentity({
    model: 'gpt-5.4',
    client_metadata: { device_id: 'client' },
    base_url: 'http://evil',
    metadata: { user_id: 'u1', topic: 'keep' },
    input: [],
  })
  assert.equal(out.model, 'gpt-5.4')
  assert.equal(out.client_metadata, undefined)
  assert.equal(out.base_url, undefined)
  assert.equal(out.metadata.user_id, undefined)
  assert.equal(out.metadata.topic, 'keep')
})

test('chat tool turns become function_call items', () => {
  const body = chatToCodexResponses({
    model: 'gpt-5.5',
    reasoning_effort: 'medium',
    messages: [
      { role: 'system', content: 'be brief' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'todo', arguments: '{"a":1}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aaaa' } },
        ],
      },
    ],
  })
  assert.equal(
    body.input.some((item) => item.role === 'assistant' && !item.content?.[0]?.text),
    false,
  )
  assert.deepEqual(body.input[1], {
    type: 'function_call',
    call_id: 'call_1',
    name: 'todo',
    arguments: '{"a":1}',
  })
  assert.deepEqual(body.input[2], { type: 'function_call_output', call_id: 'call_1', output: 'done' })
  assert.equal(body.input[3].content[1].type, 'input_image')
  assert.equal(body.input[3].content[1].image_url, 'data:image/png;base64,aaaa')
  const washed = toCodexResponses('openai.chat', {
    model: 'gpt-5.5',
    reasoning_effort: 'high',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(washed.body.reasoning.effort, 'high')
})

test('chat tool_choice hoists function.name onto Responses tool_choice.name', () => {
  const body = chatToCodexResponses({
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
  })
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'get_weather' })
  const native = toCodexResponses('openai.responses', {
    model: 'gpt-5.4',
    input: 'hi',
    tool_choice: { type: 'function', function: { name: 'lookup' } },
  })
  assert.deepEqual(native.body.tool_choice, { type: 'function', name: 'lookup' })
  assert.equal(responsesToolChoice({ type: 'tool', name: 'get_weather' }).name, 'get_weather')
  assert.equal(responsesToolChoice({ type: 'any' }), 'required')
  assert.equal(responsesToolChoice('auto'), 'auto')
})

test('chat converts to responses input', () => {
  const body = chatToCodexResponses({
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ],
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    prompt_cache_key: 'conversation-42',
  })
  assert.equal(body.model, 'gpt-5.4')
  assert.equal(body.store, false)
  assert.equal(body.prompt_cache_key, 'conversation-42')
  assert.equal(body.input[0].role, 'developer')
  assert.equal(body.input[0].content[0].text, 'be brief')
  assert.equal(body.input[1].role, 'user')
  assert.equal(body.input[1].content[0].text, 'hi')
  assert.equal(body.tools[0].name, 'lookup')
})

test('native responses system role becomes developer', () => {
  const converted = toCodexResponses('openai.responses', {
    model: 'gpt-5.5',
    input: [{ type: 'message', role: 'system', content: [{ type: 'input_text', text: 'rules' }] }],
    prompt_cache_key: 'session-1',
    prompt_cache_retention: '24h',
  })
  assert.equal(converted.body.input[0].role, 'developer')
  assert.equal(converted.body.prompt_cache_key, 'session-1')
  assert.equal(converted.body.prompt_cache_retention, undefined)
})

test('native responses string input becomes Codex list', () => {
  const converted = toCodexResponses('openai.responses', {
    model: 'gpt-5.5',
    input: 'hello',
    stream: true,
  })
  assert.equal(converted.ok, true)
  assert.equal(Array.isArray(converted.body.input), true)
  assert.equal(converted.body.input[0].content[0].text, 'hello')
  const already = normalizeCodexResponsesInput({
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'keep' }] }],
  })
  assert.equal(already.input[0].content[0].text, 'keep')
})

test('legacy fast service tier is sent as priority to Codex', () => {
  const converted = toCodexResponses('openai.responses', {
    model: 'gpt-6.1-sol',
    input: 'hello',
    service_tier: 'fast',
  })
  assert.equal(converted.body.service_tier, 'priority')
})

test('Codex hop drops max_output_tokens and keeps reasoning effort', () => {
  const converted = toCodexResponses('openai.responses', {
    model: 'gpt-5.5',
    input: 'hello',
    max_output_tokens: 8192,
    temperature: 1,
    reasoning_effort: 'high',
  })
  assert.equal(converted.body.max_output_tokens, undefined)
  assert.equal(converted.body.temperature, undefined)
  assert.equal(converted.body.reasoning.effort, 'high')
})

test('anthropic convert stays off by default', () => {
  const rejected = toCodexResponses(
    'anthropic.messages',
    { model: 'gpt-5.4', messages: [{ role: 'user', content: 'x' }] },
    {},
  )
  assert.equal(rejected.ok, false)
  const allowed = toCodexResponses(
    'anthropic.messages',
    { model: 'gpt-5.4', messages: [{ role: 'user', content: 'x' }] },
    { anthropic_to_codex: true },
  )
  assert.equal(allowed.ok, true)
})

test('responses SSE maps to chat chunks', () => {
  const delta = responsesSseToChatChunk('data: {"type":"response.output_text.delta","delta":"Hi"}')
  assert.match(delta, /chat.completion.chunk/)
  assert.match(delta, /Hi/)
  const done = responsesSseToChatChunk(
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":41,"output_tokens":12,"input_tokens_details":{"cached_tokens":8,"cache_write_tokens":3}}}}',
  )
  assert.match(done, /\[DONE\]/)
  assert.match(done, /"prompt_tokens":41/)
  assert.match(done, /"completion_tokens":12/)
  assert.match(done, /"cached_tokens":8/)
  assert.match(done, /"cache_creation_tokens":3/)
})

test('function-call SSE maps to chat tool_calls', () => {
  const state = createChatSseState()
  const added = responsesSseToChatChunk(
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"todo"}}',
    'codex',
    state,
  )
  assert.match(added, /"tool_calls"/)
  assert.match(added, /"name":"todo"/)
  const delta = responsesSseToChatChunk(
    'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"a\\":1}"}',
    'codex',
    state,
  )
  const parsed = JSON.parse(delta.slice(5).trim())
  assert.equal(parsed.choices[0].delta.tool_calls[0].function.arguments, '{"a":1}')
  assert.equal(parsed.choices[0].delta.content, undefined)
  const done = responsesSseToChatChunk(
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1}}}',
    'codex',
    state,
  )
  assert.match(done, /"finish_reason":"tool_calls"/)
  const reason = responsesSseToChatChunk('data: {"type":"response.reasoning_summary_text.delta","delta":"think"}')
  assert.match(reason, /"reasoning_content":"think"/)
  assert.doesNotMatch(reason, /"content"/)
})

test('responses SSE maps to Anthropic message events', () => {
  const state = createAnthropicSseState()
  const start = responsesSseToAnthropicEvents('data: {"type":"response.output_text.delta","delta":"Hi"}', state)
  assert.match(start, /event: message_start/)
  assert.match(start, /text_delta/)
  assert.match(start, /Hi/)
  const done = responsesSseToAnthropicEvents(
    'data: {"type":"response.completed","response":{"usage":{"output_tokens":3}}}',
    state,
  )
  assert.match(done, /event: message_stop/)
  assert.match(done, /end_turn/)
})

test('Codex JSON body maps to Anthropic message', () => {
  const msg = codexBodyToAnthropicMessage(
    {
      id: 'resp_1',
      model: 'gpt-6-astra',
      output: [{ content: [{ type: 'output_text', text: 'hello' }] }],
      usage: { input_tokens: 4, output_tokens: 2 },
    },
    'gpt-6-astra',
  )
  assert.equal(msg.type, 'message')
  assert.equal(msg.content[0].text, 'hello')
  assert.equal(msg.usage.output_tokens, 2)
})

test('assembles Codex SSE chunks into Anthropic text', () => {
  const assembled = assembleCodexBodyFromSse([
    'data: {"type":"response.output_text.delta","delta":"Hel"}',
    'data: {"type":"response.output_text.delta","delta":"lo"}',
    'data: {"type":"response.completed","response":{"usage":{"output_tokens":2}}}',
  ])
  const msg = codexBodyToAnthropicMessage(assembled, 'gpt-6-astra')
  assert.equal(msg.content[0].text, 'Hello')
  assert.equal(msg.usage.output_tokens, 2)
})

test('kernel Responses frames are re-emitted under their payload type', () => {
  const name = createResponsesSseEventNamer()
  const lines = [
    'event: response',
    'data: {"type":"response.created","response":{"id":"resp_1"}}',
    '',
    'event: response',
    'data: {"type":"response.output_text.delta","delta":"po"}',
    '',
    ': keepalive',
    'event: response',
    'data: not-json',
    '',
    'data: {"type":"response.completed","response":{"status":"completed"}}',
  ]
  assert.equal(
    lines.map(name).join(''),
    [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"po"}',
      '',
      ': keepalive',
      'event: response',
      'data: not-json',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      '',
    ].join('\n'),
  )
})

function feedChatSse(events) {
  const state = createChatSseState()
  const tools = new Map()
  let finish = null
  for (const event of events) {
    const out = responsesSseToChatChunk(`data: ${JSON.stringify(event)}`, 'codex', state)
    if (!out) continue
    for (const frame of out.split('\n\n')) {
      const trimmed = frame.trim()
      if (!trimmed.startsWith('data:') || trimmed === 'data: [DONE]') continue
      const parsed = JSON.parse(trimmed.slice(5))
      for (const call of parsed.choices?.[0]?.delta?.tool_calls || []) {
        const tool = tools.get(call.index) || { args: '', headers: 0 }
        if (call.id) {
          tool.headers += 1
          tool.id = call.id
          tool.name = call.function?.name
        }
        tool.args += call.function?.arguments || ''
        tools.set(call.index, tool)
      }
      const reason = parsed.choices?.[0]?.finish_reason
      if (reason) finish = reason
    }
  }
  return { tools, finish }
}

const fcAdded = (index, id, callId, name) => ({
  type: 'response.output_item.added',
  output_index: index,
  item_id: id,
  item: { type: 'function_call', id, call_id: callId, name, arguments: '' },
})
const fcDone = (index, id, args) => ({
  type: 'response.function_call_arguments.done',
  output_index: index,
  item_id: id,
  arguments: args,
})
const fcItemDone = (index, id, callId, name, args) => ({
  type: 'response.output_item.done',
  output_index: index,
  item_id: id,
  item: { type: 'function_call', id, call_id: callId, name, arguments: args },
})

test('parallel tool calls with args only in arguments.done keep their arguments', () => {
  const { tools, finish } = feedChatSse([
    fcAdded(0, 'fc_0', 'call_a', 'bash'),
    fcAdded(1, 'fc_1', 'call_b', 'find'),
    fcDone(0, 'fc_0', '{"x":1}'),
    fcDone(1, 'fc_1', '{"y":2}'),
    fcItemDone(0, 'fc_0', 'call_a', 'bash', '{"x":1}'),
    fcItemDone(1, 'fc_1', 'call_b', 'find', '{"y":2}'),
    { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 2 } } },
  ])
  assert.equal(tools.get(0).args, '{"x":1}')
  assert.equal(tools.get(1).args, '{"y":2}')
  assert.equal(tools.get(0).headers, 1)
  assert.equal(tools.get(0).id, 'call_a')
  assert.equal(tools.get(0).name, 'bash')
  assert.equal(tools.get(1).headers, 1)
  assert.equal(tools.get(1).id, 'call_b')
  assert.equal(tools.get(1).name, 'find')
  assert.equal(finish, 'tool_calls')
})

test('parallel tool calls with args only in output_item.done keep their arguments', () => {
  const { tools, finish } = feedChatSse([
    fcAdded(0, 'fc_0', 'call_a', 'bash'),
    fcAdded(1, 'fc_1', 'call_b', 'find'),
    fcItemDone(0, 'fc_0', 'call_a', 'bash', '{"x":1}'),
    fcItemDone(1, 'fc_1', 'call_b', 'find', '{"y":2}'),
    { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 2 } } },
  ])
  assert.equal(tools.get(0).args, '{"x":1}')
  assert.equal(tools.get(1).args, '{"y":2}')
  assert.equal(tools.get(0).headers, 1)
  assert.equal(tools.get(0).id, 'call_a')
  assert.equal(tools.get(0).name, 'bash')
  assert.equal(tools.get(1).headers, 1)
  assert.equal(tools.get(1).id, 'call_b')
  assert.equal(tools.get(1).name, 'find')
  assert.equal(finish, 'tool_calls')
})

test('tool args already streamed via deltas are not repeated by done events', () => {
  const state = createChatSseState()
  for (const event of [
    fcAdded(0, 'fc_0', 'call_a', 'bash'),
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_0', delta: '{"x"' },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_0', delta: ':1}' },
  ]) {
    responsesSseToChatChunk(`data: ${JSON.stringify(event)}`, 'codex', state)
  }
  const done = responsesSseToChatChunk(`data: ${JSON.stringify(fcDone(0, 'fc_0', '{"x":1}'))}`, 'codex', state)
  assert.equal(done, null)
  const itemDone = responsesSseToChatChunk(
    `data: ${JSON.stringify(fcItemDone(0, 'fc_0', 'call_a', 'bash', '{"x":1}'))}`,
    'codex',
    state,
  )
  assert.equal(itemDone, null)
})

test('arguments.done emits only the tail missing from streamed deltas', () => {
  const state = createChatSseState()
  const tools = new Map()
  for (const event of [
    fcAdded(0, 'fc_0', 'call_a', 'bash'),
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_0', delta: '{"x"' },
    fcDone(0, 'fc_0', '{"x":1}'),
  ]) {
    const out = responsesSseToChatChunk(`data: ${JSON.stringify(event)}`, 'codex', state)
    if (!out) continue
    const parsed = JSON.parse(out.trim().slice(5))
    for (const call of parsed.choices[0].delta.tool_calls || []) {
      const tool = tools.get(call.index) || { args: '' }
      tool.args += call.function?.arguments || ''
      tools.set(call.index, tool)
    }
  }
  assert.equal(tools.get(0).args, '{"x":1}')
})

test('custom_tool_call args arrive via output_item.done input', () => {
  const { tools } = feedChatSse([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item_id: 'ctc_0',
      item: { type: 'custom_tool_call', id: 'ctc_0', call_id: 'call_c', name: 'apply_patch', input: '' },
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item_id: 'ctc_0',
      item: { type: 'custom_tool_call', id: 'ctc_0', call_id: 'call_c', name: 'apply_patch', input: 'raw text' },
    },
  ])
  assert.equal(tools.get(0).args, 'raw text')
  assert.equal(tools.get(0).id, 'call_c')
})

test('output_item.done for a message item returns null', () => {
  const out = responsesSseToChatChunk(
    'data: {"type":"response.output_item.done","output_index":0,"item_id":"msg_0","item":{"type":"message","id":"msg_0","role":"assistant"}}',
    'codex',
    createChatSseState(),
  )
  assert.equal(out, null)
})

test('stateless output_item.done returns null while stateless arguments.done still emits', () => {
  const itemDone = responsesSseToChatChunk(
    'data: {"type":"response.output_item.done","output_index":0,"item_id":"fc_0","item":{"type":"function_call","id":"fc_0","call_id":"call_a","name":"bash","arguments":"{\\"x\\":1}"}}',
  )
  assert.equal(itemDone, null)
  const done = responsesSseToChatChunk(
    'data: {"type":"response.function_call_arguments.done","output_index":0,"item_id":"fc_0","arguments":"{\\"x\\":1}"}',
  )
  const parsed = JSON.parse(done.trim().slice(5))
  const calls = parsed.choices[0].delta.tool_calls
  assert.equal(calls.length, 2)
  assert.equal(calls[0].function.arguments, '')
  assert.equal(calls[1].function.arguments, '{"x":1}')
})
