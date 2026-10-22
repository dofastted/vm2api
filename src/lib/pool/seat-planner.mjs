/**
 * Pre-scheduler seat book for the Claude pool.
 *
 * A seat is one inbound device (seat key) bound to one VM. Every concurrent
 * request of that device rides the same seat and shares the VM's concurrency;
 * a device is never split across VMs. Seat capacity is the VM's
 * `session_slots`; concurrency and RPM stay with PoolScheduler.reserve().
 *
 * Queues:
 *   vmQueue[vm]  `conc` tickets: a seated device waiting for VM concurrency.
 *                `seat` tickets: a device bound to this VM waiting for a seat.
 *   globalQueue  new devices (and sticky waits past their timeout); the first
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
    graceMs = 30_000,
    reservePct = 0.02,
    strategy = 'balanced',
    /** Read at use time: the scheduler owns `sticky_wait_timeout_ms` and hot-reloads it. */
    stickyWaitMs = () => 45_000,
    onChange = null,
    asyncGrants = false,
  } = {}) {
    this.graceMs = graceMs
    this.reservePct = reservePct
    this.strategy = normalizeSeatStrategy(strategy)
    this.stickyWaitMs = stickyWaitMs
    this.onChange = onChange
    this.asyncGrants = asyncGrants
    this.tasks = new Set()
    this.failure = null
    /** @type {Map<string, object>} seatKey → live seat */
    this.seats = new Map()
    /** @type {Map<string, Map<number, object>>} vmId → index → seat */
    this.byVm = new Map()
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

  seatOf(seatKey) {
    if (!seatKey) return null
    return this.seats.get(String(seatKey)) || null
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
  hasSeatWaiters(vmId) {
    const id = String(vmId)
    if ((this.vmQueues.get(id) || []).some((ticket) => ticket.kind === 'seat')) return true
    return this.globalQueue.some((ticket) => ticket.accepts(id))
  }

  /** Seated requests of this VM already waiting for concurrency: newcomers line up behind them. */
  hasConcWaiters(vmId) {
    return (this.vmQueues.get(String(vmId)) || []).some((ticket) => ticket.kind === 'conc')
  }

  open(seatKey, { vmId, accountId = null, cap = 0, index = null }) {
    const key = String(seatKey)
    const id = String(vmId)
    let book = this.byVm.get(id)
    if (!book) {
      book = new Map()
      this.byVm.set(id, book)
    }
    let slotIndex = index ?? 0
    if (index == null) while (book.has(slotIndex)) slotIndex += 1
    const seat = {
      seatKey: key,
      vmId: id,
      accountId,
      index: slotIndex,
      inflight: 0,
      graceUntil: null,
      timer: null,
      live: true,
    }
    book.set(slotIndex, seat)
    this.seats.set(key, seat)
    if (cap) this.noteCap(id, cap)
    this.rehome(key, id)
    this.changed()
    return seat
  }

  hold(seat) {
    seat.inflight += 1
    clearTimeout(seat.timer)
    seat.timer = null
    if (seat.graceUntil != null) {
      seat.graceUntil = null
      this.changed()
    }
  }

  /**
   * One request of this seat finished. The last one starts the grace window:
   * the seat stays with its device for `graceMs`, then frees. A device that
   * still has a ticket queued on this VM keeps the seat; grace starts again
   * once that queue has drained.
   */
  release(seat) {
    if (!seat) return
    seat.inflight = Math.max(0, seat.inflight - 1)
    if (!seat.live) {
      this.pump(seat.vmId)
      return
    }
    if (seat.inflight === 0) this.armGrace(seat)
    this.pump(seat.vmId)
  }

  /** Tickets queued on this seat's VM. Global waiters do not keep the seat. */
  queuedOn(seat) {
    return (this.vmQueues.get(seat.vmId) || []).some((ticket) => ticket.seatKey === seat.seatKey)
  }

  /**
   * Own the seat for `graceMs` after the last in-flight request. `graceMs`
   * of 0 still frees immediately. Failover calls `free` and never comes here.
   */
  armGrace(seat) {
    if (!seat?.live || seat.inflight !== 0 || seat.timer) return
    if (!(this.graceMs > 0)) {
      this.free(seat)
      return
    }
    if (this.queuedOn(seat)) return
    seat.graceUntil = Date.now() + this.graceMs
    seat.timer = setTimeout(() => {
      seat.timer = null
      if (!seat.live || seat.inflight !== 0) return
      // Queued work of this device would otherwise reopen the seat ahead of
      // devices already waiting for one.
      if (this.queuedOn(seat)) {
        seat.graceUntil = null
        this.changed()
        return
      }
      this.free(seat)
    }, this.graceMs)
    seat.timer.unref?.()
    this.changed()
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
    seat.graceUntil = null
    if (this.seats.get(seat.seatKey) === seat) this.seats.delete(seat.seatKey)
    const book = this.byVm.get(seat.vmId)
    if (book?.get(seat.index) === seat) book.delete(seat.index)
    if (book && book.size === 0) this.byVm.delete(seat.vmId)
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
    if (!ticket?.queued) return
    const seatKey = ticket.seatKey
    const vmId = ticket.vmId
    this.unlink(ticket)
    const seat = vmId ? this.seatOf(seatKey) : null
    // A timeout never calls release. Rearm grace once this VM's queue is empty
    // so the seat does not stay taken after the device gave up.
    if (seat?.vmId === vmId) this.armGrace(seat)
    this.changed()
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
        if (id === vmId && ticket.kind === 'conc') continue
        moved.push(ticket)
      }
    }
    const deadline = Date.now() + this.stickyWaitMs()
    for (const ticket of moved) {
      this.place(ticket, { kind: 'conc', vmId })
      ticket.deadline = deadline
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
    if (this.asyncGrants) return this.pumpAsync(vmId)
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

  track(operation) {
    const task = Promise.resolve(operation)
    this.tasks.add(task)
    task.then(
      () => this.tasks.delete(task),
      (error) => {
        this.failure ||= error
        this.tasks.delete(task)
      },
    )
    return task
  }

  async flush() {
    while (this.tasks.size) await Promise.allSettled([...this.tasks])
    if (this.failure) throw this.failure
  }

  pumpAsync(vmId) {
    const id = String(vmId || '')
    if (!id) return Promise.resolve()
    this.dirty.add(id)
    if (this.pumping) return this.pumpingTask
    this.pumping = true
    this.pumpingTask = this.track(
      (async () => {
        try {
          while (this.dirty.size) {
            const next = this.dirty.values().next().value
            this.dirty.delete(next)
            await this.pumpOneAsync(next)
          }
        } finally {
          this.pumping = false
        }
      })(),
    )
    return this.pumpingTask
  }

  async pumpOneAsync(vmId) {
    for (const kind of ['conc', 'seat']) {
      for (const ticket of [...(this.vmQueues.get(vmId) || [])]) {
        if (!ticket.queued || ticket.kind !== kind) continue
        if (!(await this.grantAsync(ticket, vmId))) break
      }
    }
    for (const ticket of [...this.globalQueue]) {
      if (!ticket.queued || !ticket.accepts(vmId)) continue
      await this.grantAsync(ticket, vmId)
    }
  }

  async grantAsync(ticket, vmId) {
    let result
    try {
      result = await ticket.tryGrant(vmId)
    } catch (error) {
      ticket.error = error
      ticket.wake?.()
      throw error
    }
    if (!result) return false
    const granted = typeof result === 'object' ? result : ticket.granted
    if (!ticket.queued || (Number.isFinite(ticket.deadline) && Date.now() >= ticket.deadline)) {
      ticket.granted = null
      await granted?.reservation?.release?.()
      return false
    }
    ticket.granted = granted
    this.unlink(ticket)
    this.changed()
    ticket.wake?.()
    return true
  }

  pumpOne(vmId) {
    for (const kind of ['conc', 'seat']) {
      for (const ticket of [...(this.vmQueues.get(vmId) || [])]) {
        if (!ticket.queued || ticket.kind !== kind) continue
        if (!this.grant(ticket, vmId)) break
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
    this.changed()
    ticket.wake?.()
    return true
  }

  pending() {
    let total = this.globalQueue.length
    for (const queue of this.vmQueues.values()) total += queue.length
    return total
  }

  /** Earliest grace expiry among these VMs (ms from now), the best wake estimate for a 529. */
  retryAfterMs(vmIds = null) {
    const now = Date.now()
    const wanted = vmIds ? new Set([...vmIds].map(String)) : null
    let soonest = null
    for (const seat of this.seats.values()) {
      if (seat.graceUntil == null || seat.graceUntil <= now) continue
      if (wanted && !wanted.has(seat.vmId)) continue
      const left = seat.graceUntil - now
      if (soonest == null || left < soonest) soonest = left
    }
    return soonest
  }

  /** Per-VM seat and queue counts; VMs absent from the map are idle. */
  snapshot() {
    const seats = {}
    const row = (vmId) =>
      (seats[vmId] ||= {
        seats_used: 0,
        seats_max: this.caps.get(vmId) || 0,
        seats_grace: 0,
        queue_depth: 0,
        conc_waiting: 0,
      })
    for (const [vmId, book] of this.byVm) {
      const entry = row(vmId)
      entry.seats_used = book.size
      for (const seat of book.values()) if (seat.graceUntil != null) entry.seats_grace += 1
    }
    for (const [vmId, queue] of this.vmQueues) {
      const entry = row(vmId)
      entry.queue_depth += queue.length
      entry.conc_waiting += queue.filter((ticket) => ticket.kind === 'conc').length
    }
    return { seats, global_queue_depth: this.globalQueue.length }
  }
}

function insertByArrival(queue, ticket) {
  let at = queue.length
  while (at > 0 && queue[at - 1].enqueuedAt > ticket.enqueuedAt) at -= 1
  queue.splice(at, 0, ticket)
}
