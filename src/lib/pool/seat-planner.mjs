/**
 * Pre-scheduler seat book for the Claude pool.
 *
 * A seat is one client session (seat key) bound to one VM slot. Every
 * concurrent request of that session rides the same seat and shares the VM's
 * concurrency; a session is never split across VMs. Two sessions on the same
 * device are two seats. Seat capacity is the VM's `session_slots`;
 * concurrency and RPM are managed by the Rust scheduler.
 *
 * The live seat frees when its last request and any queued follow-up finish.
 * Sticky VM memory and persisted restart holds have their own lifetimes.
 *
 * Queues:
 *   vmQueue[vm]  `conc` tickets: a seated session waiting for VM concurrency.
 *                `seat` tickets: a session bound to this VM waiting for a seat.
 *   globalQueue  new sessions (and sticky waits past their timeout); the first
 *                ticket that accepts a VM gets its free seat.
 *
 * Grants are synchronous: a ticket's tryGrant() writes the seat and the
 * reservation before its promise resolves, so a newcomer always sees the seat
 * as taken and cannot jump the queue.
 */

export const SEAT_STRATEGIES = Object.freeze(['balanced', 'fill'])

/** Float slack so a headroom exactly on the reserve line still opens. */
const BUDGET_EPSILON = 1e-9

export function normalizeSeatStrategy(value) {
  return String(value || '').trim() === 'fill' ? 'fill' : 'balanced'
}

/**
 * Budget gate for a new seat: headroom must cover this seat and every open
 * one at `reservePct` each. Unknown headroom (no /usage reading yet) passes.
 */
export function budgetAllows(headroom, open, reservePct) {
  if (headroom == null) return true
  const room = Number(headroom)
  if (!Number.isFinite(room)) return true
  return room + BUDGET_EPSILON >= (Number(open) + 1) * Number(reservePct || 0)
}

function occupancy(open, cap) {
  return cap > 0 ? open / cap : 1
}

function headroomRank(value) {
  if (value == null) return Number.POSITIVE_INFINITY
  const n = Number(value)
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY
}

/**
 * Order VMs for a new seat. Priority first; inside one level balanced takes
 * the lowest occupancy and fill the highest (still below cap). Ties go to the
 * larger headroom, then vmId so the result is deterministic.
 * @param {Array<{ vmId: string, priority?: number, seatCap: number, headroom?: number|null }>} candidates
 * @param {{ strategy: string, openOf: (vmId: string) => number }} opts
 */
export function rankSeatCandidates(candidates, { strategy = 'balanced', openOf }) {
  const fill = normalizeSeatStrategy(strategy) === 'fill'
  return [...candidates].sort((left, right) => {
    const priority = (Number(right.priority) || 0) - (Number(left.priority) || 0)
    if (priority) return priority
    const lo = occupancy(openOf(left.vmId), left.seatCap)
    const ro = occupancy(openOf(right.vmId), right.seatCap)
    if (lo !== ro) return fill ? ro - lo : lo - ro
    const lh = headroomRank(left.headroom)
    const rh = headroomRank(right.headroom)
    if (lh !== rh) return rh > lh ? 1 : -1
    return String(left.vmId).localeCompare(String(right.vmId))
  })
}

