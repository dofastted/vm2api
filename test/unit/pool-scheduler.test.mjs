import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { SchedulerPoolsRepo } from '../../src/lib/db/repos/scheduler-pools-repo.mjs'
import {
  FailoverRunner,
  adoptProviderResponseHeaders,
  opaque429Tracker,
  poolOverloadedError,
  sessionCircuitDedupe,
  vmTimeoutTracker,
} from '../../src/lib/pool/failover-runner.mjs'
import {
  PoolScheduler,
  accountIdOf,
  familyLimitsOf,
  filterByHostMemory,
  formatPoolSelectionSummary,
  normalizePoolRouting,
  quotaGuardConfigOf,
  quotaGuardLevel,
  seatHomes,
  validateQuotaRoutingPatch,
} from '../../src/lib/pool/pool-scheduler.mjs'
import {
  SchedulerUnavailableError,
  createSchedulerRuntime,
  formatNodeKey,
} from '../../src/lib/scheduler/scheduler-runtime.mjs'
import { listVms } from '../../src/lib/vm/vm-registry.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')

function resolveSchedulerBin() {
  for (const candidate of [
    process.env.KIN_SCHEDULER_BIN,
    path.join(REPO_ROOT, 'bin', process.platform === 'win32' ? 'kin-scheduler.exe' : 'kin-scheduler'),
    '/tmp/vm2api-sched-m3-target/release/kin-scheduler',
    '/tmp/vm2api-sched-target/release/kin-scheduler',
  ]) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return null
}

