import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { parseVmQuotaOverride, vmQuotaOverrideOf } from '../../src/lib/pool/vm-quota-override.mjs'

async function quota() {
  return await new AccountQuota({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-quota-')),
    config: {
      quota: { block_on_5h: true, block_on_7d: true },
      tiers: { default: { limit_5h: 0.85, limit_7d: 0.8, max_concurrency: 4 } },
    },
    accounts: [
      { account_id: 'acc-a', vm_id: 'vm-a' },
      { account_id: 'acc-b', vm_id: 'vm-b' },
    ],
  }).init()
}

function setUtil(q, accountId, u5, u7 = 0.1) {
  q.ingestHeaders(
    accountId,
    {
      'anthropic-ratelimit-unified-5h-utilization': String(u5),
      'anthropic-ratelimit-unified-7d-utilization': String(u7),
      'anthropic-ratelimit-unified-5h-reset': new Date(Date.now() + 3600_000).toISOString(),
    },
    {},
  )
}

test('VM 5h threshold override only moves that VM gate', async () => {
  const q = await quota()
  q.setVmQuotaOverride('vm-a', { limit_5h: 0.95 })
  setUtil(q, 'acc-a', 0.9)
  setUtil(q, 'acc-b', 0.9)
  assert.equal(q.canAccept('acc-a').ok, true)
  assert.equal(q.canAccept('acc-b').reason, 'quota_5h_safety')
})

test('VM block switch off lets the slot run past its threshold; clearing restores global', async () => {
  const q = await quota()
  setUtil(q, 'acc-a', 0.9)
  q.setVmQuotaOverride('vm-a', { block_on_5h: false })
  assert.equal(q.canAccept('acc-a').ok, true)
  q.setVmQuotaOverride('vm-a', null)
  assert.equal(q.canAccept('acc-a').reason, 'quota_5h_safety')
})

test('parseVmQuotaOverride rejects out-of-range and unknown fields, null field follows global', () => {
  assert.deepEqual(parseVmQuotaOverride({ limit_5h: 0.9, limit_7d: null }), {
    ok: true,
    value: { limit_5h: 0.9 },
  })
  assert.deepEqual(parseVmQuotaOverride({ limit_5h: null }), { ok: true, value: null })
  assert.equal(parseVmQuotaOverride({ limit_5h: 0.2 }).ok, false)
  assert.equal(parseVmQuotaOverride({ limit_7d: 1.5 }).ok, false)
  assert.equal(parseVmQuotaOverride({ block_on_5h: 'yes' }).ok, false)
  assert.equal(parseVmQuotaOverride({ max_concurrency: 4 }).ok, false)
})

test('stored session window fields are ignored on read', () => {
  assert.deepEqual(vmQuotaOverrideOf({ policy: { quota: { limit_5h: 0.9, max_sessions: 2, session_idle_min: 5 } } }), {
    limit_5h: 0.9,
  })
  assert.equal(parseVmQuotaOverride({ max_sessions: 1 }).ok, false)
})
