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
export function tryAcquireOpenAISlot(id, { concurrency = 1, maxRpm = 0, now = Date.now() } = {}) {
  const cap = Number(concurrency) > 0 ? Number(concurrency) : 1
  const slot = slotOf(id)
  if (slot.inFlight >= cap) return null
  const rpm = Number(maxRpm) || 0
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
      wakeOpenAIWaiter()
    },
  }
}

export function openAIWaiterCount() {
  return waiters.length
}

/** FIFO: one released seat wakes the oldest waiter. A woken waiter that still misses passes it on. */
export function wakeOpenAIWaiter() {
  const next = waiters.shift()
  next?.wake()
}

/**
 * Park until a seat frees, `deadline` passes, or `signal` aborts.
 * Resolves `{ woken }`; throws `pool_wait_queue_full` past OPENAI_MAX_WAITERS.
 */
export function waitForOpenAICapacity({ deadline, signal = null } = {}) {
  if (waiters.length >= OPENAI_MAX_WAITERS) {
    return Promise.reject(Object.assign(new Error('OpenAI pool wait queue is full'), { code: 'pool_wait_queue_full' }))
  }
  return new Promise((resolve) => {
    const entry = {}
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
    entry.wake = () => {
      cleanup()
      resolve({ woken: true })
    }
    const timer = setTimeout(
      () => {
        cleanup()
        resolve({ woken: false })
      },
      Math.max(1, Number(deadline) - Date.now()),
    )
    timer.unref?.()
    waiters.push(entry)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

export function reportOpenAIAttempt(id, kind, firstOutputMs = null, now = Date.now()) {
  const key = String(id || '')
  if (!key) return
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
  for (const entry of waiters.splice(0)) entry.wake()
  roundRobinCursor = 0
}
