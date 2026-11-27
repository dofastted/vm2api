import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildClaudeResetRedeem, quotaFromAccount } from '../../src/lib/admin/panel-api.mjs'
import { createImportCommit } from '../../src/lib/oauth/import-commit.mjs'
import { createUsageCache, getUsageFetchMeta } from '../../src/lib/oauth/usage-cache.mjs'
import {
  claudeResetOperationId,
  claudeResetOrgId,
  resetClaudeResetLeasesForTest,
} from '../../src/lib/oauth/claude-reset-credits.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { createFailoverMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'
import { listQuotaFromHeaders } from '../../src/lib/pool/quota-window.mjs'
import { RateLimitService } from '../../src/lib/pool/rate-limit-service.mjs'
import { resolveUsageWindows } from '../../src/lib/protocol/user-count-tokens.mjs'
import { AccountRuntimeRepo } from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'

const ORG = '11111111-1111-4111-8111-111111111111'
const BASE = Math.floor(Date.now() / 1000) * 1000
const T0 = BASE
const T1 = BASE + 12 * 60_000 + 23_572
const T2 = BASE + 21 * 60_000 + 30_539
const T3 = BASE + 23 * 60_000
const T4 = BASE + 25 * 60_000
const T5 = BASE + 27 * 60_000
const RESET_5H_OLD = String(Math.floor((BASE + 2.5 * 3600_000) / 1000))
const RESET_7D_OLD = String(Math.floor((BASE + 57 * 3600_000) / 1000))
const RESET_7D_OFFICIAL = new Date(Number(RESET_7D_OLD) * 1000).toISOString()

function makeFixture(t, { vmId = 'vm-1', accountUuid = 'acc-1', schedulable = false } = {}) {
  resetClaudeResetLeasesForTest()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-reset-sync-'))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
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
  quota.runtimeRepo = runtimeRepo
  const writeVm = (id = vmId, uuid = accountUuid, sched = schedulable) => {
    fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({
        id,
        platform: 'anthropic',
        family: 'claude',
        schedulable: sched,
        claude: {
          mode: 'oauth',
          account_uuid: uuid,
          scope: 'user:profile user:inference',
        },
      }),
    )
  }
  writeVm()
  t.after(() => {
    try {
      db.close()
    } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, dataDir, db, runtimeRepo, quota, cfg: { paths: { project: root } }, writeVm }
}

function scriptedTransport({
  clears = ['five_hour', 'seven_day'],
  claim = { result: 'reset', cleared: clears },
  claimStatus = 200,
  givesBackWeekly = false,
} = {}) {
  const posts = []
  const status = {
    cedar_ember: {
      eligible: true,
      at_limit: true,
      next_grant_id: 'grant_next',
      grants: [
        {
          id: 'grant_next',
          resets_left: 2,
          usable_now: true,
          use_requires_limit: false,
          gives_back_weekly: givesBackWeekly,
          clears,
        },
      ],
    },
  }
  const transport = async (_exec, op, opts = {}) => {
    if (op === 'profile') return { ok: true, status: 200, body: { organization: { uuid: ORG } } }
    if (op === 'reset-status') return { ok: true, status: 200, body: status }
    if (op === 'reset-redeem') {
      posts.push(opts.body)
      return { ok: claimStatus === 200, status: claimStatus, body: claim }
    }
    throw new Error(`unexpected op ${op}`)
  }
  return { transport, posts }
}

function seedPreResetHeaders(quota, accountId, { u5 = 0.84, u7 = 0.76, uOi = null, statusOi = null, now = T0 } = {}) {
  const headers = {
    'anthropic-ratelimit-unified-5h-utilization': String(u5),
    'anthropic-ratelimit-unified-5h-reset': RESET_5H_OLD,
    'anthropic-ratelimit-unified-5h-status': u5 >= 1 ? 'rejected' : 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': String(u7),
    'anthropic-ratelimit-unified-7d-reset': RESET_7D_OLD,
    'anthropic-ratelimit-unified-7d-status': u7 >= 0.75 ? 'allowed_warning' : 'allowed',
  }
  if (uOi != null) {
    headers['anthropic-ratelimit-unified-7d_oi-utilization'] = String(uOi)
    headers['anthropic-ratelimit-unified-7d_oi-reset'] = RESET_7D_OLD
    headers['anthropic-ratelimit-unified-7d_oi-status'] = statusOi || (uOi >= 1 ? 'rejected' : 'allowed')
  }
  quota.ingestHeaders(accountId, headers, null, { now })
}

function officialZeroProbe(atMs, { includeFable = false } = {}) {
  return {
    ok: true,
    usage_status: 200,
    limits_present: true,
    source: 'official-cc-usage',
    probed_at: new Date(atMs).toISOString(),
    five_hour: { utilization: 0, resets_at: null, status: 'allowed' },
    seven_day: { utilization: 0, resets_at: RESET_7D_OFFICIAL, status: 'allowed' },
    ...(includeFable
      ? {
          usage_has_fable: true,
          seven_day_oi: { utilization: 0, resets_at: null, status: 'allowed' },
        }
      : {}),
  }
}

test('#1723 full reset reconciles stale headers on valid official 0% without touching vm.schedulable', async (t) => {
  const { root, cfg, quota } = makeFixture(t, { schedulable: false })
  seedPreResetHeaders(quota, 'acc-1', { u5: 0.84, u7: 0.76, now: T0 })

  const cache = createUsageCache({ now: () => T0, jitter: false })
  await cache.load('acc-1', async () => ({
    ok: true,
    probed_at: new Date(T0).toISOString(),
    five_hour: { utilization: 84, resets_at: new Date(Number(RESET_5H_OLD) * 1000).toISOString() },
    seven_day: { utilization: 76, resets_at: RESET_7D_OFFICIAL },
  }))
  assert.ok(cache.peek('acc-1'))

  const { transport, posts } = scriptedTransport({ clears: ['five_hour', 'seven_day', 'seven_day_overage_included'] })
  const res = await buildClaudeResetRedeem({
    cfg,
    accountQuota: quota,
    usageCache: cache,
    id: 'vm-1',
    idempotencyKey: 'op-full',
    transport,
    now: () => T1,
  })
  assert.equal(res.ok, true)
  assert.equal(res.data.outcome, 'reset')
  assert.equal(res.data.replayed, false)
  // Public output still hides internal ids / org / operation hash.
  const raw = JSON.stringify(res)
  for (const secret of ['grant_next', ORG, posts[0].request_id, '"id"']) {
    assert.equal(raw.includes(secret), false, secret)
  }
  // Usage cache invalidated on fresh confirmed reset.
  assert.equal(cache.peek('acc-1'), null)
  // vm.schedulable untouched.
  const vmOnDisk = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-1.json'), 'utf8'))
  assert.equal(vmOnDisk.schedulable, false)

  // Post-reset official probe reconciles headers, list, snapshot, and gate.
  const gensAfterReset = quota.resetGenerations('acc-1')
  assert.equal(gensAfterReset['5h'], 1)
  assert.equal(gensAfterReset['7d'], 1)
  quota.ingestOAuthUsage('acc-1', officialZeroProbe(T2), {
    startedAt: T2,
    resetGenerations: gensAfterReset,
    now: T2,
  })

  const acc = quota.repo.get('acc-1')
  assert.equal(acc.unified.headers['5h'].utilization, 0)
  assert.equal(acc.unified.headers['5h'].reset, null)
  assert.equal(acc.unified.headers['7d'].utilization, 0)
  assert.equal(acc.unified.headers['7d'].reset, RESET_7D_OFFICIAL)

  const listed = listQuotaFromHeaders(acc.unified, { now: T2 })
  assert.equal(listed.utilization_5h, 0)
  assert.equal(listed.utilization_7d, 0)

  const panelQuota = quotaFromAccount(acc)
  assert.equal(panelQuota.utilization_5h, 0)
  assert.equal(panelQuota.utilization_7d, 0)

  const snap = quota.snapshot({ now: T2 }).accounts.find((a) => a.account_id === 'acc-1')
  assert.equal(snap.unified['5h'].utilization, 0)
  assert.equal(snap.unified['7d'].utilization, 0)

  assert.equal(quota.canAccept('acc-1', { now: T2 }).ok, true)
})

