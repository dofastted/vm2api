import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { getDb, registerActivityCoordinator, quoteIdentifier } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator } from '../../src/lib/db/global-maintenance.mjs'
import { SharedBackgroundTasks } from '../../src/lib/core/shared-background-tasks.mjs'
import { SharedRoutingConfig } from '../../src/lib/admin/shared-routing-config.mjs'
import { RuntimeSettings, loadSettingsState } from '../../src/lib/db/settings-state.mjs'
import { createCredentialRefreshMonitor } from '../../src/lib/oauth/credential-refresh-monitor.mjs'
import { createHealthProbeMonitor } from '../../src/lib/admin/health-probe.mjs'
import { createUsageProbeMonitor } from '../../src/lib/oauth/usage-probe-monitor.mjs'
import { VmTestScheduleRunner } from '../../src/lib/admin/vm-test-schedule.mjs'

const vm = {
  id: 'scope-vm',
  status: 'running',
  schedulable: true,
  has_token: true,
  has_refresh: true,
  expires_at: 1,
  proxy: { url: 'socks5h://127.0.0.1:19099' },
}
const plan = {
  enabled: true,
  frequency: 'daily',
  time: '09:00',
  timezone: 'UTC',
  cron: '0 9 * * *',
  revision: 'synthetic-revision',
  model: 'claude-haiku-4-5',
  prompt: 'synthetic',
  max_tokens: 8,
}

