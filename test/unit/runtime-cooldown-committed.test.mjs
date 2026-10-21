import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { SchedulingRuntime } from '../../src/lib/pool/scheduling-runtime.mjs'

async function fixture() {
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  const left = await new SchedulingRuntime(db).init()
  const right = await new SchedulingRuntime(other).init()
  left.upsert({ account_id: 'cooldown-account', vm_id: 'cooldown-vm', status: 'ready' })
  await left.flush()
  await right.refresh()
  return { left, right }
}

async function mark(runtime, options) {
  if (runtime.markCooldownCommitted) return runtime.markCooldownCommitted('cooldown-account', options)
  const value = runtime.markCooldown('cooldown-account', options)
  await runtime.flush()
  return { applied: !!value, state: runtime.get('cooldown-account') }
}

for (const model of [null, 'claude-test']) {
  test(`an old ${model ? 'model' : 'account'} cooldown reports not applied after a newer observation`, async () => {
    const { left, right } = await fixture()
    const older = await left.beginObservation()
    const newer = await right.beginObservation()
    const until = Date.now() + 90_000
    right.markCooldown('cooldown-account', {
      vmId: 'cooldown-vm',
      model,
      until,
      reason: 'newer-block',
      observation: newer,
    })
    await right.flush()
    const result = await mark(left, {
      vmId: 'cooldown-vm',
      model,
      until: until - 1000,
      reason: 'older-block',
      observation: older,
    })
    assert.equal(result.applied, false)
    assert.equal(model ? result.state.model_states[model].cooldown_until : result.state.cooldown_until, until)
    assert.equal(model ? result.state.model_states[model].reason : result.state.cooldown_reason, 'newer-block')
  })
}

test('committed cooldowns publish cache only after PG accepts the queued mutation', async () => {
  const { left } = await fixture()
  let release
  const paused = new Promise((resolve) => {
    release = resolve
  })
  left.writes.enqueue(() => paused)
  const until = Date.now() + 60_000
  const pending = mark(left, { vmId: 'cooldown-vm', until, reason: 'synthetic-block' })
  try {
    await setImmediate()
    assert.equal(left.get('cooldown-account').cooldown_until, null)
  } finally {
    release()
    await pending
  }
  const result = await pending
  assert.equal(result.applied, true)
  assert.equal(result.state.cooldown_until, until)
  assert.equal((await left.persistence.get('cooldown-account')).cooldown_until, until)
})

test('independent model versions preserve peer cooldowns while accepting an older different-model observation', async () => {
  const { left, right } = await fixture()
  const older = await left.beginObservation()
  const newer = await right.beginObservation()
  const until = Date.now() + 60_000
  right.markCooldown('cooldown-account', {
    vmId: 'cooldown-vm',
    model: 'model-b',
    until,
    reason: 'peer',
    observation: newer,
  })
  await right.flush()
  const result = await mark(left, {
    vmId: 'cooldown-vm',
    model: 'model-a',
    until,
    reason: 'older-independent',
    observation: older,
  })
  assert.equal(result.applied, true)
  assert.equal(result.state.model_states['model-a'].reason, 'older-independent')
  assert.equal(result.state.model_states['model-b'].reason, 'peer')
})
