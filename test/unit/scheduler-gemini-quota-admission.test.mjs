import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildApiKeyScope, createSchedulerRuntime } from '../../src/lib/scheduler/scheduler-runtime.mjs'

test('real M3 enforces current group quota for acquire, supplied scope and switch without suspending 3p', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-admission-'))
  const bucket = () => ({
    id: 'gemini-5h',
    remaining_fraction: 0,
    reset_at: new Date(Date.now() + 3600_000).toISOString(),
  })
  let envs = ['empty', 'ready'].map((id) => ({
    id,
    enabled: true,
    healthy: true,
    schedulable: true,
    proxy_ready: true,
    license_ok: true,
    models: ['gemini-4-hydrogen-high', 'gemini-4-hydrogen-medium', 'claude-sonnet-4-6-high'],
    account: { quota_groups: [{ windows: [{ ...bucket(), remaining_fraction: id === 'empty' ? 0 : 0.5 }] }] },
  }))
  const runtime = createSchedulerRuntime({
    getDb: () => null,
    getVms: () => [],
    getRoutingConfig: () => ({}),
    geminiScheduler: { listEnvironments: () => envs },
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
    apiKeyKind: 'master',
    ownerScope: { type: 'platform' },
    nodeTypes: ['gemini_env'],
    model: 'gemini-4-hydrogen-medium',
    modelFamily: 'gemini',
    protocol: 'google.gemini',
    noQueue: true,
  }
  const acquire = (extra = {}) => runtime.acquireNode({ ...params, ...extra, sessionId: crypto.randomUUID() })
  const reject = (extra = {}) => assert.rejects(acquire(extra), (error) => error.code === 'pool_exhausted')
  const expectNode = async (extra, expected) => {
    const lease = await acquire(extra).catch((error) => {
      error.message += `; expected ${expected}, request ${JSON.stringify(extra)}`
      throw error
    })
    assert.equal(lease.selected_node.node_id, expected)
    await runtime.releaseLease(lease.lease_id, 'ok')
  }
  try {
    await runtime.start({ waitMs: 5000, startLoops: false })
    await runtime.pushTelemetryNow()
    await expectNode({}, 'ready')
    await reject({ allowedNodeKeys: ['gemini_env:empty'] })
    const supplied = buildApiKeyScope({
      apiKeyKind: 'master',
      originPoolId: params.originPoolId,
      allowedNodeKeys: ['gemini_env:empty'],
    })
    await reject({ apiKeyScope: supplied })
    assert.deepEqual(supplied.allowed_node_keys, ['gemini_env:empty'])
    await expectNode({ model: 'ag-claude-sonnet-4-6-high', allowedNodeKeys: ['gemini_env:empty'] }, 'empty')
    // Replace snapshots without rebuilding config: both regular and prebuilt scopes must see new quota.
    envs = envs.map((env) => ({ ...env, account: { quota_groups: [{ windows: [bucket()] }] } }))
    await reject()
    await reject({ apiKeyScope: { ...supplied, allowed_node_keys: [] } })
    envs[0].account.quota_groups[0].windows[0].reset_at = new Date(Date.now() - 1000).toISOString()
    await expectNode({}, 'empty')
    envs[0].account.quota_groups[0].windows[0] = { ...bucket(), remaining_fraction: 0.2 }
    await expectNode({}, 'empty')
    await reject({ allowedNodeKeys: ['gemini_env:ready'] })
    await reject({ ownerScope: { type: 'user', userId: 'different-tenant' } })
    envs[0].schedulable = false
    await runtime.pushTelemetryNow()
    await reject()
    envs[0].schedulable = true
    await runtime.pushTelemetryNow()
    // Effort-specific per-model quota must follow the actual resolved upstream model.
    envs[0].account.quotas = [{ model: 'gemini-4-hydrogen-medium', remaining_fraction: 0 }]
    await reject({ requestedEffort: 'medium' })
    await expectNode({ model: 'gemini-4-hydrogen-high', requestedEffort: 'high' }, 'empty')
    const active = await acquire({ model: 'gemini-4-hydrogen-high', requestedEffort: 'high' })
    envs[0].account.quota_groups[0].windows[0] = bucket()
    await assert.rejects(
      runtime.switchNode({
        releaseLeaseId: active.lease_id,
        failure: { http_status: 503 },
        nextAttempt: { ...params, sessionId: crypto.randomUUID(), apiKeyScope: { ...supplied, allowed_node_keys: [] } },
      }),
      (error) => error.code === 'pool_exhausted',
    )
  } finally {
    await runtime.shutdown({ drain: false, stopProcess: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
