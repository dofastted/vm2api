/**
 * Blue/green overlap: the draining controller's live load, as seen by the new leader.
 *
 * Scheduling state (per-account/per-family/per-VM inflight, open session seats, quota inflight) is
 * in memory only. Without this the new leader would see every slot idle while the old controller
 * still streams on it, and hand out up to twice the configured concurrency.
 *
 * The draining controller writes exportLiveLoad() to a small JSON file as its requests finish; the
 * leader folds the difference into its own counters (applyForeignLoad) and takes it out again when
 * the file goes stale or the old controller exits (clearForeignLoad). Seats come back as plain
 * restored seats, so a session that continues on the new leader keeps its slot.
 */
import fs from 'node:fs'
import path from 'node:path'

const count = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : 0)

function mapToObject(map) {
  const out = {}
  for (const [k, v] of map || []) if (count(v)) out[k] = count(v)
  return out
}

export function exportLiveLoad({ scheduler, accountQuota } = {}) {
  const families = {}
  for (const [accountId, byFamily] of scheduler?.inflightFamily || []) {
    const row = mapToObject(byFamily)
    if (Object.keys(row).length) families[accountId] = row
  }
  const seats = []
  for (const seat of scheduler?.planner?.seats?.values?.() || []) {
    if (!seat?.live || !(seat.inflight > 0)) continue
    seats.push({ seatKey: seat.seatKey, vmId: seat.vmId, accountId: seat.accountId, index: seat.index })
  }
  return {
    accounts: mapToObject(scheduler?.inflight),
    families,
    vms: mapToObject(scheduler?.vmInflight),
    quota: mapToObject(accountQuota?.inflight),
    seats,
  }
}

function adjust(map, key, delta) {
  if (!map || !delta) return
  const next = Math.max(0, (map.get(key) || 0) + delta)
  if (next === 0) map.delete(key)
  else map.set(key, next)
}

function diffInto(map, prev = {}, next = {}, touched) {
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    const delta = count(next[key]) - count(prev[key])
    if (!delta) continue
    adjust(map, key, delta)
    touched?.add(key)
  }
}

const EMPTY = Object.freeze({ accounts: {}, families: {}, vms: {}, quota: {}, seats: [] })

export function createForeignLoad({ scheduler, accountQuota, logger = console } = {}) {
  let applied = EMPTY
  /** seatKey → seat restored for the peer */
  const ghostSeats = new Map()

  function apply(snapshot) {
    const next = snapshot && typeof snapshot === 'object' ? { ...EMPTY, ...snapshot } : EMPTY
    const accounts = new Set()
    const vms = new Set()
    diffInto(scheduler?.inflight, applied.accounts, next.accounts, accounts)
    diffInto(scheduler?.vmInflight, applied.vms, next.vms, vms)
    diffInto(accountQuota?.inflight, applied.quota, next.quota)
    for (const accountId of new Set([...Object.keys(applied.families || {}), ...Object.keys(next.families || {})])) {
      let byFamily = scheduler?.inflightFamily?.get(accountId)
      if (!byFamily && scheduler?.inflightFamily) {
        byFamily = new Map()
        scheduler.inflightFamily.set(accountId, byFamily)
      }
      diffInto(byFamily, applied.families?.[accountId], next.families?.[accountId])
      if (byFamily && byFamily.size === 0) scheduler.inflightFamily.delete(accountId)
      accounts.add(accountId)
    }
    const planner = scheduler?.planner
    const wanted = new Map((next.seats || []).filter((s) => s?.seatKey && s?.vmId).map((s) => [String(s.seatKey), s]))
    for (const [key, seat] of ghostSeats) {
      if (wanted.has(key)) continue
      ghostSeats.delete(key)
      // The session moved on to this leader meanwhile: the seat is ours now.
      if (seat.live && seat.inflight === 0) planner?.finishDialog?.(seat)
      vms.add(seat.vmId)
    }
    for (const [key, s] of wanted) {
      if (ghostSeats.has(key) || planner?.seatOf?.(key)) continue
      const seat = planner?.restore?.(key, { vmId: s.vmId, accountId: s.accountId || null, index: s.index })
      if (seat) {
        ghostSeats.set(key, seat)
        vms.add(seat.vmId)
      }
    }
    applied = next
    for (const accountId of accounts) scheduler?.notifyCapacity?.(accountId)
    for (const vmId of vms) planner?.pump?.(vmId)
    if (vms.size || accounts.size) scheduler?.signalChange?.()
  }

  return {
    apply,
    clear: () => apply(EMPTY),
    snapshot: () => applied,
    ghostSeatCount: () => ghostSeats.size,
    logger,
  }
}

export function foreignLoadPath(dataDir) {
  return path.join(dataDir, 'run', 'handover-load.json')
}

/** Draining side: rewrite the file when the load changes, and as a heartbeat. */
export function startLoadWriter({ file, read, intervalMs = 1000, heartbeatMs = 5000 } = {}) {
  let last = ''
  let lastWrite = 0
  const write = () => {
    const body = JSON.stringify(read())
    const now = Date.now()
    if (body === last && now - lastWrite < heartbeatMs) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ at: now, load: JSON.parse(body) }))
    fs.renameSync(tmp, file)
    last = body
    lastWrite = now
  }
  const tick = () => {
    try {
      write()
    } catch {}
  }
  tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return {
    stop({ remove = true } = {}) {
      clearInterval(timer)
      if (remove) fs.rmSync(file, { force: true })
    },
  }
}

/**
 * Leader side: fold the peer's file in; a stale or missing file counts as no load.
 *
 * onGone fires once when the peer has evidently exited, so the overlap ends even if the deploy script
 * never sends SIGHUP: the file was removed (a clean exit removes it after the drain), it has not been
 * refreshed for goneMs (crash, kill), or it never appeared within goneMs of activation.
 */
export function startLoadReader({ file, foreign, intervalMs = 1000, staleMs = 15000, goneMs = 60000, onGone = null } = {}) {
  const started = Date.now()
  let seen = false
  let lastFresh = 0
  let gone = false
  const tick = () => {
    const now = Date.now()
    let load = null
    let missing = false
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (now - Number(doc.at) <= staleMs) {
        load = doc.load
        seen = true
        lastFresh = now
      }
    } catch (e) {
      missing = e?.code === 'ENOENT'
    }
    foreign.apply(load)
    if (gone || !onGone) return
    const peerGone = seen ? missing || now - lastFresh > goneMs : now - started > goneMs
    if (!peerGone) return
    gone = true
    try {
      onGone()
    } catch {}
  }
  tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return {
    stop() {
      clearInterval(timer)
      foreign.clear()
    },
  }
}
