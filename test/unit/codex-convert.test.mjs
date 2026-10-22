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

test('parallel done-only tools retain complete JSON, stable indexes and one terminal frame', () => {
  const state = createChatSseState()
  const items = [0, 1].map((index) => ({
    type: 'function_call',
    id: `fc_${index}`,
    call_id: `call_${index}`,
    name: 'edit',
    arguments: JSON.stringify({ path: `${index}.txt`, text: '你好' }),
  }))
  const events = [
    ...items.map((item, index) => ({
      type: 'response.output_item.added',
      output_index: index,
      item: { ...item, arguments: '' },
    })),
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_0', arguments: items[0].arguments },
    { type: 'response.output_item.done', output_index: 1, item: items[1] },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: items[0].arguments },
    { type: 'response.completed', response: { output: items } },
  ]
  const output = events
    .map((event) => responsesSseToChatChunk(`data: ${JSON.stringify(event)}`, 'codex', state) || '')
    .join('')
  const chunks = output
    .split('\n\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)))
  const calls = chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls || [])
  for (let index = 0; index < items.length; index++) {
    const tool = calls.filter((call) => call.index === index)
    assert.equal(tool.filter((call) => call.type === 'function').length, 1)
    assert.deepEqual(
      JSON.parse(tool.map((call) => call.function?.arguments || '').join('')),
      JSON.parse(items[index].arguments),
    )
  }
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls')
  assert.equal(responsesSseToChatChunk('data: [DONE]', 'codex', state), null)
})

test('done only appends missing suffix and rejects a conflicting streamed prefix', () => {
  const state = createChatSseState()
  responsesSseToChatChunk(
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_a","id":"fc_a","name":"edit"}}',
    'codex',
    state,
  )
  responsesSseToChatChunk(
    `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{"path":' })}`,
    'codex',
    state,
  )
  const full = { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"path":"a.txt"}' }
  const tail = responsesSseToChatChunk(`data: ${JSON.stringify(full)}`, 'codex', state)
  assert.equal(JSON.parse(tail.slice(6)).choices[0].delta.tool_calls[0].function.arguments, '"a.txt"}')
  assert.equal(responsesSseToChatChunk(`data: ${JSON.stringify(full)}`, 'codex', state), null)
  assert.throws(
    () =>
      responsesSseToChatChunk(
        `data: ${JSON.stringify({ ...full, arguments: '{"path":"other.txt"}' })}`,
        'codex',
        state,
      ),
    { code: 'tool_arguments_mismatch' },
  )
})

test('non-stream Anthropic conversion accepts object arguments and rejects non-object JSON', () => {
  const call = { type: 'function_call', call_id: 'call_a', name: 'edit' }
  const ok = codexBodyToAnthropicMessage({ output: [{ ...call, arguments: { path: 'a.txt' } }] })
  assert.deepEqual(ok.content[0].input, { path: 'a.txt' })
  for (const bad of ['{"path":', '[1]', '"text"']) {
    assert.throws(() => codexBodyToAnthropicMessage({ output: [{ ...call, arguments: bad }] }), {
      code: 'tool_arguments_invalid',
    })
  }
})

test('completed snapshots recover unregistered function and custom calls in every output shape', () => {
  const output = [
    { type: 'function_call', call_id: 'call_a', id: 'fc_a', name: 'edit', arguments: '{"path":"a.txt"}' },
    { type: 'custom_tool_call', call_id: 'call_b', id: 'ct_b', name: 'patch', input: '*** Begin Patch\n你好' },
  ]
  const completed = `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_a', output } })}`
  const chat = responsesSseToChatChunk(completed, 'codex', createChatSseState())
  const chunk = JSON.parse(chat.split('\n\n')[0].slice(6))
  const calls = chunk.choices[0].delta.tool_calls
  assert.equal(calls.find((call) => call.index === 0 && !call.type).function.arguments, output[0].arguments)
  assert.equal(calls.find((call) => call.index === 1 && !call.type).function.arguments, output[1].input)
  const assembled = assembleCodexBodyFromSse([completed])
  assert.deepEqual(assembled.output, output)
  const message = codexBodyToAnthropicMessage(assembled)
  assert.equal(message.stop_reason, 'tool_use')
  assert.deepEqual(
    message.content.map((block) => block.input),
    [{ path: 'a.txt' }, { input: output[1].input }],
  )
  const anthropic = responsesSseToAnthropicEvents(completed, createAnthropicSseState())
  const frames = anthropic
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
  assert.deepEqual(
    frames.filter((frame) => frame.type === 'content_block_start').map((frame) => frame.content_block.type),
    ['tool_use', 'tool_use'],
  )
  for (let index = 0; index < 2; index++) {
    const args = frames
      .filter((frame) => frame.index === index && frame.delta?.type === 'input_json_delta')
      .map((frame) => frame.delta.partial_json)
      .join('')
    assert.deepEqual(JSON.parse(args), message.content[index].input)
    assert.equal(frames.filter((frame) => frame.type === 'content_block_stop' && frame.index === index).length, 1)
  }
  assert.equal(frames.find((frame) => frame.type === 'message_delta').delta.stop_reason, 'tool_use')
})

test('official Codex passthrough keeps instructions/input/cache/session fields intact', () => {
  const input = {
    model: 'gpt-5.5',
    instructions: 'You are Codex, a coding agent.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
    reasoning: { effort: 'high' },
    service_tier: 'priority',
    max_output_tokens: 8192,
    temperature: 0.2,
    prompt_cache_key: 'caller-session-key',
    previous_response_id: 'resp_123',
    conversation_id: 'conv_123',
    session_id: 'sess_123',
    metadata: { user_id: 'caller-user', topic: 'keep' },
    store: false,
  }
  const out = toCodexResponses('openai.responses', input, {}, { officialPassthrough: true })
  assert.equal(out.ok, true)
  assert.equal(out.converted, false)
  assert.deepEqual(out.body, input, 'official body must be preserved field-for-field')
})

test('official Codex passthrough still strips credentials', () => {
  const out = toCodexResponses(
    'openai.responses',
    { model: 'gpt-5.5', input: [], api_key: 'sk-live', authorization: 'Bearer x', client_metadata: { x: 1 } },
    {},
    { officialPassthrough: true },
  )
  assert.equal(out.body.api_key, undefined)
  assert.equal(out.body.authorization, undefined)
  assert.equal(out.body.client_metadata, undefined)
})
