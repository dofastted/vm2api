import { randomUUID } from 'node:crypto'
import { getVm, patchVmRecord, waitForSlotDrain } from './vm-registry.mjs'
import { applyHold, deriveScheduleFields, HOLD_MAINTENANCE, migrateScheduleRecord } from '../pool/schedule-state.mjs'
import { clearRustHealthCache } from '../transport/kernel-router.mjs'

/** Caller owns the VM lifecycle lock. Keep requests and the watchdog off the entire cutover. */
export async function withSlotMaintenance({ projectRoot, id, watchdog, poolScheduler, operation }) {
  const tag = 'slot-runtime:' + randomUUID()
  let previousHold = null
  let held = false
  try {
    const saved = patchVmRecord(projectRoot, id, (record) => {
      migrateScheduleRecord(record)
      previousHold = record.schedule_hold || null
      applyHold(record, HOLD_MAINTENANCE, { tag })
    })
    if (!saved) return { ok: false, status: 404, code: 'vm_not_found', error: 'vm not found' }
    held = true
    await watchdog?.hold?.(id)
    const drained = await waitForSlotDrain(poolScheduler, [id])
    if (!drained.ok) return { ok: false, status: 409, code: 'slot_drain_timeout', error: '在途请求未结束，未重启内核' }
    return await operation()
  } finally {
    try {
      if (getVm(projectRoot, id)?.schedule_hold?.detail?.tag === tag) {
        patchVmRecord(projectRoot, id, (record) => {
          if (record.schedule_hold?.detail?.tag !== tag) return
          if (previousHold) record.schedule_hold = previousHold
          else delete record.schedule_hold
          deriveScheduleFields(record)
        })
      }
    } finally {
      if (held) {
        clearRustHealthCache(id)
        poolScheduler?.healthCache?.delete?.(id)
        watchdog?.release?.(id)
      }
    }
  }
}
