import '../fixtures/kin-computer-test-env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildRecreatedVmRecord,
  preflightFreshClaudeKernels,
  recreateVmFiles,
  seedFreshCliHome,
} from '../../src/lib/vm/vm-recreate.mjs'
import { destroyVmRuntime } from '../../src/lib/vm/vm-runtime.mjs'
import { verifyCragV2Tree } from '../../src/lib/vm/wrap-cli-runtime.mjs'
import { seedEncryptedPackage } from '../fixtures/crag-license.mjs'

test('fresh KVM home requires CRAG preinstallation and keeps the free kernel selected', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fresh-kvm-crag-'))
  const keys = ['KIN_WRAP_CLI_ROOT', 'KIN_CRAG_V2_ROOT', 'KIN_KERNEL_BIN']
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const template = path.join(root, 'share/wrap-cli')
  fs.mkdirSync(template, { recursive: true })
  for (const name of ['kin-kernel.bin', 'cli-node']) fs.writeFileSync(path.join(template, name), 'fixture')
  const vm = { id: 'vm-12', runtime_type: 'kvm', dataplane: 'wrap' }
  assert.throws(() => seedFreshCliHome(root, vm), { code: 'crag_v2_package_missing' })
  seedEncryptedPackage(root)
  const home = seedFreshCliHome(root, vm).homeDir
  assert.equal(verifyCragV2Tree(path.join(home, '.kin/crag-v2')).ok, true)
  assert.doesNotMatch(fs.readFileSync(path.join(home, '.kin/kin-kernel'), 'utf8'), /crag-v2/)
})

test('fresh Docker home stages encrypted CRAG without selecting it or requiring a license', (t) => {
  if (process.arch !== 'x64') return t.skip('requires an amd64 CRAG fixture')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fresh-dual-kernels-'))
  const keys = ['KIN_WRAP_CLI_ROOT', 'KIN_CRAG_V2_ROOT', 'KIN_KERNEL_BIN']
  const saved = keys.map((key) => [key, process.env[key]])
  for (const key of keys) delete process.env[key]
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const vm = { id: 'vm-13', dataplane: 'crag', crag_kernel_version: 'v2' }
  assert.throws(() => preflightFreshClaudeKernels(root, vm), { code: 'kernel_package_missing' })
  const template = path.join(root, 'share/wrap-cli')
  fs.mkdirSync(template, { recursive: true })
  for (const name of ['kin-kernel.bin', 'cli-node']) fs.writeFileSync(path.join(template, name), name)
  assert.throws(() => preflightFreshClaudeKernels(root, vm), { code: 'crag_v2_package_missing' })
  const pkg = seedEncryptedPackage(root)
  preflightFreshClaudeKernels(root, vm)
  assert.equal(fs.existsSync(path.join(root, 'vms')), false)

  const home = seedFreshCliHome(root, vm, { preinstallBoth: true }).homeDir
  assert.equal(verifyCragV2Tree(path.join(home, '.kin/crag-v2')).ok, true)
  assert.equal(fs.readFileSync(path.join(home, '.kin/cli-node'), 'utf8'), 'cli-node')
  assert.equal(fs.readFileSync(path.join(home, '.kin/kin-kernel.bin'), 'utf8'), 'kin-kernel.bin')
  assert.doesNotMatch(fs.readFileSync(path.join(home, '.kin/kin-kernel'), 'utf8'), /crag-v2/)
  fs.appendFileSync(path.join(pkg, 'crag-v2.payload.enc'), 'corrupt')
  assert.throws(() => preflightFreshClaudeKernels(root, vm), { code: 'crag_v2_hash_mismatch' })
})

