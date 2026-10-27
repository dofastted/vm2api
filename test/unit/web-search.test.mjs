import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CLAUDE_WEB_SEARCH_TOOL,
  dropWebSearchFlag,
  ensureClaudeWebSearch,
  hasClaudeWebSearch,
  historyHasWebSearchArtifacts,
  isAnthropicServerTool,
  isWebSearchTool,
  promptRequestsWebSearch,
  sanitizeAnthropicTools,
  shouldInjectClaudeWebSearch,
} from '../../src/lib/protocol/web-search.mjs'
import { officialMessagesBody } from '../../src/lib/protocol/anthropic-messages.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { copyOfficialAnthropicFields } from '../../src/lib/protocol/sanitize.mjs'
import { openaiToolsToClaude, toClaudeMessages } from '../../src/lib/protocol/convert.mjs'
import { rewriteToolNames } from '../../src/lib/protocol/anthropic-policy.mjs'

test('ensureClaudeWebSearch appends native server tool when missing', () => {
  const out = ensureClaudeWebSearch({
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
  })
  assert.equal(out.tools.length, 2)
  assert.deepEqual(out.tools[1], { type: 'web_search_20250305', name: 'web_search', max_uses: 8 })
})

test('ensureClaudeWebSearch is a no-op when search already present', () => {
  const body = {
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  }
  const out = ensureClaudeWebSearch(body)
  assert.equal(out.tools.length, 1)
  assert.equal(out, body)
})

test('ensureClaudeWebSearch respects tool_choice none', () => {
  const out = ensureClaudeWebSearch({ tool_choice: { type: 'none' } })
  assert.equal(out.tools, undefined)
  assert.equal(ensureClaudeWebSearch({ tool_choice: 'none' }).tools, undefined)
})

test('ensureClaudeWebSearch disabled leaves tools unchanged', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }] }
  const out = ensureClaudeWebSearch(body, { enabled: false })
  assert.equal(out, body)
  assert.equal(out.tools, undefined)
})

test('promptRequestsWebSearch matches 搜索 / search / web search only', () => {
  assert.equal(promptRequestsWebSearch('帮我搜索一下天气'), true)
  assert.equal(promptRequestsWebSearch('Please search for the latest news'), true)
  assert.equal(promptRequestsWebSearch('Use web search if needed'), true)
  assert.equal(promptRequestsWebSearch('web-search the docs'), true)
  assert.equal(promptRequestsWebSearch('hello'), false)
  assert.equal(promptRequestsWebSearch('research this paper'), false)
  assert.equal(promptRequestsWebSearch('列出你目前可以调用的所有工具'), false)
})

test('shouldInjectClaudeWebSearch ignores search keywords; false flag always wins', () => {
  const ask = { messages: [{ role: 'user', content: '帮我搜索天气' }] }
  const hello = { messages: [{ role: 'user', content: 'hello' }] }
  assert.equal(shouldInjectClaudeWebSearch({ clientClass: 'hermes', body: hello }), false)
  assert.equal(shouldInjectClaudeWebSearch({ clientClass: 'hermes', body: ask }), false)
  assert.equal(
    shouldInjectClaudeWebSearch({
      headers: { 'user-agent': 'kin-console-test/1.0' },
      body: { messages: [{ role: 'user', content: 'list tools' }] },
    }),
    false,
  )
  assert.equal(shouldInjectClaudeWebSearch({ officialClient: true, body: ask }), false)
  assert.equal(shouldInjectClaudeWebSearch({ clientClass: 'claude_code_official', body: ask }), false)
  assert.equal(shouldInjectClaudeWebSearch({ body: { ...ask, web_search: false } }), false)
  assert.equal(shouldInjectClaudeWebSearch({ body: hello, headers: { 'x-kin-web-search': 'true' } }), true)
  assert.equal(shouldInjectClaudeWebSearch({ body: { ...hello, web_search: true } }), true)
})

test('replayed search history keeps the tool armed on a silent follow-up', () => {
  const followUp = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: '搜索最新公告' }] },
      {
        role: 'assistant',
        content: [
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'news' } },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [{ type: 'web_search_result', title: 'T', url: 'https://a.co', encrypted_content: 'AAAA' }],
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: '继续，压缩成十个字' }] },
    ],
  }
  assert.equal(historyHasWebSearchArtifacts(followUp), true)
  assert.equal(shouldInjectClaudeWebSearch({ clientClass: 'hermes', body: followUp }), true)
  assert.equal(shouldInjectClaudeWebSearch({ body: { ...followUp, web_search: false } }), false)
  assert.equal(shouldInjectClaudeWebSearch({ officialClient: true, body: followUp }), false)

  const plain = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} }] },
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ],
  }
  assert.equal(historyHasWebSearchArtifacts(plain), false)
  assert.equal(shouldInjectClaudeWebSearch({ clientClass: 'hermes', body: plain }), false)
})

