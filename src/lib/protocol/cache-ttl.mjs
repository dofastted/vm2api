/**
 * Anthropic cache_control ttl for unofficial OAuth.
 * Default 1h (2× input). Customers may request 5m (1.25× input);
 * billing must use the TTL we actually sent.
 */
import { isAnthropicServerTool } from './web-search.mjs'
import { readJsonParsedCached } from '../vm/vm-file.mjs'

export const DEFAULT_CACHE_TTL = '1h'
export const CACHE_TTL_HEADER = 'x-kin-cache-ttl'

export function normalizeCacheTtl(value, fallback = DEFAULT_CACHE_TTL) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (
    raw === '1h' ||
    raw === '1hr' ||
    raw === '60m' ||
    raw === '3600' ||
    raw === 'hour' ||
    raw === '1hour' ||
    raw === 'default'
  )
    return '1h'
  if (raw === '5m' || raw === '5min' || raw === '300') return '5m'
  return fallback === DEFAULT_CACHE_TTL ? DEFAULT_CACHE_TTL : normalizeCacheTtl(fallback)
}

export function cacheTtlFromRouting(routing = {}) {
  return normalizeCacheTtl(routing?.compatibility?.cache_ttl)
}

export function cacheTtlFromRoutingFile(filePath) {
  if (!filePath) return DEFAULT_CACHE_TTL
  try {
    const routing = readJsonParsedCached(filePath)
    if (!routing) return DEFAULT_CACHE_TTL
    return cacheTtlFromRouting(routing)
  } catch {
    return DEFAULT_CACHE_TTL
  }
}

/** First explicit inbound TTL in wire order; omitted TTLs defer to the menu setting. */
export function bodyCacheTtl(body) {
  if (!body || typeof body !== 'object') return null
  let first = null
  const collect = (node) => {
    if (first != null) return
    const control = node?.cache_control
    if (control?.type !== 'ephemeral') return
    if (control.ttl === '5m' || control.ttl === '1h') first = control.ttl
  }
  for (const tool of Array.isArray(body.tools) ? body.tools : []) collect(tool)
  for (const block of Array.isArray(body.system) ? body.system : []) collect(block)
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) collect(block)
  }
  collect(body)
  return first
}

export function bodyRequestsHourCache(body) {
  return bodyCacheTtl(body) === '1h'
}

/**
 * Header, then an explicit 5m/1h on any inbound marker, then the settings menu.
 * Rewritten requests resolve omitted TTLs to this value; official passthrough
 * leaves caller omissions untouched.
 */
export function resolveCacheTtl({ headers = {}, body, routing, routingFile } = {}) {
  const hdr = headers[CACHE_TTL_HEADER] || headers['X-Kin-Cache-Ttl']
  if (hdr != null && String(hdr).trim()) return normalizeCacheTtl(hdr)
  const requested = bodyCacheTtl(body)
  if (requested) return requested
  if (routing?.compatibility?.cache_ttl != null) return cacheTtlFromRouting(routing)
  if (routingFile) return cacheTtlFromRoutingFile(routingFile)
  if (routing) return cacheTtlFromRouting(routing)
  return DEFAULT_CACHE_TTL
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isThinkingNode(node) {
  return node?.type === 'thinking' || node?.type === 'redacted_thinking'
}

/**
 * Normalize a single cache_control value into a legal Anthropic ephemeral marker,
 * returning undefined when the value is unusable (non-object or non-ephemeral).
 */
export function normalizeCacheControlObject(
  control,
  { fallbackTtl = DEFAULT_CACHE_TTL, stripExtraFields = false } = {},
) {
  if (control == null) return undefined
  if (!isPlainObject(control)) return undefined
  if (control.type !== 'ephemeral') return undefined
  let ttl
  if (control.ttl != null && String(control.ttl).trim() !== '') {
    ttl = control.ttl === '5m' || control.ttl === '1h' ? control.ttl : normalizeCacheTtl(control.ttl, fallbackTtl)
  }
  if (stripExtraFields) {
    const out = ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' }
    if (typeof control.scope === 'string' && control.scope.trim()) out.scope = control.scope.trim()
    if (typeof control.evict_on_complete === 'boolean') out.evict_on_complete = control.evict_on_complete
    return out
  }
  const out = { ...control, type: 'ephemeral' }
  if (ttl === undefined) delete out.ttl
  else out.ttl = ttl
  return out
}

const CACHE_CONTROL_ALLOWED_EXTRA_KEYS = new Set(['type', 'ttl', 'scope', 'evict_on_complete'])

export function isCleanCacheControl(control, { stripExtraFields = false } = {}) {
  if (!isPlainObject(control) || control.type !== 'ephemeral') return false
  if (control.ttl != null && control.ttl !== '5m' && control.ttl !== '1h') return false
  if (stripExtraFields) {
    for (const key of Object.keys(control)) {
      if (!CACHE_CONTROL_ALLOWED_EXTRA_KEYS.has(key)) return false
    }
    if (Object.hasOwn(control, 'scope') && (typeof control.scope !== 'string' || !control.scope.trim())) return false
    if (Object.hasOwn(control, 'evict_on_complete') && typeof control.evict_on_complete !== 'boolean') return false
  }
  return true
}

function collectCacheEntries(body) {
  const entries = []
  const walkBlock = (node, section) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node.content)) {
      for (const child of node.content) walkBlock(child, 'nested')
    }
    if (Object.prototype.hasOwnProperty.call(node, 'cache_control') && node.cache_control !== undefined) {
      entries.push({ node, section })
    }
  }
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    if (
      tool &&
      typeof tool === 'object' &&
      Object.prototype.hasOwnProperty.call(tool, 'cache_control') &&
      tool.cache_control !== undefined
    ) {
      entries.push({ node: tool, section: 'tools' })
    }
  }
  if (Array.isArray(body?.system)) {
    for (const block of body.system) walkBlock(block, 'system')
  }
  if (Array.isArray(body?.crag_prompt?.blocks)) {
    for (const block of body.crag_prompt.blocks) walkBlock(block, 'system')
  }
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (!Array.isArray(message?.content)) continue
    for (const block of message.content) walkBlock(block, 'messages')
  }
  if (
    body &&
    typeof body === 'object' &&
    Object.prototype.hasOwnProperty.call(body, 'cache_control') &&
    body.cache_control !== undefined
  ) {
    entries.push({ node: body, section: 'body' })
  }
  return entries
}

