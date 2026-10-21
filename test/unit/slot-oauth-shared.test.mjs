import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { getDb, registerActivityCoordinator, quoteIdentifier } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator } from '../../src/lib/db/global-maintenance.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { readWorkerCredentialFile, writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'
import { runSlotOauth } from '../../src/lib/transport/slot-oauth.mjs'

async function fixture(t) {
  const db = getDb()
  const coordinator = new GlobalMaintenanceCoordinator(db)
  await coordinator.start()
  registerActivityCoordinator(db, coordinator)
  const bootstrap = await coordinator.admitBootstrap()
  await coordinator.acknowledgeEpoch(bootstrap.epoch)
  await bootstrap.complete({ ended: true })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shared-slot-refresh-'))
  const homeDir = path.join(root, 'vms', 'vm-01', 'cli-home')
  writeWorkerCredentialFile(homeDir, {
    type: 'oauth', access_token: 'SYNTHETIC_AT', refresh_token: 'SYNTHETIC_RT', expires_at: 1,
    account_uuid: 'slot-refresh-account',
  })
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  t.after(async () => {
    if (previous == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
    await coordinator.stop()
    const client = new pg.Client({ connectionString: db.connectionString })
    await client.connect()
    try { await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(coordinator.schema)} CASCADE`) }
    finally { await client.end(); fs.rmSync(root, { recursive: true, force: true }) }
  })
  const run = (callback) => coordinator.runActivity({ kind: 'fixture' }, async () => ({ ended: true, value: await callback() }))
  return { db, coordinator, homeDir, exec: { vmId: 'vm-01', homeDir, vm: {} }, run }
}

test('the actual slot OAuth refresh shares a committed attempt after bootstrap has closed', async (t) => {
  const f = await fixture(t)
  let calls = 0
  const runDocker = async () => {
    calls++
    await new Promise((resolve) => setTimeout(resolve, 30))
    writeWorkerCredentialFile(f.homeDir, {
      ...readWorkerCredentialFile(f.homeDir), access_token: 'SYNTHETIC_NEW_AT', refresh_token: 'SYNTHETIC_NEW_RT',
    })
    return { code: 0, stdout: '{"ok":true,"status":200,"body":{"refreshed":true}}' }
  }
  const results = await Promise.all([runSlotOauth(f.exec, 'refresh', { runDocker }), runSlotOauth(f.exec, 'refresh', { runDocker })])
  assert.equal(calls, 1)
  assert.ok(results.every((result) => result.ok))
  const rows = await f.run(() => f.db.query('SELECT finished_at,shared_result FROM background_task_runs'))
  assert.equal(rows.rows.length, 1)
  assert.ok(rows.rows[0].finished_at)
  assert.equal(JSON.stringify(rows.rows).includes('SYNTHETIC_'), false)
})

test('a slot refresh timeout retains its shared operation and task', async (t) => {
  const f = await fixture(t)
  const result = await runSlotOauth(f.exec, 'refresh', { runDocker: async () => ({ timed_out: true }) })
  assert.equal(result.attemptFinished, false)
  const rows = await f.run(() => f.db.query('SELECT released_at,uncertain_at FROM vm_operations'))
  assert.equal(rows.rows.length, 1)
  assert.equal(rows.rows[0].released_at, null)
  assert.ok(rows.rows[0].uncertain_at)
})

test('implicit worker refresh commands cannot execute while another inference is active', async (t) => {
  const f = await fixture(t)
  const gate = await f.run(() => new ExecutionAdmissionsRepo(f.db).tryReserve({
    accountId: 'slot-refresh-account', vmId: 'vm-01', accountLimit: 2, vmLimit: 2, rpmLimit: 0, fableLimit: 0,
  }))
  let calls = 0
  try {
    await assert.rejects(runSlotOauth(f.exec, 'models', { runDocker: async () => {
      calls++
      return { code: 0, stdout: '{"ok":true,"status":200}' }
    } }), { code: 'vm_execution_active' })
    assert.equal(calls, 0)
  } finally { await f.run(() => gate.release()) }
})
