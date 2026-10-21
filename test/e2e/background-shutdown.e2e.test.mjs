import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { startGateway } from '../harness.mjs'
import { coordinationSchemaFor } from '../../src/lib/db/global-maintenance.mjs'
import { quoteIdentifier } from '../../src/lib/db/database.mjs'

async function fixture(t, graceMs = 3000) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-background-shutdown-'))
  fs.mkdirSync(path.join(project, 'vms'))
  fs.writeFileSync(path.join(project, 'vms', 'active.json'), '{}')
  const preload = fileURLToPath(new URL('../fixtures/background-shutdown.mjs', import.meta.url))
  const gw = await startGateway({
    project,
    env: {
      VM2API_CONTROL_PLANE_MODE: 'kubernetes',
      KIN_BACKUP_DISABLED: '1',
      VM2API_SHUTDOWN_TIMEOUT_MS: String(graceMs),
      VM2API_SYNTHETIC_BACKGROUND_DIRECTORY: project,
      NODE_OPTIONS: `--import=${preload}`,
    },
  })
  t.after(async () => {
    fs.writeFileSync(path.join(project, 'release'), '1')
    await gw.stop()
    const client = new pg.Client({ connectionString: gw.connectionString })
    await client.connect()
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(coordinationSchemaFor(gw.schema))} CASCADE`)
    } finally {
      await client.end()
      fs.rmSync(project, { recursive: true, force: true })
    }
  })
  const deadline = Date.now() + 3000
  while (!fs.existsSync(path.join(project, 'started')) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(fs.existsSync(path.join(project, 'started')), gw.stderr())
  return gw
}

const exitOf = (child) =>
  child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise((resolve) => child.once('exit', resolve))

test('shutdown awaits a global shared background callback and its committed terminal state', async (t) => {
  const gw = await fixture(t)
  const exit = exitOf(gw.child)
  gw.child.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(gw.child.exitCode, null, gw.stderr())
  fs.writeFileSync(path.join(gw.project, 'release'), '1')
  assert.equal(await exit, 0, gw.stderr())
  assert.ok(
    (await gw.db.query("SELECT finished_at FROM background_task_runs WHERE task_key='synthetic-shutdown-background'"))
      .rows[0].finished_at,
  )
  assert.equal(
    (await gw.db.query("SELECT value FROM settings WHERE key='synthetic-background-ended'")).rows[0].value,
    'true',
  )
})

test('an unfinished global background callback remains claimed when the shutdown deadline expires', async (t) => {
  const gw = await fixture(t, 100)
  const exit = exitOf(gw.child)
  const started = Date.now()
  gw.child.kill('SIGTERM')
  assert.equal(await exit, 1, gw.stderr())
  assert.ok(Date.now() - started < 6500)
  const row = (
    await gw.db.query("SELECT finished_at FROM background_task_runs WHERE task_key='synthetic-shutdown-background'")
  ).rows[0]
  assert.equal(row.finished_at, null)
})
