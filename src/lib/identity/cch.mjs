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
  const body = JSON.parse(String(raw ?? ''))
  let billing = false
  const normalized = mapSystemText(body, (text) => {
    billing = true
    return normalizeBillingCch(text)
  })
  if (!billing) throw new Error('billing cch not found')
  return projectBillingFields(JSON.stringify(normalized))
}

function projectBillingFields(text) {
  return stripMaxTokens(stripFallbackCreditToken(stripFallbacks(clearModelValues(text))))
}

export function computeClaudeCodeCch(bodyBytes) {
  const h = xxh64(bodyBytes, CCH_XXH64_SEED)
  return (h & 0xfffffn).toString(16).padStart(5, '0')
}

function normalizeBillingCch(text) {
  return text.replace(/(^\s*x-anthropic-billing-header:)([^\r\n]*)/i, (line) => {
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
  let found = false
  const firstBilling = (text) => {
    // History and later documentation blocks are caller content, not billing.
    if (found || !/^\s*x-anthropic-billing-header:/i.test(text)) return text
    found = true
    return fn(text)
  }
  if (typeof body.system === 'string') {
    const system = firstBilling(body.system)
    return system === body.system ? body : { ...body, system }
  }
  if (!Array.isArray(body.system)) return body
  let changed = false
  const system = body.system.map((block) => {
    if (typeof block === 'string') {
      const text = firstBilling(block)
      changed ||= text !== block
      return text
    }
    if (!block || typeof block.text !== 'string') return block
    const text = firstBilling(block.text)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  return changed ? { ...body, system } : body
}

const SYSTEM_BILLING_CCH = new RegExp(
  `(^\\s*x-anthropic-billing-header:[^\\r\\n]*?\\bcch=)${CCH_PLACEHOLDER}(?=;)`,
  'i',
)

/** Native hops leave the placeholder for the CLI's final SDK serialization. */
export function sealClaudeCodeCch(body, { enabled = true, seal = true } = {}) {
  if (body == null || (typeof body !== 'string' && typeof body !== 'object')) return body
  const stringBody = typeof body === 'string'
  const normalized = normalizeSystemCch(stringBody ? JSON.parse(body) : body)
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
