import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeAntigravityRequest,
  renderAntigravityResponse,
  antigravityUsageForProtocol,
  createAntigravityProtocolStream,
} from '../../src/lib/protocol/antigravity-convert.mjs'
import { createAntigravityUpstream } from '../../scripts/antigravity-upstream.mjs'

const model = 'gemini-test'
const weather = {
  name: 'weather',
  description: 'Weather in a city',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}
const call = { type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'Paris' } }
const toolResult = { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: '18C' }] }
const usage = {
  input_tokens: 20,
  output_tokens: 8,
  cache_read_input_tokens: 10,
  cache_creation_input_tokens: 3,
  thinking_tokens: 2,
}

function events(value) {
  return value
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split('\n')
      const data = lines.find((line) => line.startsWith('data: '))?.slice(6)
      return data === '[DONE]' ? '[DONE]' : JSON.parse(data)
    })
}

test('Anthropic system, tool history, images and signatures remain structured', () => {
  const body = {
    model,
    system: [{ type: 'text', text: 'Keep the result factual' }],
    messages: [
      { role: 'user', content: 'Paris weather?' },
      { role: 'assistant', content: [{ ...call, thought_signature: 'opaque-signature==' }] },
      {
        role: 'user',
        content: [toolResult, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
      },
    ],
    tools: [weather],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    max_tokens: 100,
    temperature: 0.2,
    output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
  }
  const copied = structuredClone(body)
  const out = normalizeAntigravityRequest('anthropic.messages', body)
  assert.equal(out.ok, true)
  assert.deepEqual(out.request.system, body.system)
  assert.equal(out.request.messages[1].content[0].thought_signature, 'opaque-signature==')
  assert.deepEqual(out.request.messages[2].content[0], toolResult)
  assert.equal(out.request.messages[2].content[1].source.data, 'AAAA')
  assert.deepEqual(out.request.tools, [weather])
  assert.equal(out.request.max_tokens, 100)
  assert.equal(out.request.temperature, 0.2)
  assert.deepEqual(out.request.response_format, body.output_config.format)
  assert.deepEqual(body, copied)
})

test('Chat imports developer, assistant function calls and user tool results without flattening', () => {
  const out = normalizeAntigravityRequest('openai.chat', {
    model,
    messages: [
      { role: 'developer', content: 'Do not invent the weather' },
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Paris"}' },
            thought_signature: 'signature',
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '18C' },
    ],
    tools: [{ type: 'function', function: { name: 'weather', parameters: weather.input_schema } }],
    tool_choice: { type: 'function', function: { name: 'weather' } },
    parallel_tool_calls: false,
    max_completion_tokens: 200,
    response_format: { type: 'json_object' },
  })
  assert.equal(out.ok, true)
  assert.equal(out.request.system[0].text, 'Do not invent the weather')
  assert.deepEqual(out.request.messages[1].content[0], { ...call, thought_signature: 'signature' })
  assert.deepEqual(out.request.messages[2].content[0], toolResult)
  assert.deepEqual(out.request.tool_choice, { type: 'tool', name: 'weather', disable_parallel_tool_use: true })
  assert.equal(out.request.max_tokens, 200)
})

test('Responses preserves full function-call loop, instructions and images', () => {
  const out = normalizeAntigravityRequest('openai.responses', {
    model,
    instructions: 'Answer in one sentence',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'weather', arguments: '{"city":"Paris"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '18C' },
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
    ],
    tools: [{ type: 'function', name: weather.name, parameters: weather.input_schema }],
    tool_choice: 'auto',
    max_output_tokens: 200,
    text: { format: { type: 'json_schema', name: 'weather', schema: { type: 'object' }, strict: true } },
  })
  assert.equal(out.ok, true)
  assert.deepEqual(out.request.system, [{ type: 'text', text: 'Answer in one sentence' }])
  assert.deepEqual(out.request.messages[1].content, [call])
  assert.deepEqual(out.request.messages[2].content[0], toolResult)
  assert.equal(out.request.messages[2].content[1].type, 'image')
  assert.equal(out.request.response_format.name, 'weather')
})

