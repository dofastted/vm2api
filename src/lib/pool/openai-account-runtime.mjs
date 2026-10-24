/**
 * Process-local OpenAI scheduling signals.
 * Failure EWMA matches codex-proxy-rs AccountFeedbackStats:
 * success/failure α=0.2, capacity reject α=0.4, 15 minute half-life.
 */

const FAILURE_ALPHA = 0.2
const CAPACITY_ALPHA = 0.4
const FAILURE_HALF_LIFE_MS = 15 * 60 * 1000
const RPM_WINDOW_MS = 60_000

export const OPENAI_MAX_WAITERS = 100

const slots = new Map()
const waiters = []
const feedback = new Map()
// Upstream failures park a GPT account for a short, process-local window.
// This is deliberately not the operator switch, which must not be flipped by
// a transient 401/429/5xx. The hold expires on its own.
const holds = new Map()
let roundRobinCursor = 0

function slotOf(id) {
  const key = String(id || '')
  let slot = slots.get(key)
  if (!slot) {
    slot = { inFlight: 0, lastStartedAt: null, starts: [] }
    slots.set(key, slot)
  }
  return slot
}

function decayedFailure(entry, now) {
  if (!entry?.updatedAt) return entry?.value || 0
  const elapsed = Math.max(0, now - entry.updatedAt)
  return entry.value * 0.5 ** (elapsed / FAILURE_HALF_LIFE_MS)
}

function recentStarts(slot, now) {
  if (!slot?.starts?.length) return 0
  slot.starts = slot.starts.filter((t) => now - t < RPM_WINDOW_MS)
  return slot.starts.length
}

export function openAIRuntimeSignals(id, now = Date.now()) {
  const key = String(id || '')
  const slot = slots.get(key)
  const entry = feedback.get(key)
  const failure = entry ? decayedFailure(entry, now) : 0
  const latency = entry?.latency
  return {
    inFlight: slot?.inFlight || 0,
    lastStartedAt: slot?.lastStartedAt ?? null,
    rpmCount: recentStarts(slot, now),
    rpmResetAt: slot?.starts?.length ? slot.starts[0] + RPM_WINDOW_MS : null,
    failureRateBps: Math.round(Math.min(1, Math.max(0, failure)) * 10_000),
    firstOutputLatencyMs: Number.isFinite(latency) && latency > 0 ? Math.round(latency) : null,
  }
}

export function openAIRuntimeSnapshot(id, now = Date.now()) {
  return openAIRuntimeSignals(id, now)
}

/** Live failure hold for a GPT account, or null once it has expired. */
export function openAIAccountHold(id, now = Date.now()) {
  const key = String(id || '')
  const hold = holds.get(key)
  if (!hold) return null
  if (hold.until <= now) {
    holds.delete(key)
    return null
  }
  return { until: hold.until, reason: hold.reason, set_at: hold.set_at }
}

/** Park an account after an uncommitted upstream failure. Longest live hold wins. */
export function holdOpenAIAccount(id, { until, reason = 'upstream_error', now = Date.now() } = {}) {
  const key = String(id || '')
  const at = Number(until) || 0
  if (!key || !(at > now)) return null
  const current = holds.get(key)
  if (current && current.until >= at) return { ...current }
  const next = { until: at, reason: String(reason || 'upstream_error'), set_at: now }
  holds.set(key, next)
  return { ...next }
}

export function clearOpenAIAccountHold(id) {
  holds.delete(String(id || ''))
}

export function readOpenAICursor() {
  return roundRobinCursor
}

export function bumpOpenAICursor() {
  roundRobinCursor += 1
  return roundRobinCursor
}

/**
 * One synchronous check-and-claim: concurrency and RPM are read and taken in
 * the same tick, so two admissions can never both see the last free seat.
 * Returns a lease whose release() is idempotent, or null when full.
 */
