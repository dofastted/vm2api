import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { closeCacheRuntime, initCacheRuntime } from '../../src/lib/cache/index.mjs'
import { AccountRuntimeRepo } from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { RateLimitService, anthropic429Reset, hardBlockOf } from '../../src/lib/pool/rate-limit-service.mjs'

function setup(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-rate-limit-'))
  const db = createDatabase({ dataDir: dir })
  const runtimeRepo = new AccountRuntimeRepo(db)
  const accountQuota = new AccountQuota({ db, config: {} })
  accountQuota.attachRuntimeRepo(runtimeRepo)
  runtimeRepo.upsert({ account_id: 'acc-1', vm_id: 'vm-01', status: 'ready' })
  const probes = []
  const service = new RateLimitService({
    runtimeRepo,
    accountQuota,
    config,
    onUsageProbe: (item) => probes.push(item),
  })
  const close = () => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { service, runtimeRepo, accountQuota, probes, close }
}

const quotaPolicy = { scope: 'account', reason: 'account_quota_exhausted' }

function limitResult(message) {
  return {
    ok: false,
    status: 429,
    committed: false,
    body: { type: 'error', error: { type: 'api_error', message } },
    headers: {},
  }
}

test('plan limit writes rate_limit_reset_at from the text and survives a passive Extra re-read', () => {
  const { service, runtimeRepo, accountQuota, probes, close } = setup()
  try {
    const now = Date.now()
    const block = service.handleUpstreamError({
      accountId: 'acc-1',
      vmId: 'vm-01',
      result: limitResult("provider error: You've hit your limit · resets 11am (America/New_York)"),
      policy: quotaPolicy,
      now,
    })
    assert.equal(block.kind, 'rate_limited')
    assert.equal(block.fallback, false)
    assert.ok(block.until > now && block.until <= now + 24 * 3600_000)
    const state = runtimeRepo.get('acc-1')
    assert.equal(state.rate_limit_reset_at, Math.floor(block.until / 1000) * 1000)
    assert.equal(state.session_window_status, 'rejected')
    assert.deepEqual(hardBlockOf(state, now), { reason: 'rate_limited', until: state.rate_limit_reset_at })
    // Every upstream 429 asks /usage once (throttled per account), even with a parsed reset.
    assert.equal(probes.length, 1)
    // Passive Extra saying "under safety" must not lift the 429 block.
    accountQuota.clearQuotaExhaustedCooldown('acc-1')
    assert.equal(runtimeRepo.get('acc-1').rate_limit_reset_at, state.rate_limit_reset_at)
  } finally {
    close()
  }
})

test('plan limit without any reset falls back to the configured cooldown and asks for one /usage hop', () => {
  const { service, runtimeRepo, probes, close } = setup({ fallback_cooldown_min: 30 })
  try {
    const now = Date.now()
    const block = service.handleUpstreamError({
      accountId: 'acc-1',
      vmId: 'vm-01',
      result: limitResult("You've hit your limit"),
      policy: quotaPolicy,
      now,
    })
    assert.equal(block.fallback, true)
    assert.equal(block.until, now + 30 * 60_000)
    assert.equal(Math.abs(runtimeRepo.get('acc-1').rate_limit_reset_at - block.until) < 1000, true)
    assert.deepEqual(probes, [{ accountId: 'acc-1', vmId: 'vm-01' }])
  } finally {
    close()
  }
})

test('model-scoped 429 does not write an account hard block', () => {
  const { service, runtimeRepo, close } = setup()
  try {
    const block = service.handleUpstreamError({
      accountId: 'acc-1',
      vmId: 'vm-01',
      result: limitResult('rate limited'),
      policy: { scope: 'model', reason: 'opus_rate_limited' },
    })
    assert.equal(block, null)
    assert.equal(runtimeRepo.get('acc-1').rate_limit_reset_at, null)
  } finally {
    close()
  }
})

test('#163: an unknown bare 429 asks for one usage probe and fabricates no 5h block', () => {
  const { service, runtimeRepo, probes, close } = setup()
  try {
    const block = service.handleUpstreamError({
      accountId: 'acc-1',
      vmId: 'vm-01',
      result: limitResult('Rate limited'),
      policy: { scope: 'account', reason: 'rate_limited_unknown' },
    })
    assert.equal(block, null)
    assert.equal(runtimeRepo.get('acc-1').rate_limit_reset_at, null)
    assert.deepEqual(probes, [{ accountId: 'acc-1', vmId: 'vm-01' }])
  } finally {
    close()
  }
})

test('529 writes overload_until for the configured minutes', () => {
  const { service, runtimeRepo, close } = setup({ overload_cooldown_min: 10 })
  try {
    const now = Date.now()
    const block = service.handleUpstreamError({
      accountId: 'acc-1',
      vmId: 'vm-01',
      result: { status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } },
      policy: { scope: 'provider', reason: 'provider_overloaded' },
      now,
    })
    assert.equal(block.until, now + 10 * 60_000)
    assert.equal(hardBlockOf(runtimeRepo.get('acc-1'), now).reason, 'overloaded')
  } finally {
    close()
  }
})

