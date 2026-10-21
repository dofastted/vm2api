import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { startGateway, api } from '../harness.mjs'
import { coordinationSchemaFor } from '../../src/lib/db/global-maintenance.mjs'
import { quoteIdentifier } from '../../src/lib/db/database.mjs'

async function fixture(t, scheduled = false) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-maintenance-backup-'))
  fs.mkdirSync(path.join(project, 'vms'))
  fs.writeFileSync(path.join(project, 'vms', 'active.json'), '{}')
  const gw = await startGateway({
    project,
    env: { VM2API_CONTROL_PLANE_MODE: 'kubernetes', ...(scheduled ? {} : { KIN_BACKUP_DISABLED: '1' }) },
  })
  const schema = coordinationSchemaFor(gw.schema)
  t.after(async () => {
    await gw.stop()
    const cleanup = new pg.Client({ connectionString: gw.connectionString })
    await cleanup.connect()
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`)
    } finally {
      await cleanup.end()
      fs.rmSync(project, { recursive: true, force: true })
    }
  })
  return { gw, q: quoteIdentifier(schema) }
}

test('Kubernetes manual backup transfers its HTTP activity to private maintenance history', async (t) => {
  const { gw, q } = await fixture(t)
  const response = await api(gw, 'POST', '/api/panel/backups')
  assert.equal(response.status, 201, response.text)
  const history = (await gw.db.pool.query(`SELECT kind, source_activity_id, ended_at FROM ${q}.operations`)).rows
  assert.equal(history.length, 1)
  assert.equal(history[0].kind, 'backup')
  assert.ok(history[0].source_activity_id)
  assert.ok(history[0].ended_at)
  assert.equal((await fetch(gw.baseUrl + '/readyz')).status, 200)
})

test('Kubernetes scheduled backup uses private claims and leaves no active business task in its snapshot', async (t) => {
  const { gw, q } = await fixture(t, true)
  let records = []
  let history = []
  for (let i = 0; i < 100; i++) {
    records = (await gw.db.pool.query("SELECT id FROM backup_records WHERE kind='scheduled' AND status='ok'")).rows
    if (records.length) {
      history = (await gw.db.pool.query(`SELECT ended_at FROM ${q}.operations WHERE task_key='scheduled-backup'`)).rows
      if (history.some((operation) => operation.ended_at)) break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(records.length, 1, gw.stderr())
  assert.equal(
    (await gw.db.pool.query("SELECT count(*) AS n FROM background_task_runs WHERE task_key='scheduled-backup'")).rows[0]
      .n,
    0,
  )
  assert.equal(history.length, 1)
  assert.ok(history[0].ended_at)
})

test('Kubernetes restore advances the durable epoch and rebinds before reopening requests', async (t) => {
  const { gw, q } = await fixture(t)
  const before = await api(gw, 'GET', '/api/panel/routing')
  assert.equal(before.status, 200, before.text)
  const backup = await api(gw, 'POST', '/api/panel/backups')
  assert.equal(backup.status, 201, backup.text)
  const id = backup.json.item.id
  const routingFile = path.join(gw.project, 'config', 'routing.json')
  const seed = JSON.parse(fs.readFileSync(routingFile, 'utf8'))
  seed.pool = { ...seed.pool, queue_max: 987 }
  const updatedSeed = JSON.stringify(seed, null, 2)
  fs.writeFileSync(routingFile, updatedSeed)
  assert.equal((await api(gw, 'PUT', '/api/panel/routing', { body: { pool: { queue_max: 23 } } })).status, 200)
  const restored = await api(gw, 'POST', `/api/panel/backups/${id}/restore`, { body: { confirm: true } })
  assert.equal(restored.status, 200, restored.text)
  const state = (await gw.db.pool.query(`SELECT phase, epoch FROM ${q}.control WHERE id=1`)).rows[0]
  assert.equal(state.phase, 'open')
  assert.equal(state.epoch, 2)
  assert.equal(
    (await gw.db.pool.query(`SELECT count(*) AS n FROM ${q}.members WHERE stopped_at IS NULL AND bound_epoch<>2`))
      .rows[0].n,
    0,
  )
  assert.ok((await gw.db.pool.query(`SELECT ended_at FROM ${q}.operations WHERE kind='restore'`)).rows[0].ended_at)
  assert.equal(fs.readFileSync(routingFile, 'utf8'), updatedSeed)
  const routing = await api(gw, 'GET', '/api/panel/routing')
  assert.equal(routing.status, 200, routing.text)
  assert.equal(routing.json.data.pool.queue_max, before.json.data.pool.queue_max)
  assert.equal((await fetch(gw.baseUrl + '/readyz')).status, 200)
})
