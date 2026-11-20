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
 * (`data` for redacted_thinking). The table lives outside the versioned
 * migrations so this local addition cannot take a migration number later.
 */
import crypto from 'node:crypto'
import { getDb } from '../db/database.mjs'
import { mapThinkingBlocks } from '../protocol/anthropic-policy.mjs'
import { mergeConsecutiveAnthropicMessages, messageHasTurnControls } from '../protocol/sanitize.mjs'

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
    db.exec(`CREATE TABLE IF NOT EXISTS thinking_signature_owners (
      key TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_thinking_owner_created ON thinking_signature_owners(created_at)')
    this.sql = {
      owners: db.prepare(
        'SELECT key, account_id FROM thinking_signature_owners WHERE key IN (SELECT value FROM json_each(?))',
      ),
      refresh: db.prepare(
        'UPDATE thinking_signature_owners SET created_at = ? WHERE key IN (SELECT value FROM json_each(?)) AND created_at < ?',
      ),
      insert: db.prepare(
        'INSERT OR IGNORE INTO thinking_signature_owners (key, account_id, created_at) VALUES (?, ?, ?)',
      ),
      purge: db.prepare('DELETE FROM thinking_signature_owners WHERE created_at < ?'),
    }
    this.boundDb = db
    return this.sql
  }

  /**
   * key → account for the keys that have a record; null when no database is
   * reachable, so the caller can leave history alone instead of guessing.
   */
  ownersOf(keys, now = Date.now()) {
    const sql = this.statements()
    if (!sql) return null
    const found = new Map()
    if (!keys.length) return found
    const list = JSON.stringify(keys)
    for (const row of sql.owners.all(list)) found.set(row.key, row.account_id)
    if (found.size) sql.refresh.run(now, list, now - REFRESH_AFTER_MS)
    return found
  }

  /** First writer wins: a signature belongs to the account that returned it. */
  record(keys, accountId, now = Date.now()) {
    const account = String(accountId || '')
    const sql = keys.length && account ? this.statements() : null
    if (!sql) return
    for (const key of keys) sql.insert.run(key, account, now)
    if (now - this.lastPurge >= PURGE_EVERY_MS) {
      this.lastPurge = now
      sql.purge.run(now - this.ttlMs)
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
export function filterThinkingForAccount(body, accountId, store = thinkingOwners) {
  const account = String(accountId || '')
  const counts = { kept: 0, converted: 0, dropped: 0, unknown: 0 }
  const keys = account ? historyKeys(body) : []
  if (!keys.length) return { body, ...counts }
  let owners = null
  try {
    owners = store.ownersOf([...new Set(keys)])
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
export function recordThinkingOwners(message, accountId, store = thinkingOwners) {
  const keys = []
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    const key = thinkingSignatureKey(block)
    if (key) keys.push(key)
  }
  try {
    store.record(keys, accountId)
  } catch {}
  return keys.length
}

function isThinkingBlock(block) {
  return block?.type === 'thinking' || block?.type === 'redacted_thinking'
}

function isPureToolResultTurn(message) {
  const content = Array.isArray(message?.content) ? message.content : null
  return !!content?.length && content.every((block) => block?.type === 'tool_result')
}

/**
 * CRAG print drops other accounts' thinking before the hop
 * (routing.compatibility.crag_drop_foreign_thinking, default off).
 *
 * CRAG print replays the caller body unfiltered and only strips after the
 * upstream answers "Invalid `signature` in `thinking` block". Every such 400
 * tells the upstream this account was handed another account's reasoning.
 * Recording covers every block this pool returns, so a signature with no
 * record (or another account's) never came from this slot's kernel and is
 * dropped before the hop instead. Off by default because an incomplete record
 * (a cleared table, sessions older than the record) drops the account's own
 * thinking and breaks the prompt cache.
 *
 * - Only signed blocks this account did not mint go; its own stay byte-identical.
 * - A turn left with no blocks is dropped (it has no tool_use to orphan) unless it
 *   carries turn controls (output_config / clear_at); neighbours it leaves behind
 *   with the same role are merged.
 * - If the open tool loop (after the last user turn that is not pure
 *   tool_result) loses a block, every thinking block in the loop goes and
 *   thinking is off for this hop: the shape signature repair already sends.
 * - A trailing assistant turn (prefill) carrying a foreign block is left alone.
 * - Without a reachable database the body goes unchanged.
 * @returns {{ body: object, kept: number, dropped: number, droppedTurns: number, openLoop: boolean, thinkingOff: boolean, bailed: string|null }}
 */
export function dropForeignThinkingForCrag(body, accountId, store = thinkingOwners) {
  const counts = { kept: 0, dropped: 0, droppedTurns: 0, openLoop: false, thinkingOff: false, bailed: null }
  const account = String(accountId || '')
  const messages = Array.isArray(body?.messages) ? body.messages : null
  if (!account || !messages?.length) return { body, ...counts }
  const keys = historyKeys(body)
  if (!keys.length) return { body, ...counts }
  let owners = null
  try {
    owners = store.ownersOf([...new Set(keys)])
  } catch {}
  if (!owners) return { body, ...counts, bailed: 'no_db' }

  let loopStart = 0
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user' && !isPureToolResultTurn(messages[i])) {
      loopStart = i + 1
      break
    }
  }
  let any = false
  const foreignAt = messages.map((message, i) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return null
    const foreign = new Set()
    message.content.forEach((block, j) => {
      const key = thinkingSignatureKey(block)
      if (!key) return
      if (owners.get(key) === account) {
        counts.kept += 1
        return
      }
      foreign.add(j)
      any = true
      if (i >= loopStart) counts.openLoop = true
    })
    return foreign
  })
  if (!any) return { body, ...counts }
  const last = messages.length - 1
  if (messages[last]?.role === 'assistant' && foreignAt[last]?.size) {
    return { body, ...counts, openLoop: false, bailed: 'prefill' }
  }

  const out = []
  messages.forEach((message, i) => {
    const foreign = foreignAt[i]
    if (!foreign) {
      out.push(message)
      return
    }
    const wipeLoop = counts.openLoop && i >= loopStart
    const content = message.content.filter((block, j) => !(wipeLoop ? isThinkingBlock(block) : foreign.has(j)))
    const removed = message.content.length - content.length
    if (!removed) {
      out.push(message)
      return
    }
    counts.dropped += removed
    if (!content.length && !messageHasTurnControls(message)) {
      counts.droppedTurns += 1
      return
    }
    out.push({ ...message, content })
  })
  // Dropping a whole turn can leave same-role neighbours; merge them (never across turn controls).
  const next = { ...body, messages: counts.droppedTurns ? mergeConsecutiveAnthropicMessages(out) : out }
  if (counts.openLoop) {
    if (next.thinking) {
      delete next.thinking
      counts.thinkingOff = true
    }
    if (Array.isArray(next.context_management?.edits)) {
      const edits = next.context_management.edits.filter((edit) => edit?.type !== 'clear_thinking_20251015')
      next.context_management = { ...next.context_management }
      if (edits.length) next.context_management.edits = edits
      else delete next.context_management.edits
    }
  }
  return { body: next, ...counts }
}
