/**
 * M3 parity: `pool.fable_requires_max` against the real Rust `kin-scheduler`.
 *
 * 238 (JS PoolScheduler.checkEligibility -> slotAllowsModel): with the switch
 * on, a Fable request never lands on a non-Max slot; with no Max slot left the
 * pool answered at once with 429 `fable_requires_max`. 243 dropped the call,
 * so Fable went to Pro slots. These cases pin the 238 behavior.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { fableRequiresMaxEnabled, slotDeniesFableForPlan } from '../../src/lib/pool/slot-model-gate.mjs'
import {
  SchedulerApiError,
  VIRTUAL_POOL_IDS,
  createSchedulerRuntime,
} from '../../src/lib/scheduler/scheduler-runtime.mjs'

function resolveSchedulerBin() {
  const candidates = [
    process.env.KIN_SCHEDULER_BIN,
    '/tmp/vm2api-sched-m3-target/release/kin-scheduler',
    path.resolve(process.cwd(), 'bin/kin-scheduler'),
    path.resolve(process.cwd(), 'scheduler/target/release/kin-scheduler'),
    path.resolve(process.cwd(), 'scheduler/target/debug/kin-scheduler'),
  ].filter(Boolean)
  for (const p of candidates) if (fs.existsSync(p)) return p
  throw new Error(`kin-scheduler binary not found in candidates: ${candidates.join(', ')}`)
}

const BIN_PATH = resolveSchedulerBin()
const FABLE_MODELS = ['claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2']
const OTHER_MODELS = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5']

function claudeVm(id, tier, priority) {
  return {
    id,
    name: id,
    kind: 'claude',
    status: 'running',
    schedulable: true,
    claude: { account_uuid: `acct-${id}`, account_tier: tier, account_tier_source: 'profile' },
    policy: { priority, weight: 10, max_concurrency: 4, session_slots: 4 },
  }
}

function setup(t, { vms, routing, accounts = {} }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-m3-fable-'))
  const db = createDatabase({ dbPath: path.join(tmp, 'kin.db') })
  const state = { vms, routing }
  const accountQuota = {
    repo: { get: (id) => accounts[id] || null, list: () => Object.values(accounts) },
    snapshot: () => ({ accounts: Object.values(accounts) }),
  }
  const runtime = createSchedulerRuntime({
    getDb: () => db,
    getVms: () => state.vms,
    getRoutingConfig: () => state.routing,
    accountQuota,
    telemetryIntervalMs: 0,
    clientOptions: {
      binPath: BIN_PATH,
      dataDir: tmp,
      socketPath: path.join(tmp, 'sched.sock'),
      tokenPath: path.join(tmp, 'sched.token'),
      capFile: path.join(tmp, 'sched.cap.json'),
    },
  })
  t.after(async () => {
    await runtime.shutdown({ drain: false, stopProcess: true })
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  return { runtime, state, accountQuota }
}

let sessionSeq = 0
function acquireParams(model, extra = {}) {
  sessionSeq += 1
  return {
    originPoolId: VIRTUAL_POOL_IDS.claude,
    apiKeyKind: 'master',
    model,
    protocol: 'anthropic',
    nodeTypes: ['claude_vm'],
    sessionId: `00000000-0000-4000-8000-${String(sessionSeq).padStart(12, '0')}`,
    ...extra,
  }
}

const MIXED = () => [claudeVm('pro-a', 'pro', 10), claudeVm('pro-b', 'pro', 9), claudeVm('max-a', 'max', 1)]

test('fable_requires_max: Pro+Max pool sends every Fable model to Max, other models keep priority order', async (t) => {
  const { runtime } = setup(t, { vms: MIXED(), routing: { pool: { fable_requires_max: true } } })
  await runtime.start({ waitMs: 5_000, startLoops: false })
  await runtime.pushTelemetryNow()

  for (const model of FABLE_MODELS) {
    for (let i = 0; i < 3; i += 1) {
      const res = await runtime.acquireNode(acquireParams(model))
      assert.equal(res.selected_node.node_key, 'claude_vm:max-a', `${model} must land on Max`)
      await runtime.releaseLease(res.lease_id, 'ok')
    }
  }
  // 238: non-Fable models are unaffected by the switch; highest priority wins.
  for (const model of OTHER_MODELS) {
    const res = await runtime.acquireNode(acquireParams(model))
    assert.equal(res.selected_node.node_key, 'claude_vm:pro-a', `${model} keeps priority order`)
    await runtime.releaseLease(res.lease_id, 'ok')
  }
})

test('fable_requires_max: no Max slot -> immediate 429 fable_requires_max (acquire, explain, FailoverRunner)', async (t) => {
  const { runtime } = setup(t, {
    vms: [claudeVm('pro-a', 'pro', 10), claudeVm('pro-b', 'pro', 9)],
    routing: { pool: { fable_requires_max: true } },
  })
  await runtime.start({ waitMs: 5_000, startLoops: false })
  await runtime.pushTelemetryNow()

  for (const model of FABLE_MODELS) {
    const t0 = Date.now()
    await assert.rejects(runtime.acquireNode(acquireParams(model)), (err) => {
      assert.ok(err instanceof SchedulerApiError)
      assert.equal(err.status, 429)
      assert.equal(err.code, 'fable_requires_max')
      return true
    })
    assert.ok(Date.now() - t0 < 1_000, 'must not queue')
    const exp = await runtime.explainDispatch(acquireParams(model))
    assert.equal(exp.ok, false)
    assert.equal(exp.error_code, 'fable_requires_max')
  }

  const runner = new FailoverRunner({
    scheduler: { markCooldown() {}, markSuccess() {}, setSchedulerRuntime() {} },
    schedulerRuntime: runtime,
  })
  let called = 0
  const t0 = Date.now()
  const res = await runner.run({
    requestId: 'req-fable-no-max',
    canonicalBody: { model: 'claude-fable-5-1' },
    model: 'claude-fable-5-1',
    callAttempt: async () => {
      called += 1
      return { ok: true }
    },
  })
  assert.equal(called, 0, 'no upstream attempt on a Pro slot')
  assert.equal(res.ok, false)
  assert.equal(res.status, 429)
  assert.equal(res.body?.error?.code, 'fable_requires_max')
  assert.ok(Date.now() - t0 < 1_000)
})

test('fable_requires_max: removing the last Max at runtime flips to 429 after syncConfigNow', async (t) => {
  const { runtime, state } = setup(t, { vms: MIXED(), routing: { pool: { fable_requires_max: true } } })
  await runtime.start({ waitMs: 5_000, startLoops: false })
  await runtime.pushTelemetryNow()
  const ok = await runtime.acquireNode(acquireParams('claude-fable-5-2'))
  assert.equal(ok.selected_node.node_key, 'claude_vm:max-a')
  await runtime.releaseLease(ok.lease_id, 'ok')

  state.vms = state.vms.filter((vm) => vm.id !== 'max-a')
  await runtime.syncConfigNow('test')
  await assert.rejects(runtime.acquireNode(acquireParams('claude-fable-5-2')), {
    status: 429,
    code: 'fable_requires_max',
  })
})

test('fable_requires_max off: 238 put Fable on the best slot regardless of plan', async (t) => {
  const { runtime } = setup(t, { vms: MIXED(), routing: { pool: { fable_requires_max: false } } })
  await runtime.start({ waitMs: 5_000, startLoops: false })
  await runtime.pushTelemetryNow()
  const res = await runtime.acquireNode(acquireParams('claude-fable-5'))
  assert.equal(res.selected_node.node_key, 'claude_vm:pro-a')
  await runtime.releaseLease(res.lease_id, 'ok')
})

test('fable_requires_max: master pin bypasses the plan gate as in 238 (pinned skipped slotAllowsModel)', async (t) => {
  const { runtime } = setup(t, { vms: MIXED(), routing: { pool: { fable_requires_max: true } } })
  await runtime.start({ waitMs: 5_000, startLoops: false })
  await runtime.pushTelemetryNow()
  const res = await runtime.acquireNode(
    acquireParams('claude-fable-5', { pinNodeKey: 'claude_vm:pro-b', isAdminDiagnostic: true }),
  )
  assert.equal(res.selected_node.node_key, 'claude_vm:pro-b')
  await runtime.releaseLease(res.lease_id, 'ok')
})

test('slotAllowsModel per-account model denial still drops the slot (238 model_not_supported)', async (t) => {
  const accounts = {
    'acct-max-a': {
      account_id: 'acct-max-a',
      status: 'active',
      unified: { model_denied_until: { 'claude-fable-5': Date.now() + 3_600_000 } },
    },
  }
  const { runtime } = setup(t, {
    vms: [...MIXED(), claudeVm('max-b', 'max', 0)],
    routing: { pool: { fable_requires_max: true } },
    accounts,
  })
  await runtime.start({ waitMs: 5_000, startLoops: false })
  await runtime.pushTelemetryNow()
  const res = await runtime.acquireNode(acquireParams('claude-fable-5'))
  assert.equal(res.selected_node.node_key, 'claude_vm:max-b')
  await runtime.releaseLease(res.lease_id, 'ok')
})

test('panel badge and dispatch share one predicate', () => {
  const routing = { pool: { fable_requires_max: true } }
  const on = fableRequiresMaxEnabled(routing)
  assert.equal(on, true)
  for (const vm of MIXED()) {
    assert.equal(slotDeniesFableForPlan({ vm, fableRequiresMax: on }), vm.claude.account_tier !== 'max')
  }
  // A flat summarizeVm shape (what the panel sees) answers the same.
  assert.equal(
    slotDeniesFableForPlan({
      vm: { id: 'x', account_tier: 'pro', account_tier_source: 'profile' },
      fableRequiresMax: on,
    }),
    true,
  )
  assert.equal(
    slotDeniesFableForPlan({
      vm: { id: 'x', account_tier: 'max', account_tier_source: 'profile' },
      fableRequiresMax: on,
    }),
    false,
  )
  assert.equal(slotDeniesFableForPlan({ vm: { id: 'x', kind: 'codex' }, fableRequiresMax: on }), false)
  assert.equal(slotDeniesFableForPlan({ vm: MIXED()[0], fableRequiresMax: false }), false)
})

function runtimeRepoWith(states) {
  return {
    schedulingSnapshot: (ids) => new Map(ids.filter((id) => states[id]).map((id) => [id, { state: states[id] }])),
  }
}

test('model wait gate: Fable family cooldown on one Max sends Fable to the other Max; opus cooldown skips that slot (238 markWait)', async (t) => {
  const until = Date.now() + 3_600_000
  const { runtime, accountQuota } = setup(t, {
    vms: [...MIXED(), claudeVm('max-b', 'max', 0)],
    routing: { pool: { fable_requires_max: true } },
  })
  accountQuota.runtimeRepo = runtimeRepoWith({
    'acct-max-a': { model_states: { fable: { cooldown_until: until, reason: 'fable_credits_required' } } },
    'acct-pro-a': { model_states: { 'claude-opus-4-6': { cooldown_until: until } } },
  })
  await runtime.start({ waitMs: 5_000, startLoops: false })
  await runtime.pushTelemetryNow()
  for (const model of FABLE_MODELS) {
    const res = await runtime.acquireNode(acquireParams(model))
    assert.equal(res.selected_node.node_key, 'claude_vm:max-b', `${model} skips the cooling Max`)
    await runtime.releaseLease(res.lease_id, 'ok')
  }
  const opus = await runtime.acquireNode(acquireParams('claude-opus-4-6'))
  assert.equal(opus.selected_node.node_key, 'claude_vm:pro-b')
  await runtime.releaseLease(opus.lease_id, 'ok')
  const sonnet = await runtime.acquireNode(acquireParams('claude-sonnet-4-6'))
  assert.equal(sonnet.selected_node.node_key, 'claude_vm:pro-a', 'cooldown is per model')
  await runtime.releaseLease(sonnet.lease_id, 'ok')
})

test('model wait gate: the only Max cooling is not reported as fable_requires_max', async (t) => {
  const { runtime, accountQuota } = setup(t, { vms: MIXED(), routing: { pool: { fable_requires_max: true } } })
  accountQuota.runtimeRepo = runtimeRepoWith({
    'acct-max-a': {
      model_states: { fable: { cooldown_until: Date.now() + 3_600_000, reason: 'fable_credits_required' } },
    },
  })
  await runtime.start({ waitMs: 5_000, startLoops: false })
  await runtime.pushTelemetryNow()
  await assert.rejects(runtime.acquireNode(acquireParams('claude-fable-5')), (err) => {
    assert.ok(err instanceof SchedulerApiError)
    assert.notEqual(err.code, 'fable_requires_max')
    return true
  })
})

async function turn(runtime, model, sessionId) {
  const res = await runtime.acquireNode({ ...acquireParams(model), sessionId, machineId: 'machine-1' })
  await runtime.commitLease(res.lease_id)
  await runtime.releaseLease(res.lease_id, 'ok')
  return res.selected_node.node_key
}

for (const keepPin of [true, false]) {
  test(`keep_pin_on_model_gate=${keepPin}: a Fable turn borrows Max; the next opus turn ${keepPin ? 'goes home' : 'stays on Max'} (238 reconcileSticky borrowed)`, async (t) => {
    const { runtime } = setup(t, {
      vms: MIXED(),
      routing: { pool: { fable_requires_max: true, keep_pin_on_model_gate: keepPin } },
    })
    await runtime.start({ waitMs: 5_000, startLoops: false })
    await runtime.pushTelemetryNow()
    const sid = '00000000-0000-4000-8000-00000000beef'
    assert.equal(await turn(runtime, 'claude-opus-4-6', sid), 'claude_vm:pro-a')
    assert.equal(await turn(runtime, 'claude-fable-5-1', sid), 'claude_vm:max-a')
    assert.equal(await turn(runtime, 'claude-opus-4-6', sid), keepPin ? 'claude_vm:pro-a' : 'claude_vm:max-a')
  })
}

test('summary fork and seatless probe follow the conversation pin without sticking (238 summary familyVm / seatless reconcileSticky)', async (t) => {
  const { runtime } = setup(t, { vms: MIXED(), routing: { pool: {} } })
  await runtime.start({ waitMs: 5_000, startLoops: false })
  await runtime.pushTelemetryNow()
  const sid = '00000000-0000-4000-8000-00000000cafe'
  // Pin the conversation to pro-b (pro-a out of scope for that one turn).
  const first = await runtime.acquireNode({
    ...acquireParams('claude-opus-4-6'),
    sessionId: sid,
    allowedNodeKeys: ['claude_vm:pro-b'],
  })
  assert.equal(first.selected_node.node_key, 'claude_vm:pro-b')
  await runtime.commitLease(first.lease_id)
  await runtime.releaseLease(first.lease_id, 'ok')

  const summary = await runtime.acquireNode({
    ...acquireParams('claude-opus-4-6'),
    sessionId: `${sid}:summary`,
    parentSessionId: sid,
    isEphemeralProbe: true,
  })
  assert.equal(summary.selected_node.node_key, 'claude_vm:pro-b')
  assert.equal(summary.explain?.affinity?.why, 'ephemeral_follow_session')
  await runtime.releaseLease(summary.lease_id, 'ok')

  const probe = await runtime.acquireNode({
    ...acquireParams('claude-opus-4-6'),
    sessionId: sid,
    isEphemeralProbe: true,
  })
  assert.equal(probe.selected_node.node_key, 'claude_vm:pro-b')
  await runtime.releaseLease(probe.lease_id, 'ok')
})
