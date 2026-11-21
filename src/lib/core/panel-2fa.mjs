/**
 * Optional TOTP two-factor authentication for panel sign-in.
 *
 * State lives in the existing `settings` key/value table under
 * `panel_2fa:<username>` — no schema change, no new table. The shared secret
 * and the recovery-code hashes go through the same at-rest encryption as other
 * credential fields (`db/secure.mjs`), so setting VM2API_DB_SECRET protects
 * them too.
 *
 * Two-step sign-in: the password step mints a short-lived signed challenge,
 * the code step exchanges it for a session. The challenge is an HMAC over the
 * username and expiry, so it survives a restart and works across processes
 * without any shared state.
 */

import crypto from 'node:crypto'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { decryptString, encryptString } from '../db/secure.mjs'
import { DEFAULT_OPTIONS, buildOtpauthUri, generateSecret, matchCounter, normalizeSecret } from './totp.mjs'

const KEY_PREFIX = 'panel_2fa:'
const CHALLENGE_SECRET_KEY = 'panel_2fa_challenge_secret'
const CHALLENGE_TTL_MS = 5 * 60 * 1000
const RECOVERY_CODE_COUNT = 10
const RECOVERY_GROUP = 5
// A TOTP step is 30s and a recovery code is single-use, so a human never needs
// more than a handful of tries; brute force does.
const MAX_ATTEMPTS = 5
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000

/** Sign-in codes accept a TOTP code or one of the single-use recovery codes. */
export const TOTP_DIGITS = DEFAULT_OPTIONS.digits

export class TwoFactorError extends Error {
  constructor(message, code, status = 400) {
    super(message)
    this.name = 'TwoFactorError'
    this.code = code
    this.status = status
  }
}

/** The settings key is case-insensitive, matching the users table collation. */
export function twoFactorKey(username) {
  return (
    KEY_PREFIX +
    String(username || '')
      .trim()
      .toLowerCase()
  )
}

function settings() {
  return new SettingsRepo()
}

function nowIso() {
  return new Date().toISOString()
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function loadRecord(username, repo = settings()) {
  const name = String(username || '').trim()
  if (!name) return null
  const rec = repo.get(twoFactorKey(name), null)
  if (!rec || typeof rec !== 'object') return null
  return rec
}

function saveRecord(username, rec, repo = settings()) {
  repo.set(twoFactorKey(username), rec)
  return rec
}

function readSecret(rec) {
  if (!rec?.secret) return ''
  try {
    return normalizeSecret(decryptString(rec.secret) || '')
  } catch {
    // A stored secret that no longer decrypts (rotated VM2API_DB_SECRET) must
    // not read as "no 2FA": surface it so sign-in fails closed.
    throw new TwoFactorError('两步验证密钥无法解密，请联系管理员重置', 'totp_secret_unreadable', 500)
  }
}

function optionsOf(rec) {
  return {
    digits: rec?.digits || DEFAULT_OPTIONS.digits,
    period: rec?.period || DEFAULT_OPTIONS.period,
    algorithm: rec?.algorithm || DEFAULT_OPTIONS.algorithm,
    skew: DEFAULT_OPTIONS.skew,
  }
}

/** Whether the account must present a code after its password. */
export function isTwoFactorEnabled(username) {
  const rec = loadRecord(username)
  return !!(rec?.enabled && rec?.secret)
}

/** Batch form of {@link isTwoFactorEnabled} for the user list. */
export function twoFactorEnabledFor(usernames = []) {
  const repo = settings()
  const out = new Map()
  for (const name of usernames) {
    const rec = loadRecord(name, repo)
    out.set(name, !!(rec?.enabled && rec?.secret))
  }
  return out
}

/** Public status for the settings pane. */
export function twoFactorStatus(username) {
  const rec = loadRecord(username)
  const recovery = Array.isArray(rec?.recovery) ? rec.recovery : []
  return {
    enabled: !!(rec?.enabled && rec?.secret),
    pending: !!(rec && !rec.enabled && rec.secret),
    confirmed_at: rec?.confirmed_at || null,
    recovery_total: recovery.length,
    recovery_remaining: recovery.filter((item) => !item?.used_at).length,
    digits: rec?.digits || DEFAULT_OPTIONS.digits,
    period: rec?.period || DEFAULT_OPTIONS.period,
  }
}

function formatRecoveryCode() {
  // Crockford-ish base32 without look-alikes, grouped for legibility.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < RECOVERY_GROUP * 2; i += 1) {
    out += alphabet[crypto.randomInt(alphabet.length)]
  }
  return `${out.slice(0, RECOVERY_GROUP)}-${out.slice(RECOVERY_GROUP)}`
}

/** Strips grouping so users may paste a code with or without the dash. */
export function normalizeRecoveryCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

