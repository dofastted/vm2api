/**
 * Anthropic cache_control ttl for unofficial OAuth.
 * Default 5m (1.25× input). Customers may request 1h (2× input);
 * billing must use the 1h bucket so the difference is charged.
 */
import fs from 'node:fs'
import { isAnthropicServerTool } from './web-search.mjs'

export const DEFAULT_CACHE_TTL = '5m'
export const CACHE_TTL_HEADER = 'x-kin-cache-ttl'

export function normalizeCacheTtl(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!raw) return DEFAULT_CACHE_TTL
  if (raw === '1h' || raw === '1hr' || raw === '60m' || raw === '3600' || raw === 'hour' || raw === '1hour') return '1h'
  if (raw === '5m' || raw === '5min' || raw === '300' || raw === 'default') return '5m'
  return DEFAULT_CACHE_TTL
}

export function cacheTtlFromRouting(routing = {}) {
  return normalizeCacheTtl(routing?.compatibility?.cache_ttl)
}

export function cacheTtlFromRoutingFile(filePath) {
  if (!filePath) return DEFAULT_CACHE_TTL
  try {
    return cacheTtlFromRouting(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch {
    return DEFAULT_CACHE_TTL
  }
}

/** True when the caller already asked for a 1h breakpoint. */
export function bodyRequestsHourCache(body) {
  if (!body || typeof body !== 'object') return false
  const hour = (control) => ephemeralCacheTtl(control) === '1h'
  if (hour(body.cache_control)) return true
  if (Array.isArray(body.tools) && body.tools.some((tool) => hour(tool?.cache_control))) return true
  if (Array.isArray(body.system) && body.system.some((block) => hour(block?.cache_control))) return true
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!Array.isArray(message?.content)) continue
      if (message.content.some((block) => hour(block?.cache_control))) return true
    }
  }
  return false
}

/** Header, then inbound 1h, then routing.json, then 5m. Official traffic owns its breakpoints. */
export function resolveCacheTtl({ headers = {}, body, routing, routingFile, officialTraffic = false } = {}) {
  if (officialTraffic) return null
  const hdr = headers[CACHE_TTL_HEADER] || headers['X-Kin-Cache-Ttl']
  if (hdr != null && String(hdr).trim()) return normalizeCacheTtl(hdr)
  if (bodyRequestsHourCache(body)) return '1h'
  if (routing) return cacheTtlFromRouting(routing)
  return cacheTtlFromRoutingFile(routingFile)
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

function sanitizeSystemCacheControl(control) {
  return sanitizePublicCacheControl(control)
}

/** Drop cache_control fields the public Messages schema rejects (scope, …). */
export function stripIllegalCacheControlFields(body) {
  if (!body || typeof body !== 'object') return body
  const out = { ...body }
  if (out.cache_control) out.cache_control = sanitizePublicCacheControl(out.cache_control)
  if (Array.isArray(out.system)) {
    out.system = out.system.map((block) => mapCacheControl(block, sanitizeSystemCacheControl))
  }
  if (Array.isArray(out.tools)) {
    out.tools = out.tools.map((tool) => mapCacheControl(tool, sanitizePublicCacheControl))
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (!Array.isArray(message?.content)) return message
      return {
        ...message,
        content: message.content.map((block) => mapCacheControl(block, sanitizePublicCacheControl)),
      }
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
  const map = (node) => {
    const next = dropScopeOnNode(node)
    if (next !== node) changed = true
    return next
  }
  const out = { ...body }
  if (out.cache_control && Object.prototype.hasOwnProperty.call(out.cache_control, 'scope')) {
    out.cache_control = dropCacheControlScope(out.cache_control)
    changed = true
  }
  if (Array.isArray(out.system)) out.system = out.system.map(map)
  if (Array.isArray(out.tools)) out.tools = out.tools.map(map)
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (!Array.isArray(message?.content)) return message
      const content = message.content.map(map)
      if (content.some((block, i) => block !== message.content[i])) {
        changed = true
        return { ...message, content }
      }
      return message
    })
  }
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

