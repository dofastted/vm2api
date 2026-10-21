import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { startGateway, api } from '../harness.mjs'
import { GlobalMaintenanceCoordinator } from '../../src/lib/db/global-maintenance.mjs'
import { quoteIdentifier } from '../../src/lib/db/database.mjs'

const env = { VM2API_CONTROL_PLANE_MODE: 'kubernetes', KIN_BACKUP_DISABLED: '1' }

async function controller(t, gw) {
  const coordinator = new GlobalMaintenanceCoordinator(gw.db)
  await coordinator.start()
  await coordinator.acknowledgeEpoch(1)
  t.after(async () => {
    await coordinator.stop().catch(() => {})
    const cleanup = new pg.Client({ connectionString: gw.connectionString })
    await cleanup.connect()
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(coordinator.schema)} CASCADE`)
    } finally {
      await cleanup.end()
    }
  })
  return coordinator
}

test('Kubernetes master HTTP inference and panel writes complete durable activities after persistence', async (t) => {
  const gw = await startGateway({ env })
  const coordinator = await controller(t, gw)
  try {
    const routing = await api(gw, 'PUT', '/api/panel/routing', { body: { pool: { queue_max: 11 } } })
    assert.equal(routing.status, 200, routing.text)
    const response = await api(gw, 'POST', '/v1/messages', {
      body: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8,
        stream: true,
        messages: [{ role: 'user', content: 'activity persists before completion' }],
      },
    })
    assert.equal(response.status, 200, response.text)
    let rows
    for (let i = 0; i < 100; i++) {
      rows = (
        await gw.db.pool.query(
          `SELECT kind, completed_at, uncertain_at FROM ${quoteIdentifier(coordinator.schema)}.activities WHERE kind = 'http'`,
        )
      ).rows
      if (rows.length >= 2 && rows.every((row) => row.completed_at)) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(rows.length >= 2)
    assert.ok(rows.every((row) => row.completed_at && !row.uncertain_at))
  } finally {
    await gw.stop()
  }
})

test('persisted global DRAINING rejects new panel/master requests and readiness while liveness stays available', async (t) => {
  const gw = await startGateway({ env })
  const coordinator = await controller(t, gw)
  let operation
  let pending
  try {
    pending = coordinator.beginMaintenance({ kind: 'backup', timeoutMs: 2000 })
    pending.catch(() => {})
    for (let i = 0; i < 100; i++) {
      if ((await coordinator.getState()).phase === 'draining') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal((await coordinator.getState()).phase, 'draining')
    assert.equal((await fetch(gw.baseUrl + '/readyz')).status, 503)
    assert.equal((await fetch(gw.baseUrl + '/healthz')).status, 200)
    const panel = await api(gw, 'GET', '/api/panel/proxies')
    assert.equal(panel.status, 503, panel.text)
    const inference = await api(gw, 'POST', '/v1/messages', {
      body: { model: 'claude-haiku-4-5-20251001', messages: [] },
    })
    assert.equal(inference.status, 503, inference.text)
  } finally {
    operation = await pending?.catch(() => null)
    await operation?.close()
    const state = await coordinator.getState()
    if (state.phase === 'draining') await coordinator.cancelDrain(state.operationId)
    await gw.stop()
  }
})