test('tool_choice none still skips inject even when search is explicitly on', () => {
  assert.equal(
    shouldInjectClaudeWebSearch({
      body: { messages: [{ role: 'user', content: 'search news' }], tool_choice: { type: 'none' }, web_search: true },
    }),
    true,
  )
  assert.equal(ensureClaudeWebSearch({ tool_choice: { type: 'none' } }, { enabled: true }).tools, undefined)
})

test('OpenAI web_search type is not dropped during convert', () => {
  const tools = openaiToolsToClaude([
    { type: 'web_search' },
    { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } },
    { type: 'web_search_preview' },
  ])
  assert.deepEqual(tools[0], CLAUDE_WEB_SEARCH_TOOL)
  assert.equal(tools.filter((t) => t.name === 'web_search').length, 1)
  assert.equal(tools[1].name, 'lookup')
})

test('OpenAI path does not inject web_search just because the prompt says search', () => {
  const hello = toClaudeMessages('openai.chat', {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'hi' }],
  })
  const skipped = ensureClaudeWebSearch(hello.claude, {
    enabled: shouldInjectClaudeWebSearch({
      headers: { 'user-agent': 'OpenAI/Python 1.40' },
      body: hello.claude,
    }),
  })
  assert.equal(hasClaudeWebSearch(skipped.tools), false)

  const asked = toClaudeMessages('openai.chat', {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'search the latest docs' }],
  })
  const keywordOnly = ensureClaudeWebSearch(asked.claude, {
    enabled: shouldInjectClaudeWebSearch({
      headers: { 'user-agent': 'OpenAI/Python 1.40' },
      body: asked.claude,
    }),
  })
  assert.equal(hasClaudeWebSearch(keywordOnly.tools), false)
  const forced = ensureClaudeWebSearch(asked.claude, {
    enabled: shouldInjectClaudeWebSearch({
      headers: { 'user-agent': 'OpenAI/Python 1.40', 'x-kin-web-search': 'true' },
      body: asked.claude,
    }),
  })
  assert.ok(hasClaudeWebSearch(forced.tools))
  assert.deepEqual(forced.tools.at(-1), CLAUDE_WEB_SEARCH_TOOL)
})

test('dropWebSearchFlag and sanitize drop the KIN-only top key', () => {
  const body = { model: 'claude-sonnet-5', web_search: false, messages: [] }
  assert.equal(Object.prototype.hasOwnProperty.call(dropWebSearchFlag(body), 'web_search'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(copyOfficialAnthropicFields(body), 'web_search'), false)
})

test('openai.chat convert injects mapped search then caller can ensure', () => {
  const { claude } = toClaudeMessages('openai.chat', {
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'news?' }],
    tools: [{ type: 'web_search' }],
  })
  assert.ok(hasClaudeWebSearch(claude.tools))
  assert.deepEqual(claude.tools[0], CLAUDE_WEB_SEARCH_TOOL)
})

test('rewriteToolNames skips Anthropic server tools', () => {
  const result = rewriteToolNames({
    tools: [
      { type: 'web_search_20250305', name: 'web_search' },
      { name: 'mcp.server/read file', input_schema: { type: 'object' } },
    ],
  })
  assert.equal(result.body.tools[0].name, 'web_search')
  assert.equal(result.body.tools[0].type, 'web_search_20250305')
  assert.match(result.body.tools[1].name, /^kin_tool_/)
})

test('custom tool sanitizer keeps eager_input_streaming true and false', () => {
  for (const eager of [true, false]) {
    const out = officialMessagesBody({
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Write', input_schema: { type: 'object', properties: {} }, eager_input_streaming: eager }],
    })
    assert.equal(out.tools[0].eager_input_streaming, eager)
  }
  const omitted = officialMessagesBody({
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'Write', input_schema: { type: 'object', properties: {} } }],
  })
  assert.equal(Object.hasOwn(omitted.tools[0], 'eager_input_streaming'), false)
})