export class SeatPlanner {
  constructor({
    graceMs = 0,
    reservePct = 0.02,
    strategy = 'balanced',
    /** Read at use time: the scheduler owns `sticky_wait_timeout_ms` and hot-reloads it. */
    stickyWaitMs = () => 45_000,
    /** Sticky VM-memory TTL. It does not keep an idle dialog's session slot. */
    stickyTtlMs = () => 86_400_000,
    onChange = null,
  } = {}) {
    this.graceMs = graceMs
    this.reservePct = reservePct
    this.strategy = normalizeSeatStrategy(strategy)
    this.stickyWaitMs = stickyWaitMs
    this.stickyTtlMs = stickyTtlMs
    this.onChange = onChange
    /** @type {Map<string, object>} seatKey → live seat */
    this.seats = new Map()
    /** @type {Map<string, Map<number, object>>} vmId → index → seat */
    this.byVm = new Map()
    // Scoped root seat → its requests, including serial follow-ups and grants in transit.
    this.subagents = new Map()
    // Only an admitted primary can refresh its scoped root registration.
    this.roots = new Map()
    /** @type {Map<string, object[]>} */
    this.vmQueues = new Map()
    /** @type {object[]} */
    this.globalQueue = []
    /** vmId → last seen seat cap, for snapshots of VMs that hold no seat right now. */
    this.caps = new Map()
    this.pumping = false
    this.dirty = new Set()
  }

  configure({ graceMs, reservePct, strategy } = {}) {
    if (graceMs != null) this.graceMs = graceMs
    if (reservePct != null) this.reservePct = reservePct
    if (strategy != null) this.strategy = normalizeSeatStrategy(strategy)
  }

  changed() {
    try {
      this.onChange?.()
    } catch {}
  }

  noteCap(vmId, cap) {
    this.caps.set(String(vmId), Number(cap) || 0)
  }

  seatOf(seatKey, destination = null, departingSeat = null) {
    if (!seatKey) return null
    const active = this.seats.get(String(seatKey))
    if (!destination || (active && (active !== departingSeat || active.vmId === destination))) return active || null
    // Returning home before the old requests finished reuses their existing seat.
    for (const seat of this.byVm.get(destination)?.values() || []) if (seat.seatKey === seatKey) return seat
    return null
  }

  setRootVm(seatKey, vmId, familyMode) {
    const previous = this.roots.get(seatKey)
    if (familyMode) this.roots.set(seatKey, { vmId, expiresAt: Date.now() + this.stickyTtlMs() })
    if (previous && previous.vmId !== vmId) {
      if (!familyMode) this.roots.delete(seatKey)
      for (const ticket of this.vmQueues.get(previous.vmId) || []) {
        if (ticket.child && ticket.seatKey === seatKey) ticket.wake?.()
      }
    }
  }

  rootVm(seatKey) {
    const root = this.roots.get(seatKey)
    if (root && Date.now() < root.expiresAt) return root.vmId
    this.roots.delete(seatKey)
    return null
  }

  openCount(vmId) {
    return this.byVm.get(String(vmId))?.size || 0
  }

  canOpen(vmId, cap, headroom) {
    const open = this.openCount(vmId)
    if (open >= (Number(cap) || 0)) return false
    return budgetAllows(headroom, open, this.reservePct)
  }

  rank(candidates) {
    return rankSeatCandidates(candidates, { strategy: this.strategy, openOf: (vmId) => this.openCount(vmId) })
  }

  /**
   * A queued ticket that can take a new seat on this VM. A newcomer must not
   * open one while any of these wait: that would jump the queue.
   */
  hasSeatWaiters(vmId, { before = null } = {}) {
    const id = String(vmId)
    const ahead = (ticket) => !before?.child || ticket.sequence < before.sequence
    if ((this.vmQueues.get(id) || []).some((ticket) => ticket.kind === 'seat' && ahead(ticket))) return true
    for (const ticket of this.globalQueue) {
      if (ticket === before) break
      if (ticket.accepts(id) && ahead(ticket)) return true
    }
    return false
  }

  /** Seated requests of this VM already waiting for concurrency: newcomers line up behind them. */
  hasConcWaiters(vmId) {
    return (this.vmQueues.get(String(vmId)) || []).some((ticket) => ticket.kind === 'conc' && !ticket.child)
  }

  earlierSubagentWaiting(child) {
    for (const other of this.subagents.get(child.seatKey) || []) {
      if (!other.running && other.order != null && other.order < child.order) return true
    }
    return false
  }