test('Responses continuation accepts only explicitly resolved history and does not inherit old instructions', () => {
  const prior = [
    { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
    { role: 'assistant', content: [call] },
  ]
  const body = {
    model,
    previous_response_id: 'resp_private',
    input: [{ type: 'function_call_output', call_id: 'call_1', output: '18C' }],
  }
  assert.equal(normalizeAntigravityRequest('openai.responses', body).code, 'previous_response_not_found')
  const out = normalizeAntigravityRequest('openai.responses', body, { previousMessages: prior })
  assert.equal(out.ok, true)
  assert.equal(out.request.messages.length, 3)
  assert.deepEqual(out.request.system, [])
  assert.deepEqual(out.request.messages[2].content, [toolResult])
  assert.equal('previous_response_id' in out.request, false)
})

test('Responses include tolerates reasoning.encrypted_content and rejects anything else', () => {
  const body = (include) => ({ model, input: 'hi', include })
  assert.equal(normalizeAntigravityRequest('openai.responses', body(['reasoning.encrypted_content'])).ok, true)
  const rejected = normalizeAntigravityRequest(
    'openai.responses',
    body(['reasoning.encrypted_content', 'message.output_text.logprobs']),
  )
  assert.equal(rejected.code, 'antigravity_feature_not_supported')
  assert.match(rejected.message, /message\.output_text\.logprobs/)
  assert.doesNotMatch(rejected.message, /encrypted_content/)
})

test('orphan, duplicate and malformed tool calls fail instead of fabricating a request', () => {
  assert.equal(
    normalizeAntigravityRequest('anthropic.messages', { model, messages: [{ role: 'user', content: [toolResult] }] })
      .code,
    'invalid_tool_history',
  )
  assert.equal(
    normalizeAntigravityRequest('anthropic.messages', {
      model,
      messages: [{ role: 'assistant', content: [call, call] }],
    }).code,
    'invalid_tool_history',
  )
  const bad = normalizeAntigravityRequest('openai.chat', {
    model,
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{broken' } }],
      },
    ],
  })
  assert.equal(bad.code, 'invalid_tool_arguments')
  assert.equal(
    normalizeAntigravityRequest('openai.responses', { model, input: 'hi', tools: [{ type: 'web_search' }] }).code,
    'antigravity_feature_not_supported',
  )
})

test('unknown content, unsafe image schemes and opaque provider state are rejected explicitly', () => {
  for (const block of [
    { type: 'input_audio', input_audio: {} },
    { type: 'file', file: {} },
    { type: 'image_url', image_url: { url: 'file:///etc/passwd' } },
  ]) {
    assert.equal(
      normalizeAntigravityRequest('openai.chat', { model, messages: [{ role: 'user', content: [block] }] }).ok,
      false,
    )
  }
  assert.equal(
    normalizeAntigravityRequest('openai.responses', {
      model,
      input: [{ type: 'reasoning', encrypted_content: 'opaque', summary: [] }],
    }).code,
    'antigravity_feature_not_supported',
  )
  assert.equal(
    normalizeAntigravityRequest('openai.chat', { model, messages: [{ role: 'user', content: 'hi' }], n: 2 }).code,
    'antigravity_feature_not_supported',
  )
  assert.equal(
    normalizeAntigravityRequest('openai.responses', { model, input: 'hi', background: true }).code,
    'antigravity_feature_not_supported',
  )
})

test('usage uses disjoint Anthropic cache tokens and never adds cache twice', () => {
  assert.deepEqual(antigravityUsageForProtocol('anthropic.messages', usage), {
    input_tokens: 20,
    output_tokens: 8,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 3,
  })
  const chat = antigravityUsageForProtocol('openai.chat', usage)
  assert.equal(chat.prompt_tokens, 33)
  assert.equal(chat.total_tokens, 41)
  assert.equal(chat.prompt_tokens_details.cached_tokens, 10)
  assert.equal(chat.completion_tokens_details.reasoning_tokens, 2)
  const responses = antigravityUsageForProtocol('openai.responses', usage)
  assert.equal(responses.input_tokens, 33)
  assert.equal(responses.output_tokens, 8)
  assert.equal(antigravityUsageForProtocol('openai.chat', null), null)
  assert.equal(antigravityUsageForProtocol('anthropic.messages', {}), null)
  assert.deepEqual(antigravityUsageForProtocol('openai.responses', { input_tokens: 0, output_tokens: 0 }), {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  })
})