function mintRecoveryCodes() {
  const plain = []
  const stored = []
  while (plain.length < RECOVERY_CODE_COUNT) {
    const code = formatRecoveryCode()
    if (plain.includes(code)) continue
    plain.push(code)
    stored.push({ hash: encryptString(sha256(normalizeRecoveryCode(code))), used_at: null })
  }
  return { plain, stored }
}

function recoveryHash(item) {
  if (!item?.hash) return ''
  try {
    return decryptString(item.hash) || ''
  } catch {
    return ''
  }
}

/**
 * Starts enrollment: generates a secret and returns the data the authenticator
 * app needs. The secret stays unconfirmed until a valid code proves the app
 * actually holds it, so an abandoned setup never locks anyone out.
 */
export function beginTwoFactorSetup(username, { issuer = 'vm2api', account = '' } = {}) {
  const name = String(username || '').trim()
  if (!name) throw new TwoFactorError('缺少用户名', 'invalid_user')
  const repo = settings()
  const existing = loadRecord(name, repo)
  if (existing?.enabled && existing?.secret) {
    throw new TwoFactorError('两步验证已开启，请先关闭再重新绑定', 'totp_already_enabled', 409)
  }
  const secret = generateSecret()
  saveRecord(
    name,
    {
      enabled: false,
      secret: encryptString(secret),
      digits: DEFAULT_OPTIONS.digits,
      period: DEFAULT_OPTIONS.period,
      algorithm: DEFAULT_OPTIONS.algorithm,
      created_at: nowIso(),
      confirmed_at: null,
      last_counter: null,
      recovery: [],
    },
    repo,
  )
  return {
    secret,
    uri: buildOtpauthUri({ secret, issuer, account: account || name }),
    digits: DEFAULT_OPTIONS.digits,
    period: DEFAULT_OPTIONS.period,
    algorithm: DEFAULT_OPTIONS.algorithm,
  }
}

/**
 * Confirms enrollment with a code from the app and returns the one-time
 * recovery codes. They are shown exactly once; only hashes are kept.
 */
export function confirmTwoFactorSetup(username, code) {
  const name = String(username || '').trim()
  const repo = settings()
  const rec = loadRecord(name, repo)
  if (!rec?.secret) throw new TwoFactorError('请先获取绑定密钥', 'totp_setup_missing', 409)
  if (rec.enabled) throw new TwoFactorError('两步验证已开启', 'totp_already_enabled', 409)
  const secret = readSecret(rec)
  const counter = matchCounter(code, secret, new Date(), optionsOf(rec))
  if (counter === null) throw new TwoFactorError('验证码不正确', 'totp_invalid_code', 400)
  const { plain, stored } = mintRecoveryCodes()
  saveRecord(name, { ...rec, enabled: true, confirmed_at: nowIso(), last_counter: counter, recovery: stored }, repo)
  clearAttempts(name)
  return { recovery_codes: plain }
}

/** Turns 2FA off and drops the secret and recovery codes. */
export function disableTwoFactor(username) {
  const name = String(username || '').trim()
  const repo = settings()
  if (!loadRecord(name, repo)) return false
  repo.remove(twoFactorKey(name))
  clearAttempts(name)
  return true
}

/** Issues a fresh set of recovery codes, invalidating the previous ones. */
export function regenerateRecoveryCodes(username) {
  const name = String(username || '').trim()
  const repo = settings()
  const rec = loadRecord(name, repo)
  if (!rec?.enabled || !rec?.secret) throw new TwoFactorError('两步验证未开启', 'totp_not_enabled', 409)
  const { plain, stored } = mintRecoveryCodes()
  saveRecord(name, { ...rec, recovery: stored }, repo)
  return { recovery_codes: plain }
}

// ---------------------------------------------------------------------------
// Throttling: in-memory, per username. A restart clears it, which is fine —
// the window only has to outlast an online guessing burst.
// ---------------------------------------------------------------------------

const attempts = new Map()

function attemptKey(username) {
  return String(username || '')
    .trim()
    .toLowerCase()
}

export function clearAttempts(username) {
  attempts.delete(attemptKey(username))
}

function noteFailure(username) {
  const key = attemptKey(username)
  const now = Date.now()
  const entry = attempts.get(key)
  if (!entry || now - entry.first > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, first: now })
    return
  }
  entry.count += 1
}

function assertNotLocked(username) {
  const key = attemptKey(username)
  const entry = attempts.get(key)
  if (!entry) return
  const now = Date.now()
  if (now - entry.first > ATTEMPT_WINDOW_MS) {
    attempts.delete(key)
    return
  }
  if (entry.count >= MAX_ATTEMPTS) {
    const waitSec = Math.ceil((ATTEMPT_WINDOW_MS - (now - entry.first)) / 1000)
    throw new TwoFactorError(`验证码错误次数过多，请 ${waitSec} 秒后再试`, 'totp_too_many_attempts', 429)
  }
}