  trackSubagent(home) {
    const { seatKey } = home
    const family = this.subagents.get(seatKey) || new Set()
    const child = {
      ...home,
      running: false,
      order: null,
      closed: false,
      close: () => {
        if (!family.delete(child)) return
        child.closed = true
        if (!family.size) this.subagents.delete(seatKey)
        const seat = this.seatOf(seatKey)
        this.finishDialog(seat)
        this.pump(child.vmId)
        const current = this.roots.get(seatKey)?.vmId
        if (current && current !== child.vmId) this.pump(current)
        this.changed()
      },
    }
    family.add(child)
    this.subagents.set(seatKey, family)
    this.changed()
    return child
  }

  subagentCounts(seatKey) {
    let running = 0
    let queued = 0
    for (const child of this.subagents.get(seatKey) || []) {
      if (child.running) running++
      else queued++
    }
    return { running, queued }
  }

  open(seatKey, { vmId, accountId = null, cap = 0 }) {
    const key = String(seatKey)
    const id = String(vmId)
    let book = this.byVm.get(id)
    if (!book) {
      book = new Map()
      this.byVm.set(id, book)
    }
    let index = 0
    while (book.has(index)) index += 1
    const seat = {
      seatKey: key,
      vmId: id,
      accountId,
      index,
      inflight: 0,
      heldUntil: null,
      graceUntil: null,
      timer: null,
      live: true,
    }
    book.set(index, seat)
    this.seats.set(key, seat)
    if (cap) this.noteCap(id, cap)
    this.rehome(key, id)
    this.changed()
    return seat
  }
  /**
   * Put a persisted in-flight session back on its slot without treating it
   * as a new open. `index` is kept when that cell is free. `heldUntil` is
   * only a restart race: the dialog already ended, so the slot frees unless
   * that session queues again before the timer. It is not sticky TTL.
   * `home: false` books the cell only, like a family seat after leaveHome:
   * the session's home is elsewhere and this cell frees with its last request.
   */
  restore(seatKey, { vmId, accountId = null, index = null, heldUntil = null, cap = 0, home = true } = {}) {
    const key = String(seatKey || '')
    const id = String(vmId || '')
    if (!key || !id || (home && this.seats.has(key))) return null
    let book = this.byVm.get(id)
    if (!book) {
      book = new Map()
      this.byVm.set(id, book)
    }
    let slot = Number.isInteger(index) && index >= 0 && !book.has(index) ? index : 0
    while (book.has(slot)) slot += 1
    const until = Number(heldUntil) > Date.now() ? Number(heldUntil) : null
    const seat = {
      seatKey: key,
      vmId: id,
      accountId,
      index: slot,
      inflight: 0,
      heldUntil: until,
      graceUntil: until,
      timer: null,
      live: true,
    }
    book.set(slot, seat)
    if (home) this.seats.set(key, seat)
    if (cap) this.noteCap(id, cap)
    if (until) this.armHold(seat)
    this.changed()
    return seat
  }

  hold(seat) {
    seat.inflight += 1
    clearTimeout(seat.timer)
    seat.timer = null
    if (seat.heldUntil != null || seat.graceUntil != null) {
      seat.heldUntil = null
      seat.graceUntil = null
      this.changed()
    }
  }

  /**
   * One request of this seat finished. The last one frees the slot unless
   * another request of this session is already waiting. Sticky VM memory
   * stays in the router until its own TTL.
   */
  release(seat) {
    if (!seat) return
    const followUp = this.followUpWaiting(seat)
    seat.inflight = Math.max(0, seat.inflight - 1)
    if (!seat.live) {
      this.pump(seat.vmId)
      return
    }
    if (seat.inflight === 0 && !followUp) this.finishDialog(seat)
    this.pump(seat.vmId)
    const current = this.roots.get(seat.seatKey)?.vmId
    if (current && current !== seat.vmId) this.pump(current)
  }

