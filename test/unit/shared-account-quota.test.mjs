import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'

async function pair(t) {
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(() => other.close())
  const left = await new AccountQuota({ db, config: {} }).init()
  left.ensure({ account_id: 'shared-account', vm_id: 'vm-a' })
  await left.flush()
  const right = await new AccountQuota({ db: other, config: {} }).init()
  return { left, right }
}

test('independent account caches persist additive exact usage without losing other replica increments', async (t) => {
  const { left, right } = await pair(t)
  left.ingestHeaders(
    'shared-account',
    {},
    {
      input_tokens: '9007199254740993',
      output_tokens: 3,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 5,
    },
  )
  await left.flush()
  right.ingestHeaders(
    'shared-account',
    {},
    {
      input_tokens: 7,
      output_tokens: 11,
      cache_read_input_tokens: 13,
      cache_creation_input_tokens: 17,
    },
  )
  right.ingestHeaders('shared-account', {}, { input_tokens: 100 }, { countRequest: false })
  await right.flush()
  const saved = await left.persistence.get('shared-account')
  assert.equal(saved.requests, 2)
  assert.equal(saved.tokens_in, '9007199254741000')
  assert.equal(saved.tokens_out, 14)
  assert.equal(saved.cache_read_tokens, 17)
  assert.equal(saved.cache_creation_tokens, 22)
})

test('a stale probe cache preserves another replica management fields and usage', async (t) => {
  const { left, right } = await pair(t)
  left.setMaxConcurrency('shared-account', 9, { override: true })
  left.setMaxRpm('shared-account', 123, { override: true })
  left.rebindToVm('shared-account', 'vm-b', { email: 'new@example.test' })
  left.ingestHeaders('shared-account', {}, { input_tokens: 7 })
  await left.flush()
  right.ingestOAuthUsage('shared-account', {
    ok: true,
    limits_present: true,
    five_hour: { utilization: 42 },
  })
  await right.flush()
  const saved = await left.persistence.get('shared-account')
  assert.equal(saved.max_concurrency, 9)
  assert.equal(saved.concurrency_override, 1)
  assert.equal(saved.max_rpm, 123)
  assert.equal(saved.rpm_override, 1)
  assert.equal(saved.vm_id, 'vm-b')
  assert.equal(saved.email, 'new@example.test')
  assert.equal(saved.requests, 1)
  assert.equal(saved.tokens_in, 7)
})

test('concurrent ensure on independent connections inserts one account without replacing it', async (t) => {
  const { left, right } = await pair(t)
  let arrived = 0
  let ready
  const gate = new Promise((resolve) => {
    ready = resolve
  })
  for (const quota of [left, right]) {
    const get = quota.persistence.get.bind(quota.persistence)
    quota.persistence.get = async (id) => {
      const row = await get(id)
      if (id === 'concurrent-account' && !row) {
        if (++arrived === 2) ready()
        await gate
      }
      return row
    }
    quota.ensure({ account_id: 'concurrent-account', vm_id: 'vm-a' })
  }
  await Promise.all([left.flush(), right.flush()])
  assert.equal((await left.persistence.list()).filter((row) => row.account_id === 'concurrent-account').length, 1)
})

test('an older probe finishing after a newer observation cannot overwrite the newer usage window', async (t) => {
  const { left, right } = await pair(t)
  const oldObservation = await left.beginObservation()
  const newObservation = await right.beginObservation()
  right.ingestOAuthUsage(
    'shared-account',
    {
      ok: true,
      limits_present: true,
      five_hour: { utilization: 81 },
    },
    { observation: newObservation },
  )
  await right.flush()
  left.ingestOAuthUsage(
    'shared-account',
    {
      ok: true,
      limits_present: true,
      five_hour: { utilization: 12 },
    },
    { observation: oldObservation },
  )
  await left.flush()
  const saved = await left.persistence.get('shared-account')
  assert.equal(saved.unified['5h'].utilization, 0.81)
  assert.equal(left.repo.get('shared-account').unified['5h'].utilization, 0.81)
})
