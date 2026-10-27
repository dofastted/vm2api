/**
 * Detects when a continuing conversation stops being a prefix of its previous
 * turn. Anthropic only reads cache up to the first changed byte, and only at a
 * breakpoint or within 20 blocks before one, so a break far behind the tail
 * falls back to the system prefix unless a marker is moved in front of it.
 *
 * Marker movement is not a history break: cache_control is stripped before
 * hashing. Image bytes and prompt text are never stored.
 */
import { createHash } from 'node:crypto'
import { listCacheMarkers, normalizeCacheTtl } from './cache-ttl.mjs'

const SESSION_LIMIT = 10_000
/** Longest cache TTL; an older turn cannot be read anyway. */
const SESSION_IDLE_MS = 60 * 60_000
const sessions = new Map()
/** Image floors outlive the cache: a session that drops images keeps dropping them. */
const IMAGE_SESSION_IDLE_MS = 24 * 60 * 60_000
const imageSessions = new Map()
/** Images within the last IMAGE_WINDOW messages always stay; see retainImages. */
const IMAGE_WINDOW = 24
/** Cache entries written by recent turns, per session; anchors only read these. */
const WRITE_LIMIT = 64
const IMAGE_TYPES = new Set(['image', 'input_image', 'image_url'])
/** Anthropic accepts at most four cache breakpoints per request. */
const MAX_CACHE_MARKERS = 4

// oh-my-pi drops the oldest images once a request passes its provider image
// budget (coding-agent session/provider-image-budget.ts). A dropped image leaves
// no text, except that an image-only result becomes this text. Its Anthropic
// serializer labels an image-only tool result and hoists error-result images
// behind a caption (pi-ai providers/anthropic.ts); both labels vanish with the
// image. The canonical stripped form below reproduces exactly that, so a
// message reads the same whether this gateway or the client removed the image.
export const DROPPED_IMAGE_TEXT = '[image omitted: provider image limit]'
const IMAGE_ONLY_TEXTS = new Set(['(see attached image)', DROPPED_IMAGE_TEXT])
const HOISTED_IMAGES_TEXT = 'Attached image(s) from the tool result(s) above:'

function digest(value) {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
    .slice(0, 16)
}

function firstDivergence(previous, current) {
  const shared = Math.min(previous.length, current.length)
  for (let i = 0; i < shared; i++) {
    if (previous[i] !== current[i]) return i
  }
  return previous.length > current.length ? shared : -1
}

function withoutCacheControl(value) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(withoutCacheControl)
  const out = {}
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'cache_control') continue
    out[key] = withoutCacheControl(nested)
  }
  return out
}
function imageMeta(block) {
  const source = block?.source && typeof block.source === 'object' ? block.source : block
  const data = source?.data || source?.base64 || block?.data || ''
  const url = source?.url || block?.image_url?.url || block?.url || null
  return {
    type: block?.type || 'image',
    media_type: source?.media_type || block?.media_type || null,
    url: Boolean(url),
    bytes: typeof data === 'string' ? data.length : 0,
    digest: typeof data === 'string' && data ? digest(data) : url ? digest(url) : null,
  }
}

function partKind(block) {
  if (typeof block === 'string') return { kind: 'text', digest: digest(block) }
  if (!block || typeof block !== 'object') return { kind: 'structure', digest: digest(block) }
  const type = block.type
  if (IMAGE_TYPES.has(type) || block.source || block.image_url) {
    return { kind: 'image', digest: digest(imageMeta(block)) }
  }
  if (type === 'text' || type === 'input_text') return { kind: 'text', digest: digest(block.text || '') }
  return { kind: 'structure', digest: digest(withoutCacheControl(block)) }
}

// Same official reminder as outbound-attempt.mjs. Detector only: a tool result
// may legally contain this string, so nothing here rewrites it.
const VOLATILE_CONTEXT_BUDGET = /<total_tokens>\d+ tokens left<\/total_tokens>/g
const CONTEXT_BUDGET_PLACEHOLDER = '<total_tokens>0 tokens left</total_tokens>'