test('tool-only replies produce tool_calls and Responses function_call with stable call_id', () => {
  const result = { ok: true, content: [call], stop_reason: 'tool_use', usage }
  const chat = renderAntigravityResponse('openai.chat', result, { id: 'chat_1', model, created: 1 })
  assert.equal(chat.choices[0].finish_reason, 'tool_calls')
  assert.equal(chat.choices[0].message.content, null)
  assert.equal(chat.choices[0].message.tool_calls[0].function.arguments, '{"city":"Paris"}')
  const response = renderAntigravityResponse('openai.responses', result, { id: 'resp_1', model, created: 1 })
  assert.equal(response.status, 'completed')
  assert.equal(response.output.length, 1)
  assert.equal(response.output[0].type, 'function_call')
  assert.equal(response.output[0].call_id, 'call_1')
  assert.equal(response.output[0].id, 'resp_1_item_0')
  assert.equal(response.output_text, '')
})

test('Responses token-limit termination is incomplete rather than completed', () => {
  const result = { ok: true, content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens', usage: null }
  const response = renderAntigravityResponse('openai.responses', result, { model })
  assert.equal(response.status, 'incomplete')
  assert.deepEqual(response.incomplete_details, { reason: 'max_output_tokens' })
  assert.equal(response.usage, null)
})

test('Anthropic stream carries text, tool JSON, stop reason and final usage', () => {
  const stream = createAntigravityProtocolStream('anthropic.messages', { id: 'msg_1', model })
  const wire =
    stream.push({ type: 'text_delta', text: 'Checking. ' }) +
    stream.push(call) +
    stream.finish({ ok: true, content: [{ type: 'text', text: 'Checking. ' }, call], stop_reason: 'tool_use', usage })
  const all = events(wire)
  assert.deepEqual(
    all.map((event) => event.type),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ],
  )
  assert.equal(all[0].message.id, 'msg_1')
  assert.equal(all[4].content_block.name, 'weather')
  assert.equal(all[5].delta.partial_json, '{"city":"Paris"}')
  assert.equal(all[7].delta.stop_reason, 'tool_use')
  assert.equal(all[7].usage.input_tokens, 20)
})