function stripNestedCacheControls(blocks) {
  let lastValid = null
  for (const child of blocks) {
    if (!child || typeof child !== 'object') continue
    if (Array.isArray(child.content)) {
      const inner = stripNestedCacheControls(child.content)
      if (inner != null) lastValid = inner
    }
    if (child.cache_control != null) {
      if (!isThinkingNode(child)) lastValid = child.cache_control
      delete child.cache_control
    } else if (Object.prototype.hasOwnProperty.call(child, 'cache_control')) {
      delete child.cache_control
    }
  }
  return lastValid
}

/**
 * In-place SSOT repair of cache_control breakpoints so any inbound/outbound body
 * satisfies Anthropic & CRAG rules without violently rejecting the request:
 *  - drops cache_control on thinking/redacted_thinking blocks and malformed values
 *  - optionally strips non-whitelisted fields (e.g. scope/evict_on_complete)
 *  - optionally lifts nested tool_result.content breakpoints onto parent tool_result
 *  - trims excess breakpoints to `limit` (default 4), keeping newest message anchors
 *    and tail system/tool anchors
 *  - optionally fills omitted TTLs and fixes any 5m/omitted -> 1h TTL inversion
 */
export function repairCacheBreakpointsInPlace(
  body,
  {
    limit = 4,
    fallbackTtl = DEFAULT_CACHE_TTL,
    fillMissing = false,
    stripExtraFields = false,
    liftNested = false,
  } = {},
) {
  if (!body || typeof body !== 'object') return body
  const max = Number.isInteger(limit) && limit >= 0 ? limit : 4
  const fallback = normalizeCacheTtl(fallbackTtl)

  // 1. Clean individual markers and strip illegal thinking placements.
  for (const { node } of collectCacheEntries(body)) {
    if (isThinkingNode(node) || node.cache_control == null) {
      delete node.cache_control
      continue
    }
    const cleaned = normalizeCacheControlObject(node.cache_control, { fallbackTtl: fallback, stripExtraFields })
    if (!cleaned) delete node.cache_control
    else node.cache_control = cleaned
  }

  // 2. Lift nested tool_result.content markers onto their parent block when requested.
  if (liftNested && Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!Array.isArray(message?.content)) continue
      for (const block of message.content) {
        if (!block || typeof block !== 'object' || !Array.isArray(block.content)) continue
        const lifted = stripNestedCacheControls(block.content)
        if (lifted != null && block.cache_control == null && !isThinkingNode(block)) {
          block.cache_control = lifted
        }
      }
    }
  }

  // 3. Enforce breakpoint budget (<= max), sacrificing lowest-value anchors first.
  const live = collectCacheEntries(body).filter((entry) => entry.node.cache_control != null)
  if (live.length > max) {
    const bySection = (name) => live.filter((entry) => entry.section === name)
    const nested = bySection('nested')
    const tools = bySection('tools')
    const system = bySection('system')
    const messages = bySection('messages')
    const root = bySection('body')
    const messageTail = [...messages, ...root]
    const staleMessages = messageTail.slice(0, Math.max(0, messageTail.length - 2))
    const activeMessages = messageTail.slice(Math.max(0, messageTail.length - 2))
    const dropOrder = [...nested, ...staleMessages, ...tools, ...system, ...activeMessages]
    for (const entry of dropOrder.slice(0, live.length - max)) {
      delete entry.node.cache_control
    }
  }

  // 4. Fill omitted TTLs (when enabled) and repair any 5m/omitted -> 1h inversion.
  let short = false
  for (const { node } of collectCacheEntries(body)) {
    const control = node.cache_control
    if (!control) continue
    if (fillMissing && control.ttl == null) {
      control.ttl = short ? '5m' : fallback
    }
    if (short && control.ttl === '1h') {
      control.ttl = '5m'
    }
    if (control.ttl !== '1h') short = true
  }
  return body
}

