import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readWorkerCredentialFile,
  writeWorkerCredentialFile,
  ensureSlotSubscriptionType,
} from '../../src/lib/oauth/oauth-credentials.mjs'
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

test('official Pro profile repairs a stale Max plan in DB, VM, credential and panel views', async (t) => {
  const f = fixture(t, { mode: 'oauth' })
  const root = f.args.cfg.paths.project
  const home = path.join(root, 'vms/vm-02/cli-home')
  writeWorkerCredentialFile(home, { access_token: 'at-test', refresh_token: 'rt-test', subscription_type: 'max' })
  f.quota.setAccountTier('account-test', 'max')
  // Unknown/default Pro hints still must not overwrite a real credential plan.
  ensureSlotSubscriptionType(home, 'pro')
  assert.equal(readWorkerCredentialFile(home).subscription_type, 'max')
  const result = (
    await buildProbeOne({
      ...f.args,
      accountQuota: f.quota,
      usageCache: usageCache({
        ok: true,
        source: 'official-cc-usage',
        usage_status: 200,
        limits_present: true,
        five_hour: { utilization: 0.1 },
        seven_day: { utilization: 0.2 },
        seven_day_oi: { utilization: 0.1 },
        usage_has_fable: null,
        account_tier: 'pro',
        account_tier_source: 'profile',
      }),
    })
  ).data
  assert.equal(result.account_tier, 'pro')
  assert.equal(result.quota.account_tier, 'pro')
  assert.equal(f.quota.repo.get('account-test').unified.account_tier_source, 'profile')
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms/vm-02.json'))).claude.account_tier, 'pro')
  assert.equal(readWorkerCredentialFile(home).subscription_type, 'pro')
  const detail = await f.detail(f.reopen())
  assert.equal(detail.vm.account_tier, 'pro')
})

for (const explicitTier of [false, true]) {
  test(`Pro rate veto survives ${explicitTier ? 'explicit usage tier' : 'inferred usage'} probe and DB reopen`, async (t) => {
    const f = fixture(t, { mode: 'oauth' })
    const root = f.args.cfg.paths.project
    const vmFile = path.join(root, 'vms/vm-02.json')
    const vm = JSON.parse(fs.readFileSync(vmFile, 'utf8'))
    vm.claude.rate_limit_tier = 'default_claude_ai'
    vm.claude.account_tier = 'max'
    vm.claude.account_tier_source = 'usage'
    fs.writeFileSync(vmFile, JSON.stringify(vm))
    const home = path.join(root, 'vms/vm-02/cli-home')
    writeWorkerCredentialFile(home, {
      access_token: 'at-test',
      refresh_token: 'rt-test',
      subscription_type: 'pro',
      rate_limit_tier: 'default_claude_ai',
    })
    f.quota.setAccountTier('account-test', 'max', { source: 'usage' })
    const result = (
      await buildProbeOne({
        ...f.args,
        accountQuota: f.quota,
        usageCache: usageCache({
          ok: true,
          source: 'official-cc-usage',
          usage_status: 200,
          limits_present: true,
          five_hour: { utilization: 0.1 },
          seven_day: { utilization: 0.2 },
          seven_day_oi: { utilization: 0.1 },
          usage_has_fable: true,
          ...(explicitTier ? { account_tier: 'max', account_tier_source: 'usage' } : {}),
        }),
      })
    ).data
    assert.equal(result.account_tier, 'pro')
    assert.equal(result.quota.account_tier, 'pro')
    assert.equal(f.quota.repo.get('account-test').unified.account_tier, 'pro')
    assert.equal(JSON.parse(fs.readFileSync(vmFile, 'utf8')).claude.account_tier, 'pro')
    assert.equal(readWorkerCredentialFile(home).subscription_type, 'pro')
    const detail = await f.detail(f.reopen())
    assert.equal(detail.vm.account_tier, 'pro')
    assert.equal(detail.vm.usage_has_fable, true)
  })
}

