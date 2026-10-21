import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { getDb, quoteIdentifier, registerActivityCoordinator } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator } from '../../src/lib/db/global-maintenance.mjs'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'
import { createUsageProbeMonitor } from '../../src/lib/oauth/usage-probe-monitor.mjs'
import { createHealthProbeMonitor } from '../../src/lib/admin/health-probe.mjs'
import { HaVmCatalog, bindHaVmCatalog } from '../../src/lib/vm/ha-vm-catalog.mjs'

test('HA routing updates keep unsupported monitors stopped and reject on-demand probes before claiming work', async (t) => {
  const db = getDb()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-648-ha-monitors-'))
  const coordinator = new GlobalMaintenanceCoordinator(db)
  await coordinator.start()
  registerActivityCoordinator(db, coordinator)
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes-ha'
  const file = path.join(root, 'routing.json')
  fs.writeFileSync(file, JSON.stringify({ health_probe: { enabled: true }, usage_probe: { enabled: true } }))
  let config
  let probes = 0
  let pool
  const usage = createUsageProbeMonitor({ config: { enabled: true }, listTargets: () => [] })
  const health = createHealthProbeMonitor({ config: { enabled: true }, listTargets: () => [] })
  t.after(async () => {
    await Promise.all([usage.stop(), health.stop()])
    if (previous == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
    bindHaVmCatalog(null)
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
  const runtime = createRoutingRuntime({
    db,
    cfg: { paths: { project: root } },
    routingConfigPath: file,
    getRoutingConfig: () => config,
    setRoutingConfig: (next) => { config = next },
    accountQuota: { reloadConfig() {}, attachRuntimeRepo() {} },
    getPoolScheduler: () => pool,
    setPoolScheduler: (next) => { pool = next },
    healthMonitor: health,
    usageProbeMonitor: usage,
    probeUsageOne: () => { probes++ },
  })
  const bootstrap = await coordinator.admitBootstrap()
  await bootstrap.run(async () => {
    const catalog = new HaVmCatalog(db)
    bindHaVmCatalog(catalog)
    await catalog.refresh()
    config = await runtime.initRoutingConfig()
    await runtime.initPoolRuntime()
  })
  await coordinator.acknowledgeEpoch(bootstrap.epoch)
  await bootstrap.complete({ ended: true })
  const intervals = []
  const original = globalThis.setInterval
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...args) => {
    intervals.push(ms)
    return original(callback, ms, ...args)
  })
  await coordinator.runActivity({ kind: 'routing_update' }, async () => {
    await runtime.persistRoutingPatch({ pool: { queue_max: 23 } })
    return { ended: true }
  })
  assert.deepEqual(intervals, [], 'a routing update must not install unsupported HA monitor timers')
  pool.rateLimitService.onUsageProbe({ vmId: 'synthetic-vm' })
  assert.equal(probes, 0)
})