/**
 * Immutable SSOT cache breakpoint auto-repair. Returns the original `body`
 * reference untouched when all breakpoints already satisfy the constraints.
 */
export function repairCacheBreakpoints(
  body,
  {
    limit = 4,
    fallbackTtl = DEFAULT_CACHE_TTL,
    fillMissing = false,
    stripExtraFields = false,
    liftNested = false,
  } = {},
) {
  if (!body || typeof body !== 'object') return body
  const max = Number.isInteger(limit) && limit >= 0 ? limit : 4
  const entries = collectCacheEntries(body)
  let needsRepair = false
  let count = 0
  let short = false
  for (const { node, section } of entries) {
    const control = node.cache_control
    if (control == null) {
      needsRepair = true
      break
    }
    if (isThinkingNode(node)) {
      needsRepair = true
      break
    }
    if (liftNested && section === 'nested') {
      needsRepair = true
      break
    }
    if (!isCleanCacheControl(control, { stripExtraFields })) {
      needsRepair = true
      break
    }
    if (fillMissing && control.ttl == null) {
      needsRepair = true
      break
    }
    if (short && control.ttl === '1h') {
      needsRepair = true
      break
    }
    if (control.ttl !== '1h') short = true
    if (++count > max) {
      needsRepair = true
      break
    }
  }
  if (!needsRepair) return body
  return repairCacheBreakpointsInPlace(structuredClone(body), {
    limit: max,
    fallbackTtl,
    fillMissing,
    stripExtraFields,
    liftNested,
  })
}

/** Validate Anthropic/CRAG cache_control breakpoints (budget <= 4, 1h before 5m, no thinking markers). */
export function validateCacheBreakpoints(body) {
  let count = 0
  let short = false
  const invalid = (message) => {
    const error = new Error(message)
    error.status = 400
    error.body = { type: 'error', error: { type: 'invalid_request_error', code: 'invalid_cache_control', message } }
    throw error
  }
  for (const { node } of collectCacheEntries(body)) {
    const control = node.cache_control
    if (control == null) continue
    if (isThinkingNode(node)) {
      invalid('Cache breakpoints are not allowed on thinking blocks.')
    }
    if (!isCleanCacheControl(control)) {
      invalid('Cache control must be ephemeral with an optional 5m or 1h TTL.')
    }
    if (short && control.ttl === '1h') invalid('Cache TTL must place 1h before 5m (including missing TTL).')
    if (control.ttl !== '1h') short = true
    if (++count > 4) invalid('Cache control exceeds four breakpoints.')
  }
}

/**
 * Claude Code 2.1.328+ asks for automatic caching with a top-level
 * `cache_control`. Our kernels read block markers only, so convert it to the
 * standard shape: the same policy on the current message tail.
 *
 * The conversion is count neutral — the root marker becomes a block marker, it
 * is not added alongside one — so a body that was inside the four-breakpoint
 * budget stays inside it. Validation is the caller's business: a native
 * passthrough validates the caller's markers first, while a hop that rewrites
 * system blocks must not be judged on markers it is about to drop.
 *
 * Safe to call on any body: one without the field is returned unchanged.
 */
export function materializeAutomaticCache(body) {
  if (!body || typeof body !== 'object') return body
  if (!Object.prototype.hasOwnProperty.call(body, 'cache_control')) return body
  const { cache_control: control, ...out } = body
  if (!control || typeof control !== 'object') return out
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || typeof message !== 'object') continue
    // Supported mid-conversation system turns are also in the cache prefix.
    // Skipping them could put this 5m marker before their explicit 1h marker.
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
    if (!Array.isArray(content)) continue
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j]
      if (!block || ['thinking', 'redacted_thinking'].includes(block.type)) continue
      // An explicit tail policy already caches the entire eligible prefix.
      if (block.cache_control != null) return out
      const next = content.slice()
      next[j] = { ...block, cache_control: { ...control } }
      out.messages = messages.slice()
      out.messages[i] = { ...message, content: next }
      return out
    }
  }
  return out
}

/**
 * Only call for a rewritten native body: every surviving marker is Node-owned.
 * Explicit TTLs stay. A missing TTL takes `ttl`, or 5m once a short marker
 * precedes it, so filling never puts a 1h after a 5m. Anthropic reads tools,
 * system, messages, then the root automatic marker at the message tail.
 */
export function fillMissingCacheTtl(body, ttl = DEFAULT_CACHE_TTL) {
  if (!body || typeof body !== 'object') return body
  const target = normalizeCacheTtl(ttl)
  let short = false
  let changed = false
  const fill = (node) => {
    const control = node?.cache_control
    if (!control || control.type !== 'ephemeral') return node
    if (control.ttl === '1h' || control.ttl === '5m') {
      if (control.ttl === '5m') short = true
      return node
    }
    const next = short ? '5m' : target
    if (next !== '1h') short = true
    changed = true
    return { ...node, cache_control: { ...control, ttl: next } }
  }
  const out = walkCacheNodes(body, fill)
  return changed ? out : body
}

const CACHE_TTL_MS = Object.freeze({ '5m': 5 * 60_000, '1h': 60 * 60_000 })
const CONVERSATION_TTL_LIMIT = 10_000
const conversationTtls = new Map()

