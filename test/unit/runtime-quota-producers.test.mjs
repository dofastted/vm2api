import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { SchedulingRuntime } from '../../src/lib/pool/scheduling-runtime.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { RateLimitService } from '../../src/lib/pool/rate-limit-service.mjs'

async function fixture() {
  const db = getDb()
  const peer = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  const left = await new SchedulingRuntime(db).init()
  const right = await new SchedulingRuntime(peer).init()
  const quota = await new AccountQuota({ db, config: {} }).init()
  quota.ensure({ account_id: 'producer-account', vm_id: 'producer-vm' })
  left.upsert({ account_id: 'producer-account', vm_id: 'producer-vm', status: 'ready' })
  await left.flush()
  await right.refresh()
  quota.attachRuntimeRepo(left)
  return { left, right, quota, service: new RateLimitService({ runtimeRepo: left, accountQuota: quota }) }
}

for (const producer of ['headers', 'oauth-usage']) {
  test(`an older AccountQuota ${producer} result cannot overwrite a newer runtime session window`, async () => {
    const { left, right, quota } = await fixture()
    const older = await quota.beginObservation()
    const newer = await right.beginObservation()
    const end = Date.now() + 3600_000
    right.updateWindow('producer-account', {
      sessionWindowStatus: 'rejected',
      sessionWindowEnd: end,
      observation: newer,
    })
    await right.flush()
    if (producer === 'headers') {
      quota.ingestHeaders(
        'producer-account',
        {
          'anthropic-ratelimit-unified-5h-status': 'allowed',
          'anthropic-ratelimit-unified-5h-reset': new Date(end - 1000).toISOString(),
        },
        null,
        { observation: older },
      )
    } else {
      quota.ingestOAuthUsage(
        'producer-account',
        {
          ok: true,
          usage_status: 200,
          limits_present: true,
          five_hour: { status: 'allowed', utilization: 10, resets_at: new Date(end - 1000).toISOString() },
        },
        { observation: older },
      )
    }
    await left.flush()
    const stored = await left.persistence.get('producer-account')
    assert.equal(stored.session_window_status, 'rejected')
    assert.equal(stored.session_window_end, end)
  })
}

for (const status of [429, 529]) {
  test(`a late ${status} result retains its original observation and cannot extend a newer block`, async () => {
    const { left, right, service } = await fixture()
    const older = await left.beginObservation()
    const newer = await right.beginObservation()
    const until = Date.now() + 90 * 60_000
    const field = status === 429 ? 'rate_limit_reset_at' : 'overload_until'
    right.updateWindow('producer-account', {
      ...(status === 429 ? { rateLimitResetAt: until } : { overloadUntil: until }),
      observation: newer,
    })
    await right.flush()
    await service.handleUpstreamError({
      accountId: 'producer-account',
      vmId: 'producer-vm',
      result: { status, accountObservation: older, body: { error: { message: 'synthetic limit' } } },
      policy: { scope: 'account', reason: status === 429 ? 'account_quota_exhausted' : 'provider_overloaded' },
    })
    await left.flush()
    assert.equal((await left.persistence.get('producer-account'))[field], until)
  })
}

test('an older allowed response cannot clear a newer runtime rate limit', async () => {
  const { left, right, service } = await fixture()
  const older = await left.beginObservation()
  const newer = await right.beginObservation()
  const until = Date.now() + 3600_000
  right.updateWindow('producer-account', {
    rateLimitResetAt: until,
    sessionWindowStatus: 'rejected',
    observation: newer,
  })
  await right.flush()
  await left.refresh()
  await service.updateSessionWindow({
    accountId: 'producer-account',
    vmId: 'producer-vm',
    observation: older,
    headers: { 'anthropic-ratelimit-unified-5h-status': 'allowed' },
  })
  await left.flush()
  const stored = await left.persistence.get('producer-account')
  assert.equal(stored.rate_limit_reset_at, until)
  assert.equal(stored.session_window_status, 'rejected')
})

test('quota clearing cannot restore a stale worker snapshot or clear a peer cooldown', async () => {
  const { left, right, quota } = await fixture()
  left.upsert({
    account_id: 'producer-account',
    cooldown_until: Date.now() + 1000,
    cooldown_reason: 'quota_guard',
    worker_status: { generation: 1 },
  })
  await left.flush()
  await right.refresh()
  const until = Date.now() + 3600_000
  right.markCooldown('producer-account', { vmId: 'producer-vm', until, reason: 'account_quota_exhausted' })
  right.upsert({ account_id: 'producer-account', worker_status: { generation: 2 } })
  await right.flush()
  let callbacks = 0
  quota.onQuotaCooldownCleared = () => {
    callbacks++
  }
  const cleared = await quota.clearQuotaExhaustedCooldown('producer-account')
  await left.flush()
  assert.equal(cleared, false)
  assert.equal(callbacks, 0)
  const stored = await left.persistence.get('producer-account')
  assert.equal(stored.cooldown_until, until)
  assert.equal(stored.worker_status.generation, 2)
})

test('quota-cleared callbacks wait until the queued PG clearing has committed', async () => {
  const { left, quota } = await fixture()
  left.upsert({ account_id: 'producer-account', cooldown_until: Date.now() + 1000, cooldown_reason: 'quota_guard' })
  await left.flush()
  let release
  const paused = new Promise((resolve) => {
    release = resolve
  })
  left.writes.enqueue(() => paused)
  let callbacks = 0
  quota.onQuotaCooldownCleared = () => {
    callbacks++
  }
  const clearing = quota.clearQuotaExhaustedCooldown('producer-account')
  try {
    await setImmediate()
    assert.equal(callbacks, 0, 'cache eligibility is not proof that PG accepted the clearing')
  } finally {
    release()
    await clearing
    await left.flush()
  }
  assert.equal(callbacks, 1)
  assert.equal((await left.persistence.get('producer-account')).cooldown_until, null)
})
