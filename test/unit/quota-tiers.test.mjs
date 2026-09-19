import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_TIER_POLICIES,
  accountTierKey,
  mergeTierMaps,
  normalizeTiers,
  resolveTierKey,
  resolveTierPolicy,
} from '../../src/lib/pool/quota-tiers.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { buildRouting } from '../../src/lib/admin/panel-api.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tiers-'))
}

test('normalizeTiers fills product defaults', () => {
  const tiers = normalizeTiers()
  assert.deepEqual(tiers.default, DEFAULT_TIER_POLICIES.default)
  assert.deepEqual(tiers.pro, DEFAULT_TIER_POLICIES.pro)
  assert.deepEqual(tiers.max, DEFAULT_TIER_POLICIES.max)
})

test('normalizeTiers reads limit_5h and aliases old safety_ratio', () => {
  const fromNew = normalizeTiers({
    pro: { max_concurrency: 3, limit_5h: 0.7, limit_7d: 0.6 },
  })
  assert.equal(fromNew.pro.limit_5h, 0.7)
  assert.equal(fromNew.pro.safety_ratio, 0.7)
  assert.equal(fromNew.pro.limit_7d, 0.6)
  assert.equal(fromNew.pro.weekly_safety_ratio, 0.6)

  const fromOld = normalizeTiers({
    pro: { max_concurrency: 3, safety_ratio: 0.7, weekly_safety_ratio: 0.6, warn_ratio: 0.55 },
  })
  assert.equal(fromOld.pro.limit_5h, 0.7)
  assert.equal(fromOld.pro.limit_7d, 0.6)
  assert.equal(fromOld.pro.max_sessions, 0)
})

test('resolveTierKey maps unknown to default', () => {
  assert.equal(resolveTierKey('pro'), 'pro')
  assert.equal(resolveTierKey('MAX'), 'max')
  assert.equal(resolveTierKey('unknown'), 'default')
  assert.equal(accountTierKey({ unified: { account_tier: 'pro' } }), 'pro')
})

test('mergeTierMaps only overlays provided keys', () => {
  const merged = mergeTierMaps(
    { pro: { max_concurrency: 2, safety_ratio: 0.85 } },
    { pro: { weekly_safety_ratio: 0.6 }, max: { max_concurrency: 8 } },
  )
  assert.equal(merged.pro.max_concurrency, 2)
  assert.equal(merged.pro.weekly_safety_ratio, 0.6)
  assert.equal(merged.max.max_concurrency, 8)
})

test('buildRouting returns tiers so the panel can re-render a save', () => {
  const data = buildRouting({
    routingConfig: { sticky: {}, quota: {}, concurrency: {} },
    stickyRouter: { stats: () => ({ active_sessions: 0 }) },
  }).data
  assert.ok(data.tiers.pro)
  assert.equal(data.tiers.pro.max_concurrency, 2)
  assert.equal(data.tiers.pro.limit_5h, 0.85)
  assert.equal(data.tiers.pro.limit_7d, 0.8)
  assert.equal(data.tiers.pro.weekly_safety_ratio, 0.8)
  assert.equal(data.tiers.max.max_concurrency, 4)
})

test('canAccept uses per-tier 5h and weekly lines', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: {
      quota: { block_on_5h: true, block_on_7d: true },
      tiers: {
        default: { max_concurrency: 2, safety_ratio: 0.85, weekly_safety_ratio: 0.8, warn_ratio: 0.75 },
        pro: { max_concurrency: 2, safety_ratio: 0.85, weekly_safety_ratio: 0.8, warn_ratio: 0.75 },
        max: { max_concurrency: 4, safety_ratio: 0.95, weekly_safety_ratio: 0.95, warn_ratio: 0.85 },
      },
    },
  })
  q.ensure({ account_id: 'pro-1' })
  q.setAccountTier('pro-1', 'pro')
  q.ingestHeaders('pro-1', { 'anthropic-ratelimit-unified-5h-utilization': '0.86' })
  assert.equal(q.canAccept('pro-1').reason, 'quota_5h_safety')

  q.ensure({ account_id: 'max-1' })
  q.setAccountTier('max-1', 'max')
  q.ingestHeaders('max-1', {
    'anthropic-ratelimit-unified-5h-utilization': '0.86',
    'anthropic-ratelimit-unified-7d-utilization': '0.90',
  })
  assert.equal(q.canAccept('max-1').ok, true, 'Max 5h/7d stay under 95%')

  q.ingestHeaders('max-1', { 'anthropic-ratelimit-unified-7d-utilization': '0.96' })
  assert.equal(q.canAccept('max-1').reason, 'quota_7d_safety')
})

test('reloadConfig picks up saved weekly line without process restart shape', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  q.ensure({ account_id: 'p' })
  q.setAccountTier('p', 'pro')
  q.ingestHeaders('p', { 'anthropic-ratelimit-unified-7d-utilization': '0.82' })
  assert.equal(q.canAccept('p').reason, 'quota_7d_safety')
  q.reloadConfig({
    quota: { block_on_5h: true, block_on_7d: true },
    tiers: { pro: { max_concurrency: 2, safety_ratio: 0.85, weekly_safety_ratio: 0.9, warn_ratio: 0.75 } },
  })
  assert.equal(q.canAccept('p').ok, true)
})

