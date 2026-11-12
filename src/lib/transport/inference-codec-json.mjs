import { types } from 'node:util'

export const CODEC_LIMITS = Object.freeze({
  threads: 2,
  thresholdBytes: 256 * 1024,
  jobBytes: 192 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  nodes: 16384,
  depth: 64,
  jobTimeoutMs: 30000,
  restartDelayMs: 1000,
})

export function inspectCodecValue(value, maxBytes, snapshot = false) {
  let bytes = 0
  let nodes = 0
  const parents = new Set()
  const visit = (current, depth) => {
    if (++nodes > CODEC_LIMITS.nodes || depth > CODEC_LIMITS.depth) throw new Error('codec shape limit')
    bytes += typeof current === 'string' ? 16 + current.length * 6 : 32
    if (bytes > maxBytes) throw new Error('codec byte limit')
    if (current == null || ['string', 'number', 'boolean', 'undefined'].includes(typeof current)) return current
    if (
      typeof current !== 'object' ||
      types.isProxy(current) ||
      types.isBoxedPrimitive(current) ||
      JSON.isRawJSON?.(current)
    ) {
      throw new Error('codec non-JSON value')
    }
    const array = Array.isArray(current)
    const prototype = Object.getPrototypeOf(current)
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) {
      throw new Error('codec prototype')
    }
    if (
      Object.getOwnPropertyDescriptor(current, 'toJSON') ||
      Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON') ||
      (array && Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) ||
      parents.has(current)
    ) {
      throw new Error('codec custom serialization')
    }
    if (array && current.length > CODEC_LIMITS.nodes - nodes) throw new Error('codec array limit')
    const keys = Object.keys(current)
    if (keys.length > CODEC_LIMITS.nodes - nodes || (array && keys.length !== current.length)) {
      throw new Error('codec property limit')
    }
    parents.add(current)
    const copy = snapshot ? (array ? [] : Object.create(null)) : current
    for (const [index, key] of keys.entries()) {
      if (array && key !== String(index)) throw new Error('codec sparse array')
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('codec accessor')
      bytes += 64 + key.length * 6
      const child = visit(descriptor.value, depth + 1)
      if (snapshot) copy[key] = child
    }
    parents.delete(current)
    return copy
  }
  try {
    const copy = visit(value, 0)
    return { bytes, value: copy }
  } catch {
    return null
  }
}

export function encodeInferenceJson(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
}

export function parseWorkerJson(buffer, status = 0) {
  const text = String(buffer || '')
  try {
    return JSON.parse(text)
  } catch {
    if (status === 413) {
      return {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'body_too_large',
          message: 'Request body exceeds the slot kernel limit',
          details: { retryable: false },
        },
      }
    }
    return {
      type: 'error',
      error: { type: 'worker_error', code: 'worker_invalid_json', message: text.slice(0, 400) },
    }
  }
}
