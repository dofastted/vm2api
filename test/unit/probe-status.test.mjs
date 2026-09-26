import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { buildProbeOne, buildVmDetail } = await import('../../src/lib/admin/panel-api.mjs')
const { AccountQuota } = await import('../../src/lib/pool/account-quota.mjs')
const { createDatabase } = await import('../../src/lib/db/database.mjs')

function usageCache(probe) {
  return {
    clear() {},
    async load() {
      return probe
    },
  }
}

function fixture(t, { mode = 'setup-token', headers = true, failed = false } = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-card-'))
  fs.mkdirSync(path.join(project, 'vms'))
  fs.writeFileSync(
    path.join(project, 'vms/vm-02.json'),
    JSON.stringify({
      id: 'vm-02',
      status: 'stopped',
      claude: { mode, has_access: true, account_uuid: 'account-test' },
      policy: { maxConcurrency: 20, sessionSlots: 20 },
    }),
  )
  const dataDir = path.join(project, 'data')
  let db = createDatabase({ dataDir })
  let quota = new AccountQuota({ db })
  const acc = quota.ensure({ account_id: 'account-test', vm_id: 'vm-02', max_concurrency: 20 })
  acc.unified.headers = headers
    ? { '5h': { utilization: 0.15, status: 'allowed' }, sampled_at: '2026-09-20T00:00:00Z' }
    : {}
  if (failed) {
    acc.unified.last_probe = {
      at: '2026-09-21T00:00:00Z',
      source: 'official-cc-usage',
      ok: false,
      error: 'invalid_grant',
    }
    acc.unified.usage_rate_limited_until = '2099-01-01T00:00:00Z'
  }
  quota.repo.save(acc)
  t.after(() => {
    db.close()
    fs.rmSync(project, { recursive: true, force: true })
  })
  const args = { cfg: { paths: { project }, rewrite: {} }, id: 'vm-02', force: true, hop: true }
  return {
    quota,
    args,
    reopen() {
      db.close()
      db = createDatabase({ dataDir })
      quota = new AccountQuota({ db })
      return quota
    },
    async detail(q = quota) {
      return (await buildVmDetail({ ...args, accountQuota: q })).data
    },
  }
}

test('Setup Token probe persists the card check time/source across DB reopen and detail reload', async (t) => {
  const f = fixture(t)
  const probe = {
    ok: true,
    source: 'official-cc-usage',
    via: 'worker',
    probed_at: '2026-09-26T12:00:00Z',
    five_hour: { utilization: 0.15, resets_at: '2026-09-26T16:00:00Z', status: 'allowed' },
  }
  const result = (await buildProbeOne({ ...f.args, accountQuota: f.quota, usageCache: usageCache(probe) })).data
  assert.equal(result.ok, true)
  assert.equal(result.source, 'official-cc-usage')
  const detail = await f.detail(f.reopen())
  assert.equal(detail.account.last_probe_check?.at, result.probed_at)
  assert.equal(detail.account.last_probe_check.source, result.source)
  assert.equal(detail.account.last_probe_check.via, 'worker')
  assert.equal(detail.account.last_probe_check.data_at, result.probed_at)
  assert.deepEqual(detail.vm.last_probe_check, detail.account.last_probe_check)
})

test('cached-header check preserves active-probe failures, backoff, quota and counters', async (t) => {
  const f = fixture(t, { failed: true })
  const before = f.quota.repo.get('account-test')
  await buildProbeOne({
    ...f.args,
    accountQuota: f.quota,
    usageCache: usageCache({
      ok: false,
      source: 'official-cc-usage',
      via: 'worker',
      rate_limited: true,
      probed_at: '2026-09-26T12:00:00Z',
      error: 'rate limited',
    }),
  })
  const after = f.quota.repo.get('account-test')
  assert.equal(after.unified.last_probe_check?.ok, true)
  assert.equal(after.unified.last_probe?.ok, false)
  assert.equal(after.unified.last_probe?.error, 'invalid_grant')
  assert.equal(after.requests, before.requests)
  assert.equal(after.max_concurrency, 20)
})

test('no header samples reports unavailable and persists the attempt without fake success', async (t) => {
  const f = fixture(t, { headers: false })
  const probe = {
    ok: false,
    source: 'official-cc-usage',
    via: 'worker',
    error: '暂无请求响应头用量，请先完成一次请求后再检查',
    probed_at: '2026-09-26T12:00:00Z',
  }
  const result = (await buildProbeOne({ ...f.args, accountQuota: f.quota, usageCache: usageCache(probe) })).data
  assert.equal(result.ok, false)
  assert.match(result.error, /暂无.*响应头/)
  const check = (await f.detail()).account.last_probe_check
  assert.equal(check.at, result.probed_at)
  assert.equal(check.ok, false)
  assert.equal(check.data_at, result.probed_at)
  assert.equal(f.quota.repo.get('account-test').unified.last_probe?.ok, false)
  const detail = await f.detail(f.reopen())
  assert.equal(detail.vm.account_tier, 'pro')
  assert.equal(detail.vm.usage_has_fable, null)
})