test('only a live allowed header lifts a rate limit early', () => {
  const { service, runtimeRepo, close } = setup()
  try {
    const now = Date.now()
    service.handleUpstreamError({
      accountId: 'acc-1',
      vmId: 'vm-01',
      result: limitResult("You've hit your limit · resets 11pm (UTC)"),
      policy: quotaPolicy,
      now,
    })
    const reset = String(Math.floor((now + 4 * 3600_000) / 1000))
    service.updateSessionWindow({
      accountId: 'acc-1',
      headers: { 'anthropic-ratelimit-unified-5h-status': 'allowed_warning' },
      now,
    })
    assert.ok(hardBlockOf(runtimeRepo.get('acc-1'), now))
    const lifted = service.updateSessionWindow({
      accountId: 'acc-1',
      headers: {
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-reset': reset,
      },
      now,
    })
    assert.equal(lifted, true)
    const state = runtimeRepo.get('acc-1')
    assert.equal(hardBlockOf(state, now), null)
    assert.equal(state.session_window_end, Number(reset) * 1000)
  } finally {
    close()
  }
})

test('an out-of-range 5h reset header is ignored for the session window', () => {
  const { service, runtimeRepo, close } = setup()
  try {
    const now = Date.now()
    service.updateSessionWindow({
      accountId: 'acc-1',
      headers: {
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now - 10 * 3600_000) / 1000)),
      },
      now,
    })
    assert.equal(runtimeRepo.get('acc-1').session_window_end, null)
  } finally {
    close()
  }
})

test('clearExpired drops elapsed rate limit and overload columns', () => {
  const { runtimeRepo, close } = setup()
  try {
    const now = Date.now()
    runtimeRepo.updateWindow('acc-1', { rateLimitResetAt: now - 1000, overloadUntil: now - 1000 })
    runtimeRepo.clearExpired(now)
    const state = runtimeRepo.get('acc-1')
    assert.equal(state.rate_limit_reset_at, null)
    assert.equal(state.overload_until, null)
  } finally {
    close()
  }
})

test('an incomplete hop does not write an empty_response cooldown', () => {
  const { service, runtimeRepo, close } = setup({ empty_response_cooldown_sec: 60 })
  try {
    const block = service.handleUpstreamError({
      accountId: 'acc-1',
      vmId: 'vm-01',
      result: { status: 200, committed: false, terminalState: 'incomplete' },
      policy: { reason: 'empty_response', scope: 'stream' },
      now: 1_700_000_000_000,
    })
    assert.equal(block, null)
    assert.equal(runtimeRepo.get('acc-1').cooldown_until, null)
    assert.equal(typeof service.noteDistinctEmptyHop, 'undefined')
  } finally {
    close()
  }
})

test('anthropic429Reset prefers an exhausted 7d window over 5h', () => {
  const now = 1_700_000_000_000
  const out = anthropic429Reset(
    {
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': String((now + 3600_000) / 1000),
      'anthropic-ratelimit-unified-7d-status': 'rejected',
      'anthropic-ratelimit-unified-7d-reset': String((now + 86_400_000) / 1000),
    },
    now,
  )
  assert.equal(out.window, '7d')
  assert.equal(out.resetAt, now + 86_400_000)
})