/**
 * One conversation writes one TTL. Switching mid-conversation re-prices the
 * whole prefix and Anthropic rejects 1h after 5m, so the first resolved value
 * wins until the conversation is idle past that TTL; by then its cache is gone
 * and nothing is lost by re-resolving.
 */
export function pinConversationCacheTtl(conversationKey, ttl, now = Date.now()) {
  const wanted = normalizeCacheTtl(ttl)
  const key = String(conversationKey || '').trim()
  if (!key) return wanted
  const hit = conversationTtls.get(key)
  const pinned = hit && now - hit.at < CACHE_TTL_MS[hit.ttl] ? hit.ttl : wanted
  conversationTtls.delete(key)
  conversationTtls.set(key, { ttl: pinned, at: now })
  if (conversationTtls.size > CONVERSATION_TTL_LIMIT) {
    conversationTtls.delete(conversationTtls.keys().next().value)
  }
  return pinned
}

export function clearConversationCacheTtls() {
  conversationTtls.clear()
}

/**
 * Public Messages only accepts ephemeral { type, ttl }.
 * Official CC 2.1.241 may send `scope` with prompt-caching-scope beta;
 * Haiku and unofficial hops without that beta 400 Extra inputs.
 */
export function sanitizePublicCacheControl(control) {
  if (!control || typeof control !== 'object') return control
  if (control.type && control.type !== 'ephemeral') return control
  const out = { type: 'ephemeral' }
  if (control.ttl != null && String(control.ttl).trim()) out.ttl = control.ttl
  return out
}

export function dropCacheControlScope(control) {
  if (!control || typeof control !== 'object') return control
  if (!Object.prototype.hasOwnProperty.call(control, 'scope')) return control
  const { scope: _scope, ...rest } = control
  return rest
}

function setEphemeralTtl(control, ttl) {
  if (!control || typeof control !== 'object') return { type: 'ephemeral', ttl }
  if (control.type && control.type !== 'ephemeral') return control
  return { type: 'ephemeral', ttl }
}

function mapCacheControl(node, mapFn) {
  if (!node || typeof node !== 'object' || !node.cache_control) return node
  return { ...node, cache_control: mapFn(node.cache_control) }
}

/** Drop cache_control fields the public Messages schema rejects (scope, …). */
export function stripIllegalCacheControlFields(body) {
  if (!body || typeof body !== 'object') return body
  return walkCacheNodes(body, (node) => mapCacheControl(node, sanitizePublicCacheControl))
}
/** Drop caller cache_control (including nested tool_result.content & crag_prompt.blocks). */
export function removeCacheControlFields(body) {
  if (!body || typeof body !== 'object') return body
  const out = { ...body }
  delete out.cache_control
  const clearNode = (node) => {
    if (!node || typeof node !== 'object') return node
    let next = node
    if (Array.isArray(node.content)) {
      const content = node.content.map(clearNode)
      if (content.some((child, i) => child !== node.content[i])) {
        next = { ...next, content }
      }
    }
    if (Object.prototype.hasOwnProperty.call(next, 'cache_control')) {
      next = next === node ? { ...node } : next
      delete next.cache_control
    }
    return next
  }
  if (Array.isArray(out.tools)) out.tools = out.tools.map(clearNode)
  if (Array.isArray(out.system)) out.system = out.system.map(clearNode)
  if (Array.isArray(out.crag_prompt?.blocks)) {
    out.crag_prompt = { ...out.crag_prompt, blocks: out.crag_prompt.blocks.map(clearNode) }
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (!Array.isArray(message?.content)) return message
      const content = message.content.map(clearNode)
      return content.some((block, i) => block !== message.content[i]) ? { ...message, content } : message
    })
  }
  return out
}

function dropScopeOnNode(node) {
  if (!node || typeof node !== 'object' || !node.cache_control) return node
  if (!Object.prototype.hasOwnProperty.call(node.cache_control, 'scope')) return node
  return { ...node, cache_control: dropCacheControlScope(node.cache_control) }
}

export function stripCacheScopeFields(body) {
  if (!body || typeof body !== 'object') return body
  let changed = false
  const out = walkCacheNodes(body, (node) => {
    const next = dropScopeOnNode(node)
    if (next !== node) changed = true
    return next
  })
  return changed ? out : body
}

function setEphemeralTtlUnlessPinned(control, ttl) {
  if (!control || typeof control !== 'object') return { type: 'ephemeral', ttl }
  if (control.type && control.type !== 'ephemeral') return control
  if (String(control.ttl || '').trim()) return { type: 'ephemeral', ttl: normalizeCacheTtl(control.ttl) }
  return { type: 'ephemeral', ttl }
}

/** Anthropic treats a missing ttl as 5m. */
export function ephemeralCacheTtl(control) {
  if (!control || typeof control !== 'object') return null
  return String(control.ttl || '5m').toLowerCase() === '1h' ? '1h' : '5m'
}