function stringStamp(text) {
  const stamp = { t: 's', n: text.length, d: digest(text) }
  if (!text.includes('<total_tokens>')) return stamp
  stamp.total_tokens = true
  stamp.norm = digest(text.replace(VOLATILE_CONTEXT_BUDGET, CONTEXT_BUDGET_PLACEHOLDER))
  return stamp
}

function normalizeCounters(value) {
  if (typeof value === 'string') {
    return value.includes('<total_tokens>') ? value.replace(VOLATILE_CONTEXT_BUDGET, CONTEXT_BUDGET_PLACEHOLDER) : value
  }
  if (Array.isArray(value)) return value.map(normalizeCounters)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      if (key === 'cache_control') continue
      out[key] = normalizeCounters(value[key])
    }
    return out
  }
  return value
}

function valueStamp(value, depth = 0) {
  if (typeof value === 'string') return stringStamp(value)
  if (typeof value === 'number' || typeof value === 'boolean') return { t: typeof value, v: value, d: digest(value) }
  if (value == null) return { t: 'null', d: digest(null) }
  if (Array.isArray(value)) {
    const stamp = { t: 'a', n: value.length, d: digest(value), norm: digest(normalizeCounters(value)) }
    if (depth < 3) stamp.items = value.slice(0, 6).map((item) => valueStamp(item, depth + 1))
    return stamp
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => key !== 'cache_control')
    const stamp = { t: 'o', keys, d: digest(value), norm: digest(normalizeCounters(value)) }
    if (depth < 3) {
      stamp.fields = {}
      for (const key of keys) stamp.fields[key] = valueStamp(value[key], depth + 1)
    }
    return stamp
  }
  return { t: typeof value }
}

function stampDelta(prev, next) {
  if (!prev || !next) return { change: 'missing' }
  if (prev.d && prev.d === next.d) return null
  if (prev.norm && next.norm && prev.norm === next.norm) {
    return { change: 'counter_only', prev_n: prev.n, next_n: next.n }
  }
  if (prev.t !== next.t) return { change: 'type', prev_t: prev.t, next_t: next.t }
  if (prev.t === 's') {
    if (prev.norm && next.norm && prev.norm === next.norm) {
      return { change: 'counter_only', prev_n: prev.n, next_n: next.n }
    }
    return {
      change: prev.n === next.n ? 'value' : 'length',
      prev_n: prev.n,
      next_n: next.n,
      ...(prev.total_tokens || next.total_tokens ? { total_tokens: true } : {}),
    }
  }
  if (prev.t === 'number' || prev.t === 'boolean' || prev.t === 'null') {
    return prev.v === next.v ? null : { change: 'value' }
  }
  if (prev.t === 'a') {
    if (prev.n !== next.n) return { change: 'length', prev_n: prev.n, next_n: next.n }
    const changed = []
    const seen = Math.min(prev.items?.length || 0, next.items?.length || 0)
    for (let i = 0; i < seen; i++) {
      const delta = stampDelta(prev.items[i], next.items[i])
      if (delta) changed.push({ index: i, ...delta })
    }
    if (seen < prev.n) {
      return {
        change: 'unknown',
        capped: true,
        prev_n: prev.n,
        next_n: next.n,
        ...(changed.length ? { sampled: changed.slice(0, 8) } : {}),
      }
    }
    if (!changed.length) return { change: 'value', prev_n: prev.n, next_n: next.n }
    return { change: 'items', prev_n: prev.n, next_n: next.n, changed: changed.slice(0, 8) }
  }
  if (prev.t === 'o') {
    if (!prev.fields || !next.fields) return { change: 'unknown', capped: true }
    const added = next.keys.filter((key) => !prev.keys.includes(key))
    const removed = prev.keys.filter((key) => !next.keys.includes(key))
    const keyOrder = !added.length && !removed.length && prev.keys.join('\0') !== next.keys.join('\0')
    const changed = []
    for (const key of prev.keys) {
      if (!Object.prototype.hasOwnProperty.call(next.fields, key)) continue
      const delta = stampDelta(prev.fields[key], next.fields[key])
      if (delta) changed.push({ key, ...delta })
    }
    if (!added.length && !removed.length && !keyOrder && !changed.length) {
      return { change: 'unknown', capped: false }
    }
    const out = {}
    if (added.length) out.added = added
    if (removed.length) out.removed = removed
    if (keyOrder) out.key_order = true
    if (changed.length) out.changed = changed.slice(0, 8)
    return out
  }
  return { change: 'value' }
}

