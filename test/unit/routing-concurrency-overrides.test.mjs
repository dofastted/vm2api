import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'

async function fixture(t, cap, { override = true, tier = 'default' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-concurrency-'))
  const accountId = 'test-account'
  const quota = await new AccountQuota({
    dataDir: path.join(root, 'data'),
    accounts: [
      {
        account_id: accountId,
        vm_id: 'vm-02',
        max_concurrency: cap,
        concurrency_override: override,
      },
    ],
  }).init()
  quota.setAccountTier(accountId, tier)
  const vmPath = path.join(root, 'vms/vm-02.json')
  fs.mkdirSync(path.dirname(vmPath), { recursive: true })
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-02',
      claude: { account_uuid: accountId, account_tier: tier },
      policy: { maxConcurrency: cap, concurrencyOverride: override },
    }),
  )
  const runtime = createRoutingRuntime({
    cfg: { paths: { project: root } },
    accountQuota: quota,
    routingConfig: { tiers: {}, quota: {}, concurrency: {} },
  })
  t.after(async () => {
    await quota.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    runtime,
    vmPath,
    policy: () => JSON.parse(fs.readFileSync(vmPath, 'utf8')).policy,
    account: () => quota.repo.get(accountId),
  }
}

for (const cap of [0, 2, 16, 20]) {
  test(`tier synchronization preserves a manual concurrency value of ${cap}`, async (t) => {
    const f = await fixture(t, cap)
    const applied = f.runtime.applyRoutingTierConcurrency({ default: { max_concurrency: 4 } })
    assert.equal(applied.skipped, 1)
    assert.equal(f.policy().maxConcurrency, cap)
    assert.equal(f.policy().concurrencyOverride, true)
    assert.equal(f.account().max_concurrency, cap)
    assert.equal(Boolean(f.account().concurrency_override), true)
  })

  test(`global default updates preserve a manual concurrency value of ${cap}`, async (t) => {
    const f = await fixture(t, cap)
    f.runtime.applyRoutingConcurrency(4)
    assert.equal(f.policy().maxConcurrency, cap)
    assert.equal(f.policy().concurrencyOverride, true)
    assert.equal(f.account().max_concurrency, cap)
    assert.equal(Boolean(f.account().concurrency_override), true)
  })
}

for (const tier of ['default', 'pro', 'max']) {
  test(`inherited ${tier} concurrency receives the tier default`, async (t) => {
    const f = await fixture(t, 2, { override: false, tier })
    const applied = f.runtime.applyRoutingTierConcurrency({ [tier]: { max_concurrency: 6 } })
    assert.equal(applied[tier], 1)
    assert.equal(f.policy().maxConcurrency, 6)
    assert.equal(f.policy().concurrencyOverride, false)
    assert.equal(f.account().max_concurrency, 6)
  })
}

test('global default updates still reach inherited concurrency', async (t) => {
  const f = await fixture(t, 2, { override: false })
  f.runtime.applyRoutingConcurrency(4)
  assert.equal(f.policy().maxConcurrency, 4)
  assert.equal(f.policy().concurrencyOverride, false)
  assert.equal(f.account().max_concurrency, 4)
})

test('tier synchronization does not rewrite an unchanged inherited VM record', async (t) => {
  const f = await fixture(t, 4, { override: false })
  const before = fs.readFileSync(f.vmPath, 'utf8')
  const applied = f.runtime.applyRoutingTierConcurrency({ default: { max_concurrency: 4 } })
  assert.equal(applied.default, 0)
  assert.equal(fs.readFileSync(f.vmPath, 'utf8'), before)
})

async function rpmFixture(t, rpm, { override = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-rpm-'))
  const accountId = 'test-account'
  const quota = await new AccountQuota({
    dataDir: path.join(root, 'data'),
    accounts: [{ account_id: accountId, vm_id: 'vm-02', max_rpm: rpm }],
  }).init()
  const vmPath = path.join(root, 'vms/vm-02.json')
  fs.mkdirSync(path.dirname(vmPath), { recursive: true })
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-02',
      claude: { account_uuid: accountId, account_tier: 'default' },
      policy: { maxRpm: rpm, rpmOverride: override },
    }),
  )
  const runtime = createRoutingRuntime({
    cfg: { paths: { project: root } },
    accountQuota: quota,
    routingConfig: { tiers: {}, quota: {}, concurrency: {} },
  })
  t.after(async () => {
    await quota.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    runtime,
    vmPath,
    policy: () => JSON.parse(fs.readFileSync(vmPath, 'utf8')).policy,
    account: () => quota.repo.get(accountId),
  }
}

test('tier RPM synchronization preserves a manual RPM value', async (t) => {
  const f = await rpmFixture(t, 30)
  const applied = f.runtime.applyRoutingTierRpm({ default: { max_rpm: 10 } })
  assert.equal(applied.skipped, 1)
  assert.equal(f.policy().maxRpm, 30)
  assert.equal(f.policy().rpmOverride, true)
  assert.equal(f.account().max_rpm, 30)
})

test('tier RPM synchronization updates inherited RPM and skips unchanged records', async (t) => {
  const f = await rpmFixture(t, 10, { override: false })
  const before = fs.readFileSync(f.vmPath, 'utf8')
  assert.equal(f.runtime.applyRoutingTierRpm({ default: { max_rpm: 10 } }).default, 0)
  assert.equal(fs.readFileSync(f.vmPath, 'utf8'), before)
  assert.equal(f.runtime.applyRoutingTierRpm({ default: { max_rpm: 20 } }).default, 1)
  assert.equal(f.policy().maxRpm, 20)
  assert.equal(f.account().max_rpm, 20)
})