  /** A later request is queued, or already granted and not yet taken by its caller. */
  followUpWaiting(seat) {
    if (this.seatOf(seat.seatKey) !== seat) return false
    if (this.subagents.has(seat.seatKey) && this.roots.get(seat.seatKey)?.vmId === seat.vmId) return true
    const mine = (ticket) => ticket.seatKey === seat.seatKey && (!ticket.child || ticket.vmId === seat.vmId)
    for (const queue of this.vmQueues.values()) {
      if (queue.some(mine)) return true
    }
    if (this.globalQueue.some(mine)) return true
    for (const ticket of this.granted || []) {
      if (mine(ticket)) return true
    }
    return false
  }

  noteGranted(ticket) {
    if (!this.granted) this.granted = new Set()
    this.granted.add(ticket)
  }

  forgetGranted(ticket) {
    this.granted?.delete(ticket)
  }

  /**
   * Dialog ended. A follow-up already waiting keeps the slot; otherwise the
   * slot is free now. `heldUntil` is a restart handoff only.
   */
  finishDialog(seat) {
    if (!seat?.live || seat.inflight !== 0 || seat.timer) return
    if (this.followUpWaiting(seat)) return
    const stored = Number(seat.heldUntil)
    const until = stored > Date.now() ? stored : 0
    const wait = until - Date.now()
    if (!(wait > 0)) {
      this.free(seat)
      return
    }
    seat.heldUntil = until
    seat.graceUntil = until
    seat.timer = setTimeout(() => {
      seat.timer = null
      if (!seat.live || seat.inflight !== 0) return
      if (this.followUpWaiting(seat)) {
        seat.heldUntil = null
        seat.graceUntil = null
        this.changed()
        return
      }
      this.free(seat)
    }, wait)
    seat.timer.unref?.()
    this.changed()
  }

  /** @deprecated restart handoff only; a finished dialog does not keep its slot. */
  armHold(seat) {
    this.finishDialog(seat)
  }

  /** @deprecated alias of finishDialog. */
  armGrace(seat) {
    this.finishDialog(seat)
  }

  /** Drop the seat now. Requests still running on it finish; their release only counts down. */
  free(seat) {
    if (!seat?.live) return
    this.detachSeat(seat)
    this.changed()
    this.pump(seat.vmId)
  }

  detachSeat(seat) {
    seat.live = false
    clearTimeout(seat.timer)
    seat.timer = null
    seat.heldUntil = null
    seat.graceUntil = null
    if (this.seats.get(seat.seatKey) === seat) this.seats.delete(seat.seatKey)
    const book = this.byVm.get(seat.vmId)
    if (book?.get(seat.index) === seat) book.delete(seat.index)
    if (book && book.size === 0) this.byVm.delete(seat.vmId)
  }

  /** Keep a draining family seat in this VM's book until its last reservation ends. */
  leaveHome(seat) {
    if (seat.family && seat.inflight > 0) {
      if (this.seats.get(seat.seatKey) === seat) this.seats.delete(seat.seatKey)
      this.changed()
    } else this.free(seat)
  }

  enqueue(ticket) {
    ticket.queued = true
    if (ticket.vmId) {
      const id = String(ticket.vmId)
      const queue = this.vmQueues.get(id) || []
      insertByArrival(queue, ticket)
      this.vmQueues.set(id, queue)
    } else {
      insertByArrival(this.globalQueue, ticket)
    }
    this.changed()
  }

  remove(ticket) {
    if (ticket?.queued) {
      const { seatKey, vmId } = ticket
      this.unlink(ticket)
      const seat = vmId ? this.seatOf(seatKey) : null
      // A timeout never calls release. Rearm the sticky hold once this VM's
      // queue is empty so the seat does not stay taken after the session gave up.
      if (seat?.vmId === vmId) this.armHold(seat)
      this.changed()
    }
    // A migration ticket can also be the last request keeping its source seat alive.
    if (ticket?.departingSeat) this.finishDialog(ticket.departingSeat)
  }