function downgradePinnedHourToFive() {
  return { type: 'ephemeral', ttl: '5m' }
}

function upgradeFiveToHour() {
  return { type: 'ephemeral', ttl: '1h' }
}

function walkCacheNodes(body, mapFn) {
  const out = { ...body }
  if (out.cache_control) {
    const mapped = mapFn({ cache_control: out.cache_control })
    out.cache_control = mapped?.cache_control
  }
  if (Array.isArray(out.tools)) out.tools = out.tools.map(mapFn)
  if (Array.isArray(out.system)) out.system = out.system.map(mapFn)
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (!Array.isArray(message?.content)) return message
      const content = message.content.map(mapFn)
      return content.some((block, i) => block !== message.content[i]) ? { ...message, content } : message
    })
  }
  return out
}

/**
 * Anthropic processes breakpoints in order: tools → system → messages.
 * A ttl=1h block must not appear after a ttl=5m block.
 * Caller last-tool 5m + KIN expansion 1h is the live 400.
 * honorHour: keep caller 1h and upgrade earlier 5m instead of wiping the 1h.
 */
export function enforceCacheTtlOrder(body, { honorHour = false } = {}) {
  if (!body || typeof body !== 'object') return body
  if (honorHour) return honorHourCacheTtlOrder(body)
  let seen5m = false
  let changed = false
  const fix = (node) => {
    if (!node || typeof node !== 'object' || !node.cache_control) return node
    const ttl = ephemeralCacheTtl(node.cache_control)
    if (ttl === '1h' && seen5m) {
      changed = true
      return { ...node, cache_control: downgradePinnedHourToFive() }
    }
    if (ttl === '5m') seen5m = true
    return node
  }
  const out = walkCacheNodes(body, fix)
  return changed ? out : body
}

function honorHourCacheTtlOrder(body) {
  const ttls = []
  const record = (node) => {
    if (!node || typeof node !== 'object' || !node.cache_control) return node
    ttls.push(ephemeralCacheTtl(node.cache_control))
    return node
  }
  walkCacheNodes(body, record)
  let last1h = -1
  for (let i = 0; i < ttls.length; i++) if (ttls[i] === '1h') last1h = i
  if (last1h < 0) return body
  let need = false
  for (let i = 0; i < last1h; i++) {
    if (ttls[i] === '5m') {
      need = true
      break
    }
  }
  if (!need) return body
  let idx = 0
  const fix = (node) => {
    if (!node || typeof node !== 'object' || !node.cache_control) return node
    const at = idx++
    if (at < last1h && ephemeralCacheTtl(node.cache_control) === '5m') {
      return { ...node, cache_control: upgradeFiveToHour() }
    }
    return node
  }
  return walkCacheNodes(body, fix)
}

/**
 * System is gateway-rebuilt: stamp the resolved ttl.
 * Tools/messages keep a caller ttl; fill only when missing.
 * Mixed 5m-then-1h upgrades the earlier 5m so a caller 1h is not wiped.
 */
export function applyCacheTtlToBody(body, ttl = DEFAULT_CACHE_TTL) {
  const target = normalizeCacheTtl(ttl)
  if (!body || typeof body !== 'object') return body
  const out = { ...body }
  if (out.cache_control) out.cache_control = setEphemeralTtlUnlessPinned(out.cache_control, target)
  if (Array.isArray(out.system)) {
    out.system = out.system.map((block) =>
      block?.cache_control ? { ...block, cache_control: setEphemeralTtl(block.cache_control, target) } : block,
    )
  }
  if (Array.isArray(out.tools)) {
    out.tools = out.tools.map((tool) =>
      tool?.cache_control ? { ...tool, cache_control: setEphemeralTtlUnlessPinned(tool.cache_control, target) } : tool,
    )
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (!Array.isArray(message?.content)) return message
      return {
        ...message,
        content: message.content.map((block) =>
          block?.cache_control
            ? { ...block, cache_control: setEphemeralTtlUnlessPinned(block.cache_control, target) }
            : block,
        ),
      }
    })
  }
  const honorHour = target === '1h' || bodyRequestsHourCache(out)
  return enforceCacheTtlOrder(out, { honorHour })
}

