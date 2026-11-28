import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSchedulerRuntime } from '../../src/lib/scheduler/scheduler-runtime.mjs'

test('M3 admits Gemini base alias without widening model or owner scope', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-regression-'))
  const environment = {
    id: 'synthetic-env',
    enabled: true,
    healthy: true,
    schedulable: true,
    proxy_ready: true,
    license_ok: true,
    models: ['gemini-4-hydrogen-high', 'gemini-4-hydrogen-medium'],
  }
  const runtime = createSchedulerRuntime({
    getDb: () => null,
    getVms: () => [],
    getRoutingConfig: () => ({}),
    geminiScheduler: { listEnvironments: () => [environment] },
    telemetryIntervalMs: 0,
    clientOptions: {
      binPath: process.env.KIN_SCHEDULER_BIN,
      dataDir: dir,
      socketPath: path.join(dir, 'scheduler.sock'),
      tokenPath: path.join(dir, 'token'),
      capFile: path.join(dir, 'cap.json'),
    },
  })
  const params = {
    originPoolId: '__virtual_gemini__',
    apiKeyKind: 'managed',
    apiKeyRecord: { id: 'synthetic-key', group_type: 'gemini', pool_binding_mode: 'legacy_scope' },
    ownerScope: { type: 'platform' },
    nodeTypes: ['gemini_env'],
    allowedNodeKeys: ['gemini_env:synthetic-env'],
    modelFamily: 'gemini',
    protocol: 'google.gemini',
  }
  try {
    await runtime.start({ waitMs: 5000, startLoops: false })
    await runtime.pushTelemetryNow()
    for (const model of ['gemini-4-hydrogen-high', 'gemini-4-hydrogen']) {
      const lease = await runtime.acquireNode({ ...params, model, sessionId: crypto.randomUUID() })
      assert.equal(lease.selected_node.node_id, 'synthetic-env')
      await runtime.releaseLease(lease.lease_id, 'ok')
    }
    for (const extra of [
      { model: 'gemini-nonexistent' },
      { model: 'gemini-4-hydrogen', allowedNodeKeys: ['gemini_env:other'] },
      { model: 'gemini-4-hydrogen', ownerScope: { type: 'user', userId: 'other-tenant' } },
      {
        model: 'gemini-4-hydrogen',
        apiKeyRecord: { ...params.apiKeyRecord, allowed_models: '["gemini-4-hydrogen-high"]' },
      },
    ])
      await assert.rejects(runtime.acquireNode({ ...params, ...extra, sessionId: crypto.randomUUID() }), (error) =>
        ['pool_exhausted', 'model_not_allowed'].includes(error.code),
      )
    environment.models = ['gemini-4-hydrogen-high']
    await runtime.syncConfigNow('test-nondefault-effort')
    const explicit = await runtime.acquireNode({
      ...params,
      model: 'gemini-4-hydrogen',
      requestedEffort: 'high',
      noQueue: true,
      sessionId: crypto.randomUUID(),
    })
    assert.equal(explicit.selected_node.node_id, environment.id)
    await runtime.releaseLease(explicit.lease_id, 'aborted')
    await assert.rejects(
      runtime.acquireNode({ ...params, model: 'gemini-4-hydrogen', noQueue: true, sessionId: crypto.randomUUID() }),
      { code: 'pool_exhausted' },
    )
  } finally {
    await runtime.shutdown({ drain: false, stopProcess: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