function partRecord(block) {
  const classified = partKind(block)
  const clean = typeof block === 'string' ? block : withoutCacheControl(block)
  return {
    kind: classified.kind,
    digest: classified.digest,
    type: typeof block === 'string' ? 'string' : block?.type || null,
    stamp: valueStamp(clean),
  }
}

function contentParts(content) {
  if (typeof content === 'string') return [partRecord(content)]
  if (!Array.isArray(content)) return [partRecord(content)]
  return content.map(partRecord)
}

function isImagePart(block) {
  return !!block && typeof block === 'object' && IMAGE_TYPES.has(block.type)
}

/** Images this gateway could strip: top-level blocks and tool_result content. */
export function messageImageCount(message) {
  const content = message?.content
  if (!Array.isArray(content)) return 0
  let count = 0
  for (const block of content) {
    if (isImagePart(block)) count++
    else if (block?.type === 'tool_result' && Array.isArray(block.content)) {
      for (const inner of block.content) if (isImagePart(inner)) count++
    }
  }
  return count
}

function onlyImageLabels(blocks) {
  return blocks.every((block) => block?.type === 'text' && IMAGE_ONLY_TEXTS.has(block.text))
}

function stripToolResultImages(block) {
  if (!Array.isArray(block.content)) return block
  const kept = block.content.filter((inner) => !isImagePart(inner))
  const removed = kept.length !== block.content.length
  const labelsOnly = kept.length > 0 && onlyImageLabels(kept)
  if (!removed && !labelsOnly) return block
  if (kept.length && !labelsOnly) return { ...block, content: kept }
  if (!removed && kept.length === 1 && kept[0].text === DROPPED_IMAGE_TEXT) return block
  return { ...block, content: [{ type: 'text', text: DROPPED_IMAGE_TEXT }] }
}

/**
 * The message as oh-my-pi sends it after dropping every image in it. A marker
 * that sat on a removed image moves to the new last non-thinking block.
 */
export function stripMessageImages(message) {
  const content = message?.content
  if (!Array.isArray(content)) return message
  let changed = false
  let carried = null
  const kept = []
  for (const block of content) {
    if (isImagePart(block) || (block?.type === 'text' && block.text === HOISTED_IMAGES_TEXT)) {
      changed = true
      if (block.cache_control) carried = block.cache_control
      continue
    }
    const next = block?.type === 'tool_result' ? stripToolResultImages(block) : block
    if (next !== block) changed = true
    kept.push(next)
  }
  if (!changed) return message
  if (!kept.length || onlyImageLabels(kept)) {
    const control = kept.find((block) => block.cache_control)?.cache_control || carried
    kept.splice(0, kept.length, {
      type: 'text',
      text: DROPPED_IMAGE_TEXT,
      ...(control ? { cache_control: control } : {}),
    })
  } else if (carried && !kept.some((block) => block?.cache_control)) {
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i]?.type === 'thinking' || kept[i]?.type === 'redacted_thinking') continue
      kept[i] = { ...kept[i], cache_control: carried }
      break
    }
  }
  return { ...message, content: kept }
}

/**
 * What survives a client-side image drop and marker stamping: no images, no
 * cache_control, and string content as the one text block a marker turns it into.
 * `clean` is already free of cache_control; `hash` is its digest when known.
 */
