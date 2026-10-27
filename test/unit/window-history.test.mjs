import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lastClosedWindow, rollWindowHistory } from '../../src/lib/pool/window-history.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'

const H = 3600_000
const now = Date.parse('2026-10-26T12:00:00Z')
const iso = (ms) => new Date(ms).toISOString()

test('first reading opens the current window, no prev yet', () => {
  const h = rollWindowHistory(null, { '5h': { utilization: 0.4, reset: iso(now + 2 * H) } }, now)
  assert.deepEqual(h['5h'], { current: { reset: iso(now + 2 * H), used_ratio: 0.4 } })
  assert.equal(h['7d'], undefined)
  assert.equal(lastClosedWindow(h, '5h', now), null)
})

test('same window keeps the latest reading; reset jitter is not a rollover', () => {
  let h = rollWindowHistory(null, { '5h': { utilization: 0.4, reset: iso(now + 2 * H) } }, now)
  h = rollWindowHistory(h, { '5h': { utilization: 0.55, reset: iso(now + 2 * H + 60_000) } }, now + 60_000)
  assert.equal(h['5h'].current.used_ratio, 0.55)
  assert.equal(h['5h'].prev, undefined)
})

test('natural rollover archives the old window with its final used%', () => {
  const oldReset = now + H
  let h = rollWindowHistory(null, { '5h': { utilization: 0.92, reset: iso(oldReset) } }, now)
  const later = oldReset + 10 * 60_000
  h = rollWindowHistory(h, { '5h': { utilization: 0.03, reset: iso(later + 5 * H) } }, later)
  assert.deepEqual(h['5h'].prev, {
    start: iso(oldReset - 5 * H),
    end: iso(oldReset),
    used_ratio: 0.92,
    closed_at: iso(later),
  })
  assert.equal(h['5h'].current.used_ratio, 0.03)
  assert.deepEqual(lastClosedWindow(h, '5h', later), h['5h'].prev)
})

test('a reset credit ends the window where the new one starts', () => {
  const oldReset = now + 4 * H
  let h = rollWindowHistory(null, { '5h': { utilization: 0.7, reset: iso(oldReset) } }, now)
  h = rollWindowHistory(h, { '5h': { utilization: 0, reset: iso(now + 5 * H) } }, now)
  assert.equal(h['5h'].prev.used_ratio, 0.7)
  assert.equal(h['5h'].prev.start, iso(oldReset - 5 * H))
  assert.equal(h['5h'].prev.end, iso(now))
})

test('elapsed resets and missing used% are leftovers, not readings', () => {
  const h0 = rollWindowHistory(null, { '5h': { utilization: 0.5, reset: iso(now + H) } }, now)
  assert.equal(rollWindowHistory(h0, { '5h': { utilization: 0, reset: iso(now - H) } }, now), h0)
  assert.equal(rollWindowHistory(h0, { '5h': { utilization: null, reset: iso(now + 3 * H) } }, now), h0)
})

test('once the current reset passes it reads as the closed window', () => {
  const h = rollWindowHistory(null, { '7d': { utilization: 0.81, reset: iso(now + H) } }, now)
  assert.deepEqual(lastClosedWindow(h, '7d', now + 2 * H), {
    start: iso(now + H - 7 * 24 * H),
    end: iso(now + H),
    used_ratio: 0.81,
  })
})

test('AccountQuota archives the 5h window across header readings and persists it', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-winhist-'))
  const q = new AccountQuota({ dataDir, config: {} })
  const sec = (ms) => String(Math.floor(ms / 1000))
  const t = Date.now()
  q.ingestHeaders('a-hist', {
    'anthropic-ratelimit-unified-5h-utilization': '0.6',
    'anthropic-ratelimit-unified-5h-reset': sec(t + H),
    'anthropic-ratelimit-unified-5h-status': 'allowed',
  })
  q.ingestHeaders('a-hist', {
    'anthropic-ratelimit-unified-5h-utilization': '0.01',
    'anthropic-ratelimit-unified-5h-reset': sec(t + 5 * H),
    'anthropic-ratelimit-unified-5h-status': 'allowed',
  })
  const hist = q.repo.get('a-hist').window_history
  assert.equal(hist['5h'].prev.used_ratio, 0.6)
  assert.equal(hist['5h'].current.used_ratio, 0.01)
  const snap = q.snapshot().accounts.find((a) => a.account_id === 'a-hist')
  assert.equal(snap.window_history['5h'].prev.used_ratio, 0.6)
})