test('#1723 partial resets only invalidate cleared windows (session, weekly, Fable)', async (t) => {
  // 1. Session-only reset: 5h reconciles to 0%, 7d keeps 0.76 under low-reading guard.
  {
    const { cfg, quota } = makeFixture(t, { vmId: 'vm-sess', accountUuid: 'acc-sess' })
    seedPreResetHeaders(quota, 'acc-sess', { u5: 0.84, u7: 0.76, now: T0 })
    const { transport } = scriptedTransport({ clears: ['five_hour'] })
    const res = await buildClaudeResetRedeem({
      cfg,
      accountQuota: quota,
      id: 'vm-sess',
      idempotencyKey: 'op-sess',
      transport,
      now: () => T1,
    })
    assert.equal(res.ok, true)
    const gens = quota.resetGenerations('acc-sess')
    assert.deepEqual(gens, { '5h': 1, '7d': 0, '7d_oi': 0 })

    quota.ingestOAuthUsage('acc-sess', officialZeroProbe(T2), {
      startedAt: T2,
      resetGenerations: gens,
      now: T2,
    })
    const acc = quota.repo.get('acc-sess')
    const listed = listQuotaFromHeaders(acc.unified, { now: T2 })
    assert.equal(listed.utilization_5h, 0)
    assert.equal(listed.utilization_7d, 0.76)
  }

  // 2. Weekly-only reset: 7d reconciles to 0%, 5h keeps 0.84.
  {
    const { cfg, quota } = makeFixture(t, { vmId: 'vm-week', accountUuid: 'acc-week' })
    seedPreResetHeaders(quota, 'acc-week', { u5: 0.84, u7: 0.76, now: T0 })
    const { transport } = scriptedTransport({ clears: ['seven_day'] })
    await buildClaudeResetRedeem({
      cfg,
      accountQuota: quota,
      id: 'vm-week',
      idempotencyKey: 'op-week',
      transport,
      now: () => T1,
    })
    const gens = quota.resetGenerations('acc-week')
    assert.deepEqual(gens, { '5h': 0, '7d': 1, '7d_oi': 0 })

    quota.ingestOAuthUsage('acc-week', officialZeroProbe(T2), {
      startedAt: T2,
      resetGenerations: gens,
      now: T2,
    })
    const listed = listQuotaFromHeaders(quota.repo.get('acc-week').unified, { now: T2 })
    assert.equal(listed.utilization_5h, 0.84)
    assert.equal(listed.utilization_7d, 0)
  }

  // 3. Fable-only reset: 7d_oi reconciles to 0% & lifts fableWindowLimited, 5h/7d untouched.
  {
    const { cfg, quota } = makeFixture(t, { vmId: 'vm-fable', accountUuid: 'acc-fable' })
    seedPreResetHeaders(quota, 'acc-fable', { u5: 0.84, u7: 0.76, uOi: 1, statusOi: 'rejected', now: T0 })
    const seeded = quota.repo.get('acc-fable')
    seeded.unified.fable = { limited: true, utilization: 1, reset: RESET_7D_OLD, ok: true }
    quota.repo.save(seeded)
    assert.equal(quota.fableWindowLimited('acc-fable', T0), true)

    const { transport } = scriptedTransport({
      clears: ['seven_day_overage_included'],
      givesBackWeekly: true,
    })
    await buildClaudeResetRedeem({
      cfg,
      accountQuota: quota,
      id: 'vm-fable',
      idempotencyKey: 'op-fable',
      transport,
      now: () => T1,
    })
    const gens = quota.resetGenerations('acc-fable')
    assert.deepEqual(gens, { '5h': 0, '7d': 0, '7d_oi': 1 })

    quota.ingestOAuthUsage('acc-fable', officialZeroProbe(T2, { includeFable: true }), {
      startedAt: T2,
      resetGenerations: gens,
      now: T2,
    })
    const acc = quota.repo.get('acc-fable')
    const listed = listQuotaFromHeaders(acc.unified, { now: T2 })
    assert.equal(listed.utilization_5h, 0.84)
    assert.equal(listed.utilization_7d, 0.76)
    assert.equal(listed.utilization_7d_oi, 0)
    assert.equal(acc.unified.fable.limited, false)
    assert.equal(quota.fableWindowLimited('acc-fable', T2), false)
  }
})

