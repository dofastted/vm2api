/**
 * Structural features of unofficial cases (test14 / forced tools, …)
 * so they convert to the current official 4-block Claude Code rewrite
 * without dropping caller tools or the user prompt.
 */
export const OFFICIAL_SYSTEM_KINDS = Object.freeze(['billing', 'identity', 'agent_prompt', 'environment'])

export const TEST14_FEATURES = Object.freeze({
  id: '07-forced-weather',
  source: 'test14.json',
  inbound: {
    has_top_level_system: false,
    user_text: '请查询东京现在的天气，使用摄氏度。',
    tool_names: ['get_weather'],
    tool_choice: { type: 'tool', name: 'get_weather' },
    forced_tool: true,
  },
  official_outbound: {
    system_block_count: 4,
    // rewrite + parkBillingAfterCacheBoundary: identity/agent cache prefix, billing after last breakpoint
    system_kinds: Object.freeze(['identity', 'agent_prompt', 'billing', 'environment']),
    keep_caller_tools: true,
    keep_tool_choice: true,
    keep_user_text: true,
    do_not_inject_cc_tools: true,
  },
})

export const TEST14_OPENAI_INBOUND = Object.freeze({
  model: 'claude-sonnet-5',
  max_tokens: 1024,
  stream: false,
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询指定城市的实时天气。当用户询问某个城市的天气、温度或气象情况时调用此工具。',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: '需要查询天气的城市名称，例如：上海、东京、New York' },
            unit: {
              type: 'string',
              enum: ['celsius', 'fahrenheit'],
              description: '温度单位，celsius 表示摄氏度，fahrenheit 表示华氏度',
            },
          },
          required: ['city', 'unit'],
          additionalProperties: false,
        },
      },
    },
  ],
  tool_choice: { type: 'function', function: { name: 'get_weather' } },
  messages: [{ role: 'user', content: TEST14_FEATURES.inbound.user_text }],
})

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  return content
    .map((block) => (typeof block === 'string' ? block : block?.text || ''))
    .filter(Boolean)
    .join('\n')
}

function toolName(tool) {
  if (!tool || typeof tool !== 'object') return ''
  return String(tool.name || tool.function?.name || tool.type || '').trim()
}

export function extractCaseFeatures(body = {}) {
  const systemTexts = []
  if (typeof body.system === 'string' && body.system.trim()) systemTexts.push(body.system)
  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      const text = typeof block === 'string' ? block : block?.text || ''
      if (text.trim()) systemTexts.push(text)
    }
  }
  const tools = Array.isArray(body.tools) ? body.tools : []
  const toolNames = tools.map(toolName).filter(Boolean)
  const toolChoice =
    body.tool_choice && typeof body.tool_choice === 'object'
      ? { type: body.tool_choice.type, name: body.tool_choice.name || body.tool_choice.function?.name }
      : body.tool_choice || null
  const firstUser = (Array.isArray(body.messages) ? body.messages : []).find((msg) => msg?.role === 'user')
  return {
    has_top_level_system: systemTexts.length > 0,
    user_text: contentText(firstUser?.content),
    tool_names: toolNames,
    tool_choice: toolChoice,
    forced_tool: !!(toolChoice && toolChoice.type === 'tool' && toolChoice.name),
  }
}

export function officialSystemKinds(system) {
  if (!Array.isArray(system)) return []
  return system.map((block, index) => {
    const text = String(block?.text || '')
    if (/x-anthropic-billing-header:/i.test(text)) return 'billing'
    if (index === 1 && /^[\u200b\u200c\u200d\ufeff\s]*$/.test(text)) return 'identity'
    if (/You are a Claude agent, built on Anthropic's Claude Agent SDK/.test(text)) return 'identity'
    if (text.trim() === "You are Claude Code, Anthropic's official CLI for Claude.") return 'identity'
    if (
      /# Doing tasks|# Tone and style/.test(text) ||
      /You are an interactive agent that helps users with software engineering tasks/.test(text) ||
      /Help the user complete the current request/.test(text)
    )
      return 'agent_prompt'
    if (/# Environment/.test(text)) return 'environment'
    return index >= 4 ? 'append' : `block_${index}`
  })
}

export function matchesTest14Features(features) {
  const want = TEST14_FEATURES.inbound
  return (
    features.has_top_level_system === want.has_top_level_system &&
    features.user_text === want.user_text &&
    features.tool_names.join() === want.tool_names.join() &&
    features.forced_tool === want.forced_tool &&
    features.tool_choice?.name === want.tool_choice.name
  )
}