export function tryAcquireOpenAISlot(id, { concurrency = 1, maxRpm = 0, now = Date.now(), quotaPolicy = null } = {}) {
  // Candidate selection resolves pins against the same live policy snapshot.
  // Never replace a resolved legacy/pinned candidate cap with the global cap
  // here: doing so can sell more seats than the candidate was selected for.
  const effectiveConcurrency = Number.isFinite(Number(concurrency))
    ? Number(concurrency)
    : Number(quotaPolicy?.max_concurrency)
  const effectiveRpm = Number.isFinite(Number(maxRpm)) ? Number(maxRpm) : Number(quotaPolicy?.max_rpm)
  const cap = Number(effectiveConcurrency) > 0 ? Number(effectiveConcurrency) : 1
  const slot = slotOf(id)
  if (slot.inFlight >= cap) return null
  const rpm = Number(effectiveRpm) || 0
  if (rpm > 0 && recentStarts(slot, now) >= rpm) return null
  recentStarts(slot, now)
  slot.inFlight += 1
  slot.lastStartedAt = now
  slot.starts.push(now)
  let released = false
  return {
    id: String(id || ''),
    release() {
      if (released) return
      released = true
      slot.inFlight = Math.max(0, slot.inFlight - 1)
      wakeOpenAIWaiter(id)
    },
  }
}

export function openAIWaiterCount() {
  return waiters.length
}

/**
 * FIFO per account: a seat freed on `accountId` wakes the oldest waiter that
 * can use that account (or that parked without an account set). Without an id
 * the oldest waiter wakes, for changes that may open any account.
 */
export function wakeOpenAIWaiter(accountId = null) {
  const key = accountId == null ? null : String(accountId)
  const at = key == null ? 0 : waiters.findIndex((entry) => !entry.accounts || entry.accounts.has(key))
  if (at < 0 || at >= waiters.length) return
  const [next] = waiters.splice(at, 1)
  next.wake(key)
}

/**
 * Park until a seat frees, `deadline` passes, or `signal` aborts.
 * `accounts` limits which releases wake this waiter; omit it to wake on any.
 * `front` re-parks a woken waiter at the head of the queue; it was already
 * counted, so it is not refused by the queue cap.
 * Resolves `{ woken, accountId }`; throws `pool_wait_queue_full` past OPENAI_MAX_WAITERS.
 */
export function waitForOpenAICapacity({ deadline, signal = null, accounts = null, front = false } = {}) {
  if (!front && waiters.length >= OPENAI_MAX_WAITERS) {
    return Promise.reject(Object.assign(new Error('OpenAI pool wait queue is full'), { code: 'pool_wait_queue_full' }))
  }
  return new Promise((resolve) => {
    const entry = { accounts: accounts ? new Set(Array.from(accounts, String)) : null }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      const at = waiters.indexOf(entry)
      if (at >= 0) waiters.splice(at, 1)
    }
    const onAbort = () => {
      cleanup()
      resolve({ woken: false, aborted: true })
    }
    entry.wake = (accountId = null) => {
      cleanup()
      resolve({ woken: true, accountId })
    }
    const timer = setTimeout(
      () => {
        cleanup()
        resolve({ woken: false })
      },
      Math.max(1, Number(deadline) - Date.now()),
    )
    timer.unref?.()
    if (front) waiters.unshift(entry)
    else waiters.push(entry)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

export function reportOpenAIAttempt(id, kind, firstOutputMs = null, now = Date.now()) {
  const key = String(id || '')
  if (!key) return
  if (kind === 'succeeded') holds.delete(key)
  const entry = feedback.get(key) || { value: 0, updatedAt: null, latency: null }
  const sample = kind === 'succeeded' ? 0 : 1
  const alpha = kind === 'capacity_rejected' ? CAPACITY_ALPHA : FAILURE_ALPHA
  const decayed = decayedFailure(entry, now)
  entry.value = alpha * sample + (1 - alpha) * decayed
  entry.updatedAt = now
  const latency = Number(firstOutputMs)
  if (Number.isFinite(latency) && latency > 0) {
    entry.latency = entry.latency == null ? latency : FAILURE_ALPHA * latency + (1 - FAILURE_ALPHA) * entry.latency
  }
  feedback.set(key, entry)
}

export function resetOpenAIAccountRuntime() {
  slots.clear()
  feedback.clear()
  holds.clear()
  for (const entry of waiters.splice(0)) entry.wake()
  roundRobinCursor = 0
}
