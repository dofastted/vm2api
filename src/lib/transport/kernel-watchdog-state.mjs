import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { physicalContainerName } from '../vm/vm-physical-target.mjs'

export function watchdogStateKey(vmId) {
  return `kernel_watchdog_state:${physicalContainerName(vmId)}`
}

function validate(value) {
  if (
    value?.version !== 1 ||
    !Array.isArray(value.attempts) ||
    value.attempts.some((at) => !Number.isFinite(at) || at < 0) ||
    !(value.nextAt === null || (Number.isFinite(value.nextAt) && value.nextAt >= 0)) ||
    !Number.isFinite(value.telemetryDue) ||
    value.telemetryDue < 0 ||
    !(value.fault === null || typeof value.fault === 'string')
  )
    throw Object.assign(new Error('Invalid persistent watchdog state'), { code: 'watchdog_state_invalid' })
  return value
}

export async function readWatchdogState(db, vmId) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = $1').get(watchdogStateKey(vmId))
  if (!row) return { version: 1, attempts: [], nextAt: null, telemetryDue: 0, fault: null }
  let value
  try {
    value = JSON.parse(row.value)
  } catch {
    throw Object.assign(new Error('Invalid persistent watchdog state'), { code: 'watchdog_state_invalid' })
  }
  return validate(value)
}

export function writeWatchdogState(db, vmId, value) {
  return new SettingsRepo(db).set(watchdogStateKey(vmId), validate(value))
}
