import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VM_CONFIG_DEFAULTS,
  VM_CPU_MODELS,
  VM_MEMORY_OPTIONS,
  memoryMiB,
  normalizeVmConfig,
  resolveMachineSpec,
  slotMemory,
  validateVmConfigPatch,
} from '../../src/lib/vm/machine-spec.mjs'

test('normalizeVmConfig fills defaults and replaces invalid fields', () => {
  assert.deepEqual(normalizeVmConfig(null).smbios, VM_CONFIG_DEFAULTS.smbios)
  const out = normalizeVmConfig({
    memory: '3g',
    vcpus: 99,
    disk_gb: 1,
    cpu_model: 'nope',
    default_runtime: 'qemu',
    mac_oui: '01:00:00',
    allow_tcg: 'yes',
    smbios: { manufacturer: 'Bad,Inc', product: '' },
  })
  assert.equal(out.memory, '512m')
  assert.equal(out.vcpus, 2)
  assert.equal(out.disk_gb, 20)
  assert.equal(out.cpu_model, 'host')
  assert.equal(out.default_runtime, 'docker')
  assert.equal(out.mac_oui, '52:54:00')
  assert.equal(out.allow_tcg, false)
  assert.equal(out.smbios.manufacturer, 'Dell Inc.')
  assert.equal(out.smbios.product, 'OptiPlex 7090')
})

test('validateVmConfigPatch names the field on every boundary', () => {
  assert.equal(validateVmConfigPatch(null).ok, true)
  assert.equal(validateVmConfigPatch({}).ok, true)
  assert.equal(validateVmConfigPatch({ memory: '1g', vcpus: 1, disk_gb: 10 }).ok, true)
  assert.equal(validateVmConfigPatch({ vcpus: 16, disk_gb: 200, memory: '16g' }).ok, true)

  const memory = validateVmConfigPatch({ memory: '3g' })
  assert.equal(memory.ok, false)
  assert.match(memory.error, /memory/)
  assert.match(memory.error, new RegExp(VM_MEMORY_OPTIONS[0]))

  const vcpusLo = validateVmConfigPatch({ vcpus: 0 })
  assert.equal(vcpusLo.ok, false)
  assert.match(vcpusLo.error, /vcpus/)
  const vcpusHi = validateVmConfigPatch({ vcpus: 17 })
  assert.equal(vcpusHi.ok, false)
  assert.match(vcpusHi.error, /vcpus/)
  const vcpusFrac = validateVmConfigPatch({ vcpus: 1.5 })
  assert.equal(vcpusFrac.ok, false)

  const diskLo = validateVmConfigPatch({ disk_gb: 9 })
  assert.equal(diskLo.ok, false)
  assert.match(diskLo.error, /disk_gb/)
  const diskHi = validateVmConfigPatch({ disk_gb: 201 })
  assert.equal(diskHi.ok, false)

  const cpu = validateVmConfigPatch({ cpu_model: 'Haswell' })
  assert.equal(cpu.ok, false)
  assert.match(cpu.error, /cpu_model/)
  assert.match(cpu.error, new RegExp(VM_CPU_MODELS[0]))

  const oui = validateVmConfigPatch({ mac_oui: '01:00:00' })
  assert.equal(oui.ok, false)
  assert.match(oui.error, /mac_oui/)

  const comma = validateVmConfigPatch({ smbios: { manufacturer: 'Dell, Inc.' } })
  assert.equal(comma.ok, false)
  assert.match(comma.error, /smbios\.manufacturer/)
  const long = validateVmConfigPatch({ smbios: { product: 'x'.repeat(65) } })
  assert.equal(long.ok, false)
  assert.match(long.error, /smbios\.product/)

  const runtime = validateVmConfigPatch({ default_runtime: 'qemu' })
  assert.equal(runtime.ok, false)
  assert.match(runtime.error, /default_runtime/)
  const tcg = validateVmConfigPatch({ allow_tcg: 'true' })
  assert.equal(tcg.ok, false)
  assert.match(tcg.error, /allow_tcg/)
})

test('mac_oui multicast bit is rejected; generated mac keeps it clear', () => {
  assert.equal(validateVmConfigPatch({ mac_oui: '52:54:00' }).ok, true)
  assert.equal(validateVmConfigPatch({ mac_oui: '00:00:00' }).ok, true)
  assert.equal(validateVmConfigPatch({ mac_oui: '53:54:00' }).ok, false)
  for (let i = 0; i < 40; i += 1) {
    const spec = resolveMachineSpec({ config: { mac_oui: '52:54:00' } })
    const first = Number.parseInt(spec.mac.slice(0, 2), 16)
    assert.equal(first & 1, 0, spec.mac)
    assert.match(spec.mac, /^52:54:00:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}$/)
  }
})

test('resolveMachineSpec override precedence and invalid_machine', () => {
  const spec = resolveMachineSpec({
    config: { memory: '2g', vcpus: 4, disk_gb: 40, cpu_model: 'qemu64' },
    overrides: { memory: '4g', vcpus: 8, disk_gb: 80, cpu_model: 'host' },
    runtime: 'kvm',
  })
  assert.equal(spec.memory, '4g')
  assert.equal(spec.vcpus, 8)
  assert.equal(spec.disk_gb, 80)
  assert.equal(spec.cpu_model, 'qemu64')
  assert.match(spec.smbios.serial, /^[A-Z0-9]{7,10}$/)
  assert.match(spec.smbios.uuid, /^[0-9a-f-]{36}$/)
  assert.ok(spec.disk_serial)

  const base = resolveMachineSpec({ config: { memory: '2g' } })
  assert.equal(base.memory, '2g')
  assert.equal(base.vcpus, 2)

  assert.throws(
    () => resolveMachineSpec({ overrides: { memory: '3g' } }),
    (err) => err.status === 400 && err.code === 'invalid_machine' && /memory/.test(err.message),
  )
  assert.throws(
    () => resolveMachineSpec({ overrides: '4g' }),
    (err) => err.status === 400 && err.code === 'invalid_machine',
  )
})

test('slotMemory prefers the slot then routing then 512m', () => {
  assert.equal(slotMemory({ machine: { memory: '4g' } }, { vm: { memory: '2g' } }), '4g')
  assert.equal(slotMemory({ machine: {} }, { vm: { memory: '2g' } }), '2g')
  assert.equal(slotMemory(null, { vm: { memory: '8g' } }), '8g')
  assert.equal(slotMemory(null, null), '512m')
  assert.equal(slotMemory({ machine: { memory: 'nope' } }, { vm: { memory: '2g' } }), '2g')
})

test('memoryMiB parses the documented size tokens', () => {
  assert.equal(memoryMiB('512m'), 512)
  assert.equal(memoryMiB('1g'), 1024)
  assert.equal(memoryMiB('2G'), 2048)
  assert.equal(memoryMiB(''), 0)
})
