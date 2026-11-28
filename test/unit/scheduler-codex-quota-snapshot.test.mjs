/**
 * Refs #1874 — Codex quota soft limits + temp_unschedulable in scheduler config/telemetry (M3).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { OPENAI_QUOTA_DEFAULTS } from '../../src/lib/pool/openai-quota-policy.mjs'
import { createSchedulerRuntime } from '../../src/lib/scheduler/scheduler-runtime.mjs'

function makeRuntime(overrides = {}) {
  const routing = {
    pool: {},
    concurrency: {},
    codex: {
      quota: { ...OPENAI_QUOTA_DEFAULTS, limit_5h: 0.85, limit_7d: 0.9 },
    },
    ...(overrides.routing || {}),
  }
  const vms = overrides.vms ?? [
    {
      id: 'codex-a',
      platform: 'openai',
      status: 'running',
      has_token: true,
      utilization_5h: 0.5,
      utilization_7d: 0.4,
    },
    {
      id: 'codex-parked',
      platform: 'openai',
      status: 'running',
      has_token: true,
      temp_unschedulable_until: new Date(Date.now() + 120_000).toISOString(),
      temp_unschedulable_reason: 'quota_5h_local',
    },
  ]
  const runtime = createSchedulerRuntime({
    cfg: { paths: { project: '' } },
    getRoutingConfig: () => routing,
    getVms: () => vms,
    accountQuota: {},
    client: { isStandby: true, stopped: true },
    telemetryIntervalMs: 0,
    ...overrides.runtimeOpts,
  })
  return { runtime, routing, vms }
}

test('buildConfigSnapshot carries codex_quota limits and temp_unschedulable on nodes', () => {
  const { runtime } = makeRuntime()
  const snap = runtime.buildConfigSnapshot({ configVersion: 7 })
  assert.equal(snap.config_version, 7)
  assert.deepEqual(snap.codex_quota, { limit_5h: 0.85, limit_7d: 0.9 })

  const parked = snap.nodes.find((n) => n.node_id === 'codex-parked')
  assert.ok(parked)
  assert.ok(parked.temp_unschedulable_until_ms > Date.now())
  assert.equal(parked.temp_unschedulable_reason, 'quota_5h_local')

  const healthy = snap.nodes.find((n) => n.node_id === 'codex-a')
  assert.ok(healthy)
  assert.equal(healthy.temp_unschedulable_until_ms, undefined)
})

test('buildConfigSnapshot fail-closed: invalid routing quota normalizes to policy defaults', () => {
  const { runtime } = makeRuntime({
    routing: {
      codex: { quota: { limit_5h: 'not-a-number', limit_7d: OPENAI_QUOTA_DEFAULTS.limit_7d } },
    },
  })
  const snap = runtime.buildConfigSnapshot()
  assert.equal(snap.codex_quota.limit_5h, OPENAI_QUOTA_DEFAULTS.limit_5h)
  assert.equal(snap.codex_quota.limit_7d, OPENAI_QUOTA_DEFAULTS.limit_7d)
})

test('buildTelemetryBatch marks parked codex schedulable=false and exports temp fields', () => {
  const now = Date.now()
  const { runtime } = makeRuntime()
  const batch = runtime.buildTelemetryBatch({ now })
  const parked = batch.find((u) => u.node_key === 'codex_vm:codex-parked')
  assert.ok(parked)
  assert.equal(parked.schedulable, false)
  assert.equal(parked.temp_unschedulable_reason, 'quota_5h_local')
  assert.ok(parked.temp_unschedulable_until_ms > now)

  const ok = batch.find((u) => u.node_key === 'codex_vm:codex-a')
  assert.ok(ok)
  assert.equal(ok.schedulable, true)
  assert.equal(ok.temp_unschedulable_until_ms, 0)
})

test('buildTelemetryBatch after manual restriction clear sends until=0 for Rust clear (no snapshot fallback)', () => {
  const now = Date.now()
  const cleared = {
    id: 'codex-cleared',
    platform: 'openai',
    status: 'running',
    has_token: true,
    schedulable: true,
  }
  const { runtime } = makeRuntime({ vms: [cleared] })
  const update = runtime.buildTelemetryBatch({ now }).find((u) => u.node_key === 'codex_vm:codex-cleared')
  assert.ok(update)
  assert.equal(update.schedulable, true)
  assert.equal(update.temp_unschedulable_until_ms, 0)
  assert.equal(update.temp_unschedulable_reason, null)
})

test('cleared VM with stale snapshot-style fields absent still emits until=0 every batch', () => {
  const now = Date.now()
  const clearedAfterPark = {
    id: 'codex-early-clear',
    platform: 'openai',
    status: 'running',
    has_token: true,
    schedulable: true,
  }
  const { runtime, vms } = makeRuntime({ vms: [clearedAfterPark] })
  const snap = runtime.buildConfigSnapshot()
  assert.equal(snap.nodes[0].temp_unschedulable_until_ms, undefined)
  vms[0].temp_unschedulable_until = new Date(now + 600_000).toISOString()
  vms[0].temp_unschedulable_reason = 'quota_5h_local'
  const snapStale = runtime.buildConfigSnapshot()
  assert.ok(snapStale.nodes[0].temp_unschedulable_until_ms > now)
  delete vms[0].temp_unschedulable_until
  delete vms[0].temp_unschedulable_reason
  delete vms[0].claude
  const update = runtime.buildTelemetryBatch({ now }).find((u) => u.node_key === 'codex_vm:codex-early-clear')
  assert.equal(update.schedulable, true)
  assert.equal(update.temp_unschedulable_until_ms, 0)
  assert.equal(update.temp_unschedulable_reason, null)
})
