import crypto from 'node:crypto'
import { getDb, withTransaction } from '../db/database.mjs'
import { ExecutionAdmissionsRepo } from '../db/repos/execution-admissions-repo.mjs'
import { budgetAllows } from './seat-planner.mjs'
import { lockHaRequestContext } from '../core/ha-request-context.mjs'

function invalid(field) {
  return Object.assign(new Error(`Invalid shared execution ${field}`), { code: 'invalid_execution_admission' })
}

/** Account/VM admission and device-seat ownership commit in the same short transaction. */
export class SharedExecutionAdmissions {
  constructor(db = getDb(), options = {}) {
    this.db = db
    this.executions = new ExecutionAdmissionsRepo(db, options)
  }

  async lockDevice(seatKey) {
    await this.db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      `vm2api:execution:${this.db.schema}`,
      `device:${seatKey}`,
    ])
  }

  async readSeat(seatKey) {
    return this.db
      .prepare(`SELECT s.*,
      (SELECT count(*) FROM execution_admissions a WHERE a.seat_key = s.seat_key
        AND a.seat_generation = s.generation AND a.released_at IS NULL) AS inflight,
      clock_timestamp() AS database_now
      FROM execution_seats s WHERE s.seat_key = $1`)
      .get(seatKey)
  }

  async getSeat(seatKey) {
    const row = await this.readSeat(seatKey)
    if (!row || (!row.inflight && (!row.grace_until || row.grace_until <= row.database_now))) return null
    return {
      seatKey: row.seat_key,
      vmId: row.vm_id,
      accountId: row.account_id,
      slotIndex: row.slot_index,
      generation: row.generation,
      inflight: row.inflight,
      graceUntil: row.grace_until?.getTime() ?? null,
    }
  }

  async getCounts(accountId, vmId) {
    return this.executions.getCounts({ accountId, vmId })
  }

  inspectCircuit(accountId, config) {
    return this.executions.circuits.inspect(accountId, config)
  }

  resetCircuit(accountId, config) {
    return this.executions.circuits.reset(accountId, config)
  }

  async tryReserve(input) {
    const { seatKey } = input
    if (seatKey == null) return this.executions.tryReserve(input)
    if (typeof seatKey !== 'string' || !seatKey.trim()) throw invalid('seatKey')
    if (!Number.isSafeInteger(input.seatCap) || input.seatCap < 0 || input.seatCap > 20) throw invalid('seatCap')
    if (!Number.isSafeInteger(input.seatGraceMs) || input.seatGraceMs < 0 || input.seatGraceMs > 120000)
      throw invalid('seatGraceMs')
    if (!Number.isFinite(input.seatReservePct) || input.seatReservePct < 0 || input.seatReservePct > 1)
      throw invalid('seatReservePct')
    if (input.seatHeadroom != null && !Number.isFinite(input.seatHeadroom)) throw invalid('seatHeadroom')
    const gate = await withTransaction(this.db, async () => {
      // Match direct admission's parent -> device/account/VM lock order.
      await lockHaRequestContext(this.db)
      await this.executions.assertRoutingRevision(input.routingRevision)
      await this.lockDevice(seatKey)
      const before = await this.readSeat(seatKey)
      // A move involves two VM books. Lock both in the same order as admissions.
      await this.executions.lockResources({
        accountId: input.accountId,
        vmIds: [input.vmId, ...(before ? [before.vm_id] : [])],
      })
      await this.db
        .prepare(`DELETE FROM execution_seats s WHERE s.vm_id = ANY($1::text[])
        AND (s.grace_until IS NULL OR s.grace_until <= clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM execution_admissions a WHERE a.seat_key = s.seat_key
          AND a.seat_generation = s.generation AND a.released_at IS NULL)`)
        .run([input.vmId, ...(before ? [before.vm_id] : [])])
      let seat = await this.readSeat(seatKey)
      let previousSeat
      if (seat && (seat.vm_id !== input.vmId || seat.account_id !== input.accountId)) {
        if (seat.inflight || !input.moveSeat) {
          return {
            ok: false,
            code: 'device_seat_bound',
            reason: 'device_seat_bound',
            vmId: seat.vm_id,
            slotIndex: seat.slot_index,
          }
        }
        previousSeat = seat
        seat = null
      }
      let slotIndex = seat?.slot_index
      if (!seat) {
        const { count } = await this.db
          .prepare('SELECT count(*) AS count FROM execution_seats WHERE vm_id = $1 AND seat_key <> $2')
          .get(input.vmId, seatKey)
        if (count >= input.seatCap) return { ok: false, code: 'seat_limit', reason: 'seat_limit' }
        const { count: accountSeats } = await this.db
          .prepare(`SELECT count(*) AS count FROM execution_seats s WHERE s.account_id = $1 AND s.seat_key <> $2
          AND (s.grace_until > clock_timestamp() OR EXISTS (SELECT 1 FROM execution_admissions a
            WHERE a.seat_key = s.seat_key AND a.seat_generation = s.generation AND a.released_at IS NULL))`)
          .get(input.accountId, seatKey)
        if (!budgetAllows(input.seatHeadroom, accountSeats, input.seatReservePct))
          return { ok: false, code: 'seat_budget', reason: 'seat_budget' }
        const free = await this.db
          .prepare(`SELECT n AS slot_index FROM generate_series(0, $2::integer - 1) AS n
          WHERE NOT EXISTS (SELECT 1 FROM execution_seats WHERE vm_id = $1 AND slot_index = n AND seat_key <> $3)
          ORDER BY n LIMIT 1`)
          .get(input.vmId, input.seatCap, seatKey)
        if (!free) return { ok: false, code: 'seat_limit', reason: 'seat_limit' }
        slotIndex = free.slot_index
      }
      const admission = await this.executions.tryReserve(input)
      if (!admission.ok) return admission
      if (previousSeat) {
        await this.db
          .prepare('DELETE FROM execution_seats WHERE seat_key = $1 AND generation = $2')
          .run(seatKey, previousSeat.generation)
      }
      const generation = seat?.generation || crypto.randomUUID()
      if (seat) {
        await this.db
          .prepare('UPDATE execution_seats SET grace_until = NULL, grace_ms = $2 WHERE seat_key = $1')
          .run(seatKey, input.seatGraceMs)
      } else {
        await this.db
          .prepare(`INSERT INTO execution_seats (seat_key, generation, vm_id, account_id, slot_index, grace_ms)
          VALUES ($1,$2,$3,$4,$5,$6)`)
          .run(seatKey, generation, input.vmId, input.accountId, slotIndex, input.seatGraceMs)
      }
      await this.db
        .prepare('UPDATE execution_admissions SET seat_key = $2, seat_generation = $3, slot_index = $4 WHERE id = $1')
        .run(admission.admissionId, seatKey, generation, slotIndex)
      return { ...admission, slotIndex, seatGeneration: generation, seatKey }
    })
    if (!gate.ok) return gate
    return {
      ...gate,
      release: (options) => this.release(gate, options),
      markUncertain: () => this.executions.markUncertain(gate),
    }
  }

  async release(handle, options = {}) {
    if (options.uncertain) return this.executions.markUncertain(handle)
    return withTransaction(this.db, async () => {
      const row = await this.db
        .prepare('SELECT * FROM execution_admissions WHERE id = $1 AND owner_id = $2')
        .get(handle.admissionId, handle.ownerId)
      if (!row) return { released: false }
      if (row.seat_key) await this.lockDevice(row.seat_key)
      const seat = row.seat_key ? await this.readSeat(row.seat_key) : null
      await this.executions.lockResources({
        accountId: row.account_id,
        vmIds: [row.vm_id, ...(seat ? [seat.vm_id] : [])],
      })
      const result = await this.executions.release(handle)
      if (!result.released || !seat || seat.generation !== row.seat_generation) return result
      const after = await this.readSeat(row.seat_key)
      if (after.inflight) return result
      if (after.grace_ms > 0) {
        await this.db
          .prepare(`UPDATE execution_seats SET grace_until = clock_timestamp() + $3::integer * interval '1 millisecond'
          WHERE seat_key = $1 AND generation = $2`)
          .run(row.seat_key, row.seat_generation, after.grace_ms)
      } else {
        await this.db
          .prepare('DELETE FROM execution_seats WHERE seat_key = $1 AND generation = $2')
          .run(row.seat_key, row.seat_generation)
      }
      return result
    })
  }
}
