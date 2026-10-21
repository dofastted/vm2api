import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { buildProbeOne } from '../../src/lib/admin/panel-api.mjs'

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

test('a fresh zero observation and an unchanged observation still supersede older tickets', async (t) => {
  const { left, right } = await pair(t)
  const older = await left.beginObservation()
  const fresh = await right.beginObservation()
  right.ingestOAuthUsage('shared-account', { ok: true, five_hour: { utilization: 0 } }, { observation: fresh })
  await right.flush()
  left.ingestOAuthUsage('shared-account', { ok: true, five_hour: { utilization: 50 } }, { observation: older })
  await left.flush()
  assert.equal((await left.persistence.get('shared-account')).unified['5h'].utilization, 0)
})

test('late header results keep additive usage but cannot replace a newer header observation', async (t) => {
  const { left, right } = await pair(t)
  const observation = await left.beginObservation()
  right.ingestHeaders('shared-account', { 'anthropic-ratelimit-unified-5h-utilization': '0.81' })
  await right.flush()
  left.ingestHeaders(
    'shared-account',
    { 'anthropic-ratelimit-unified-5h-utilization': '0.12' },
    { input_tokens: 7 },
    { observation },
  )
  await left.flush()
  const saved = await left.persistence.get('shared-account')
  assert.equal(saved.requests, 2)
  assert.equal(saved.tokens_in, 7)
  assert.equal(saved.unified.headers['5h'].utilization, 0.81)
})

test('panel probes take their tickets before asynchronous I/O and preserve the newer quota and tier', async (t) => {
  const { left, right } = await pair(t)
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-account-probe-'))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  fs.mkdirSync(path.join(project, 'vms'))
  fs.writeFileSync(
    path.join(project, 'vms/vm-a.json'),
    JSON.stringify({
      id: 'vm-a',
      status: 'stopped',
      claude: { mode: 'oauth', has_access: true, account_uuid: 'shared-account' },
    }),
  )
  let entered
  let resume
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const gate = new Promise((resolve) => {
    resume = resolve
  })
  const args = { cfg: { paths: { project }, rewrite: {} }, id: 'vm-a', force: true, hop: true }
  const oldResult = buildProbeOne({
    ...args,
    accountQuota: left,
    usageCache: {
      clear() {},
      async load() {
        entered()
        await gate
        return {
          ok: true,
          limits_present: true,
          usage_has_fable: false,
          account_tier: 'pro',
          five_hour: { utilization: 12 },
        }
      },
    },
  })
  await started
  await buildProbeOne({
    ...args,
    accountQuota: right,
    usageCache: {
      clear() {},
      async load() {
        return {
          ok: true,
          limits_present: true,
          usage_has_fable: true,
          account_tier: 'max',
          five_hour: { utilization: 81 },
        }
      },
    },
  })
  resume()
  await oldResult
  await Promise.all([left.flush(), right.flush()])
  const saved = await left.persistence.get('shared-account')
  assert.equal(saved.unified['5h'].utilization, 0.81)
  assert.equal(saved.unified.account_tier, 'max')
  assert.equal(saved.unified.usage_has_fable, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, 'vms/vm-a.json'))).claude.account_tier, 'max')
})

test('header observations preserve unrelated official and model fields from another replica', async (t) => {
  const { left, right } = await pair(t)
  right.ingestOAuthUsage('shared-account', { ok: true, seven_day: { utilization: 61 } })
  right.markModelUnsupported('shared-account', 'claude-fable-5')
  await right.flush()
  left.ingestHeaders('shared-account', { 'anthropic-ratelimit-unified-5h-utilization': '0.2' })
  await left.flush()
  const saved = await left.persistence.get('shared-account')
  assert.equal(saved.unified['7d'].utilization, 0.61)
  assert.equal(saved.unified.headers['5h'].utilization, 0.2)
  assert.ok(saved.unified.model_denied_until['claude-fable-5'] > Date.now())
})

test('a stale health check cannot replace remote header windows with an empty initialized object', async (t) => {
  const { left, right } = await pair(t)
  left.ingestHeaders('shared-account', { 'anthropic-ratelimit-unified-5h-utilization': '0.81' })
  await left.flush()
  right.ingestHeaders('shared-account', {}, null, { countRequest: false })
  await right.flush()
  assert.equal((await left.persistence.get('shared-account')).unified.headers['5h'].utilization, 0.81)
})

test('a stale test-chat or rate-limited probe preserves the successful usage probe from another replica', async (t) => {
  const { left, right } = await pair(t)
  left.recordLastProbe('shared-account', { ok: true, source: 'vm-oauth-usage' })
  await left.flush()
  right.recordLastProbe('shared-account', { ok: false, source: 'test-chat', error: 'expired', status: 401 })
  await right.flush()
  let saved = await left.persistence.get('shared-account')
  assert.equal(saved.unified.last_probe.ok, true)
  assert.equal(saved.unified.last_probe.source, 'vm-oauth-usage')
  // A third, independently loaded stale cache must not synthesize a failed last_probe on 429.
  const third = await new AccountQuota({ db: right.db, config: {} }).init()
  left.recordLastProbe('shared-account', { ok: true, source: 'official-cc-usage' })
  await left.flush()
  third.ingestOAuthUsage('shared-account', { usage_status: 429, rate_limited: true })
  await third.flush()
  saved = await left.persistence.get('shared-account')
  assert.equal(saved.unified.last_probe.ok, true)
  assert.equal(saved.unified.last_probe.source, 'official-cc-usage')
  assert.ok(saved.unified.usage_rate_limited_until)
})

