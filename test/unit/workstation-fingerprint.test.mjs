import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeTimezone, US_TIMEZONES } from '../../src/lib/core/timezone.mjs'
import {
  applyGeneratedFingerprint,
  DEVICE_ID_RE,
  generateWorkstationFingerprint,
  HOSTNAME_RE,
  isGeneratedHostname,
  isHexDeviceId,
  MACHINE_ID_RE,
  takenFingerprintKeys,
  writeGuestMachineIdFile,
} from '../../src/lib/identity/workstation-fingerprint.mjs'

test('generateWorkstationFingerprint emits a coherent linux pack', () => {
  const pack = generateWorkstationFingerprint({ id: 'vm-05', kernel: 'ubuntu-24.04' })
  assert.match(pack.hostname, HOSTNAME_RE)
  assert.equal(pack.hostname.startsWith('ubuntu-'), true)
  assert.match(pack.device_id, DEVICE_ID_RE)
  assert.match(pack.guest_machine_id, MACHINE_ID_RE)
  assert.equal(pack.sku, '4c8g')
  assert.equal(pack.linux_kernel, '6.8.0-51-generic')
  assert.equal(pack.locale, 'en_US.UTF-8')
  assert.match(pack.timezone, /^America\//)
  assert.equal(pack.source, 'generated')
  assert.equal(isGeneratedHostname(pack.hostname), true)
  assert.equal(isHexDeviceId(pack.device_id), true)
})

test('debian family hostname and catalog kernel', () => {
  const pack = generateWorkstationFingerprint({ id: 'vm-10', kernel: 'debian-12' })
  assert.equal(pack.hostname.startsWith('debian-'), true)
  assert.equal(pack.sku, '2c4g')
  assert.match(pack.linux_kernel, /6\.1\.0-\d+-amd64/)
})

test('collision retries until unused hostname', () => {
  const first = generateWorkstationFingerprint({ id: 'vm-01', kernel: 'ubuntu-24.04' })
  const taken = takenFingerprintKeys([{ fingerprint: first }])
  const second = generateWorkstationFingerprint({ id: 'vm-02', kernel: 'ubuntu-24.04' }, { taken })
  assert.notEqual(second.hostname, first.hostname)
  assert.notEqual(second.device_id, first.device_id)
  assert.notEqual(second.guest_machine_id, first.guest_machine_id)
})

test('timezone is not a dead index mapping', () => {
  const seen = new Set()
  for (let i = 0; i < 24; i++) {
    const pack = generateWorkstationFingerprint({ id: 'vm-05', kernel: 'ubuntu-24.04' })
    seen.add(pack.timezone)
  }
  assert.ok(seen.size >= 2)
})

test('explicit America timezone is kept', () => {
  const pack = generateWorkstationFingerprint({
    id: 'vm-03',
    kernel: 'ubuntu-24.04',
    timezone: 'America/Denver',
  })
  assert.equal(pack.timezone, 'America/Denver')
})

test('explicit Tokyo timezone survives fingerprint generation and slot normalization', () => {
  const pack = generateWorkstationFingerprint({ id: 'vm-01', timezone: ' asia/tokyo ' })
  const fingerprint = applyGeneratedFingerprint({}, pack)
  assert.equal(pack.timezone, 'Asia/Tokyo')
  assert.equal(fingerprint.timezone, 'Asia/Tokyo')
  assert.equal(normalizeTimezone(pack.timezone), 'Asia/Tokyo')
  assert.equal(pack.locale, 'en_US.UTF-8')
})

test('invalid fingerprint timezone retains the existing US random fallback', () => {
  for (const timezone of ['', 'Asia/Not_A_Zone', 'America/Not_A_Zone', '+09:00']) {
    const pack = generateWorkstationFingerprint({ id: 'vm-01', timezone })
    assert.ok(US_TIMEZONES.includes(pack.timezone))
  }
})

test('applyGeneratedFingerprint drops official ids for reconcile to refill', () => {
  const pack = generateWorkstationFingerprint({ id: 'vm-05', kernel: 'ubuntu-24.04' })
  const next = applyGeneratedFingerprint(
    { official_machine_id: 'old', official_user_id: 'u', identity_source: 'official-cc-init', session_id: 'keep?' },
    pack,
  )
  assert.equal(next.device_id, pack.device_id)
  assert.equal(next.hostname, pack.hostname)
  assert.equal(next.official_machine_id, undefined)
  assert.equal(next.identity_source, undefined)
})

test('writeGuestMachineIdFile replaces a docker directory trap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mid-'))
  const destDir = path.join(root, 'vms', 'vm-05', 'machine-id')
  fs.mkdirSync(destDir, { recursive: true })
  const dest = writeGuestMachineIdFile(root, 'vm-05', 'ab'.repeat(16))
  assert.equal(fs.statSync(dest).isFile(), true)
  assert.equal(fs.readFileSync(dest, 'utf8').trim(), 'ab'.repeat(16))
  fs.rmSync(root, { recursive: true, force: true })
})
