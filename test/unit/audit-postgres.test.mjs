import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '../../src/lib/db/database.mjs'
const exec = promisify(execFile)

test('audit commands execute PostgreSQL aggregates using a read-only connection', async () => {
  const db = getDb()
  for (const [script, args] of [
    ['audit-billing-gaps.mjs', []],
    ['audit-billing-openai.mjs', []],
    ['audit-fable-week.mjs', []],
    ['audit-billing-contract.mjs', ['--database', '--json']],
  ]) {
    const { stdout } = await exec(process.execPath, [`scripts/${script}`, ...args], {
      env: { ...process.env, VM2API_DATABASE_URL: db.connectionString, VM2API_DATABASE_SCHEMA: db.schema },
    })
    const report = JSON.parse(stdout)
    assert.equal(typeof report, 'object', script)
    if (script === 'audit-billing-gaps.mjs') assert.equal(typeof report.totals.n, 'number')
    if (script === 'audit-billing-contract.mjs') assert.equal(typeof report.db.totals.n, 'number')
    assert.equal(stdout.includes('postgresql://'), false, script)
  }
})

async function preflight() {
  const db = getDb()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-upgrade-preflight-'))
  try {
    return await exec(process.execPath, ['scripts/check-postgres-upgrade.mjs'], {
      env: {
        ...process.env,
        KIN_DATA_DIR: directory,
        VM2API_DATABASE_URL: db.connectionString,
        VM2API_DATABASE_SCHEMA: db.schema,
      },
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('upgrade preflight reads valid source checksums without modifying migration history', async () => {
  const before = await getDb().prepare('SELECT * FROM schema_migrations ORDER BY version').all()
  await preflight()
  assert.deepEqual(await getDb().prepare('SELECT * FROM schema_migrations ORDER BY version').all(), before)
})

test('upgrade preflight refuses an applied checksum mismatch without repairing it', async () => {
  const row = await getDb().prepare('SELECT version FROM schema_migrations ORDER BY version LIMIT 1').get()
  await getDb()
    .prepare('UPDATE schema_migrations SET checksum = $1 WHERE version = $2')
    .run('synthetic-mismatch', row.version)
  await assert.rejects(preflight(), (error) => error.code === 1 && /preflight|cutover/i.test(error.stderr))
  assert.equal(
    (await getDb().prepare('SELECT checksum FROM schema_migrations WHERE version = $1').get(row.version)).checksum,
    'synthetic-mismatch',
  )
})

test('upgrade preflight refuses unknown migrations and an empty history', async () => {
  await getDb()
    .prepare('INSERT INTO schema_migrations (version,name,checksum,applied_at) VALUES ($1,$2,$3,$4)')
    .run('999-unknown', 'unknown', 'unknown', new Date().toISOString())
  await assert.rejects(preflight(), (error) => error.code === 1)
  await getDb().exec('DELETE FROM schema_migrations')
  await assert.rejects(preflight(), (error) => error.code === 1)
})

test('upgrade preflight refuses missing migration history and persisted restore maintenance', async () => {
  await getDb().exec('DROP TABLE schema_migrations')
  await assert.rejects(preflight(), (error) => error.code === 1)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-preflight-marker-'))
  try {
    fs.writeFileSync(path.join(directory, 'restore-maintenance.json'), '{}')
    await assert.rejects(
      exec(process.execPath, ['scripts/check-postgres-upgrade.mjs'], {
        env: { ...process.env, KIN_DATA_DIR: directory },
      }),
      (error) => error.code === 1,
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
