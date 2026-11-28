import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_SLOT_HOME,
  DEFAULT_SLOT_USER,
  RESERVED_SLOT_USERNAMES,
  detectHostCpuVendor,
  isCustomSlotUser,
  isValidSlotUsername,
  slotClaudeDir,
  slotGuestUidGid,
  slotHome,
  slotUser,
} from '../../src/lib/vm/slot-identity.mjs'

test('isValidSlotUsername enforces regex, boundaries, and reserved blacklist', () => {
  for (const good of ['mchen', 'dwalsh84', 'sam_k', 'leo-park', 'hannah', 'a1b', 'abcdefgh12345678']) {
    assert.equal(isValidSlotUsername(good), true, `expected valid: ${good}`)
  }
  const badList = [
    '',
    ' ',
    'ab',
    'a'.repeat(17),
    '1alice',
    '-alice',
    '_alice',
    'alice-',
    'alice_',
    'a--b',
    'Alice',
    'alice.smith',
    ' alice',
    'alice ',
    'root',
    'kincli',
    'claude',
    'anthropic',
    'admin',
    'ubuntu',
    'debian',
    'systemd-network',
    'systemd-custom',
    'www-data',
    'nobody',
    'devbox',
    null,
    undefined,
    123,
  ]
  for (const bad of badList) {
    assert.equal(isValidSlotUsername(bad), false, `expected invalid: ${String(bad)}`)
  }
  assert.equal(RESERVED_SLOT_USERNAMES.has('kincli'), true)
  assert.equal(RESERVED_SLOT_USERNAMES.has('root'), true)
  assert.equal(DEFAULT_SLOT_USER, 'kincli')
  assert.equal(DEFAULT_SLOT_HOME, '/home/kincli')
})

test('slotUser, slotHome, slotClaudeDir, isCustomSlotUser preserve legacy kincli fallback', () => {
  for (const legacyVm of [null, undefined, {}, { fingerprint: {} }, { fingerprint: { username: 'root' } }]) {
    assert.equal(slotUser(legacyVm), 'kincli')
    assert.equal(slotHome(legacyVm), '/home/kincli')
    assert.equal(slotClaudeDir(legacyVm), '/home/kincli/.claude')
    assert.equal(isCustomSlotUser(legacyVm), false)
  }

  const customVm = { fingerprint: { username: 'mchen84' } }
  assert.equal(slotUser(customVm), 'mchen84')
  assert.equal(slotHome(customVm), '/home/mchen84')
  assert.equal(slotClaudeDir(customVm), '/home/mchen84/.claude')
  assert.equal(isCustomSlotUser(customVm), true)
})

test('slotGuestUidGid resolves explicit ids, legacy 999:987, and custom 1000:1000', () => {
  assert.deepEqual(slotGuestUidGid({}), { uid: 999, gid: 987 })
  assert.deepEqual(slotGuestUidGid({ fingerprint: {} }), { uid: 999, gid: 987 })
  assert.deepEqual(slotGuestUidGid({ fingerprint: { username: 'mchen84' } }), { uid: 1000, gid: 1000 })
  assert.deepEqual(slotGuestUidGid({ fingerprint: { username: 'mchen84', guest_uid: 1001, guest_gid: 1002 } }), {
    uid: 1001,
    gid: 1002,
  })
  // Reject non-positive uid/gid (e.g., 0 root) and fall back cleanly.
  assert.deepEqual(slotGuestUidGid({ fingerprint: { username: 'mchen84', guest_uid: 0, guest_gid: 0 } }), {
    uid: 1000,
    gid: 1000,
  })
})

test('detectHostCpuVendor reads vendor_id from cpuinfo cleanly', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cpuinfo-'))
  try {
    const amdFile = path.join(tmp, 'amd')
    const intelFile = path.join(tmp, 'intel')
    const armFile = path.join(tmp, 'arm')
    fs.writeFileSync(amdFile, 'processor\t: 0\nvendor_id\t: AuthenticAMD\nmodel name\t: EPYC\n', 'utf8')
    fs.writeFileSync(intelFile, 'processor\t: 0\nvendor_id\t: GenuineIntel\nmodel name\t: Xeon\n', 'utf8')
    fs.writeFileSync(armFile, 'processor\t: 0\nFeatures\t: fp asimd\n', 'utf8')
    assert.equal(detectHostCpuVendor({ cpuinfoPath: amdFile, env: {} }), 'amd')
    assert.equal(detectHostCpuVendor({ cpuinfoPath: intelFile, env: {} }), 'intel')
    assert.equal(detectHostCpuVendor({ cpuinfoPath: armFile, env: {} }), 'any')
    assert.equal(detectHostCpuVendor({ cpuinfoPath: path.join(tmp, 'missing'), env: {} }), 'any')
    assert.equal(detectHostCpuVendor({ env: { KIN_KVM_HOST_CPU_VENDOR: 'AuthenticAMD' } }), 'amd')
    assert.equal(detectHostCpuVendor({ env: { KIN_HOST_CPU_VENDOR: 'intel' } }), 'intel')
    assert.equal(detectHostCpuVendor({ env: { KIN_KVM_HOST_CPU_VENDOR: 'any' } }), 'any')
    assert.equal(
      detectHostCpuVendor({
        env: {},
        readFileSync: () => 'vendor_id\t: GenuineIntel\n',
      }),
      'intel',
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