function walkCacheNodes(body, mapFn) {
  const walkBlock = (node) => {
    if (!node || typeof node !== 'object') return node
    let next = node
    if (Array.isArray(node.content)) {
      const content = node.content.map(walkBlock)
      if (content.some((child, i) => child !== node.content[i])) {
        next = { ...node, content }
      }
    }
    return mapFn(next)
  }
  const out = { ...body }
  if (Array.isArray(out.tools)) out.tools = out.tools.map(mapFn)
  if (Array.isArray(out.system)) out.system = out.system.map(walkBlock)
  if (Array.isArray(out.crag_prompt?.blocks)) {
    const blocks = out.crag_prompt.blocks.map(walkBlock)
    if (blocks.some((block, i) => block !== out.crag_prompt.blocks[i])) {
      out.crag_prompt = { ...out.crag_prompt, blocks }
    }
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (!Array.isArray(message?.content)) return message
      const content = message.content.map(walkBlock)
      return content.some((block, i) => block !== message.content[i]) ? { ...message, content } : message
    })
  }
  if (out.cache_control) {
    const mapped = mapFn({ cache_control: out.cache_control })
    out.cache_control = mapped?.cache_control
  }
  return out
}

/**
 * Anthropic accepts 1h followed by 5m, but never the reverse. Missing TTL is
 * already a valid implicit 5m; the platform default only repairs invalid values.
 * Evaluate automatic caching last, after tools, system and message markers.
 */
export function enforceCacheTtlOrder(body, ttl = DEFAULT_CACHE_TTL) {
  if (!body || typeof body !== 'object') return body
  const fallback = normalizeCacheTtl(ttl)
  let short = false
  let changed = false
  const fix = (node) => {
    const control = node?.cache_control
    if (control?.type !== 'ephemeral') return node
    let target = control.ttl
    if (target != null && target !== '1h' && target !== '5m') target = fallback
    if (short && target === '1h') target = '5m'
    if (target !== '1h') short = true
    if (target === control.ttl) return node
    changed = true
    return { ...node, cache_control: { ...control, ttl: target } }
  }
  const out = walkCacheNodes(body, fix)
  return changed ? out : body
}

/** Normalize ephemeral TTLs without discarding scope or other marker fields. */
export function normalizeCacheTtlToBody(body, ttl = DEFAULT_CACHE_TTL) {
  if (!body || typeof body !== 'object') return body
  const target = normalizeCacheTtl(ttl)
  let changed = false
  const fix = (node) => {
    const control = node?.cache_control
    if (control?.type !== 'ephemeral' || control.ttl === target) return node
    changed = true
    return { ...node, cache_control: { ...control, ttl: target } }
  }
  const out = walkCacheNodes(body, fix)
  return changed ? out : body
}

/** Rewrite every outbound cache breakpoint to this request's resolved TTL. */
export function applyCacheTtlToBody(body, ttl = DEFAULT_CACHE_TTL) {
  const target = normalizeCacheTtl(ttl)
  if (!body || typeof body !== 'object') return body
  return walkCacheNodes(body, (node) =>
    node?.cache_control ? { ...node, cache_control: setEphemeralTtl(node.cache_control, target) } : node,
  )
}

export const MESSAGES_BREAKPOINT_MODES = Object.freeze(['off', 'fill', 'rewrite', 'tail', 'cli-hop'])

/**
 * Anthropic only caches a prefix that ends at a breakpoint, so a body with no
 * cache_control at all is billed full price every turn no matter what cache_ttl
 * says. `cache_ttl` retimes existing breakpoints; this config creates them.
 */
export const DEFAULT_CACHE_BREAKPOINTS = Object.freeze({
  enabled: true,
  preserve_client: true,
  system_tail: true,
  tools_tail: true,
  // rewrite removes caller-owned markers before rebuilding last + penultimate-user anchors.
  // HTTP hop uses this default; cli-hop calls applyMessageBreakpoints(..., 'rewrite') after stripping.

  messages: 'rewrite',
})

export function normalizeMessagesBreakpointMode(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (raw === 'off' || raw === 'none' || raw === 'false' || raw === '0' || raw === 'disabled') return 'off'
  if (raw === 'cli-hop' || raw === 'cli' || raw === 'leftover') return 'cli-hop'
  if (raw === 'tail' || raw === 'current-tail' || raw === 'single') return 'tail'
  if (raw === 'rewrite' || raw === 'replace' || raw === 'restamp' || raw === 'auto') return 'rewrite'
  if (raw === 'fill' || raw === 'true' || raw === '1') return 'fill'
  return DEFAULT_CACHE_BREAKPOINTS.messages
}

const bool = (value, fallback) => (value == null ? fallback : value !== false && String(value) !== 'false')

export function normalizeCacheBreakpoints(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: bool(src.enabled, DEFAULT_CACHE_BREAKPOINTS.enabled),
    preserve_client: bool(src.preserve_client, DEFAULT_CACHE_BREAKPOINTS.preserve_client),
    system_tail: bool(src.system_tail, DEFAULT_CACHE_BREAKPOINTS.system_tail),
    tools_tail: bool(src.tools_tail, DEFAULT_CACHE_BREAKPOINTS.tools_tail),
    messages: normalizeMessagesBreakpointMode(src.messages),
  }
}

