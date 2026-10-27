import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleCodexProtocol } from '../../src/lib/protocol/handle-codex.mjs'
import { getVm, listVms, persistCodexUsage } from '../../src/lib/vm/vm-registry.mjs'
import { persistCodexQuotaSnapshot } from '../../src/lib/vm/codex-slot.mjs'
import { codexQuotaPark, CODEX_DEFAULT_PARK_MS } from '../../src/lib/protocol/codex-usage.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

beforeEach(() => resetOpenAIAccountRuntime())

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-stale-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-a.json'),
    JSON.stringify({
      id: 'vm-a',
      platform: 'openai',
      family: 'codex',
      status: 'running',
      schedulable: true,
      codex: {
        has_access: true,
        extra: {
          codex_primary_used_percent: 20,
          codex_primary_window_minutes: 300,
          codex_secondary_used_percent: 30,
          codex_secondary_window_minutes: 10080,
          // Manual quota queries also retain the normalized aliases.
          codex_5h_used_percent: 20,
          codex_5h_window_minutes: 300,
          codex_7d_used_percent: 30,
          codex_7d_window_minutes: 10080,
          ...extra,
        },
      },
    }),
  )
  return root
}

async function hop(root, { headers = {}, code = 'usage_limit_reached', status = 429 } = {}) {
  let calls = 0
  const result = await handleCodexProtocol({
    req: { headers: {}, apiKeyKind: 'user' },
    res: { headersSent: false, write() {}, end() {} },
    protocol: 'openai.responses',
    ctx: { body: { model: 'gpt-5.4', input: 'fixture', stream: false } },
    inbound: { stream: false },
    logBag: {},
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, _status, body) => body,
    writeSSEHeaders() {},
    routing: {},
    projectRoot: root,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async () => {
        calls += 1
        return {
          ok: status === 200,
          status,
          committed: false,
          headers,
          body: status === 200 ? { id: 'fixture-response' } : { error: { code, type: 'api_error' } },
        }
      },
    },
  })
  assert.equal(calls, 1, 'fixture must exercise the real protocol ingestion path')
  return result
}

function values(root) {
  const vm = getVm(root, 'vm-a')
  const summary = listVms(root).find((v) => v.id === 'vm-a')
  return { vm, summary, windows: summary.codex_usage.windows.map((w) => w.used_percent) }
}

test('quota error without headers invalidates cached below-cap percentages in the actual protocol path', async (t) => {
  const root = fixture(t)
  await hop(root)
  const { vm, summary, windows } = values(root)
  assert.deepEqual(windows, [null, null])
  assert.equal(summary.utilization_5h, null)
  assert.equal(summary.utilization_7d, null)
  assert.equal(vm.codex.usage.quota.utilization_5h, null)
  assert.equal(vm.schedulable, true)
  const until = Date.parse(vm.codex.extra.codex_limited_until)
  assert.ok(until > Date.now())
  assert.equal(codexQuotaPark(vm.codex.extra, until - 1).limited, true)
  assert.equal(codexQuotaPark(vm.codex.extra, until + 1).limited, false)
  assert.deepEqual(values(root).windows, [null, null], 'park expiry cannot resurrect stale percentages')
})

test('quota error keeps fresh partial headers but does not revive an old alias for the missing window', async (t) => {
  const root = fixture(t)
  await hop(root, {
    headers: {
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '120',
    },
  })
  const { vm, windows } = values(root)
  assert.deepEqual(windows, [100, null])
  assert.equal(vm.codex.usage.quota.utilization_5h, 1)
  assert.ok(Date.parse(vm.codex.extra.codex_limited_until) > Date.now() + CODEX_DEFAULT_PARK_MS)
})

test('quota error preserves both authoritative window percentages, including a below-cap one', async (t) => {
  const root = fixture(t)
  await hop(root, {
    headers: {
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-window-minutes': '300',
      'x-codex-secondary-used-percent': '31',
      'x-codex-secondary-window-minutes': '10080',
    },
  })
  assert.deepEqual(values(root).windows, [100, 31])
})

test('reset-only quota headers must not restore cached utilization through normalized aliases', async (t) => {
  const root = fixture(t)
  await hop(root, {
    headers: {
      'x-codex-primary-reset-after-seconds': '120',
      'x-codex-primary-window-minutes': '300',
    },
  })
  assert.deepEqual(values(root).windows, [null, null])
})

