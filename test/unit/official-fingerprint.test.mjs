import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  reconcileFingerprint,
  applyOfficialFingerprintToVm,
  discardLeftoverClaudeJson,
  readOfficialCcIdentity,
  OFFICIAL_IDENTITY_SOURCE,
} from '../../src/lib/identity/official-fingerprint.mjs'

test('official machineID replaces slot-generated device_id', () => {
  const machine = 'aa'.repeat(32)
  const user = 'bb'.repeat(32)
  const next = reconcileFingerprint(
    { device_id: 'slot-uuid', machine_id: 'guest-os', session_id: 'sess' },
    { machine_id: machine, user_id: user },
  )
  assert.equal(next.device_id, machine)
  assert.equal(next.official_machine_id, machine)
  assert.equal(next.official_user_id, user)
  assert.equal(next.identity_source, OFFICIAL_IDENTITY_SOURCE)
  assert.equal(next.guest_machine_id, 'guest-os')
  assert.equal(next.machine_id, undefined)
  assert.equal(next.session_id, 'sess')
})

test('applyOfficialFingerprintToVm writes vm.json and drops leftover claude.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fp-'))
  const home = path.join(root, 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  const machine = 'cc'.repeat(32)
  const user = 'dd'.repeat(32)
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({
      machineID: machine,
      userID: user,
      oauthAccount: { accountUuid: 'acc-1' },
    }),
  )
  fs.writeFileSync(
    path.join(home, '.claude', '.claude.json'),
    JSON.stringify({
      machineID: 'leftover-mid',
      userID: 'leftover-uid',
    }),
  )
  const vmPath = path.join(root, 'vm-30.json')
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-30',
      fingerprint: { device_id: 'slot-uuid', official_machine_id: 'old-mid' },
    }),
  )
  fs.writeFileSync(
    path.join(home, '.claude', 'kin-identity.json'),
    JSON.stringify({
      device_id: 'slot-uuid',
      account_uuid: 'acc-1',
    }),
  )
  const result = applyOfficialFingerprintToVm(vmPath, home)
  assert.equal(result.wrote, true)
  assert.equal(result.replaced_device, true)
  assert.equal(result.leftover.removed, true)
  assert.equal(result.leftover.conflict, true)
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.fingerprint.device_id, machine)
  assert.equal(vm.fingerprint.official_user_id, user)
  assert.equal(vm.fingerprint.identity_source, OFFICIAL_IDENTITY_SOURCE)
  assert.equal(fs.existsSync(path.join(home, '.claude', '.claude.json')), false)
  const ident = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'kin-identity.json'), 'utf8'))
  assert.equal(ident.device_id, machine)
  fs.rmSync(root, { recursive: true, force: true })
})

test('discardLeftoverClaudeJson is a no-op when missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fp-miss-'))
  assert.deepEqual(discardLeftoverClaudeJson(root), { removed: false, conflict: false, promoted: false })
  fs.rmSync(root, { recursive: true, force: true })
})

test('CLAUDE_CONFIG_DIR nested claude.json is official identity and is promoted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fp-nested-'))
  const home = path.join(root, 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  const machine = 'ee'.repeat(32)
  const user = 'ff'.repeat(32)
  fs.writeFileSync(
    path.join(home, '.claude', '.claude.json'),
    JSON.stringify({
      machineID: machine,
      userID: user,
      oauthAccount: { accountUuid: 'acc-nested', emailAddress: 'n@example.com' },
    }),
  )
  const ident = readOfficialCcIdentity(home)
  assert.equal(ident.machine_id, machine)
  assert.equal(ident.user_id, user)
  assert.equal(ident.account_uuid, 'acc-nested')

  const vmPath = path.join(root, 'vm-02.json')
  fs.writeFileSync(vmPath, JSON.stringify({ id: 'vm-02', fingerprint: { device_id: 'slot-uuid' } }))
  const result = applyOfficialFingerprintToVm(vmPath, home)
  assert.equal(result.wrote, true)
  assert.equal(result.official, true)
  assert.equal(result.leftover.promoted, true)
  assert.equal(result.leftover.removed, false)
  assert.equal(fs.existsSync(path.join(home, '.claude.json')), true)
  assert.equal(fs.existsSync(path.join(home, '.claude', '.claude.json')), true)
  const canonical = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))
  assert.equal(canonical.machineID, machine)
  assert.equal(canonical.userID, user)
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.fingerprint.device_id, machine)
  assert.equal(vm.fingerprint.official_user_id, user)
  assert.equal(vm.fingerprint.identity_source, OFFICIAL_IDENTITY_SOURCE)
  fs.rmSync(root, { recursive: true, force: true })
})

test('matching nested claude.json is kept when canonical already has the same IDs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fp-match-'))
  const home = path.join(root, 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  const doc = { machineID: '11'.repeat(32), userID: '22'.repeat(32) }
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(doc))
  fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify(doc))
  const out = discardLeftoverClaudeJson(home)
  assert.deepEqual(out, { removed: false, conflict: false, promoted: false })
  assert.equal(fs.existsSync(path.join(home, '.claude', '.claude.json')), true)
  fs.rmSync(root, { recursive: true, force: true })
})
