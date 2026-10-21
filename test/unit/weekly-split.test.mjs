import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import {
  computeWeeklySplit,
  publicWeeklySplit,
  splitBlocksModel,
  weeklySplitConfig,
} from '../../src/lib/pool/weekly-split.mjs'

function close(actual, expected) {
  assert.ok(Math.abs(Number(actual) - expected) < 1e-9, `${actual} !~ ${expected}`)
}

test('uOi 20% leaves 40% of weekly for Fable', () => {
  const s = computeWeeklySplit({ utilization_7d: 0.1, utilization_7d_oi: 0.2 })
  close(s.fable_used_weekly, 0.1)
  close(s.fable_remain_weekly, 0.4)
  close(s.regular_used_weekly, 0)
  close(s.regular_remain_weekly, 0.5)
  assert.equal(s.mode, 'open')
  assert.equal(s.fable_blocked, false)
  assert.equal(s.regular_blocked, false)
})

test('case 1: regular half full and Fable unused → fable_only', () => {
  const s = computeWeeklySplit({ utilization_7d: 0.5, utilization_7d_oi: 0 })
  close(s.regular_used_weekly, 0.5)
  close(s.regular_remain_weekly, 0)
  close(s.fable_used_weekly, 0)
  close(s.fable_remain_weekly, 0.5)
  assert.equal(s.mode, 'fable_only')
  assert.equal(s.regular_blocked, true)
  assert.equal(s.fable_blocked, false)
  assert.equal(splitBlocksModel(s, 'claude-sonnet-5'), 'regular_split')
  assert.equal(splitBlocksModel(s, 'claude-fable-5'), null)
})

test('case 2: 7d_oi full or rejected → regular_only', () => {
  const full = computeWeeklySplit({ utilization_7d: 0.5, utilization_7d_oi: 1 })
  close(full.fable_used_weekly, 0.5)
  close(full.fable_remain_weekly, 0)
  assert.equal(full.mode, 'regular_only')
  assert.equal(full.fable_blocked, true)
  assert.equal(full.regular_blocked, false)
  assert.equal(splitBlocksModel(full, 'claude-fable-5'), 'fable_split')
  assert.equal(splitBlocksModel(full, 'claude-opus-5'), null)

  const rejected = computeWeeklySplit({
    utilization_7d: 0.2,
    utilization_7d_oi: 0.36,
    status_7d_oi: 'rejected',
  })
  assert.equal(rejected.mode, 'regular_only')
  assert.equal(rejected.fable_blocked, true)
  assert.equal(splitBlocksModel(rejected, 'claude-fable-5'), 'fable_split')
})

test('7d_oi rejected with elapsed reset does not block Fable in weekly split', () => {
  const now = Date.parse('2026-10-19T09:00:00Z')
  const s = computeWeeklySplit({
    utilization_7d: 0.2,
    utilization_7d_oi: 0.36,
    status_7d_oi: 'rejected',
    reset_7d_oi: '1792206000',
    now,
  })
  assert.equal(s.fable_blocked, false)
  assert.equal(s.mode, 'open')
})

test('enabled=false never intercepts', () => {
  const s = computeWeeklySplit({
    enabled: false,
    utilization_7d: 0.5,
    utilization_7d_oi: 1,
    status_7d_oi: 'rejected',
  })
  assert.equal(s.enabled, false)
  assert.equal(s.mode, 'open')
  assert.equal(s.fable_blocked, false)
  assert.equal(s.regular_blocked, false)
  assert.equal(splitBlocksModel(s, 'claude-sonnet-5'), null)
  assert.equal(splitBlocksModel(s, 'claude-fable-5'), null)
  assert.equal(publicWeeklySplit(s), null)
  assert.equal(weeklySplitConfig({}).enabled, false)
  assert.equal(weeklySplitConfig({ weekly_split: { enabled: false } }).enabled, false)
})

test('misaligned 7d vs 7d_oi uses the difference as regular usage', () => {
  const s = computeWeeklySplit({ utilization_7d: 0.23, utilization_7d_oi: 0.36 })
  close(s.fable_used_weekly, 0.18)
  close(s.regular_used_weekly, 0.05)
  assert.equal(s.mode, 'open')
})

test('AccountQuota.weeklySplitOf reads unified windows and config', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wsplit-'))
  const q = await new AccountQuota({
    dataDir: dir,
    config: { quota: { weekly_split: { enabled: true, fable_share: 0.5 } } },
  }).init()
  q.ingestHeaders('acc-1', {
    'anthropic-ratelimit-unified-7d-utilization': '0.50',
    'anthropic-ratelimit-unified-7d_oi-utilization': '0',
    'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
  })
  const split = q.weeklySplitOf('acc-1')
  assert.equal(split.enabled, true)
  assert.equal(split.mode, 'fable_only')
  assert.equal(split.regular_blocked, true)
  q.reloadConfig({ quota: { weekly_split: { enabled: false, fable_share: 0.5 } } })
  const off = q.weeklySplitOf('acc-1')
  assert.equal(off.enabled, false)
  assert.equal(splitBlocksModel(off, 'claude-sonnet-5'), null)
})