export function cacheBreakpointsFromRouting(routing = {}) {
  return normalizeCacheBreakpoints(routing?.compatibility?.cache_breakpoints)
}

export function cacheBreakpointsFromRoutingFile(filePath) {
  if (!filePath) return normalizeCacheBreakpoints(null)
  try {
    const routing = readJsonParsedCached(filePath)
    if (!routing) return normalizeCacheBreakpoints(null)
    return cacheBreakpointsFromRouting(routing)
  } catch {
    return normalizeCacheBreakpoints(null)
  }
}

/**
 * Use the first inbound TTL in wire order. Persona or CLI assembly must not
 * introduce a later 1h marker after a caller-selected 5m prefix.
 */
export function highestInboundCacheTtl(body, fallback = DEFAULT_CACHE_TTL) {
  return bodyCacheTtl(body) ?? normalizeCacheTtl(fallback)
}

/**
 * The caller's own system breakpoint, which persona drops when it rebuilds the
 * array. Keep the last original marker on the outbound tail block, the closest
 * equivalent boundary.
 */
export function callerSystemCacheControl(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.system)) return null
  let found = null
  for (const block of body.system) {
    if (block?.cache_control && typeof block.cache_control === 'object') found = block.cache_control
  }
  return found
}

/** Keep a caller-selected ttl, fill only what is missing. null means "not cacheable". */
function politeEphemeral(control, ttl) {
  if (!control || typeof control !== 'object') return { type: 'ephemeral', ttl }
  if (control.type && control.type !== 'ephemeral') return null
  const existingTtl = String(control.ttl || '').trim()
  if (control.type === 'ephemeral' && existingTtl) return control
  return { ...control, type: 'ephemeral', ttl: existingTtl || ttl }
}

function stampNode(node, ttl) {
  if (!node || typeof node !== 'object') return node
  const next = politeEphemeral(node.cache_control, ttl)
  if (!next || next === node.cache_control) return node
  return { ...node, cache_control: next }
}

/** Only the literal boolean enables deferred loading. */
function isDeferredLoadingTool(tool) {
  return tool?.defer_loading === true || tool?.custom?.defer_loading === true
}

/**
 * The tail block is the only position that covers the whole system prefix, and
 * KIN keeps the caller's own system inside the array rather than moving it into
 * messages, so a breakpoint on an earlier block would exclude it.
 */
export function injectSystemTailBreakpoint(body, ttl = DEFAULT_CACHE_TTL) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.system) || body.system.length === 0) return body
  const idx = body.system.length - 1
  const stamped = stampNode(body.system[idx], normalizeCacheTtl(ttl))
  if (stamped === body.system[idx]) return body
  const system = body.system.slice()
  system[idx] = stamped
  return { ...body, system }
}

/**
 * Anthropic silently refuses to cache a prefix shorter than the model minimum,
 * so a breakpoint below it buys nothing while still being visible upstream —
 * and the official 4-block system carries no breakpoint of its own once the
 * agent slot is empty. Ordered longest-match-first; bare `opus-4` must not
 * swallow `opus-4-6`.
 */
const MIN_CACHEABLE_TOKEN_RULES = Object.freeze([
  [/mythos[-_](?:preview|beta)|preview[-_]mythos/, 2048],
  [/opus[-_]?4[-_.]8/, 1024],
  [/opus[-_]?4[-_.]7/, 2048],
  [/opus[-_]?4[-_.]6/, 4096],
  [/opus[-_]?4[-_.]5/, 4096],
  [/opus[-_]?4[-_.]1/, 1024],
  [/opus[-_]?4(?![-_.]?\d)/, 1024],
  [/opus[-_]?5/, 512],
  [/fable[-_]?5/, 512],
  [/mythos[-_]?5/, 512],
  [/sonnet[-_]?5/, 1024],
  [/sonnet[-_]?4(?:[-_.][56])?(?![-_.]?\d)/, 1024],
  [/haiku[-_]?4[-_.]5/, 4096],
  [/3[-_]5[-_]haiku|haiku[-_]?3[-_.]5/, 2048],
])

/** 1024 covers most of the catalog, so an unknown id lands on the common tier. */
export const DEFAULT_MIN_CACHEABLE_TOKENS = 1024

export function minCacheableTokens(model) {
  const id = String(model || '')
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, '')
  if (!id) return DEFAULT_MIN_CACHEABLE_TOKENS
  for (const [re, min] of MIN_CACHEABLE_TOKEN_RULES) {
    if (re.test(id)) return min
  }
  return DEFAULT_MIN_CACHEABLE_TOKENS
}

function blockChars(block) {
  if (typeof block === 'string') return block.length
  if (!block || typeof block !== 'object') return 0
  if (typeof block.text === 'string') return block.text.length
  try {
    return JSON.stringify(block).length
  } catch {
    return 0
  }
}

/**
 * Everything upstream hashes ahead of a system breakpoint: tools first, then
 * system. 4 chars per token under-counts CJK, which errs toward not marking —
 * the cheap mistake, since a missed breakpoint only costs a cache miss while a
 * useless one is a permanent shape difference from the official client.
 */
