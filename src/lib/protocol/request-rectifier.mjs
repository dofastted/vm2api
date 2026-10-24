/**
 * Unofficial Anthropic request rectifier (sub2api FilterThinking / retry-filter analog).
 *
 * Official Claude Code may send assistant prefill and incomplete tool turns on purpose.
 * These fixes run on unofficial clients, plus always-on output_config schema fill.
 */
import { createHash } from 'node:crypto'
import { stripIllegalCacheControlFields } from './cache-ttl.mjs'
import {
  blockHasEncryptedContent,
  hasClaudeWebSearch,
  historyHasWebSearchArtifacts,
  isWebSearchArtifactBlock,
} from './web-search.mjs'

export const CONTINUE_USER_TEXT = 'continue'
export const MISSING_TOOL_RESULT_TEXT = 'Tool result unavailable.'
export const SEARCH_HISTORY_TEXT_LIMIT = 8000

function clone(value) {
  return structuredClone(value)
}

function asBlocks(content) {
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return []
}

function collectToolUseIds(content) {
  const ids = []
  for (const block of asBlocks(content)) {
    if (block?.type === 'tool_use' && block.id) ids.push(String(block.id))
  }
  return ids
}

function collectToolResultIds(content) {
  const ids = new Set()
  for (const block of asBlocks(content)) {
    if (block?.type === 'tool_result' && block.tool_use_id) ids.add(String(block.tool_use_id))
  }
  return ids
}

function placeholderResult(toolUseId) {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: MISSING_TOOL_RESULT_TEXT,
  }
}

/** After assistant tool_use, the next user turn must include matching tool_result blocks. */
export function pairMissingToolResults(body = {}) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return body
  const messages = body.messages.map((message) => ({ ...message }))
  let pending = []
  let changed = false

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    const role = String(message?.role || '')
    if (role === 'assistant') {
      pending = pending.concat(collectToolUseIds(message.content))
      continue
    }
    if (role !== 'user' || pending.length === 0) continue
    const have = collectToolResultIds(message.content)
    const missing = pending.filter((id) => !have.has(id))
    pending = []
    if (!missing.length) continue
    const extras = missing.map(placeholderResult)
    if (Array.isArray(message.content)) {
      messages[i] = { ...message, content: [...extras, ...message.content] }
    } else if (typeof message.content === 'string') {
      messages[i] = {
        ...message,
        content: [...extras, { type: 'text', text: message.content }],
      }
    } else {
      messages[i] = { ...message, content: extras }
    }
    changed = true
  }

  if (pending.length) {
    messages.push({
      role: 'user',
      content: pending.map(placeholderResult),
    })
    changed = true
  }
  if (!changed) return body
  return { ...body, messages }
}

/** Anthropic unofficial path: conversation must end with a user turn (not assistant prefill). */
export function ensureConversationEndsWithUser(body = {}) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return body
  const last = body.messages[body.messages.length - 1]
  if (String(last?.role || '') !== 'assistant') return body
  return {
    ...body,
    messages: [...body.messages, { role: 'user', content: [{ type: 'text', text: CONTINUE_USER_TEXT }] }],
  }
}

function fillObjectSchema(node) {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(fillObjectSchema)
  const out = { ...node }
  if (String(out.type || '').toLowerCase() === 'object' && out.additionalProperties == null) {
    out.additionalProperties = false
  }
  if (out.properties && typeof out.properties === 'object') {
    const next = {}
    for (const [key, value] of Object.entries(out.properties)) {
      next[key] = fillObjectSchema(value)
    }
    out.properties = next
  }
  if (out.items) out.items = fillObjectSchema(out.items)
  if (out.schema) out.schema = fillObjectSchema(out.schema)
  if (out.format && typeof out.format === 'object') out.format = fillObjectSchema(out.format)
  if (Array.isArray(out.anyOf)) out.anyOf = out.anyOf.map(fillObjectSchema)
  if (Array.isArray(out.oneOf)) out.oneOf = out.oneOf.map(fillObjectSchema)
  return out
}

/** Missing additionalProperties on output_config JSON schema → 400. */
export function ensureOutputConfigSchema(body = {}) {
  const config = body.output_config
  if (!config || typeof config !== 'object') return body
  const next = fillObjectSchema(config)
  if (JSON.stringify(next) === JSON.stringify(config)) return body
  return { ...body, output_config: next }
}

function plainText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block?.type === 'text') return String(block.text || '')
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function clip(text) {
  const raw = String(text || '').trim()
  if (raw.length <= SEARCH_HISTORY_TEXT_LIMIT) return raw
  return `${raw.slice(0, SEARCH_HISTORY_TEXT_LIMIT)}…`
}

function searchResultLine(result, index) {
  if (!result || typeof result !== 'object') return `${index + 1}. result`
  const title = String(result.title || '').trim()
  const url = String(result.url || result.source || '').trim()
  const head = [title, url].filter(Boolean).join(' — ') || 'result'
  const body = clip(plainText(result.content))
  return body ? `${index + 1}. ${head}\n${body}` : `${index + 1}. ${head}`
}

