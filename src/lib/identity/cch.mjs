/**
 * Claude Code 2.1.296-compatible cch over compact final JSON.
 * Normalize the billing value before hashing, including caller-supplied values.
 * Billing's `cch=` goes back to `00000`. Every `"model":"..."` value is cleared.
 * `"fallbacks":[...]`, `"fallback_credit_token":"..."`, and a numeric
 * `"max_tokens"` are cut out, including the adjacent comma.
 * Seed `0x4D659218E32A3268` is the ELF immediate, same as 2.1.177.
 * Low 20 bits, 5 lowercase hex. The bytes on the wire keep the real fields.
 */
import { xxh64 } from './xxh64.mjs'

export const CCH_PLACEHOLDER = '00000'
export const CCH_XXH64_SEED = 0x4d659218e32a3268n

function cut(text, start, end) {
  if (end < text.length && text[end] === ',') end += 1
  else if (start > 0 && text[start - 1] === ',') start -= 1
  return text.slice(0, start) + text.slice(end)
}

function clearModelValues(text) {
  const needle = '"model":"'
  const out = []
  let i = 0
  while (true) {
    const j = text.indexOf(needle, i)
    if (j < 0) {
      out.push(text.slice(i))
      break
    }
    let k = j + needle.length
    while (k < text.length) {
      if (text[k] === '\\' && k + 1 < text.length) {
        k += 2
        continue
      }
      if (text[k] === '"') break
      k += 1
    }
    out.push(text.slice(i, j + needle.length))
    i = k
  }
  return out.join('')
}

function stripFallbacks(text) {
  const key = '"fallbacks":['
  const j = text.indexOf(key)
  if (j < 0) return text
  let i = j + key.length - 1
  let depth = 0
  let inStr = false
  let esc = false
  while (i < text.length) {
    const c = text[i]
    if (inStr) {
      esc = !esc || c !== '\\' ? !esc && c === '\\' : false
      if (c === '"' && !esc) inStr = false
      else if (c === '\\') esc = !esc
      else esc = false
    } else if (c === '"') inStr = true
    else if (c === '[') depth += 1
    else if (c === ']') {
      depth -= 1
      if (depth === 0) return cut(text, j, i + 1)
    }
    i += 1
  }
  return text
}

function stripFallbackCreditToken(text) {
  const key = '"fallback_credit_token":"'
  const j = text.indexOf(key)
  if (j < 0) return text
  let k = j + key.length
  while (k < text.length) {
    if (text[k] === '\\' && k + 1 < text.length) {
      k += 2
      continue
    }
    if (text[k] === '"') return cut(text, j, k + 1)
    k += 1
  }
  return text
}

function stripMaxTokens(text) {
  const key = '"max_tokens":'
  const j = text.indexOf(key)
  if (j < 0) return text
  let k = j + key.length
  if (k >= text.length || !/\d/.test(text[k])) return text
  while (k < text.length && /\d/.test(text[k])) k += 1
  return cut(text, j, k)
}

