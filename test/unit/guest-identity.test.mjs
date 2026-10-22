import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mergeGuestFingerprint, mergeGuestHardware, collectSlotIdentity } from '../../src/lib/vm/guest-identity.mjs'

test('merge keeps device/session and maps arch', () => {
  const out = mergeGuestFingerprint(
    { device_id: 'dev-keep', session_id: 'sess-keep', stainless_package_version: '0.94.0' },
    {
      hostname: '01',
      os_id: 'ubuntu',
      os_pretty: 'Ubuntu 24.04',
      kernel_release: '6.8.0-host',
      arch: 'amd64',
      goos: 'linux',
      runtime_kind: 'docker',
      worker_version: '2026.08.23-identity',
      collected_at: '2026-08-23T00:00:00Z',
    },
  )
  assert.equal(out.device_id, 'dev-keep')
  assert.equal(out.session_id, 'sess-keep')
  assert.equal(out.source, 'guest')
  assert.equal(out.stainless_os, 'Linux')
  assert.equal(out.stainless_arch, 'x64')
  assert.equal(out.hostname, '01')
  assert.equal(out.stainless_runtime_version, 'v26.3.0')
})

test('merge keeps official machine as device_id and parks guest machine', () => {
  const out = mergeGuestFingerprint(
    {
      official_machine_id: 'official-m',
      device_id: 'old-dev',
      machine_id: 'guest-m',
      session_id: 'sess-keep',
    },
    { hostname: '01', machine_id: 'guest-new', arch: 'amd64', goos: 'linux' },
  )
  assert.equal(out.device_id, 'official-m')
  assert.equal(out.official_machine_id, 'official-m')
  assert.equal(out.guest_machine_id, 'guest-new')
  assert.equal(out.identity_source, 'official-cc-init')
  assert.equal('machine_id' in out, false)
})

test('collectSlotIdentity writes guest fingerprint onto vm.json', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-guest-'))
  const id = 'vm-01'
  fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
  const vmPath = path.join(root, 'vms', `${id}.json`)
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id,
      fingerprint: { device_id: 'dev-1', session_id: 'sess-1' },
      runtime: { type: 'docker' },
    }),
  )
  const out = await collectSlotIdentity(
    root,
    { id, runtime: { type: 'docker' } },
    {
      callGet: async () => ({
        ok: true,
        status: 200,
        body: {
          ok: true,
          identity: {
            hostname: '01',
            os_pretty: 'Ubuntu 24.04',
            arch: 'amd64',
            goos: 'linux',
            runtime_kind: 'docker',
            worker_version: 'test',
            collected_at: '2026-08-23T01:00:00Z',
          },
        },
      }),
    },
  )
  assert.equal(out.ok, true)
  const saved = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(saved.fingerprint.device_id, 'dev-1')
  assert.equal(saved.fingerprint.hostname, '01')
  assert.equal(saved.fingerprint.source, 'guest')
  assert.equal(saved.runtime.identity_collected_at, '2026-08-23T01:00:00Z')
  fs.rmSync(root, { recursive: true, force: true })
})

test('collectSlotIdentity refreshes worker telemetry; hardware stays on the vm record', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-guest-telemetry-'))
  const id = 'vm-02'
  const slotDir = path.join(root, 'vms', id)
  fs.mkdirSync(path.join(slotDir, 'cli-home', '.claude'), { recursive: true })
  fs.mkdirSync(path.join(slotDir, 'run'), { recursive: true })
  fs.writeFileSync(
    path.join(slotDir, 'cli-home', '.claude.json'),
    JSON.stringify({ userID: 'ab'.repeat(32), machineID: 'cd'.repeat(32) }),
  )
  fs.writeFileSync(path.join(slotDir, 'run', 'worker.json'), JSON.stringify({ vm_id: id }))
  const vmPath = path.join(root, 'vms', `${id}.json`)
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id,
      seed_policy: { telemetry_disabled: false },
      fingerprint: { device_id: 'dev-1', session_id: 'sess-1' },
      runtime: { type: 'docker' },
    }),
  )
  const out = await collectSlotIdentity(
    root,
    { id, runtime: { type: 'docker' } },
    {
      callGet: async () => ({
        ok: true,
        status: 200,
        body: {
          identity: {
            hostname: '02',
            os_pretty: 'Ubuntu 24.04',
            arch: 'amd64',
            goos: 'linux',
            runtime_kind: 'docker',
            collected_at: '2026-08-23T01:00:00Z',
            hardware: {
              cpu_model: 'Observed CPU',
              cpu_cores: 8,
              memory_bytes: 8589934592,
              shell: '/bin/zsh',
            },
          },
        },
      }),
    },
  )
  assert.equal(out.ok, true)
  assert.equal(out.telemetry_sync.wrote, true)
  const worker = JSON.parse(fs.readFileSync(path.join(slotDir, 'run', 'worker.json'), 'utf8'))
  assert.equal(worker.telemetry.identity.cpu_model, undefined)
  assert.equal(worker.telemetry.identity.env.cpu_model, undefined)
  assert.equal(worker.telemetry.identity.env.shell, 'zsh')
  const saved = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(saved.fingerprint.hardware.cpu_model, 'Observed CPU')
  fs.rmSync(root, { recursive: true, force: true })
})