test('isWebSearchTool / isAnthropicServerTool', () => {
  assert.equal(isWebSearchTool({ type: 'web_search_20250305', name: 'web_search' }), true)
  assert.equal(isWebSearchTool({ type: 'google_search' }), true)
  assert.equal(isWebSearchTool({ name: 'search_web' }), false)
  assert.equal(isWebSearchTool({ name: 'read_file' }), false)
  assert.equal(isAnthropicServerTool({ type: 'web_search_20250305', name: 'web_search' }), true)
  assert.equal(isAnthropicServerTool({ name: 'read_file' }), false)
  assert.equal(isAnthropicServerTool({ type: 'custom', name: 'Read' }), false)
})

test('sanitizeAnthropicTools drops input_schema on web_search_20250305', () => {
  const out = sanitizeAnthropicTools([
    { name: 'read_file', input_schema: { type: 'object' } },
    {
      type: 'web_search_20250305',
      name: 'web_search',
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      description: 'search',
    },
  ])
  assert.deepEqual(out[0], { name: 'read_file', input_schema: { type: 'object' } })
  assert.deepEqual(out[1], { type: 'web_search_20250305', name: 'web_search' })
})

test('sanitizeAnthropicTools keeps Rikka search_web as a client tool', () => {
  const schema = {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  }
  const out = sanitizeAnthropicTools([
    {
      name: 'search_web',
      description: 'search web for latest information',
      input_schema: schema,
    },
    { name: 'scrape_web', input_schema: { type: 'object' } },
  ])
  assert.deepEqual(out[0], {
    name: 'search_web',
    description: 'search web for latest information',
    input_schema: schema,
  })
  assert.deepEqual(out[1], { name: 'scrape_web', input_schema: { type: 'object' } })
})

test('sanitizeAnthropicTools lifts OpenAI function search_web to Claude client tool', () => {
  const out = sanitizeAnthropicTools([
    {
      type: 'function',
      function: {
        name: 'search_web',
        description: 'search web for latest information',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    },
  ])
  assert.deepEqual(out, [
    {
      name: 'search_web',
      description: 'search web for latest information',
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    },
  ])
})

test('openaiToolsToClaude maps function search_web to a client tool not native web_search', () => {
  const out = openaiToolsToClaude([
    {
      type: 'function',
      function: {
        name: 'search_web',
        description: 'search web for latest information',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    },
  ])
  assert.deepEqual(out, [
    {
      name: 'search_web',
      description: 'search web for latest information',
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    },
  ])
})

test('ensureClaudeWebSearch does not overlay native web_search onto search_web', () => {
  const tools = [
    {
      name: 'search_web',
      description: 'search web for latest information',
      input_schema: { type: 'object' },
    },
  ]
  const out = ensureClaudeWebSearch({
    messages: [{ role: 'user', content: '搜索天气' }],
    tools,
  })
  assert.equal(out.tools.length, 1)
  assert.equal(out.tools[0].name, 'search_web')
  assert.equal(out.tools[0].type, undefined)
})

test('officialMessagesBody keeps inbound search_web as a client tool', () => {
  const official = officialMessagesBody({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: '今天天气' }],
    tools: [
      {
        name: 'search_web',
        description: 'search web for latest information',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ],
  })
  assert.deepEqual(official.tools, [
    {
      name: 'search_web',
      description: 'search web for latest information',
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    },
  ])
})

test('officialMessagesBody and cli-hop strip tools.1 web_search extras', () => {
  const inbound = {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: '搜索天气' }],
    tools: [
      { name: 'read_file', input_schema: { type: 'object' } },
      {
        type: 'web_search_20250305',
        name: 'web_search',
        input_schema: { type: 'object' },
        allowed_domains: ['example.com'],
      },
    ],
  }
  const official = officialMessagesBody(inbound)
  assert.equal(official.tools[1].input_schema, undefined)
  assert.deepEqual(official.tools[1], {
    type: 'web_search_20250305',
    name: 'web_search',
    allowed_domains: ['example.com'],
  })
  const hop = prepareCliHopBody(inbound)
  assert.equal(hop.tools[1].input_schema, undefined)
  assert.equal(hop.tools[1].type, 'web_search_20250305')
})

