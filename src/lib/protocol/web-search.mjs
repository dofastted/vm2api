/**
 * Claude server-side web search.
 *
 * Unofficial /v1 injects the native server tool only when the last user
 * prompt asks to search (搜索 / search / web search), or when the caller
 * replays search history (a follow-up turn that carries server_tool_use /
 * web_search_tool_result blocks must keep the tool armed, else Anthropic
 * rejects the replayed block). All persona modes share this gate. Opt out
 * with body.web_search=false or x-kin-web-search: false. Explicit true
 * still forces inject. Official Claude Code inbound is never injected.
 * Caller-declared search is forwarded as-is.
 *
 * Schema is Anthropic-only: { type: "web_search_20250305", name: "web_search" }.
 * Anthropic requires name "web_search"; replaying a server_tool_use under any
 * other name is rejected. Do not add description / input_schema — the native
 * type is the whole prompt.
 */

const WEB_SEARCH_BASE = Object.freeze({
  type: 'web_search_20250305',
  name: 'web_search',
})

/** Injected tool, same as Claude Code 2.1.281's own server search definition. */
export const CLAUDE_WEB_SEARCH_TOOL = Object.freeze({
  ...WEB_SEARCH_BASE,
  max_uses: 8,
})

export const WEB_SEARCH_HEADER = 'x-kin-web-search'

const WEB_SEARCH_NAMES = new Set(['web_search', 'web_search_20250305', 'websearch', 'google_search'])

function searchToolName(tool) {
  return String(tool?.name || tool?.function?.name || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
}

/**
 * Claude Code's own `WebSearch` is a client tool (it has input_schema and the
 * client runs it). Rewriting it to the server tool breaks ToolSearch
 * `tool_reference` blocks that still point at `WebSearch`.
 */
function isClaudeCodeClientWebSearch(tool, type) {
  return tool.name === 'WebSearch' && tool.input_schema != null && !type.startsWith('web_search')
}

/**
 * A web_search tool that carries its own description and schema (OpenAI
 * `function` wrapper or Anthropic `input_schema`) is the caller's own search,
 * run by the caller. Rewriting it to the native server tool drops that schema
 * and makes Anthropic run a different search than the one the caller asked for.
 * Native tools have a `web_search*` type or no schema at all.
 */
function isWebSearchFamilyName(tool, type) {
  const name = searchToolName(tool)
  return type.startsWith('web_search') || type === 'google_search' || WEB_SEARCH_NAMES.has(name)
}

function isCallerDefinedSearchFunction(tool, type) {
  if (type.startsWith('web_search') || type === 'google_search') return false
  if (!isWebSearchFamilyName(tool, type)) return false
  const def = type === 'function' && tool.function ? tool.function : tool
  const schema = def.parameters ?? def.input_schema
  return schema != null && Boolean(def.description)
}

export function isWebSearchTool(tool) {
  if (!tool || typeof tool !== 'object') return false
  const type = String(tool.type || '').toLowerCase()
  if (isClaudeCodeClientWebSearch(tool, type)) return false
  if (isCallerDefinedSearchFunction(tool, type)) return false
  const name = searchToolName(tool)
  return type.startsWith('web_search') || type === 'google_search' || WEB_SEARCH_NAMES.has(name)
}

/** Client search tools (Rikka search_web, Claude Code WebSearch). Not Anthropic's built-in web_search. */
export function isCallerClientSearchTool(tool) {
  if (!tool || typeof tool !== 'object') return false
  const type = String(tool.type || '').toLowerCase()
  if (isClaudeCodeClientWebSearch(tool, type)) return true
  const name = searchToolName(tool)
  if (name === 'search_web' || name === 'scrape_web') return true
  return isCallerDefinedSearchFunction(tool, type)
}

export function isAnthropicServerTool(tool) {
  const type = String(tool?.type || '')
  return type !== '' && type !== 'function' && type !== 'custom'
}

export function hasClaudeWebSearch(tools) {
  return Array.isArray(tools) && tools.some(isWebSearchTool)
}

export function hasCallerClientSearchTool(tools) {
  return Array.isArray(tools) && tools.some(isCallerClientSearchTool)
}

export function isFalseFlag(value) {
  if (value === false || value === 0) return true
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  return raw === 'false' || raw === '0' || raw === 'off' || raw === 'no'
}

export function isTrueFlag(value) {
  if (value === true || value === 1) return true
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes'
}

export function isWebSearchDisabled({ body, headers } = {}) {
  const hdr = headers?.[WEB_SEARCH_HEADER] ?? headers?.['X-Kin-Web-Search']
  if (isFalseFlag(hdr)) return true
  if (isFalseFlag(body?.web_search)) return true
  return false
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part.text === 'string') return part.text
        if (part && typeof part.content === 'string') return part.content
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content.text === 'string') return content.text
  return ''
}