test('applyTierConcurrency writes only the matching tier', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: { concurrency: { default_max_per_account: 20 } },
    accounts: [
      { account_id: 'a-pro', vm_id: 'vm-1', max_concurrency: 20 },
      { account_id: 'a-max', vm_id: 'vm-2', max_concurrency: 20 },
    ],
  })
  q.setAccountTier('a-pro', 'pro')
  q.setAccountTier('a-max', 'max')
  q.applyTierConcurrency({
    default: { max_concurrency: 2 },
    pro: { max_concurrency: 2 },
    max: { max_concurrency: 4 },
  })
  assert.equal(q.repo.get('a-pro').max_concurrency, 2)
  assert.equal(q.repo.get('a-max').max_concurrency, 4)
})

test('applyTierRpm writes only the matching tier and skips override', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: {},
    accounts: [
      { account_id: 'r-pro', vm_id: 'vm-1', max_rpm: 0 },
      { account_id: 'r-max', vm_id: 'vm-2', max_rpm: 0 },
      { account_id: 'r-pin', vm_id: 'vm-3', max_rpm: 99 },
    ],
  })
  q.setAccountTier('r-pro', 'pro')
  q.setAccountTier('r-max', 'max')
  q.setMaxRpm('r-pin', 99, { override: true })
  q.applyTierRpm({
    default: { max_rpm: 10 },
    pro: { max_rpm: 15 },
    max: { max_rpm: 30 },
  })
  assert.equal(q.repo.get('r-pro').max_rpm, 15)
  assert.equal(q.repo.get('r-max').max_rpm, 30)
  assert.equal(q.repo.get('r-pin').max_rpm, 99)
})

test('resolveTierPolicy reads live config', () => {
  const p = resolveTierPolicy(
    {
      tiers: { max: { max_concurrency: 8, safety_ratio: 0.9, weekly_safety_ratio: 0.7, warn_ratio: 0.6 } },
    },
    'max',
  )
  assert.equal(p.max_concurrency, 8)
  assert.equal(p.limit_7d, 0.7)
  assert.equal(p.weekly_safety_ratio, 0.7)
})

test('saving Pro 5h=80% lands on policyFor limit_5h', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: {
      quota: { block_on_5h: true, block_on_7d: true },
      tiers: normalizeTiers({
        pro: { limit_5h: 0.8, limit_7d: 0.8, max_concurrency: 2, max_sessions: 0 },
      }),
    },
  })
  q.ensure({ account_id: 'pro-80' })
  q.setAccountTier('pro-80', 'pro')
  assert.equal(q.policyFor(q.repo.get('pro-80')).limit_5h, 0.8)
  q.ingestHeaders('pro-80', { 'anthropic-ratelimit-unified-5h-utilization': '0.81' })
  assert.equal(q.canAccept('pro-80').reason, 'quota_5h_safety')
})

test('reloadConfig applies conc rpm sessions without rewriting account rows', () => {
  const q = new AccountQuota({
    dataDir: tmpDir(),
    config: {
      quota: { block_on_5h: true, block_on_7d: true },
      tiers: { default: { max_concurrency: 2, max_rpm: 0, max_sessions: 0 } },
    },
  })
  q.ensure({ account_id: 'live' })
  const acc = q.repo.get('live')
  assert.equal(q.limitFor(acc), 2)
  assert.equal(q.rpmLimitFor(acc), 0)
  q.reloadConfig({
    quota: { block_on_5h: true, block_on_7d: true },
    tiers: { default: { max_concurrency: 8, max_rpm: 12, max_sessions: 2, session_idle_min: 5 } },
  })
  assert.equal(q.limitFor(q.repo.get('live')), 8)
  assert.equal(q.rpmLimitFor(q.repo.get('live')), 12)
  q.sessions.touch('live', 's1')
  q.sessions.release('live', 's1')
  q.sessions.touch('live', 's2')
  q.sessions.release('live', 's2')
  assert.equal(q.canAccept('live', { sessionKey: 's3' }).reason, 'session_limit')
  assert.equal(q.canAccept('live', { sessionKey: 's1' }).ok, true)
})

test('manual conc and rpm pins ignore live tier', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  q.ensure({ account_id: 'pin' })
  q.setMaxConcurrency('pin', 1, { override: true })
  q.setMaxRpm('pin', 2, { override: true })
  q.reloadConfig({
    quota: { block_on_5h: true, block_on_7d: true },
    tiers: { default: { max_concurrency: 8, max_rpm: 60 } },
  })
  assert.equal(q.limitFor(q.repo.get('pin')), 1)
  assert.equal(q.rpmLimitFor(q.repo.get('pin')), 2)
})
