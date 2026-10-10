import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { READ_IDENTITY, readGuestIdentity } from '../../src/lib/vm/guest-identity-reader.mjs'
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