function identityOf(clean, hash = null) {
  const blocks =
    typeof clean?.content === 'string' ? { ...clean, content: [{ type: 'text', text: clean.content }] } : clean
  const bare = stripMessageImages(blocks)
  return bare === clean && hash ? hash : digest(bare)
}

function messageIdentity(message) {
  return identityOf(withoutCacheControl(message))
}

function messageRecord(message) {
  const clean = withoutCacheControl(message)
  const images = messageImageCount(message)
  const hash = digest(clean)
  const record = {
    hash,
    role: message?.role || null,
    keys: clean && typeof clean === 'object' && !Array.isArray(clean) ? Object.keys(clean) : [],
    parts: contentParts(message?.content),
    id: identityOf(clean, hash),
  }
  return images ? { ...record, images } : record
}

function keyDelta(previous, next) {
  const prevKeys = previous || []
  const nextKeys = next || []
  const added = nextKeys.filter((key) => !prevKeys.includes(key))
  const removed = prevKeys.filter((key) => !nextKeys.includes(key))
  const keyOrder = !added.length && !removed.length && prevKeys.join('\0') !== nextKeys.join('\0')
  if (!added.length && !removed.length && !keyOrder) return null
  return {
    reason: keyOrder ? 'key_order' : 'message_fields',
    ...(added.length ? { added } : {}),
    ...(removed.length ? { removed } : {}),
    ...(keyOrder ? { key_order: true } : {}),
  }
}

function messageDiff(previous, current) {
  if (!previous || !current) {
    return {
      reason: 'missing',
      prev_n: previous?.parts.length ?? 0,
      next_n: current?.parts.length ?? 0,
      prev_types: (previous?.parts || []).map((part) => part.type || part.kind),
      next_types: (current?.parts || []).map((part) => part.type || part.kind),
    }
  }
  if (previous.role !== current.role) return { reason: 'role', prev: previous.role, next: current.role }
  if (previous.parts.length !== current.parts.length) {
    return {
      reason: 'part_count',
      prev_n: previous.parts.length,
      next_n: current.parts.length,
      prev_types: previous.parts.map((part) => part.type || part.kind),
      next_types: current.parts.map((part) => part.type || part.kind),
    }
  }
  for (let i = 0; i < previous.parts.length; i++) {
    const left = previous.parts[i]
    const right = current.parts[i]
    if (left.kind !== right.kind) {
      return { reason: 'part_kind', part: i, prev: left.type || left.kind, next: right.type || right.kind }
    }
    if (left.digest !== right.digest) {
      return {
        reason: 'part',
        part: i,
        type: left.type || left.kind,
        fields: stampDelta(left.stamp, right.stamp) || { change: 'digest' },
      }
    }
  }
  return keyDelta(previous.keys, current.keys) || { reason: 'digest' }
}

function snapshotBody(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return {
    tools: digest(withoutCacheControl(body?.tools)),
    tool_names: tools.map((tool) => tool?.name || null),
    system: digest(withoutCacheControl(body?.system)),
    messages: messages.map(messageRecord),
  }
}

function toolsDiff(previous, current) {
  const prevNames = previous?.tool_names || []
  const nextNames = current?.tool_names || []
  const added = nextNames.filter((name) => !prevNames.includes(name))
  const removed = prevNames.filter((name) => !nextNames.includes(name))
  return {
    reason: added.length || removed.length ? 'tool_names' : 'tool_fields',
    prev_n: prevNames.length,
    next_n: nextNames.length,
    ...(added.length ? { added } : {}),
    ...(removed.length ? { removed } : {}),
  }
}

function messageBreak(previous, current) {
  const prevHashes = previous.messages.map((message) => message.hash)
  const currHashes = current.messages.map((message) => message.hash)
  const index = firstDivergence(prevHashes, currHashes)
  if (index < 0) return null
  return {
    section: 'messages',
    index,
    kind: classifyParts(previous.messages[index], current.messages[index]),
    diff: messageDiff(previous.messages[index], current.messages[index]),
  }
}