test('PG mode: 200 session windows batch asynchronously with 0 sync repo calls; 429/529/unblock immediately update L1, bump revision, and flush via pgPool', async (t) => {
  await closeCacheRuntime()
  const cacheRt = await initCacheRuntime({ redisConfig: null })
  t.after(async () => {
    await closeCacheRuntime()
  })

  const pgQueries = []
  let failNext = false
  const mockPgPool = {
    async query(sql, params) {
      if (failNext) {
        failNext = false
        throw new Error('transient pg write error')
      }
      pgQueries.push({ sql: String(sql), params })
      return { rows: [], rowCount: 1 }
    },
  }

  let syncCalls = 0
  const forbidSyncRepo = {
    db: { engine: 'postgres' },
    get() {
      syncCalls += 1
      throw new Error('PG mode must NOT call sync runtimeRepo.get')
    },
    updateWindow() {
      syncCalls += 1
      throw new Error('PG mode must NOT call sync runtimeRepo.updateWindow')
    },
  }

  const svc = new RateLimitService({
    runtimeRepo: forbidSyncRepo,
    pgPool: mockPgPool,
    flushIntervalMs: 60_000,
  })
  t.after(() => svc.close())

  const now = 1_750_000_000_000
  const reset5hSec = String(Math.floor((now + 4 * 3600_000) / 1000))
  const revBefore200 = cacheRt.scheduler.revision

  // 1. Routine 200 response with unified headers -> updates L1, deduplicates, 0 sync calls, no revision storm
  const lifted1 = svc.updateSessionWindow({
    accountId: 'acc-pg-1',
    vmId: 'vm-pg-1',
    headers: {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-reset': reset5hSec,
    },
    now,
  })
  assert.equal(lifted1, false)
  assert.equal(syncCalls, 0)
  assert.equal(cacheRt.scheduler.revision, revBefore200, 'routine 200 window update must not bump scheduler revision')
  assert.equal(svc.getL1WindowState('acc-pg-1').session_window_status, 'allowed')
  assert.equal(svc.getL1WindowState('acc-pg-1').session_window_end, Number(reset5hSec) * 1000)

  // Duplicate identical 200 within 60s dedupes completely
  svc.updateSessionWindow({
    accountId: 'acc-pg-1',
    vmId: 'vm-pg-1',
    headers: {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-reset': reset5hSec,
    },
    now: now + 5_000,
  })
  assert.equal(pgQueries.length, 0, 'routine 200 should be buffered until flush')

  // Failure on flush re-queues dirty entry; subsequent flush succeeds via UNNEST
  failNext = true
  const failedFlush = await svc.flushWindowWrites()
  assert.equal(failedFlush.failed, 1)
  const okFlush = await svc.flushWindowWrites()
  assert.equal(okFlush.flushed, 1)
  assert.equal(okFlush.failed, 0)
  const updCall = pgQueries.find((q) => /UPDATE accounts AS a[\s\S]*FROM UNNEST/i.test(q.sql))
  assert.ok(updCall, 'PG flush must use batched UPDATE accounts FROM UNNEST')
  assert.deepEqual(updCall.params[0], ['acc-pg-1'])
  assert.deepEqual(updCall.params[4], [false], 'rate_limit_reset_at flag must stay false on routine 200')
  assert.deepEqual(updCall.params[12], [true], 'session_window_status flag must be true')
  assert.deepEqual(updCall.params[13], ['allowed'])

  // 2. High-risk 429 -> immediately updates L1, bumps scheduler revision, and immediately flushes via pgPool
  pgQueries.length = 0
  const revBefore429 = cacheRt.scheduler.revision
  const block429 = svc.handleUpstreamError({
    accountId: 'acc-pg-1',
    vmId: 'vm-pg-1',
    result: limitResult("You've hit your limit"),
    policy: quotaPolicy,
    now,
  })
  assert.equal(block429.kind, 'rate_limited')
  assert.equal(syncCalls, 0)
  assert.equal(cacheRt.scheduler.revision, revBefore429 + 1, '429 must immediately bump scheduler revision')
  assert.equal(hardBlockOf(svc.getL1WindowState('acc-pg-1'), now).reason, 'rate_limited')
  await svc.flushWindowWrites()
  const upd429 = pgQueries.find((q) => /UPDATE accounts AS a[\s\S]*FROM UNNEST/i.test(q.sql))
  assert.ok(upd429, '429 must flush immediately via pgPool')
  assert.deepEqual(upd429.params[4], [true])
  assert.ok(typeof upd429.params[5][0] === 'string' && upd429.params[5][0].includes('T'))
  assert.deepEqual(upd429.params[13], ['rejected'])

  // 3. Live allowed header lifts active L1 429 block -> bumps revision & immediately clears rate_limit_reset_at
  pgQueries.length = 0
  const revBeforeLift = cacheRt.scheduler.revision
  const lifted = svc.updateSessionWindow({
    accountId: 'acc-pg-1',
    vmId: 'vm-pg-1',
    headers: {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-reset': reset5hSec,
    },
    now: now + 10_000,
  })
  assert.equal(lifted, true)
  assert.equal(syncCalls, 0)
  assert.equal(cacheRt.scheduler.revision, revBeforeLift + 1, 'early rate-limit unblock must bump scheduler revision')
  assert.equal(hardBlockOf(svc.getL1WindowState('acc-pg-1'), now + 10_000), null)
  await svc.flushWindowWrites()
  const updLift = pgQueries.find((q) => /UPDATE accounts AS a[\s\S]*FROM UNNEST/i.test(q.sql))
  assert.ok(updLift)
  assert.deepEqual(updLift.params[4], [true])
  assert.deepEqual(updLift.params[5], [null], 'rate_limit_reset_at must be cleared to NULL in PG')

  // 4. High-risk 529 -> immediately updates L1 overload_until, bumps revision, flushes via pgPool
  pgQueries.length = 0
  const revBefore529 = cacheRt.scheduler.revision
  const block529 = svc.handleUpstreamError({
    accountId: 'acc-pg-2',
    vmId: 'vm-pg-2',
    result: { status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } },
    policy: { scope: 'provider', reason: 'provider_overloaded' },
    now,
  })
  assert.equal(block529.kind, 'overloaded')
  assert.equal(syncCalls, 0)
  assert.equal(cacheRt.scheduler.revision, revBefore529 + 1)
  assert.equal(hardBlockOf(svc.getL1WindowState('acc-pg-2'), now).reason, 'overloaded')
  await svc.flushWindowWrites()
  const upd529 = pgQueries.find((q) => /UPDATE accounts AS a[\s\S]*FROM UNNEST/i.test(q.sql))
  assert.ok(upd529)
  assert.deepEqual(upd529.params[6], [true])
  assert.ok(typeof upd529.params[7][0] === 'string' && upd529.params[7][0].includes('T'))
})