/**
 * Verifies a TOTP code or a recovery code for an account with 2FA enabled.
 *
 * A TOTP code is rejected if its time step was already used, so a code
 * captured in transit cannot be replayed inside the drift window. A recovery
 * code is marked used and never accepted again.
 *
 * @returns {{ ok: true, method: 'totp' | 'recovery', recovery_remaining?: number }}
 */
export function verifyTwoFactorCode(username, code) {
  const name = String(username || '').trim()
  const repo = settings()
  const rec = loadRecord(name, repo)
  if (!rec?.enabled || !rec?.secret) throw new TwoFactorError('两步验证未开启', 'totp_not_enabled', 409)
  assertNotLocked(name)

  const raw = String(code || '').trim()
  if (!raw) {
    noteFailure(name)
    throw new TwoFactorError('请输入验证码', 'totp_invalid_code', 400)
  }

  const secret = readSecret(rec)
  const counter = matchCounter(raw, secret, new Date(), optionsOf(rec))
  if (counter !== null) {
    if (rec.last_counter !== null && rec.last_counter !== undefined && counter <= rec.last_counter) {
      noteFailure(name)
      throw new TwoFactorError('该验证码已使用，请等待下一个验证码', 'totp_code_reused', 400)
    }
    saveRecord(name, { ...rec, last_counter: counter }, repo)
    clearAttempts(name)
    return { ok: true, method: 'totp' }
  }

  const normalized = normalizeRecoveryCode(raw)
  const wanted = normalized ? sha256(normalized) : ''
  const recovery = Array.isArray(rec.recovery) ? rec.recovery : []
  if (wanted) {
    const idx = recovery.findIndex((item) => {
      if (!item || item.used_at) return false
      const stored = recoveryHash(item)
      if (stored.length !== wanted.length) return false
      return crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(wanted))
    })
    if (idx >= 0) {
      const next = recovery.map((item, i) => (i === idx ? { ...item, used_at: nowIso() } : item))
      saveRecord(name, { ...rec, recovery: next }, repo)
      clearAttempts(name)
      return { ok: true, method: 'recovery', recovery_remaining: next.filter((item) => !item.used_at).length }
    }
  }

  noteFailure(name)
  throw new TwoFactorError('验证码不正确', 'totp_invalid_code', 400)
}

// ---------------------------------------------------------------------------
// Sign-in challenge
// ---------------------------------------------------------------------------

function challengeSecret() {
  const repo = settings()
  let secret = repo.get(CHALLENGE_SECRET_KEY, null)
  if (typeof secret !== 'string' || secret.length < 32) {
    secret = crypto.randomBytes(32).toString('hex')
    repo.set(CHALLENGE_SECRET_KEY, secret)
  }
  return secret
}

function sign(payload) {
  return crypto.createHmac('sha256', challengeSecret()).update(payload).digest('base64url')
}

/**
 * Mints the token returned by the password step. It only proves the password
 * was accepted: it grants nothing on its own and expires in five minutes.
 *
 * `claims` travels inside the signed payload so the code step can rebuild the
 * identity without the password. It is a fallback only — the code step still
 * re-reads the account, so a role change or a disable in between wins.
 */
export function issueTwoFactorChallenge(username, { ttlMs = CHALLENGE_TTL_MS, claims = {} } = {}) {
  const name = String(username || '').trim()
  if (!name) throw new TwoFactorError('缺少用户名', 'invalid_user')
  const expiresAt = Date.now() + ttlMs
  const payload = Buffer.from(
    JSON.stringify({ u: name, exp: expiresAt, n: crypto.randomBytes(8).toString('base64url'), c: claims }),
  ).toString('base64url')
  return { challenge: `${payload}.${sign(payload)}`, expires_in: Math.floor(ttlMs / 1000) }
}

/**
 * Validates a challenge and returns who it was minted for.
 *
 * @returns {{ username: string, claims: Record<string, unknown> }}
 */
export function consumeTwoFactorChallenge(challenge) {
  const text = String(challenge || '')
  const dot = text.lastIndexOf('.')
  if (dot <= 0) throw new TwoFactorError('验证会话无效，请重新登录', 'totp_challenge_invalid', 401)
  const payload = text.slice(0, dot)
  const provided = Buffer.from(text.slice(dot + 1))
  const expected = Buffer.from(sign(payload))
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new TwoFactorError('验证会话无效，请重新登录', 'totp_challenge_invalid', 401)
  }
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw new TwoFactorError('验证会话无效，请重新登录', 'totp_challenge_invalid', 401)
  }
  if (!parsed?.u || !Number.isFinite(parsed.exp)) {
    throw new TwoFactorError('验证会话无效，请重新登录', 'totp_challenge_invalid', 401)
  }
  if (Date.now() > parsed.exp) {
    throw new TwoFactorError('验证超时，请重新登录', 'totp_challenge_expired', 401)
  }
  return {
    username: String(parsed.u),
    claims: parsed.c && typeof parsed.c === 'object' ? parsed.c : {},
  }
}