test('recreated record keeps slot identity and drops credentials', () => {
  const prev = {
    id: 'vm-07',
    name: '07',
    kernel: 'debian-12',
    timezone: 'America/Chicago',
    timezone_source: 'manual',
    locale: 'en_US.UTF-8',
    note: 'keep me',
    proxy: { id: 'px-7', url: 'socks5h://127.0.0.1:1080' },
    policy: {
      maxConcurrency: 12,
      weight: 3,
      priority: 9,
      inflight: 4,
      allowed_models: ['claude-sonnet-5'],
      active_hours: { start: '20:00', end: '08:00', timezone: 'America/Chicago', days: [1, 2, 3, 4, 5] },
    },
    claude: { email: 'old@kin.test', has_access: true },
    fingerprint: { device_id: 'old-dev', session_id: 'old-sess' },
    stats: { calls: 9 },
    created_at: '2026-01-01T00:00:00.000Z',
    seed_policy: { telemetry_disabled: false, theme: 'light' },
    proxy_cli_enabled: true,
    utilization_5h: 0.9,
    account_tier: 'max',
    inference_engine: 'rust',
    dataplane: 'wrap',
    persona_preset: 'zero',
  }
  const next = buildRecreatedVmRecord(prev)
  assert.equal(next.id, 'vm-07')
  assert.equal(next.name, '07')
  assert.equal(next.kernel, 'debian-12')
  assert.equal(next.timezone, 'America/Chicago')
  assert.equal(next.timezone_source, 'manual')
  assert.deepEqual(next.proxy, prev.proxy)
  assert.equal(next.policy.maxConcurrency, 12)
  assert.equal(next.policy.weight, 3)
  assert.equal(next.policy.priority, 9)
  assert.equal(next.policy.inflight, 0)
  assert.deepEqual(next.policy.allowed_models, ['claude-sonnet-5'])
  assert.deepEqual(next.policy.active_hours, prev.policy.active_hours)
  assert.deepEqual(next.claude, {})
  assert.equal(next.platform, 'anthropic')
  assert.equal(next.family, 'claude')
  assert.deepEqual(next.stats, {})
  assert.equal(next.created_at, prev.created_at)
  assert.equal(next.schedulable, false)
  assert.equal(next.schedule_disabled_reason, 'no_credential')
  assert.notEqual(next.fingerprint.device_id, 'old-dev')
  assert.match(next.fingerprint.device_id, /^[0-9a-f]{64}$/)
  assert.match(next.fingerprint.hostname, /^debian-[0-9a-f]{4}$/)
  assert.match(next.fingerprint.guest_machine_id, /^[0-9a-f]{32}$/)
  assert.equal(next.utilization_5h, undefined)
  assert.equal(next.account_tier, undefined)
  assert.equal(next.seed_policy.telemetry_disabled, false)
  assert.equal(next.inference_engine, 'rust')
  assert.equal(next.dataplane, 'wrap')
  assert.equal(next.persona_preset, 'zero')
  assert.equal(next.proxy_cli_enabled, true)
})

test('recreated record keeps tenant owner and origin', () => {
  const prev = { id: 'vm-09', kernel: 'debian-12', owner_user_id: 'u1', origin: 'user_created', claude: {} }
  const next = buildRecreatedVmRecord(prev)
  assert.equal(next.owner_user_id, 'u1')
  assert.equal(next.origin, 'user_created')
  const platform = buildRecreatedVmRecord({ id: 'vm-10', kernel: 'debian-12', claude: {} })
  assert.equal(platform.owner_user_id, undefined)
  assert.equal(platform.origin, undefined)
})

test('recreated record enables proxy_cli when an exit is still bound', () => {
  const next = buildRecreatedVmRecord({
    id: 'vm-08',
    proxy: { id: 'px-8', url: 'socks5h://127.0.0.1:1080', host: '127.0.0.1', port: 1080 },
    proxy_cli_enabled: false,
  })
  assert.equal(next.proxy_cli_enabled, true)
})

test('recreated records preserve and normalize non-US timezones', () => {
  for (const timezone of ['Asia/Tokyo', ' asia/tokyo ']) {
    const next = buildRecreatedVmRecord({ id: 'vm-07', timezone })
    assert.equal(next.timezone, 'Asia/Tokyo')
    assert.equal(next.fingerprint.timezone, 'Asia/Tokyo')
  }
})

test('recreated records leave a missing or invalid timezone unset', () => {
  for (const timezone of [undefined, 'Invalid/Zone', 'America/Not_A_Zone', '+09:00']) {
    const next = buildRecreatedVmRecord({ id: 'vm-07', timezone })
    assert.equal(next.timezone, null)
    assert.equal(next.fingerprint.timezone, null)
  }
})