test('Setup Token Fable hop does not classify the plan without complete official usage', async (t) => {
  const f = fixture(t)
  f.quota.setAccountTier('account-test', 'pro')
  const result = (
    await buildProbeOne({
      ...f.args,
      accountQuota: f.quota,
      fableProbe: async () => ({
        tier: 'max',
        fable: { ok: true, status: 200, model: 'claude-fable-5-1', plan_denied: false },
      }),
    })
  ).data
  assert.equal(result.account_tier, 'pro')
  assert.equal(f.quota.repo.get('account-test').unified.account_tier, 'pro')
  assert.equal(f.quota.repo.get('account-test').unified.usage_has_fable, undefined)
  assert.equal(f.quota.repo.get('account-test').unified.fable.ok, false)
  assert.equal(f.quota.repo.get('account-test').unified.fable.plan_denied, false)
  const detail = await f.detail(f.reopen())
  assert.equal(detail.vm.account_tier, 'pro')
})

test('Setup Token usage scope failure reports auth scope and preserves history', async (t) => {
  const f = fixture(t)
  f.quota.setAccountTier('account-test', 'max', { source: 'usage' })
  let fableCalled = false
  const result = (
    await buildProbeOne({
      ...f.args,
      accountQuota: f.quota,
      usageCache: usageCache({
        ok: false,
        source: 'official-cc-usage',
        via: 'worker',
        usage_status: 403,
        usage_scope_missing: true,
        credential_scope_required: 'user:profile',
        usage_error: '当前凭证缺少 user:profile scope，需导入完整 OAuth 后才能探测官方 /usage',
        probed_at: '2026-09-26T12:00:00Z',
      }),
      fableProbe: async () => {
        fableCalled = true
        return { tier: 'max', fable: { ok: true, status: 200, model: 'claude-fable-5-1' } }
      },
    })
  ).data
  assert.equal(result.ok, false)
  assert.equal(result.usage_scope_missing, true)
  assert.match(result.error, /完整 OAuth|user:profile/)
  assert.equal(result.account_tier, 'max')
  assert.equal(fableCalled, false)
  const acc = f.quota.repo.get('account-test')
  assert.equal(acc.unified.account_tier, 'max')
  assert.equal(acc.unified.fable, undefined)
  assert.equal(acc.unified.last_probe.ok, false)
  assert.match(acc.unified.last_probe.error, /user:profile/)
})

test('official OAuth probe still ingests real usage and exposes its actual result to the card', async (t) => {
  const f = fixture(t, { mode: 'oauth' })
  const probe = {
    ok: false,
    source: 'official-cc-usage',
    via: 'worker',
    error: 'probe_failed',
    probed_at: '2026-09-24T00:00:00Z',
  }
  const result = (
    await buildProbeOne({
      ...f.args,
      accountQuota: f.quota,
      usageCache: {
        clear() {},
        async load() {
          return probe
        },
      },
    })
  ).data
  assert.equal(result.ok, false)
  const detail = await f.detail(f.reopen())
  assert.equal(detail.account.last_probe_check?.at, probe.probed_at)
  assert.equal(detail.account.last_probe_check.ok, false)
  assert.equal(detail.account.last_probe_check.error, 'probe_failed')
  assert.equal(detail.account.last_probe.error, 'probe_failed')
})

test('confirmed usage revoke parks the VM and reports revoked status', async (t) => {
  const f = fixture(t, { mode: 'oauth' })
  const result = (
    await buildProbeOne({
      ...f.args,
      accountQuota: f.quota,
      usageCache: usageCache({
        ok: false,
        source: 'official-cc-usage',
        via: 'worker',
        usage_status: 401,
        usage_error: 'OAuth access token has been revoked.',
        probed_at: '2026-09-26T12:00:00Z',
      }),
    })
  ).data
  assert.equal(result.ok, false)
  const vm = JSON.parse(fs.readFileSync(path.join(f.args.cfg.paths.project, 'vms/vm-02.json'), 'utf8'))
  assert.equal(vm.schedulable, false)
  assert.equal(vm.schedule_disabled_reason, 'oauth_revoked')
  const detail = await f.detail(f.reopen())
  assert.equal(detail.vm.cred_status.key, 'bad')
  assert.equal(detail.vm.cred_status.text, 'revoke')
})

test('complete Pro usage replaces stale Max windows in persisted panel data', async (t) => {
  const f = fixture(t, { mode: 'oauth' })
  f.quota.ingestOAuthUsage('account-test', {
    ok: true,
    usage_status: 200,
    limits_present: true,
    usage_has_fable: true,
    seven_day_oi: { utilization: 0.2, resets_at: '2099-01-01T00:00:00Z' },
  })
  const result = (
    await buildProbeOne({
      ...f.args,
      accountQuota: f.quota,
      usageCache: usageCache({
        ok: true,
        usage_status: 200,
        limits_present: true,
        usage_has_fable: false,
        account_tier: 'pro',
        five_hour: { utilization: 0.1 },
        seven_day: { utilization: 0.2 },
        probed_at: '2026-09-26T12:00:00Z',
      }),
    })
  ).data
  assert.equal(result.account_tier, 'pro')
  assert.equal(result.quota.account_tier, 'pro')
  const detail = await f.detail(f.reopen())
  assert.equal(detail.vm.account_tier, 'pro')
  assert.equal(detail.vm.usage_has_fable, false)
  assert.equal(detail.vm.utilization_7d_oi, null)
})