test('Chat streaming separates content, reasoning, tool calls and opt-in usage', () => {
  const stream = createAntigravityProtocolStream('openai.chat', { id: 'chat_1', model, includeUsage: true, created: 1 })
  const result = {
    ok: true,
    content: [{ type: 'thinking', thinking: 'Need weather' }, { type: 'text', text: 'Checking.' }, call],
    stop_reason: 'tool_use',
    usage,
  }
  const wire =
    stream.push({ type: 'thinking_delta', thinking: 'Need weather' }) +
    stream.push({ type: 'text_delta', text: 'Checking.' }) +
    stream.push(call) +
    stream.finish(result)
  const all = events(wire)
  assert.equal(all[0].choices[0].delta.role, 'assistant')
  assert.equal(all[1].choices[0].delta.reasoning_content, 'Need weather')
  assert.equal(all[2].choices[0].delta.content, 'Checking.')
  assert.equal(all[3].choices[0].delta.tool_calls[0].function.name, 'weather')
  assert.equal(all[4].choices[0].delta.tool_calls[0].function.arguments, '{"city":"Paris"}')
  assert.equal(all[5].choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(all[6].choices, [])
  assert.equal(all[6].usage.prompt_tokens, 33)
  assert.equal(all[7], '[DONE]')
})

test('Responses stream sends complete output-item lifecycle and final output for text and tools', () => {
  const stream = createAntigravityProtocolStream('openai.responses', { id: 'resp_1', model, created: 1 })
  const result = { ok: true, content: [{ type: 'text', text: 'Checking.' }, call], stop_reason: 'tool_use', usage }
  const all = events(stream.push({ type: 'text_delta', text: 'Checking.' }) + stream.push(call) + stream.finish(result))
  assert.equal(all[0].type, 'response.created')
  assert.equal(all[1].type, 'response.in_progress')
  assert.equal(all[2].type, 'response.output_item.added')
  assert.equal(all[3].type, 'response.content_part.added')
  assert.equal(all[4].type, 'response.output_text.delta')
  assert.equal(all[5].type, 'response.output_text.done')
  assert.equal(all[6].type, 'response.content_part.done')
  assert.equal(all[7].type, 'response.output_item.done')
  assert.equal(all[8].type, 'response.output_item.added')
  assert.equal(all[8].item.type, 'function_call')
  assert.equal(all[8].item.call_id, 'call_1')
  assert.equal(all[9].type, 'response.function_call_arguments.delta')
  assert.equal(all[10].type, 'response.function_call_arguments.done')
  assert.equal(all[11].type, 'response.output_item.done')
  assert.equal(all[12].type, 'response.completed')
  assert.deepEqual(
    all[12].response.output,
    renderAntigravityResponse('openai.responses', result, { id: 'resp_1', model, created: 1 }).output,
  )
  assert.deepEqual(
    all.map((event) => event.sequence_number),
    all.map((_, index) => index),
  )
})

test('canonical tool arguments deltas validate JSON before reporting terminal success', () => {
  const stream = createAntigravityProtocolStream('openai.responses', { id: 'resp_1', model })
  let wire = stream.push({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'call_1', name: 'weather', input: {} },
  })
  wire += stream.push({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"city":' },
  })
  wire += stream.push({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '"Paris"}' },
  })
  wire += stream.push({ type: 'content_block_stop', index: 0 })
  wire += stream.finish({ ok: true, content: [call], stop_reason: 'tool_use', usage })
  assert.equal(events(wire).at(-1).type, 'response.completed')
  const bad = createAntigravityProtocolStream('anthropic.messages', { model })
  bad.push({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'call_1', name: 'weather', input: {} },
  })
  bad.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{broken' } })
  assert.throws(() => bad.push({ type: 'content_block_stop', index: 0 }), /valid JSON/)
})

test('mid-stream failure never emits a completed event or success terminator', () => {
  for (const protocol of ['anthropic.messages', 'openai.chat', 'openai.responses']) {
    const stream = createAntigravityProtocolStream(protocol, { model })
    const wire =
      stream.push({ type: 'text_delta', text: 'partial' }) +
      stream.error({ code: 'client_cancelled', message: 'Cancelled' })
    assert.doesNotMatch(wire, /message_stop|response.completed|\[DONE\]/)
    assert.match(wire, /client_cancelled/)
    assert.equal(stream.finish({ ok: true, content: [{ type: 'text', text: 'partial' }] }), '')
  }
})

test('a final text mismatch produces an error and cannot masquerade as a complete result', () => {
  const stream = createAntigravityProtocolStream('openai.responses', { model })
  let wire = stream.push({ type: 'text_delta', text: 'partial' })
  assert.throws(() => stream.finish({ ok: true, content: [{ type: 'text', text: 'different' }], usage }), {
    code: 'antigravity_stream_mismatch',
  })
  wire += stream.error({ code: 'antigravity_stream_mismatch', message: 'Content mismatch' })
  assert.equal(events(wire).at(-1).type, 'response.failed')
  assert.match(wire, /antigravity_stream_mismatch/)
  assert.doesNotMatch(wire, /response.completed/)
})

test('non-streaming upstream results can be serialized as a complete stream', () => {
  const result = { ok: true, content: [{ type: 'text', text: 'Hello' }], usage, stop_reason: 'end_turn' }
  const wire = createAntigravityProtocolStream('openai.responses', { model }).finish(result)
  assert.equal(events(wire).at(-1).type, 'response.completed')
  assert.match(wire, /response.output_text.delta/)
})

