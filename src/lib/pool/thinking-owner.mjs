/**
 * Which account signed each thinking block.
 *
 * A thinking block's signature only verifies on the account that produced
 * it; replayed to another account it is a 400. Every Claude response records
 * its thinking blocks under the account that served it. Before a hop goes
 * out, only the hop account's own blocks stay thinking. Any other block —
 * signed by another account, or with no record at all — goes as a plain text
 * block with its thinking text, and is dropped when that text is empty.
 *
 * Key: sha256 of the signature's length, first 100 and last 100 characters
 * (`data` for redacted_thinking). The table is created by the PostgreSQL baseline migration.
 */
import crypto from 'node:crypto'
import { getDb } from '../db/database.mjs'
import { mapThinkingBlocks } from '../protocol/anthropic-policy.mjs'

const EDGE = 100
const MIN_SIGNATURE = 24
const TTL_MS = 30 * 24 * 60 * 60 * 1000
const PURGE_EVERY_MS = 60 * 60 * 1000
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

/** Stable key for one signed thinking block, or null when it carries no usable signature. */
export function thinkingSignatureKey(block) {
  const raw = block?.type === 'thinking' ? block.signature : block?.type === 'redacted_thinking' ? block.data : null
  const signature = String(raw || '').trim()
  if (signature.length < MIN_SIGNATURE) return null
  const material = signature.length <= EDGE * 2 ? signature : signature.slice(0, EDGE) + signature.slice(-EDGE)
  return crypto.createHash('sha256').update(`${signature.length}:${material}`).digest('hex').slice(0, 32)
}

export class ThinkingOwnerStore {
  /** `db` pins a connection (tests); otherwise the process database, re-read so a restore rebinds. */
  constructor({ db = null, ttlMs = TTL_MS } = {}) {
    this.pinned = db
    this.ttlMs = ttlMs
    this.boundDb = null
    this.lastPurge = 0
  }

  statements() {
    let db
    try {
      db = this.pinned || getDb()
    } catch {
      return null
    }
    if (this.boundDb === db) return this.sql
    this.sql = {
      owners: db.prepare('SELECT key, account_id FROM thinking_signature_owners WHERE key  = ANY($1::text[])'),
      refresh: db.prepare(
        'UPDATE thinking_signature_owners SET created_at = $1 WHERE key = ANY($2::text[]) AND created_at < $3',
      ),
      insert: db.prepare(
        'INSERT INTO thinking_signature_owners (key, account_id, created_at) VALUES ($1, $2, $3) ON CONFLICT(key) DO NOTHING',
      ),
      purge: db.prepare('DELETE FROM thinking_signature_owners WHERE created_at < $1'),
    }
    this.boundDb = db
    return this.sql
  }

  /**
   * key → account for the keys that have a record; null when no database is
   * reachable, so the caller can leave history alone instead of guessing.
   */
  async ownersOf(keys, now = Date.now()) {
    const sql = this.statements()
    if (!sql) return null
    const found = new Map()
    if (!keys.length) return found
    const list = keys
    for (const row of await sql.owners.all(list)) found.set(row.key, row.account_id)
    if (found.size) await sql.refresh.run(now, list, now - REFRESH_AFTER_MS)
    return found
  }

  /** First writer wins: a signature belongs to the account that returned it. */
  async record(keys, accountId, now = Date.now()) {
    const account = String(accountId || '')
    const sql = keys.length && account ? this.statements() : null
    if (!sql) return
    for (const key of keys) await sql.insert.run(key, account, now)
    if (now - this.lastPurge >= PURGE_EVERY_MS) {
      this.lastPurge = now
      await sql.purge.run(now - this.ttlMs)
    }
  }
}

export const thinkingOwners = new ThinkingOwnerStore()

function historyKeys(body) {
  const keys = []
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      const key = thinkingSignatureKey(block)
      if (key) keys.push(key)
    }
  }
  return keys
}

/**
 * The body this account may replay: its own thinking stays, every other
 * signed block becomes text (dropped when empty). Without a reachable
 * database the body goes unchanged.
 * @returns {{ body: object, kept: number, converted: number, dropped: number, unknown: number }}
 */
export async function filterThinkingForAccount(body, accountId, store = thinkingOwners) {
  const account = String(accountId || '')
  const counts = { kept: 0, converted: 0, dropped: 0, unknown: 0 }
  const keys = account ? historyKeys(body) : []
  if (!keys.length) return { body, ...counts }
  let owners = null
  try {
    owners = await store.ownersOf([...new Set(keys)])
  } catch {}
  if (!owners) return { body, ...counts, kept: keys.length }
  const out = mapThinkingBlocks(body, (block, message) => {
    const key = message?.role === 'assistant' ? thinkingSignatureKey(block) : null
    // Unsigned blocks are stripInvalidThinkingBlocks' call.
    if (!key) return block
    const owner = owners.get(key)
    if (owner === account) {
      counts.kept += 1
      return block
    }
    if (owner == null) counts.unknown += 1
    const text = block.type === 'thinking' ? String(block.thinking || '') : ''
    if (text.trim()) {
      counts.converted += 1
      return { type: 'text', text }
    }
    counts.dropped += 1
    return null
  })
  return { body: out.body, ...counts }
}

/** Bind the thinking blocks of a served response to the account that produced them. */
export async function recordThinkingOwners(message, accountId, store = thinkingOwners) {
  const keys = []
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    const key = thinkingSignatureKey(block)
    if (key) keys.push(key)
  }
  try {
    await store.record(keys, accountId)
  } catch {}
  return keys.length
}