test('collectSlotIdentity maps missing endpoint', async () => {
  const out = await collectSlotIdentity(
    '/tmp',
    { id: 'vm-01' },
    {
      callGet: async () => ({ ok: false, status: 404, body: { error: { message: 'not found' } } }),
    },
  )
  assert.equal(out.ok, false)
  assert.equal(out.code, 'worker_identity_unsupported')
})

test('merge keeps generated hostname and catalog kernel', () => {
  const out = mergeGuestFingerprint(
    {
      device_id: 'ab'.repeat(32),
      session_id: 'sess-keep',
      hostname: 'ubuntu-a3f1',
      linux_kernel: '6.8.0-51-generic',
      guest_machine_id: 'cd'.repeat(16),
      source: 'generated',
      timezone: 'America/Denver',
      locale: 'en_US.UTF-8',
    },
    {
      hostname: '05',
      kernel_release: '7.0.0-14-generic',
      machine_id: 'guest-new',
      timezone: 'UTC',
      locale: 'C',
      arch: 'amd64',
      goos: 'linux',
    },
  )
  assert.equal(out.hostname, 'ubuntu-a3f1')
  assert.equal(out.guest_hostname, '05')
  assert.equal(out.kernel_release, '6.8.0-51-generic')
  assert.equal(out.guest_kernel_release, '7.0.0-14-generic')
  assert.equal(out.guest_machine_id, 'cd'.repeat(16))
  assert.equal(out.timezone, 'America/Denver')
  assert.equal(out.locale, 'en_US.UTF-8')
  assert.equal(out.source, 'generated')
  assert.equal(out.device_id, 'ab'.repeat(32))
})

test('merge persists observed hardware without rotating stable identity', () => {
  const out = mergeGuestFingerprint(
    {
      device_id: 'dev-keep',
      session_id: 'sess-keep',
      hostname: 'ubuntu-a3f1',
      linux_kernel: '6.8.0-51-generic',
      hardware: { cpu_model: 'old-cpu', cpu_cores: 2, mac: 'aa:aa:aa:aa:aa:aa' },
    },
    {
      hostname: '05',
      arch: 'amd64',
      goos: 'linux',
      collected_at: '2026-10-17T00:00:00Z',
      hardware: {
        cpu_model: 'Intel(R) Xeon(R) CPU',
        cpu_cores: 4,
        memory_bytes: 8589934592,
        root_disk: '/dev/vda2',
        mac: '52:54:00:11:22:33',
        dmi: { manufacturer: 'Dell Inc.', product: 'OptiPlex 7090', serial: 'ABC123' },
        shell: 'bash',
        package_managers: 'apt',
        runtimes: 'node,python',
        observed_at: '2026-10-17T00:00:00Z',
      },
    },
  )
  assert.equal(out.device_id, 'dev-keep')
  assert.equal(out.session_id, 'sess-keep')
  assert.equal(out.hostname, 'ubuntu-a3f1')
  assert.equal(out.linux_kernel, '6.8.0-51-generic')
  assert.equal(out.hardware.cpu_model, 'Intel(R) Xeon(R) CPU')
  assert.equal(out.hardware.cpu_cores, 4)
  assert.equal(out.hardware.memory_bytes, 8589934592)
  assert.equal(out.hardware.mac, '52:54:00:11:22:33')
  assert.equal(out.hardware.dmi.product, 'OptiPlex 7090')
  assert.equal(out.hardware.package_managers, 'apt')
  assert.equal(out.hardware.observed_at, '2026-10-17T00:00:00Z')
})

test('merge keeps previous hardware facts when new probes are empty', () => {
  const out = mergeGuestHardware(
    {
      cpu_model: 'keep-cpu',
      cpu_cores: 8,
      dmi: { manufacturer: 'Dell Inc.', product: 'keep' },
      observed_at: '2026-01-01T00:00:00Z',
    },
    { cpu_model: '', cpu_cores: null, dmi: { manufacturer: '' } },
    '2026-10-17T01:00:00Z',
  )
  assert.equal(out.cpu_model, 'keep-cpu')
  assert.equal(out.cpu_cores, 8)
  assert.equal(out.dmi.product, 'keep')
  assert.equal(out.dmi.manufacturer, 'Dell Inc.')
  assert.equal(out.observed_at, '2026-10-17T01:00:00Z')
})

test('merge without guest hardware leaves previous fingerprint.hardware', () => {
  const out = mergeGuestFingerprint(
    { device_id: 'dev', hardware: { cpu_model: 'keep-cpu', cpu_cores: 2 } },
    { hostname: '01', arch: 'amd64', goos: 'linux' },
  )
  assert.equal(out.hardware.cpu_model, 'keep-cpu')
  assert.equal(out.hardware.cpu_cores, 2)
})
