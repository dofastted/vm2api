import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase, getDb } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { generateCode } from '../../src/lib/core/totp.mjs'
import {
  TwoFactorError,
  beginTwoFactorSetup,
  clearAttempts,
  confirmTwoFactorSetup,
  consumeTwoFactorChallenge,
  disableTwoFactor,
  isTwoFactorEnabled,
  issueTwoFactorChallenge,
  normalizeRecoveryCode,
  regenerateRecoveryCodes,
  twoFactorEnabledFor,
  twoFactorKey,
  twoFactorStatus,
  verifyTwoFactorCode,
} from '../../src/lib/core/panel-2fa.mjs'

const USER = 'admin'
let root

/** Enrolls USER and returns the secret plus its recovery codes. */
function enroll(user = USER) {
  const { secret } = beginTwoFactorSetup(user)
  const { recovery_codes } = confirmTwoFactorSetup(user, generateCode(secret, new Date()))
  return { secret, recoveryCodes: recovery_codes }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-2fa-'))
  openDatabase({ dataDir: path.join(root, 'data') })
  clearAttempts(USER)
})

afterEach(() => {
  closeDatabase()
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.VM2API_DB_SECRET
  clearAttempts(USER)
})

test('2FA is off until enrollment is confirmed', () => {
  assert.equal(isTwoFactorEnabled(USER), false)
  assert.deepEqual(twoFactorStatus(USER), {
    enabled: false,
    pending: false,
    confirmed_at: null,
    recovery_total: 0,
    recovery_remaining: 0,
    digits: 6,
    period: 30,
  })

  const setup = beginTwoFactorSetup(USER)
  assert.match(setup.uri, /^otpauth:\/\/totp\//)
  assert.match(setup.uri, /issuer=vm2api/)
  assert.equal(setup.secret.length, 32)
  // An abandoned setup must never gate sign-in.
  assert.equal(isTwoFactorEnabled(USER), false)
  assert.equal(twoFactorStatus(USER).pending, true)

  confirmTwoFactorSetup(USER, generateCode(setup.secret, new Date()))
  assert.equal(isTwoFactorEnabled(USER), true)
  assert.equal(twoFactorStatus(USER).enabled, true)
  assert.ok(twoFactorStatus(USER).confirmed_at)
})

test('enrollment needs a code the authenticator actually produced', () => {
  beginTwoFactorSetup(USER)
  assert.throws(
    () => confirmTwoFactorSetup(USER, '000000'),
    (e) => e instanceof TwoFactorError && e.code === 'totp_invalid_code',
  )
  assert.equal(isTwoFactorEnabled(USER), false)
})

test('confirming without a setup, or twice, is refused', () => {
  assert.throws(
    () => confirmTwoFactorSetup(USER, '123456'),
    (e) => e.code === 'totp_setup_missing',
  )
  const { secret } = enroll()
  assert.throws(
    () => confirmTwoFactorSetup(USER, generateCode(secret, new Date())),
    (e) => e.code === 'totp_already_enabled',
  )
  assert.throws(
    () => beginTwoFactorSetup(USER),
    (e) => e.code === 'totp_already_enabled',
  )
})

test('enrollment hands out ten single-use recovery codes', () => {
  const { recoveryCodes } = enroll()
  assert.equal(recoveryCodes.length, 10)
  assert.equal(new Set(recoveryCodes).size, 10)
  for (const code of recoveryCodes) assert.match(code, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/)
  const status = twoFactorStatus(USER)
  assert.equal(status.recovery_total, 10)
  assert.equal(status.recovery_remaining, 10)
})

test('a valid code signs in and the same code cannot be replayed', () => {
  const { secret } = enroll()
  // The step used to enroll is already spent.
  assert.throws(
    () => verifyTwoFactorCode(USER, generateCode(secret, new Date())),
    (e) => e.code === 'totp_code_reused',
  )
  clearAttempts(USER)
  // The next step is accepted, and then spent in turn.
  const next = new Date(Date.now() + 30_000)
  assert.deepEqual(verifyTwoFactorCode(USER, generateCode(secret, next)), { ok: true, method: 'totp' })
  assert.throws(
    () => verifyTwoFactorCode(USER, generateCode(secret, next)),
    (e) => e.code === 'totp_code_reused',
  )
})

test('a wrong code is rejected and 2FA must be enabled to verify at all', () => {
  assert.throws(
    () => verifyTwoFactorCode(USER, '123456'),
    (e) => e.code === 'totp_not_enabled',
  )
  enroll()
  assert.throws(
    () => verifyTwoFactorCode(USER, '000000'),
    (e) => e.code === 'totp_invalid_code',
  )
  clearAttempts(USER)
  assert.throws(
    () => verifyTwoFactorCode(USER, ''),
    (e) => e.code === 'totp_invalid_code',
  )
})

test('a recovery code works once, with or without its dash', () => {
  const { recoveryCodes } = enroll()
  const result = verifyTwoFactorCode(USER, recoveryCodes[0])
  assert.equal(result.method, 'recovery')
  assert.equal(result.recovery_remaining, 9)
  assert.throws(
    () => verifyTwoFactorCode(USER, recoveryCodes[0]),
    (e) => e.code === 'totp_invalid_code',
  )
  clearAttempts(USER)

  // Lower case, spaced and dash-free spellings all resolve to the same code.
  const spelled = recoveryCodes[1].replace('-', ' ').toLowerCase()
  assert.equal(verifyTwoFactorCode(USER, spelled).method, 'recovery')
  clearAttempts(USER)
  assert.equal(verifyTwoFactorCode(USER, normalizeRecoveryCode(recoveryCodes[2])).method, 'recovery')
  assert.equal(twoFactorStatus(USER).recovery_remaining, 7)
})

test('regenerating recovery codes invalidates the previous set', () => {
  const { recoveryCodes } = enroll()
  const { recovery_codes: fresh } = regenerateRecoveryCodes(USER)
  assert.equal(fresh.length, 10)
  assert.equal(
    fresh.some((code) => recoveryCodes.includes(code)),
    false,
  )
  assert.throws(
    () => verifyTwoFactorCode(USER, recoveryCodes[0]),
    (e) => e.code === 'totp_invalid_code',
  )
  clearAttempts(USER)
  assert.equal(verifyTwoFactorCode(USER, fresh[0]).method, 'recovery')
  assert.equal(twoFactorStatus(USER).recovery_remaining, 9)
})

test('recovery codes cannot be regenerated before 2FA is on', () => {
  assert.throws(
    () => regenerateRecoveryCodes(USER),
    (e) => e.code === 'totp_not_enabled',
  )
  beginTwoFactorSetup(USER)
  assert.throws(
    () => regenerateRecoveryCodes(USER),
    (e) => e.code === 'totp_not_enabled',
  )
})

test('repeated wrong codes lock verification for a while', () => {
  enroll()
  for (let i = 0; i < 5; i += 1) {
    assert.throws(
      () => verifyTwoFactorCode(USER, '000000'),
      (e) => e.code === 'totp_invalid_code',
      `attempt ${i + 1}`,
    )
  }
  assert.throws(
    () => verifyTwoFactorCode(USER, '000000'),
    (e) => e.code === 'totp_too_many_attempts' && e.status === 429,
  )
  // Even a correct code is held off while locked.
  assert.throws(
    () => verifyTwoFactorCode(USER, '000001'),
    (e) => e.code === 'totp_too_many_attempts',
  )
  clearAttempts(USER)
  assert.throws(
    () => verifyTwoFactorCode(USER, '000000'),
    (e) => e.code === 'totp_invalid_code',
  )
})

test('disabling clears the secret and the recovery codes', () => {
  const { secret } = enroll()
  assert.equal(disableTwoFactor(USER), true)
  assert.equal(isTwoFactorEnabled(USER), false)
  assert.equal(new SettingsRepo(getDb()).get(twoFactorKey(USER), null), null)
  assert.equal(disableTwoFactor(USER), false, 'disabling twice is a no-op')
  // The old secret is gone, so a code from it means nothing now.
  assert.throws(
    () => verifyTwoFactorCode(USER, generateCode(secret, new Date())),
    (e) => e.code === 'totp_not_enabled',
  )
})

test('state is keyed case-insensitively, like the users table', () => {
  enroll('Admin')
  assert.equal(isTwoFactorEnabled('admin'), true)
  assert.equal(isTwoFactorEnabled('ADMIN'), true)
  assert.equal(twoFactorKey(' Admin '), 'panel_2fa:admin')
  assert.equal(disableTwoFactor('ADMIN'), true)
  assert.equal(isTwoFactorEnabled('Admin'), false)
})

test('the batch lookup matches the single-account one', () => {
  enroll('alice')
  const map = twoFactorEnabledFor(['alice', 'bob'])
  assert.equal(map.get('alice'), true)
  assert.equal(map.get('bob'), false)
  assert.equal(map.get('alice'), isTwoFactorEnabled('alice'))
})

test('the stored secret is encrypted when VM2API_DB_SECRET is set', () => {
  process.env.VM2API_DB_SECRET = 'unit-test-secret'
  const { secret, recoveryCodes } = enroll()
  const stored = new SettingsRepo(getDb()).get(twoFactorKey(USER), null)
  assert.ok(stored)
  assert.match(stored.secret, /^enc:v1:/)
  const blob = JSON.stringify(stored)
  assert.equal(blob.includes(secret), false, 'the base32 secret must not be stored in the clear')
  for (const code of recoveryCodes) {
    assert.equal(blob.includes(normalizeRecoveryCode(code)), false, 'recovery codes are hashed, never stored')
  }
  // Still usable through the encryption layer.
  assert.equal(verifyTwoFactorCode(USER, generateCode(secret, new Date(Date.now() + 30_000))).method, 'totp')
})

test('a secret that no longer decrypts fails sign-in closed', () => {
  process.env.VM2API_DB_SECRET = 'original-secret'
  enroll()
  process.env.VM2API_DB_SECRET = 'rotated-secret'
  // Still flagged as enabled — it must not silently degrade to password-only.
  assert.equal(isTwoFactorEnabled(USER), true)
  assert.throws(
    () => verifyTwoFactorCode(USER, '123456'),
    (e) => e.code === 'totp_secret_unreadable' && e.status === 500,
  )
})

test('a challenge round-trips its username and claims', () => {
  const { challenge, expires_in } = issueTwoFactorChallenge(USER, { claims: { role: 'admin', id: 'u1' } })
  assert.equal(expires_in, 300)
  const opened = consumeTwoFactorChallenge(challenge)
  assert.equal(opened.username, USER)
  assert.deepEqual(opened.claims, { role: 'admin', id: 'u1' })
  assert.throws(
    () => issueTwoFactorChallenge(''),
    (e) => e.code === 'invalid_user',
  )
})

test('a forged, altered or malformed challenge is refused', () => {
  const { challenge } = issueTwoFactorChallenge(USER, { claims: { role: 'user' } })
  const [payload, signature] = [challenge.slice(0, challenge.lastIndexOf('.')), challenge.split('.').pop()]

  // Re-signing a privilege escalation requires the server key.
  const forgedPayload = Buffer.from(
    JSON.stringify({ u: USER, exp: Date.now() + 60_000, c: { role: 'admin' } }),
  ).toString('base64url')
  assert.throws(
    () => consumeTwoFactorChallenge(`${forgedPayload}.${signature}`),
    (e) => e.code === 'totp_challenge_invalid',
  )
  assert.throws(
    () => consumeTwoFactorChallenge(`${payload}.${signature.slice(0, -1)}x`),
    (e) => e.code === 'totp_challenge_invalid',
  )
  assert.throws(
    () => consumeTwoFactorChallenge(payload),
    (e) => e.code === 'totp_challenge_invalid',
  )
  assert.throws(
    () => consumeTwoFactorChallenge(''),
    (e) => e.code === 'totp_challenge_invalid',
  )
  assert.throws(
    () => consumeTwoFactorChallenge('not.a.challenge'),
    (e) => e.code === 'totp_challenge_invalid',
  )
})

test('an expired challenge is refused', () => {
  const { challenge } = issueTwoFactorChallenge(USER, { ttlMs: -1_000 })
  assert.throws(
    () => consumeTwoFactorChallenge(challenge),
    (e) => e.code === 'totp_challenge_expired' && e.status === 401,
  )
})

test('the challenge signing key survives a reopen and differs per install', () => {
  const { challenge } = issueTwoFactorChallenge(USER)
  closeDatabase()
  openDatabase({ dataDir: path.join(root, 'data') })
  assert.equal(consumeTwoFactorChallenge(challenge).username, USER, 'the key is persisted, not per-process')

  // A different install cannot validate it.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-2fa-other-'))
  try {
    closeDatabase()
    openDatabase({ dataDir: path.join(other, 'data') })
    assert.throws(
      () => consumeTwoFactorChallenge(challenge),
      (e) => e.code === 'totp_challenge_invalid',
    )
  } finally {
    fs.rmSync(other, { recursive: true, force: true })
  }
})