test('#1723 non-reset outcomes and failed/incomplete probes never clear or fabricate 0%', async (t) => {
  // Non-reset outcomes do not register a boundary or clear headers.
  for (const outcome of ['already_used', 'not_limited', 'cooldown', 'ineligible', 'unavailable']) {
    const { cfg, quota } = makeFixture(t, { vmId: `vm-${outcome}`, accountUuid: `acc-${outcome}` })
    seedPreResetHeaders(quota, `acc-${outcome}`, { u5: 0.9, u7: 0.76, now: T0 })
    const { transport } = scriptedTransport({ claim: { result: outcome } })
    await buildClaudeResetRedeem({
      cfg,
      accountQuota: quota,
      id: `vm-${outcome}`,
      idempotencyKey: `op-${outcome}`,
      transport,
      now: () => T1,
    })
    assert.deepEqual(quota.resetGenerations(`acc-${outcome}`), { '5h': 0, '7d': 0, '7d_oi': 0 })
    quota.ingestOAuthUsage(`acc-${outcome}`, officialZeroProbe(T2), { startedAt: T2, now: T2 })
    const listed = listQuotaFromHeaders(quota.repo.get(`acc-${outcome}`).unified, { now: T2 })
    assert.equal(listed.utilization_5h, 0.9, outcome)
    assert.equal(listed.utilization_7d, 0.76, outcome)
  }

  // Confirmed reset + failed probe / missing window / missing timing stays conservative (no fabricated 0% or gate bypass).
  const { cfg, quota } = makeFixture(t, { vmId: 'vm-fail', accountUuid: 'acc-fail' })
  seedPreResetHeaders(quota, 'acc-fail', { u5: 0.92, u7: 0.88, now: T0 })
  assert.equal(quota.canAccept('acc-fail', { now: T0 }).ok, false)

  const { transport } = scriptedTransport({ clears: ['five_hour', 'seven_day'] })
  await buildClaudeResetRedeem({
    cfg,
    accountQuota: quota,
    id: 'vm-fail',
    idempotencyKey: 'op-fail',
    transport,
    now: () => T1,
  })
  // Before valid official probe: gate remains conservative, not blindly opened.
  assert.equal(quota.canAccept('acc-fail', { now: T1 }).ok, false)

  // Failed official probe (502) does not clear or write 0%.
  quota.ingestOAuthUsage(
    'acc-fail',
    { ok: false, usage_status: 502, error: 'upstream_error', probed_at: new Date(T2).toISOString() },
    { startedAt: T2, resetGenerations: quota.resetGenerations('acc-fail'), now: T2 },
  )
  assert.equal(listQuotaFromHeaders(quota.repo.get('acc-fail').unified, { now: T2 }).utilization_5h, 0.92)
  assert.equal(quota.canAccept('acc-fail', { now: T2 }).ok, false)

  // Official probe with missing timing proof (no startedAt, no resetGenerations, no probed_at) is ignored.
  quota.ingestOAuthUsage(
    'acc-fail',
    {
      ok: true,
      usage_status: 200,
      five_hour: { utilization: 0, resets_at: null, status: 'allowed' },
      seven_day: { utilization: 0, resets_at: RESET_7D_OFFICIAL, status: 'allowed' },
    },
    { now: T2 },
  )
  assert.equal(listQuotaFromHeaders(quota.repo.get('acc-fail').unified, { now: T2 }).utilization_5h, 0.92)
  assert.equal(listQuotaFromHeaders(quota.repo.get('acc-fail').unified, { now: T2 }).utilization_7d, 0.88)

  // Official probe omitting five_hour only reconciles seven_day; never fabricates 0% for absent 5h.
  quota.ingestOAuthUsage(
    'acc-fail',
    {
      ok: true,
      usage_status: 200,
      probed_at: new Date(T2).toISOString(),
      five_hour: {},
      seven_day: { utilization: 0, resets_at: RESET_7D_OFFICIAL, status: 'allowed' },
    },
    { startedAt: T2, resetGenerations: quota.resetGenerations('acc-fail'), now: T2 },
  )
  const listedPartial = listQuotaFromHeaders(quota.repo.get('acc-fail').unified, { now: T2 })
  assert.equal(listedPartial.utilization_5h, 0.92)
  assert.equal(listedPartial.utilization_7d, 0)
  assert.equal(quota.canAccept('acc-fail', { now: T2 }).ok, false)
})

test('#1723 race 1 (t0->t3): late pre-reset headers, 429, and probes cannot restore old 84%/76%', async (t) => {
  const { cfg, quota, runtimeRepo } = makeFixture(t)
  const rateLimit = new RateLimitService({ runtimeRepo, accountQuota: quota })
  seedPreResetHeaders(quota, 'acc-1', { u5: 0.84, u7: 0.76, now: T0 })

  // t0: in-flight request A and in-flight official probe P capture pre-reset generation & timestamp.
  const preResetGens = quota.resetGenerations('acc-1')
  assert.deepEqual(preResetGens, { '5h': 0, '7d': 0, '7d_oi': 0 })

  // t1: confirmed full reset.
  const { transport } = scriptedTransport({ clears: ['five_hour', 'seven_day'] })
  await buildClaudeResetRedeem({
    cfg,
    accountQuota: quota,
    id: 'vm-1',
    idempotencyKey: 'op-race1',
    transport,
    now: () => T1,
  })

  // t2: post-reset official probe returns 0%/0%.
  quota.ingestOAuthUsage('acc-1', officialZeroProbe(T2), {
    startedAt: T2,
    resetGenerations: quota.resetGenerations('acc-1'),
    now: T2,
  })
  assert.equal(listQuotaFromHeaders(quota.repo.get('acc-1').unified, { now: T2 }).utilization_5h, 0)
  assert.equal(quota.canAccept('acc-1', { now: T2 }).ok, true)

  // t3: late pre-reset response headers from request A arrive (local receipt time T3 > T1!).
  quota.ingestHeaders(
    'acc-1',
    {
      'anthropic-ratelimit-unified-5h-utilization': '0.84',
      'anthropic-ratelimit-unified-5h-reset': RESET_5H_OLD,
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.76',
      'anthropic-ratelimit-unified-7d-reset': RESET_7D_OLD,
      'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
    },
    { input_tokens: 100, output_tokens: 50 },
    { requestStartedAt: T0, resetGenerations: preResetGens, now: T3 },
  )

  // t3: late pre-reset 429 also blocked by RateLimitService + AccountQuota.
  const rlBlock = rateLimit.handle429({
    accountId: 'acc-1',
    vmId: 'vm-1',
    result: {
      status: 429,
      headers: {
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-utilization': '1',
        'anthropic-ratelimit-unified-5h-reset': RESET_5H_OLD,
      },
    },
    now: T3,
    requestStartedAt: T0,
    resetGenerations: preResetGens,
  })
  assert.equal(rlBlock, null)
  assert.equal(runtimeRepo.get('acc-1')?.rate_limit_reset_at ?? null, null)

  // t3: late pre-reset official probe P arrives with 84%/76%.
  quota.ingestOAuthUsage(
    'acc-1',
    {
      ok: true,
      usage_status: 200,
      probed_at: new Date(T3).toISOString(),
      five_hour: { utilization: 84, resets_at: new Date(Number(RESET_5H_OLD) * 1000).toISOString(), status: 'allowed' },
      seven_day: { utilization: 76, resets_at: RESET_7D_OFFICIAL, status: 'allowed_warning' },
    },
    { startedAt: T0, resetGenerations: preResetGens, now: T3 },
  )

  // Both list & scheduling reads still see 0%/0% and remain open.
  const acc = quota.repo.get('acc-1')
  const listed = listQuotaFromHeaders(acc.unified, { now: T3 })
  assert.equal(listed.utilization_5h, 0)
  assert.equal(listed.utilization_7d, 0)
  assert.equal(quotaFromAccount(acc).utilization_5h, 0)
  assert.equal(quotaFromAccount(acc).utilization_7d, 0)
  const snap = quota.snapshot({ now: T3 }).accounts.find((a) => a.account_id === 'acc-1')
  assert.equal(snap.unified['5h'].utilization, 0)
  assert.equal(snap.unified['7d'].utilization, 0)
  assert.equal(quota.canAccept('acc-1', { now: T3 }).ok, true)
})

