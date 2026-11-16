import test from 'node:test'
import assert from 'node:assert/strict'
import { createActiveUsageQuery } from '../../src/lib/oauth/active-usage-query.mjs'

const vm = { id: 'vm-01', claude: { mode: 'oauth', has_access: true, account_uuid: 'account-1' } }
const successful = {
  ok: true,
  usage_status: 200,
  limits_present: true,
  five_hour: { utilization: 0.12 },
  seven_day: { utilization: 0.15 },
  usage_has_fable: true,
  probed_at: '2026-10-23T15:00:00Z',
}
function fixture(overrides = {}) {
  const writes = []
  const account = { unified: { headers: { '5h': { utilization: 0.4 } } } }
  const args = {
    vm,
    projectRoot: '/test',
    accountQuota: {
      async ensure() {
        await Promise.resolve()
        return account
      },
      async ingestOAuthUsage(id, result) {
        await Promise.resolve()
        writes.push({ id, result })
        return { unified: { account_tier: 'max' } }
      },
    },
  }
  const query = createActiveUsageQuery({
    probe: async (opts) => {
      assert.equal(opts.includeFable, false)
      assert.equal(opts.exec.vm, vm)
      return successful
    },
    ...overrides,
  })
  return { query, args, writes, account }
}

test('explicit query uses official usage only and awaits quota persistence', async () => {
  const f = fixture()
  const result = await f.query(f.args)
  assert.equal(result.status, 200)
  assert.equal(result.body.data.five_hour.utilization, 0.12)
  assert.equal(f.writes.length, 1)
})

for (const [name, response, status] of [
  ['429 with previously sampled headers', { ok: false, usage_status: 429 }, 429],
  ['401', { ok: false, usage_status: 401, usage_error: 'credential revoked' }, 502],
  ['missing scope', { ok: false, usage_status: 403, usage_scope_missing: true }, 502],
  ['empty successful response', { ok: true, usage_status: 200, limits_present: false }, 502],
  ['Fable-only success', { ok: true, usage_status: 500, fable: { ok: true } }, 502],
]) {
  test(`${name} returns an error, never cached quota success`, async () => {
    const f = fixture({ probe: async () => response })
    const result = await f.query(f.args)
    assert.equal(result.status, status)
    assert.equal(result.body.ok, false)
    assert.equal(result.body.data, undefined)
    assert.equal(f.writes.length, status === 429 ? 1 : 0)
  })
}

test('concurrent clicks share one query, but a later click gets fresh data', async () => {
  let calls = 0
  let release
  const ready = new Promise((resolve) => {
    release = resolve
  })
  const f = fixture({
    probe: async () => {
      calls++
      await ready
      return successful
    },
  })
  const a = f.query(f.args)
  const b = f.query(f.args)
  release()
  assert.deepEqual(await a, await b)
  assert.equal(calls, 1)
  assert.equal(f.writes.length, 1)
  await f.query(f.args)
  assert.equal(calls, 2)
})

test('rate-limit backoff blocks additional upstream calls', async () => {
  const f = fixture({ probe: async () => assert.fail('must not call upstream') })
  f.account.unified.usage_rate_limited_until = new Date(Date.now() + 60_000).toISOString()
  assert.equal((await f.query(f.args)).status, 429)
  assert.equal(f.writes.length, 0)
})

test('unsupported credentials fail without calling a model or usage', async () => {
  const f = fixture({ probe: async () => assert.fail('must not call upstream') })
  for (const mode of ['official-setup-token', 'apikey']) {
    const result = await f.query({ ...f.args, vm: { ...vm, claude: { ...vm.claude, mode } } })
    assert.equal(result.status, 400)
  }
  assert.equal((await f.query({ ...f.args, vm: null })).status, 404)
  assert.equal((await f.query({ ...f.args, vm: { id: 'empty' } })).status, 400)
})

test('failed query releases the in-flight entry so retry can succeed', async () => {
  let calls = 0
  const f = fixture({
    probe: async () => {
      if (++calls === 1) throw new Error('timeout')
      return successful
    },
  })
  assert.equal((await f.query(f.args)).status, 502)
  assert.equal((await f.query(f.args)).status, 200)
})

test('weekly-only usage stays successful without inventing a five-hour window', async () => {
  const f = fixture({ probe: async () => ({ ...successful, five_hour: null }) })
  const result = await f.query(f.args)
  assert.equal(result.status, 200)
  assert.equal(result.body.data.five_hour, null)
  assert.equal(result.body.data.seven_day.utilization, 0.15)
})

test('GPT slots are rejected before probing', async () => {
  const f = fixture({ probe: async () => assert.fail('must not query Claude usage') })
  const result = await f.query({ ...f.args, vm: { ...vm, kind: 'codex' } })
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'unsupported_platform')
})