test('canonical signatures survive text block normalization without control characters', () => {
  const out = normalizeAntigravityRequest('anthropic.messages', {
    model,
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'Prior response', thoughtSignature: 'opaque_A-B/==' }] },
      { role: 'user', content: 'continue' },
    ],
  })
  assert.equal(out.request.messages[0].content[0].thought_signature, 'opaque_A-B/==')
  const bad = normalizeAntigravityRequest('anthropic.messages', {
    model,
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'Prior response', thought_signature: 'bad\nvalue' }] },
    ],
  })
  assert.equal(bad.ok, false)
})

test('all JSON schema request dialects normalize to one structured format', () => {
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
  const expected = { type: 'json_schema', name: 'answer', strict: true, schema }
  const chat = normalizeAntigravityRequest('openai.chat', {
    model,
    messages: [{ role: 'user', content: 'answer' }],
    response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } },
  })
  const responses = normalizeAntigravityRequest('openai.responses', {
    model,
    input: 'answer',
    text: { format: { type: 'json_schema', name: 'answer', strict: true, schema } },
  })
  assert.deepEqual(chat.request.response_format, expected)
  assert.deepEqual(responses.request.response_format, expected)
  assert.equal(
    normalizeAntigravityRequest('openai.responses', {
      model,
      input: 'answer',
      text: { format: { type: 'json_schema' } },
    }).ok,
    false,
  )
})

test('canonical content starts with initial content deliver it to every streaming protocol', () => {
  const result = { ok: true, content: [{ type: 'text', text: 'Initial text' }, call], stop_reason: 'tool_use', usage }
  for (const protocol of ['anthropic.messages', 'openai.chat', 'openai.responses']) {
    const stream = createAntigravityProtocolStream(protocol, { model })
    let wire = stream.push({ type: 'content_block_start', index: 0, content_block: result.content[0] })
    wire += stream.push({ type: 'content_block_stop', index: 0 })
    wire += stream.push({ type: 'content_block_start', index: 1, content_block: call })
    wire += stream.push({ type: 'content_block_stop', index: 1 })
    wire += stream.finish(result)
    assert.match(wire, /Initial text/)
    assert.match(wire, /Paris/)
    assert.doesNotMatch(wire, /antigravity_stream_mismatch/)
    if (protocol === 'openai.chat') assert.equal(events(wire).at(-1), '[DONE]')
    if (protocol === 'openai.responses') assert.equal(events(wire).at(-1).type, 'response.completed')
  }
})

test('generation controls and tool selection reject invalid values before an upstream attempt', () => {
  const body = { model, messages: [{ role: 'user', content: 'weather?' }], tools: [weather] }
  for (const patch of [
    { temperature: -1 },
    { top_p: 2 },
    { top_k: 1.2 },
    { max_tokens: 0 },
    { stop: [''] },
    { tool_choice: { type: 'tool', name: 'undeclared' } },
    { parallel_tool_calls: 'yes' },
  ])
    assert.equal(normalizeAntigravityRequest('anthropic.messages', { ...body, ...patch }).ok, false)
  assert.equal(
    normalizeAntigravityRequest('openai.completions', { model, prompt: 'weather?', tools: [weather] }).code,
    'antigravity_feature_not_supported',
  )
})

test('provider tool signatures survive Chat streams and Responses output replay', () => {
  const signedCall = { ...call, thought_signature: 'opaque-tool-signature==' }
  const stream = createAntigravityProtocolStream('openai.chat', { model })
  const wire =
    stream.push(signedCall) + stream.finish({ ok: true, content: [signedCall], stop_reason: 'tool_use', usage })
  const advertised = events(wire).find((event) => event.choices?.[0]?.delta?.tool_calls?.[0]?.id)
  assert.equal(advertised.choices[0].delta.tool_calls[0].thought_signature, signedCall.thought_signature)
  const output = renderAntigravityResponse(
    'openai.responses',
    { ok: true, content: [signedCall], usage },
    { model },
  ).output
  const replay = normalizeAntigravityRequest('openai.responses', {
    model,
    input: [...output, { type: 'function_call_output', call_id: 'call_1', output: '18C' }],
  })
  assert.equal(replay.ok, true)
  assert.equal(replay.request.messages[0].content[0].thought_signature, signedCall.thought_signature)
})