for (const tier of ['pro', 'max']) {
  test(`usage cannot replace a verified ${tier} profile when the next profile is unavailable`, async (t) => {
    const f = fixture(t, { mode: 'oauth' })
    const root = f.args.cfg.paths.project
    const vmFile = path.join(root, 'vms/vm-02.json')
    const vm = JSON.parse(fs.readFileSync(vmFile, 'utf8'))
    vm.claude = {
      ...vm.claude,
      account_tier: tier,
      account_tier_source: 'profile',
      rate_limit_tier: 'default_claude_ai',
    }
    fs.writeFileSync(vmFile, JSON.stringify(vm))
    f.quota.setAccountTier('account-test', tier, { source: 'profile' })
    const home = path.join(root, 'vms/vm-02/cli-home')
    writeWorkerCredentialFile(home, { access_token: 'at-test', refresh_token: 'rt-test', subscription_type: tier })
    const result = (
      await buildProbeOne({
        ...f.args,
        accountQuota: f.quota,
        usageCache: usageCache({
          ok: true,
          source: 'official-cc-usage',
          usage_status: 200,
          limits_present: true,
          five_hour: { utilization: 0.1 },
          seven_day: { utilization: 0.2 },
          seven_day_oi: { utilization: 0.1 },
          usage_has_fable: true,
          account_tier: 'max',
          account_tier_source: 'usage',
        }),
      })
    ).data
    assert.equal(result.account_tier, tier)
    assert.equal(result.quota.account_tier, tier)
    assert.equal(f.quota.repo.get('account-test').unified.account_tier_source, 'profile')
    assert.equal(readWorkerCredentialFile(home).subscription_type, tier)
    const detail = await f.detail(f.reopen())
    assert.equal(detail.vm.account_tier, tier)
    assert.equal(detail.vm.account_tier_source, 'profile')
  })
}

test('panel serializes quota-only profile provenance ahead of stale VM usage and subscription', async (t) => {
  const f = fixture(t, { mode: 'oauth' })
  const root = f.args.cfg.paths.project
  const vmFile = path.join(root, 'vms/vm-02.json')
  const vm = JSON.parse(fs.readFileSync(vmFile, 'utf8'))
  vm.claude = {
    ...vm.claude,
    account_tier: 'max',
    account_tier_source: 'usage',
    subscription_type: 'max',
    rate_limit_tier: 'default_claude_max_5x',
  }
  fs.writeFileSync(vmFile, JSON.stringify(vm))
  f.quota.setAccountTier('account-test', 'pro', { source: 'profile' })
  const detail = await f.detail()
  assert.equal(detail.vm.account_tier, 'pro')
  assert.equal(detail.vm.account_tier_source, 'profile')
  assert.equal(detail.vm.subscription_type, 'max', 'subscription metadata stays separate from scheduling inference')
})

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

test('probe errors remain text across the response, persisted checks and detail reload', async (t) => {
  const cases = [
    { usage_error: { code: 'worker_timeout' }, expected: 'worker_timeout' },
    { error: { message: 'Probe timed out', code: 'worker_timeout' }, expected: 'Probe timed out' },
    { error: { message: {}, code: 'worker_timeout' }, expected: 'worker_timeout' },
    { error: 'probe_failed', expected: 'probe_failed' },
    { error: { message: {}, code: {} }, expected: null },
  ]
  for (const { expected, ...errors } of cases) {
    await t.test(JSON.stringify(errors), async (t) => {
      const f = fixture(t, { mode: 'oauth' })
      const result = (
        await buildProbeOne({
          ...f.args,
          accountQuota: f.quota,
          usageCache: usageCache({
            ok: false,
            source: 'official-cc-usage',
            via: 'slot-worker',
            usage_status: 502,
            probed_at: '2026-10-02T02:00:00Z',
            ...errors,
          }),
        })
      ).data
      assert.equal(result.ok, false)
      assert.equal(result.error, expected)
      const detail = await f.detail(f.reopen())
      for (const record of [detail.vm, detail.account]) {
        assert.equal(record.last_probe.ok, false)
        assert.equal(record.last_probe.error, expected)
        assert.equal(record.last_probe_check.ok, false)
        assert.equal(record.last_probe_check.error, expected)
      }
    })
  }
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