/** Readable leftover of a server-tool interaction whose encrypted payload is unusable. */
function searchArtifactText(block) {
  const type = String(block?.type || '')
  if (type === 'server_tool_use') {
    const query = String(block?.input?.query || '').trim()
    return query ? `[web search] ${query}` : `[server tool ${String(block?.name || 'call')}]`
  }
  const content = block?.content
  if (content && !Array.isArray(content) && typeof content === 'object') {
    return `[web search unavailable: ${String(content.error_code || content.type || 'error')}]`
  }
  if (Array.isArray(content) && (type === 'web_search_tool_result' || type.endsWith('_tool_result'))) {
    const lines = content.map((result, index) => searchResultLine(result, index))
    return lines.length ? `[web search results]\n${lines.join('\n')}` : '[web search results unavailable]'
  }
  const line = searchResultLine(block, 0).replace(/^1\.\s*/, '')
  return `[search result] ${line}`
}

function isServerToolBlock(block) {
  const type = String(block?.type || '')
  if (type === 'server_tool_use') return true
  return type !== 'tool_result' && type.endsWith('_tool_result')
}

const SEARCH_BLOCK_TYPES = new Set(['search_result', 'web_search_result'])

/** Client tool_use / tool_result pairs are never flattened — only their inner search blocks. */
function isFlattenableSearchBlock(block) {
  if (isServerToolBlock(block)) return true
  if (SEARCH_BLOCK_TYPES.has(String(block?.type || ''))) return blockHasEncryptedContent(block)
  return typeof block?.encrypted_content === 'string'
}

function flattenSearchBlocks(content, depth = 0) {
  if (!Array.isArray(content) || depth > 4) return content
  const out = []
  let changed = false
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      out.push(block)
      continue
    }
    if (isFlattenableSearchBlock(block)) {
      out.push({ type: 'text', text: searchArtifactText(block) })
      changed = true
      continue
    }
    if (Array.isArray(block.content)) {
      const nested = flattenSearchBlocks(block.content, depth + 1)
      if (nested !== block.content) {
        out.push({ ...block, content: nested })
        changed = true
        continue
      }
    }
    out.push(block)
  }
  return changed ? out : content
}

function messageNeedsFlatten(content, depth = 0) {
  if (!Array.isArray(content) || depth > 4) return false
  return content.some((block) => isWebSearchArtifactBlock(block) || messageNeedsFlatten(block?.content, depth + 1))
}

/** Match only the same search-bearing history and tool contract, never later conversation turns. */
export function searchHistoryFingerprint(body = {}) {
  if (!Array.isArray(body.messages)) return null
  let hash = null
  for (let index = 0; index < body.messages.length; index++) {
    const message = body.messages[index]
    if (!messageNeedsFlatten(message?.content)) continue
    hash ??= createHash('sha256')
    hash.update(JSON.stringify([index, message.role, message.content]))
    hash.update('\n')
  }
  if (!hash) return null
  hash.update(JSON.stringify(body.tools || []))
  return hash.digest('hex')
}

/**
 * Retry or confirmed replay: search history the current account cannot decrypt
 * ("Invalid `encrypted_content` in `search_result` block") becomes plain text.
 * server_tool_use is flattened together with its result so no call is orphaned.
 */
export function flattenSearchResultHistory(body = {}) {
  if (!Array.isArray(body.messages)) return body
  let changed = false
  const messages = body.messages.map((message) => {
    if (!messageNeedsFlatten(message?.content)) return message
    const content = flattenSearchBlocks(message.content)
    if (content === message.content) return message
    changed = true
    return {
      ...message,
      content: content.length ? content : placeholderContent(message?.role),
    }
  })
  if (!changed) return body
  return { ...body, messages }
}

/**
 * Replayed server search with no native web_search left in tools (the caller ships its
 * own client web_search, or search is switched off): Anthropic rejects the replayed
 * server_tool_use as "not defined in `tools` as a server tool", so it becomes text.
 */
export function flattenUndeclaredSearchHistory(body = {}) {
  if (hasClaudeWebSearch(body.tools) || !historyHasWebSearchArtifacts(body)) return body
  return flattenSearchResultHistory(body)
}

function placeholderContent(role) {
  return [
    {
      type: 'text',
      text: role === 'assistant' ? '(assistant content removed)' : '(content removed)',
    },
  ]
}

/** First-pass unofficial fix: schema, plus replayed server search the caller no longer declares. */
export function rectifyUnofficialRequest(body = {}) {
  return flattenUndeclaredSearchHistory(ensureOutputConfigSchema(stripIllegalCacheControlFields(clone(body))))
}

/** Retry-only (upstream 400 prefill / unpaired tool_use). sub2api does not do this on first hop. */
export function rectifyUnofficialRequestForRetry(body = {}) {
  let out = clone(body)
  out = stripIllegalCacheControlFields(out)
  out = ensureOutputConfigSchema(out)
  out = pairMissingToolResults(out)
  out = ensureConversationEndsWithUser(out)
  return out
}