test('terminal-only text signatures enrich metadata without changing content or failing successful streams', () => {
  for (const protocol of ['anthropic.messages', 'openai.chat', 'openai.responses']) {
    const stream = createAntigravityProtocolStream(protocol, { model })
    let wire = stream.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    wire += stream.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } })
    wire += stream.push({ type: 'thought_signature', index: 0, signature: 'terminal-signature==' })
    assert.equal(stream.push({ type: 'thought_signature', index: 0, signature: 'terminal-signature==' }), '')
    wire += stream.push({ type: 'content_block_stop', index: 0 })
    wire += stream.finish({
      ok: true,
      content: [{ type: 'text', text: 'OK', thought_signature: 'terminal-signature==' }],
      stop_reason: 'end_turn',
      usage,
    })
    assert.match(wire, /terminal-signature==/)
    assert.doesNotMatch(wire, /antigravity_stream_mismatch/)
    if (protocol === 'openai.responses')
      assert.equal(events(wire).at(-1).response.output[0].content[0].thought_signature, 'terminal-signature==')
    if (protocol === 'anthropic.messages') assert.equal(events(wire).at(-1).type, 'message_stop')
    if (protocol === 'openai.chat') assert.equal(events(wire).at(-1), '[DONE]')
  }
})

test('late tool signatures are accepted after block stop, while missing/conflicting signatures fail', () => {
  const stream = createAntigravityProtocolStream('openai.chat', { model })
  let wire = stream.push(call)
  wire += stream.push({ type: 'thought_signature', index: 0, signature: 'tool-sig==' })
  wire += stream.finish({
    ok: true,
    content: [{ ...call, thought_signature: 'tool-sig==' }],
    stop_reason: 'tool_use',
    usage,
  })
  assert.equal(
    events(wire).find((event) => event.choices?.[0]?.delta?.tool_calls?.[0]?.thought_signature)?.choices[0].delta
      .tool_calls[0].thought_signature,
    'tool-sig==',
  )
  const missing = createAntigravityProtocolStream('openai.chat', { model })
  assert.throws(() => missing.push({ type: 'thought_signature', index: 0, signature: 'sig' }), /missing content block/)
  missing.push({ type: 'text_delta', text: 'OK' })
  missing.push({ type: 'thought_signature', index: 0, signature: 'sig1' })
  assert.throws(
    () => missing.push({ type: 'thought_signature', index: 0, signature: 'sig2' }),
    /conflicting thought signatures/,
  )
})

test('thinking thought_signature event uses a standard signature_delta while the block is open', () => {
  const stream = createAntigravityProtocolStream('anthropic.messages', { model })
  let wire = stream.push({ type: 'thinking_delta', thinking: 'Reasoning summary' })
  wire += stream.push({ type: 'thought_signature', index: 0, signature: 'thinking-sig==' })
  wire += stream.finish({
    ok: true,
    content: [{ type: 'thinking', thinking: 'Reasoning summary', signature: 'thinking-sig==' }],
    stop_reason: 'end_turn',
    usage,
  })
  assert.equal(events(wire).find((event) => event.delta?.type === 'signature_delta')?.delta.signature, 'thinking-sig==')
  assert.equal(events(wire).at(-1).type, 'message_stop')
})

