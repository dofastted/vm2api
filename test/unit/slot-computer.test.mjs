import '../fixtures/kin-computer-test-env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RFC4122_UUID_RE } from '../../src/lib/identity/rfc4122-uuid.mjs'
import { DEVICE_ID_RE, HOSTNAME_RE, MACHINE_ID_RE } from '../../src/lib/identity/workstation-fingerprint.mjs'
import { assignComputerFingerprint, ensureSlotComputer } from '../../src/lib/identity/slot-computer.mjs'

test('missing kin-computer binary throws computer_service_missing', () => {
  const prev = process.env.KIN_COMPUTER_BIN
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-computer-missing-'))
  try {
    process.env.KIN_COMPUTER_BIN = path.join(root, 'no-such-kin-computer-bin')
    const vm = { id: 'vm-missing-bin', kernel: 'ubuntu-24.04', runtime: { type: 'docker' } }
    assert.throws(
      () => ensureSlotComputer(root, vm),
      (err) => err?.code === 'computer_service_missing',
    )
  } finally {
    if (prev == null) delete process.env.KIN_COMPUTER_BIN
    else process.env.KIN_COMPUTER_BIN = prev
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('kvm fingerprint with empty uuid is repaired in place with RFC4122 writeback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-computer-bad-uuid-'))
  const vm = { id: 'vm-bad-uuid', kernel: 'ubuntu-24.04', runtime: { type: 'kvm' } }
  const dir = path.join(root, 'vms', vm.id, 'kvm', 'fingerprint')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'identity.json'),
    `${JSON.stringify({ hostname: 'wks1234567890123', machine_id: 'a'.repeat(32), uuid: '' }, null, 2)}\n`,
  )
  fs.writeFileSync(path.join(dir, 'qemu-smbios.args'), '-smbios\ntype=1,manufacturer=KinStub,product=Test\n')
  const fixed = ensureSlotComputer(root, vm)
  assert.equal(fixed.created, false)
  const ident = JSON.parse(fs.readFileSync(path.join(fixed.dir, 'identity.json'), 'utf8'))
  assert.match(String(ident.uuid || ''), RFC4122_UUID_RE)
  const args = fs.readFileSync(path.join(fixed.dir, 'qemu-smbios.args'), 'utf8')
  assert.match(args, new RegExp(`-uuid\\s*\\n${ident.uuid}`, 'm'))
  assert.match(args, new RegExp(`uuid=${ident.uuid}`))
  fs.rmSync(root, { recursive: true, force: true })
})

test('kin-computer empty uuid after create is coerced before acceptance', () => {
  const prev = process.env.KIN_COMPUTER_STUB_EMPTY_UUID
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-computer-empty-create-'))
  try {
    process.env.KIN_COMPUTER_STUB_EMPTY_UUID = '1'
    const vm = { id: 'vm-empty-create', kernel: 'ubuntu-24.04', runtime: { type: 'kvm' } }
    const first = ensureSlotComputer(root, vm)
    assert.equal(first.created, true)
    const ident = JSON.parse(fs.readFileSync(path.join(first.dir, 'identity.json'), 'utf8'))
    assert.match(String(ident.uuid || ''), RFC4122_UUID_RE)
    const args = fs.readFileSync(path.join(first.dir, 'qemu-smbios.args'), 'utf8')
    assert.doesNotMatch(args, /-uuid\s*\n\s*\n/)
    assert.match(args, new RegExp(`uuid=${ident.uuid}`))
  } finally {
    if (prev == null) delete process.env.KIN_COMPUTER_STUB_EMPTY_UUID
    else process.env.KIN_COMPUTER_STUB_EMPTY_UUID = prev
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('linux computer is written once and device_id stays 64-bit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-computer-linux-'))
  const vm = { id: 'vm-linux-1', kernel: 'ubuntu-24.04', runtime: { type: 'kvm' } }
  const first = ensureSlotComputer(root, vm)
  const second = ensureSlotComputer(root, vm)
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.hostname, first.hostname)
  assert.equal(second.guest_machine_id, first.guest_machine_id)
  assert.match(first.hostname, HOSTNAME_RE)
  assert.doesNotMatch(first.hostname, /^[a-z]+-[0-9a-f]{4}$/)
  assert.match(first.guest_machine_id, MACHINE_ID_RE)
  assert.equal(fs.existsSync(path.join(first.dir, 'qemu-smbios.args')), true)
  const pack = assignComputerFingerprint(root, vm, {
    taken: { hostname: new Set(), device_id: new Set(), guest_machine_id: new Set() },
  })
  assert.equal(pack.hostname, first.hostname)
  assert.equal(pack.guest_machine_id, first.guest_machine_id)
  assert.match(pack.device_id, DEVICE_ID_RE)
  const ident = JSON.parse(fs.readFileSync(path.join(first.dir, 'identity.json'), 'utf8'))
  const uuid = String(ident.uuid || '')
    .replace(/-/g, '')
    .toLowerCase()
  assert.notEqual(pack.device_id, uuid)
  fs.rmSync(root, { recursive: true, force: true })
})

