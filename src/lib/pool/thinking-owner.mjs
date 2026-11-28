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
import { DB_INSTANCE_ID, getDb, isDbOpen } from '../db/database.mjs'
import { enqueueWrite, writeBehindArmed } from '../db/write-behind.mjs'
import { getCacheRuntime } from '../cache/index.mjs'
import { mapThinkingBlocks } from '../protocol/anthropic-policy.mjs'
import { mergeConsecutiveAnthropicMessages, messageHasTurnControls } from '../protocol/sanitize.mjs'

const EDGE = 100
const MIN_SIGNATURE = 24
const TTL_MS = 30 * 24 * 60 * 60 * 1000
const PURGE_EVERY_MS = 60 * 60 * 1000
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000
const OWNER_CACHE_PREFIX = 'thinking:owner:'
const OWNER_CACHE_TTL_MS = 10 * 60 * 1000
const REFRESH_THROTTLE_MS = 60 * 1000
const BATCH_INSERT_CHUNK = 100

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
  constructor({ db = null, ttlMs = TTL_MS, writeBehind = null } = {}) {
    this.pinned = db
    this.ttlMs = ttlMs
    this._explicitWriteBehind = typeof writeBehind === 'boolean' ? writeBehind : null
    this.boundDb = null
    this.lastPurge = 0
    this._lastRefreshAt = new Map()
  }

  _isPrimaryDb(db) {
    return isDbOpen() && db === getDb()
  }

  _cacheKey(db, sigKey) {
    if (this._isPrimaryDb(db)) return `${OWNER_CACHE_PREFIX}${sigKey}`
    return `${OWNER_CACHE_PREFIX}iso:${db?.[DB_INSTANCE_ID] || 'isolated'}:${sigKey}`
  }

  _shouldWriteBehind(db) {
    if (this._explicitWriteBehind !== null) return this._explicitWriteBehind
    return writeBehindArmed() && this._isPrimaryDb(db)
  }

  _batchInsertSync(db, keys, account, now) {
    for (let i = 0; i < keys.length; i += BATCH_INSERT_CHUNK) {
      const chunk = keys.slice(i, i + BATCH_INSERT_CHUNK)
      if (chunk.length === 1) {
        this.sql.insert.run(chunk[0], account, now)
        continue
      }
      const placeholders = chunk.map(() => '(?, ?, ?)').join(', ')
      const params = []
      for (const k of chunk) params.push(k, account, now)
      db.prepare(
        `INSERT OR IGNORE INTO thinking_signature_owners (key, account_id, created_at) VALUES ${placeholders}`,
      ).run(...params)
    }
  }

  _scheduleRefresh(db, foundKeys, now) {
    if (!foundKeys.length) return
    const toRefresh = []
    for (const k of foundKeys) {
      const last = this._lastRefreshAt.get(k) || 0
      if (now - last >= REFRESH_THROTTLE_MS) {
        this._lastRefreshAt.set(k, now)
        toRefresh.push(k)
      }
    }
    if (this._lastRefreshAt.size > 8192) {
      this._lastRefreshAt.clear()
    }
    if (!toRefresh.length) return
    const list = JSON.stringify(toRefresh)
    const run = () => {
      try {
        this.sql?.refresh?.run(now, list, now - REFRESH_AFTER_MS)
      } catch {}
    }
    if (this._shouldWriteBehind(db)) {
      enqueueWrite(run)
    } else {
      run()
    }
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
    this._lastRefreshAt.clear()
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
    const unique = [...new Set((keys || []).filter(Boolean))]
    if (!unique.length) return found

    const db = this.boundDb
    const client = getCacheRuntime()?.client
    const useCache = Boolean(client?.enabled)
    const isPrimary = this._isPrimaryDb(db)
    const missing = []

    if (useCache) {
      for (const k of unique) {
        const hit = client.getL1(this._cacheKey(db, k))
        if (hit.hit && typeof hit.value === 'string' && hit.value) {
          found.set(k, hit.value)
        } else {
          missing.push(k)
        }
      }
    } else {
      missing.push(...unique)
    }

    if (missing.length) {
      const list = JSON.stringify(missing)
      for (const row of sql.owners.all(list)) {
        found.set(row.key, row.account_id)
        if (useCache) {
          const ck = this._cacheKey(db, row.key)
          client.setL1(ck, row.account_id, OWNER_CACHE_TTL_MS, 0, true)
          if (isPrimary && client.hasRedis) {
            client
              .set(ck, row.account_id, {
                ttlMs: OWNER_CACHE_TTL_MS,
                l1TtlMs: OWNER_CACHE_TTL_MS,
                jitter: true,
                prefixes: [OWNER_CACHE_PREFIX],
              })
              .catch(() => {})
          }
        }
      }
    }

    if (found.size) this._scheduleRefresh(db, [...found.keys()], now)
    return found
  }

  /**
   * Async L1 -> Redis L2 MGET -> DB backfill lookup for thinking signature owners.
   * Prewarms L1 so subsequent sync `filterThinkingForAccount` / `dropForeignThinkingForCrag`
   * calls resolve with 0 DB RPCs.
   */
  async ownersOfAsync(keys, now = Date.now()) {
    const sql = this.statements()
    if (!sql) return null
    const found = new Map()
    const unique = [...new Set((keys || []).filter(Boolean))]
    if (!unique.length) return found

    const db = this.boundDb
    const client = getCacheRuntime()?.client
    const useCache = Boolean(client?.enabled)
    const isPrimary = this._isPrimaryDb(db)
    const missingL1 = []

    if (useCache) {
      for (const k of unique) {
        const hit = client.getL1(this._cacheKey(db, k))
        if (hit.hit && typeof hit.value === 'string' && hit.value) {
          found.set(k, hit.value)
        } else {
          missingL1.push(k)
        }
      }
    } else {
      missingL1.push(...unique)
    }

    let missingDb = missingL1
    if (missingL1.length && useCache && isPrimary && client.hasRedis) {
      const l2Keys = missingL1.map((k) => this._cacheKey(db, k))
      const l2Vals = await client.mget(l2Keys, { prefixes: [OWNER_CACHE_PREFIX] })
      if (Array.isArray(l2Vals)) {
        missingDb = []
        for (let i = 0; i < missingL1.length; i += 1) {
          const val = l2Vals[i]
          if (typeof val === 'string' && val) {
            found.set(missingL1[i], val)
            client.setL1(l2Keys[i], val, OWNER_CACHE_TTL_MS, 0, true)
          } else {
            missingDb.push(missingL1[i])
          }
        }
      }
    }

    if (missingDb.length) {
      const list = JSON.stringify(missingDb)
      for (const row of sql.owners.all(list)) {
        found.set(row.key, row.account_id)
        if (useCache) {
          const ck = this._cacheKey(db, row.key)
          client.setL1(ck, row.account_id, OWNER_CACHE_TTL_MS, 0, true)
          if (isPrimary && client.hasRedis) {
            client
              .set(ck, row.account_id, {
                ttlMs: OWNER_CACHE_TTL_MS,
                l1TtlMs: OWNER_CACHE_TTL_MS,
                jitter: true,
                prefixes: [OWNER_CACHE_PREFIX],
              })
              .catch(() => {})
          }
        }
      }
    }

    if (found.size) this._scheduleRefresh(db, [...found.keys()], now)
    return found
  }

  /** First writer wins: a signature belongs to the account that returned it. */
  record(keys, accountId, now = Date.now()) {
    const account = String(accountId || '')
    const unique = [...new Set((keys || []).filter(Boolean))]
    const sql = unique.length && account ? this.statements() : null
    if (!sql) return

    const db = this.boundDb
    const client = getCacheRuntime()?.client
    const useCache = Boolean(client?.enabled)
    const isPrimary = this._isPrimaryDb(db)

    // Populate L1/L2 immediately (first-writer-wins: never overwrite an existing owner)
    if (useCache) {
      for (const key of unique) {
        const ck = this._cacheKey(db, key)
        if (!client.getL1(ck).hit) {
          client.setL1(ck, account, OWNER_CACHE_TTL_MS, 0, true)
          if (isPrimary && client.hasRedis) {
            client
              .set(ck, account, {
                ttlMs: OWNER_CACHE_TTL_MS,
                l1TtlMs: OWNER_CACHE_TTL_MS,
                jitter: true,
                prefixes: [OWNER_CACHE_PREFIX],
              })
              .catch(() => {})
          }
        }
      }
    }

    const doPurge = now - this.lastPurge >= PURGE_EVERY_MS
    if (doPurge) this.lastPurge = now

    const persist = () => {
      try {
        this._batchInsertSync(db, unique, account, now)
        if (doPurge) sql.purge.run(now - this.ttlMs)
      } catch {}
    }

    if (this._shouldWriteBehind(db)) {
      enqueueWrite(persist)
    } else {
      persist()
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
 * Lightweight single-query ownership probe for CRAG hops when
 * `crag_drop_foreign_thinking` is `'off'`. Never clones or rewrites `body`.
 * @returns {{ kept: number, foreign: number, unknown: number }}
 */
export function inspectForeignThinking(body, accountId, store = thinkingOwners) {
  const account = String(accountId || '')
  const counts = { kept: 0, foreign: 0, unknown: 0 }
  const keys = account ? historyKeys(body) : []
  if (!keys.length) return counts
  let owners = null
  try {
    owners = store.ownersOf([...new Set(keys)])
  } catch {}
  if (!owners) return { ...counts, kept: keys.length }
  for (const key of keys) {
    const owner = owners.get(key)
    if (owner === account) counts.kept += 1
    else {
      counts.foreign += 1
      if (owner == null) counts.unknown += 1
    }
  }
  return counts
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

/**
 * `routing.compatibility.crag_drop_foreign_thinking` → what to drop.
 *
 * Three states, with the two historical ones byte-compatible: `true` keeps
 * meaning "drop every block this account did not mint" and anything else that
 * is not the middle value (including `false` and a missing key) stays off.
 * @returns {'off'|'foreign_only'|'all'}
 */
export function cragForeignThinkingMode(value) {
  if (value === true) return 'all'
  if (value === 'foreign_only') return 'foreign_only'
  return 'off'
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
 * `mode` picks what counts as droppable:
 * - `'all'` (the `true` setting): every signed block this account did not mint,
 *   including signatures with no record at all. What an incomplete record
 *   mis-drops.
 * - `'foreign_only'`: only blocks recorded against a *different* account. An
 *   unrecorded signature stays, so a cleared table or a session older than the
 *   record no longer costs the caller its own thinking or its prompt cache,
 *   while a hop that really did inherit another account's reasoning is still
 *   fixed before the 400.
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
 * @returns {{ body: object, kept: number, unknownKept: number, dropped: number, droppedTurns: number, openLoop: boolean, thinkingOff: boolean, bailed: string|null }}
 */
export function dropForeignThinkingForCrag(body, accountId, store = thinkingOwners, { mode = 'all' } = {}) {
  const foreignOnly = mode === 'foreign_only'
  const counts = {
    kept: 0,
    unknownKept: 0,
    foreign: 0,
    dropped: 0,
    droppedTurns: 0,
    openLoop: false,
    thinkingOff: false,
    bailed: null,
  }
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
      const owner = owners.get(key)
      if (owner === account) {
        counts.kept += 1
        return
      }
      counts.foreign += 1
      // foreign_only: no record is not proof of another account. Keep it and
      // let the upstream 400 (plus the signature repair) handle the rare miss,
      // rather than dropping the caller's own thinking on an incomplete table.
      if (foreignOnly && owner == null) {
        counts.unknownKept += 1
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
