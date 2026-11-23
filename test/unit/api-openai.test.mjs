import test from 'node:test'
import assert from 'node:assert/strict'
import {
  claudeToOpenAIChatRequest,
  claudeToOpenAIResponsesRequest,
  openaiChatToClaudeMessage,
} from '../../src/lib/pool/api-openai.mjs'

test('claude request becomes openai responses for official hop', () => {
  const out = claudeToOpenAIResponsesRequest({
    model: 'gpt-5.6-sol',
    system: 'hi',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(out.model, 'gpt-5.6-sol')
  assert.equal(out.input[0].role, 'developer')
  assert.equal(out.input[1].role, 'user')
  assert.equal(out.input[1].content[0].type, 'input_text')
  assert.equal(out.input[1].content[0].text, 'hello')
  assert.equal(out.max_output_tokens, 16)
  assert.equal(out.messages, undefined)
})

test('claude forced tool becomes responses tool_choice.name', () => {
  const out = claudeToOpenAIResponsesRequest({
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'tool', name: 'get_weather' },
  })
  assert.equal(out.tools[0].name, 'get_weather')
  assert.deepEqual(out.tool_choice, { type: 'function', name: 'get_weather' })
})

test('claude tool loop becomes function_call and function_call_output items', () => {
  const out = claudeToOpenAIResponsesRequest({
    model: 'gpt-5.6-sol',
    system: 'hi',
    messages: [
      { role: 'user', content: '查北京天气' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_abc', name: 'get_weather', input: { city: '北京' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_abc', content: '晴，零下2度' }],
      },
    ],
    tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
  })
  const types = out.input.map((item) => item.type)
  assert.deepEqual(types, ['message', 'message', 'function_call', 'function_call_output'])
  assert.equal(out.input[0].role, 'developer')
  assert.equal(out.input[1].role, 'user')
  const fc = out.input[2]
  assert.equal(fc.call_id, 'call_abc')
  assert.equal(fc.name, 'get_weather')
  assert.equal(fc.arguments, '{"city":"北京"}')
  const fo = out.input[3]
  assert.equal(fo.call_id, 'call_abc')
  assert.equal(fo.output, '晴，零下2度')
})

test('claude assistant text+tool turn keeps both items; empty text emits no message item', () => {
  const withText = claudeToOpenAIResponsesRequest({
    model: 'gpt-5.6-sol',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我查一下' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '晴' }] },
    ],
  })
  assert.deepEqual(
    withText.input.map((i) => i.type),
    ['message', 'message', 'function_call', 'function_call_output'],
  )
  const toolOnly = claudeToOpenAIResponsesRequest({
    model: 'gpt-5.6-sol',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '晴' }] },
    ],
  })
  // tool-only assistant turn: no empty assistant message item
  assert.deepEqual(
    toolOnly.input.map((i) => i.type),
    ['message', 'function_call', 'function_call_output'],
  )
})

test('claude request becomes openai chat', () => {
  const out = claudeToOpenAIChatRequest({
    model: 'gpt-4o',
    system: 'hi',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(out.model, 'gpt-4o')
  assert.equal(out.messages[0].role, 'system')
  assert.equal(out.messages[1].content, 'hello')
  assert.equal(out.stream, true)
})

test('openai chat becomes claude message', () => {
  const msg = openaiChatToClaudeMessage({
    id: 'chatcmpl-1',
    model: 'gpt-4o',
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 1 },
  })
  assert.equal(msg.content[0].text, 'ok')
  assert.equal(msg.stop_reason, 'end_turn')
  assert.equal(msg.usage.input_tokens, 2)
})
