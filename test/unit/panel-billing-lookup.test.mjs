import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildUsage, buildVmList, indexBillingAccounts, lookupBilling } from '../../src/lib/admin/panel-api.mjs'

test('billing index keeps UUID row when leftover vm-id account is empty', () => {
  const leftover = {
    account_id: 'vm-50',
    vm_id: 'vm-50',
    today_requests: 0,
    today_cache_read_tokens: 0,
    requests: 0,
    today_cost: 0,
  }
  const real = {
    account_id: '7667b68b-3351-4bc9-b06e-39d6795b3019',
    vm_id: 'vm-50',
    today_requests: 243,
    today_cache_read_tokens: 24757802,
    requests: 245,
    today_cost: 24.45,
  }
  const index = indexBillingAccounts({ accounts: [real, leftover] })
  const vm = { id: 'vm-50', account_uuid: real.account_id }
  const leftoverAcc = { account_id: 'vm-50', vm_id: 'vm-50' }
  assert.equal(lookupBilling(index, vm), real)
  assert.equal(lookupBilling(index, leftoverAcc), real)
  assert.equal(lookupBilling(index, { id: 'vm-50' }), real)
})

test('billing rows of an older account on a reused slot keep their own email', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-billing-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const billing = {
    accounts: [
      { account_id: 'old-uuid', vm_id: 'vm-02', total_cost: 9, email: 'old@example.com' },
      { account_id: 'new-uuid', vm_id: 'vm-02', total_cost: 1 },
      { vm_id: 'vm-03', total_cost: 1 },
    ],
  }
  const accountQuota = {
    snapshot: () => ({
      accounts: [
        { account_id: 'new-uuid', vm_id: 'vm-02', email: 'new@example.com' },
        { account_id: 'vm3-uuid', vm_id: 'vm-03', email: 'three@example.com' },
      ],
    }),
  }
  const usage = await buildUsage({
    accountQuota,
    cfg: { paths: { project: root } },
    requestLog: { billingStats: () => billing },
  })
  const emails = usage.data.billing.accounts.map((row) => row.email)
  assert.deepEqual(emails, ['old@example.com', 'new@example.com', 'three@example.com'])
})

test('VM list carries lifetime tokens from the same billing row as total_cost', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-billing-tokens-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', 'vm-07.json'), JSON.stringify({ id: 'vm-07' }))
  fs.writeFileSync(path.join(root, 'vms', 'vm-08.json'), JSON.stringify({ id: 'vm-08' }))
  const listed = await buildVmList({
    cfg: { paths: { project: root } },
    accountQuota: { config: {}, snapshot: () => ({ accounts: [] }) },
    routingConfig: {},
    requestLog: {
      billingStats: () => ({
        accounts: [
          {
            account_id: 'vm-07',
            vm_id: 'vm-07',
            total_cost: 12.5,
            input_tokens: 1200,
            output_tokens: 300,
            cache_read_tokens: 90000,
            window_5h_tokens: 40,
            window_7d_tokens: 900,
            today: { input_tokens: 200, output_tokens: 300, cache_read_tokens: 9000, cache_creation_tokens: 500 },
          },
        ],
      }),
    },
  })
  const byId = Object.fromEntries(listed.data.items.map((vm) => [vm.id, vm]))
  assert.equal(byId['vm-07'].total_cost, 12.5)
  assert.equal(byId['vm-07'].total_tokens, 91500)
  assert.equal(byId['vm-07'].window_5h_tokens, 40)
  assert.equal(byId['vm-07'].window_7d_tokens, 900)
  // Claude input excludes cache; 今日 must count the cache buckets too (input + output alone was 500).
  assert.equal(byId['vm-07'].today_tokens, 10000)
  assert.equal(byId['vm-08'].total_tokens, 0)
})

test('usage rows of a deleted VM are not listed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-usage-deleted-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', 'vm-02.json'), JSON.stringify({ id: 'vm-02' }))
  const usage = await buildUsage({
    accountQuota: {
      snapshot: () => ({
        accounts: [
          { account_id: 'two-uuid', vm_id: 'vm-02', email: 'two@example.com', requests: 1 },
          { account_id: 'three-uuid', vm_id: 'vm-03', email: 'three@example.com', requests: 5 },
        ],
      }),
    },
    cfg: { paths: { project: root } },
    requestLog: {
      billingStats: () => ({ accounts: [{ account_id: 'three-uuid', vm_id: 'vm-03', total_cost: 3 }] }),
    },
  })
  assert.deepEqual(
    usage.data.accounts.map((a) => a.vm_id),
    ['vm-02'],
  )
  assert.equal(usage.data.totals.requests, 1)
  assert.equal(usage.data.billing.accounts[0].email, 'three@example.com')
})

test('GPT usage row without pool email takes slot email', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-gpt-usage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-codex-01.json'),
    JSON.stringify({
      id: 'vm-codex-01',
      platform: 'openai',
      family: 'codex',
      codex_kernel: true,
      email: 'lemeryvorhees@gmail.com',
      codex: { email: 'lemeryvorhees@gmail.com' },
    }),
  )
  const usage = await buildUsage({
    accountQuota: {
      snapshot: () => ({
        accounts: [{ account_id: 'vm-codex-01', vm_id: 'vm-codex-01', email: null }],
      }),
    },
    cfg: { paths: { project: root } },
    requestLog: {
      billingStats: () => ({
        accounts: [{ account_id: 'vm-codex-01', vm_id: 'vm-codex-01', total_cost: 139.87, today_cost: 24.86 }],
      }),
    },
  })
  const row = usage.data.accounts.find((a) => a.vm_id === 'vm-codex-01')
  assert.equal(row?.email, 'lemeryvorhees@gmail.com')
  assert.equal(row?.total_cost, 139.87)
})
