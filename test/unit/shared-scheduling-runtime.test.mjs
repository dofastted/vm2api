import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { SchedulingRuntime } from '../../src/lib/pool/scheduling-runtime.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function pair(t, seed = {}) {
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(() => other.close())
  const left = await new SchedulingRuntime(db).init()
  left.upsert({ account_id: 'runtime-account', vm_id: 'vm-old', status: 'ready', priority: 3, weight: 2, ...seed })
  await left.flush()
  const right = await new SchedulingRuntime(other).init()
  return { left, right, stored: () => left.persistence.get('runtime-account') }
}

for (const producer of ['window', 'heartbeat']) {
  test(`a stale ${producer} update preserves another controller's VM, priority and cooldown`, async (t) => {
    const { left, right, stored } = await pair(t)
    const until = Date.now() + 120_000
    left.upsert({ account_id: 'runtime-account', vm_id: 'vm-new', priority: 19, weight: 7 })
    left.markCooldown('runtime-account', { vmId: 'vm-new', until, reason: 'account_quota_exhausted' })
    await left.flush()
    if (producer === 'window')
      right.updateWindow('runtime-account', { vmId: 'vm-old', sessionWindowStatus: 'rejected' })
    else
      right.upsert({
        account_id: 'runtime-account',
        vm_id: 'vm-old',
        worker_heartbeat_at: Date.now(),
        worker_status: { ok: true },
      })
    await right.flush()
    const state = await stored()
    assert.equal(state.vm_id, 'vm-new')
    assert.equal(state.priority, 19)
    assert.equal(state.weight, 7)
    assert.equal(state.cooldown_until, until)
    assert.equal(state.rate_limit_reset_at, until)
  })
}

test('different model cooldowns merge across independent runtime caches', async (t) => {
  const { left, right, stored } = await pair(t)
  const until = Date.now() + 90_000
  left.markCooldown('runtime-account', { vmId: 'vm-old', model: 'claude-a', until, reason: 'model-a-limit' })
  await left.flush()
  right.markCooldown('runtime-account', {
    vmId: 'vm-old',
    model: 'claude-b',
    until: until + 1000,
    reason: 'model-b-limit',
  })
  await right.flush()
  const state = await stored()
  assert.deepEqual(Object.keys(state.model_states).sort(), ['claude-a', 'claude-b'])
  assert.equal(state.model_states['claude-a'].cooldown_until, until)
  assert.equal(state.model_states['claude-b'].cooldown_until, until + 1000)
})

test("a late local expiry cannot clear another controller's extended account, hard or model cooldown", async (t) => {
  const now = Date.now()
  const { left, right, stored } = await pair(t, {
    status: 'cooldown',
    cooldown_until: now - 1,
    cooldown_reason: 'account_quota_exhausted',
    rate_limit_reset_at: now - 1,
    overload_until: now - 1,
    model_states: { 'claude-a': { cooldown_until: now - 1, reason: 'old' } },
  })
  const until = now + 120_000
  left.markCooldown('runtime-account', { vmId: 'vm-old', until, reason: 'account_quota_exhausted' })
  left.updateWindow('runtime-account', { overloadUntil: until })
  left.markCooldown('runtime-account', { vmId: 'vm-old', model: 'claude-a', until, reason: 'new' })
  await left.flush()
  right.clearExpired(now)
  await right.flush()
  const state = await stored()
  assert.equal(state.cooldown_until, until)
  assert.equal(state.rate_limit_reset_at, until)
  assert.equal(state.overload_until, until)
  assert.equal(state.model_states['claude-a'].cooldown_until, until)
})

test('a stale auth clear preserves a new quota cooldown while explicit management clear removes the current state', async (t) => {
  const { left, right, stored } = await pair(t, {
    status: 'cooldown',
    cooldown_until: Date.now() + 1000,
    cooldown_reason: 'authentication_failed_after_refresh',
  })
  const until = Date.now() + 90_000
  left.markCooldown('runtime-account', { vmId: 'vm-old', until, reason: 'account_quota_exhausted' })
  left.markCooldown('runtime-account', { vmId: 'vm-old', until, reason: 'model-limit', model: 'claude-a' })
  await left.flush()
  right.clearAuthCooldown('runtime-account')
  await right.flush()
  assert.equal((await stored()).cooldown_until, until)
  assert.equal((await stored()).cooldown_reason, 'account_quota_exhausted')
  right.clearAccountCooldown('runtime-account')
  await right.flush()
  const cleared = await stored()
  assert.equal(cleared.cooldown_until, null)
  assert.equal(cleared.rate_limit_reset_at, null)
  assert.deepEqual(cleared.model_states, {})
  assert.equal(cleared.priority, 3)
})

test('database observation tickets reject an older worker or allowed-window completion', async (t) => {
  const { left, right, stored } = await pair(t)
  const older = await left.beginObservation()
  const newer = await right.beginObservation()
  const until = Date.now() + 90_000
  right.upsert(
    {
      account_id: 'runtime-account',
      vm_id: 'vm-old',
      worker_status: { ok: true, generation: 2 },
      worker_heartbeat_at: 200,
    },
    { observation: newer },
  )
  right.updateWindow('runtime-account', {
    rateLimitResetAt: until,
    sessionWindowStatus: 'rejected',
    observation: newer,
  })
  await right.flush()
  left.upsert(
    {
      account_id: 'runtime-account',
      vm_id: 'vm-old',
      worker_status: { ok: false, generation: 1 },
      worker_heartbeat_at: 100,
    },
    { observation: older },
  )
  left.updateWindow('runtime-account', { rateLimitResetAt: null, sessionWindowStatus: 'allowed', observation: older })
  await left.flush()
  const state = await stored()
  assert.deepEqual(state.worker_status, { ok: true, generation: 2 })
  assert.equal(state.worker_heartbeat_at, 200)
  assert.equal(state.rate_limit_reset_at, until)
  assert.equal(state.session_window_status, 'rejected')
})

test('runtime refresh publishes committed peer rows and preserves a later local mutation', async (t) => {
  const { left, right } = await pair(t)
  right.upsert({ account_id: 'runtime-account', vm_id: 'vm-new', priority: 21 })
  await right.flush()
  await left.refresh()
  assert.equal(left.get('runtime-account').vm_id, 'vm-new')
  assert.equal(left.get('runtime-account').priority, 21)
  const entered = deferred()
  const resume = deferred()
  const list = left.persistence.list.bind(left.persistence)
  left.persistence.list = async () => {
    const rows = await list()
    entered.resolve()
    await resume.promise
    return rows
  }
  const pending = left.refresh()
  try {
    await entered.promise
    left.upsert({ account_id: 'runtime-account', vm_id: 'vm-new', priority: 31 })
    await left.flush()
  } finally {
    resume.resolve()
    await pending
  }
  assert.equal(left.get('runtime-account').priority, 31)
})

test('an older runtime refresh finishing late cannot replace a newer committed peer snapshot', async (t) => {
  const { left, right } = await pair(t)
  const entered = deferred()
  const resume = deferred()
  const list = left.persistence.list.bind(left.persistence)
  let first = true
  left.persistence.list = async () => {
    const rows = await list()
    if (first) {
      first = false
      entered.resolve()
      await resume.promise
    }
    return rows
  }
  const pending = left.refresh()
  try {
    await entered.promise
    right.upsert({ account_id: 'runtime-account', vm_id: 'vm-new', priority: 41 })
    await right.flush()
    await left.refresh()
  } finally {
    resume.resolve()
    await pending
  }
  assert.equal(left.get('runtime-account').priority, 41)
})