function makeProject(specs = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-pool-scheduler-m3-'))
  const vmsDir = path.join(root, 'vms')
  fs.mkdirSync(vmsDir, { recursive: true })
  const list = specs || [
    { id: 'vm-01', accountId: 'account-1', policy: { priority: 5, weight: 10, maxConcurrency: 2 } },
    { id: 'vm-02', accountId: 'account-2', policy: { priority: 5, weight: 10, maxConcurrency: 2 } },
  ]
  for (const spec of list) {
    const vm = {
      id: spec.id,
      name: spec.id,
      platform: 'anthropic',
      status: spec.status ?? 'running',
      schedulable: spec.schedulable ?? true,
      proxy_cli_enabled: true,
      proxy: { id: `proxy-${spec.id}`, url: `socks5h://127.0.0.1:${spec.port || 10001}` },
      runtime: { worker_socket: path.join(vmsDir, spec.id, 'run', 'worker.sock') },
      policy: { maxConcurrency: 2, concurrencyOverride: true, weight: 10, priority: 5, ...(spec.policy || {}) },
      ...(spec.owner_user_id ? { owner_user_id: spec.owner_user_id } : {}),
      claude: {
        account_uuid: spec.accountId || spec.id,
        account_tier: spec.tier || 'max',
        access_token: `access-${spec.accountId || spec.id}`,
        refresh_token: `refresh-${spec.accountId || spec.id}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        ...(spec.claude || {}),
      },
    }
    fs.writeFileSync(path.join(vmsDir, `${spec.id}.json`), JSON.stringify(vm))
  }
  return root
}

class MemoryRuntimeRepo {
  constructor() {
    this.states = new Map()
  }
  get(id) {
    return this.states.get(id) || null
  }
  upsert(state) {
    const next = { ...(this.states.get(state.account_id) || {}), ...state }
    this.states.set(state.account_id, next)
    return next
  }
  markCooldown(id, update) {
    const state = this.states.get(id) || { account_id: id, vm_id: update.vmId, model_states: {} }
    if (update.model) {
      state.model_states = {
        ...(state.model_states || {}),
        [update.model]: { cooldown_until: update.until, reason: update.reason },
      }
    } else {
      state.cooldown_until = update.until
      state.cooldown_reason = update.reason
      state.status = update.status
    }
    this.states.set(id, state)
    return state
  }
  clearExpired() {}
  writeHeartbeat(input) {
    this.upsert(input)
  }
}

let sharedSchedRoot = null
let sharedRuntime = null
let activeRoot = null
let activePoolsRepo = null
let reqSeq = 0

async function syncProjectToRust(root, poolsRepo = null) {
  activeRoot = root
  activePoolsRepo = poolsRepo
  await sharedRuntime.syncConfigNow('pool_scheduler_test')
  await sharedRuntime.pushTelemetryNow()
  if (root && fs.existsSync(root)) {
    for (const vm of listVms(root)) {
      await sharedRuntime.unrestNode(formatNodeKey('claude_vm', vm.id)).catch(() => {})
    }
  }
}

before(async () => {
  const binPath = resolveSchedulerBin()
  assert.ok(binPath, 'kin-scheduler binary must exist for pool-scheduler tests (set KIN_SCHEDULER_BIN)')
  sharedSchedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-sched-rust-daemon-'))
  sharedRuntime = createSchedulerRuntime({
    cfg: { paths: { data: sharedSchedRoot, project: sharedSchedRoot } },
    getDb: () => activePoolsRepo?.db || null,
    getVms: () => (activeRoot && fs.existsSync(activeRoot) ? listVms(activeRoot) : []),
    getRoutingConfig: () => ({}),
    telemetryIntervalMs: 0,
    clientOptions: {
      binPath,
      socketPath: path.join(sharedSchedRoot, 'run', 'scheduler.sock'),
      tokenPath: path.join(sharedSchedRoot, 'run', 'scheduler.token'),
      capFile: path.join(sharedSchedRoot, 'run', 'scheduler.cap.json'),
      manageProcess: true,
    },
  })
  await sharedRuntime.start({ waitMs: 5_000, startLoops: false })
})

after(async () => {
  if (sharedRuntime) {
    await sharedRuntime.shutdown({ drain: false, stopProcess: true })
    sharedRuntime = null
  }
  if (sharedSchedRoot) {
    fs.rmSync(sharedSchedRoot, { recursive: true, force: true })
    sharedSchedRoot = null
  }
})

// ---------------------------------------------------------------------------
// 1. Pure stateless helper invariants retained after M3 legacy removal
// ---------------------------------------------------------------------------

test('normalizePoolRouting and PoolScheduler.reloadConfig clamp timeouts and report engine=rust', () => {
  const pool = new PoolScheduler({
    config: { sticky_wait_timeout_ms: 500, fallback_wait_timeout_ms: 999999, queue_max: 2000 },
  })
  assert.equal(pool.config.sticky_wait_timeout_ms, 1000)
  assert.equal(pool.config.fallback_wait_timeout_ms, 120000)
  assert.equal(pool.config.queue_max, 999)
  assert.equal(pool.snapshot().engine, 'rust')

  pool.reloadConfig({ sticky_wait_timeout_ms: 'nope', fallback_wait_timeout_ms: null, strategy: 'fill' })
  assert.equal(pool.config.sticky_wait_timeout_ms, 45000)
  assert.equal(pool.config.fallback_wait_timeout_ms, 30000)
  assert.equal(pool.config.strategy, 'fill')

  const norm = normalizePoolRouting({ strategy: 'unknown', max_primary_sessions: 3, max_subagents_per_session: 2 })
  assert.equal(norm.strategy, 'balanced')
  assert.equal(norm.max_primary_sessions, 3)
  assert.equal(norm.max_subagents_per_session, 2)
})

test('formatPoolSelectionSummary, seatHomes, filterByHostMemory, quotaGuardLevel, and familyLimitsOf', () => {
  assert.equal(formatPoolSelectionSummary({}), '')
  assert.equal(
    formatPoolSelectionSummary({
      reason: 'all_accounts_busy',
      soonest_available_ms: 10_064_000,
      sticky_cleared: true,
    }),
    'all_accounts_busy soonest=10064s sticky_cleared',
  )
  assert.equal(
    formatPoolSelectionSummary({ reason: 'no_eligible_accounts', eligible: 0 }),
    'no_eligible_accounts eligible=0',
  )

  assert.deepEqual(seatHomes({ deviceVm: 'vm-1', familyVm: 'vm-2', familyFirst: false }), [
    { vmId: 'vm-1', reason: 'device-affinity' },
    { vmId: 'vm-2', reason: 'family-affinity' },
  ])
  assert.deepEqual(seatHomes({ deviceVm: 'vm-1', familyVm: 'vm-1', familyFirst: true }), [
    { vmId: 'vm-1', reason: 'family-affinity' },
  ])

  const filtered = filterByHostMemory(
    [
      { vmId: 'vm-ok', hostPressure: 'ok' },
      { vmId: 'vm-warn', hostPressure: 'warning' },
      { vmId: 'vm-crit', hostPressure: 'critical' },
    ],
    'vm-crit',
  )
  assert.deepEqual(
    filtered.map((c) => c.vmId),
    ['vm-ok', 'vm-crit'],
  )

  assert.throws(
    () => validateQuotaRoutingPatch({ quota: { exhaustion_guard_new_session: 0.96, exhaustion_guard_stop: 0.9 } }),
    {
      code: 'invalid_quota_config',
    },
  )
  const cfg = quotaGuardConfigOf({
    exhaustion_guard: true,
    exhaustion_guard_new_session: 0.85,
    exhaustion_guard_stop: 0.95,
  })
  assert.equal(quotaGuardLevel({ '5h': { utilization: 0.5 } }, cfg).level, 'open')
  assert.equal(quotaGuardLevel({ '5h': { utilization: 0.9 } }, cfg).level, 'continuing')
  assert.equal(quotaGuardLevel({ '5h': { utilization: 0.96 } }, cfg).level, 'stop')

  const limits = familyLimitsOf(
    { id: 'vm-x', policy: { maxPrimarySessionsOverride: true, maxPrimarySessions: 4 } },
    { max_primary_sessions: 2, max_subagents_per_session: 1 },
    8,
  )
  assert.equal(limits.primary, 4)
  assert.equal(limits.subagents, 1)
  assert.equal(limits.seats, 4)
  assert.equal(accountIdOf({ id: 'vm-x', claude: { account_uuid: 'acc-uuid-1' } }), 'acc-uuid-1')
})

test('FailoverRunner helper exports remain intact and legacy sessionTails is permanently deleted', () => {
  const runner = new FailoverRunner({ scheduler: null })
  assert.equal(runner.sessionTails, undefined, 'FailoverRunner.sessionTails must not exist in M3')
  assert.equal(typeof runner.waitForSessionTurn, 'undefined', 'legacy waitForSessionTurn must not exist')

  const overloaded = poolOverloadedError({ reason: 'pool_busy', retry_after_ms: 2500 })
  assert.equal(overloaded.status, 529)
  assert.equal(overloaded.retryAfterSec, 3)

  const adopted = adoptProviderResponseHeaders({
    ok: false,
    headers: { 'x-existing': '1' },
    providerResult: { response_headers: { 'X-Existing': '2', 'retry-after': '15' } },
  })
  assert.equal(adopted.headers['x-existing'], '1')
  assert.equal(adopted.headers['retry-after'], '15')

  assert.equal(typeof vmTimeoutTracker.recordTimeout, 'function')
  assert.equal(typeof opaque429Tracker.record, 'function')
  assert.equal(typeof sessionCircuitDedupe.clear, 'function')
})

// ---------------------------------------------------------------------------
// 2. Strict D4 Fail-Closed (503 scheduler_unavailable, zero Node fallback)
// ---------------------------------------------------------------------------

test('D4 Fail-Closed: PoolScheduler and FailoverRunner throw/return 503 scheduler_unavailable when runtime is missing', async (t) => {
  const root = makeProject()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = new PoolScheduler({ projectRoot: root, schedulerRuntime: null })

  await assert.rejects(
    () => pool.selectAndReserve({ model: 'claude-sonnet-4-6', allowWait: false }),
    (err) => err instanceof SchedulerUnavailableError && err.code === 'scheduler_unavailable' && err.status === 503,
  )
  await assert.rejects(
    () => pool.peekAccount({ model: 'claude-sonnet-4-6' }),
    (err) => err instanceof SchedulerUnavailableError && err.code === 'scheduler_unavailable' && err.status === 503,
  )

  let attempted = false
  const runner = new FailoverRunner({ scheduler: pool, schedulerRuntime: null })
  const res = await runner.run({
    requestId: `req-no-rt-${++reqSeq}`,
    model: 'claude-sonnet-4-6',
    callAttempt: async () => {
      attempted = true
      return { ok: true, status: 200 }
    },
  })
  assert.equal(attempted, false, 'must never invoke callAttempt without Rust scheduler')
  assert.equal(res.ok, false)
  assert.equal(res.status, 503)
  assert.equal(res.retryAfterSec, 1)
  assert.equal(res.body?.error?.code, 'scheduler_unavailable')
})

// ---------------------------------------------------------------------------
// 3. Authoritative Rust kin-scheduler dispatch via PoolScheduler & FailoverRunner
// ---------------------------------------------------------------------------

test('PoolScheduler.selectAndReserve, peekAccount, weight tier priority, excluded set, and release via real Rust', async (t) => {
  const root = makeProject([
    { id: 'vm-low', accountId: 'acc-low', policy: { priority: 2, weight: 10, maxConcurrency: 2 } },
    { id: 'vm-high', accountId: 'acc-high', policy: { priority: 9, weight: 10, maxConcurrency: 2 } },
    { id: 'vm-stopped', accountId: 'acc-stop', status: 'stopped', policy: { priority: 10, maxConcurrency: 2 } },
  ])
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  await syncProjectToRust(root)

  const pool = new PoolScheduler({ projectRoot: root, schedulerRuntime: sharedRuntime })

  // Read-only peekAccount returns highest weight tier schedulable node and reserves zero inflight.
  const peeked = await pool.peekAccount({ model: 'claude-sonnet-4-6' })
  assert.equal(peeked.ok, true)
  assert.equal(peeked.vmId, 'vm-high')
  assert.equal(Object.keys(pool.snapshot().inflight).length, 0)

  // selectAndReserve picks vm-high (tier 9 > tier 2; vm-stopped excluded by telemetry).
  const first = await pool.selectAndReserve({
    requestId: `req-sel-${++reqSeq}`,
    model: 'claude-sonnet-4-6',
    allowWait: false,
  })
  assert.equal(first.ok, true)
  assert.equal(first.vmId, 'vm-high')
  assert.equal(first.accountId, 'acc-high')
  assert.ok(first.leaseId)
  assert.equal(pool.snapshot().inflight['acc-high'], 1)
  first.release()
  assert.equal(pool.snapshot().inflight['acc-high'], undefined)

  // Explicit exclusion routes cleanly to vm-low.
  const second = await pool.selectAndReserve({
    requestId: `req-sel-${++reqSeq}`,
    model: 'claude-sonnet-4-6',
    excluded: new Set(['vm-high']),
    allowWait: false,
  })
  assert.equal(second.ok, true)
  assert.equal(second.vmId, 'vm-low')
  second.release()
})

test('FailoverRunner performs atomic Rust /schedule/switch on pre-commit 500 and preserves SessionGate FIFO', async (t) => {
  const root = makeProject([
    { id: 'vm-a', accountId: 'acc-a', policy: { priority: 8, maxConcurrency: 4 } },
    { id: 'vm-b', accountId: 'acc-b', policy: { priority: 4, maxConcurrency: 4 } },
  ])
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  await syncProjectToRust(root)

  const pool = new PoolScheduler({ projectRoot: root, schedulerRuntime: sharedRuntime })
  const runner = new FailoverRunner({
    scheduler: pool,
    schedulerRuntime: sharedRuntime,
    config: { max_same_account_retries: 0, max_account_switches: 2, total_retry_deadline_ms: 5000 },
  })

  // 1. Pre-commit 500 on vm-a triggers atomic switch to vm-b and returns 200.
  const triedVms = []
  const switchRes = await runner.run({
    requestId: `req-sw-${++reqSeq}`,
    model: 'claude-sonnet-4-6',
    canonicalBody: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
    inboundIdentity: { sessionId: '11111111-1111-4111-8111-111111111111', machineId: 'mac-pool-1' },
    callAttempt: async ({ candidate, onFirstByte }) => {
      triedVms.push(candidate.vmId)
      if (candidate.vmId === 'vm-a') {
        return {
          ok: false,
          status: 500,
          committed: false,
          body: { type: 'error', error: { type: 'api_error', code: 'overloaded', message: 'upstream 500' } },
        }
      }
      onFirstByte?.()
      return {
        ok: true,
        status: 200,
        committed: true,
        terminalState: 'verified',
        body: {
          id: 'msg_ok',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'switched ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      }
    },
  })
  assert.equal(switchRes.ok, true)
  assert.equal(switchRes.vmId, 'vm-b')
  assert.deepEqual(triedVms, ['vm-a', 'vm-b'])

  // 2. Concurrent same session_id executes strictly FIFO (max concurrent === 1) via Rust SessionGate.
  await sharedRuntime.unrestNode(formatNodeKey('claude_vm', 'vm-a')).catch(() => {})
  const sharedSessionId = '22222222-2222-4222-8222-222222222222'
  let active = 0
  let peak = 0
  const order = []
  const runTurn = (label, delayMs) =>
    runner.run({
      requestId: `req-fifo-${++reqSeq}`,
      model: 'claude-sonnet-4-6',
      canonicalBody: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: label }] },
      inboundIdentity: { sessionId: sharedSessionId, machineId: 'mac-fifo-1' },
      callAttempt: async ({ candidate, onFirstByte }) => {
        active += 1
        peak = Math.max(peak, active)
        order.push(`${label}:start:${candidate.vmId}`)
        onFirstByte?.()
        await new Promise((r) => setTimeout(r, delayMs))
        order.push(`${label}:end`)
        active -= 1
        return {
          ok: true,
          status: 200,
          committed: true,
          terminalState: 'verified',
          body: {
            id: `msg_${label}`,
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: label }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 2, output_tokens: 2 },
          },
        }
      },
    })

  const p1 = runTurn('t1', 80)
  await new Promise((r) => setTimeout(r, 15))
  const p2 = runTurn('t2', 20)
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(peak, 1, `expected strict FIFO peak=1, got ${peak} (${order.join(' -> ')})`)
  assert.equal(r2.vmId, r1.vmId, 'L1 session sticky must keep turn 2 on the committed VM of turn 1')
})

test('FailoverRunner enforces admin-only pinVmId and PoolScheduler quota restriction telemetry sync', async (t) => {
  const root = makeProject([
    { id: 'vm-1', accountId: 'acc-1', policy: { priority: 9, maxConcurrency: 2 } },
    { id: 'vm-2', accountId: 'acc-2', policy: { priority: 1, maxConcurrency: 2 } },
  ])
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  await syncProjectToRust(root)

  const repo = new MemoryRuntimeRepo()
  const pool = new PoolScheduler({ projectRoot: root, runtimeRepo: repo, schedulerRuntime: sharedRuntime })
  const runner = new FailoverRunner({
    scheduler: pool,
    schedulerRuntime: sharedRuntime,
    config: { max_same_account_retries: 0, total_retry_deadline_ms: 2000 },
  })

  // Admin diagnostic pin bypasses tier 9 and selects tier 1 vm-2 directly.
  const pinned = await runner.run({
    requestId: `req-pin-admin-${++reqSeq}`,
    model: 'claude-sonnet-4-6',
    pinVmId: 'vm-2',
    isAdminDiagnostic: true,
    callAttempt: async ({ candidate, onFirstByte }) => {
      onFirstByte?.()
      return {
        ok: true,
        status: 200,
        committed: true,
        terminalState: 'verified',
        body: {
          id: 'msg_pin',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'pinned' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }
    },
  })
  assert.equal(pinned.ok, true)
  assert.equal(pinned.vmId, 'vm-2')

  // Non-admin pinVmId is rejected by Rust (403) without invoking callAttempt.
  let nonAdminCalled = false
  const denied = await runner.run({
    requestId: `req-pin-denied-${++reqSeq}`,
    model: 'claude-sonnet-4-6',
    pinVmId: 'vm-2',
    isAdminDiagnostic: false,
    callAttempt: async () => {
      nonAdminCalled = true
      return { ok: true, status: 200 }
    },
  })
  assert.equal(nonAdminCalled, false)
  assert.equal(denied.ok, false)
  assert.equal(denied.status, 403)

  // Tenant / strict pool scope isolation via SchedulerPoolsRepo + real Rust snapshot.
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-sched-db-'))
  const keyStore = new ApiKeyStore({ dataDir: dbDir })
  t.after(() => {
    try {
      keyStore.close?.()
    } catch {}
    fs.rmSync(dbDir, { recursive: true, force: true })
  })
  const poolsRepo = new SchedulerPoolsRepo(keyStore.db)
  const poolOnly2 = poolsRepo.insert({
    id: 'pool_only_vm2',
    name: 'Only VM2',
    provider_scope: 'anthropic',
  })
  poolsRepo.setMembers(poolOnly2.id, [{ node_type: 'claude_vm', node_id: 'vm-2' }])
  await syncProjectToRust(root, poolsRepo)

  const scoped = await pool.selectAndReserve({
    requestId: `req-pool-scope-${++reqSeq}`,
    model: 'claude-sonnet-4-6',
    originPoolId: 'pool_only_vm2',
    apiKeyKind: 'managed',
    apiKeyRecord: {
      id: 'k-only-2',
      pool_binding_mode: 'strict_pool',
      default_pool_id: 'pool_only_vm2',
      allowed_pool_ids: ['pool_only_vm2'],
    },
    allowWait: false,
  })
  assert.equal(scoped.ok, true)
  assert.equal(scoped.vmId, 'vm-2')
  scoped.release()
  activePoolsRepo = null
})
