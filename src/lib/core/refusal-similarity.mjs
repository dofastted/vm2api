/**
 * Near-duplicate refusal matching.
 *
 * The document is normalized user turns only. A shared Claude Code system
 * prefix must not push two different requests over the line. Exact SHA-256
 * still covers the full prompt, including system.
 *
 * 90% means estimated Jaccard of 24-character shingles. A 50k-token body
 * with a small edit stays above the line; a different ask does not.
 */
import { normalizeText } from './distill-detect.mjs'
import { computeMessageIdentity } from '../protocol/cache-prefix.mjs'
import { contextMessageIdentity } from '../protocol/request-body-context.mjs'

export const REFUSAL_SIMILARITY = 0.9
/** Below this, shingle overlap is noise. Exact fingerprint still applies. */
export const REFUSAL_SIMILARITY_MIN_CHARS = 512
const SHINGLE = 24
const STEP = 12
const MAX_SHINGLES = 4096
const SLOTS = 128

function isToolPayload(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false
  const type = String(block.type || '')
  if (!type) return false
  return type === 'tool_result' || type === 'function_call_output' || type.endsWith('_tool_result')
}

function contentToText(content, includeToolResults = true) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => contentToText(part, includeToolResults))
      .filter(Boolean)
      .join('\n')
  }
  if (!content || typeof content !== 'object') return ''
  if (!includeToolResults && isToolPayload(content)) return ''
  if (typeof content.text === 'string') return content.text
  // Responses items nest their parts one level deeper: message -> content -> input_text.
  if (typeof content.content === 'string') return content.content
  if (Array.isArray(content.content)) return contentToText(content.content, includeToolResults)
  return ''
}

/**
 * Responses `input`: a plain string, or items whose roleless or user-role parts
 * carry the prompt. Assistant / reasoning / tool items are skipped.
 */
function responsesInputTexts(input, includeToolResults = true) {
  if (typeof input === 'string') return input ? [input] : []
  if (!Array.isArray(input)) return []
  const out = []
  for (const item of input) {
    if (typeof item === 'string') {
      if (item) out.push(item)
      continue
    }
    if (!item || typeof item !== 'object') continue
    if (!includeToolResults && isToolPayload(item)) continue
    const role = typeof item.role === 'string' ? item.role.toLowerCase() : ''
    if (role && role !== 'user') continue
    const text = contentToText(item.content === undefined ? item : item.content, includeToolResults)
    if (text) out.push(text)
  }
  return out
}

function messageIdentity(message, ctx = null) {
  if (!ctx) return computeMessageIdentity(message)
  return contextMessageIdentity(ctx, message, computeMessageIdentity)
}

function userTexts(body, includeToolResults = true, { startIndex = 0, ctx = null } = {}) {
  if (!body || typeof body !== 'object') return []
  const out = []
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let i = Math.max(0, startIndex); i < messages.length; i++) {
    const message = messages[i]
    if (message?.role === 'user') {
      const text = contentToText(message.content, includeToolResults)
      if (text) out.push(text)
    }
  }
  if (startIndex === 0) out.push(...responsesInputTexts(body.input, includeToolResults))
  return out
}

export function historyPrefixIntact(body, interceptSession, ctx = null) {
  const ids = interceptSession?.messageIds
  if (!Array.isArray(ids) || !ids.length) return false
  const messages = Array.isArray(body?.messages) ? body.messages : []
  if (messages.length < ids.length) return false
  for (let i = 0; i < ids.length; i++) {
    if (messageIdentity(messages[i], ctx) !== ids[i]) return false
  }
  return true
}
/** Raw user turns, tool payloads omitted, repeats dropped. Not normalized. */
export function refusalAskTurns(inbound, body = inbound) {
  const seen = new Set()
  const turns = []
  for (const src of [inbound, body]) {
    for (const raw of userTexts(src, false)) {
      const key = normalizeText(raw)
      if (!key || seen.has(key)) continue
      seen.add(key)
      turns.push(raw)
    }
  }
  return turns
}