function sectionDiffs(previous, current) {
  const sections = []
  if (previous.tools !== current.tools) {
    sections.push({ section: 'tools', index: null, kind: 'structure', diff: toolsDiff(previous, current) })
  }
  if (previous.system !== current.system) sections.push({ section: 'system', index: null, kind: 'text' })
  const messages = messageBreak(previous, current)
  if (messages) sections.push(messages)
  return sections
}

function comparePrefix(previous, current) {
  if (!previous) return { turn: 1, break: null }
  const turn = (previous.turn || 0) + 1
  const sections = sectionDiffs(previous, current)
  if (!sections.length) return { turn, break: null }
  return { turn, break: sections.length > 1 ? { ...sections[0], sections } : sections[0] }
}

function classifyParts(previous, current) {
  if (!previous || !current) return 'structure'
  if (previous.role !== current.role || previous.parts.length !== current.parts.length) return 'structure'
  for (let i = 0; i < previous.parts.length; i++) {
    const left = previous.parts[i]
    const right = current.parts[i]
    if (left.kind !== right.kind) return 'structure'
    if (left.digest !== right.digest) return left.kind
  }
  return 'structure'
}

/**
 * Same-request inbound vs Node outbound differences. No prompt/image bytes.
 * Every changed section is returned. A tools difference must not hide a
 * message difference. `kind=structure` is not a wire field and does not prove
 * the block list changed: a tool_result body edit, an extra key, or key order
 * also land here.
 */
export function firstHistoryDiff(inbound, outbound) {
  if (!inbound || !outbound || typeof inbound !== 'object' || typeof outbound !== 'object') {
    return { section: null, index: null, kind: null, sections: [] }
  }
  const sections = sectionDiffs(snapshotBody(inbound), snapshotBody(outbound))
  if (!sections.length) return { section: null, index: null, kind: null, sections: [] }
  return { ...sections[0], sections }
}

export function formatCacheBreak(entry) {
  const br = entry?.break
  if (!br) return ''
  const where = br.section === 'messages' ? `messages[${br.index}]` : br.section
  const diff = br.diff
  let detail = ''
  if (diff?.reason === 'part' && Array.isArray(diff.fields?.changed)) {
    detail = ` ${diff.fields.changed.map((item) => `${item.key}:${item.change}`).join(',')}`
  } else if (diff?.reason === 'part' && diff.fields?.change) {
    detail = ` ${diff.type || 'part'}:${diff.fields.change}`
  } else if (diff?.reason) {
    detail = ` ${diff.reason}`
  }
  if (Array.isArray(br.sections) && br.sections.length > 1) {
    detail += `; also ${br.sections
      .slice(1)
      .map((item) => (item.section === 'messages' ? `messages[${item.index}]` : item.section))
      .join(',')}`
  }
  return `${where} ${br.kind}${detail}`
}

export function describeCacheContinuity({
  inbound,
  outbound,
  layer = 'node_object',
  ttl = null,
  sessionId = null,
  vmId = null,
  accountId = null,
  requestId = null,
} = {}) {
  const observed = layer === 'cli_final_wire'
  const inboundToNode = firstHistoryDiff(inbound, outbound)
  return {
    layer,
    wire_observed: observed,
    ttl: ttl ? normalizeCacheTtl(ttl) : null,
    markers: listCacheMarkers(outbound),
    inbound_to_outbound: inboundToNode,
    stages: {
      inbound_to_node: inboundToNode,
      node_to_cli: { observed: false },
    },
    session_id: sessionId || null,
    vm_id: vmId || null,
    account_id: accountId || null,
    request_id: requestId || null,
  }
}

/**
 * Compare `body` with the stored turn of `sessionKey` without recording.
 * `confirmed` is true only after a successful hop called confirmCachePrefix.
 */