  unlink(ticket) {
    ticket.queued = false
    if (ticket.vmId) {
      const id = String(ticket.vmId)
      const queue = this.vmQueues.get(id)
      if (queue) {
        const at = queue.indexOf(ticket)
        if (at >= 0) queue.splice(at, 1)
        if (!queue.length) this.vmQueues.delete(id)
      }
      return
    }
    const at = this.globalQueue.indexOf(ticket)
    if (at >= 0) this.globalQueue.splice(at, 1)
  }

  /** Move a queued ticket to another queue; arrival order is kept. */
  place(ticket, { kind, vmId = null }) {
    if (ticket.queued) this.unlink(ticket)
    ticket.kind = kind
    ticket.vmId = vmId
    this.enqueue(ticket)
  }

  /** A sticky seat wait ran past its timeout: it may now take a seat on any VM, keeping its arrival order. */
  toGlobal(ticket) {
    if (!ticket?.queued || !ticket.vmId) return
    this.place(ticket, { kind: 'global', vmId: null })
  }

  /**
   * A seat just opened for `seatKey`: its other queued requests now wait for
   * concurrency on that VM, never for a second seat elsewhere. The wait
   * restarts at the sticky timeout measured from this move; the deadline they
   * brought from the global queue would expire them on the wrong clock.
   */
  rehome(seatKey, vmId) {
    const moved = []
    for (const ticket of this.globalQueue) if (ticket.seatKey === seatKey) moved.push(ticket)
    for (const [id, queue] of this.vmQueues) {
      for (const ticket of queue) {
        if (ticket.seatKey !== seatKey) continue
        if (ticket.child) {
          if (id === vmId) ticket.kind = 'conc'
          continue
        }
        if (id === vmId && ticket.kind === 'conc') continue
        moved.push(ticket)
      }
    }
    const deadline = Date.now() + this.stickyWaitMs()
    for (const ticket of moved) {
      if (ticket.expired?.()) continue
      ticket.deadline = Math.min(deadline, ticket.requestDeadline ?? Infinity)
      this.place(ticket, { kind: 'conc', vmId })
      if (!ticket.granted) ticket.wake?.()
    }
    if (moved.length) this.pump(vmId)
  }

