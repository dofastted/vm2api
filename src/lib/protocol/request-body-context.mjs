/**
 * REQ-PERF-BODY-01 L1: request-scoped body view and hash memo.
 *
 * Keeps stable message object references across shallow copies and remembers
 * per-message identity digests for the lifetime of one inbound request.
 */
/** Test spy: how many identity digests were computed (not cache hits). */
export const requestBodyContextStats = { messageIdentityMisses: 0, valueDigestMisses: 0 }

export function resetRequestBodyContextStats() {
  requestBodyContextStats.messageIdentityMisses = 0
  requestBodyContextStats.valueDigestMisses = 0
}

/**
 * @param {object|null} body inbound working body
 * @param {{ parent?: object|null }} [options]
 */
export function createRequestBodyContext(body, { parent = null } = {}) {
  return {
    body,
    parent,
    messageIdentity: new WeakMap(),
    valueDigest: new WeakMap(),
    stats: { messageIdentityMisses: 0, valueDigestMisses: 0 },
  }
}

export function contextMessageIdentity(ctx, message, identityFn) {
  const compute = typeof identityFn === 'function' ? identityFn : () => null
  if (!message || typeof message !== 'object') return compute(message)
  if (!ctx) {
    requestBodyContextStats.messageIdentityMisses += 1
    return compute(message)
  }
  const cached = ctx.messageIdentity.get(message)
  if (cached !== undefined) return cached
  const id = compute(message)
  ctx.messageIdentity.set(message, id)
  ctx.stats.messageIdentityMisses += 1
  requestBodyContextStats.messageIdentityMisses += 1
  return id
}

export function contextValueDigest(ctx, value, digestFn) {
  if (value == null || typeof value !== 'object') {
    requestBodyContextStats.valueDigestMisses += 1
    return digestFn(value)
  }
  if (!ctx) {
    requestBodyContextStats.valueDigestMisses += 1
    return digestFn(value)
  }
  const cached = ctx.valueDigest.get(value)
  if (cached !== undefined) return cached
  const digest = digestFn(value)
  ctx.valueDigest.set(value, digest)
  ctx.stats.valueDigestMisses += 1
  requestBodyContextStats.valueDigestMisses += 1
  return digest
}

/** Shallow shell: message objects keep their references. */
export function shallowCopyBody(body, { omit = [] } = {}) {
  if (!body || typeof body !== 'object') return body
  const out = { ...body }
  for (const key of omit) delete out[key]
  return out
}

/**
 * Copy-on-write: replace `messages` only when the mapper returns a new array.
 * Other top-level fields are shallow-copied once.
 */
export function copyBodyWithMessages(body, mapMessages) {
  if (!body || typeof body !== 'object') return body
  const messages = Array.isArray(body.messages) ? body.messages : null
  if (!messages || typeof mapMessages !== 'function') return shallowCopyBody(body)
  const next = mapMessages(messages)
  if (next === messages) return shallowCopyBody(body)
  return { ...body, messages: next }
}