test('recreateVmFiles wipes home leftover and reseeds settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-recreate-'))
  const id = 'vm-03'
  const home = path.join(root, 'vms', id, 'cli-home', '.claude')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'credentials.json'), '{"claudeAiOauth":{}}')
  fs.writeFileSync(path.join(root, 'vms', `${id}-chat.json`), '{"x":1}')
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      name: '03',
      kernel: 'ubuntu-24.04',
      timezone: 'Asia/Tokyo',
      locale: 'en_US.UTF-8',
      proxy: { id: 'px-3', url: 'socks5h://127.0.0.1:1080' },
      policy: { maxConcurrency: 8, weight: 1 },
      claude: { email: 'wipe@kin.test' },
      seed_policy: { telemetry_disabled: true },
      created_at: '2026-02-01T00:00:00.000Z',
    }),
  )
  const { vm } = recreateVmFiles(root, JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8')))
  assert.equal(vm.id, id)
  assert.equal(vm.claude.email, undefined)
  assert.equal(fs.existsSync(path.join(home, 'credentials.json')), false)
  assert.equal(fs.existsSync(path.join(root, 'vms', `${id}-chat.json`)), false)
  const settings = JSON.parse(
    fs.readFileSync(path.join(root, 'vms', id, 'cli-home', '.claude', 'settings.json'), 'utf8'),
  )
  assert.equal(settings.env.DISABLE_TELEMETRY, '1')
  assert.equal(settings.env.TZ, 'Asia/Tokyo')
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8'))
  assert.equal(saved.proxy.id, 'px-3')
  assert.equal(saved.timezone, 'Asia/Tokyo')
  assert.equal(saved.fingerprint.timezone, 'Asia/Tokyo')
  assert.match(saved.fingerprint.device_id, /^[0-9a-f]{64}$/)
  assert.equal(
    fs.readFileSync(path.join(root, 'vms', id, 'machine-id'), 'utf8').trim(),
    saved.fingerprint.guest_machine_id,
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('keep rebuild retains the account, fingerprint and credential file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-recreate-keep-'))
  const id = 'vm-11'
  const cred = path.join(root, 'vms', id, 'cli-home', '.claude', 'credentials.json')
  const computer = path.join(root, 'vms', id, 'kvm', 'fingerprint', 'identity.json')
  fs.mkdirSync(path.dirname(cred), { recursive: true })
  fs.mkdirSync(path.dirname(computer), { recursive: true })
  fs.writeFileSync(cred, '{"claudeAiOauth":{"accessToken":"keep"}}')
  fs.writeFileSync(computer, '{"hostname":"kept-host"}')
  fs.writeFileSync(path.join(root, 'vms', id, 'cli-home', '.claude', 'projects'), 'session')
  const nativeFiles = {
    'cli-home/.claude.json': '{"userID":"native-user","machineID":"legacy-machine"}',
    'cli-home/.claude/.claude.json': '{"userID":"nested-user"}',
    'cli-home/.claude/kin-identity.json': '{"device_id":"kept-native"}',
    'cli-home/.claude/settings.local.json': '{"permissions":{"allow":["Read"]}}',
    'cli-home/.claude/telemetry/queue.json': '{"events":[{"id":"retained"}]}',
    'cli-home/.claude/telemetry/egress.json': '{"epoch":"existing-egress","checked_at":123}',
  }
  for (const [rel, content] of Object.entries(nativeFiles)) {
    const file = path.join(root, 'vms', id, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  fs.writeFileSync(
    path.join(root, 'vms', id, 'cli-home', '.claude', 'settings.json'),
    '{"customSetting":"keep","theme":"dark"}',
  )
  const prev = {
    id,
    name: '11',
    kernel: 'ubuntu-24.04',
    node_id: 'node-a',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    claude: { email: 'keep@kin.test', has_access: true, access_token: 'secret' },
    fingerprint: { hostname: 'kept-host', device_id: 'a'.repeat(64), guest_machine_id: 'b'.repeat(32) },
    stats: { calls: 4 },
    schedulable: true,
    created_at: '2026-03-01T00:00:00.000Z',
    seed_policy: { telemetry_disabled: true, claude_setting: 'KEEP=yes', theme: 'dark' },
  }
  const { vm, mode } = recreateVmFiles(root, prev, { mode: 'keep' })
  assert.equal(mode, 'keep')
  assert.equal(vm.claude.email, 'keep@kin.test')
  assert.equal(vm.claude.has_access, true)
  assert.equal(vm.claude.access_token, undefined)
  assert.equal(vm.fingerprint.hostname, 'kept-host')
  assert.equal(vm.fingerprint.device_id, 'a'.repeat(64))
  assert.equal(vm.stats.calls, 4)
  assert.equal(vm.node_id, 'node-a')
  assert.equal(vm.dataplane, 'crag')
  assert.equal(vm.crag_kernel_version, 'v2')
  assert.equal(vm.schedulable, true)
  assert.equal(fs.readFileSync(cred, 'utf8'), '{"claudeAiOauth":{"accessToken":"keep"}}')
  assert.equal(fs.readFileSync(computer, 'utf8'), '{"hostname":"kept-host"}')
  assert.equal(fs.existsSync(path.join(root, 'vms', id, 'cli-home', '.claude', 'projects')), false)
  assert.equal(vm.seed_policy.telemetry_disabled, true)
  for (const [rel, content] of Object.entries(nativeFiles)) {
    assert.equal(fs.readFileSync(path.join(root, 'vms', id, rel), 'utf8'), content, rel)
  }
  const settings = JSON.parse(
    fs.readFileSync(path.join(root, 'vms', id, 'cli-home', '.claude', 'settings.json'), 'utf8'),
  )
  assert.equal(settings.customSetting, 'keep')
  assert.equal(settings.env.DISABLE_TELEMETRY, '1')
  assert.equal(
    fs.readFileSync(path.join(root, 'vms', id, 'cli-home', '.claude', 'claude.setting'), 'utf8'),
    'KEEP=yes\n',
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('keep rebuild strips legacy email from the kept credential file while keeping panel email', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-recreate-strip-email-'))
  const id = 'vm-12'
  const cred = path.join(root, 'vms', id, 'cli-home', '.claude', 'credentials.json')
  fs.mkdirSync(path.dirname(cred), { recursive: true })
  fs.writeFileSync(
    cred,
    JSON.stringify({
      claudeAiOauth: { accessToken: 'keep', refreshToken: 'keep-rt', email: 'legacy@kin.test' },
    }),
  )
  const prev = {
    id,
    name: '12',
    kernel: 'ubuntu-24.04',
    claude: { email: 'keep@kin.test', has_access: true },
    fingerprint: { hostname: 'kept-host', device_id: 'a'.repeat(64), guest_machine_id: 'b'.repeat(32) },
  }
  const { vm } = recreateVmFiles(root, prev, { mode: 'keep' })
  assert.equal(vm.claude.email, 'keep@kin.test')
  const storedText = fs.readFileSync(cred, 'utf8')
  assert.doesNotMatch(storedText, /legacy@kin\.test|"email"/)
  assert.equal(JSON.parse(storedText).claudeAiOauth.accessToken, 'keep')
  fs.rmSync(root, { recursive: true, force: true })
})

test('destroy missing container is a no-op', () => {
  const r = destroyVmRuntime({ id: 'vm-missing-slot' })
  assert.equal(r.ok, true)
  assert.equal(r.action, 'absent')
})

test('KVM reset keeps machine sizing and always leaves a bootable identity (#1089)', () => {
  const machine = {
    memory: '4g',
    vcpus: 4,
    disk_gb: 40,
    cpu_model: 'host',
    mac: '52:54:00:aa:bb:cc',
    disk_serial: 'KINoldserial0001',
    smbios: {
      manufacturer: 'Dell Inc.',
      product: 'OptiPlex 7090',
      version: '1.0',
      family: 'OptiPlex',
      serial: 'OLD1',
      uuid: 'u',
    },
  }
  const prev = { id: 'vm-31', name: '31', kernel: 'ubuntu-24.04', runtime: { type: 'kvm' }, machine, fingerprint: {} }

  const traits = buildRecreatedVmRecord(prev).machine
  assert.equal(traits.memory, '4g')
  assert.equal(traits.vcpus, 4)
  assert.equal(traits.disk_gb, 40)
  assert.match(traits.mac, /^52:54:00(:[0-9a-f]{2}){3}$/)
  assert.notEqual(traits.mac, machine.mac)
  assert.match(traits.disk_serial, /^KIN[0-9a-f]+$/)
  assert.notEqual(traits.disk_serial, machine.disk_serial)
  assert.ok(traits.smbios.manufacturer && traits.smbios.serial && traits.smbios.uuid)

  assert.deepEqual(buildRecreatedVmRecord(prev, null, { mode: 'keep' }).machine, machine)

  const legacy = buildRecreatedVmRecord({ ...prev, machine: undefined }, null, { mode: 'keep' }).machine
  assert.match(legacy.mac, /^52:54:00(:[0-9a-f]{2}){3}$/)
  assert.ok(legacy.disk_serial)

  assert.equal(buildRecreatedVmRecord({ id: 'vm-32', name: '32', runtime: { type: 'docker' } }).machine, undefined)
})

test('bare ARM64 host with amd64 CRAG preflights unstaged slots and recreates slots while preserving runtime.arch', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-arm64-unstaged-recreate-'))
  const keys = ['KIN_WRAP_CLI_ROOT', 'KIN_CRAG_V2_ROOT', 'KIN_KERNEL_BIN']
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  const bareArm64 = { arch: 'arm64', platform: 'linux', dockerDefaultPlatform: '' }
  const template = path.join(root, 'share/wrap-cli')
  fs.mkdirSync(template, { recursive: true })
  for (const name of ['kin-kernel.bin', 'cli-node']) fs.writeFileSync(path.join(template, name), name)

  const freshWrapVm = { id: 'vm-21', dataplane: 'wrap', runtime: { type: 'docker' } }
  assert.throws(() => preflightFreshClaudeKernels(root, freshWrapVm, bareArm64), { code: 'crag_v2_package_missing' })

  seedEncryptedPackage(root, { arch: 'amd64' })
  preflightFreshClaudeKernels(root, freshWrapVm, bareArm64)
  assert.equal(fs.existsSync(path.join(root, 'vms', freshWrapVm.id)), false)

  const seeded = seedFreshCliHome(root, freshWrapVm, { preinstallBoth: true, ...bareArm64 })
  assert.equal(verifyCragV2Tree(path.join(seeded.homeDir, '.kin/crag-v2'), { arch: 'amd64' }).ok, true)
  assert.doesNotMatch(fs.readFileSync(path.join(seeded.homeDir, '.kin/kin-kernel'), 'utf8'), /crag-v2/)

  const prevCrag = {
    id: 'vm-22',
    name: '22',
    kernel: 'ubuntu-24.04',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    runtime: { type: 'docker', arch: 'amd64' },
  }
  fs.mkdirSync(path.join(root, 'vms', prevCrag.id, 'cli-home', '.kin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${prevCrag.id}.json`), JSON.stringify(prevCrag))
  const recreated = recreateVmFiles(root, prevCrag, { mode: 'traits', ...bareArm64 })
  assert.equal(recreated.vm.runtime.arch, 'amd64')
  assert.equal(
    verifyCragV2Tree(path.join(root, 'vms', prevCrag.id, 'cli-home/.kin/crag-v2'), { arch: 'amd64' }).ok,
    true,
  )

  const prevImplicitCrag = {
    id: 'vm-23',
    name: '23',
    kernel: 'ubuntu-24.04',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    runtime: { type: 'docker' },
  }
  fs.mkdirSync(path.join(root, 'vms', prevImplicitCrag.id, 'cli-home', '.kin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${prevImplicitCrag.id}.json`), JSON.stringify(prevImplicitCrag))
  const recreatedImplicit = recreateVmFiles(root, prevImplicitCrag, { mode: 'traits', ...bareArm64 })
  assert.equal(recreatedImplicit.vm.runtime.arch, undefined)
  assert.equal(
    verifyCragV2Tree(path.join(root, 'vms', prevImplicitCrag.id, 'cli-home/.kin/crag-v2'), { arch: 'amd64' }).ok,
    true,
  )

  const prevArmNative = {
    id: 'vm-24',
    name: '24',
    kernel: 'ubuntu-24.04',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    runtime: { type: 'docker', arch: 'arm64' },
  }
  assert.equal(buildRecreatedVmRecord(prevArmNative).runtime.arch, 'arm64')
  assert.throws(() => recreateVmFiles(root, prevArmNative, { mode: 'traits', ...bareArm64 }), {
    code: 'crag_v2_arch_mismatch',
  })
})
