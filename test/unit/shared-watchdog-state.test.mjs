import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { SharedBackgroundTasks } from '../../src/lib/core/shared-background-tasks.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { createKernelWatchdog } from '../../src/lib/transport/kernel-watchdog.mjs'
import { kernelFaults } from '../../src/lib/transport/rust-kernel-client.mjs'

const vmId = 'vm-shared-budget'
const key = 'kernel_watchdog_state:kin-shared-budget'
function state(patch = {}) {
  return { version: 1, attempts: [], nextAt: null, telemetryDue: 0, fault: null, ...patch }
}
function reserve(id = vmId) {
  return new ExecutionAdmissionsRepo(getDb()).tryReserve({
    accountId: 'budget-account',
    vmId: id,
    accountLimit: 2,
    vmLimit: 2,
    fableLimit: 0,
    rpmLimit: 0,
  })
}

test('a new watchdog controller uses the persisted restart budget', async (t) => {
  const db = getDb()
  const repo = new SettingsRepo(db)
  const now = (await db.prepare('SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now').get()).now
  await repo.set(key, state({ attempts: [now - 1000], nextAt: now - 1 }))
  t.after(() => kernelFaults.delete(vmId))
  let restarted = 0
  const watchdog = createKernelWatchdog({
    listTargets: () => [{ id: vmId, status: 'running' }],
    config: { restart_backoff_sec: [10], restart_window_sec: 3600 },
    health: async () => ({ ok: true, healthy: false, unhealthy_reason: 'synthetic failure' }),
    observeRuntime: async () => ({ state: 'running' }),
    ensure: async () => {
      restarted++
      return { ok: true }
    },
    sharedTasks: new SharedBackgroundTasks(db),
    operations: new SharedVmOperations(db),
  })
  await watchdog.tick()
  assert.equal(restarted, 0)
  assert.match((await repo.get(key)).fault, /after 1 container restarts/)
  assert.equal((await reserve()).code, 'kernel_faulted')
})

test('durable watchdog fault rejects an old candidate with an empty local fault cache', async () => {
  await new SettingsRepo(getDb()).set(key, state({ fault: 'synthetic fault' }))
  kernelFaults.delete(vmId)
  assert.equal((await reserve()).code, 'kernel_faulted')
  assert.equal((await reserve('shared-budget')).code, 'kernel_faulted')
})

test('corrupt durable watchdog state fails closed before inference admission', async () => {
  await new SettingsRepo(getDb()).set(key, { version: 1, attempts: 'invalid' })
  await assert.rejects(reserve(), { code: 'watchdog_state_invalid' })
})

test('operator watchdog reset persists before another controller admits a request', async () => {
  const db = getDb()
  await new SettingsRepo(db).set(key, state({ fault: 'synthetic fault', attempts: [Date.now()] }))
  const watchdog = createKernelWatchdog({
    sharedTasks: new SharedBackgroundTasks(db),
    operations: new SharedVmOperations(db),
  })
  const result = await watchdog.reset(vmId)
  assert.equal(result.faulted, true)
  assert.equal((await new SettingsRepo(db).get(key)).fault, null)
  assert.deepEqual((await new SettingsRepo(db).get(key)).attempts, [])
  const next = await reserve()
  assert.equal(next.ok, true)
  await next.release()
})

test('a state persistence failure after watchdog recovery retains both durable claims', async () => {
  const db = getDb()
  const at = (await db.prepare('SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now').get()).now
  await new SettingsRepo(db).set(key, state({ nextAt: at - 1 }))
  await db.exec(`CREATE FUNCTION reject_watchdog_state() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.key LIKE 'kernel_watchdog_state:%' THEN
        RAISE EXCEPTION 'synthetic watchdog state failure' USING ERRCODE = 'P6498';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER reject_watchdog_state BEFORE INSERT OR UPDATE ON settings
    FOR EACH ROW EXECUTE FUNCTION reject_watchdog_state()`)
  let recovered = 0
  const watchdog = createKernelWatchdog({
    listTargets: () => [{ id: vmId, status: 'running' }],
    health: async () => ({ ok: true, healthy: false }),
    observeRuntime: async () => ({ state: 'running' }),
    ensure: async () => {
      recovered++
      return { ok: true }
    },
    sharedTasks: new SharedBackgroundTasks(db),
    operations: new SharedVmOperations(db),
  })
  await watchdog.tick()
  assert.equal(recovered, 1)
  assert.equal((await reserve()).code, 'vm_operation_active')
  const row = await db.prepare('SELECT unknown_at, finished_at FROM background_task_runs').get()
  assert.ok(row.unknown_at)
  assert.equal(row.finished_at, null)
})
