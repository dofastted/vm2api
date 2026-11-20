/**
 * Optional at-rest encryption for credential fields in the DB
 * using the built-in `node:crypto` module.
 *
 * Enabled when VM2API_DB_SECRET (or KIN_DB_SECRET) is set: AES-256-GCM, key = SHA-256(secret).
 * Format: enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 * Without the secret, values are stored as-is (matching the previous
 * plaintext-file-with-0600 behavior).
 */

import crypto from 'node:crypto'

const PREFIX = 'enc:v1:'

function dbSecret() {
  return process.env.VM2API_DB_SECRET || process.env.KIN_DB_SECRET
}

export function encryptionEnabled() {
  return !!dbSecret()
}

function deriveKey(secret = dbSecret()) {
  return crypto.createHash('sha256').update(String(secret)).digest()
}

export function encryptString(plain, secret = dbSecret()) {
  if (plain == null) return null
  const key = deriveKey(secret)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')
}

export function decryptString(value, secret = dbSecret()) {
  if (value == null) return null
  const s = String(value)
  if (!s.startsWith(PREFIX)) return s
  const [ivB64, tagB64, ctB64] = s.slice(PREFIX.length).split(':')
  const key = deriveKey(secret)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const out = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()])
  return out.toString('utf8')
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

/** Encrypt when a secret is configured; otherwise return as-is. */
export function maybeEncrypt(plain) {
  if (plain == null) return null
  return encryptionEnabled() ? encryptString(plain) : String(plain)
}

/** Decrypt when the value carries the enc prefix; otherwise return as-is. */
export function maybeDecrypt(value) {
  if (value == null) return null
  return isEncrypted(value) ? decryptString(value) : String(value)
}
