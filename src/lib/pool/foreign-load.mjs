/**
 * Blue/green overlap: the draining controller's live load, as seen by the new leader.
 *
 * Scheduling state (per-account/per-family/per-VM inflight, open session seats, quota inflight) is
 * in memory only. Without this the new leader would see every slot idle while the old controller
 * still streams on it, and hand out up to twice the configured concurrency.
 *
 * The draining controller writes exportLiveLoad() to a small JSON file as its requests finish; the
 * leader folds the difference into its own counters (createForeignLoad().apply) and takes it out
 * again when the old controller exits (clear). Seats come back as restored seats that carry one
 * hold for the peer, so a session that continues on the new leader keeps its slot, and a request
 * the new leader finishes first does not free a seat the peer is still streaming on.
 */
import fs from 'node:fs'
import path from 'node:path'

const count = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : 0)

function mapToObject(map) {
  const out = {}
  for (const [k, v] of map || []) if (count(v)) out[k] = count(v)
  return out
}

export function exportLiveLoad({ scheduler, accountQuota, apiKeys } = {}) {
  const families = {}
  for (const [accountId, byFamily] of scheduler?.inflightFamily || []) {
    const row = mapToObject(byFamily)
    if (Object.keys(row).length) families[accountId] = row
  }
  // byVm is the complete book: a family seat whose session moved on while its requests still run
  // (planner.leaveHome) is no longer in planner.seats but still occupies its cell.
  const planner = scheduler?.planner
  const seats = []
  for (const book of planner?.byVm?.values?.() || []) {
    for (const seat of book.values()) {
      if (!seat?.live || !(seat.inflight > 0)) continue
      seats.push({
        seatKey: seat.seatKey,
        vmId: seat.vmId,
        accountId: seat.accountId,
        index: seat.index,
        home: planner.seats?.get?.(seat.seatKey) === seat,
        family: !!seat.family,
      })
    }
  }
  return {
    accounts: mapToObject(scheduler?.inflight),
    families,
    vms: mapToObject(scheduler?.vmInflight),
    quota: mapToObject(accountQuota?.inflight),
    keys: mapToObject(apiKeys?.inflight),
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

const EMPTY = Object.freeze({ accounts: {}, families: {}, vms: {}, quota: {}, keys: {}, seats: [] })

const ghostKey = (vmId, seatKey) => `${vmId}\u0000${seatKey}`

export function createForeignLoad({ scheduler, accountQuota, apiKeys, logger = console } = {}) {
  let applied = EMPTY
  /** vmId+seatKey → the local seat that holds one reservation for the peer */
  const ghostSeats = new Map()

  function seatOn(planner, vmId, seatKey) {
    for (const seat of planner?.byVm?.get?.(vmId)?.values?.() || []) {
      if (seat.live && seat.seatKey === seatKey) return seat
    }
    return null
  }

  function apply(snapshot) {
    const next = snapshot && typeof snapshot === 'object' ? { ...EMPTY, ...snapshot } : EMPTY
    const accounts = new Set()
    const vms = new Set()
    diffInto(scheduler?.inflight, applied.accounts, next.accounts, accounts)
    diffInto(scheduler?.vmInflight, applied.vms, next.vms, vms)
    diffInto(accountQuota?.inflight, applied.quota, next.quota)
    // Managed-key and per-user concurrency (ApiKeyStore.canAccept) count from this map.
    diffInto(apiKeys?.inflight, applied.keys, next.keys)
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
    const wanted = new Map()
    for (const s of next.seats || []) {
      if (!s?.seatKey || !s?.vmId) continue
      wanted.set(ghostKey(String(s.vmId), String(s.seatKey)), s)
    }
    for (const [key, seat] of ghostSeats) {
      if (wanted.has(key)) continue
      ghostSeats.delete(key)
      // Drop the peer's hold. A session that continued here keeps the seat through its own holds.
      planner?.release?.(seat)
      vms.add(seat.vmId)
    }
    // Home seats first, so a session's home on the peer becomes its home here too.
    const order = [...wanted].sort(([, a], [, b]) => Number(b.home !== false) - Number(a.home !== false))
    for (const [key, s] of order) {
      if (ghostSeats.has(key)) continue
      const vmId = String(s.vmId)
      const seatKey = String(s.seatKey)
      // The session already has a seat on that VM here: one seat, held by both controllers.
      let seat = seatOn(planner, vmId, seatKey)
      if (!seat) {
        const home = s.home !== false && !planner?.seatOf?.(seatKey)
        seat = planner?.restore?.(seatKey, { vmId, accountId: s.accountId || null, index: s.index, home })
        if (seat && s.family) seat.family = true
      }
      if (!seat) continue
      planner.hold(seat)
      ghostSeats.set(key, seat)
      vms.add(vmId)
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
 * Leader side: fold the peer's file in. A missing file counts as no load (a clean exit removes it
 * after the drain). A file that stops being refreshed keeps its last snapshot: the peer may still be
 * streaming with a stalled writer, and dropping its load would let this leader over-admit. The
 * fresh→stale and stale→fresh transitions are logged so an over-admission can be traced afterwards.
 *
 * onGone fires once when the peer has evidently exited, so the overlap ends even if the deploy script
 * never sends SIGHUP: the file was removed, it has not been refreshed for goneMs (crash, kill), or it
 * never appeared within goneMs of activation. The exclusive pass then clears the foreign load.
 */
export function startLoadReader({
  file,
  foreign,
  intervalMs = 1000,
  staleMs = 15000,
  goneMs = 60000,
  onGone = null,
  logger = console,
} = {}) {
  const started = Date.now()
  let seen = false
  let lastFresh = 0
  let stale = false
  let gone = false
  const log = (event, extra = {}) => {
    try {
      logger.log(JSON.stringify({ event, ...extra }))
    } catch {}
  }
  const tick = () => {
    const now = Date.now()
    let missing = false
    let doc = null
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      missing = e?.code === 'ENOENT'
    }
    if (doc && now - Number(doc.at) <= staleMs) {
      if (stale) log('handover-load-fresh', { stale_ms: now - lastFresh })
      stale = false
      seen = true
      lastFresh = now
      foreign.apply(doc.load)
    } else if (missing) {
      foreign.apply(null)
    } else if (seen && !stale) {
      // Keep the last snapshot until the peer is gone.
      stale = true
      log('handover-load-stale', { age_ms: doc ? now - Number(doc.at) : null, kept: true })
    }
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