test('#1723 race 2: replay and lagging low official probe cannot wipe post-reset consumption', async (t) => {
  const { root, cfg, quota } = makeFixture(t)
  seedPreResetHeaders(quota, 'acc-1', { u5: 0.84, u7: 0.76, now: T0 })
  const preResetGens = quota.resetGenerations('acc-1')

  // t1: confirmed reset.
  const { transport } = scriptedTransport({ clears: ['five_hour', 'seven_day'] })
  const first = await buildClaudeResetRedeem({
    cfg,
    accountQuota: quota,
    id: 'vm-1',
    idempotencyKey: 'op-race2',
    transport,
    now: () => T1,
  })
  assert.equal(first.data.replayed, false)
  const statePath = path.join(root, 'data', 'claude-reset-state.json')
  const stateAfterFirst = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const opKey = Object.keys(stateAfterFirst.operations)[0]
  const firstAt = stateAfterFirst.operations[opKey].at

  // t2: post-reset official probe 0%.
  const postResetGens = quota.resetGenerations('acc-1')
  quota.ingestOAuthUsage('acc-1', officialZeroProbe(T2), {
    startedAt: T2,
    resetGenerations: postResetGens,
    now: T2,
  })

  // t3: post-reset request creates real 55% / 48% consumption.
  quota.ingestHeaders(
    'acc-1',
    {
      'anthropic-ratelimit-unified-5h-utilization': '0.55',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor((T3 + 5 * 3600_000) / 1000)),
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.48',
      'anthropic-ratelimit-unified-7d-reset': RESET_7D_OLD,
      'anthropic-ratelimit-unified-7d-status': 'allowed',
    },
    null,
    { requestStartedAt: T3, resetGenerations: postResetGens, now: T3 },
  )

  // t4: replay the same receipt op-race2 — original `at` stays immutable, generation does not bump.
  const replay = await buildClaudeResetRedeem({
    cfg,
    accountQuota: quota,
    id: 'vm-1',
    idempotencyKey: 'op-race2',
    transport,
    now: () => T4,
  })
  assert.equal(replay.ok, true)
  assert.equal(replay.data.replayed, true)
  const stateAfterReplay = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(stateAfterReplay.operations[opKey].at, firstAt)
  assert.deepEqual(quota.resetGenerations('acc-1'), postResetGens)

  // t5: lagging post-reset official probe returns 5% / 4% -> low-reading guard protects 55% / 48%!
  quota.ingestOAuthUsage(
    'acc-1',
    {
      ok: true,
      usage_status: 200,
      probed_at: new Date(T5).toISOString(),
      five_hour: { utilization: 5, resets_at: new Date(T3 + 5 * 3600_000).toISOString(), status: 'allowed' },
      seven_day: { utilization: 4, resets_at: RESET_7D_OFFICIAL, status: 'allowed' },
    },
    { startedAt: T5, resetGenerations: postResetGens, now: T5 },
  )
  // And a stale pre-reset official probe from T0 also cannot touch 55% / 48%.
  quota.ingestOAuthUsage('acc-1', officialZeroProbe(T0), {
    startedAt: T0,
    resetGenerations: preResetGens,
    now: T5,
  })

  const acc = quota.repo.get('acc-1')
  const listed = listQuotaFromHeaders(acc.unified, { now: T5 })
  assert.equal(listed.utilization_5h, 0.55)
  assert.equal(listed.utilization_7d, 0.48)
  assert.equal(quotaFromAccount(acc).utilization_5h, 0.55)
  assert.equal(quotaFromAccount(acc).utilization_7d, 0.48)
  const snap = quota.snapshot({ now: T5 }).accounts.find((a) => a.account_id === 'acc-1')
  assert.equal(snap.unified['5h'].utilization, 0.55)
  assert.equal(snap.unified['7d'].utilization, 0.48)
  assert.equal(quota.canAccept('acc-1', { now: T5 }).ok, true)
})

test('#1723 normal un-reset account preserves low-reading guard', (t) => {
  const { quota } = makeFixture(t)
  seedPreResetHeaders(quota, 'acc-1', { u5: 0.84, u7: 0.76, now: T0 })
  quota.ingestOAuthUsage('acc-1', officialZeroProbe(T2), { startedAt: T2, now: T2 })
  const listed = listQuotaFromHeaders(quota.repo.get('acc-1').unified, { now: T2 })
  assert.equal(listed.utilization_5h, 0.84)
  assert.equal(listed.utilization_7d, 0.76)
})

test('#1723 slot account rebinding prevents old receipt from affecting the new account', async (t) => {
  const { cfg, quota, writeVm } = makeFixture(t, { vmId: 'vm-1', accountUuid: 'acc-A' })
  seedPreResetHeaders(quota, 'acc-A', { u5: 0.84, u7: 0.76, now: T0 })

  // vm-1 (bound to acc-A) redeems op-rebind.
  const { transport } = scriptedTransport({ clears: ['five_hour', 'seven_day'] })
  const first = await buildClaudeResetRedeem({
    cfg,
    accountQuota: quota,
    id: 'vm-1',
    idempotencyKey: 'op-rebind',
    transport,
    now: () => T1,
  })
  assert.equal(first.ok, true)
  assert.equal(quota.resetGenerations('acc-A')['5h'], 1)

  // Slot vm-1 is rebound to a new account acc-B with live 84%/76% usage.
  writeVm('vm-1', 'acc-B', true)
  seedPreResetHeaders(quota, 'acc-B', { u5: 0.84, u7: 0.76, now: T2 })

  // Replaying acc-A's receipt on vm-1 must NOT touch acc-B.
  const replay = await buildClaudeResetRedeem({
    cfg,
    accountQuota: quota,
    id: 'vm-1',
    idempotencyKey: 'op-rebind',
    transport,
    now: () => T3,
  })
  assert.equal(replay.ok, true)
  assert.equal(replay.data.replayed, true)
  assert.deepEqual(quota.resetGenerations('acc-B'), { '5h': 0, '7d': 0, '7d_oi': 0 })

  // Subsequent low official probe on acc-B still honors the normal low-reading guard.
  quota.ingestOAuthUsage('acc-B', officialZeroProbe(T4), { startedAt: T4, now: T4 })
  const listedB = listQuotaFromHeaders(quota.repo.get('acc-B').unified, { now: T4 })
  assert.equal(listedB.utilization_5h, 0.84)
  assert.equal(listedB.utilization_7d, 0.76)
})