/**
 * User turns from inbound, then body, with exact repeats dropped.
 * Hard regex passes includeToolResults: false. Tool payloads quote the rules
 * (issue text, command output) and are not the user's ask.
 * `clean` drops closed reminders and `# Environment` before comparison.
 * The current ask is repeated at the end so a long history cannot hide it.
 */
function collectRefusalUserParts(inbound, body = inbound, options = {}) {
  const includeToolResults = options.includeToolResults !== false
  const clean = typeof options.clean === 'function' ? options.clean : null
  const ctx = options.ctx || null
  const intercept = options.interceptSession
  const seen = new Set(intercept?.seen || [])
  const parts = intercept?.parts?.length && historyPrefixIntact(body, intercept, ctx) ? [...intercept.parts] : []
  const startIndexes =
    intercept?.parts?.length && historyPrefixIntact(body, intercept, ctx)
      ? [intercept.messageIds.length, intercept.messageIds.length]
      : [0, 0]
  if (!parts.length) seen.clear()
  for (let s = 0; s < 2; s++) {
    const src = s === 0 ? inbound : body
    for (const raw of userTexts(src, includeToolResults, { startIndex: startIndexes[s], ctx })) {
      const text = clean ? clean(raw) : raw
      const norm = normalizeText(text)
      if (!norm || seen.has(norm)) continue
      seen.add(norm)
      parts.push(norm)
    }
  }
  if (clean && parts.length > 1) parts.push(parts[parts.length - 1])
  return { parts, seen: [...seen] }
}

export function refusalUserDocument(inbound, body = inbound, options = {}) {
  return collectRefusalUserParts(inbound, body, options).parts.join('\n')
}

export function refusalUserDocumentCache(inbound, body = inbound, options = {}) {
  const collected = collectRefusalUserParts(inbound, body, options)
  return {
    messageIds: (Array.isArray(body?.messages) ? body.messages : []).map((message) =>
      messageIdentity(message, options.ctx),
    ),
    parts: collected.parts,
    seen: collected.seen,
  }
}

function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function shingles(text) {
  if (text.length <= SHINGLE) return [text]
  const raw = Math.floor((text.length - SHINGLE) / STEP) + 1
  const stride = raw > MAX_SHINGLES ? Math.ceil(raw / MAX_SHINGLES) : 1
  const step = STEP * stride
  const out = []
  for (let i = 0; i + SHINGLE <= text.length; i += step) out.push(text.slice(i, i + SHINGLE))
  return out
}

/** 128-slot MinHash, or null when the document is too short to compare. */
export function refusalSignature(text) {
  const norm = normalizeText(text)
  if (norm.length < REFUSAL_SIMILARITY_MIN_CHARS) return null
  const sig = new Uint32Array(SLOTS)
  sig.fill(0xffffffff)
  for (const gram of shingles(norm)) {
    const h1 = fnv1a(gram)
    const h2 = (fnv1a(`\u0001${gram}`) | 1) >>> 0
    for (let i = 0; i < SLOTS; i++) {
      const mixed = (h1 + Math.imul(i, h2)) >>> 0
      if (mixed < sig[i]) sig[i] = mixed
    }
  }
  return Array.from(sig)
}

export function encodeSignature(signature) {
  if (!signature || signature.length !== SLOTS) return null
  return signature.join(',')
}

export function decodeSignature(raw) {
  if (!raw) return null
  const parts = String(raw).split(',')
  if (parts.length !== SLOTS) return null
  const out = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    out.push(Number(part) >>> 0)
  }
  return out
}

/** Estimated Jaccard. 1 is identical, 0 is no shared slot. */
export function signatureSimilarity(left, right) {
  if (!left || !right || left.length !== right.length || !left.length) return 0
  let same = 0
  for (let i = 0; i < left.length; i++) if (left[i] === right[i]) same += 1
  return same / left.length
}