/** Last user turn only. Older turns do not keep search armed. */
export function lastUserPromptText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return contentToText(messages[i].content)
  }
  if (typeof body?.input === 'string') return body.input
  if (Array.isArray(body?.input)) return contentToText(body.input)
  return ''
}

const MAX_BLOCK_DEPTH = 4

/** Nested encrypted_content (web_search_result payloads live inside the result block). */
export function blockHasEncryptedContent(block, depth = 0) {
  if (!block || typeof block !== 'object' || depth > MAX_BLOCK_DEPTH) return false
  if (typeof block.encrypted_content === 'string') return true
  if (!Array.isArray(block.content)) return false
  return block.content.some((inner) => blockHasEncryptedContent(inner, depth + 1))
}

/** A search interaction the caller replayed from an earlier assistant turn. */
export function isWebSearchArtifactBlock(block) {
  if (!block || typeof block !== 'object') return false
  const type = String(block.type || '')
  if (type === 'web_search_tool_result' || type === 'web_search_result') return true
  if (type === 'server_tool_use') return isWebSearchTool({ name: block.name })
  return blockHasEncryptedContent(block)
}

function contentHasWebSearchArtifact(content, depth = 0) {
  if (!Array.isArray(content) || depth > MAX_BLOCK_DEPTH) return false
  return content.some(
    (block) => isWebSearchArtifactBlock(block) || contentHasWebSearchArtifact(block?.content, depth + 1),
  )
}

/** Replayed search history keeps the tool armed even when the new prompt is silent. */
export function historyHasWebSearchArtifacts(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages.some((message) => contentHasWebSearchArtifact(message?.content))
}

export function promptRequestsWebSearch(text) {
  const raw = String(text || '')
  if (!raw) return false
  if (raw.includes('搜索')) return true
  if (/\bweb[\s-]*search\b/i.test(raw)) return true
  return /\bsearch\b/i.test(raw)
}

/**
 * Inject on an explicit true flag or when the caller replays search history.
 * A bare "search" / "搜索" in the latest user text must not add or remove the
 * tool: that rewrites the tool prefix and breaks the prompt cache. Off when
 * official or body/header false. tool_choice=none is enforced in ensureClaudeWebSearch.
 */
export function shouldInjectClaudeWebSearch({ officialClient, clientClass, headers, body } = {}) {
  if (officialClient || clientClass === 'claude_code_official') return false
  if (isWebSearchDisabled({ body, headers })) return false
  const hdr = headers?.[WEB_SEARCH_HEADER] ?? headers?.['X-Kin-Web-Search']
  if (isTrueFlag(hdr) || isTrueFlag(body?.web_search)) return true
  if (historyHasWebSearchArtifacts(body)) return true
  return false
}

function toolChoiceNone(toolChoice) {
  if (toolChoice == null) return false
  if (toolChoice === 'none') return true
  return typeof toolChoice === 'object' && toolChoice.type === 'none'
}

