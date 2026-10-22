import { HaRequestRecovery } from './ha-request-recovery.mjs'

function reportFailure(error) {
  const code =
    typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(error.code) ? error.code : 'ha_recovery_failed'
  console.warn(`[ha-recovery] ${code}`)
  return code
}

/** Each Pod scans independently; exact parent transactions and the settlement ledger provide idempotency. */
export function createHaRecoveryMonitor({ db, coordinator, readNodeRecoveryStatus }) {
  const recovery = new HaRequestRecovery(db, { coordinator, readNodeRecoveryStatus })
  let cursor = null
  let scanCursor = null
  let inflight = null
  let timer = null
  let generation = 0

  const failed = (error) => ({ results: [], nextCursor: cursor, errorCode: reportFailure(error) })

  const runOnce = () => {
    if (inflight) return inflight
    inflight = coordinator
      .runActivity({ kind: 'ha_request_recovery' }, async () => {
        try {
          const scans = await coordinator.recoverHaRecoveryScans({ limit: 20, afterActivityId: scanCursor })
          scanCursor = scans.nextCursor
          const value = await recovery.scan({ limit: 20, afterRequestId: cursor })
          cursor = value.nextCursor
          for (const result of value.results) {
            if (result.errorCode) reportFailure({ code: result.errorCode })
          }
          return { ended: true, value }
        } catch (error) {
          // Only historical node reads are sent. Their failure cannot leave work owned by this scan running.
          const value = failed(error)
          return { ended: true, reason: value.errorCode, value }
        }
      })
      .catch(failed)
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  const flush = () => inflight || Promise.resolve()

  const stop = () => {
    generation++
    if (timer) clearInterval(timer)
    timer = null
    return flush()
  }

  const start = () => {
    if (timer) return flush()
    const current = ++generation
    timer = setInterval(() => {
      if (current === generation) void runOnce()
    }, 5000)
    timer.unref?.()
    return runOnce()
  }

  return { start, stop, flush, runOnce }
}
