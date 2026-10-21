/** Offline, source-preserving SQLite -> PostgreSQL import. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync, backup } from 'node:sqlite'
import { applyMigrations as upgradeSqlite, createDatabase as createSqlite } from './sqlite-legacy.mjs'
import { withTransaction, quoteIdentifier as q } from './database.mjs'

const FLAG = 'sqlite_import_done'
const sqliteMigrations = new URL('./migrations/', import.meta.url)
function tables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name)
}
function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${q(table)})`).all()
}
function canonical(row, cols) {
  return JSON.stringify(
    cols.map((c) => {
      const v = row[c.name]
      if (v == null) return null
      if (/INT/i.test(c.type)) return String(v)
      if (v instanceof Uint8Array) return Buffer.from(v).toString('base64')
      return v
    }),
  )
}
function digestRows(rows, cols) {
  const hashes = []
  for (const row of rows) hashes.push(crypto.createHash('sha256').update(canonical(row, cols)).digest('hex'))
  hashes.sort()
  const digest = crypto.createHash('sha256')
  for (const hash of hashes) digest.update(hash)
  return { count: hashes.length, sha256: digest.digest('hex') }
}

export async function importSqlite({ source, db }) {
  if (!source || !db) throw new Error('source and PostgreSQL database required')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-sqlite-import-'))
  let original, snapshot, template
  try {
    original = new DatabaseSync(path.resolve(source), { readOnly: true })
    const file = path.join(tmp, 'snapshot.db')
    await backup(original, file)
    original.close()
    original = null
    fs.chmodSync(file, 0o600)
    const sourceHash = crypto.createHash('sha256')
    for await (const chunk of fs.createReadStream(file)) sourceHash.update(chunk)
    const sourceSha = sourceHash.digest('hex')
    snapshot = new DatabaseSync(file)
    if (!tables(snapshot).includes('schema_migrations'))
      throw new Error('source has no recognized SQLite migration history')
    const sourceVersions = snapshot.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all()
    const known = new Set(
      fs
        .readdirSync(sqliteMigrations)
        .filter((f) => /^\d+.*\.sql$/.test(f))
        .map((f) => f.split('_')[0]),
    )
    if (sourceVersions.some((r) => !known.has(r.version)))
      throw new Error('source contains an unknown SQLite migration')
    upgradeSqlite(snapshot)
    template = createSqlite({ dbPath: path.join(tmp, 'template.db') })
    template.exec(
      'CREATE TABLE thinking_signature_owners(key TEXT PRIMARY KEY,account_id TEXT NOT NULL,created_at INTEGER NOT NULL)',
    )
    const expected = tables(template).filter((t) => t !== 'schema_migrations')
    const actual = tables(snapshot).filter((t) => t !== 'schema_migrations')
    if (actual.some((t) => !expected.includes(t))) throw new Error('source contains an unmapped SQLite table')
    if (!actual.includes('thinking_signature_owners'))
      snapshot.exec(
        'CREATE TABLE thinking_signature_owners(key TEXT PRIMARY KEY,account_id TEXT NOT NULL,created_at INTEGER NOT NULL)',
      )
    const metadata = new Map(expected.map((t) => [t, columns(template, t)]))
    for (const table of expected) {
      const sourceCols = columns(snapshot, table).map((c) => c.name)
      if (JSON.stringify(sourceCols) !== JSON.stringify(metadata.get(table).map((c) => c.name)))
        throw new Error(`source schema mismatch for ${table}`)
    }
    const sequenceStatement = snapshot.prepare('SELECT name,seq FROM sqlite_sequence')
    sequenceStatement.setReadBigInts(true)
    const sequences = new Map(sequenceStatement.all().map((r) => [r.name, BigInt(r.seq)]))
    const report = await withTransaction(db, async () => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext(current_database()),hashtext($1))', [
        `vm2api:sqlite-import:${db.schema}`,
      ])
      await db.exec(`LOCK TABLE ${expected.map(q).join(',')} IN ACCESS EXCLUSIVE MODE`)
      for (const table of expected) {
        const count = (await db.prepare(`SELECT count(*) AS n FROM ${q(table)}`).get()).n
        if (table === 'groups') {
          const rows = await db.prepare('SELECT * FROM groups ORDER BY id').all()
          const seedCols = columns(template, 'groups')
          const seedRows = template.prepare('SELECT * FROM groups ORDER BY id').all()
          const seedNames = seedCols.filter((c) => !['created_at', 'updated_at'].includes(c.name))
          if (digestRows(rows, seedNames).sha256 !== digestRows(seedRows, seedNames).sha256)
            throw new Error('target groups are not the unchanged baseline seeds')
        } else if (Number(count) !== 0) throw new Error(`target is not empty (${table})`)
      }
      await db.exec('DELETE FROM groups')
      const results = {}
      // All baseline FKs are deferred, including self-referencing jump nodes.
      for (const table of expected) {
        const cols = metadata.get(table)
        const statement = snapshot.prepare(`SELECT * FROM ${q(table)}`)
        statement.setReadBigInts(true)
        let batch = []
        const sourceHashes = []
        const flush = async () => {
          if (!batch.length) return
          const params = []
          const values = batch.map(
            (row) =>
              '(' +
              cols
                .map((c) => {
                  const value = row[c.name]
                  params.push(
                    typeof value === 'bigint'
                      ? value.toString()
                      : value instanceof Uint8Array
                        ? Buffer.from(value)
                        : value,
                  )
                  return '$' + params.length
                })
                .join(',') +
              ')',
          )
          await db.query(
            `INSERT INTO ${q(table)} (${cols.map((c) => q(c.name)).join(',')}) VALUES ${values.join(',')}`,
            params,
          )
          batch = []
        }
        for (const row of statement.iterate()) {
          sourceHashes.push(crypto.createHash('sha256').update(canonical(row, cols)).digest('hex'))
          batch.push(row)
          if (batch.length >= 100) await flush()
        }
        await flush()
        const sourceDigest = crypto.createHash('sha256')
        for (const hash of sourceHashes.sort()) sourceDigest.update(hash)
        const before = { count: sourceHashes.length, sha256: sourceDigest.digest('hex') }
        sourceHashes.length = 0
        const targetHashes = []
        await db.exec(`DECLARE import_validation NO SCROLL CURSOR FOR SELECT * FROM ${q(table)}`)
        try {
          for (;;) {
            const batch = await db.prepare('FETCH FORWARD 100 FROM import_validation').all()
            if (!batch.length) break
            for (const row of batch)
              targetHashes.push(crypto.createHash('sha256').update(canonical(row, cols)).digest('hex'))
          }
        } finally {
          await db.exec('CLOSE import_validation')
        }
        const targetDigest = crypto.createHash('sha256')
        for (const hash of targetHashes.sort()) targetDigest.update(hash)
        const after = { count: targetHashes.length, sha256: targetDigest.digest('hex') }
        if (before.count !== after.count || before.sha256 !== after.sha256)
          throw new Error(`import validation failed for ${table}`)
        results[table] = before
        for (const col of cols) {
          const seq = await db
            .prepare(
              `SELECT c.relname,n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=pg_get_serial_sequence($1,$2)::regclass`,
            )
            .get(`${q(db.schema)}.${q(table)}`, col.name)
          if (!seq) continue
          const maximum = await db.prepare(`SELECT max(${q(col.name)}) AS n FROM ${q(table)}`).get()
          const high = [sequences.get(table) || 0n, BigInt(maximum.n || 0)].reduce((a, b) => (a > b ? a : b))
          await db.exec(`ALTER SEQUENCE ${q(seq.nspname)}.${q(seq.relname)} RESTART WITH ${high + 1n}`)
        }
      }
      const manifest = {
        at: new Date().toISOString(),
        source_sha256: sourceSha,
        source_versions: sourceVersions,
        tables: results,
      }
      await db
        .prepare('INSERT INTO settings(key,value,updated_at) VALUES($1,$2,$3)')
        .run(FLAG, JSON.stringify(manifest), manifest.at)
      return manifest
    })
    return report
  } finally {
    original?.close()
    snapshot?.close()
    template?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