export const MESSAGES_BREAKPOINT_MODES = Object.freeze(['off', 'fill', 'rewrite'])

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
  // rewrite: Claude Code stamps the current last user; fill would leave that
  // wandering marker and freeze hits at the system prefix (~43.5k).
  messages: 'rewrite',
})

export function normalizeMessagesBreakpointMode(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (raw === 'off' || raw === 'none' || raw === 'false' || raw === '0' || raw === 'disabled') return 'off'
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
    return cacheBreakpointsFromRouting(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch {
    return normalizeCacheBreakpoints(null)
  }
}

/**
 * enforceCacheTtlOrder downgrades a 1h block that lands after a 5m one, so
 * injecting 5m ahead of a caller's 1h breakpoint would silently kill the
 * caller's intent. Inject at the highest tier the body already asks for.
 *
 * Read this from the inbound body: persona rebuilds `system` from a template and
 * drops the caller's blocks, so by outbound time the 1h marker may be gone.
 */
export function highestInboundCacheTtl(body, fallback = DEFAULT_CACHE_TTL) {
  return bodyRequestsHourCache(body) ? '1h' : normalizeCacheTtl(fallback)
}

/**
 * The caller's own system breakpoint, which persona drops when it rebuilds the
 * array. sub2api keeps the last original marker as the closest equivalent
 * boundary; the outbound tail block is that boundary here.
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
  if (String(control.ttl || '').trim()) return control
  return { ...control, type: 'ephemeral', ttl }
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

/** A string content block has no place to hang the marker, so promote it first. */
function stampMessageTail(messages, idx, ttl) {
  const message = messages[idx]
  if (!message || typeof message !== 'object') return messages
  const content = message.content
  if (typeof content === 'string') {
    const next = messages.slice()
    next[idx] = { ...message, content: [{ type: 'text', text: content, cache_control: { type: 'ephemeral', ttl } }] }
    return next
  }
  if (!Array.isArray(content) || content.length === 0) return messages
  const last = content.length - 1
  const stamped = stampNode(content[last], ttl)
  if (stamped === content[last]) return messages
  const nextContent = content.slice()
  nextContent[last] = stamped
  const next = messages.slice()
  next[idx] = { ...message, content: nextContent }
  return next
}

/**
 * Last message plus, when messages.length >= 4, the second-to-last user
 * (sub2api/Parrot addMessageCacheBreakpoints). CLI hop then drops the last
 * marker because wrap CLI restamps the current last user.
 *
 * `fill` leaves a body that already carries caller breakpoints alone.
 * `rewrite` drops everything, then re-mark.
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

export function applyMessageBreakpoints(body, ttl = DEFAULT_CACHE_TTL, mode = DEFAULT_CACHE_BREAKPOINTS.messages) {
  const resolved = normalizeMessagesBreakpointMode(mode)
  if (resolved === 'off') return body
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || body.messages.length === 0) return body
  if (resolved === 'fill' && hasMessageBreakpoint(body.messages)) return body
  const target = normalizeCacheTtl(ttl)
  let messages = resolved === 'rewrite' ? dropMessageBreakpoints(body.messages) : body.messages
  messages = stampMessageTail(messages, messages.length - 1, target)
  const prevUser = penultimateUserIndex(messages)
  if (prevUser >= 0) messages = stampMessageTail(messages, prevUser, target)
  return messages === body.messages ? body : { ...body, messages }
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
  let out = body
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
  out = applyMessageBreakpoints(out, target, cfg.messages)
  return out
}

function n(v) {
  return Number(v) || 0
}

/**
 * Put cache-creation tokens into the TTL we actually sent.
 * If Anthropic omitted the 5m/1h split, or reported 5m after we sent 1h,
 * reclassify so pricing charges the 1h difference.
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
  let total = five + hour
  if (!total && create) total = create
  if (!total) return out
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
