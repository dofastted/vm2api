import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'

function fixture(t, cap, { override = true, tier = 'default' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-a-routing-concurrency-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const accountId = 'test-account'
  const quota = new AccountQuota({
    dataDir: path.join(root, 'data'),
    accounts: [
      {
        account_id: accountId,
        vm_id: 'vm-02',
        max_concurrency: cap,
        concurrency_override: override,
      },
    ],
  })
  t.after(() => quota.db.close())
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
  return {
    runtime,
    quota,
    accountId,
    vmPath,
    policy: () => JSON.parse(fs.readFileSync(vmPath, 'utf8')).policy,
    account: () => quota.repo.get(accountId),
  }
}

for (const cap of [0, 2, 16, 20]) {
  test(`tier synchronization preserves a manual concurrency value of ${cap}`, (t) => {
    const f = fixture(t, cap)
    const applied = f.runtime.applyRoutingTierConcurrency({ default: { max_concurrency: 4 } })
    assert.equal(applied.skipped, 1)
    assert.equal(f.policy().maxConcurrency, cap)
    assert.equal(f.policy().concurrencyOverride, true)
    assert.equal(f.account().max_concurrency, cap)
    assert.equal(Boolean(f.account().concurrency_override), true)
  })

  test(`global default updates preserve a manual concurrency value of ${cap}`, (t) => {
    const f = fixture(t, cap)
    f.runtime.applyRoutingConcurrency(4)
    assert.equal(f.policy().maxConcurrency, cap)
    assert.equal(f.policy().concurrencyOverride, true)
    assert.equal(f.account().max_concurrency, cap)
    assert.equal(Boolean(f.account().concurrency_override), true)
  })
}

for (const tier of ['default', 'pro', 'max']) {
  test(`inherited ${tier} concurrency receives the tier default`, (t) => {
    const f = fixture(t, 2, { override: false, tier })
    const applied = f.runtime.applyRoutingTierConcurrency({ [tier]: { max_concurrency: 6 } })
    assert.equal(applied[tier], 1)
    assert.equal(f.policy().maxConcurrency, 6)
    assert.equal(f.policy().concurrencyOverride, false)
    assert.equal(f.account().max_concurrency, 6)
  })
}

for (const tier of ['default', 'pro', 'max']) {
  test(`startup preserves inherited ${tier} JSON while DB and admission retain the live tier`, (t) => {
    const f = fixture(t, 1, { override: false, tier })
    const tiers = { [tier]: { max_concurrency: 2 } }
    f.quota.reloadConfig({ tiers })
    const before = fs.readFileSync(f.vmPath, 'utf8')
    const applied = f.runtime.applyRoutingTierConcurrency(tiers, { preserveExisting: true })
    assert.equal(applied[tier], 0)
    assert.equal(fs.readFileSync(f.vmPath, 'utf8'), before)
    assert.deepEqual(f.policy(), { maxConcurrency: 1, concurrencyOverride: false })
    assert.equal(f.account().max_concurrency, 2)
    assert.equal(Boolean(f.account().concurrency_override), false)
    assert.equal(f.quota.limitFor(f.account()), 2)
    const reservations = []
    try {
      for (let i = 0; i < 2; i++) {
        const reserved = f.quota.tryAcquire(f.accountId, { skipGate: true })
        assert.equal(reserved.ok, true)
        reservations.push(reserved)
      }
      const blocked = f.quota.tryAcquire(f.accountId, { skipGate: true })
      assert.equal(blocked.ok, false)
      assert.equal(blocked.reason, 'concurrency_limit')
      assert.equal(blocked.detail.max, 2)
    } finally {
      for (const reservation of reservations) reservation.release()
    }
    assert.equal(f.runtime.applyRoutingTierConcurrency(tiers, { preserveExisting: true })[tier], 0)
    assert.equal(fs.readFileSync(f.vmPath, 'utf8'), before)

    // The administrator's existing explicit update path must still take effect.
    const updated = { [tier]: { max_concurrency: 6 } }
    f.quota.reloadConfig({ tiers: updated })
    assert.equal(f.runtime.applyRoutingTierConcurrency(updated)[tier], 1)
    assert.deepEqual(f.policy(), { maxConcurrency: 6, concurrencyOverride: false })
    assert.equal(f.account().max_concurrency, 6)
    assert.equal(f.quota.limitFor(f.account()), 6)
  })
}

for (const cap of [0, 1, 16, 20]) {
  test(`startup retains manual concurrency ${cap} in JSON, DB and admission`, (t) => {
    const f = fixture(t, cap)
    const before = fs.readFileSync(f.vmPath, 'utf8')
    assert.equal(
      f.runtime.applyRoutingTierConcurrency({ default: { max_concurrency: 2 } }, { preserveExisting: true }).skipped,
      1,
    )
    assert.equal(fs.readFileSync(f.vmPath, 'utf8'), before)
    assert.equal(f.account().max_concurrency, cap)
    assert.equal(Boolean(f.account().concurrency_override), true)
    assert.equal(f.quota.limitFor(f.account()), cap)
  })
}

for (const cap of [0, '1']) {
  test(`startup preserves the existing inherited ${JSON.stringify(cap)} field without coercing JSON`, (t) => {
    const f = fixture(t, cap, { override: false })
    const before = fs.readFileSync(f.vmPath, 'utf8')
    f.runtime.applyRoutingTierConcurrency({ default: { max_concurrency: 2 } }, { preserveExisting: true })
    assert.equal(fs.readFileSync(f.vmPath, 'utf8'), before)
    assert.equal(f.account().max_concurrency, 2)
    assert.equal(f.quota.limitFor(f.account()), 2)
  })
}

test('startup still initializes an absent inherited concurrency field', (t) => {
  const f = fixture(t, 1, { override: false })
  const vm = JSON.parse(fs.readFileSync(f.vmPath, 'utf8'))
  delete vm.policy.maxConcurrency
  fs.writeFileSync(f.vmPath, JSON.stringify(vm))
  assert.equal(
    f.runtime.applyRoutingTierConcurrency({ default: { max_concurrency: 2 } }, { preserveExisting: true }).default,
    1,
  )
  assert.deepEqual(f.policy(), { maxConcurrency: 2, concurrencyOverride: false })
  assert.equal(f.account().max_concurrency, 2)
  assert.equal(f.quota.limitFor(f.account()), 2)
})

test('global default updates still reach inherited concurrency', (t) => {
  const f = fixture(t, 2, { override: false })
  f.runtime.applyRoutingConcurrency(4)
  assert.equal(f.policy().maxConcurrency, 4)
  assert.equal(f.policy().concurrencyOverride, false)
  assert.equal(f.account().max_concurrency, 4)
})

test('tier synchronization does not rewrite an unchanged inherited VM record', (t) => {
  const f = fixture(t, 4, { override: false })
  const before = fs.readFileSync(f.vmPath, 'utf8')
  const applied = f.runtime.applyRoutingTierConcurrency({ default: { max_concurrency: 4 } })
  assert.equal(applied.default, 0)
  assert.equal(fs.readFileSync(f.vmPath, 'utf8'), before)
})

function rpmFixture(t, rpm, { override = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-rpm-'))
  const accountId = 'test-account'
  const quota = new AccountQuota({
    dataDir: path.join(root, 'data'),
    accounts: [{ account_id: accountId, vm_id: 'vm-02', max_rpm: rpm }],
  })
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
  t.after(() => {
    quota.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    runtime,
    vmPath,
    policy: () => JSON.parse(fs.readFileSync(vmPath, 'utf8')).policy,
    account: () => quota.repo.get(accountId),
  }
}

test('tier RPM synchronization preserves a manual RPM value', (t) => {
  const f = rpmFixture(t, 30)
  const applied = f.runtime.applyRoutingTierRpm({ default: { max_rpm: 10 } })
  assert.equal(applied.skipped, 1)
  assert.equal(f.policy().maxRpm, 30)
  assert.equal(f.policy().rpmOverride, true)
  assert.equal(f.account().max_rpm, 30)
})

test('tier RPM synchronization updates inherited RPM and skips unchanged records', (t) => {
  const f = rpmFixture(t, 10, { override: false })
  const before = fs.readFileSync(f.vmPath, 'utf8')
  assert.equal(f.runtime.applyRoutingTierRpm({ default: { max_rpm: 10 } }).default, 0)
  assert.equal(fs.readFileSync(f.vmPath, 'utf8'), before)
  assert.equal(f.runtime.applyRoutingTierRpm({ default: { max_rpm: 20 } }).default, 1)
  assert.equal(f.policy().maxRpm, 20)
  assert.equal(f.account().max_rpm, 20)
})
