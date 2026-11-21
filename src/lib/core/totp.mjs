/**
 * RFC 4226 (HOTP) and RFC 6238 (TOTP) on top of `node:crypto`, no dependencies.
 *
 * Codes derive purely from the shared secret and the local clock — there is no
 * network I/O — so this is equivalent to what an authenticator app computes.
 * Ported from the Go implementation in mail2api (`internal/totp`).
 */

import crypto from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 6238 defaults, as used by Google Authenticator, Microsoft and QQ. */
export const DEFAULT_OPTIONS = Object.freeze({
  digits: 6,
  period: 30,
  algorithm: 'SHA1',
  // Adjacent time steps accepted on either side of the current one, which
  // compensates for clock drift between the server and the phone.
  skew: 1,
})

const ALGORITHMS = new Map([
  ['SHA1', 'sha1'],
  ['SHA256', 'sha256'],
  ['SHA512', 'sha512'],
])

export class TotpError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'TotpError'
    this.code = code
  }
}

const invalidSecret = (detail) =>
  new TotpError(detail ? `invalid base32 secret: ${detail}` : 'invalid base32 secret', 'invalid_secret')

/** Maps an otpauth `algorithm` label to a node digest name. */
export function parseAlgorithm(value) {
  const name = String(value ?? '')
    .trim()
    .toUpperCase()
  if (name === '') return 'SHA1'
  if (!ALGORITHMS.has(name)) throw new TotpError(`unsupported algorithm ${JSON.stringify(value)}`, 'invalid_algorithm')
  return name
}

function normalizeOptions(opts = {}) {
  const digits = opts.digits ?? DEFAULT_OPTIONS.digits
  const period = opts.period ?? DEFAULT_OPTIONS.period
  if (!Number.isInteger(digits) || digits < 1 || digits > 10) {
    throw new TotpError('digits must be an integer between 1 and 10', 'invalid_digits')
  }
  if (!Number.isInteger(period) || period < 1) {
    throw new TotpError('period must be a positive integer', 'invalid_period')
  }
  const skew = opts.skew ?? DEFAULT_OPTIONS.skew
  if (!Number.isInteger(skew) || skew < 0) {
    throw new TotpError('skew must be a non-negative integer', 'invalid_skew')
  }
  return { digits, period, algorithm: parseAlgorithm(opts.algorithm), skew }
}

/**
 * Strips whitespace, dashes and padding from a base32 secret and upper-cases
 * it, which is how secrets are commonly transcribed by hand.
 */
export function normalizeSecret(secret) {
  let out = ''
  for (const ch of String(secret ?? '')) {
    if (ch === ' ' || ch === '-' || ch === '=' || ch === '\t' || ch === '\r' || ch === '\n') continue
    out += ch >= 'a' && ch <= 'z' ? ch.toUpperCase() : ch
  }
  return out
}

/** Decodes a (possibly unpadded, lower-case or spaced) base32 secret to bytes. */
export function decodeSecret(secret) {
  const norm = normalizeSecret(secret)
  if (norm === '') throw invalidSecret()
  const bytes = []
  let bits = 0
  let value = 0
  for (const ch of norm) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx < 0) throw invalidSecret(`illegal character ${JSON.stringify(ch)}`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >>> bits) & 0xff)
    }
  }
  // Leftover bits must be zero padding; anything else is a truncated secret.
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) throw invalidSecret('non-zero padding bits')
  if (bytes.length === 0) throw invalidSecret('decodes to an empty key')
  return Buffer.from(bytes)
}

/** Encodes raw key bytes as an unpadded base32 secret. */
export function encodeSecret(key) {
  const buf = Buffer.from(key)
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f]
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f]
  return out
}

/** Generates a fresh random base32 secret (160 bits by default, per RFC 4226). */
export function generateSecret(bytes = 20) {
  return encodeSecret(crypto.randomBytes(bytes))
}

/** Computes an RFC 4226 code for the given key and counter. */
export function hotp(key, counter, digits = DEFAULT_OPTIONS.digits, algorithm = DEFAULT_OPTIONS.algorithm) {
  if (!Number.isInteger(digits) || digits < 1 || digits > 10) {
    throw new TotpError('digits must be an integer between 1 and 10', 'invalid_digits')
  }
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const sum = crypto
    .createHmac(ALGORITHMS.get(parseAlgorithm(algorithm)), Buffer.from(key))
    .update(msg)
    .digest()

  // Dynamic truncation (RFC 4226 §5.4).
  const offset = sum[sum.length - 1] & 0x0f
  const bin =
    (((sum[offset] & 0x7f) << 24) |
      ((sum[offset + 1] & 0xff) << 16) |
      ((sum[offset + 2] & 0xff) << 8) |
      (sum[offset + 3] & 0xff)) >>>
    0
  return String(bin % 10 ** digits).padStart(digits, '0')
}