export function peekCachePrefix(sessionKey, body, now = Date.now()) {
  const key = String(sessionKey || '').trim()
  if (!key || !body || typeof body !== 'object') return null
  const previous = liveSession(key, now)
  // Compare what prepareCachePrefix would send, not the client's raw images.
  const images = liveImageState(previous?.image_key || key, now)
  const current = snapshotBody(retainImages(images, body).body)
  const compared = comparePrefix(previous, current)
  return { ...compared, confirmed: !!previous?.confirmed }
}

function liveSession(key, now) {
  const hit = sessions.get(key)
  return hit && now - hit.at < SESSION_IDLE_MS ? hit : null
}

function liveImageState(key, now) {
  const hit = imageSessions.get(key)
  return hit && now - hit.at < IMAGE_SESSION_IDLE_MS ? hit : null
}

/** First message whose images stay: the newer half of those after `dropped`. */
function nextImageFloor(messages, dropped) {
  const counts = messages.map((message, index) => (index > dropped ? messageImageCount(message) : 0))
  const keep = Math.ceil(counts.reduce((sum, count) => sum + count, 0) / 2)
  let kept = 0
  for (let i = messages.length - 1; i > dropped && keep > 0; i--) {
    kept += counts[i]
    if (kept >= keep) return i
  }
  return dropped + 1
}

function firstImageAt(messages, from) {
  for (let i = from; i < messages.length; i++) if (messageImageCount(messages[i])) return i
  return -1
}

/**
 * oh-my-pi drops its oldest image whenever a new one passes its image budget.
 * The oldest image sits far back in a long session, so every new screenshot
 * changes history there and the whole tail is rewritten. Once a session has
 * shown one such drop, images below a floor go out in the client's dropped form
 * and the client never touches history behind the floor again:
 *
 * - Age: an image older than 2×IMAGE_WINDOW messages moves the floor to the last
 *   IMAGE_WINDOW messages. Every change lands near the tail, at most once per
 *   IMAGE_WINDOW messages, where a recently written cache entry still reads.
 * - Budget: a client drop at or above the floor skips past the older half of
 *   the remaining images, so a small budget breaks once per half budget.
 *
 * State is per caller session, so an account switch keeps the floor. Clients
 * that never drop an image are never touched.
 */
function retainImages(state, body) {
  const messages = Array.isArray(body?.messages) ? body.messages : null
  if (!messages) return { body, floor: 0, active: false, moved: false }
  const priorLength = state?.ids.length ?? 0
  // Floor indexes only hold while the history below them is the same history:
  // a compaction or rewind that replaces it must not lose the new images.
  let rewritten = !!state && messages.length < priorLength
  for (let i = 0; !rewritten && i < (state?.floor || 0); i++) {
    rewritten = state.roles[i] !== messages[i]?.role || state.ids[i] !== messageIdentity(messages[i])
  }
  const start = rewritten ? 0 : state?.floor || 0
  let floor = start
  let active = !!state?.active
  let dropped = -1
  for (let i = floor; state && !rewritten && i < priorLength; i++) {
    if (!state.images[i] || messageImageCount(messages[i]) >= state.images[i]) continue
    if (state.roles[i] !== messages[i]?.role || state.ids[i] !== messageIdentity(messages[i])) continue
    dropped = i
  }
  if (dropped >= 0) {
    active = true
    floor = Math.max(floor, nextImageFloor(messages, dropped))
  }
  if (active) {
    const oldest = firstImageAt(messages, floor)
    if (oldest >= 0 && oldest < messages.length - 2 * IMAGE_WINDOW)
      floor = Math.max(floor, messages.length - IMAGE_WINDOW)
  }
  let next = null
  for (let i = 0; i < Math.min(floor, messages.length); i++) {
    const stripped = stripMessageImages(messages[i])
    if (stripped === messages[i]) continue
    next ??= messages.slice()
    next[i] = stripped
  }
  return { body: next ? { ...body, messages: next } : body, floor, active, moved: floor > start }
}

function hasContent(message) {
  const content = message?.content
  return typeof content === 'string' ? content.length > 0 : Array.isArray(content) && content.length > 0
}

