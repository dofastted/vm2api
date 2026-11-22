/**
 * Blue/green controller handover.
 *
 * Exactly one controller is the leader: it holds the data-dir flock, runs background jobs and may
 * change shared state (egress helpers, node gates, slot kernels). During a deploy a second
 * controller can be alive next to it:
 *
 *   standby  — booted with KIN_STANDBY=1; HTTP up, no lock, no background jobs, no shared changes.
 *   leader   — owns the lock.
 *   draining — gave the lock away (SIGUSR1) and only finishes the requests it already has.
 *
 * While a peer is draining, the leader is in "overlap": anything that would cut the peer's live
 * streams (recreating egress/gate containers, restarting slot kernels for a newer wrap) is queued
 * with deferUntilExclusive() and runs once the peer has exited (markExclusive()).
 */

let role = 'leader'
let overlap = false
const deferred = new Map()

export function handoverRole() {
  return role
}

export function setHandoverRole(next) {
  role = next
}

export function isOverlap() {
  return overlap
}

export function setOverlap(value) {
  overlap = !!value
}

/** Queue fn until the draining peer has gone; runs now when there is no peer. Same key coalesces. */
export function deferUntilExclusive(key, fn) {
  if (!overlap) return fn()
  deferred.set(key, fn)
  return undefined
}

export function deferredKeys() {
  return [...deferred.keys()]
}

/** Peer gone: leave overlap and run everything that was held back. */
export async function markExclusive({ logger = console } = {}) {
  if (!overlap) return []
  overlap = false
  const jobs = [...deferred.entries()]
  deferred.clear()
  const done = []
  for (const [key, fn] of jobs) {
    try {
      await fn()
      done.push(key)
    } catch (e) {
      logger.warn(`[handover] deferred ${key} failed`, e?.message || e)
    }
  }
  return done
}

export function resetHandoverForTests() {
  role = 'leader'
  overlap = false
  deferred.clear()
}
