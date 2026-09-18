import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extraToCodexSnapshot,
  normalizeCodexLimits,
  buildCodexUsageView,
  extraFromCodexHeaders,
  codexQuotaPark,
  CODEX_DEFAULT_PARK_MS,
} from '../../src/lib/protocol/codex-usage.mjs'

test('extra maps 5h/7d used percent without inversion', () => {
  const snap = extraToCodexSnapshot({
    codex_5h_used_percent: 6,
    codex_7d_used_percent: 34,
    codex_5h_reset_at: '2026-09-07T22:07:49+08:00',
    codex_7d_reset_at: '2026-09-13T21:13:10+08:00',
    codex_5h_window_minutes: 300,
    codex_7d_window_minutes: 10080,
    codex_usage_updated_at: '2026-09-07T19:02:42+08:00',
  })
  assert.equal(snap.secondary_used_percent, 6)
  assert.equal(snap.primary_used_percent, 34)
  const limits = normalizeCodexLimits(snap)
  assert.equal(limits.used_5h_percent, 6)
  assert.equal(limits.used_7d_percent, 34)
  const view = buildCodexUsageView(snap)
  assert.equal(view.unit, 'percent_used')
  assert.equal(view.quota.utilization_5h, 0.06)
  assert.equal(view.quota.utilization_7d, 0.34)
})

test('smaller primary window is 5h', () => {
  const limits = normalizeCodexLimits({
    primary_used_percent: 10,
    primary_window_minutes: 300,
    secondary_used_percent: 80,
    secondary_window_minutes: 10080,
  })
  assert.equal(limits.used_5h_percent, 10)
  assert.equal(limits.used_7d_percent, 80)
})

test('live x-codex headers map to extra without assuming 5h/7d', () => {
  const now = Date.parse('2026-09-17T00:00:00.000Z')
  const extra = extraFromCodexHeaders(
    {
      'X-Codex-Primary-Used-Percent': '12.5',
      'X-Codex-Primary-Window-Minutes': '10080',
      'X-Codex-Primary-Reset-After-Seconds': '3600',
      'X-Codex-Secondary-Used-Percent': '40',
      'X-Codex-Secondary-Window-Minutes': '300',
      'X-Codex-Secondary-Reset-At': String(Math.floor(now / 1000) + 600),
    },
    now,
  )
  const view = buildCodexUsageView(extra)
  assert.equal(view.windows.find((w) => w.id === '5h').used_percent, 40)
  assert.equal(view.windows.find((w) => w.id === '7d').used_percent, 12.5)
  assert.equal(view.quota.utilization_5h, 0.4)
  assert.equal(view.quota.utilization_7d, 0.125)
})

test('capped window parks until reset', () => {
  const now = Date.parse('2026-09-17T00:00:00.000Z')
  const extra = extraFromCodexHeaders(
    {
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '120',
    },
    now,
  )
  const park = codexQuotaPark(extra, now)
  assert.equal(park.limited, true)
  assert.equal(park.until, now + 120_000)
})

test('missing reset on a capped window uses the default park', () => {
  const now = 1_000_000
  const park = codexQuotaPark({ codex_5h_used_percent: 100, codex_5h_window_minutes: 300 }, now)
  assert.equal(park.limited, true)
  assert.equal(park.until, now + CODEX_DEFAULT_PARK_MS)
})

test('headers with no windows return null', () => {
  assert.equal(extraFromCodexHeaders({ 'content-type': 'text/event-stream' }), null)
})

test('elapsed reset on a leftover 100% window is not parked', () => {
  const now = Date.parse('2026-09-17T00:00:00.000Z')
  const park = codexQuotaPark(
    {
      codex_5h_used_percent: 100,
      codex_5h_window_minutes: 300,
      codex_5h_reset_at: new Date(now - 1000).toISOString(),
    },
    now,
  )
  assert.equal(park.limited, false)
})