test('#1723 persisted reset boundaries survive restart for reconciliation, replay, and late responses', async (t) => {
  const { cfg, dataDir, db, quota } = makeFixture(t)
  seedPreResetHeaders(quota, 'acc-1', { u5: 0.84, u7: 0.76, now: T0 })
  const preResetGens = quota.resetGenerations('acc-1')

  const { transport } = scriptedTransport({ clears: ['five_hour', 'seven_day'] })
  await buildClaudeResetRedeem({
    cfg,
    accountQuota: quota,
    id: 'vm-1',
    idempotencyKey: 'op-restart',
    transport,
    now: () => T1,
  })
  db.close()

  // Simulate process restart by opening a fresh SQLite handle and AccountQuota instance.
  const reopenedDb = createDatabase({ dataDir })
  try {
    const restartedQuota = new AccountQuota({
      db: reopenedDb,
      config: {
        quota: { safety_ratio: 0.85, weekly_safety_ratio: 0.8, block_on_5h: true, block_on_7d: true },
        concurrency: { default_max_per_account: 2 },
      },
    })

    // Reset generation survived restart.
    assert.deepEqual(restartedQuota.resetGenerations('acc-1'), { '5h': 1, '7d': 1, '7d_oi': 0 })

    // Post-reset official probe after restart reconciles 84%/76% -> 0%/0%.
    restartedQuota.ingestOAuthUsage('acc-1', officialZeroProbe(T2), {
      startedAt: T2,
      resetGenerations: restartedQuota.resetGenerations('acc-1'),
      now: T2,
    })
    assert.equal(listQuotaFromHeaders(restartedQuota.repo.get('acc-1').unified, { now: T2 }).utilization_5h, 0)
    assert.equal(listQuotaFromHeaders(restartedQuota.repo.get('acc-1').unified, { now: T2 }).utilization_7d, 0)

    // Late pre-reset response after restart is still blocked.
    restartedQuota.ingestHeaders(
      'acc-1',
      {
        'anthropic-ratelimit-unified-5h-utilization': '0.84',
        'anthropic-ratelimit-unified-5h-reset': RESET_5H_OLD,
        'anthropic-ratelimit-unified-5h-status': 'allowed',
      },
      null,
      { requestStartedAt: T0, resetGenerations: preResetGens, now: T3 },
    )
    assert.equal(listQuotaFromHeaders(restartedQuota.repo.get('acc-1').unified, { now: T3 }).utilization_5h, 0)

    // Post-reset usage + replayed receipt after restart does not reopen boundary or wipe consumption.
    restartedQuota.ingestHeaders(
      'acc-1',
      {
        'anthropic-ratelimit-unified-5h-utilization': '0.60',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor((T3 + 5 * 3600_000) / 1000)),
        'anthropic-ratelimit-unified-5h-status': 'allowed',
      },
      null,
      { requestStartedAt: T3, resetGenerations: restartedQuota.resetGenerations('acc-1'), now: T3 },
    )
    await buildClaudeResetRedeem({
      cfg,
      accountQuota: restartedQuota,
      id: 'vm-1',
      idempotencyKey: 'op-restart',
      transport,
      now: () => T4,
    })
    assert.deepEqual(restartedQuota.resetGenerations('acc-1'), { '5h': 1, '7d': 1, '7d_oi': 0 })
    restartedQuota.ingestOAuthUsage('acc-1', officialZeroProbe(T5), {
      startedAt: T5,
      resetGenerations: restartedQuota.resetGenerations('acc-1'),
      now: T5,
    })
    assert.equal(listQuotaFromHeaders(restartedQuota.repo.get('acc-1').unified, { now: T5 }).utilization_5h, 0.6)
  } finally {
    try {
      reopenedDb.close()
    } catch {}
  }
})

test('#1758 blocker 1 & minor 1: FailoverRunner skips applyCooldown on pre-reset account_quota_exhausted and fable_rate_limited 429s', async (t) => {
  // 1a. Pre-reset account_quota_exhausted 429 must not lock account or evict sessions.
  {
    const { cfg, quota, runtimeRepo } = makeFixture(t)
    runtimeRepo.upsert({ account_id: 'acc-1', vm_id: 'vm-1', status: 'ready' })
    const rateLimitService = new RateLimitService({ runtimeRepo, accountQuota: quota })
    const cooldownCalls = []
    const sessionEvictions = []
    let selectCount = 0
    const scheduler = {
      accountQuota: quota,
      async selectAndReserve() {
        selectCount += 1
        if (selectCount > 1) return { ok: false, reason: 'account_pool_exhausted' }
        return { ok: true, accountId: 'acc-1', vmId: 'vm-1', release() {} }
      },
      markSuccess() {},
      markCooldown(selected, opts) {
        cooldownCalls.push({ selected, opts })
        runtimeRepo.markCooldown(selected.accountId, { vmId: selected.vmId, ...opts })
      },
      releaseAccountSessions(info) {
        sessionEvictions.push(info)
      },
    }
    const runner = new FailoverRunner({
      scheduler,
      schedulerRuntime: createFailoverMockSchedulerRuntime({ scheduler }),
      rateLimitService,
      config: { max_same_account_retries: 0, max_total_attempts: 2 },
    })

    const attemptPolicies = []
    await runner.run({
      requestId: 'req-pre-reset-429',
      model: 'claude-sonnet-4-5',
      requestBody: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] },
      onAttempt: ({ policy }) => attemptPolicies.push(policy),
      callAttempt: async () => {
        // Confirmed reset lands while this upstream request is in flight!
        const { transport } = scriptedTransport({ clears: ['five_hour'] })
        await buildClaudeResetRedeem({
          cfg,
          accountQuota: quota,
          id: 'vm-1',
          idempotencyKey: 'op-failover-5h',
          transport,
          now: () => Date.now() + 1000,
        })
        return {
          ok: false,
          status: 429,
          committed: false,
          headers: {
            'anthropic-ratelimit-unified-5h-status': 'rejected',
            'anthropic-ratelimit-unified-5h-utilization': '1',
            'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + 2 * 3600_000) / 1000)),
          },
          body: { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } },
        }
      },
    })

    assert.equal(attemptPolicies.length, 1)
    assert.equal(attemptPolicies[0].action, 'continue')
    assert.equal(attemptPolicies[0].cooldownUntil, null)
    assert.equal(cooldownCalls.length, 0)
    assert.equal(sessionEvictions.length, 0)
    const state = runtimeRepo.get('acc-1')
    assert.equal(state.cooldown_until, null)
    assert.equal(state.rate_limit_reset_at, null)
  }

  // 1b. Pre-reset fable_rate_limited 429 must not apply Fable model cooldown after 7d_oi reset.
  {
    const { cfg, quota, runtimeRepo } = makeFixture(t, { vmId: 'vm-f1', accountUuid: 'acc-f1' })
    runtimeRepo.upsert({ account_id: 'acc-f1', vm_id: 'vm-f1', status: 'ready' })
    const rateLimitService = new RateLimitService({ runtimeRepo, accountQuota: quota })
    const cooldownCalls = []
    let selectCount = 0
    const scheduler = {
      accountQuota: quota,
      async selectAndReserve() {
        selectCount += 1
        if (selectCount > 1) return { ok: false, reason: 'account_pool_exhausted' }
        return { ok: true, accountId: 'acc-f1', vmId: 'vm-f1', release() {} }
      },
      markSuccess() {},
      markCooldown(selected, opts) {
        cooldownCalls.push({ selected, opts })
      },
    }
    const runner = new FailoverRunner({
      scheduler,
      schedulerRuntime: createFailoverMockSchedulerRuntime({ scheduler }),
      rateLimitService,
      config: { max_same_account_retries: 0, max_total_attempts: 2 },
    })

    const attemptPolicies = []
    await runner.run({
      requestId: 'req-pre-reset-fable-429',
      model: 'claude-fable-5',
      requestBody: { model: 'claude-fable-5', messages: [{ role: 'user', content: 'hi' }] },
      onAttempt: ({ policy }) => attemptPolicies.push(policy),
      callAttempt: async () => {
        const { transport } = scriptedTransport({ clears: ['seven_day_overage_included'], givesBackWeekly: true })
        await buildClaudeResetRedeem({
          cfg,
          accountQuota: quota,
          id: 'vm-f1',
          idempotencyKey: 'op-failover-fable',
          transport,
          now: () => Date.now() + 1000,
        })
        return {
          ok: false,
          status: 429,
          committed: false,
          headers: {
            'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
            'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor((Date.now() + 86_400_000) / 1000)),
          },
          body: { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } },
        }
      },
    })

    assert.equal(attemptPolicies.length, 1)
    assert.equal(attemptPolicies[0].reason, 'fable_rate_limited')
    assert.equal(attemptPolicies[0].action, 'continue')
    assert.equal(attemptPolicies[0].cooldownUntil, null)
    assert.equal(cooldownCalls.length, 0)
  }

  // Minor #1: When parsed.window is null, infer '7d' from 7d-status or representative-claim before '5h'.
  {
    const { cfg, quota, runtimeRepo } = makeFixture(t, { vmId: 'vm-7d', accountUuid: 'acc-7d' })
    runtimeRepo.upsert({ account_id: 'acc-7d', vm_id: 'vm-7d', status: 'ready' })
    const rateLimitService = new RateLimitService({ runtimeRepo, accountQuota: quota })
    const preResetGens = quota.resetGenerations('acc-7d')

    const { transport } = scriptedTransport({ clears: ['seven_day'] })
    await buildClaudeResetRedeem({
      cfg,
      accountQuota: quota,
      id: 'vm-7d',
      idempotencyKey: 'op-7d-only',
      transport,
      now: () => T1,
    })

    // 7d-status rejected with only retry-after (no 7d-reset -> parsed.window === null).
    const ignoredByStatus = rateLimitService.handleUpstreamError({
      accountId: 'acc-7d',
      vmId: 'vm-7d',
      result: {
        status: 429,
        committed: false,
        headers: {
          'anthropic-ratelimit-unified-7d-status': 'rejected',
          'retry-after': '3600',
        },
        body: { error: { message: 'Rate limited' } },
      },
      policy: { scope: 'account', reason: 'account_quota_exhausted', action: 'continue-and-cooldown' },
      now: T2,
      requestStartedAt: T0,
      resetGenerations: preResetGens,
    })
    assert.equal(ignoredByStatus?.ignored, true)
    assert.equal(ignoredByStatus?.window, '7d')

    // representative-claim: seven_day with aggregate reset (parsed.window === null).
    const ignoredByClaim = rateLimitService.handleUpstreamError({
      accountId: 'acc-7d',
      vmId: 'vm-7d',
      result: {
        status: 429,
        committed: false,
        headers: {
          'anthropic-ratelimit-unified-representative-claim': 'seven_day',
          'anthropic-ratelimit-unified-reset': RESET_7D_OLD,
        },
        body: { error: { message: 'Rate limited' } },
      },
      policy: { scope: 'account', reason: 'account_quota_exhausted', action: 'continue-and-cooldown' },
      now: T2,
      requestStartedAt: T0,
      resetGenerations: preResetGens,
    })
    assert.equal(ignoredByClaim?.ignored, true)
    assert.equal(ignoredByClaim?.window, '7d')
    assert.equal(runtimeRepo.get('acc-7d').rate_limit_reset_at, null)
  }
})

