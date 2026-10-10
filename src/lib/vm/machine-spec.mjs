/**
 * Global `routing.vm` defaults and the per-slot `vm.machine` record.
 * Docker slots only consume memory; KVM uses the full spec. Invalid values
 * never persist through normalize (defaults) or a PUT/create patch (400).
 */
import crypto from 'node:crypto'

export const VM_MEMORY_OPTIONS = Object.freeze(['256m', '512m', '1g', '2g', '4g', '8g', '16g'])
export const VM_CPU_MODELS = Object.freeze([
  'host',
  'qemu64',
  'Skylake-Client-v4',
  'Cascadelake-Server-v5',
  'EPYC-v4',
  'Haswell-noTSX-IBRS',
])

export const VM_CONFIG_DEFAULTS = Object.freeze({
  default_runtime: 'docker',
  memory: '512m',
  vcpus: 2,
  disk_gb: 20,
  cpu_model: 'host',
  smbios: Object.freeze({
    manufacturer: 'Dell Inc.',
    product: 'OptiPlex 7090',
    version: '1.0',
    family: 'OptiPlex',
  }),
  mac_oui: '52:54:00',
  allow_tcg: false,
})

const SMBIOS_KEYS = Object.freeze(['manufacturer', 'product', 'version', 'family'])
const OVERRIDE_KEYS = Object.freeze(['memory', 'vcpus', 'disk_gb'])
const SERIAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isIntInRange(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function memoryOk(value) {
  return VM_MEMORY_OPTIONS.includes(
    String(value || '')
      .trim()
      .toLowerCase(),
  )
}

function cpuModelOk(value) {
  return VM_CPU_MODELS.includes(value)
}

function runtimeOk(value) {
  return value === 'docker' || value === 'kvm'
}

/** QEMU `-smbios` splits on commas; keep the type-1 strings printable and comma-free. */
function smbiosOk(value) {
  if (typeof value !== 'string') return false
  if (value.length > 64) return false
  if (value.includes(',')) return false
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

function macOuiOk(value) {
  const raw = String(value || '').trim()
  if (!/^[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}$/i.test(raw)) return false
  const first = Number.parseInt(raw.slice(0, 2), 16)
  // Least-significant bit of the first octet is the multicast bit; QEMU user-mode
  // NICs must be unicast or the guest never sees a usable address.
  return Number.isInteger(first) && (first & 1) === 0
}

function invalidField(field, message) {
  return { ok: false, error: `${field} ${message}` }
}

export function normalizeVmConfig(raw) {
  const src = isPlainObject(raw) ? raw : {}
  const memory = memoryOk(src.memory) ? String(src.memory).trim().toLowerCase() : VM_CONFIG_DEFAULTS.memory
  const vcpus = isIntInRange(src.vcpus, 1, 16) ? src.vcpus : VM_CONFIG_DEFAULTS.vcpus
  const disk_gb = isIntInRange(src.disk_gb, 10, 200) ? src.disk_gb : VM_CONFIG_DEFAULTS.disk_gb
  const cpu_model = cpuModelOk(src.cpu_model) ? src.cpu_model : VM_CONFIG_DEFAULTS.cpu_model
  const default_runtime = runtimeOk(src.default_runtime) ? src.default_runtime : VM_CONFIG_DEFAULTS.default_runtime
  const mac_oui = macOuiOk(src.mac_oui) ? String(src.mac_oui).trim().toLowerCase() : VM_CONFIG_DEFAULTS.mac_oui
  const allow_tcg = typeof src.allow_tcg === 'boolean' ? src.allow_tcg : VM_CONFIG_DEFAULTS.allow_tcg
  const smbiosSrc = isPlainObject(src.smbios) ? src.smbios : {}
  const smbios = {}
  for (const key of SMBIOS_KEYS) {
    const value = smbiosSrc[key]
    smbios[key] = smbiosOk(value) && value.length ? value : VM_CONFIG_DEFAULTS.smbios[key]
  }
  return { default_runtime, memory, vcpus, disk_gb, cpu_model, smbios, mac_oui, allow_tcg }
}

export function validateVmConfigPatch(patch) {
  if (patch == null) return { ok: true }
  if (!isPlainObject(patch)) return invalidField('vm', '必须是对象')
  if (Object.prototype.hasOwnProperty.call(patch, 'memory') && !memoryOk(patch.memory)) {
    return invalidField('memory', `必须是 ${VM_MEMORY_OPTIONS.join('、')}`)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'vcpus') && !isIntInRange(patch.vcpus, 1, 16)) {
    return invalidField('vcpus', '必须是 1 到 16 的整数')
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'disk_gb') && !isIntInRange(patch.disk_gb, 10, 200)) {
    return invalidField('disk_gb', '必须是 10 到 200 的整数')
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'cpu_model') && !cpuModelOk(patch.cpu_model)) {
    return invalidField('cpu_model', `必须是 ${VM_CPU_MODELS.join('、')}`)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'mac_oui') && !macOuiOk(patch.mac_oui)) {
    return invalidField('mac_oui', '必须是 xx:xx:xx 十六进制且组播位为 0')
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'default_runtime') && !runtimeOk(patch.default_runtime)) {
    return invalidField('default_runtime', '必须是 docker 或 kvm')
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'allow_tcg') && typeof patch.allow_tcg !== 'boolean') {
    return invalidField('allow_tcg', '必须是布尔值')
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'smbios')) {
    if (!isPlainObject(patch.smbios)) return invalidField('smbios', '必须是对象')
    for (const key of SMBIOS_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(patch.smbios, key)) continue
      if (!smbiosOk(patch.smbios[key])) {
        return invalidField(`smbios.${key}`, '不能超过 64 个可打印字符，且不能包含逗号')
      }
    }
  }
  return { ok: true }
}

