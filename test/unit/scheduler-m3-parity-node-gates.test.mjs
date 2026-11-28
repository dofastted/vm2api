/**
 * M3 parity: per-node and per-model admission gates v1.4.238's JS
 * PoolScheduler.checkEligibility applied and the Rust cutover dropped.
 * Expected values are 238's `checkEligibility` reasons.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createSchedulerRuntime } from '../../src/lib/scheduler/scheduler-runtime.mjs'
import { claudeModelWaitGate, claudeNodeGate } from '../../src/lib/scheduler/node-gates.mjs'

const NOW = Date.parse('2026-11-28T08:00:00Z')
const FUTURE = NOW + 3_600_000

function slot(overrides = {}) {
  return {
    id: 'vm-a',
    kind: 'claude',
    status: 'running',
    schedulable: true,
    proxy_cli_enabled: true,
    proxy: { host: '10.0.0.7', port: 1080 },
    claude: {
      has_access: true,
      has_refresh: true,
      expires_at: FUTURE,
      account_tier: 'pro',
      account_tier_source: 'profile',
    },
    ...overrides,
  }
}

test('claudeNodeGate: healthy slot passes', () => {
  assert.equal(claudeNodeGate({ vm: slot(), now: NOW }), null)
  assert.equal(claudeNodeGate({ vm: slot(), health: { ok: true, engine: 'rust' }, now: NOW }), null)
})

test('claudeNodeGate: accounts row disabled -> account_disabled (238 PS:2190)', () => {
  assert.equal(claudeNodeGate({ vm: slot(), account: { status: 'disabled' }, now: NOW }), 'account_disabled')
  assert.equal(claudeNodeGate({ vm: slot(), account: { status: 'active' }, now: NOW }), null)
})

test('claudeNodeGate: SOCKS must be bound; worker.json must match vm.proxy (238 evaluateSlotGate/evaluateProxySync)', () => {
  assert.equal(claudeNodeGate({ vm: slot({ proxy_cli_enabled: false }), now: NOW }), 'proxy_required')
  assert.equal(claudeNodeGate({ vm: slot({ proxy: null }), now: NOW }), 'proxy_required')
  assert.equal(claudeNodeGate({ vm: slot(), workerProxyEndpoint: '10.0.0.9:1080', now: NOW }), 'proxy_desynced')
  assert.equal(claudeNodeGate({ vm: slot(), workerProxyEndpoint: null, now: NOW }), 'worker_proxy_missing')
  assert.equal(claudeNodeGate({ vm: slot(), workerProxyEndpoint: '10.0.0.7:1080', now: NOW }), null)
  // transparent egress and unreadable worker.json are not judged (238 same)
  assert.equal(
    claudeNodeGate({ vm: slot(), workerProxyEndpoint: '10.0.0.9:1080', egressMode: 'transparent', now: NOW }),
    null,
  )
  assert.equal(claudeNodeGate({ vm: slot(), workerProxyEndpoint: undefined, now: NOW }), null)
})

test('claudeNodeGate: credential eligibility and runtime block (238 evaluateCredentialEligibility / isCredentialRuntimeBlocked)', () => {
  // vm.json and the last worker probe both empty -> no_credential.
  assert.equal(
    claudeNodeGate({ vm: slot({ claude: {} }), health: { ok: true, engine: 'rust', credential: {} }, now: NOW }),
    'no_credential',
  )
  // Nothing probed yet and vm.json empty: unknown, not judged (238 would probe first).
  assert.equal(claudeNodeGate({ vm: slot({ claude: {} }), now: NOW }), null)
  const expiredNoRefresh = slot({ claude: { has_access: true, expires_at: NOW - 1000 } })
  assert.equal(claudeNodeGate({ vm: expiredNoRefresh, now: NOW }), 'oauth_expired')
  assert.equal(claudeNodeGate({ vm: slot(), state: { status: 'disabled' }, now: NOW }), 'credential_blocked')
  const fatal = { status: 'ready', cooldown_until: NOW + 60_000, cooldown_reason: 'oauth_invalid_grant' }
  // vm.json shows a live grant: the runtime row is a leftover (238 isLeftoverGrantRevokeRuntime).
  assert.equal(claudeNodeGate({ vm: slot(), state: fatal, now: NOW }), null)
})

test('claudeNodeGate: concurrency 0 disables the slot (238 concurrency_disabled)', () => {
  assert.equal(claudeNodeGate({ vm: slot(), maxConcurrency: 0, now: NOW }), 'concurrency_disabled')
  assert.equal(claudeNodeGate({ vm: slot(), maxConcurrency: 2, now: NOW }), null)
})

test('claudeNodeGate: kernel fault, offline data path, unreachable worker, process up but unreachable', () => {
  assert.equal(claudeNodeGate({ vm: slot(), kernelFaulted: true, now: NOW }), 'kernel_faulted')
  assert.equal(claudeNodeGate({ vm: slot(), unreachable: true, now: NOW }), 'node_offline')
  assert.equal(claudeNodeGate({ vm: slot(), health: { engine: 'rust', healthy: false }, now: NOW }), 'worker_unhealthy')
})

test('claudeModelWaitGate: per-model cooldown incl. Fable family key, Fable 7d_oi window, weekly split', () => {
  const famState = { model_states: { fable: { cooldown_until: NOW + 60_000, reason: 'fable_credits_required' } } }
  assert.equal(claudeModelWaitGate({ state: famState, model: 'claude-fable-5-1', now: NOW }), 'fable_cooldown')
  assert.equal(claudeModelWaitGate({ state: famState, model: 'claude-opus-4-6', now: NOW }), null)
  const rl = { model_states: { 'claude-fable-5': { cooldown_until: NOW + 60_000, reason: 'fable_rate_limited' } } }
  assert.equal(claudeModelWaitGate({ state: rl, model: 'claude-fable-5', now: NOW }), 'fable_quota')
  const mc = { model_states: { 'claude-opus-4-6': { cooldown_until: NOW + 60_000 } } }
  assert.equal(claudeModelWaitGate({ state: mc, model: 'claude-opus-4-6', now: NOW }), 'model_cooldown')
  assert.equal(claudeModelWaitGate({ state: mc, model: 'claude-opus-4-6', now: NOW + 120_000 }), null)
  const quota = { fableWindowLimited: () => true }
  assert.equal(
    claudeModelWaitGate({ accountId: 'a', model: 'claude-fable-5-2', accountQuota: quota, now: NOW }),
    'fable_quota',
  )
  assert.equal(claudeModelWaitGate({ accountId: 'a', model: 'claude-opus-4-6', accountQuota: quota, now: NOW }), null)
  const split = { weeklySplitOf: () => ({ enabled: true, fable_blocked: true, regular_blocked: false }) }
  assert.equal(
    claudeModelWaitGate({ accountId: 'a', model: 'claude-fable-5', accountQuota: split, now: NOW }),
    'fable_split',
  )
  assert.equal(claudeModelWaitGate({ accountId: 'a', model: 'claude-opus-4-6', accountQuota: split, now: NOW }), null)
})

function telemetryFixture(
  t,
  vms,
  { healthCache = new Map(), workerUnreachable = new Map(), accounts = {}, routing = { pool: {} } } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-m3-gates-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  for (const vm of vms) fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const poolScheduler = {
    config: { worker_health_ttl_ms: 5_000, default_max_per_account: 2 },
    healthCache,
    workerUnreachable,
    effectiveMaxConcurrency: (vm) => (vm?.policy?.concurrencyOverride ? Number(vm.policy.maxConcurrency) : 2),
  }
  return createSchedulerRuntime({
    cfg: { paths: { project: root } },
    getDb: () => null,
    getVms: () => vms,
    getRoutingConfig: () => routing,
    accountQuota: { repo: { get: (id) => accounts[id] || null, list: () => [] }, snapshot: () => ({ accounts: [] }) },
    poolScheduler,
    telemetryIntervalMs: 0,
  })
}

test('buildTelemetryBatch: health-based exclusion survives the 2s push (243 overwrote it with schedulable=true)', (t) => {
  const vms = [slot({ id: 'vm-ok' }), slot({ id: 'vm-gone' }), slot({ id: 'vm-noproxy', proxy_cli_enabled: false })]
  const now = Date.now()
  const rt = telemetryFixture(t, vms, { workerUnreachable: new Map([['vm-gone', { at: now }]]) })
  const byKey = new Map(rt.buildTelemetryBatch({ now }).map((u) => [u.node_key, u]))
  assert.equal(byKey.get('claude_vm:vm-ok').schedulable, true)
  assert.equal(byKey.get('claude_vm:vm-gone').schedulable, false)
  assert.equal(byKey.get('claude_vm:vm-gone').unschedulable_reason, 'node_offline')
  assert.equal(byKey.get('claude_vm:vm-noproxy').schedulable, false)
  assert.equal(byKey.get('claude_vm:vm-noproxy').unschedulable_reason, 'proxy_required')
})

test('buildTelemetryBatch: concurrency 0 and disabled accounts row stop the slot', (t) => {
  const vms = [
    slot({ id: 'vm-zero', policy: { concurrencyOverride: true, maxConcurrency: 0 } }),
    slot({ id: 'vm-dis', claude: { ...slot().claude, account_uuid: 'acct-dis' } }),
  ]
  const rt = telemetryFixture(t, vms, { accounts: { 'acct-dis': { account_id: 'acct-dis', status: 'disabled' } } })
  const byKey = new Map(rt.buildTelemetryBatch({ now: Date.now() }).map((u) => [u.node_key, u]))
  assert.equal(byKey.get('claude_vm:vm-zero').unschedulable_reason, 'concurrency_disabled')
  assert.equal(byKey.get('claude_vm:vm-dis').unschedulable_reason, 'account_disabled')
})

test('buildTelemetryBatch: exhaustion_guard stop removes the slot, the new-session band blocks only new conversations (238 quotaGuardLevel)', (t) => {
  const reset = Date.now() + 3_600_000
  const acct = (id, utilization) => ({
    account_id: id,
    status: 'active',
    unified: { headers: { '5h': { utilization, reset, status: 'allowed' } } },
  })
  const vms = [
    slot({ id: 'vm-open', claude: { ...slot().claude, account_uuid: 'acct-open' } }),
    slot({ id: 'vm-band', claude: { ...slot().claude, account_uuid: 'acct-band' } }),
    slot({ id: 'vm-stop', claude: { ...slot().claude, account_uuid: 'acct-stop' } }),
  ]
  const accounts = {
    'acct-open': acct('acct-open', 0.5),
    'acct-band': acct('acct-band', 0.9),
    'acct-stop': acct('acct-stop', 0.97),
  }
  const quota = { exhaustion_guard: true, exhaustion_guard_new_session: 0.85, exhaustion_guard_stop: 0.95 }
  const on = telemetryFixture(t, vms, { accounts, routing: { pool: {}, quota } })
  const byKey = new Map(on.buildTelemetryBatch({ now: Date.now() }).map((u) => [u.node_key, u]))
  assert.equal(byKey.get('claude_vm:vm-open').schedulable, true)
  assert.equal(byKey.get('claude_vm:vm-open').new_sessions_blocked, false)
  assert.equal(byKey.get('claude_vm:vm-band').schedulable, true)
  assert.equal(byKey.get('claude_vm:vm-band').new_sessions_blocked, true)
  assert.equal(byKey.get('claude_vm:vm-stop').schedulable, false)
  assert.equal(byKey.get('claude_vm:vm-stop').unschedulable_reason, 'quota_guard_stop')

  const off = telemetryFixture(t, vms, { accounts, routing: { pool: {}, quota: { exhaustion_guard: false } } })
  const offByKey = new Map(off.buildTelemetryBatch({ now: Date.now() }).map((u) => [u.node_key, u]))
  assert.equal(offByKey.get('claude_vm:vm-band').new_sessions_blocked, false)
  assert.equal(offByKey.get('claude_vm:vm-stop').schedulable, true)
})
