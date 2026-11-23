/**
 * Kernel slot lease (routing.pool.kernel_lease: off | observe | enforce).
 *
 * The CRAG kernel runs at most `runnable_capacity` native processes at once
 * (`min(slots_per_worker, memory_slot_capacity)`, reported on /internal/health).
 * A process lives only while its request runs, so a lease is one in-flight
 * request: PoolScheduler.vmInflight (foreign blue/green load included) is the
 * ledger, the cached health only sets its capacity.
 *
 * observe: grants are unchanged; a grant the ledger would refuse is counted.
 * enforce: reserve() refuses it, so the scan moves on to a VM with a free slot
 *          (or the request waits in the gateway queue, which a release wakes).
 *
 * A kernel that still answers "no free slot" while the ledger had room is a
 * desync; both modes count it so observe can show whether the ledger is right
 * before enforce trusts it.
 */

export const KERNEL_LEASE_MODES = Object.freeze(['off', 'observe', 'enforce'])

export function normalizeKernelLeaseMode(value) {
  const mode = String(value ?? '')
    .trim()
    .toLowerCase()
  return KERNEL_LEASE_MODES.includes(mode) ? mode : 'off'
}

/** Live kernel capacity, or null when this kernel does not report it (legacy CRAG, Go hop). */
export function kernelCapacityOf(health) {
  if (!health || typeof health !== 'object') return null
  const raw = health.runnable_capacity
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.floor(n))
}

/**
 * Ledger verdict for one more request on a VM.
 * `inflight` is the gateway's live count before this request.
 */
export function leaseVerdict({ capacity, inflight }) {
  if (capacity == null) return 'unknown'
  return Number(inflight || 0) < capacity ? 'ok' : 'over'
}

const COUNTERS = ['granted', 'unknown', 'over', 'denied', 'slot_busy', 'desync', 'slot_busy_over', 'slot_busy_unknown']

/** In-memory counters plus a once-a-minute summary line. */
export class KernelLeaseStats {
  constructor({ log = (line) => console.log(line), intervalMs = 60_000, now = () => Date.now() } = {}) {
    this.log = log
    this.intervalMs = intervalMs
    this.now = now
    this.windowStartedAt = now()
    this.window = this.empty()
    this.total = this.empty()
    this.byVm = new Map()
  }

  empty() {
    return Object.fromEntries(COUNTERS.map((key) => [key, 0]))
  }

  bump(key, vmId) {
    this.window[key] += 1
    this.total[key] += 1
    if (vmId) {
      const row = this.byVm.get(vmId) || this.empty()
      row[key] += 1
      this.byVm.set(vmId, row)
    }
  }

  /** One reserve() decision. */
  noteGrant({ mode, verdict, vmId, capacity, inflight, selectionReason = null, denied = false }) {
    if (verdict === 'unknown') this.bump('unknown', vmId)
    else this.bump('granted', vmId)
    if (verdict === 'over') {
      this.bump(denied ? 'denied' : 'over', vmId)
      this.log(
        `[kernel-lease] ${denied ? 'deny' : 'would-deny'} mode=${mode} vm=${vmId} inflight=${inflight} capacity=${capacity}` +
          (selectionReason ? ` reason=${selectionReason}` : ''),
      )
    }
    this.maybeFlush(mode)
  }

  /** The kernel answered slot_busy for a request the ledger granted with `verdict`. */
  noteSlotBusy({ mode, verdict, vmId, capacity, inflight, message = '' }) {
    this.bump('slot_busy', vmId)
    if (verdict === 'ok') this.bump('desync', vmId)
    else if (verdict === 'over') this.bump('slot_busy_over', vmId)
    else this.bump('slot_busy_unknown', vmId)
    this.log(
      `[kernel-lease] slot_busy mode=${mode} vm=${vmId} verdict=${verdict} inflight=${inflight ?? '-'} capacity=${capacity ?? '-'}` +
        (message ? ` msg=${JSON.stringify(String(message).slice(0, 80))}` : ''),
    )
    this.maybeFlush(mode)
  }

  maybeFlush(mode) {
    const now = this.now()
    if (now - this.windowStartedAt < this.intervalMs) return
    const w = this.window
    if (COUNTERS.some((key) => w[key] > 0)) {
      this.log(
        `[kernel-lease] summary mode=${mode} window_s=${Math.round((now - this.windowStartedAt) / 1000)} ` +
          COUNTERS.map((key) => `${key}=${w[key]}`).join(' '),
      )
    }
    this.window = this.empty()
    this.windowStartedAt = now
  }

  snapshot() {
    return {
      total: { ...this.total },
      by_vm: Object.fromEntries([...this.byVm].map(([vmId, row]) => [vmId, { ...row }])),
    }
  }
}
