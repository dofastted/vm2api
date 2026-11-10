/** Same budget the kernels use when they report the final fetch body. */
export const OUTBOUND_TOKEN_LIMIT = 10_000

export function truncateToTokens(text, limit = OUTBOUND_TOKEN_LIMIT) {
  const source = String(text ?? '')
  const cap = Number(limit)
  if (!Number.isFinite(cap) || cap <= 0) return { text: '', truncated: source.length > 0, tokens: 0 }
  let tokens = 0
  let end = 0
  for (let i = 0; i < source.length; ) {
    const code = source.codePointAt(i)
    const width = code > 0xffff ? 2 : 1
    const cost = code > 0x7f ? 1 : 0.25
    if (tokens + cost > cap) break
    tokens += cost
    i += width
    end = i
  }
  return {
    text: source.slice(0, end),
    truncated: end < source.length,
    tokens: Math.ceil(tokens),
  }
}

/** Keep a reported final body inside the log budget. Non-strings are stored as truncated JSON text. */
export function capOutboundBody(body, limit = OUTBOUND_TOKEN_LIMIT) {
  if (body == null) return null
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const cut = truncateToTokens(text, limit)
  if (!cut.truncated && typeof body !== 'string') return body
  return cut.text
}