  /**
   * Capacity changed on this VM (a release, a seat freed, a cooldown lifted).
   * Grant in order: seated requests waiting for concurrency, then devices
   * waiting for a seat here, then the first global tickets that accept it.
   */
  pump(vmId) {
    const id = String(vmId || '')
    if (!id) return
    this.dirty.add(id)
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.dirty.size) {
        const next = this.dirty.values().next().value
        this.dirty.delete(next)
        this.pumpOne(next)
      }
    } finally {
      this.pumping = false
    }
  }

  pumpAll() {
    const ids = new Set([...this.vmQueues.keys(), ...this.byVm.keys()])
    for (const ticket of this.globalQueue) for (const vmId of ticket.vmIds?.() || []) ids.add(vmId)
    for (const id of ids) this.pump(id)
  }

  pumpOne(vmId) {
    for (const kind of ['conc', 'seat']) {
      for (const ticket of [...(this.vmQueues.get(vmId) || [])]) {
        if (ticket.child) ticket.kind = this.seatOf(ticket.seatKey, vmId)?.vmId === vmId ? 'conc' : 'seat'
        if (!ticket.queued || ticket.kind !== kind) continue
        if (ticket.expired?.()) {
          ticket.wake?.()
          continue
        }
        if (ticket.child && kind === 'seat') {
          // This child needs a new root seat. Older global seekers may take it first.
          for (const earlier of [...this.globalQueue]) {
            if (earlier.sequence < ticket.sequence && earlier.accepts(vmId)) this.grant(earlier, vmId)
          }
          if (this.hasSeatWaiters(vmId, { before: ticket })) continue
        }
        // A child can be blocked on its own family while another root still has capacity.
        if (!this.grant(ticket, vmId) && !ticket.child) break
      }
    }
    for (const ticket of [...this.globalQueue]) {
      if (!ticket.queued || !ticket.accepts(vmId)) continue
      // A refusal specific to this ticket (model cap, refreshed gate) keeps its place.
      this.grant(ticket, vmId)
    }
  }

  grant(ticket, vmId) {
    let granted = false
    try {
      granted = !!ticket.tryGrant(vmId)
    } catch {
      granted = false
    }
    if (!granted) return false
    if (ticket.queued) this.unlink(ticket)
    this.noteGranted(ticket)
    this.changed()
    ticket.wake?.()
    return true
  }

  pending() {
    let total = this.globalQueue.length
    for (const queue of this.vmQueues.values()) total += queue.length
    return total
  }

  /** Earliest sticky-hold expiry among these VMs (ms from now), the best wake estimate for a 529. */
  retryAfterMs(vmIds = null) {
    const now = Date.now()
    const wanted = vmIds ? new Set([...vmIds].map(String)) : null
    let soonest = null
    for (const seat of this.seats.values()) {
      const until = seat.heldUntil ?? seat.graceUntil
      if (until == null || until <= now) continue
      if (wanted && !wanted.has(seat.vmId)) continue
      const left = until - now
      if (soonest == null || left < soonest) soonest = left
    }
    return soonest
  }

  /** Per-VM seat and queue counts; VMs absent from the map are idle. */
  snapshot(limitsOf = () => null) {
    const seats = {}
    const row = (vmId, limits) =>
      (seats[vmId] ??= {
        seats_used: 0,
        seats_max: limits?.subagents != null ? limits.seats : this.caps.get(vmId) || 0,
        seats_grace: 0,
        queue_depth: 0,
        conc_waiting: 0,
        sessions: [],
      })
    for (const [vmId, book] of this.byVm) {
      const limits = limitsOf(vmId)
      const entry = row(vmId, limits)
      entry.seats_used = book.size
      const sessions = []
      for (const seat of book.values()) {
        if (seat.heldUntil != null || seat.graceUntil != null) entry.seats_grace += 1
        const view = sessionView(seat)
        if (limits?.subagents != null) {
          const { running, queued } = this.subagentCounts(seat.seatKey)
          Object.assign(view, { subagents_running: running, subagents_queued: queued, subagents_max: limits.subagents })
        }
        sessions.push(view)
      }
      sessions.sort((a, b) => a.index - b.index)
      entry.sessions = sessions
    }
    for (const [vmId, queue] of this.vmQueues) {
      const entry = seats[vmId] || row(vmId, limitsOf(vmId))
      entry.queue_depth += queue.length
      entry.conc_waiting += queue.filter((ticket) =>
        ticket.child ? ticket.child.waitReason === 'concurrency_limit' : ticket.kind === 'conc',
      ).length
    }
    return { seats, global_queue_depth: this.globalQueue.length }
  }
}

/** Panel label for one occupied slot. Planner keys are `scope|seat:…`. */
function sessionView(seat) {
  const raw = String(seat.seatKey || '')
  const id = raw.includes('|') ? raw.slice(raw.indexOf('|') + 1) : raw
  const held = seat.heldUntil != null || seat.graceUntil != null
  return {
    index: seat.index,
    session_id: id.startsWith('seat:sess:') ? id.slice('seat:sess:'.length) : id,
    state: seat.inflight > 0 ? 'active' : held ? 'held' : 'idle',
    inflight: seat.inflight,
    held_until: seat.heldUntil ?? seat.graceUntil ?? null,
  }
}

function insertByArrival(queue, ticket) {
  let at = queue.length
  while (at > 0 && queue[at - 1].enqueuedAt > ticket.enqueuedAt) at -= 1
  queue.splice(at, 0, ticket)
}
