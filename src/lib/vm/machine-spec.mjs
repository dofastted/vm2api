/**
 * Global `routing.vm` defaults and the per-slot `vm.machine` record.
 * Docker slots consume memory and an optional explicit CPU quota; KVM uses its own spec. Invalid values
 * never persist through normalize (defaults) or a PUT/create patch (400).
 */
import crypto from 'node:crypto'

export const VM_MEMORY_OPTIONS = Object.freeze(['256m', '512m', '1g', '1536m', '2g', '4g', '8g', '16g'])
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

/** Desktop OEM identities. No commas: QEMU `-smbios` splits on them. */
export const SMBIOS_CATALOG = Object.freeze([
  Object.freeze({ manufacturer: 'Dell Inc.', product: 'OptiPlex 7090', version: '1.0', family: 'OptiPlex' }),
  Object.freeze({ manufacturer: 'Dell Inc.', product: 'Latitude 5440', version: '1.0', family: 'Latitude' }),
  Object.freeze({ manufacturer: 'Dell Inc.', product: 'XPS 15 9530', version: '1.0', family: 'XPS' }),
  Object.freeze({
    manufacturer: 'LENOVO',
    product: 'ThinkPad T14 Gen 3',
    version: 'ThinkPad T14 Gen 3',
    family: 'ThinkPad T14 Gen 3',
  }),
  Object.freeze({
    manufacturer: 'LENOVO',
    product: 'ThinkPad X1 Carbon Gen 11',
    version: 'ThinkPad X1 Carbon Gen 11',
    family: 'ThinkPad X1 Carbon Gen 11',
  }),
  Object.freeze({
    manufacturer: 'HP',
    product: 'HP EliteBook 840 G8',
    version: '1.0',
    family: '103C_5336AN HP EliteBook',
  }),
  Object.freeze({ manufacturer: 'HP', product: 'HP ProBook 450 G9', version: '1.0', family: '103C_5336AN HP ProBook' }),
  Object.freeze({
    manufacturer: 'ASUSTeK COMPUTER INC.',
    product: 'ExpertBook B1502CBA',
    version: '1.0',
    family: 'ExpertBook',
  }),
  Object.freeze({ manufacturer: 'Acer', product: 'TravelMate P215-54', version: 'V1.0', family: 'TravelMate' }),
  Object.freeze({ manufacturer: 'Framework', product: 'Laptop 13', version: '1.0', family: 'Laptop' }),
  Object.freeze({
    manufacturer: 'Micro-Star International Co. Ltd.',
    product: 'Modern 15 A11MU',
    version: '1.0',
    family: 'Modern',
  }),
  Object.freeze({ manufacturer: 'GIGABYTE', product: 'AERO 16 YE5', version: '1.0', family: 'AERO' }),
  Object.freeze({ manufacturer: 'Dell Inc.', product: 'Precision 3560', version: '1.0', family: 'Precision' }),
  Object.freeze({ manufacturer: 'Dell Inc.', product: 'Inspiron 15 3520', version: '1.0', family: 'Inspiron' }),
  Object.freeze({
    manufacturer: 'LENOVO',
    product: 'ThinkCentre M70q Gen 3',
    version: 'ThinkCentre M70q Gen 3',
    family: 'ThinkCentre M70q',
  }),
  Object.freeze({
    manufacturer: 'HP',
    product: 'HP EliteDesk 800 G6',
    version: '1.0',
    family: '103C_53307F HP EliteDesk',
  }),
  Object.freeze({
    manufacturer: 'ASUSTeK COMPUTER INC.',
    product: 'VivoBook 15 X1502ZA',
    version: '1.0',
    family: 'VivoBook',
  }),
  Object.freeze({ manufacturer: 'Acer', product: 'Veriton N4670G', version: 'V1.0', family: 'Veriton' }),
])

function copySmbios(row) {
  return {
    manufacturer: row.manufacturer,
    product: row.product,
    version: row.version,
    family: row.family,
  }
}

/** One catalog portrait. Create writes this onto the slot; later reads use the stored row. */
export function randomSmbios() {
  return copySmbios(SMBIOS_CATALOG[crypto.randomInt(SMBIOS_CATALOG.length)])
}

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

/** Explicit per-slot Docker quota. Missing/zero preserves the historic unlimited CPU policy. */
export function slotDockerCpus(vm) {
  const machine = vm?.machine
  if (!machine || !Object.hasOwn(machine, 'docker_cpus')) return 0
  const value = machine.docker_cpus
  if (typeof value !== 'number' || !Number.isFinite(value) || (value !== 0 && (value < 0.01 || value > 16))) {
    throw invalidMachine('docker_cpus must be 0 (unlimited) or a number from 0.01 to 16')
  }
  return value
}

export function resolveMachineSpec({ config, overrides, runtime } = {}) {
  const base = normalizeVmConfig(config)
  if (overrides != null && !isPlainObject(overrides)) {
    throw invalidMachine('machine 必须是对象')
  }
  if (isPlainObject(overrides)) {
    if (Object.hasOwn(overrides, 'docker_cpus')) {
      if (runtime === 'kvm') throw invalidMachine('docker_cpus is only supported for Docker slots; use vcpus for KVM')
      base.docker_cpus = slotDockerCpus({ machine: overrides })
    }
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
  const brand = randomSmbios()
  return {
    memory: base.memory,
    ...(Object.hasOwn(base, 'docker_cpus') ? { docker_cpus: base.docker_cpus } : {}),
    vcpus: base.vcpus,
    disk_gb: base.disk_gb,
    cpu_model: base.cpu_model,
    mac: randomMac(base.mac_oui),
    smbios: {
      manufacturer: brand.manufacturer,
      product: brand.product,
      version: brand.version,
      family: brand.family,
      serial: randomSerial(),
      uuid: crypto.randomUUID(),
    },
    disk_serial: randomDiskSerial(),
  }
}

/**
 * Factory reset keeps the slot's sizing but draws a new hardware identity
 * (MAC, SMBIOS, disk serial). The MAC keeps the old OUI when it had a valid one.
 */
export function regenerateMachineIdentity(machine) {
  const base = isPlainObject(machine) ? { ...machine } : {}
  const oldOui = /^([0-9a-f]{2}:){2}[0-9a-f]{2}/i.exec(String(base.mac || ''))?.[0]?.toLowerCase()
  const oui = macOuiOk(oldOui) ? oldOui : VM_CONFIG_DEFAULTS.mac_oui
  const brand = randomSmbios()
  return {
    ...base,
    mac: randomMac(oui),
    smbios: { ...brand, serial: randomSerial(), uuid: crypto.randomUUID() },
    disk_serial: randomDiskSerial(),
  }
}

/** Fill a missing per-slot SMBIOS. An existing manufacturer/product/family stays put. */
export function ensureSlotSmbios(vm) {
  if (!vm?.id) return false
  const machine = isPlainObject(vm.machine) ? vm.machine : {}
  const current = isPlainObject(machine.smbios) ? machine.smbios : {}
  if (current.manufacturer && current.product && current.family) return false
  const brand = randomSmbios()
  vm.machine = {
    ...machine,
    smbios: {
      manufacturer: brand.manufacturer,
      product: brand.product,
      version: brand.version,
      family: brand.family,
      serial: current.serial || randomSerial(),
      uuid: current.uuid || crypto.randomUUID(),
    },
  }
  return true
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
