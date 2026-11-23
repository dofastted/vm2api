/**
 * `x-kin-queue` request header: whether this request may wait in the Claude pool for a seat.
 *
 * A caller that load-balances across several upstreams (vm2api plus others) would
 * rather hear "busy" at once and send the request elsewhere than have it wait here
 * for a seat. `x-kin-queue: off` asks for exactly that: a seat that can be had right
 * now is taken as usual; otherwise the request fails right away with 529
 * `pool_overloaded` instead of joining the seat queue. A conversation whose own seat
 * is held (or, with `keep_session_home` enabled, whose home account's kernel has no
 * free slot) is not moved to another account either: it loses its prompt cache
 * either way, so the caller decides.
 *
 * Only the seat/slot wait is skipped. A conversation's turns still run one at a time
 * (`session_queue_timeout_ms`), since that queue orders turns rather than waiting
 * for capacity.
 */
export const QUEUE_HINT_HEADER = 'x-kin-queue'

const NO_QUEUE_VALUES = new Set(['off', 'none', 'no', 'false', '0'])

function readQueueHeader(headers) {
  if (!headers || typeof headers !== 'object') return undefined
  if (typeof headers.get === 'function') return headers.get(QUEUE_HINT_HEADER)
  if (QUEUE_HINT_HEADER in headers) return headers[QUEUE_HINT_HEADER]
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === QUEUE_HINT_HEADER) return value
  }
  return undefined
}

/** True unless any `x-kin-queue` token disables queueing (`off` / `none` / `no` / `false` / `0`). */
export function queueAllowedByHeaders(headers = {}) {
  const raw = readQueueHeader(headers)
  const items = Array.isArray(raw) ? raw : raw == null ? [] : String(raw).split(',')
  for (const item of items) {
    if (item == null) continue
    if (NO_QUEUE_VALUES.has(String(item).trim().toLowerCase())) return false
  }
  return true
}
