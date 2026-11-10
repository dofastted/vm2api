import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { persistOauthToVm, normalizeOauth } from '../../src/lib/oauth/oauth-credentials.mjs'
import { persistVmSubscription, summarizeVm, getVm } from '../../src/lib/vm/vm-registry.mjs'
import { probeAccount } from '../../src/lib/oauth/usage-probe.mjs'
import { createImportCommit } from '../../src/lib/oauth/import-commit.mjs'
import { collectOfficialCcAccount, writeOfficialCcStatus } from '../../src/lib/oauth/official-cc-bootstrap.mjs'
import { buildVmList, buildVmDetail } from '../../src/lib/admin/panel-api.mjs'

const maxProfile = {
  account: { has_claude_max: true },
  organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' },
}

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-plan-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-01.json'),
    JSON.stringify({
      id: 'vm-01',
      status: 'running',
      claude: { has_access: true, account_tier: 'pro' },
    }),
  )
  return root
}

test('OAuth import, normalization, VM persistence and summary retain authoritative metadata', (t) => {
  const root = project(t)
  const { importedCredentialFromOauth } = createImportCommit({})
  const imported = importedCredentialFromOauth({ access_token: 'access', ...maxProfile }, {})
  assert.equal(imported.subscription_type, 'max')
  assert.equal(normalizeOauth(imported).rate_limit_tier, 'default_claude_max_20x')
  const vm = persistOauthToVm(path.join(root, 'vms', 'vm-01.json'), imported, { operatorImport: true })
  const summary = summarizeVm(vm)
  assert.equal(summary.subscription_type, 'max')
  assert.equal(summary.rate_limit_tier, 'default_claude_max_20x')
  assert.equal(summary.account_tier, 'pro')
})

test('refresh without metadata preserves plan; a new operator import clears stale plan', (t) => {
  const root = project(t)
  persistVmSubscription(root, 'vm-01', maxProfile)
  const file = path.join(root, 'vms', 'vm-01.json')
  const refreshed = persistOauthToVm(file, { access_token: 'refreshed' })
  assert.equal(refreshed.claude.subscription_type, 'max')
  const imported = persistOauthToVm(file, { access_token: 'other' }, { operatorImport: true })
  assert.equal(imported.claude.subscription_type, undefined)
  assert.equal(imported.claude.rate_limit_tier, undefined)
})

test('profile persistence is independent of legacy Fable scheduling tier and failed reads', (t) => {
  const root = project(t)
  persistVmSubscription(root, 'vm-01', maxProfile)
  assert.equal(persistVmSubscription(root, 'vm-01', { fable: { ok: true } }), null)
  assert.equal(getVm(root, 'vm-01').claude.subscription_type, 'max')
  persistVmSubscription(root, 'vm-01', { subscription_type: 'pro' })
  assert.equal(getVm(root, 'vm-01').claude.rate_limit_tier, null)
})

test('late profile result cannot overwrite a replacement account', (t) => {
  const root = project(t)
  assert.equal(persistVmSubscription(root, 'vm-01', maxProfile, { accountUuid: 'previous-account' }), null)
  assert.equal(getVm(root, 'vm-01').claude.subscription_type, undefined)
})

test('official bootstrap status keeps authoritative subscription separate from legacy usage tier', (t) => {
  const root = project(t)
  const status = writeOfficialCcStatus(root, {
    account_tier: 'pro',
    subscription_type: 'max',
    rate_limit_tier: 'default_claude_max_20x',
  })
  assert.equal(status.subscription_type, 'max')
  assert.equal(status.rate_limit_tier, 'default_claude_max_20x')
})

test('usage check reads profile via the same slot even when Fable is denied', async () => {
  const exec = { vmId: 'vm-01' }
  const result = await probeAccount({
    exec,
    probeUsage: async () => ({ ok: true, usage_has_fable: false, fable: { plan_denied: true } }),
    slotOauth: async (actualExec, op) => {
      assert.equal(actualExec, exec)
      assert.equal(op, 'profile')
      return { ok: true, body: maxProfile }
    },
  })
  assert.equal(result.subscription_type, 'max')
  assert.equal(result.rate_limit_tier, 'default_claude_max_20x')
  assert.equal(result.subscription_error, null)
})

test('profile failure does not manufacture a plan or fail a successful usage check', async () => {
  const result = await probeAccount({
    exec: { vmId: 'vm-01' },
    probeUsage: async () => ({ ok: true, usage_has_fable: true }),
    slotOauth: async () => ({ ok: false, status: 403 }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.subscription_type, null)
  assert.equal(result.subscription_error, 'http_403')
})

test('inference-only usage check does not request profile', async () => {
  const result = await probeAccount({
    exec: { vmId: 'vm-01' },
    probeUsage: async () => ({ ok: false, usage_scope_missing: true }),
    slotOauth: async () => assert.fail('profile scope is missing'),
  })
  assert.equal(result.usage_scope_missing, true)
})

test('official bootstrap collects subscription multiplier without model-based inference', async () => {
  const result = await collectOfficialCcAccount(
    { vmId: 'vm-01' },
    {
      slotOauth: async (_exec, op) => ({ ok: true, body: op === 'profile' ? maxProfile : { data: [] } }),
    },
  )
  assert.equal(result.subscription_type, 'max')
  assert.equal(result.rate_limit_tier, 'default_claude_max_20x')
})

test('panel list and detail expose authoritative subscription separately from scheduling tier', async (t) => {
  const root = project(t)
  persistVmSubscription(root, 'vm-01', maxProfile)
  const cfg = { paths: { project: root }, rewrite: { enabled: false } }
  const accountQuota = { config: {}, snapshot: () => ({ accounts: [] }) }
  const listed = await buildVmList({ cfg, accountQuota, routingConfig: {} })
  const detail = await buildVmDetail({ cfg, accountQuota, id: 'vm-01' })
  for (const vm of [listed.data.items[0], detail.data.vm]) {
    assert.equal(vm.subscription_type, 'max')
    assert.equal(vm.rate_limit_tier, 'default_claude_max_20x')
    assert.equal(vm.account_tier, 'pro')
  }
})
