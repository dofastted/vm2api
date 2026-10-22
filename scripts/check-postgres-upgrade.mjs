/** Read-only cutover check, executed from the new image before replacing the live container. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { openAuditDb } from './audit-db.mjs'

const dataDir = process.env.KIN_DATA_DIR || path.resolve('data')
let db
try {
  if (fs.existsSync(path.join(dataDir, 'restore-maintenance.json')))
    throw new Error('offline restore recovery required')
  db = await openAuditDb()
  const server = Number((await db.prepare('SHOW server_version_num').get()).server_version_num)
  if (server < 170000 || server >= 180000) throw new Error('PostgreSQL 17 required')
  const directory = fileURLToPath(new URL('../src/lib/db/postgres-migrations/', import.meta.url))
  const expected = fs
    .readdirSync(directory)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()
    .map((name) => ({
      version: name.split('_')[0],
      checksum: crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(directory, name), 'utf8').replaceAll('\r\n', '\n'))
        .digest('hex'),
    }))
  const applied = await db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all()
  if (
    !applied.length ||
    applied.length > expected.length ||
    applied.some((row, index) => row.version !== expected[index]?.version || row.checksum !== expected[index]?.checksum)
  ) {
    throw new Error('PostgreSQL migration history is missing, unknown or inconsistent')
  }
  if (fs.existsSync(path.join(dataDir, 'kin.db'))) {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'sqlite_import_done'").get()
    if (!row?.value || !JSON.parse(row.value).source_sha256) throw new Error('missing import marker')
  } else {
    await db.prepare('SELECT 1 AS ok').get()
  }
} catch {
  console.error(
    'PostgreSQL cutover check failed. Keep the current container and verify PostgreSQL 17, migration history, import marker or offline recovery; see docs/deploy/postgresql.md.',
  )
  process.exitCode = 1
} finally {
  await db?.close()
}
