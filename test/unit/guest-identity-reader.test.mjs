import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { READ_IDENTITY, parseGuestHardware, readGuestIdentity } from '../../src/lib/vm/guest-identity-reader.mjs'
import { collectSlotIdentity } from '../../src/lib/vm/guest-identity.mjs'

const guestOutput = [
  'guest-01',
  'ubuntu',
  'Ubuntu "24.04" LTS',
  '6.8.0',
  'aarch64',
  'guest-machine',
  'UTC',
  'en_US.UTF-8',
  '',
].join('\0')

test('collects Docker guest identity without either worker or kernel socket', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-reader-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  const vm = {
    id: 'vm-01',
    runtime: { type: 'docker', worker: 'rust' },
    fingerprint: { device_id: 'keep-device', session_id: 'keep-session' },
  }
  const vmPath = path.join(root, 'vms', 'vm-01.json')
  fs.writeFileSync(vmPath, JSON.stringify(vm))
  const result = await collectSlotIdentity(root, vm, {
    callGet: (exec, requestPath, options) =>
      readGuestIdentity(exec, requestPath, {
        ...options,
        run: async (command, args, opts) => {
          assert.equal(command, 'docker')
          assert.deepEqual(args.slice(0, 4), ['exec', 'kin-01', 'sh', '-c'])
          assert.equal(opts.timeout, 5000)
          return { stdout: guestOutput }
        },
      }),
  })
  assert.equal(result.ok, true)
  const saved = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(saved.fingerprint.os_pretty, 'Ubuntu "24.04" LTS')
  assert.equal(saved.fingerprint.stainless_arch, 'arm64')
  assert.equal(saved.fingerprint.guest_machine_id, 'guest-machine')
  assert.equal(saved.fingerprint.device_id, 'keep-device')
  assert.equal(saved.fingerprint.session_id, 'keep-session')
  assert.ok(saved.runtime.identity_collected_at)
})