test('#1758 blocker 2: usage-cache epoch invalidates in-flight pre-reset probes and preserves fetch-start timing', async (t) => {
  // 2a. In-flight pre-reset probe invalidated by clear() cannot write to store or delete newer flight.
  {
    let clockMs = T0
    const cache = createUsageCache({ now: () => clockMs, jitter: false })
    let releasePre
    const preGate = new Promise((resolve) => {
      releasePre = resolve
    })
    let releasePost
    const postGate = new Promise((resolve) => {
      releasePost = resolve
    })

    const preFlight = cache.load('acc-1', async () => {
      await preGate
      return { ok: true, five_hour: { utilization: 84 }, seven_day: { utilization: 76 } }
    })

    // Confirmed reset clears cache + flights and bumps epoch.
    clockMs = T1
    cache.clear('acc-1')
    assert.equal(cache.peek('acc-1'), null)

    // Post-reset caller starts a fresh flight (must NOT join preFlight).
    clockMs = T2
    const postFlight = cache.load('acc-1', async () => {
      await postGate
      return { ok: true, five_hour: { utilization: 0 }, seven_day: { utilization: 0 } }
    })

    // Stale pre-reset flight finishes first: must NOT write 84%/76% or delete postFlight!
    releasePre()
    const preRes = await preFlight
    assert.equal(preRes.five_hour.utilization, 84)
    assert.equal(cache.peek('acc-1'), null)
    assert.equal(cache.stats().inflight, 1)

    // Another post-reset caller joins postFlight (was NOT deleted by preFlight.finally).
    const postJoin = cache.load('acc-1', async () => {
      throw new Error('should have joined active post-reset flight')
    })
    releasePost()
    const [postRes, joinedRes] = await Promise.all([postFlight, postJoin])
    assert.equal(postRes.five_hour.utilization, 0)
    assert.equal(joinedRes.five_hour.utilization, 0)
    assert.equal(cache.peek('acc-1')?.result?.five_hour?.utilization, 0)
    assert.equal(cache.stats().inflight, 0)
  }

  // 2b. Cached/shared probe keeps fetch-start timing so post-reset caller cannot stamp it post-reset.
  {
    const { cfg, quota } = makeFixture(t, { vmId: 'vm-u2', accountUuid: 'acc-u2' })
    seedPreResetHeaders(quota, 'acc-u2', { u5: 0.84, u7: 0.76, now: T0 })
    // Put a pre-reset stale entry in usageCache (simulated at T0 without clear to test timing defense-in-depth).
    const cache = createUsageCache({ now: () => T0, jitter: false })
    const preProbe = await cache.load('acc-u2', async () => ({
      ok: true,
      usage_status: 200,
      limits_present: true,
      probed_at: new Date(T3).toISOString(), // even if probed_at were late, fetchStartedAt is T0!
      five_hour: { utilization: 84, resets_at: new Date(Number(RESET_5H_OLD) * 1000).toISOString(), status: 'allowed' },
      seven_day: { utilization: 76, resets_at: RESET_7D_OFFICIAL, status: 'allowed_warning' },
    }))
    assert.equal(getUsageFetchMeta(preProbe)?.startedAt, T0)

    // Confirmed reset at T1 (use a different cache instance so `cache` still holds the pre-reset entry).
    const { transport } = scriptedTransport({ clears: ['five_hour', 'seven_day'] })
    await buildClaudeResetRedeem({
      cfg,
      accountQuota: quota,
      usageCache: createUsageCache({ jitter: false }),
      id: 'vm-u2',
      idempotencyKey: 'op-u2',
      transport,
      now: () => T1,
    })

    // Clear headers temporarily to force resolveUsageWindows to call cache.load -> hits pre-reset entry.
    const accBefore = quota.repo.get('acc-u2')
    accBefore.unified.headers = {}
    quota.repo.save(accBefore)

    await resolveUsageWindows({
      accountQuota: quota,
      accountId: 'acc-u2',
      vmId: 'vm-u2',
      exec: {},
      vm: { id: 'vm-u2', claude: { account_uuid: 'acc-u2' } },
      usageCache: cache,
      probe: async () => {
        throw new Error('expected cache hit')
      },
    })

    // Reset boundaries must NOT be consumed by the pre-reset cached result!
    const accAfter = quota.repo.get('acc-u2')
    assert.equal(accAfter.unified.reset_boundaries['5h'].reconciled, false)
    assert.equal(accAfter.unified.reset_boundaries['7d'].reconciled, false)
    assert.equal(accAfter.unified.headers['5h'], undefined)
  }
})