export function estimateCachePrefixTokens(body) {
  let chars = 0
  if (Array.isArray(body?.tools)) for (const tool of body.tools) chars += blockChars(tool)
  if (Array.isArray(body?.system)) for (const block of body.system) chars += blockChars(block)
  else chars += blockChars(body?.system)
  return Math.floor(chars / 4)
}

export function systemPrefixReachesCacheMinimum(body) {
  return estimateCachePrefixTokens(body) >= minCacheableTokens(body?.model)
}

function hasSystemBreakpoint(system) {
  return Array.isArray(system) && system.some((block) => block?.cache_control)
}

/** Anthropic rejects cache_control on a deferred tool. */
function stripDeferredToolCacheControl(body) {
  if (!Array.isArray(body.tools)) return body
  let changed = false
  const tools = body.tools.map((tool) => {
    if (!isDeferredLoadingTool(tool) || !tool?.cache_control) return tool
    changed = true
    const { cache_control: _drop, ...rest } = tool
    return rest
  })
  return changed ? { ...body, tools } : body
}

export function injectToolsTailBreakpoint(body, ttl = DEFAULT_CACHE_TTL) {
  if (!body || typeof body !== 'object') return body
  const out = stripDeferredToolCacheControl(body)
  if (!Array.isArray(out.tools) || out.tools.length === 0) return out
  let idx = -1
  for (let i = 0; i < out.tools.length; i++) {
    const tool = out.tools[i]
    if (!tool || typeof tool !== 'object') continue
    // KIN injects web_search as a server tool and it is often last; server
    // tools and deferred tools both reject the marker.
    if (isDeferredLoadingTool(tool) || isAnthropicServerTool(tool)) continue
    idx = i
  }
  if (idx < 0) return out
  const stamped = stampNode(out.tools[idx], normalizeCacheTtl(ttl))
  if (stamped === out.tools[idx]) return out
  const tools = out.tools.slice()
  tools[idx] = stamped
  return { ...out, tools }
}

function hasMessageBreakpoint(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some(
    (message) => Array.isArray(message?.content) && message.content.some((block) => block?.cache_control),
  )
}

function dropMessageBreakpoints(messages) {
  let changed = false
  const next = messages.map((message) => {
    if (!Array.isArray(message?.content)) return message
    let touched = false
    const content = message.content.map((block) => {
      if (!block || typeof block !== 'object' || !block.cache_control) return block
      touched = true
      const { cache_control: _drop, ...rest } = block
      return rest
    })
    if (!touched) return message
    changed = true
    return { ...message, content }
  })
  return changed ? next : messages
}

/** Promote strings and stamp the last non-thinking content block. */
function stampMessageTail(messages, idx, ttl) {
  const message = messages[idx]
  if (!message || typeof message !== 'object') return messages
  const marker = ttl == null ? { type: 'ephemeral' } : { type: 'ephemeral', ttl }
  const content = message.content
  if (typeof content === 'string') {
    const next = messages.slice()
    next[idx] = { ...message, content: [{ type: 'text', text: content, cache_control: marker }] }
    return next
  }
  if (!Array.isArray(content) || content.length === 0) return messages
  let target = -1
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i]?.type === 'thinking' || content[i]?.type === 'redacted_thinking') continue
    target = i
    break
  }
  if (target < 0) return messages
  const stamped = ttl == null ? { ...content[target], cache_control: marker } : stampNode(content[target], ttl)
  if (stamped === content[target]) return messages
  const nextContent = content.slice()
  nextContent[target] = stamped
  const next = messages.slice()
  next[idx] = { ...message, content: nextContent }
  return next
}

/**
 * `tail` matches current Claude Code: exactly one message-level marker on the
 * current tail. `rewrite` retains the generic Messages two-anchor policy.
 * `fill` preserves caller markers and uses that policy only when none exist.
 */
function penultimateUserIndex(messages) {
  if (!Array.isArray(messages) || messages.length < 4) return -1
  let userCount = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user') continue
    userCount++
    if (userCount === 2) return i
  }
  return -1
}

/** Empty control turns have no block to hang cache_control on. */
function lastStampableMessageIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content
    if (typeof content === 'string' && content) return i
    if (Array.isArray(content) && content.length > 0) return i
  }
  return -1
}

export function applyMessageBreakpoints(body, ttl = DEFAULT_CACHE_TTL, mode = DEFAULT_CACHE_BREAKPOINTS.messages) {
  const resolved = normalizeMessagesBreakpointMode(mode)
  if (resolved === 'off') return body
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || body.messages.length === 0) return body
  if (resolved === 'fill' && hasMessageBreakpoint(body.messages)) return body
  const target = normalizeCacheTtl(ttl)
  let messages = resolved === 'fill' ? body.messages : dropMessageBreakpoints(body.messages)
  if (resolved === 'cli-hop') {
    return messages === body.messages ? body : { ...body, messages }
  }
  const tail = lastStampableMessageIndex(messages)
  if (tail >= 0) messages = stampMessageTail(messages, tail, target)
  if (resolved !== 'tail') {
    const prevUser = penultimateUserIndex(messages)
    if (prevUser >= 0) messages = stampMessageTail(messages, prevUser, target)
  }
  return messages === body.messages ? body : { ...body, messages }
}

