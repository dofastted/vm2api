import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTINUE_USER_TEXT,
  MISSING_TOOL_RESULT_TEXT,
  ensureConversationEndsWithUser,
  ensureOutputConfigSchema,
  flattenSearchResultHistory,
  flattenUndeclaredSearchHistory,
  pairMissingToolResults,
  rectifyUnofficialRequest,
  rectifyUnofficialRequestForRetry,
} from '../../src/lib/protocol/request-rectifier.mjs'
import { prepareAnthropicRequest } from '../../src/lib/protocol/anthropic-policy.mjs'

test('assistant prefill gets a trailing user turn', () => {
  const body = ensureConversationEndsWithUser({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ],
  })
  assert.equal(body.messages.at(-1).role, 'user')
  assert.equal(body.messages.at(-1).content[0].text, CONTINUE_USER_TEXT)
})

test('unpaired tool_use gets a placeholder tool_result', () => {
  const body = pairMissingToolResults({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'run' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} }],
      },
    ],
  })
  assert.equal(body.messages.at(-1).role, 'user')
  assert.equal(body.messages.at(-1).content[0].type, 'tool_result')
  assert.equal(body.messages.at(-1).content[0].tool_use_id, 'toolu_1')
  assert.equal(body.messages.at(-1).content[0].content, MISSING_TOOL_RESULT_TEXT)
})

test('output_config object schema gets additionalProperties=false', () => {
  const body = ensureOutputConfigSchema({
    output_config: {
      format: {
        type: 'json_schema',
        schema: { type: 'object', properties: { name: { type: 'string' } } },
      },
    },
  })
  assert.equal(body.output_config.format.schema.additionalProperties, false)
})

test('unofficial first pass does not invent continue or dummy tool_result', () => {
  const raw = {
    model: 'claude-sonnet-5',
    thinking: { type: 'adaptive' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'prefill' }] },
    ],
  }
  const unofficial = prepareAnthropicRequest(raw, { unofficial: true })
  assert.equal(unofficial.messages.at(-1).role, 'assistant')
  const official = prepareAnthropicRequest(raw, { unofficial: false })
  assert.equal(official.messages.at(-1).role, 'assistant')
})

test('short thinking signatures are stripped as truncated', () => {
  const body = prepareAnthropicRequest({
    model: 'claude-opus-5',
    thinking: { type: 'adaptive' },
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'keep', signature: 'too_short' },
          { type: 'text', text: 'answer' },
        ],
      },
    ],
  })
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'answer' }])
})

test('rectifyUnofficialRequest first pass leaves assistant tool_use alone', () => {
  const body = rectifyUnofficialRequest({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_x', name: 'x', input: {} },
          { type: 'text', text: 'done' },
        ],
      },
    ],
  })
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].role, 'assistant')
})

test('replayed web_search history flattens to text with its server_tool_use', () => {
  const body = flattenSearchResultHistory({
    messages: [
      { role: 'user', content: [{ type: 'text', text: '搜索最新公告' }] },
      {
        role: 'assistant',
        content: [
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'anthropic 公告' } },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [
              { type: 'web_search_result', title: 'Anthropic News', url: 'https://a.co/x', encrypted_content: 'AAAA' },
            ],
          },
          { type: 'text', text: '结论' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ],
  })
  const assistant = body.messages[1].content
  assert.equal(assistant.length, 3)
  assert.equal(
    assistant.every((block) => block.type === 'text'),
    true,
  )
  assert.match(assistant[0].text, /\[web search\] anthropic 公告/)
  assert.match(assistant[1].text, /Anthropic News — https:\/\/a\.co\/x/)
  assert.equal(assistant[2].text, '结论')
  assert.equal(JSON.stringify(body).includes('encrypted_content'), false)
  assert.deepEqual(body.messages[2].content, [{ type: 'text', text: '继续' }])
})

test('search_result block with encrypted_content flattens inside a tool_result', () => {
  const body = flattenSearchResultHistory({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [
              {
                type: 'search_result',
                source: 'https://docs.local/a',
                title: 'Doc A',
                content: [{ type: 'text', text: 'body text' }],
                encrypted_content: 'BBBB',
              },
            ],
          },
        ],
      },
    ],
  })
  const toolResult = body.messages[0].content[0]
  assert.equal(toolResult.type, 'tool_result')
  assert.equal(toolResult.tool_use_id, 'toolu_1')
  assert.equal(toolResult.content[0].type, 'text')
  assert.match(toolResult.content[0].text, /\[search result\] Doc A — https:\/\/docs\.local\/a/)
  assert.match(toolResult.content[0].text, /body text/)
})

function serverSearchHistory(tools) {
  return {
    tools,
    messages: [
      { role: 'user', content: [{ type: 'text', text: '查一下' }] },
      {
        role: 'assistant',
        content: [
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'example' } },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [{ type: 'web_search_result', title: 'Ex', url: 'https://ex.co', encrypted_content: 'AAAA' }],
          },
          { type: 'text', text: '结论' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ],
  }
}

test('server search history flattens when tools carry no native web_search (#702)', () => {
  const clientSearch = {
    name: 'web_search',
    description: 'Search the web using a client-side tool',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  }
  for (const tools of [[clientSearch], [], undefined]) {
    const body = flattenUndeclaredSearchHistory(serverSearchHistory(tools))
    const types = body.messages[1].content.map((block) => block.type)
    assert.deepEqual(types, ['text', 'text', 'text'])
    assert.match(body.messages[1].content[0].text, /\[web search\] example/)
    assert.equal(body.tools, tools)
  }
})

test('first-pass rectifier flattens undeclared server search history', () => {
  const body = rectifyUnofficialRequest(serverSearchHistory([]))
  assert.deepEqual(
    body.messages[1].content.map((block) => block.type),
    ['text', 'text', 'text'],
  )
})

test('server search history stays when native web_search is declared', () => {
  const body = serverSearchHistory([{ type: 'web_search_20250305', name: 'web_search' }])
  assert.equal(flattenUndeclaredSearchHistory(body), body)
  assert.deepEqual(rectifyUnofficialRequest(body), body)
})
test('clean bodies and citation-only search_result are left untouched', () => {
  const clean = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} }],
      },
    ],
  }
  assert.equal(flattenSearchResultHistory(clean), clean)

  const rag = {
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'search_result',
            source: 'https://docs.local/a',
            title: 'Doc A',
            content: [{ type: 'text', text: 'body' }],
            citations: { enabled: true },
          },
        ],
      },
    ],
  }
  assert.equal(flattenSearchResultHistory(rag), rag)
})

test('retry rectifier pairs tools then ends on user', () => {
  const body = rectifyUnofficialRequestForRetry({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_x', name: 'x', input: {} },
          { type: 'text', text: 'done' },
        ],
      },
    ],
  })
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[1].role, 'user')
  assert.equal(body.messages[1].content[0].tool_use_id, 'toolu_x')
})