test('falls back to uname -n when the guest has no hostname command', async () => {
  // A shell function shadows PATH, standing in for kin-os-arch which lacks `hostname`.
  const script = `hostname() { return 127; }\n${READ_IDENTITY}`
  const result = await readGuestIdentity({ vmId: 'vm-03', vm: { runtime: { type: 'docker' } } }, '', {
    run: (_command, args, opts) => {
      assert.equal(args.at(-1), READ_IDENTITY)
      return promisify(execFile)('sh', ['-c', script], opts)
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.body.identity.hostname, (await promisify(execFile)('uname', ['-n'])).stdout.trim())
})

test('collects kvm guest identity via kin-guest-exec', async () => {
  const result = await readGuestIdentity({ vmId: 'vm-01', vm: { id: 'vm-01', runtime: { type: 'kvm' } } }, '', {
    run: async (command, args) => {
      assert.equal(command, 'docker')
      assert.deepEqual(args.slice(0, 4), ['exec', 'kin-01', '/usr/local/bin/kin-guest-exec', '--'])
      assert.equal(args.at(-1), READ_IDENTITY)
      return { stdout: guestOutput }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.body.identity.runtime_kind, 'kvm')
  assert.equal(result.body.identity.hostname, 'guest-01')
})

test('kvm collect-identity waits longer for guest ssh', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-kvm-timeout-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  const vm = { id: 'vm-01', runtime: { type: 'kvm' }, fingerprint: {} }
  fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify(vm))
  let seen
  const result = await collectSlotIdentity(root, vm, {
    callGet: async (_exec, _path, options) => {
      seen = options.timeoutMs
      return {
        ok: true,
        status: 200,
        body: {
          identity: {
            schema_version: '1',
            runtime_kind: 'kvm',
            hostname: 'guest-01',
            os_id: 'ubuntu',
            os_pretty: 'Ubuntu 24.04 LTS',
            kernel_release: '6.8.0',
            arch: 'x86_64',
            machine_id: 'guest-machine',
            timezone: 'UTC',
            locale: 'en_US.UTF-8',
            goos: 'linux',
          },
        },
      }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(seen, 20_000)
  assert.equal(result.runtime_kind, 'kvm')
})

test('reports stopped containers, timeouts and incomplete output as failures', async () => {
  for (const [error, expected] of [
    [{ stderr: 'container is not running' }, 'guest_identity_exec_failed'],
    [{ killed: true, message: 'timeout' }, 'guest_identity_timeout'],
  ]) {
    const result = await readGuestIdentity({ vmId: 'vm-01' }, '', {
      run: async () => {
        throw error
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.body.error.code, expected)
  }
  const invalid = await readGuestIdentity({ vmId: 'vm-01' }, '', { run: async () => ({ stdout: 'partial' }) })
  assert.equal(invalid.body.error.code, 'guest_identity_invalid')
})

const hardwareJson = JSON.stringify({
  cpu_model: 'Intel(R) Xeon(R) CPU',
  cpu_cores: 4,
  memory_bytes: 4294967296,
  root_disk: '/dev/vda2',
  mac: '52:54:00:11:22:33',
  dmi: {
    manufacturer: 'Dell Inc.',
    product: 'OptiPlex 7090',
    version: '1.0',
    family: 'OptiPlex',
    serial: 'ABC123',
    uuid: '11111111-2222-3333-4444-555555555555',
  },
  shell: 'bash',
  package_managers: 'apt',
  runtimes: 'node,python',
})

const guestOutputWithHardware = [
  'guest-01',
  'ubuntu',
  'Ubuntu "24.04" LTS',
  '6.8.0',
  'aarch64',
  'guest-machine',
  'UTC',
  'en_US.UTF-8',
  hardwareJson,
  '',
].join('\0')

test('parses optional hardware JSON and ignores invalid extra field', () => {
  const hw = parseGuestHardware(hardwareJson)
  assert.equal(hw.cpu_model, 'Intel(R) Xeon(R) CPU')
  assert.equal(hw.cpu_cores, 4)
  assert.equal(hw.memory_bytes, 4294967296)
  assert.equal(hw.dmi.product, 'OptiPlex 7090')
  assert.equal(hw.package_managers, 'apt')
  assert.equal(parseGuestHardware(''), null)
  assert.equal(parseGuestHardware('{'), null)
})

test('collects guest hardware JSON without breaking required identity fields', async () => {
  const result = await readGuestIdentity({ vmId: 'vm-01', vm: { runtime: { type: 'docker' } } }, '', {
    run: async () => ({ stdout: guestOutputWithHardware }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.body.identity.hostname, 'guest-01')
  assert.equal(result.body.identity.hardware.cpu_model, 'Intel(R) Xeon(R) CPU')
  assert.equal(result.body.identity.hardware.cpu_cores, 4)
  assert.equal(result.body.identity.hardware.mac, '52:54:00:11:22:33')
  assert.equal(result.body.identity.hardware.dmi.manufacturer, 'Dell Inc.')
  assert.equal(result.body.identity.hardware.shell, 'bash')
  assert.ok(result.body.identity.hardware.observed_at)
})

test('invalid optional hardware JSON does not fail identity collection', async () => {
  const stdout = [
    'guest-01',
    'ubuntu',
    'Ubuntu 24.04',
    '6.8.0',
    'x86_64',
    'guest-machine',
    'UTC',
    'en_US.UTF-8',
    '{',
    '',
  ].join('\0')
  const result = await readGuestIdentity({ vmId: 'vm-01' }, '', { run: async () => ({ stdout }) })
  assert.equal(result.ok, true)
  assert.equal(result.body.identity.hostname, 'guest-01')
  assert.equal(result.body.identity.hardware, undefined)
})

test('READ_IDENTITY hardware probes survive missing optional commands', async () => {
  const script = `hostname() { return 127; }\nnproc() { return 127; }\n${READ_IDENTITY}`
  const result = await readGuestIdentity({ vmId: 'vm-04', vm: { runtime: { type: 'docker' } } }, '', {
    run: (_command, args, opts) => {
      assert.equal(args.at(-1), READ_IDENTITY)
      return promisify(execFile)('sh', ['-c', script], opts)
    },
  })
  assert.equal(result.ok, true)
  assert.ok(result.body.identity.hostname)
  assert.equal(typeof result.body.identity.hardware, 'object')
  assert.ok(result.body.identity.hardware.memory_bytes > 0)
  assert.ok(result.body.identity.hardware.cpu_cores > 0)
})

function slotComputerFixture(t, { cpuMax, memoryMax }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-slot-computer-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const hw = path.join(root, 'kin-hardware')
  const dmi = path.join(root, 'kin-dmi')
  const cg = path.join(root, 'cgroup')
  for (const dir of [hw, dmi, cg]) fs.mkdirSync(dir)
  const files = {
    [path.join(hw, 'cpu_brand')]: 'Persona CPU i5-1135G7',
    [path.join(hw, 'logical_cpus')]: '8',
    [path.join(hw, 'ram_bytes')]: '8589934592',
    [path.join(hw, 'mac')]: '02:aa:bb:cc:dd:ee',
    [path.join(dmi, 'sys_vendor')]: 'Dell Inc.',
    [path.join(dmi, 'product_name')]: 'Inspiron 5502',
    [path.join(dmi, 'product_family')]: 'Inspiron',
    [path.join(cg, 'cpu.max')]: cpuMax,
    [path.join(cg, 'memory.max')]: memoryMax,
  }
  for (const [file, body] of Object.entries(files)) fs.writeFileSync(file, `${body}\n`)
  return `KIN_HW_DIR='${hw}'\nKIN_DMI_DIR='${dmi}'\nKIN_CGROUP_DIR='${cg}'\n`
}

async function readWithPrefix(prefix) {
  return readGuestIdentity({ vmId: 'vm-05', vm: { runtime: { type: 'docker' } } }, '', {
    run: (_command, args, opts) => promisify(execFile)('sh', ['-c', `${prefix}${args.at(-1)}`], opts),
  })
}

test('Docker slot hardware comes from the slot computer and cgroup limits, not the host', async (t) => {
  const prefix = slotComputerFixture(t, { cpuMax: '150000 100000', memoryMax: '4294967296' })
  const result = await readWithPrefix(prefix)
  assert.equal(result.ok, true)
  const hw = result.body.identity.hardware
  assert.equal(hw.cpu_model, 'Persona CPU i5-1135G7')
  assert.equal(hw.cpu_cores, 2)
  assert.equal(hw.memory_bytes, 4294967296)
  assert.equal(hw.mac, '02:aa:bb:cc:dd:ee')
  assert.equal(hw.dmi.manufacturer, 'Dell Inc.')
  assert.equal(hw.dmi.product, 'Inspiron 5502')
  assert.equal(hw.dmi.family, 'Inspiron')
})

test('unlimited cgroup falls back to the slot computer cores and memory', async (t) => {
  const prefix = slotComputerFixture(t, { cpuMax: 'max 100000', memoryMax: 'max' })
  const result = await readWithPrefix(prefix)
  assert.equal(result.ok, true)
  const hw = result.body.identity.hardware
  assert.equal(hw.cpu_cores, 8)
  assert.equal(hw.memory_bytes, 8589934592)
})