test('#1758 blocker 3: post-reset reconciliation clears pre-reset rate_limit_reset_at but preserves overload and post-reset 429s', async (t) => {
  // 3a. Pre-reset 429 sets future rate_limit_reset_at -> reset -> valid 0% official probe lifts it.
  {
    const { cfg, quota, runtimeRepo } = makeFixture(t)
    runtimeRepo.upsert({ account_id: 'acc-1', vm_id: 'vm-1', status: 'ready' })
    const rateLimit = new RateLimitService({ runtimeRepo, accountQuota: quota })

    const resetFutureSec = String(Math.floor((T0 + 3 * 3600_000) / 1000))
    const block = rateLimit.handle429({
      accountId: 'acc-1',
      vmId: 'vm-1',
      result: {
        status: 429,
        headers: {
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-utilization': '1',
          'anthropic-ratelimit-unified-5h-reset': resetFutureSec,
        },
      },
      now: T0,
    })
    assert.ok(block?.until > T2)
    assert.ok(runtimeRepo.get('acc-1').rate_limit_reset_at > T2)

    const { transport } = scriptedTransport({ clears: ['five_hour', 'seven_day'] })
    await buildClaudeResetRedeem({
      cfg,
      accountQuota: quota,
      id: 'vm-1',
      idempotencyKey: 'op-clear-rl',
      transport,
      now: () => T1,
    })

    // Post-reset valid 0% official probe reconciles and clears pre-reset rate_limit_reset_at.
    quota.ingestOAuthUsage('acc-1', officialZeroProbe(T2), {
      startedAt: T2,
      resetGenerations: quota.resetGenerations('acc-1'),
      now: T2,
    })
    const state = runtimeRepo.get('acc-1')
    assert.equal(state.rate_limit_reset_at, null)
    assert.equal(state.cooldown_until, null)
    assert.equal(state.status, 'ready')
    assert.equal(quota.canAccept('acc-1', { now: T2 }).ok, true)
  }

  // 3b. Active overload_until (529) prevents clearing.
  {
    const { cfg, quota, runtimeRepo } = makeFixture(t, { vmId: 'vm-ov', accountUuid: 'acc-ov' })
    runtimeRepo.upsert({ account_id: 'acc-ov', vm_id: 'vm-ov', status: 'ready' })
    runtimeRepo.updateWindow('acc-ov', {
      vmId: 'vm-ov',
      rateLimitedAt: T0,
      rateLimitResetAt: T0 + 3 * 3600_000,
      overloadUntil: T2 + 10 * 60_000,
    })
    const { transport } = scriptedTransport({ clears: ['five_hour'] })
    await buildClaudeResetRedeem({
      cfg,
      accountQuota: quota,
      id: 'vm-ov',
      idempotencyKey: 'op-ov',
      transport,
      now: () => T1,
    })
    quota.ingestOAuthUsage('acc-ov', officialZeroProbe(T2), {
      startedAt: T2,
      resetGenerations: quota.resetGenerations('acc-ov'),
      now: T2,
    })
    assert.ok(runtimeRepo.get('acc-ov').rate_limit_reset_at > T2)
    assert.ok(runtimeRepo.get('acc-ov').overload_until > T2)
  }

  // 3c. Post-reset 429 (rate_limited_at > reset boundary) is NOT cleared by reconciling an earlier reset.
  {
    const { cfg, quota, runtimeRepo } = makeFixture(t, { vmId: 'vm-post429', accountUuid: 'acc-post429' })
    runtimeRepo.upsert({ account_id: 'acc-post429', vm_id: 'vm-post429', status: 'ready' })
    const { transport } = scriptedTransport({ clears: ['five_hour'] })
    await buildClaudeResetRedeem({
      cfg,
      accountQuota: quota,
      id: 'vm-post429',
      idempotencyKey: 'op-post429',
      transport,
      now: () => T1,
    })
    // A brand new 429 happens at T2 (AFTER reset T1).
    runtimeRepo.updateWindow('acc-post429', {
      vmId: 'vm-post429',
      rateLimitedAt: T2,
      rateLimitResetAt: T2 + 3 * 3600_000,
    })
    quota.ingestOAuthUsage('acc-post429', officialZeroProbe(T3), {
      startedAt: T3,
      resetGenerations: quota.resetGenerations('acc-post429'),
      now: T3,
    })
    assert.ok(runtimeRepo.get('acc-post429').rate_limit_reset_at > T3)
  }
})