/** Returns the RFC 6238 time step for `at` under the given period. */
export function counterFor(at = new Date(), period = DEFAULT_OPTIONS.period) {
  const seconds = Math.floor((at instanceof Date ? at.getTime() : Number(at)) / 1000)
  return Math.floor(seconds / (period || DEFAULT_OPTIONS.period))
}

/** Returns the code for `secret` at time `at`. */
export function generateCode(secret, at = new Date(), opts = {}) {
  const o = normalizeOptions(opts)
  return hotp(decodeSecret(secret), counterFor(at, o.period), o.digits, o.algorithm)
}

function constantTimeEquals(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/**
 * Returns the time step the code matches, or `null` when it matches none.
 *
 * The caller persists the returned counter so the same code cannot be replayed
 * while it is still inside the drift window.
 */
export function matchCounter(code, secret, at = new Date(), opts = {}) {
  const o = normalizeOptions(opts)
  const key = decodeSecret(secret)
  const trimmed = String(code ?? '').trim()
  if (trimmed.length !== o.digits) return null
  const center = counterFor(at, o.period)
  for (let delta = -o.skew; delta <= o.skew; delta += 1) {
    const counter = center + delta
    if (counter < 0) continue
    if (constantTimeEquals(hotp(key, counter, o.digits, o.algorithm), trimmed)) return counter
  }
  return null
}

/** Reports whether `code` is valid for `secret` at `at`, allowing for drift. */
export function validate(code, secret, at = new Date(), opts = {}) {
  return matchCounter(code, secret, at, opts) !== null
}

/** Milliseconds for which the code valid at `at` stays valid. */
export function timeRemaining(at = new Date(), period = DEFAULT_OPTIONS.period) {
  const p = period || DEFAULT_OPTIONS.period
  const seconds = Math.floor((at instanceof Date ? at.getTime() : Number(at)) / 1000)
  return (p - (seconds % p)) * 1000
}

/**
 * Parses either a bare base32 secret or an `otpauth://totp/...` URI.
 *
 * @returns {{ secret: string, issuer: string, account: string, options: { digits: number, period: number, algorithm: string, skew: number } }}
 */
export function parseKey(raw) {
  const text = String(raw ?? '').trim()
  if (!text.toLowerCase().startsWith('otpauth://')) {
    decodeSecret(text)
    return { secret: normalizeSecret(text), issuer: '', account: '', options: { ...DEFAULT_OPTIONS } }
  }
  let url
  try {
    url = new URL(text)
  } catch {
    // The URL error repeats the whole URI, secret included: never surface it.
    throw new TotpError('the otpauth URI cannot be parsed', 'invalid_uri')
  }
  if (url.host.toLowerCase() !== 'totp') {
    throw new TotpError(`unsupported otpauth type ${JSON.stringify(url.host)}`, 'invalid_uri')
  }
  const secret = normalizeSecret(url.searchParams.get('secret') || '')
  decodeSecret(secret)

  const label = decodeURIComponent(url.pathname.replace(/^\//, ''))
  const sep = label.indexOf(':')
  let issuer = sep >= 0 ? label.slice(0, sep) : ''
  const account = sep >= 0 ? label.slice(sep + 1) : label
  if (url.searchParams.get('issuer')) issuer = url.searchParams.get('issuer')

  const options = { ...DEFAULT_OPTIONS }
  const digits = url.searchParams.get('digits')
  if (digits) {
    const n = Number(digits)
    if (!Number.isInteger(n) || n < 1 || n > 10)
      throw new TotpError('digits must be between 1 and 10', 'invalid_digits')
    options.digits = n
  }
  const period = url.searchParams.get('period')
  if (period) {
    const n = Number(period)
    if (!Number.isInteger(n) || n < 1) throw new TotpError(`invalid period ${JSON.stringify(period)}`, 'invalid_period')
    options.period = n
  }
  const algorithm = url.searchParams.get('algorithm')
  if (algorithm) options.algorithm = parseAlgorithm(algorithm)
  return { secret, issuer, account, options }
}

/** Builds the `otpauth://totp/...` URI an authenticator app scans. */
export function buildOtpauthUri({ secret, issuer = '', account = '', ...opts } = {}) {
  const o = normalizeOptions(opts)
  const normalized = normalizeSecret(secret)
  decodeSecret(normalized)
  const label = issuer ? `${issuer}:${account}` : account
  const params = new URLSearchParams({ secret: normalized })
  if (issuer) params.set('issuer', issuer)
  params.set('algorithm', o.algorithm)
  params.set('digits', String(o.digits))
  params.set('period', String(o.period))
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`
}