/** Bounded marker inventory for diagnostics. No prompt or image bytes. */
export function listCacheMarkers(body) {
  const hits = []
  const ttlOf = (control) => {
    if (!control || typeof control !== 'object') return null
    return control.ttl ? normalizeCacheTtl(control.ttl) : null
  }
  if (body?.cache_control) hits.push({ section: 'body', index: 0, ttl: ttlOf(body.cache_control), type: 'body' })
  if (Array.isArray(body?.system)) {
    for (const [index, block] of body.system.entries()) {
      if (block?.cache_control) {
        hits.push({ section: 'system', index, ttl: ttlOf(block.cache_control), type: block.type || 'text' })
      }
    }
  }
  if (Array.isArray(body?.tools)) {
    for (const [index, tool] of body.tools.entries()) {
      if (tool?.cache_control) {
        hits.push({ section: 'tools', index, ttl: ttlOf(tool.cache_control), type: tool.type || 'function' })
      }
    }
  }
  if (Array.isArray(body?.messages)) {
    for (const [index, message] of body.messages.entries()) {
      if (!Array.isArray(message?.content)) continue
      for (const [blockIndex, block] of message.content.entries()) {
        if (!block?.cache_control) continue
        hits.push({
          section: 'messages',
          index,
          blockIndex,
          role: message.role || null,
          ttl: ttlOf(block.cache_control),
          type: block.type || 'text',
        })
      }
    }
  }
  return hits
}

/**
 * tools → system → messages matches the order Anthropic evaluates breakpoints,
 * so a uniform ttl never produces an illegal 1h-after-5m sequence.
 */
export function applyCacheBreakpoints(body, { ttl = DEFAULT_CACHE_TTL, config, inbound } = {}) {
  const cfg = normalizeCacheBreakpoints(config)
  if (!cfg.enabled) return body
  const source = inbound && typeof inbound === 'object' ? inbound : body
  const target = highestInboundCacheTtl(source, ttl)
  let out = fillMissingCacheTtl(body, target)
  if (cfg.tools_tail) out = injectToolsTailBreakpoint(out, target)
  const caller = cfg.preserve_client ? callerSystemCacheControl(source) : null
  // A template that marks its own boundary (the official agent slot) already has
  // the prefix it wants; a second marker on the tail would only widen it over the
  // caller's --system leftover and burn one of the four slots.
  if (!hasSystemBreakpoint(out.system)) {
    if (caller) {
      out = injectSystemTailBreakpoint(out, caller.ttl ? normalizeCacheTtl(caller.ttl) : target)
    } else if (cfg.system_tail && systemPrefixReachesCacheMinimum(out)) {
      out = injectSystemTailBreakpoint(out, target)
    }
  }
  const mode = cfg.preserve_client && hasMessageBreakpoint(out.messages) ? 'fill' : cfg.messages
  out = applyMessageBreakpoints(out, target, mode)
  return enforceCacheTtlOrder(out, target)
}

function n(v) {
  return Number(v) || 0
}

/**
 * Preserve reported cache-write buckets, including legal mixed-TTL requests.
 * Only an unclassified total (or a delta above the start split) needs a fallback.
 */
export function applyCacheTtlToUsage(usage, ttl = DEFAULT_CACHE_TTL) {
  if (!usage || typeof usage !== 'object') return usage
  const target = normalizeCacheTtl(ttl)
  const out = { ...usage, cache_ttl: target }
  if (usage.cache_creation && typeof usage.cache_creation === 'object') {
    out.cache_creation = { ...usage.cache_creation }
  }
  const five = n(out.cache_creation_5m_tokens ?? out.cache_creation?.ephemeral_5m_input_tokens)
  const hour = n(out.cache_creation_1h_tokens ?? out.cache_creation?.ephemeral_1h_input_tokens)
  const create = n(out.cache_creation_input_tokens ?? out.cache_creation_tokens)
  // message_delta can raise the total without resending the message_start split.
  const total = Math.max(five + hour, create)
  if (!total) return out
  if (five + hour > 0) {
    const remainder = total - five - hour
    out.cache_creation_5m_tokens = five + (target === '5m' ? remainder : 0)
    out.cache_creation_1h_tokens = hour + (target === '1h' ? remainder : 0)
    out.cache_creation = {
      ...out.cache_creation,
      ephemeral_5m_input_tokens: out.cache_creation_5m_tokens,
      ephemeral_1h_input_tokens: out.cache_creation_1h_tokens,
    }
    return out
  }
  if (target === '1h') {
    out.cache_creation_1h_tokens = total
    out.cache_creation_5m_tokens = 0
    if (!out.cache_creation) out.cache_creation = {}
    out.cache_creation.ephemeral_1h_input_tokens = total
    out.cache_creation.ephemeral_5m_input_tokens = 0
  } else {
    out.cache_creation_5m_tokens = total
    out.cache_creation_1h_tokens = 0
    if (!out.cache_creation) out.cache_creation = {}
    out.cache_creation.ephemeral_5m_input_tokens = total
    out.cache_creation.ephemeral_1h_input_tokens = 0
  }
  return out
}