async function fixture(t) {
  const db = getDb()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-monitor-startup-'))
  const coordinator = new GlobalMaintenanceCoordinator(db)
  await coordinator.start()
  registerActivityCoordinator(db, coordinator)
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  t.after(async () => {
    if (previous === undefined) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
    await coordinator.stop()
    const cleanup = new pg.Client({ connectionString: db.connectionString })
    await cleanup.connect()
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(coordinator.schema)} CASCADE`)
    } finally {
      await cleanup.end()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  const file = path.join(root, 'routing.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      credential_refresh: { enabled: true },
      health_probe: { enabled: true },
      usage_probe: { enabled: true },
    }),
  )
  const routing = new SharedRoutingConfig({
    db,
    file,
    normalize: (x) => x,
    merge: (a, b) => ({ ...a, ...b }),
    apply: () => ({ status: 'applied' }),
  })
  const bootstrap = await coordinator.admitBootstrap()
  await bootstrap.run(async () => {
    await routing.init()
    await loadSettingsState(db)
    await new RuntimeSettings(db).set('vm_test_schedule:scope-vm', plan)
  })
  await coordinator.acknowledgeEpoch(bootstrap.epoch)
  await bootstrap.complete({ ended: true })
  await assert.rejects(db.query('SELECT 1'), { code: 'maintenance_activity_closed' })
  return { db, root, coordinator, tasks: new SharedBackgroundTasks(db) }
}

test('credential refresh obtains a fresh activity after initialization has ended', async (t) => {
  const { db, tasks } = await fixture(t)
  let calls = 0
  const monitor = createCredentialRefreshMonitor({
    sharedTasks: tasks,
    config: { enabled: true },
    listTargets: () => [vm],
    refreshOne: async () => {
      await db.query('SELECT 1')
      calls++
      return { ok: true }
    },
  })
  t.after(() => monitor.stop())
  await monitor.runOnce()
  assert.equal(calls, 1)
})

test('health probing obtains a fresh activity after initialization has ended', async (t) => {
  const { db, tasks } = await fixture(t)
  let calls = 0
  const monitor = createHealthProbeMonitor({
    sharedTasks: tasks,
    config: { enabled: true },
    listTargets: () => [vm],
    runChat: async () => {
      await db.query('SELECT 1')
      calls++
      return {
        ok: true,
        text: 'synthetic',
        body: { id: 'msg_synthetic', content: [{ type: 'text', text: 'synthetic' }] },
      }
    },
  })
  t.after(() => monitor.stop())
  await monitor.runRealProbe()
  assert.equal(calls, 1)
})

test('usage probing obtains a fresh activity before configuration refresh and preparation', async (t) => {
  const { db, tasks } = await fixture(t)
  let calls = 0
  const monitor = createUsageProbeMonitor({
    sharedTasks: tasks,
    config: { enabled: true },
    listTargets: () => [vm],
    accountForVm: () => ({}),
    reconcile: async () => {
      await db.query('SELECT 1')
    },
    probeOne: async () => {
      await db.query('SELECT 1')
      calls++
      return { ok: true }
    },
  })
  t.after(() => monitor.stop())
  await monitor.runOnce()
  assert.equal(calls, 1)
})

test('VM schedule initial and subsequent discovery use new activities after initialization', async (t) => {
  const { db, tasks, root } = await fixture(t)
  const runner = new VmTestScheduleRunner({
    projectRoot: root,
    sharedTasks: tasks,
    settings: () => new RuntimeSettings(db),
    list: () => [vm],
    runTest: async () => ({ ok: true }),
  })
  t.after(() => runner.stop())
  await runner.start()
  assert.equal(runner.jobs.has(vm.id), true)
  await runner.reload()
  assert.equal(runner.jobs.has(vm.id), true)
})

test('VM schedule cron preparation enters a fresh activity before refreshing settings', async (t) => {
  const { db, tasks, root } = await fixture(t)
  let calls = 0
  const runner = new VmTestScheduleRunner({
    projectRoot: root,
    sharedTasks: tasks,
    settings: () => new RuntimeSettings(db),
    list: () => [vm],
    runTest: async () => {
      await db.query('SELECT 1')
      calls++
      return { ok: true }
    },
  })
  t.after(() => runner.stop())
  runner.started = true
  await runner._run(vm.id, plan.revision)
  assert.equal(calls, 1)
})

test('a monitor can replace the closed initialization scope inherited by an asynchronous callback', async (t) => {
  const { db, coordinator, tasks } = await fixture(t)
  let resume
  const delayed = new Promise((resolve) => {
    resume = resolve
  })
  let calls = 0
  const monitor = createCredentialRefreshMonitor({
    sharedTasks: tasks,
    listTargets: () => [vm],
    refreshOne: async () => {
      await db.query('SELECT 1')
      calls++
      return { ok: true }
    },
  })
  t.after(() => monitor.stop())
  const initialization = await coordinator.admit({ kind: 'synthetic_initialization' })
  const background = initialization.run(() => delayed.then(() => monitor.runOnce()))
  await initialization.complete({ ended: true })
  resume()
  await background
  assert.equal(calls, 1)
})

test('DRAINING rejects monitor configuration and VM discovery before any callback or claim', async (t) => {
  const { db, root, coordinator, tasks } = await fixture(t)
  let calls = 0
  let discoveryReads = 0
  const callback = async () => {
    calls++
    return { ok: true }
  }
  const credential = createCredentialRefreshMonitor({
    sharedTasks: tasks,
    listTargets: () => [vm],
    refreshOne: callback,
  })
  const health = createHealthProbeMonitor({ sharedTasks: tasks, listTargets: () => [vm], runChat: callback })
  const usage = createUsageProbeMonitor({ sharedTasks: tasks, listTargets: () => [vm], probeOne: callback })
  const runner = new VmTestScheduleRunner({
    projectRoot: root,
    sharedTasks: tasks,
    settings: () => {
      discoveryReads++
      return new RuntimeSettings(db)
    },
    list: () => {
      discoveryReads++
      return [vm]
    },
    runTest: callback,
  })
  const operation = await coordinator.beginMaintenance({ kind: 'backup' })
  try {
    await assert.rejects(credential.runOnce(), { code: 'database_maintenance' })
    await assert.rejects(health.runRealProbe(), { code: 'database_maintenance' })
    await assert.rejects(usage.runOnce(), { code: 'database_maintenance' })
    await runner.start()
    await runner.flush()
    assert.equal(discoveryReads, 0, 'a discovery admission refusal never reads settings or VMs')
    assert.equal(runner.jobs.size, 0)
    assert.equal(runner.writeFailure, null, 'maintenance refusal is not a persistence failure')
    assert.equal(calls, 0)
    assert.equal((await db.pool.query('SELECT count(*)::integer AS n FROM background_task_runs')).rows[0].n, 0)
  } finally {
    await Promise.all([credential.stop(), health.stop(), usage.stop(), runner.stop()])
    await operation.close()
    await coordinator.cancelDrain(operation.operationId)
  }
})

test('the exact restore owner can reload VM schedules inside its trusted rebind scope', async (t) => {
  const { db, root, coordinator, tasks } = await fixture(t)
  const runner = new VmTestScheduleRunner({
    projectRoot: root,
    sharedTasks: tasks,
    settings: () => new RuntimeSettings(db),
    list: () => [vm],
    runTest: async () => ({ ok: true }),
  })
  t.after(() => runner.stop())
  const request = await coordinator.admit({ kind: 'http' })
  await request.run(async () => {
    const operation = await coordinator.beginMaintenanceFromCurrentActivity({ kind: 'restore' })
    try {
      await operation.beginRestore()
      await operation.beginRebind()
      await operation.runAdmin(() => runner.reload())
      await runner.reload()
      await coordinator.acknowledgeEpoch(2)
      await operation.resume()
    } finally {
      await operation.close()
    }
  })
  await request.complete({ ended: true })
})
