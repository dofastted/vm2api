/**
 * `x-kin-queue` request header: whether this request may wait in the pool for a seat.
 *
 * A caller that load-balances across several upstreams (vm2api plus others) would
 * rather hear "busy" at once and send the request elsewhere than have it wait here
 * for a seat. `x-kin-queue: off` asks for exactly that: a seat that can be had right
 * now is taken as usual; otherwise the request fails right away with 529
 * `pool_overloaded` instead of joining the seat queue. A conversation whose own seat
 * is held (or whose home account's kernel has no free slot) is not moved to another
 * account either: it loses its prompt cache either way, so the caller decides.
 *
 * Only the seat queue is skipped. A conversation's turns still run one at a time
 * (`session_queue_timeout_ms`), since that queue orders turns rather than waiting
 * for capacity.
 */
export const QUEUE_HINT_HEADER = 'x-kin-queue'

const NO_QUEUE_VALUES = new Set(['off', 'none', 'no', 'false', '0'])

/** True unless the caller sent `x-kin-queue: off` (also none / no / false / 0). */
export function queueAllowedByHeaders(headers = {}) {
  const raw = headers?.[QUEUE_HINT_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value == null) return true
  return !NO_QUEUE_VALUES.has(String(value).trim().toLowerCase())
}