test('generic rate limit is not proof that quota percentages are stale', async (t) => {
  const root = fixture(t)
  await hop(root, { code: 'rate_limit_exceeded' })
  assert.deepEqual(values(root).windows, [20, 30])
})

test('success without quota headers keeps the last measured percentages', async (t) => {
  const root = fixture(t)
  await hop(root, { status: 200 })
  assert.deepEqual(values(root).windows, [20, 30])
})

test('a known capped window is not erased or released by a headerless quota error', async (t) => {
  const reset = new Date(Date.now() + 3_600_000).toISOString()
  const root = fixture(t, {
    codex_secondary_used_percent: 100,
    codex_7d_used_percent: 100,
    codex_secondary_reset_at: reset,
    codex_7d_reset_at: reset,
  })
  // A concurrent hop can finish after another request recorded a capped window.
  persistCodexUsage(root, 'vm-a', { quotaExceeded: true, limitedUntil: Date.now() + CODEX_DEFAULT_PARK_MS })
  const { vm, windows } = values(root)
  assert.deepEqual(windows, [null, 100])
  assert.equal(codexQuotaPark(vm.codex.extra, Date.now() + 120_000).limited, true)
})

test('normal header ingestion still merges a missing window instead of discarding it', (t) => {
  const root = fixture(t)
  persistCodexUsage(root, 'vm-a', {
    headers: {
      'x-codex-primary-used-percent': '25',
      'x-codex-primary-window-minutes': '300',
    },
  })
  assert.deepEqual(values(root).windows, [25, 30])
})

test('a later real header sample restores values without a sticky invalidation flag', async (t) => {
  const root = fixture(t)
  await hop(root)
  persistCodexUsage(root, 'vm-a', {
    headers: {
      'x-codex-primary-used-percent': '2',
      'x-codex-primary-window-minutes': '300',
      'x-codex-secondary-used-percent': '32',
      'x-codex-secondary-window-minutes': '10080',
    },
  })
  assert.deepEqual(values(root).windows, [2, 32])
  assert.equal(getVm(root, 'vm-a').codex.extra.codex_limited_until, undefined)
})

test('manual quota query restores normalized aliases after a headerless quota error', async (t) => {
  const root = fixture(t)
  await hop(root)
  persistCodexQuotaSnapshot(root, 'vm-a', {
    extra: {
      codex_primary_used_percent: 100,
      codex_primary_window_minutes: 300,
      codex_secondary_used_percent: 35,
      codex_secondary_window_minutes: 10080,
      codex_5h_used_percent: 100,
      codex_7d_used_percent: 35,
    },
  })
  assert.deepEqual(values(root).windows, [100, 35])
})

test('legacy normalized-only usage keeps a known cap without creating role fields', (t) => {
  const reset = new Date(Date.now() + 3_600_000).toISOString()
  const root = fixture(t, {
    codex_primary_used_percent: undefined,
    codex_primary_window_minutes: undefined,
    codex_secondary_used_percent: undefined,
    codex_secondary_window_minutes: undefined,
    codex_7d_used_percent: 100,
    codex_7d_reset_at: reset,
  })
  persistCodexUsage(root, 'vm-a', { quotaExceeded: true, limitedUntil: Date.now() + CODEX_DEFAULT_PARK_MS })
  assert.deepEqual(values(root).windows, [null, 100])
})

test('fresh zero percent is a measurement, not a missing reading', async (t) => {
  const root = fixture(t)
  await hop(root, {
    headers: {
      'x-codex-primary-used-percent': '0',
      'x-codex-primary-window-minutes': '300',
    },
  })
  assert.deepEqual(values(root).windows, [0, null])
})

test('manual quota refresh drops a stale codex_limited_until when windows are below cap', (t) => {
  const parkedUntil = new Date(Date.now() + 5 * 86_400_000).toISOString()
  const root = fixture(t, { codex_limited_until: parkedUntil })
  persistCodexQuotaSnapshot(root, 'vm-a', {
    extra: {
      codex_primary_used_percent: 0,
      codex_primary_window_minutes: 10080,
      codex_secondary_used_percent: 0,
      codex_secondary_window_minutes: 0,
      codex_5h_used_percent: 0,
      codex_7d_used_percent: 0,
    },
    credits: { has_credits: false, unlimited: false, balance: '0' },
  })
  assert.equal(getVm(root, 'vm-a').codex.extra.codex_limited_until, undefined)
})
