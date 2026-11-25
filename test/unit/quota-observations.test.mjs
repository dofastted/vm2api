import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildVmDetail, buildVmList, quotaFromAccount } from '../../src/lib/admin/panel-api.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { createActiveUsageQuery } from '../../src/lib/oauth/active-usage-query.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-observations-'))
  fs.mkdirSync(path.join(root, 'data'))
  fs.mkdirSync(path.join(root, 'vms'))
  const vm = { id: 'vm-synthetic', claude: { mode: 'oauth', has_access: true, account_uuid: 'synthetic-account' } }
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  const db = createDatabase({ dataDir: path.join(root, 'data') })
  const quota = new AccountQuota({ db, config: { quota: { safety_ratio: 0.85, weekly_safety_ratio: 0.8 } } })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const now = Date.now()
  const reset = String(Math.floor((now + 86400_000) / 1000))
  quota.ingestHeaders(
    'synthetic-account',
    {
      'anthropic-ratelimit-unified-7d-utilization': '0.76',
      'anthropic-ratelimit-unified-7d-reset': reset,
      'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
    },
    null,
    { now },
  )
  return { root, quota, vm, now, reset }
}

test('#1776 active query exposes official zero separately, without overwriting conservative headers', async (t) => {
  const { root, quota, vm, now, reset } = fixture(t)
  let calls = 0
  const query = createActiveUsageQuery({
    probe: async () => {
      calls++
      return {
        ok: true,
        usage_status: 200,
        limits_present: true,
        probed_at: new Date(now).toISOString(),
        five_hour: { utilization: 0, status: 'allowed', resets_at: null },
        seven_day: { utilization: 0, status: 'allowed', resets_at: new Date(Number(reset) * 1000).toISOString() },
      }
    },
  })
  assert.equal((await query({ vm, projectRoot: root, accountQuota: quota })).status, 200)
  assert.equal(calls, 1)
  const acc = quota.repo.get('synthetic-account')
  assert.equal(acc.unified.headers['7d'].utilization, 0.76)
  assert.equal(acc.unified.official['7d'].utilization, 0)
  const before = structuredClone(acc)
  const cfg = { paths: { project: root }, rewrite: { enabled: false } }
  const listed = await buildVmList({ cfg, accountQuota: quota, routingConfig: {} })
  const detail = await buildVmDetail({ cfg, accountQuota: quota, id: vm.id })
  for (const row of [quotaFromAccount(acc), listed.data.items[0], detail.data.vm]) {
    assert.equal(row.utilization_7d, 0.76)
    assert.equal(row.quota_observations?.official?.['7d']?.utilization, 0, 'saved official result must remain visible')
    assert.equal(row.quota_observations.official.updated_at, acc.unified.official.updated_at)
    assert.equal(row.quota_observations.passive['7d'].utilization, 0.76)
    assert.equal(row.quota_observations.passive['7d'].sampled_at, acc.unified.headers['7d'].sampled_at)
  }
  assert.deepEqual(quota.repo.get('synthetic-account'), before, 'display must not write quota state')
  assert.equal(calls, 1, 'display must not query the provider')
})

test('post-reset headers reconcile official storage without updating its old query time', (t) => {
  const { quota, now } = fixture(t)
  const stamp = new Date(now).toISOString()
  quota.ingestOAuthUsage('synthetic-account', {
    ok: true,
    usage_status: 200,
    limits_present: true,
    probed_at: stamp,
    seven_day: { utilization: 100, status: 'rejected', resets_at: new Date(now + 86400_000).toISOString() },
  })
  assert.equal(quota.repo.get('synthetic-account').unified.official['7d'].utilization, 1)
  quota.recordQuotaReset('synthetic-account', {
    cleared: ['seven_day'],
    now: now + 1000,
    operationId: 'synthetic-reset',
  })
  quota.ingestHeaders(
    'synthetic-account',
    {
      'anthropic-ratelimit-unified-7d-utilization': '0.05',
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor((now + 8 * 86400_000) / 1000)),
    },
    null,
    { now: now + 2000, requestStartedAt: now + 2000, resetGenerations: quota.resetGenerations('synthetic-account') },
  )
  const acc = quota.repo.get('synthetic-account')
  const before = structuredClone(acc)
  const official = quotaFromAccount(acc).quota_observations.official
  assert.equal(official['7d'].utilization, 0.05)
  assert.equal(official.updated_at, stamp)
  assert.equal(official['7d'].sampled_at, null)
  assert.deepEqual(quota.repo.get('synthetic-account'), before)
})

