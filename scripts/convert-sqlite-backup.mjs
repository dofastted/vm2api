import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { createDatabase } from '../src/lib/db/database.mjs'
import { importSqlite } from '../src/lib/db/sqlite-import.mjs'
import { materializeSqliteBackup } from '../src/lib/db/sqlite-backup.mjs'
import { runBackupJob } from '../src/lib/admin/backup-core.mjs'
const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    output: { type: 'string' },
    'vm-dir': { type: 'string' },
    'config-dir': { type: 'string' },
  },
})
if (!values.source || !values.output)
  throw new Error(
    'usage: npm run db:convert:sqlite-backup -- --source <old.tar.gz|old.db.gz> --output <new.tar.gz>; target PostgreSQL must be empty',
  )
const output = path.resolve(values.output)
if (fs.existsSync(output)) throw new Error('output already exists')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-convert-backup-'))
let db, client
try {
  const source = await materializeSqliteBackup(path.resolve(values.source), tmp)
  for (const [option, folder] of [
    ['vm-dir', 'vms'],
    ['config-dir', 'config'],
  ]) {
    const destination = path.join(tmp, folder)
    if (values[option]) {
      const directory = path.resolve(values[option])
      if (!fs.statSync(directory).isDirectory()) throw new Error(`${option} must be a directory`)
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name)
        if (!name.endsWith('.json') || !fs.lstatSync(file).isFile()) continue
        fs.copyFileSync(file, path.join(destination, name))
        fs.chmodSync(path.join(destination, name), 0o600)
      }
    }
    if (!fs.existsSync(destination)) throw new Error(`legacy backup requires --${option} to restore companion files`)
  }
  const legacy = new DatabaseSync(source, { readOnly: true })
  try {
    for (const { id } of legacy.prepare('SELECT id FROM vms').all()) {
      if (typeof id !== 'string' || path.basename(id) !== id || !fs.existsSync(path.join(tmp, 'vms', id + '.json')))
        throw new Error('companion VM files do not cover the SQLite VM records')
    }
  } finally {
    legacy.close()
  }
  db = await createDatabase({ allowLegacySource: true })
  await importSqlite({ source, db })
  client = await db.pool.connect()
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const snapshot = (await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id
  const schemaVersion = (await db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get())
    .version
  const record = await runBackupJob(
    {
      connectionString: db.connectionString,
      schema: db.schema,
      schemaVersion,
      snapshot,
      backupDir: path.dirname(output),
      tmpDir: tmp,
      projectRoot: tmp,
      configDir: path.join(tmp, 'config'),
    },
    {
      id: 'converted_' + crypto.randomBytes(6).toString('hex'),
      createdAt: new Date().toISOString(),
      kind: 'converted',
    },
  )
  if (record.file_path !== output) {
    fs.linkSync(record.file_path, output)
    fs.unlinkSync(record.file_path)
  }
  await client.query('COMMIT')
  console.log(JSON.stringify({ ok: true, output, sha256: record.sha256, includes: record.includes }))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  if (client) {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
  if (db) await db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}