test('native Google terminal signature events complete successfully through all public stream adapters', async () => {
  for (const protocol of ['anthropic.messages', 'openai.chat', 'openai.responses']) {
    const upstream = createAntigravityUpstream(
      { models: ['native-model'] },
      {
        readToken: () => ({ access_token: 'test-token', expiry: '2999-01-01T00:00:00Z' }),
        loadProject: async () => 'test-project',
        fetch: async () =>
          new Response(
            [
              { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'OK' }] } }] },
              {
                candidates: [
                  {
                    index: 0,
                    content: { role: 'model', parts: [{ thoughtSignature: 'c2lnbmF0dXJl', text: '' }] },
                    finishReason: 'STOP',
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 20,
                  cachedContentTokenCount: 4,
                  candidatesTokenCount: 3,
                  thoughtsTokenCount: 2,
                  totalTokenCount: 25,
                },
              },
            ]
              .map((event) => `data: ${JSON.stringify({ response: event })}\n\n`)
              .join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      },
    )
    const stream = createAntigravityProtocolStream(protocol, { model: 'native-model', includeUsage: true })
    let wire = ''
    const result = await upstream.infer(
      { model: 'native-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      {
        onEvent: (event) => {
          wire += stream.push(event)
        },
      },
    )
    assert.equal(result.ok, true)
    assert.deepEqual(result.content, [{ type: 'text', text: 'OK', thought_signature: 'c2lnbmF0dXJl' }])
    wire += stream.finish(result)
    assert.doesNotMatch(wire, /stream_mismatch|response.failed|"type":"error"/)
    const all = events(wire)
    const actualUsage =
      protocol === 'anthropic.messages'
        ? all.find((event) => event.type === 'message_delta').usage
        : protocol === 'openai.responses'
          ? all.at(-1).response.usage
          : all.find((event) => event.choices?.length === 0).usage
    assert.equal(
      protocol === 'anthropic.messages'
        ? actualUsage.input_tokens
        : protocol === 'openai.responses'
          ? actualUsage.input_tokens
          : actualUsage.prompt_tokens,
      protocol === 'anthropic.messages' ? 16 : 20,
    )
    assert.equal(protocol === 'openai.chat' ? actualUsage.completion_tokens : actualUsage.output_tokens, 5)
    upstream.close()
  }
})

test('native function-call signatures replay through Chat into a matching native function response', async () => {
  const nativeRequests = []
  let turn = 0
  const upstream = createAntigravityUpstream(
    { models: ['native-model'] },
    {
      readToken: () => ({ access_token: 'test-token', expiry: '2999-01-01T00:00:00Z' }),
      loadProject: async () => 'test-project',
      fetch: async (_url, options) => {
        nativeRequests.push(JSON.parse(options.body).request)
        turn++
        const parts =
          turn === 1
            ? [
                {
                  functionCall: { id: 'call_weather', name: 'weather', args: { city: 'Paris' } },
                  thoughtSignature: 'dG9vbC1zaWc=',
                },
              ]
            : [{ text: '18C' }]
        return new Response(
          `data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } } })}\n\n`,
        )
      },
    },
  )
  const initial = {
    model: 'native-model',
    messages: [{ role: 'user', content: 'Paris weather?' }],
    tools: [{ type: 'function', function: { name: 'weather', parameters: weather.input_schema } }],
  }
  const request = normalizeAntigravityRequest('openai.chat', initial).request
  const first = await upstream.infer(request)
  assert.equal(first.ok, true)
  const chat = renderAntigravityResponse('openai.chat', first, { model: 'native-model' })
  assert.equal(chat.choices[0].finish_reason, 'tool_calls')
  const continuation = normalizeAntigravityRequest('openai.chat', {
    ...initial,
    messages: [
      ...initial.messages,
      chat.choices[0].message,
      { role: 'tool', tool_call_id: 'call_weather', content: '18C' },
    ],
  })
  assert.equal(continuation.ok, true)
  const second = await upstream.infer(continuation.request)
  assert.equal(second.ok, true)
  const nativeCall = nativeRequests[1].contents[1].parts[0]
  const nativeResult = nativeRequests[1].contents[2].parts[0]
  assert.equal(nativeCall.thoughtSignature, 'dG9vbC1zaWc=')
  assert.equal(nativeCall.functionCall.id, 'call_weather')
  assert.equal(nativeResult.functionResponse.id, 'call_weather')
  assert.equal(nativeResult.functionResponse.name, 'weather')
  assert.equal(nativeResult.functionResponse.response.result, '18C')
  upstream.close()
})