function withMarker(message, control) {
  if (typeof message.content === 'string') {
    return { ...message, content: [{ type: 'text', text: message.content, cache_control: { ...control } }] }
  }
  const content = message.content.slice()
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i]?.type === 'thinking' || content[i]?.type === 'redacted_thinking') continue
    content[i] = { ...content[i], cache_control: { ...control } }
    return { ...message, content }
  }
  return null
}

function withoutMarkers(message) {
  return {
    ...message,
    content: message.content.map((block) => {
      if (!block?.cache_control) return block
      const { cache_control: _drop, ...rest } = block
      return rest
    }),
  }
}

/**
 * Cache entries this body writes: every message marker, valid for its TTL.
 * Upstream keeps an omitted ttl for 5m; normalizeCacheTtl would read it as the
 * gateway's 1h default and keep an expired entry as an anchor.
 */
function markerWrites(body, now) {
  const writes = []
  for (const [index, message] of (body.messages || []).entries()) {
    if (!Array.isArray(message?.content)) continue
    const control = message.content.findLast((block) => block?.cache_control)?.cache_control
    if (!control) continue
    const hour = control.ttl != null && String(control.ttl).trim() !== '' && normalizeCacheTtl(control.ttl) === '1h'
    writes.push({ index, until: now + (hour ? 60 * 60_000 : 5 * 60_000) })
  }
  return writes
}

/**
 * Entries written before this turn whose prefix still holds: unexpired and
 * before the break. A failed hop wrote nothing, so its markers only count once
 * confirmed.
 */
function liveWrites(previous, br, now) {
  if (!previous) return []
  const limit = !br ? Number.POSITIVE_INFINITY : br.section === 'messages' ? br.index : 0
  const latest = new Map()
  for (const write of [...(previous.writes || []), ...(previous.confirmed ? previous.pending || [] : [])]) {
    if (write.until <= now || write.index >= limit) continue
    latest.set(write.index, Math.max(write.until, latest.get(write.index) || 0))
  }
  return [...latest]
    .map(([index, until]) => ({ index, until }))
    .sort((a, b) => a.index - b.index)
    .slice(-WRITE_LIMIT)
}

function lastMarkedMessage(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (Array.isArray(messages[i]?.content) && messages[i].content.some((block) => block?.cache_control)) return i
  }
  return -1
}

/**
 * Message markers for this turn: one reads the newest cache entry still valid
 * before the first change, one writes. Normally those are the previous tail and
 * the new tail the caller already placed, and nothing moves.
 *
 * After a change (break), the read marker goes on the newest valid entry before
 * it (an entry this process did not see written, after a restart, falls back
 * to the last user turn before the change), so upstream rewrites only from
 * there. The write marker goes in front of the oldest image still sent past the
 * change: the next change strips that image, and an entry right in front of it
 * keeps that rewrite as short as the image's age. Entries only exist where a
 * marker sat, so without this the next change would read from behind this one.
 * The turn after such a write marks it as the read, since it is not the
 * previous tail. Every marker keeps the tail marker's TTL.
 */