test('container computer prepare is stable and exposes mac plus dmi', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-computer-os-'))
  const vm = { id: 'vm-os-1', kernel: 'ubuntu-24.04', runtime: { type: 'docker' } }
  const first = ensureSlotComputer(root, vm)
  const second = ensureSlotComputer(root, vm)
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.hostname, first.hostname)
  assert.match(first.hostname, HOSTNAME_RE)
  assert.doesNotMatch(first.hostname, /^[a-z]+-[0-9a-f]{4}$/)
  assert.match(first.guest_machine_id, MACHINE_ID_RE)
  assert.match(first.mac, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/)
  assert.equal(fs.statSync(path.join(first.dir, 'system', 'dmi', 'id')).isDirectory(), true)
  assert.equal(fs.readFileSync(path.join(first.dir, 'system', 'etc', 'kin-computer'), 'utf8').trim(), 'source=linux-pc')
  assert.equal(
    fs
      .readFileSync(path.join(first.dir, 'system', 'hardware', 'mac'), 'utf8')
      .trim()
      .toLowerCase(),
    first.mac,
  )
  fs.rmSync(root, { recursive: true, force: true })
})

function assertFingerprintModes(dir) {
  const stat = fs.lstatSync(dir)
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) {
    assert.equal(stat.mode & 0o777, 0o755, `expected 0755 on directory ${dir}`)
    for (const entry of fs.readdirSync(dir)) assertFingerprintModes(path.join(dir, entry))
    return
  }
  if (stat.isFile()) {
    assert.equal(stat.mode & 0o777, 0o644, `expected 0644 on file ${dir}`)
  }
}

test('ensureSlotComputer normalizes fingerprint dirs to 0755 and files to 0644 under umask 077', {
  skip: process.platform === 'win32',
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-computer-umask-'))
  const previousUmask = process.umask(0o077)
  try {
    const dockerVm = { id: 'vm-umask-docker', kernel: 'debian-12', runtime: { type: 'docker' } }
    const created = ensureSlotComputer(root, dockerVm)
    assert.equal(created.created, true)
    assertFingerprintModes(created.dir)

    // Simulate a pre-existing slot whose fingerprint files were stranded at 0700/0600.
    fs.chmodSync(path.join(created.dir, 'system', 'etc', 'kin-computer'), 0o600)
    fs.chmodSync(path.join(created.dir, 'system', 'dmi', 'id'), 0o700)
    const healed = ensureSlotComputer(root, dockerVm)
    assert.equal(healed.created, false)
    assert.equal(healed.hostname, created.hostname)
    assertFingerprintModes(healed.dir)
  } finally {
    process.umask(previousUmask)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
