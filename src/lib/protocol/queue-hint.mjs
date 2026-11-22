/**
 * `x-kin-queue` request header: whether this request may wait in the pool for a seat.
 *
 * A caller that load-balances across several upstreams (vm2api plus others) would
 * rather hear "busy" at once and send the request elsewhere than have it wait here
 * for a seat. `x-kin-queue: off` asks for exactly that: a free seat (the pinned one or
 * any other) is taken as usual, and when none is free the request fails right away
 * with 529 `pool_overloaded` instead of joining the seat queue.
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