test('Claude Code client WebSearch stays a client tool (issue #134)', () => {
  const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  const tool = { name: 'WebSearch', description: 'Search the web.', defer_loading: true, input_schema: schema }
  assert.equal(isWebSearchTool(tool), false)
  assert.equal(hasClaudeWebSearch([tool]), false)
  const out = officialMessagesBody({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    tools: [{ name: 'ToolSearch', input_schema: { type: 'object' } }, tool],
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.deepEqual(out.tools[1], {
    name: 'WebSearch',
    input_schema: schema,
    description: 'Search the web.',
    defer_loading: true,
  })
  // Server-search spellings keep mapping to the native tool.
  assert.equal(isWebSearchTool({ name: 'websearch' }), true)
  assert.equal(isWebSearchTool({ name: 'web_search', input_schema: schema }), true)
  assert.equal(isWebSearchTool({ type: 'web_search_20250305', name: 'WebSearch', input_schema: schema }), true)
  assert.equal(isWebSearchTool({ name: 'WebSearch' }), true)
})

test('custom tools keep defer_loading only when literally true', () => {
  const out = sanitizeAnthropicTools([
    { name: 'Lazy', input_schema: { type: 'object' }, defer_loading: true },
    { name: 'Eager', input_schema: { type: 'object' }, defer_loading: 'true' },
  ])
  assert.equal(out[0].defer_loading, true)
  assert.equal(Object.prototype.hasOwnProperty.call(out[1], 'defer_loading'), false)
})

test('ensureClaudeWebSearch does not overlay native web_search onto Claude Code WebSearch', () => {
  const tool = { name: 'WebSearch', input_schema: { type: 'object' }, defer_loading: true }
  const body = { tools: [tool], messages: [{ role: 'user', content: 'search the docs' }] }
  assert.equal(ensureClaudeWebSearch(body), body)
})

test('caller-declared web_search is not given injected defaults', () => {
  const [out] = sanitizeAnthropicTools([{ type: 'web_search_20250305', name: 'web_search' }])
  assert.deepEqual(out, { type: 'web_search_20250305', name: 'web_search' })
  const [capped] = sanitizeAnthropicTools([{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }])
  assert.equal(capped.max_uses, 3)
})

test('caller-defined web_search function stays a client tool through convert', () => {
  const fn = {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web using Tavily.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  }
  assert.equal(isWebSearchTool(fn), false)
  const [out] = openaiToolsToClaude([fn])
  assert.equal(out.name, 'web_search')
  assert.equal(out.type, undefined)
  assert.deepEqual(out.input_schema.required, ['query'])
  assert.equal(out.description, 'Search the web using Tavily.')
})

test('caller-defined web_search function blocks native search injection', () => {
  const body = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Tavily',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
    ],
  }
  assert.equal(ensureClaudeWebSearch(body), body)
})

test('non-search tool with description+schema is not caller-defined search and does not block inject', () => {
  const readFileFn = {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from disk',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  }
  assert.equal(isWebSearchTool(readFileFn), false)
  const body = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [readFileFn],
  }
  const out = ensureClaudeWebSearch(body)
  assert.equal(out.tools.length, 2)
  assert.equal(out.tools[0].function.name, 'read_file')
  assert.deepEqual(out.tools[1], CLAUDE_WEB_SEARCH_TOOL)
})

test('Anthropic custom tool with description+schema but non-search name does not block inject', () => {
  const body = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        name: 'lookup',
        description: 'Look up a record',
        input_schema: { type: 'object', properties: { id: { type: 'string' } } },
      },
    ],
  }
  const out = ensureClaudeWebSearch(body)
  assert.equal(out.tools.length, 2)
  assert.equal(out.tools[0].name, 'lookup')
  assert.deepEqual(out.tools[1], CLAUDE_WEB_SEARCH_TOOL)
})

test('bare OpenAI web_search and native types still map to the server tool', () => {
  assert.equal(isWebSearchTool({ type: 'web_search' }), true)
  assert.equal(isWebSearchTool({ type: 'function', function: { name: 'web_search' } }), true)
  assert.equal(isWebSearchTool({ name: 'web_search' }), true)
  assert.equal(isWebSearchTool({ name: 'web_search', input_schema: { type: 'object' } }), true)
})

test('caller-defined web_search survives convert then sanitize as a client tool', () => {
  const fn = {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web using Tavily.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  }
  const [out] = sanitizeAnthropicTools(openaiToolsToClaude([fn]))
  assert.equal(out.type, undefined)
  assert.equal(out.name, 'web_search')
  assert.deepEqual(out.input_schema.required, ['query'])
  assert.equal(out.description, 'Search the web using Tavily.')
})

test('native web_search with a stray description is still rebuilt as the server tool', () => {
  const [out] = sanitizeAnthropicTools([
    { type: 'web_search_20250305', name: 'web_search', description: 'x', input_schema: {} },
  ])
  assert.deepEqual(out, { type: 'web_search_20250305', name: 'web_search' })
})
