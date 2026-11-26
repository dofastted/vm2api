import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extraToCodexSnapshot,
  normalizeCodexLimits,
  buildCodexUsageView,
  extraFromCodexHeaders,
  codexQuotaPark,
  CODEX_DEFAULT_PARK_MS,
  codexWindowIdFromMinutes,
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
  // A fixed `now` inside the window keeps this testing the mapping; with the
  // real clock the 2026-09 resets are elapsed and the view correctly drops them.
  const view = buildCodexUsageView(snap, Date.parse('2026-09-07T00:00:00.000Z'))
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
  const view = buildCodexUsageView(extra, now)
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

test('quota view drops elapsed 5h/7d readings instead of pinning the panel at the stale window', () => {
  const now = Date.parse('2026-09-17T00:00:00.000Z')
  // 5h reset elapsed, 7d still live: the 100% is the closed window's leftover.
  const view = buildCodexUsageView(
    {
      codex_5h_used_percent: 100,
      codex_5h_window_minutes: 300,
      codex_5h_reset_at: new Date(now - 60_000).toISOString(),
      codex_7d_used_percent: 67,
      codex_7d_window_minutes: 10080,
      codex_7d_reset_at: new Date(now + 3600_000).toISOString(),
    },
    now,
  )
  assert.equal(view.quota.utilization_5h, null)
  assert.equal(view.quota.status_5h, null)
  assert.equal(view.quota.reset_5h, null)
  assert.equal(view.quota.utilization_7d, 0.67)
  assert.equal(view.quota.status_7d, 'ok')
  // Live caps keep their reading: scheduling treats them as restricted, so
  // the panel must keep showing them.
  const liveView = buildCodexUsageView(
    {
      codex_5h_used_percent: 100,
      codex_5h_window_minutes: 300,
      codex_5h_reset_at: new Date(now + 500_000).toISOString(),
    },
    now,
  )
  assert.equal(liveView.quota.utilization_5h, 1)
  assert.equal(liveView.quota.status_5h, 'limited')
  // No reset on the reading: unknown liveness stays conservative (unchanged).
  const noResetView = buildCodexUsageView(
    {
      codex_5h_used_percent: 100,
      codex_5h_window_minutes: 300,
    },
    now,
  )
  assert.equal(noResetView.quota.utilization_5h, 1)
  assert.equal(noResetView.quota.status_5h, 'limited')
})

test('classifies 1440-minute window as 24h and ignores 0-minute records (#1744)', () => {
  const view = buildCodexUsageView({
    codex_primary_window_minutes: 1440,
    codex_primary_used_percent: 1,
    codex_secondary_window_minutes: 0,
    codex_secondary_used_percent: 0,
  })
  assert.deepEqual(
    view.windows.map(({ id, label, window_minutes, used_percent }) => ({ id, label, window_minutes, used_percent })),
    [{ id: '24h', label: '24h', window_minutes: 1440, used_percent: 1 }],
  )
  assert.equal(view.limits.used_5h_percent, null)
  assert.equal(view.limits.window_5h_minutes, null)
  assert.equal(view.limits.used_7d_percent, null)
  assert.equal(view.limits.window_7d_minutes, null)
  assert.equal(view.quota.utilization_5h, null)
  assert.equal(view.quota.utilization_7d, null)
})

test('ignores stale 5h/7d aliases next to explicit 24h and 0-minute raw windows', () => {
  const view = buildCodexUsageView({
    codex_primary_window_minutes: 1440,
    codex_primary_used_percent: 1,
    codex_secondary_window_minutes: 0,
    codex_secondary_used_percent: 0,
    codex_5h_window_minutes: 0,
    codex_5h_used_percent: 0,
    codex_7d_window_minutes: 1440,
    codex_7d_used_percent: 1,
  })
  assert.deepEqual(
    view.windows.map(({ id, window_minutes, used_percent }) => ({ id, window_minutes, used_percent })),
    [{ id: '24h', window_minutes: 1440, used_percent: 1 }],
  )
  assert.equal(view.quota.utilization_5h, null)
  assert.equal(view.quota.utilization_7d, null)
})

test('0-minute secondary alongside 7d leaves 5h unknown instead of 0%', () => {
  const view = buildCodexUsageView({
    codex_primary_window_minutes: 10080,
    codex_primary_used_percent: 42,
    codex_secondary_window_minutes: 0,
    codex_secondary_used_percent: 0,
  })
  assert.deepEqual(
    view.windows.map(({ id, window_minutes, used_percent }) => ({ id, window_minutes, used_percent })),
    [
      { id: '5h', window_minutes: null, used_percent: null },
      { id: '7d', window_minutes: 10080, used_percent: 42 },
    ],
  )
  assert.equal(view.quota.utilization_5h, null)
  assert.equal(view.quota.utilization_7d, 0.42)
})

test('duration formatter covers standard, daily, multi-day, minute, and invalid windows', () => {
  assert.equal(codexWindowIdFromMinutes(300), '5h')
  assert.equal(codexWindowIdFromMinutes(1440), '24h')
  assert.equal(codexWindowIdFromMinutes(10080), '7d')
  assert.equal(codexWindowIdFromMinutes(60), '1h')
  assert.equal(codexWindowIdFromMinutes(2880), '2d')
  assert.equal(codexWindowIdFromMinutes(45), '45m')
  assert.equal(codexWindowIdFromMinutes(0), null)
  assert.equal(codexWindowIdFromMinutes(-10), null)
  assert.equal(codexWindowIdFromMinutes(null), null)
})

test('codexQuotaPark enforces 100% cap on 24h windows and ignores 0-minute records', () => {
  const now = Date.parse('2026-11-24T00:00:00.000Z')
  const resetAt = new Date(now + 3600_000).toISOString()
  const capped24h = codexQuotaPark(
    {
      codex_primary_window_minutes: 1440,
      codex_primary_used_percent: 100,
      codex_primary_reset_at: resetAt,
      codex_secondary_window_minutes: 0,
      codex_secondary_used_percent: 0,
    },
    now,
  )
  assert.equal(capped24h.limited, true)
  assert.equal(capped24h.until, now + 3600_000)

  const bogusZero = codexQuotaPark(
    {
      codex_primary_window_minutes: 1440,
      codex_primary_used_percent: 1,
      codex_secondary_window_minutes: 0,
      codex_secondary_used_percent: 100,
      codex_secondary_reset_at: resetAt,
    },
    now,
  )
  assert.equal(bogusZero.limited, false)
})