/**
 * Append the native Claude web_search server tool when the inbound body has none.
 * No-ops when disabled, when the client already declared native or client search,
 * or when tool_choice is none. search_web is a caller tool, not this server tool.
 */
export function ensureClaudeWebSearch(body, { enabled = true } = {}) {
  if (!enabled || !body || typeof body !== 'object') return body
  if (toolChoiceNone(body.tool_choice)) return body
  if (hasClaudeWebSearch(body.tools) || hasCallerClientSearchTool(body.tools)) return body
  const tools = Array.isArray(body.tools) ? [...body.tools] : []
  tools.push({ ...CLAUDE_WEB_SEARCH_TOOL })
  return { ...body, tools }
}

/** Drop the KIN-only top-level switch so Anthropic never sees Extra inputs. */
export function dropWebSearchFlag(body) {
  if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'web_search')) {
    return body
  }
  const { web_search: _drop, ...rest } = body
  return rest
}

/** Fields Anthropic rejects on native server tools (`Extra inputs are not permitted`). */
const SERVER_TOOL_DROP = new Set(['input_schema', 'description', 'parameters', 'function', 'strict'])
const WEB_SEARCH_KEEP = new Set([
  'type',
  'name',
  'allowed_domains',
  'blocked_domains',
  'user_location',
  'max_uses',
  'cache_control',
  'defer_loading',
])
/**
 * Anthropic custom/client tool: { name, description, input_schema }.
 * OpenAI function wrappers and `parameters` lift into that shape.
 * Native web_search stays the server tool; search_web stays a client tool.
 */
export function toAnthropicCustomTool(tool) {
  if (!tool || typeof tool !== 'object') return tool
  if (isWebSearchTool(tool) || isAnthropicServerTool(tool)) return tool
  const fn = tool.type === 'function' && tool.function && typeof tool.function === 'object' ? tool.function : null
  const name = String(fn?.name || tool.name || '').trim()
  if (!name) return tool
  const description = String(fn?.description || tool.description || '')
  const input_schema = fn?.parameters || tool.input_schema || tool.parameters || { type: 'object', properties: {} }
  const out = { name, input_schema }
  if (description) out.description = description
  if (tool.cache_control) out.cache_control = tool.cache_control
  const strict = fn?.strict ?? tool.strict
  if (typeof strict === 'boolean') out.strict = strict
  if (tool.defer_loading === true) out.defer_loading = true
  const eager =
    typeof tool.eager_input_streaming === 'boolean'
      ? tool.eager_input_streaming
      : typeof fn?.eager_input_streaming === 'boolean'
        ? fn.eager_input_streaming
        : undefined
  if (typeof eager === 'boolean') out.eager_input_streaming = eager
  return out
}

/**
 * Strip client leftovers from Anthropic server tools. Custom tools keep
 * input_schema. web_search_* is rebuilt to the native {type,name} plus
 * the few optional fields the API accepts.
 */
export function sanitizeAnthropicTools(tools) {
  if (!Array.isArray(tools)) return tools
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool
    if (isWebSearchTool(tool)) {
      // Caller-declared search keeps its own options; no injected defaults.
      const out = { ...WEB_SEARCH_BASE }
      const type = String(tool.type || '')
      if (type.startsWith('web_search_')) out.type = type
      for (const key of WEB_SEARCH_KEEP) {
        if (key === 'type' || key === 'name') continue
        if (tool[key] != null) out[key] = tool[key]
      }
      return out
    }
    if (!isAnthropicServerTool(tool)) return toAnthropicCustomTool(tool)
    let next = tool
    for (const key of SERVER_TOOL_DROP) {
      if (!Object.prototype.hasOwnProperty.call(next, key)) continue
      if (next === tool) next = { ...tool }
      delete next[key]
    }
    return next
  })
}

export function sanitizeBodyServerTools(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.tools)) return body
  const tools = sanitizeAnthropicTools(body.tools)
  if (tools === body.tools) return body
  return { ...body, tools }
}