function invalidMachine(message) {
  const err = new Error(message)
  err.status = 400
  err.code = 'invalid_machine'
  return err
}

function randomMac(oui) {
  const bytes = crypto.randomBytes(3)
  const tail = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(':')
  return `${oui}:${tail}`
}

function randomSerial() {
  const n = 7 + crypto.randomInt(4)
  let out = ''
  for (let i = 0; i < n; i += 1) out += SERIAL_ALPHABET[crypto.randomInt(SERIAL_ALPHABET.length)]
  return out
}

function randomDiskSerial() {
  return `KIN${crypto.randomBytes(8).toString('hex')}`.slice(0, 20)
}

export function resolveMachineSpec({ config, overrides, runtime } = {}) {
  void runtime
  const base = normalizeVmConfig(config)
  if (overrides != null && !isPlainObject(overrides)) {
    throw invalidMachine('machine 必须是对象')
  }
  if (isPlainObject(overrides)) {
    const patch = {}
    for (const key of OVERRIDE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) patch[key] = overrides[key]
    }
    const checked = validateVmConfigPatch(patch)
    if (!checked.ok) throw invalidMachine(checked.error)
    if (Object.prototype.hasOwnProperty.call(patch, 'memory')) base.memory = String(patch.memory).trim().toLowerCase()
    if (Object.prototype.hasOwnProperty.call(patch, 'vcpus')) base.vcpus = patch.vcpus
    if (Object.prototype.hasOwnProperty.call(patch, 'disk_gb')) base.disk_gb = patch.disk_gb
  }
  return {
    memory: base.memory,
    vcpus: base.vcpus,
    disk_gb: base.disk_gb,
    cpu_model: base.cpu_model,
    mac: randomMac(base.mac_oui),
    smbios: {
      manufacturer: base.smbios.manufacturer,
      product: base.smbios.product,
      version: base.smbios.version,
      family: base.smbios.family,
      serial: randomSerial(),
      uuid: crypto.randomUUID(),
    },
    disk_serial: randomDiskSerial(),
  }
}

export function slotMemory(vm, routing) {
  const fromVm = vm?.machine?.memory
  if (memoryOk(fromVm)) return String(fromVm).trim().toLowerCase()
  return normalizeVmConfig(routing?.vm).memory
}

export function memoryMiB(str) {
  const raw = String(str || '').trim()
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(raw)
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n) || n < 0) return 0
  const mult = { '': 1 / 1024, k: 1 / 1024, m: 1, g: 1024 }[m[2].toLowerCase()]
  return Math.round(n * mult)
}
