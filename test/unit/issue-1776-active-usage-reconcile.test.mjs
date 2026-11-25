import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildDashboard,
  buildUsage,
  buildVmDetail,
  buildVmList,
  quotaFromAccount,
} from '../../src/lib/admin/panel-api.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { AccountRuntimeRepo } from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { createActiveUsageQuery } from '../../src/lib/oauth/active-usage-query.mjs'
import { ACTIVE_CALIBRATION_SETTLE_MS, AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { isNearLimit } from '../../src/lib/pool/quota-tiers.mjs'
import { listQuotaFromHeaders } from '../../src/lib/pool/quota-window.mjs'

const T0 = Date.parse('2026-11-24T07:04:41.589Z')
const T1_NEXT_DAY = Date.parse('2026-11-25T00:14:44.649Z')
const RESET_5H_ELAPSED = String(Math.floor(Date.parse('2026-11-24T09:30:00Z') / 1000))
const RESET_7D_FUTURE = String(Math.floor(Date.parse('2026-11-26T16:00:00Z') / 1000))
const RESET_7D_FUTURE_ISO = new Date(Number(RESET_7D_FUTURE) * 1000).toISOString()

function makeEnv(t, { vmId = 'vm-01', accountId = 'acc-1', schedulable = true, scheduleOff = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1776-reconcile-'))
  const dataDir = path.join(root, 'data')
  const vmsDir = path.join(root, 'vms')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(vmsDir, { recursive: true })
  const vm = {
    id: vmId,
    platform: 'anthropic',
    family: 'claude',
    status: 'running',
    has_token: true,
    has_refresh: true,
    account_uuid: accountId,
    schedulable,
    ...(scheduleOff ? { schedule_off: true, schedule_manual: true } : {}),
    claude: {
      mode: 'oauth',
      has_access: true,
      has_refresh: true,
      account_uuid: accountId,
      scope: 'user:profile user:inference',
    },
  }
  fs.writeFileSync(path.join(vmsDir, `${vm.id}.json`), JSON.stringify(vm))
  const db = createDatabase({ dataDir })
  const runtimeRepo = new AccountRuntimeRepo(db)
  const quota = new AccountQuota({
    db,
    config: {
      quota: {
        safety_ratio: 0.85,
        weekly_safety_ratio: 0.8,
        block_on_5h: true,
        block_on_7d: true,
      },
      concurrency: { default_max_per_account: 2 },
    },
  })
  quota.attachRuntimeRepo(runtimeRepo)
  t.after(() => {
    try {
      db.close()
    } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  })
  const cfg = { paths: { project: root }, rewrite: { enabled: false } }
  return { root, dataDir, vmsDir, vm, db, runtimeRepo, quota, cfg }
}

function officialZero(probedAtMs, extra = {}) {
  return {
    ok: true,
    usage_status: 200,
    limits_present: true,
    source: 'official-cc-usage',
    probed_at: new Date(probedAtMs).toISOString(),
    five_hour: { utilization: 0, resets_at: null, status: 'allowed' },
    seven_day: { utilization: 0, resets_at: RESET_7D_FUTURE_ISO, status: 'allowed' },
    ...extra,
  }
}

test('#1776 explicit active usage query reconciles stale pre-upgrade 7d headers without reset_boundaries', async (t) => {
  const { root, vm, quota, runtimeRepo, cfg } = makeEnv(t, { schedulable: true })
  quota.ingestHeaders(
    'acc-1',
    {
      'anthropic-ratelimit-unified-5h-utilization': '0.84',
      'anthropic-ratelimit-unified-5h-reset': RESET_5H_ELAPSED,
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.76',
      'anthropic-ratelimit-unified-7d-reset': RESET_7D_FUTURE,
      'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
    },
    null,
    { now: T0 },
  )
  runtimeRepo.upsert({
    account_id: 'acc-1',
    vm_id: vm.id,
    status: 'cooldown',
    cooldown_until: T1_NEXT_DAY + 3600_000,
    cooldown_reason: 'account_quota_exhausted',
    rate_limited_at: T0,
    rate_limit_reset_at: T1_NEXT_DAY + 3600_000,
    session_window_status: 'rejected',
  })

  // Before active calibration: 7d=0.76 puts account in draining zone and near_limit=true everywhere.
  assert.equal(quota.nearLimit(quota.repo.get('acc-1'), { now: T1_NEXT_DAY }), true)
  assert.equal(quota.gateZoneOf('acc-1'), 'draining')

  const query = createActiveUsageQuery({
    now: () => T1_NEXT_DAY,
    probe: async () => officialZero(T1_NEXT_DAY),
  })
  const res = await query({ projectRoot: root, vm, accountQuota: quota })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.seven_day.utilization, 0)
  assert.equal(res.body.data.reconciled, true)
  assert.deepEqual(res.body.data.reconciled_windows, ['5h', '7d'])
  assert.deepEqual(res.body.data.retained_windows, [])

  const acc = quota.repo.get('acc-1')
  assert.equal(acc.unified.headers['5h'].utilization, 0)
  assert.equal(acc.unified.headers['5h'].reset, null)
  assert.equal(acc.unified.headers['7d'].utilization, 0)
  assert.equal(acc.unified.headers['7d'].sampled_at, new Date(T1_NEXT_DAY).toISOString())
  assert.equal(acc.unified.reset_boundaries ?? null, null)

  // Stale pre-calibration quota cooldown was cleared.
  const runtimeState = runtimeRepo.get('acc-1')
  assert.equal(runtimeState.cooldown_until, null)
  assert.equal(runtimeState.rate_limit_reset_at, null)
  assert.equal(runtimeState.session_window_status, 'allowed')

  // Panel list, detail, snapshot, dashboard, usage, and nearLimit all agree on 0% / open.
  const listed = await buildVmList({ cfg, accountQuota: quota, routingConfig: {} })
  const detail = await buildVmDetail({ cfg, accountQuota: quota, id: vm.id })
  const row = listed.data.items[0]
  assert.equal(row.utilization_5h, 0)
  assert.equal(row.utilization_7d, 0)
  assert.equal(row.near_limit, false)
  assert.equal(row.availability.key, 'ok')
  assert.equal(row.schedule_state, 'on')
  assert.equal(detail.data.vm.utilization_7d, 0)
  assert.equal(detail.data.vm.near_limit, false)

  const snap = quota.snapshot({ now: T1_NEXT_DAY })
  const snapAcc = snap.accounts.find((a) => a.account_id === 'acc-1')
  assert.equal(snapAcc.unified['5h'].utilization, 0)
  assert.equal(snapAcc.unified['7d'].utilization, 0)
  assert.equal(quota.nearLimit(acc, { now: T1_NEXT_DAY }), false)
  assert.equal(isNearLimit(snapAcc, undefined, { now: T1_NEXT_DAY }), false)

  const dash = await buildDashboard({
    cfg,
    accountQuota: quota,
    routingConfig: {},
    stickyRouter: { stats: () => ({ active_sessions: 0 }) },
  })
  const usage = buildUsage({ cfg, accountQuota: quota })
  assert.equal(dash.data.summary.peak_7d, 0)
  assert.equal(dash.data.summary.near_limit, 0)
  assert.equal(usage.data.totals.near_limit, 0)

  // Admission: open gate, concurrent 2nd call allowed, 120k cold call allowed.
  assert.equal(quota.gateZoneOf('acc-1'), 'open')
  const first = quota.tryAcquire('acc-1', { now: T1_NEXT_DAY })
  assert.equal(first.ok, true)
  assert.equal(quota.canAccept('acc-1', { now: T1_NEXT_DAY }).ok, true)
  first.release()
  assert.equal(
    quota.canAccept('acc-1', {
      now: T1_NEXT_DAY,
      requestRisk: { estimatedPromptTokens: 120_000, uncachedTokens: 120_000, cold: true, largeCold: true },
    }).ok,
    true,
  )

  // Operator-disabled vm.schedulable / vm.schedule_off is NEVER modified by active calibration.
  const disabled = makeEnv(t, { vmId: 'vm-off', accountId: 'acc-off', schedulable: false, scheduleOff: true })
  disabled.quota.ingestHeaders(
    'acc-off',
    {
      'anthropic-ratelimit-unified-7d-utilization': '0.76',
      'anthropic-ratelimit-unified-7d-reset': RESET_7D_FUTURE,
      'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
    },
    null,
    { now: T0 },
  )
  const resOff = await query({ projectRoot: disabled.root, vm: disabled.vm, accountQuota: disabled.quota })
  assert.equal(resOff.status, 200)
  assert.equal(disabled.quota.repo.get('acc-off').unified.headers['7d'].utilization, 0)
  const diskOff = JSON.parse(fs.readFileSync(path.join(disabled.vmsDir, 'vm-off.json'), 'utf8'))
  assert.equal(diskOff.schedulable, false)
  assert.equal(diskOff.schedule_off, true)
})

test('#1776 background/passive official probe still honors low-reading guard (ou<=0.15 && eu>=0.4)', (t) => {
  const { quota } = makeEnv(t)
  quota.ingestHeaders(
    'acc-1',
    {
      'anthropic-ratelimit-unified-5h-utilization': '0.84',
      'anthropic-ratelimit-unified-5h-reset': RESET_7D_FUTURE,
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.76',
      'anthropic-ratelimit-unified-7d-reset': RESET_7D_FUTURE,
      'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
    },
    null,
    { now: T0 },
  )
  // Passive / background ingestOAuthUsage (no activeCalibration) even 17 hours later:
  quota.ingestOAuthUsage('acc-1', officialZero(T1_NEXT_DAY), {
    startedAt: T1_NEXT_DAY,
    now: T1_NEXT_DAY,
  })
  const acc = quota.repo.get('acc-1')
  assert.equal(acc.unified.official['7d'].utilization, 0)
  assert.equal(acc.unified.headers['5h'].utilization, 0.84)
  assert.equal(acc.unified.headers['7d'].utilization, 0.76)
  assert.equal(listQuotaFromHeaders(acc.unified, { now: T1_NEXT_DAY }).utilization_7d, 0.76)
  assert.equal(quota.gateZoneOf('acc-1'), 'draining')
  assert.equal(quota.nearLimit(acc, { now: T1_NEXT_DAY }), true)
})

test('#1776 in-flight or newer inference headers block stale active query from wiping fresh consumption', async (t) => {
  // Subcase A: active query starts at t1, real inference writes 0.55 at t2 (t1 < t2 < t3), active query resolves at t3.
  {
    const { root, vm, quota } = makeEnv(t, { vmId: 'vm-race-a', accountId: 'acc-race-a' })
    const t0 = T0
    const t1 = T0 + 10 * 60_000
    const t2 = t1 + 2_000
    const t3 = t1 + 5_000
    quota.ingestHeaders(
      'acc-race-a',
      {
        'anthropic-ratelimit-unified-7d-utilization': '0.10',
        'anthropic-ratelimit-unified-7d-reset': RESET_7D_FUTURE,
        'anthropic-ratelimit-unified-7d-status': 'allowed',
      },
      null,
      { now: t0 },
    )
    let releaseProbe
    const gate = new Promise((resolve) => {
      releaseProbe = resolve
    })
    const query = createActiveUsageQuery({
      now: () => t1,
      probe: async () => {
        await gate
        return officialZero(t3)
      },
    })
    const pendingQuery = query({ projectRoot: root, vm, accountQuota: quota, forceReconcile: true })
    // Yield so queryActiveUsage reaches awaiting probe() with probeStartedAt = t1.
    await new Promise((resolve) => setImmediate(resolve))

    quota.ingestHeaders(
      'acc-race-a',
      {
        'anthropic-ratelimit-unified-7d-utilization': '0.55',
        'anthropic-ratelimit-unified-7d-reset': RESET_7D_FUTURE,
        'anthropic-ratelimit-unified-7d-status': 'allowed',
      },
      { input_tokens: 500, output_tokens: 100 },
      { now: t2 },
    )
    releaseProbe()
    const res = await pendingQuery
    assert.equal(res.status, 200)
    assert.equal(res.body.data.reconciled, false)
    assert.equal(res.body.data.can_force_reconcile, false)
    assert.equal(res.body.data.retained_windows[0].window, '7d')
    assert.equal(res.body.data.retained_windows[0].reason, 'newer_headers')
    assert.equal(quota.repo.get('acc-race-a').unified.headers['7d'].utilization, 0.55)
  }

  // Subcase B: inflight > 0 blocks both normal and forceReconcile active queries.
  {
    const { root, vm, quota } = makeEnv(t, { vmId: 'vm-race-b', accountId: 'acc-race-b' })
    quota.ingestHeaders(
      'acc-race-b',
      {
        'anthropic-ratelimit-unified-7d-utilization': '0.55',
        'anthropic-ratelimit-unified-7d-reset': RESET_7D_FUTURE,
        'anthropic-ratelimit-unified-7d-status': 'allowed',
      },
      null,
      { now: T0 },
    )
    const lease = quota.tryAcquire('acc-race-b', { now: T1_NEXT_DAY })
    assert.equal(lease.ok, true)
    const query = createActiveUsageQuery({
      now: () => T1_NEXT_DAY,
      probe: async () => officialZero(T1_NEXT_DAY),
    })
    const normalRes = await query({ projectRoot: root, vm, accountQuota: quota })
    const forcedRes = await query({ projectRoot: root, vm, accountQuota: quota, forceReconcile: true })
    lease.release()

    for (const res of [normalRes, forcedRes]) {
      assert.equal(res.status, 200)
      assert.equal(res.body.data.reconciled, false)
      assert.equal(res.body.data.can_force_reconcile, false)
      assert.equal(res.body.data.retained_windows[0].window, '7d')
      assert.equal(res.body.data.retained_windows[0].reason, 'inflight')
    }
    assert.equal(quota.repo.get('acc-race-b').unified.headers['7d'].utilization, 0.55)
  }
})

test('#1776 active query within 5-minute settle window preserves 76% unless explicitly force-reconciled', async (t) => {
  const { root, vm, quota, cfg } = makeEnv(t)
  quota.ingestHeaders(
    'acc-1',
    {
      'anthropic-ratelimit-unified-7d-utilization': '0.76',
      'anthropic-ratelimit-unified-7d-reset': RESET_7D_FUTURE,
      'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
    },
    null,
    { now: T0 },
  )

  let clock = T0 + 30_000
  const query = createActiveUsageQuery({
    now: () => clock,
    probe: async () => officialZero(clock),
  })

  // Step 1: 30s after inference (< 5m settle window) without forceReconcile -> retains 0.76 and reports settle_window.
  const step1 = await query({ projectRoot: root, vm, accountQuota: quota })
  assert.equal(step1.status, 200)
  assert.equal(step1.body.data.reconciled, false)
  assert.equal(step1.body.data.can_force_reconcile, true)
  assert.equal(step1.body.data.settle_remaining_ms, ACTIVE_CALIBRATION_SETTLE_MS - 30_000)
  assert.equal(step1.body.data.retained_windows.length, 1)
  assert.equal(step1.body.data.retained_windows[0].window, '7d')
  assert.equal(step1.body.data.retained_windows[0].reason, 'settle_window')
  assert.equal(step1.body.data.retained_windows[0].official_utilization, 0)
  assert.equal(step1.body.data.retained_windows[0].retained_utilization, 0.76)

  const accAfterStep1 = quota.repo.get('acc-1')
  assert.equal(accAfterStep1.unified.official['7d'].utilization, 0)
  assert.equal(accAfterStep1.unified.headers['7d'].utilization, 0.76)

  const listedStep1 = await buildVmList({ cfg, accountQuota: quota, routingConfig: {} })
  assert.equal(listedStep1.data.items[0].utilization_7d, 0.76)
  assert.equal(listedStep1.data.items[0].quota_observations.official['7d'].utilization, 0)
  assert.equal(listedStep1.data.items[0].quota_observations.passive['7d'].utilization, 0.76)

  // Step 2: Explicit operator confirmation via POST /api/panel/vms/:id/usage/query { force_reconcile: true } reconciles to 0%.
  clock = T0 + 35_000
  let routePayload = {}
  const response = {}
  const handlePanel = createPanelHandler({
    cfg,
    routingConfig: {},
    accountQuota: quota,
    requireAuth(req) {
      req.panelUser = 'boss'
      req.panelRole = 'admin'
      req.panelUserId = 'u-1'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => routePayload,
  })
  // Verify invalid body type returns 400 first.
  routePayload = ['not-an-object']
  await handlePanel({ method: 'POST', headers: {} }, {}, new URL(`http://localhost/api/panel/vms/${vm.id}/usage/query`))
  assert.equal(response.status, 400)

  // Now test force_reconcile via createActiveUsageQuery (same options panel-routes passes).
  const step2 = await query({ projectRoot: root, vm, accountQuota: quota, forceReconcile: true })
  assert.equal(step2.status, 200)
  assert.equal(step2.body.data.reconciled, true)
  assert.equal(step2.body.data.force_reconcile, true)
  assert.equal(step2.body.data.can_force_reconcile, false)
  assert.deepEqual(step2.body.data.retained_windows, [])
  assert.equal(quota.repo.get('acc-1').unified.headers['7d'].utilization, 0)
  assert.equal(quotaFromAccount(quota.repo.get('acc-1')).utilization_7d, 0)
})

test('#1776 active calibration respects 529 overload_until and newer 429 cooldowns, and calibrates 7d_oi independently', async (t) => {
  // 1. Active 529 overload_until is never cleared by active calibration.
  {
    const { root, vm, quota, runtimeRepo } = makeEnv(t, { vmId: 'vm-529', accountId: 'acc-529' })
    quota.ingestHeaders(
      'acc-529',
      {
        'anthropic-ratelimit-unified-7d-utilization': '0.76',
        'anthropic-ratelimit-unified-7d-reset': RESET_7D_FUTURE,
        'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
      },
      null,
      { now: T0 },
    )
    runtimeRepo.upsert({
      account_id: 'acc-529',
      vm_id: vm.id,
      status: 'cooldown',
      overload_until: T1_NEXT_DAY + 60_000,
      cooldown_until: T1_NEXT_DAY + 60_000,
      cooldown_reason: 'upstream_overloaded',
    })
    const query = createActiveUsageQuery({
      now: () => T1_NEXT_DAY,
      probe: async () => officialZero(T1_NEXT_DAY),
    })
    await query({ projectRoot: root, vm, accountQuota: quota })
    assert.equal(quota.repo.get('acc-529').unified.headers['7d'].utilization, 0)
    assert.equal(runtimeRepo.get('acc-529').overload_until, T1_NEXT_DAY + 60_000)
    assert.equal(runtimeRepo.get('acc-529').cooldown_until, T1_NEXT_DAY + 60_000)
  }

  // 2. Newer 429 (rate_limited_at >= probeStartedAt) is never cleared; 7d_oi calibrates when idle > 5m.
  {
    const { root, vm, quota, runtimeRepo } = makeEnv(t, { vmId: 'vm-oi', accountId: 'acc-oi' })
    quota.ingestHeaders(
      'acc-oi',
      {
        'anthropic-ratelimit-unified-7d-utilization': '0.76',
        'anthropic-ratelimit-unified-7d-reset': RESET_7D_FUTURE,
        'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
        'anthropic-ratelimit-unified-7d_oi-utilization': '1',
        'anthropic-ratelimit-unified-7d_oi-reset': RESET_7D_FUTURE,
        'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
      },
      null,
      { now: T0 },
    )
    const seeded = quota.repo.get('acc-oi')
    seeded.unified.fable = { limited: true, utilization: 1, reset: RESET_7D_FUTURE, ok: true }
    quota.repo.save(seeded)
    runtimeRepo.upsert({
      account_id: 'acc-oi',
      vm_id: vm.id,
      status: 'cooldown',
      cooldown_until: T1_NEXT_DAY + 120_000,
      cooldown_reason: 'rate_limited',
      rate_limited_at: T1_NEXT_DAY + 1_000,
      rate_limit_reset_at: T1_NEXT_DAY + 120_000,
    })

    const query = createActiveUsageQuery({
      now: () => T1_NEXT_DAY,
      probe: async () =>
        officialZero(T1_NEXT_DAY, {
          usage_has_fable: true,
          seven_day_oi: { utilization: 0, resets_at: null, status: 'allowed' },
        }),
    })
    const res = await query({ projectRoot: root, vm, accountQuota: quota })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.reconciled_windows, ['5h', '7d', '7d_oi'])
    assert.equal(quota.fableWindowLimited('acc-oi', T1_NEXT_DAY), false)
    assert.equal(quota.repo.get('acc-oi').unified.fable.limited, false)
    // Newer 429 (rate_limited_at > probeStartedAt) was preserved!
    assert.equal(runtimeRepo.get('acc-oi').rate_limit_reset_at, T1_NEXT_DAY + 120_000)
  }
})

for (const key of ['5h', '7d', '7d_oi']) {
  test(`active calibration uses latest inference activity for ${key} settle time without fresh quota headers`, async (t) => {
    const { root, vm, quota, runtimeRepo } = makeEnv(t)
    quota.ingestHeaders(
      'acc-1',
      {
        [`anthropic-ratelimit-unified-${key}-utilization`]: '0.76',
        [`anthropic-ratelimit-unified-${key}-reset`]: RESET_7D_FUTURE,
        [`anthropic-ratelimit-unified-${key}-status`]: 'allowed_warning',
      },
      null,
      { now: T0 },
    )
    // A completed inference can omit quota headers, leaving an older window sample.
    runtimeRepo.upsert({ account_id: 'acc-1', vm_id: vm.id, last_used_at: T1_NEXT_DAY - 30_000 })
    const before = structuredClone(quota.repo.get('acc-1').unified.headers[key])
    const probe = officialZero(
      T1_NEXT_DAY,
      key === '7d_oi'
        ? {
            usage_has_fable: true,
            seven_day_oi: { utilization: 0, status: 'allowed', resets_at: RESET_7D_FUTURE_ISO },
          }
        : {},
    )
    const query = createActiveUsageQuery({ now: () => T1_NEXT_DAY, probe: async () => probe })
    const res = await query({ projectRoot: root, vm, accountQuota: quota })
    assert.equal(res.status, 200)
    assert.equal(
      quota.repo.get('acc-1').unified.headers[key].utilization,
      0.76,
      'an inference completed 30s ago must retain the high reading during settle despite an old quota sample',
    )
    assert.equal(res.body.data.reconciled, false)
    const retained = res.body.data.retained_windows.find((w) => w.window === key)
    assert.equal(retained?.reason, 'settle_window')
    assert.equal(retained?.settle_remaining_ms, ACTIVE_CALIBRATION_SETTLE_MS - 30_000)
    assert.equal(retained?.header_sampled_at, before.sampled_at || new Date(T0).toISOString())
    const forced = await query({ projectRoot: root, vm, accountQuota: quota, forceReconcile: true })
    assert.equal(forced.status, 200)
    assert.equal(quota.repo.get('acc-1').unified.headers[key].utilization, 0)
  })
}