test('an in-flight database result does not publish over a later synchronous local mutation', async (t) => {
  const { left } = await pair(t)
  const apply = left.persistence.applyChanges.bind(left.persistence)
  let entered
  let resume
  let nextEntered
  let nextResume
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const gate = new Promise((resolve) => {
    resume = resolve
  })
  const nextStarted = new Promise((resolve) => {
    nextEntered = resolve
  })
  const nextGate = new Promise((resolve) => {
    nextResume = resolve
  })
  let first = true
  left.persistence.applyChanges = async (...args) => {
    if (!first) {
      nextEntered()
      await nextGate
    }
    const saved = await apply(...args)
    if (first) {
      first = false
      entered()
      await gate
    }
    return saved
  }
  left.ingestHeaders('shared-account', {}, { input_tokens: 3 })
  await started
  left.setMaxConcurrency('shared-account', 17, { override: true })
  left.ingestHeaders('shared-account', {}, { input_tokens: 7 })
  resume()
  await nextStarted
  assert.equal(left.repo.get('shared-account').max_concurrency, 17)
  assert.equal(left.repo.get('shared-account').tokens_in, 10)
  nextResume()
  await left.flush()
  const saved = await left.persistence.get('shared-account')
  assert.equal(saved.max_concurrency, 17)
  assert.equal(saved.tokens_in, 10)
  assert.equal(left.repo.get('shared-account').max_concurrency, 17)
  assert.equal(left.repo.get('shared-account').tokens_in, 10)
})

test('refresh reads remote account management changes without replacing transient state or allocations', async (t) => {
  const { left, right } = await pair(t)
  left.inflight.set('shared-account', 2)
  const sessions = left.sessions
  const allocations = left.allocations
  const history = [{ source: 'synthetic-existing-history' }]
  allocations.set('shared-account', history)
  right.setMaxConcurrency('shared-account', 19, { override: true })
  right.setMaxRpm('shared-account', 321, { override: true })
  await right.flush()
  assert.notEqual(left.repo.get('shared-account').max_concurrency, 19)
  await left.refresh()
  assert.equal(left.repo.get('shared-account').max_concurrency, 19)
  assert.equal(left.repo.get('shared-account').max_rpm, 321)
  assert.equal(left.inflight.get('shared-account'), 2)
  assert.equal(left.sessions, sessions)
  assert.equal(left.allocations, allocations)
  assert.equal(left.allocations.get('shared-account'), history)
})

test('a delayed refresh cannot overwrite a local write started after the read', async (t) => {
  const { left } = await pair(t)
  const list = left.persistence.list.bind(left.persistence)
  let entered
  let resume
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const gate = new Promise((resolve) => {
    resume = resolve
  })
  left.persistence.list = async () => {
    const rows = await list()
    entered()
    await gate
    return rows
  }
  const refreshing = left.refresh()
  await started
  left.setMaxConcurrency('shared-account', 23, { override: true })
  left.ingestHeaders('shared-account', {}, { input_tokens: 7 })
  await left.flush()
  resume()
  await refreshing
  assert.equal(left.repo.get('shared-account').max_concurrency, 23)
  assert.equal(left.repo.get('shared-account').tokens_in, 7)
})

test('an older refresh finishing late cannot replace a newer committed remote snapshot', async (t) => {
  const { left, right } = await pair(t)
  const list = left.persistence.list.bind(left.persistence)
  let entered
  let resume
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const gate = new Promise((resolve) => {
    resume = resolve
  })
  let first = true
  left.persistence.list = async () => {
    const rows = await list()
    if (first) {
      first = false
      entered()
      await gate
    }
    return rows
  }
  const older = left.refresh()
  await started
  right.setMaxConcurrency('shared-account', 29, { override: true })
  await right.flush()
  await left.refresh()
  resume()
  await older
  assert.equal(left.repo.get('shared-account').max_concurrency, 29)
})

test('ticket allocation preserves local invocation order when an earlier PG allocation is delayed', async (t) => {
  const { left } = await pair(t)
  const allocate = left.persistence.beginObservation.bind(left.persistence)
  let entered
  let resume
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const gate = new Promise((resolve) => {
    resume = resolve
  })
  let calls = 0
  left.persistence.beginObservation = async () => {
    if (++calls === 1) {
      entered()
      await gate
    }
    return allocate()
  }
  const older = left.beginObservation()
  await started
  const newer = left.beginObservation()
  await Promise.resolve()
  const callsBeforeRelease = calls
  resume()
  const [oldTicket, newTicket] = await Promise.all([older, newer])
  assert.equal(callsBeforeRelease, 1)
  assert.ok(BigInt(oldTicket) < BigInt(newTicket))
})