test('observation projection preserves unknown, zero and stale samples without borrowing aggregate timestamps', () => {
  const acc = {
    unified: {
      official: {
        updated_at: '2026-01-01T00:00:00Z',
        '5h': { utilization: null, status: 'allowed' },
        '7d': { utilization: 0, stale: true },
      },
      headers: { sampled_at: '2026-01-02T00:00:00Z', '7d': { utilization: 0.76, sampled_at: '2026-01-01T00:00:00Z' } },
    },
  }
  const before = structuredClone(acc)
  const obs = quotaFromAccount(acc).quota_observations
  assert.equal(obs?.official?.['5h']?.utilization, null)
  assert.equal(obs.official['7d'].utilization, 0)
  assert.equal(obs.official['7d'].stale, true)
  assert.equal(obs.official['5h'].sampled_at, null, 'aggregate update is not a per-window sample')
  assert.equal(obs.passive['7d'].sampled_at, '2026-01-01T00:00:00Z')
  assert.equal(obs.passive['5h'], null)
  assert.deepEqual(acc, before)
})

test('absent official snapshots do not promote legacy scheduling aliases to official observations', () => {
  const row = quotaFromAccount({ unified: { '7d': { utilization: 0.5 } } })
  assert.equal(row.quota_observations?.official, null)
  assert.equal(row.utilization_7d, 0.5)
})

test('projection allowlists display fields rather than serializing arbitrary account data', () => {
  const row = quotaFromAccount({
    unified: { official: { secret: 'synthetic-secret', '7d': { utilization: 0, access_token: 'synthetic-secret' } } },
  })
  assert.ok(row.quota_observations)
  assert.equal(JSON.stringify(row.quota_observations).includes('synthetic-secret'), false)
})

test('slot observation projection does not inherit another account after rebinding', async (t) => {
  const { root, quota, vm, now } = fixture(t)
  quota.ingestOAuthUsage('synthetic-account', {
    ok: true,
    usage_status: 200,
    limits_present: true,
    probed_at: new Date(now).toISOString(),
    seven_day: { utilization: 0.2, status: 'allowed' },
  })
  quota.rebindToVm('synthetic-account', vm.id)
  vm.claude.account_uuid = 'replacement-account'
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  const cfg = { paths: { project: root }, rewrite: { enabled: false } }
  for (const row of [
    (await buildVmList({ cfg, accountQuota: quota, routingConfig: {} })).data.items[0],
    (await buildVmDetail({ cfg, accountQuota: quota, id: vm.id })).data.vm,
  ])
    assert.equal(row.quota_observations, null)
})

test('a partial official refresh preserves the other window without inventing its sample time', (t) => {
  const { quota, now } = fixture(t)
  quota.ingestOAuthUsage('synthetic-account', {
    ok: true,
    usage_status: 200,
    limits_present: true,
    probed_at: new Date(now).toISOString(),
    seven_day: { utilization: 0.2, status: 'allowed' },
  })
  quota.ingestOAuthUsage('synthetic-account', {
    ok: true,
    usage_status: 200,
    limits_present: true,
    probed_at: new Date(now + 1000).toISOString(),
    five_hour: { utilization: 0, status: 'allowed' },
  })
  const official = quotaFromAccount(quota.repo.get('synthetic-account')).quota_observations.official
  assert.equal(official['7d'].utilization, 0.2)
  assert.equal(official['5h'].utilization, 0)
  assert.equal(official['7d'].sampled_at, null)
})

for (const [label, response, status] of [
  ['429', { ok: false, usage_status: 429 }, 429],
  ['failed', { ok: false, usage_status: 500 }, 502],
  ['empty', { ok: true, usage_status: 200, limits_present: false }, 502],
]) {
  test(`${label} cannot turn the retained official reading into zero`, async (t) => {
    const { root, quota, vm, now } = fixture(t)
    quota.ingestOAuthUsage('synthetic-account', {
      ok: true,
      usage_status: 200,
      limits_present: true,
      probed_at: new Date(now).toISOString(),
      seven_day: { utilization: 0.25, status: 'allowed' },
    })
    const before = structuredClone(quota.repo.get('synthetic-account').unified.official)
    const query = createActiveUsageQuery({ probe: async () => response })
    assert.equal((await query({ vm, projectRoot: root, accountQuota: quota })).status, status)
    assert.deepEqual(quota.repo.get('synthetic-account').unified.official, before)
    assert.equal(
      quotaFromAccount(quota.repo.get('synthetic-account')).quota_observations?.official?.['7d']?.utilization,
      0.25,
    )
  })
}