function placeMarkers(body, { br, writes, previousTail }) {
  if (br && br.section !== 'messages') return null
  const messages = body.messages
  const marked = []
  for (const [i, message] of messages.entries()) {
    if (Array.isArray(message?.content) && message.content.some((block) => block?.cache_control)) marked.push(i)
  }
  if (!marked.length) return null
  const tail = marked[marked.length - 1]
  const limit = br ? br.index : messages.length
  const usable = (i) => messages[i]?.role === 'user' && hasContent(messages[i])
  let read = writes.findLast((write) => write.index < limit && write.index < tail && usable(write.index))?.index ?? -1
  if (!br && (read < 0 || read >= previousTail || marked.includes(read))) return null
  for (let i = Math.min(limit, tail) - 1; br && read < 0 && i >= 0; i--) if (usable(i)) read = i
  let write = tail
  const oldest = br ? firstImageAt(messages, br.index) : -1
  for (let i = oldest - 1; oldest > 0 && write === tail && i > read; i--) if (usable(i)) write = i
  const wanted = [read, write].filter((i) => i >= 0)
  const messageMarkers = listCacheMarkers(body).filter((marker) => marker.section === 'messages').length
  if (listCacheMarkers(body).length - messageMarkers + wanted.length > MAX_CACHE_MARKERS) return null
  const control = messages[tail].content.findLast((block) => block?.cache_control).cache_control
  const next = messages.map((message, i) => (marked.includes(i) ? withoutMarkers(message) : message))
  for (const i of wanted) {
    const stamped = withMarker(next[i], control)
    if (!stamped) return null
    next[i] = stamped
  }
  return {
    body: { ...body, messages: next },
    ...(read >= 0 ? { anchor: read } : {}),
    ...(write !== tail ? { checkpoint: write } : {}),
  }
}

/**
 * Prepare `body` as the next attempted turn of `sessionKey` (account + session)
 * and record it: image floor first (it decides what is sent), then the prefix
 * comparison, then the markers. `imageKey` names the caller session the image
 * floor belongs to across accounts; it defaults to `sessionKey`. The recorded
 * snapshot is the body before markers move, since markers are not history. It
 * stays unconfirmed until confirmCachePrefix: a failed/rejected hop must not
 * make the next estimate treat the session as warm.
 */
export function prepareCachePrefix(sessionKey, body, now = Date.now(), { imageKey = null } = {}) {
  const key = String(sessionKey || '').trim()
  if (!key || !body || typeof body !== 'object') return null
  const imagesAt = String(imageKey || '').trim() || key
  const previous = liveSession(key, now)
  const retained = retainImages(liveImageState(imagesAt, now), body)
  const current = snapshotBody(retained.body)
  const compared = comparePrefix(previous, current)
  const br = compared.break
  const writes = liveWrites(previous, br, now)
  const previousTail = previous?.tail ?? -1
  const placed = Array.isArray(retained.body.messages)
    ? placeMarkers(retained.body, { br, writes, previousTail })
    : null
  const sent = placed?.body ?? retained.body
  sessions.delete(key)
  sessions.set(key, {
    ...current,
    turn: compared.turn,
    at: now,
    confirmed: false,
    image_key: imagesAt,
    writes,
    pending: markerWrites(sent, now),
    // Where the caller's tail marker sat; a later turn reads it if it was written.
    tail: lastMarkedMessage(retained.body),
  })
  if (sessions.size > SESSION_LIMIT) sessions.delete(sessions.keys().next().value)
  imageSessions.delete(imagesAt)
  imageSessions.set(imagesAt, {
    at: now,
    floor: retained.floor,
    active: retained.active,
    roles: current.messages.map((record) => record.role),
    ids: current.messages.map((record) => record.id),
    images: current.messages.map((record) => record.images || 0),
  })
  if (imageSessions.size > SESSION_LIMIT) imageSessions.delete(imageSessions.keys().next().value)
  return {
    body: sent,
    turn: compared.turn,
    break: br,
    ...(retained.floor > 0 ? { image_floor: retained.floor, image_floor_moved: retained.moved } : {}),
    ...(placed?.anchor != null && br ? { anchor: placed.anchor } : {}),
    ...(placed?.checkpoint != null ? { checkpoint: placed.checkpoint } : {}),
    ...(placed && !br ? { reread: placed.anchor } : {}),
  }
}

/** Mark the latest attempted snapshot as a confirmed cache write/read. */
export function confirmCachePrefix(sessionKey, now = Date.now()) {
  const key = String(sessionKey || '').trim()
  if (!key) return false
  const hit = sessions.get(key)
  if (!hit || now - hit.at >= SESSION_IDLE_MS) return false
  hit.confirmed = true
  return true
}

export function clearCachePrefixSessions() {
  sessions.clear()
  imageSessions.clear()
}
