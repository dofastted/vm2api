/**
 * KVM runner identity: MAC and virtio disk serial must match the slot's first boot.
 * They live on vm.machine and in the stopped container's env; image/network recreate
 * must backfill from the container (or guest hardware probe) before docker rm.
 */
import { VM_CONFIG_DEFAULTS } from './machine-spec.mjs'
import { patchVmRecord } from './vm-registry.mjs'

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i
const DISK_SERIAL_RE = /^[\x20-\x7e]{1,64}$/

function presentText(value) {
  if (value == null) return ''
  const text = String(value).trim()
  return text || ''
}

function macOk(value) {
  const text = presentText(value).toLowerCase()
  return text && MAC_RE.test(text) ? text : ''
}

function diskSerialOk(value) {
  const text = presentText(value)
  if (!text || !DISK_SERIAL_RE.test(text) || text.includes(',')) return ''
  return text
}

/** @param {string[]|null|undefined} rows Docker Config.Env */
export function dockerEnvMap(rows) {
  const map = {}
  if (!Array.isArray(rows)) return map
  for (const row of rows) {
    const text = String(row || '')
    const eq = text.indexOf('=')
    if (eq <= 0) continue
    map[text.slice(0, eq)] = text.slice(eq + 1)
  }
  return map
}

export function readDockerContainerEnv(containerName, { run } = {}) {
  const name = presentText(containerName)
  if (!name || typeof run !== 'function') return null
  const r = run(['docker', 'inspect', '-f', '{{json .Config.Env}}', name], { timeout: 15_000 })
  if (!r.ok) return null
  try {
    return dockerEnvMap(JSON.parse(String(r.stdout || '[]').trim() || '[]'))
  } catch {
    return null
  }
}

function pickMac(vm, containerEnv) {
  return macOk(vm?.machine?.mac) || macOk(containerEnv?.KIN_KVM_MAC) || macOk(vm?.fingerprint?.hardware?.mac) || ''
}

function pickDiskSerial(vm, containerEnv) {
  return diskSerialOk(vm?.machine?.disk_serial) || diskSerialOk(containerEnv?.KIN_KVM_DISK_SERIAL) || ''
}

/**
 * Merge MAC / disk_serial onto vm.machine from the slot record, an existing
 * container, or guest hardware probes. Optionally persist to vms/<id>.json.
 * @returns {boolean} true when vm.machine was updated in memory
 */
export function ensureKvmMachineRecord(
  vm,
  { projectRoot, containerName, containerEnv: containerEnvIn, run, persist = false } = {},
) {
  if (!vm?.id) return false
  const containerEnv =
    containerEnvIn && typeof containerEnvIn === 'object'
      ? containerEnvIn
      : containerName
        ? readDockerContainerEnv(containerName, { run })
        : null
  const mac = pickMac(vm, containerEnv)
  const disk_serial = pickDiskSerial(vm, containerEnv)
  if (!mac && !disk_serial) return false
  const machine = vm.machine && typeof vm.machine === 'object' ? { ...vm.machine } : {}
  let changed = false
  if (mac && machine.mac !== mac) {
    machine.mac = mac
    changed = true
  }
  if (disk_serial && machine.disk_serial !== disk_serial) {
    machine.disk_serial = disk_serial
    changed = true
  }
  if (!changed) return false
  vm.machine = machine
  if (persist && projectRoot) {
    patchVmRecord(projectRoot, vm.id, (record) => ({
      machine: { ...(record.machine && typeof record.machine === 'object' ? record.machine : {}), ...machine },
    }))
  }
  return true
}

/**
 * True when runner env is present but MAC or disk serial is empty.
 * @param {Record<string, string>|null|undefined} envMap
 * @param {string[]|null|undefined} envRows raw Config.Env from inspect (undefined = not in payload)
 */
export function kvmEnvMapIncomplete(envMap, envRows) {
  if (!Array.isArray(envRows)) return false
  const map = envMap && typeof envMap === 'object' ? envMap : {}
  return !macOk(map.KIN_KVM_MAC) || !diskSerialOk(map.KIN_KVM_DISK_SERIAL)
}

/** True when a stopped/running kvm container is missing runner env the entry script requires. */
export function kvmContainerEnvIncomplete(containerName, { run } = {}) {
  const env = readDockerContainerEnv(containerName, { run })
  if (!env) return false
  return kvmEnvMapIncomplete(env, env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : [])
}

export function kvmMachineFields(vm) {
  const m = vm?.machine && typeof vm.machine === 'object' ? vm.machine : {}
  const smbios = m.smbios && typeof m.smbios === 'object' ? m.smbios : {}
  const d = VM_CONFIG_DEFAULTS
  return {
    vcpus: Number.isInteger(m.vcpus) ? m.vcpus : d.vcpus,
    disk_gb: Number.isInteger(m.disk_gb) ? m.disk_gb : d.disk_gb,
    cpu_model: m.cpu_model || d.cpu_model,
    mac: macOk(m.mac),
    smbios: {
      manufacturer: smbios.manufacturer || d.smbios.manufacturer,
      product: smbios.product || d.smbios.product,
      version: smbios.version || d.smbios.version,
      family: smbios.family || d.smbios.family,
      serial: smbios.serial || '',
      uuid: smbios.uuid || '',
    },
    disk_serial: diskSerialOk(m.disk_serial),
  }
}