test('#1758 minors 2, 3, 4: per-window 429 reconcile, stale official/allocation guard, and import-commit timing', async (t) => {
  // Minor #2: 5h 429 must not prematurely reconcile 7d when 7d utilization is absent.
  {
    const { cfg, quota } = makeFixture(t, { vmId: 'vm-m2', accountUuid: 'acc-m2' })
    seedPreResetHeaders(quota, 'acc-m2', { u5: 0.84, u7: 0.76, now: T0 })
    const { transport } = scriptedTransport({ clears: ['five_hour', 'seven_day'] })
    await buildClaudeResetRedeem({
      cfg,
      accountQuota: quota,
      id: 'vm-m2',
      idempotencyKey: 'op-m2',
      transport,
      now: () => T1,
    })
    const gens = quota.resetGenerations('acc-m2')
    quota.ingestHeaders(
      'acc-m2',
      {
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-reset': RESET_5H_OLD,
        'anthropic-ratelimit-unified-7d-status': 'allowed',
      },
      null,
      { exhausted: true, countRequest: false, requestStartedAt: T2, resetGenerations: gens, now: T2 },
    )
    const acc = quota.repo.get('acc-m2')
    assert.equal(acc.unified.reset_boundaries['5h'].reconciled, true)
    assert.equal(acc.unified.reset_boundaries['7d'].reconciled, false)
    assert.equal(acc.unified.headers['7d'].utilization, 0.76)
  }

  // Minor #3: open header reconciliation clears stale pre-reset limited official window;
  // healOfficialOverwriteExtra ignores pre-reset header allocations.
  {
    const { cfg, quota } = makeFixture(t, { vmId: 'vm-m3', accountUuid: 'acc-m3' })
    // Seed pre-reset 84% header allocation + limited official 100%.
    seedPreResetHeaders(quota, 'acc-m3', { u5: 0.84, u7: 0.76, now: T0 })
    const seeded = quota.repo.get('acc-m3')
    seeded.unified.official = {
      '5h': { utilization: 1, status: 'rejected', reset: new Date(Number(RESET_5H_OLD) * 1000).toISOString() },
      '7d': { utilization: 1, status: 'rejected', reset: RESET_7D_OFFICIAL },
    }
    seeded.unified['5h'] = { ...seeded.unified.official['5h'] }
    seeded.unified['7d'] = { ...seeded.unified.official['7d'] }
    quota.repo.save(seeded)

    const { transport } = scriptedTransport({ clears: ['five_hour', 'seven_day'] })
    await buildClaudeResetRedeem({
      cfg,
      accountQuota: quota,
      id: 'vm-m3',
      idempotencyKey: 'op-m3',
      transport,
      now: () => T1,
    })
    const gens = quota.resetGenerations('acc-m3')
    quota.ingestHeaders(
      'acc-m3',
      {
        'anthropic-ratelimit-unified-5h-utilization': '0.05',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor((T2 + 5 * 3600_000) / 1000)),
      },
      null,
      { requestStartedAt: T2, resetGenerations: gens, now: T2 },
    )
    const afterOpen = quota.repo.get('acc-m3')
    assert.equal(afterOpen.unified.official['5h'].status, 'allowed')
    assert.equal(afterOpen.unified.official['5h'].utilization, 0.05)
    assert.equal(afterOpen.unified['5h'].status, 'allowed')
    assert.equal(afterOpen.unified['5h'].utilization, 0.05)

    // Pre-reset 84% allocation at T0 must not heal a post-reset 100% official reading at T3.
    const { cfg: cfg3b, quota: quota3b } = makeFixture(t, { vmId: 'vm-m3b', accountUuid: 'acc-m3b' })
    seedPreResetHeaders(quota3b, 'acc-m3b', { u5: 0.84, u7: 0.2, now: T0 })
    const { transport: t3b } = scriptedTransport({ clears: ['five_hour'] })
    await buildClaudeResetRedeem({
      cfg: cfg3b,
      accountQuota: quota3b,
      id: 'vm-m3b',
      idempotencyKey: 'op-m3b',
      transport: t3b,
      now: () => T1,
    })
    const gens3b = quota3b.resetGenerations('acc-m3b')
    quota3b.ingestOAuthUsage(
      'acc-m3b',
      {
        ok: true,
        usage_status: 200,
        limits_present: true,
        probed_at: new Date(T2).toISOString(),
        five_hour: {
          utilization: 100,
          resets_at: new Date(T2 + 5 * 3600_000).toISOString(),
          status: 'rejected',
        },
        seven_day: { utilization: 20, resets_at: RESET_7D_OFFICIAL, status: 'allowed' },
      },
      { startedAt: T2, resetGenerations: gens3b, now: T2 },
    )
    const afterFull = quota3b.repo.get('acc-m3b')
    assert.equal(afterFull.unified.headers['5h'].utilization, 1)
    assert.equal(afterFull.unified.headers['5h'].status, 'rejected')
  }

  // Minor #4: officialCcStatsHandler captures startedAt & resetGenerations before stats arrive.
  {
    const { cfg, quota } = makeFixture(t, { vmId: 'vm-m4', accountUuid: 'acc-m4' })
    seedPreResetHeaders(quota, 'acc-m4', { u5: 0.84, u7: 0.76, now: T0 })
    const { officialCcStatsHandler } = createImportCommit({
      cfg,
      accountQuota: quota,
      routingConfig: {},
      applyVmConcurrency() {},
    })
    // Handler created before reset (captures gen 0 and pre-reset startedAt).
    const onStats = officialCcStatsHandler('vm-m4', 'acc-m4')

    const { transport } = scriptedTransport({ clears: ['five_hour', 'seven_day'] })
    await buildClaudeResetRedeem({
      cfg,
      accountQuota: quota,
      id: 'vm-m4',
      idempotencyKey: 'op-m4',
      transport,
      now: () => T1,
    })
    quota.ingestOAuthUsage('acc-m4', officialZeroProbe(T2), {
      startedAt: T2,
      resetGenerations: quota.resetGenerations('acc-m4'),
      now: T2,
    })
    assert.equal(listQuotaFromHeaders(quota.repo.get('acc-m4').unified, { now: T2 }).utilization_5h, 0)

    // Pre-reset bootstrap stats finish late -> must be ignored!
    onStats({
      five_hour: { utilization: 84, resets_at: new Date(Number(RESET_5H_OLD) * 1000).toISOString(), status: 'allowed' },
      seven_day: { utilization: 76, resets_at: RESET_7D_OFFICIAL, status: 'allowed_warning' },
    })
    assert.equal(listQuotaFromHeaders(quota.repo.get('acc-m4').unified, { now: T3 }).utilization_5h, 0)
    assert.equal(listQuotaFromHeaders(quota.repo.get('acc-m4').unified, { now: T3 }).utilization_7d, 0)
  }
})

test('#1776 legacy 1.4.168 receipt without account_id never contaminates rebound slot account', async (t) => {
  const { dataDir, cfg, quota, writeVm } = makeFixture(t, { vmId: 'vm-1', accountUuid: 'acc-B', schedulable: true })
  const opKey = claudeResetOperationId('vm-1', 'legacy-168-op')
  const orgKey = claudeResetOrgId(ORG)
  fs.writeFileSync(
    path.join(dataDir, 'claude-reset-state.json'),
    JSON.stringify({
      version: 1,
      operations: {
        [opKey]: {
          outcome: 'reset',
          kind: 'full',
          cleared: ['five_hour', 'seven_day', 'seven_day_overage_included'],
          at: new Date(T1).toISOString(),
        },
      },
      fences: {
        [orgKey]: {
          operation: opKey,
          state: 'reset',
          at: new Date(T1).toISOString(),
        },
      },
    }),
  )

  // Slot vm-1 was rebound to acc-B, which produced real 76% weekly consumption at T2 > T1.
  writeVm('vm-1', 'acc-B', true)
  seedPreResetHeaders(quota, 'acc-B', { u5: 0.42, u7: 0.76, now: T2 })

  const { transport } = scriptedTransport({ clears: ['five_hour', 'seven_day', 'seven_day_overage_included'] })
  const replay = await buildClaudeResetRedeem({
    cfg,
    accountQuota: quota,
    id: 'vm-1',
    idempotencyKey: 'legacy-168-op',
    transport,
    now: () => T3,
  })
  assert.equal(replay.ok, true)
  assert.equal(replay.data.outcome, 'reset')
  assert.equal(replay.data.replayed, true)

  // Unattributed 1.4.168 receipt must never create reset_boundaries on acc-B or invalidate acc-B's 76% usage.
  assert.equal(quota.repo.get('acc-B').unified.reset_boundaries ?? null, null)
  assert.deepEqual(quota.resetGenerations('acc-B'), { '5h': 0, '7d': 0, '7d_oi': 0 })

  quota.ingestOAuthUsage('acc-B', officialZeroProbe(T4), { startedAt: T4, now: T4 })
  const listedB = listQuotaFromHeaders(quota.repo.get('acc-B').unified, { now: T4 })
  assert.equal(listedB.utilization_5h, 0.42)
  assert.equal(listedB.utilization_7d, 0.76)
})
