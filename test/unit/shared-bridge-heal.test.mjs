import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { getDb, registerActivityCoordinator, quoteIdentifier } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator } from '../../src/lib/db/global-maintenance.mjs'
import { createSlotBridgeHealer } from '../../src/lib/vm/slot-recovery.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { SharedProxyOperations } from '../../src/lib/vm/shared-proxy-operations.mjs'
import { SharedBackgroundTasks } from '../../src/lib/core/shared-background-tasks.mjs'
import { createKernelWatchdog } from '../../src/lib/transport/kernel-watchdog.mjs'

const proxy = { id: 'bridge-proxy', scheme: 'socks5', host: '192.0.2.1', port: 1080 }
const vm = { id: 'bridge-vm', status: 'running', proxy }

function healer(overrides = {}) {
  const db = getDb()
  let starts = 0
  return {
    starts: () => starts,
    heal: createSlotBridgeHealer({
      projectRoot: '/unused',
      logger: { warn() {} },
      operations: new SharedVmOperations(db),
      proxyOperations: new SharedProxyOperations(db),
      ops: {
        getVm: (_root, id) => ({ ...vm, id }),
        egressAlive: () => false,
        ensureProxyEgress: async () => {
          starts++
          return { ok: true }
        },
        cluster: () => null,
        ...overrides,
      },
    }),
  }
}

test('bridge healing cannot bypass an existing VM mutation', async () => {
  const db = getDb()
  const held = await new SharedVmOperations(db).tryAcquire({ vmId: vm.id })
  const fx = healer()
  try {
    await assert.rejects(fx.heal([vm]), { code: 'vm_operation_active' })
    assert.equal(fx.starts(), 0)
    const pool = await new SharedProxyOperations(db).tryAcquire()
    assert.equal(pool.ok, true, 'a refusal before any helper work returns the pool claim')
    await pool.release()
  } finally {
    await held.release()
  }
})

test('bridge healing takes claims for other VMs sharing the same helper', async () => {
  const db = getDb()
  await db
    .prepare('INSERT INTO proxies (id, bound_vm_id) VALUES ($1,$2)')
    .run(proxy.id, JSON.stringify([vm.id, 'other-bridge-vm']))
  const held = await new SharedVmOperations(db).tryAcquire({ vmId: 'other-bridge-vm' })
  const fx = healer()
  try {
    await assert.rejects(fx.heal([vm]), { code: 'vm_operation_active' })
    assert.equal(fx.starts(), 0)
  } finally {
    await held.release()
  }
})

test('an unknown helper result is returned and preserves VM and pool claims', async () => {
  const db = getDb()
  const fx = healer({ ensureProxyEgress: async () => ({ ok: false, vmOperationUncertain: true }) })
  const result = await fx.heal([vm])
  assert.equal(result?.vmOperationUncertain, true)
  assert.equal((await new SharedVmOperations(db).tryAcquire({ vmId: vm.id })).code, 'vm_operation_active')
  assert.equal((await new SharedProxyOperations(db).tryAcquire()).code, 'proxy_operation_active')
})

test('watchdog bridge activity remains unknown when the healer cannot confirm completion', async () => {
  const db = getDb()
  const watchdog = createKernelWatchdog({
    listTargets: () => [],
    sharedTasks: new SharedBackgroundTasks(db),
    operations: new SharedVmOperations(db),
    healBridges: async () => ({ ok: false, vmOperationUncertain: true }),
  })
  await watchdog.tick()
  await watchdog.flush()
  const row = await db
    .prepare("SELECT unknown_at, finished_at FROM background_task_runs WHERE task_key='kernel_bridge_heal'")
    .get()
  assert.ok(row.unknown_at)
  assert.equal(row.finished_at, null)
})

test('bridge work obtains its own activity after bootstrap ends and waits for all claims', async (t) => {
  const db = getDb()
  const coordinator = new GlobalMaintenanceCoordinator(db)
  await coordinator.start()
  registerActivityCoordinator(db, coordinator)
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  t.after(async () => {
    if (previous == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
    await coordinator.stop()
    const cleanup = new pg.Client({ connectionString: db.connectionString })
    await cleanup.connect()
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(coordinator.schema)} CASCADE`)
    } finally {
      await cleanup.end()
    }
  })
  const bootstrap = await coordinator.admitBootstrap()
  await coordinator.acknowledgeEpoch(bootstrap.epoch)
  await bootstrap.complete({ ended: true })
  await assert.rejects(db.query('SELECT 1'), { code: 'maintenance_activity_closed' })
  const fx = healer()
  const watchdog = createKernelWatchdog({
    listTargets: () => [],
    sharedTasks: new SharedBackgroundTasks(db),
    operations: new SharedVmOperations(db),
    healBridges: () => fx.heal([vm]),
  })
  await watchdog.tick()
  await watchdog.flush()
  assert.equal(fx.starts(), 1)
  const check = await coordinator.admit({ kind: 'test_observer' })
  try {
    await check.run(async () => {
      assert.equal((await db.prepare('SELECT count(*) AS n FROM vm_operations WHERE released_at IS NULL').get()).n, 0)
      assert.equal(
        (await db.prepare('SELECT count(*) AS n FROM background_task_runs WHERE finished_at IS NULL').get()).n,
        0,
      )
    })
  } finally {
    await check.complete({ ended: true })
  }
})