export function projectClaudeCodeCchText(raw) {
  const source = String(raw ?? '')
  const billingCch = /(x-anthropic-billing-header:[^"]*?\bcch=)[0-9a-f]{5}(?=;)/i
  if (!billingCch.test(source)) throw new Error('billing cch not found')
  const replaced = source.replace(billingCch, (_match, prefix) => `${prefix}00000`)
  return projectBillingFields(replaced)
}

function projectBillingFields(text) {
  return stripMaxTokens(stripFallbackCreditToken(stripFallbacks(clearModelValues(text))))
}

export function computeClaudeCodeCch(bodyBytes) {
  const h = xxh64(bodyBytes, CCH_XXH64_SEED)
  return (h & 0xfffffn).toString(16).padStart(5, '0')
}

function normalizeBillingCch(text) {
  return text.replace(/(^\s*x-anthropic-billing-header:)([^\r\n]*)/gim, (line) => {
    let found = false
    const normalized = line.replace(/\s*cch=[^;\s]*;?/gi, () => {
      if (found) return ''
      found = true
      return ` cch=${CCH_PLACEHOLDER};`
    })
    if (found) return normalized
    return `${normalized.trimEnd()}${normalized.trimEnd().endsWith(';') ? '' : ';'} cch=${CCH_PLACEHOLDER};`
  })
}

function normalizeSystemCch(body) {
  return mapSystemText(body, normalizeBillingCch)
}

function mapSystemText(body, fn) {
  if (typeof body.system === 'string') {
    const system = fn(body.system)
    return system === body.system ? body : { ...body, system }
  }
  if (!Array.isArray(body.system)) return body
  let changed = false
  const system = body.system.map((block) => {
    if (typeof block === 'string') {
      const text = fn(block)
      changed ||= text !== block
      return text
    }
    if (!block || typeof block.text !== 'string') return block
    const text = fn(block.text)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  return changed ? { ...body, system } : body
}

const SYSTEM_BILLING_CCH = new RegExp(
  `(^\\s*x-anthropic-billing-header:[^\\r\\n]*?\\bcch=)${CCH_PLACEHOLDER}(?=;)`,
  'gim',
)

/**
 * Billing literals echoed inside conversation history.
 *
 * The final CLI serialization stamps the digest by rewriting the first
 * `x-anthropic-billing-header: … cch=xxxxx;` literal it finds in the request
 * JSON, and `messages` is serialized ahead of `system`. When a prompt carries a
 * captured request body (debug dumps, redacted transcripts, logs an agent read
 * back into the conversation) that literal shadows the real system billing
 * line: the digest lands in the history instead, and the history entry changes
 * on every turn. The rotating literal breaks the cached prefix, so cache reads
 * pin to the static system+tools head and each turn re-writes the tail.
 *
 * Break the literal in message content only, so the stamp always lands on the
 * system block. WORD JOINER is invisible, does not split words, and makes the
 * rewrite idempotent: the joined digest no longer matches the pattern.
 */
const MESSAGE_BILLING_CCH_LITERAL = /(x-anthropic-billing-header:[^"\r\n]*?\bcch=)([0-9a-f]{5})(?=;)/gi
export const BILLING_LITERAL_JOINER = '\u2060'

function joinBillingLiterals(text) {
  if (!text.includes('x-anthropic-billing-header')) return text
  return text.replace(
    MESSAGE_BILLING_CCH_LITERAL,
    (_match, prefix, digest) => `${prefix}${BILLING_LITERAL_JOINER}${digest}`,
  )
}

function joinBillingLiteralsDeep(value) {
  if (typeof value === 'string') return joinBillingLiterals(value)
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const out = joinBillingLiteralsDeep(item)
      changed ||= out !== item
      return out
    })
    return changed ? next : value
  }
  if (value && typeof value === 'object') {
    let changed = false
    const next = {}
    for (const [key, item] of Object.entries(value)) {
      const out = joinBillingLiteralsDeep(item)
      changed ||= out !== item
      next[key] = out
    }
    return changed ? next : value
  }
  return value
}

/**
 * Neutralize billing literals in `messages` so the later CLI seal step cannot
 * mistake conversation history for the request's own billing line.
 */
export function neutralizeMessageBillingLiterals(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return body
  const messages = joinBillingLiteralsDeep(body.messages)
  return messages === body.messages ? body : { ...body, messages }
}

/** Native hops leave the placeholder for the CLI's final SDK serialization. */
export function sealClaudeCodeCch(body, { enabled = true, seal = true } = {}) {
  if (body == null || (typeof body !== 'string' && typeof body !== 'object')) return body
  const stringBody = typeof body === 'string'
  const parsed = stringBody ? JSON.parse(body) : body
  // Native hop (seal=false): the CLI stamps the digest itself and picks the
  // first billing literal in the serialized JSON, which is a message when the
  // request carries `messages` ahead of `system`. Join history literals there
  // so the stamp lands on the system block; every other hop leaves them intact.
  const normalized = seal ? normalizeSystemCch(parsed) : neutralizeMessageBillingLiterals(normalizeSystemCch(parsed))
  if (!enabled || !seal) return stringBody ? JSON.stringify(normalized) : normalized
  const raw = JSON.stringify(normalized)
  let billing = false
  mapSystemText(normalized, (text) => {
    billing ||= new RegExp(SYSTEM_BILLING_CCH.source, 'im').test(text)
    return text
  })
  if (!billing) return stringBody ? raw : normalized
  // Normalized system billing already holds the placeholder; message literals are hashed verbatim.
  const cch = computeClaudeCodeCch(Buffer.from(projectBillingFields(raw), 'utf8'))
  const sealed = mapSystemText(normalized, (text) => text.replace(SYSTEM_BILLING_CCH, `$1${cch}`))
  return stringBody ? JSON.stringify(sealed) : sealed
}
