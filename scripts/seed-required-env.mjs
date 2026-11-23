/**
 * Align every slot to current seed telemetry contract.
 * telemetry ON  → delete kill-switch keys, write worker.json.telemetry.enabled
 * telemetry OFF → write kill-switch keys = 1
 * Does not restart workers or Node.
 */
import path from 'node:path'
import { listVms, getVm } from '../src/lib/vm/vm-registry.mjs'
import { atomicWriteJson } from '../src/lib/vm/vm-file.mjs'
import { loadVmIdentity, persistVmSettings } from '../src/lib/identity/vm-identity.mjs'
import {
  defaultSeedPolicy,
  NONESSENTIAL_TRAFFIC_ENV_KEY,
  TELEMETRY_KILL_ENV_KEYS,
} from '../src/lib/protocol/seed-policy.mjs'
import { syncWorkerTelemetry } from '../src/lib/vm/vm-runtime.mjs'

const root = process.argv[2] || '/opt/kin-gateway'
const enable = !/^off|false|0|disable/i.test(String(process.argv[3] || 'on'))
const ids = listVms(root).map((vm) => vm.id)
const missing = []
let wrote = 0
let unchanged = 0
let failed = 0
let workerOn = 0
for (const id of ids) {
  const vm = getVm(root, id)
  if (!vm) {
    failed += 1
    missing.push(id)
    continue
  }
  const next = defaultSeedPolicy({
    ...(vm.seed_policy || {}),
    telemetry_disabled: !enable,
  })
  vm.seed_policy = next
  vm.updated_at = new Date().toISOString()
  const vmPath = path.join(root, 'vms', `${id}.json`)
  atomicWriteJson(vmPath, vm, { mode: 0o600 })
  const exec = {
    vmId: id,
    homeDir: path.join(root, 'vms', id, 'cli-home'),
    vmPath,
    timezone: vm.timezone,
    locale: vm.locale,
    seedPolicy: next,
    vm,
  }
  try {
    const identity = loadVmIdentity(exec)
    const result = persistVmSettings(exec, identity)
    const env = identity.settings?.env || {}
    const killKeys = TELEMETRY_KILL_ENV_KEYS.filter((key) => key !== NONESSENTIAL_TRAFFIC_ENV_KEY)
    const keysPresent = killKeys.filter((key) => Object.prototype.hasOwnProperty.call(env, key))
    const nonessential = env[NONESSENTIAL_TRAFFIC_ENV_KEY]
    const ok = enable
      ? keysPresent.length === 0 && nonessential === undefined
      : keysPresent.includes('DISABLE_TELEMETRY') && nonessential === undefined
    if (!ok) {
      failed += 1
      missing.push(id)
      continue
    }
    const tel = syncWorkerTelemetry(vm, root)
    if (tel.enabled) workerOn += 1
    if (result.wrote || tel.wrote) wrote += 1
    else unchanged += 1
  } catch {
    failed += 1
    missing.push(id)
  }
}
console.log(
  JSON.stringify({
    total: ids.length,
    telemetry_enabled: enable,
    seed_policy_on: enable,
    wrote,
    unchanged,
    worker_telemetry_enabled: workerOn,
    failed,
    missing: missing.slice(0, 12),
  }),
)
if (failed) process.exit(1)
