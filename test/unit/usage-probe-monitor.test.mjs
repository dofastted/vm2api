import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isUsageProbeDue,
  isUsageProbeTarget,
  normalizeUsageProbeConfig,
  createUsageProbeMonitor,
} from '../../src/lib/oauth/usage-probe-monitor.mjs'

const live = {
  id: 'vm-13',
  status: 'running',
  has_refresh: true,
  proxy: { host: '127.0.0.1', port: 1080, url: 'socks5h://127.0.0.1:1080' },
}

test('normalize fills usage-probe defaults', () => {
  const n = normalizeUsageProbeConfig({ interval_sec: 3, concurrency: 99, stale_sec: 10 })
  assert.equal(n.enabled, true)
  assert.equal(n.interval_sec, 30)
  assert.equal(n.stale_sec, 60)
  assert.equal(n.concurrency, 8)
  assert.equal(n.run_on_start, true)
})

test('only live credential + proxy slots are usage-probe targets', () => {
  assert.equal(isUsageProbeTarget(live), true)
  assert.equal(isUsageProbeTarget({ ...live, has_refresh: false, has_token: false }), false)
  assert.equal(isUsageProbeTarget({ ...live, status: 'stopped' }), false)
  assert.equal(isUsageProbeTarget({ ...live, proxy: null }), false)
})

test('a never-sampled window hops official /usage once', () => {
  assert.deepEqual(isUsageProbeDue({ unified: { '5h': { utilization: 0, status: 'active' } } }), {
    due: true,
    reason: 'never_sampled_official',
  })
})

test('a live Extra window stays passive', () => {
  const now = Date.parse('2026-09-23T11:25:00.000Z')
  assert.deepEqual(
    isUsageProbeDue(
      {
        unified: {
          headers: {
            '5h': { utilization: 0.2, status: 'allowed', reset: '2026-09-23T16:00:00.000Z' },
          },
        },
      },
      { now },
    ),
    { due: false, reason: 'list_passive_only' },
  )
})

test('an official sample without Extra stays passive', () => {
  const now = Date.parse('2026-09-23T11:25:00.000Z')
  assert.deepEqual(
    isUsageProbeDue(
      {
        unified: {
          source: 'vm-oauth-usage',
          official: {
            '5h': { utilization: 0.22, status: 'allowed', reset: '2026-09-23T16:00:00.000Z' },
          },
        },
      },
      { now },
    ),
    { due: false, reason: 'list_passive_only' },
  )
})

test('a stale Pro classification is rechecked without an elapsed Extra window', () => {
  const now = Date.parse('2026-09-23T11:25:00.000Z')
  const account = {
    unified: {
      account_tier: 'pro',
      fable: { plan_denied: true, status: 403, probed_at: '2026-09-23T10:00:00.000Z' },
      fable_probe_attempted_at: '2026-09-23T10:00:00.000Z',
    },
  }
  assert.deepEqual(isUsageProbeDue(account, { now }), { due: true, reason: 'pro_tier_recheck' })
  account.unified.fable_probe_attempted_at = '2026-09-23T11:20:00.000Z'
  assert.deepEqual(isUsageProbeDue(account, { now }), { due: false, reason: 'probed_recently' })
})

test('an elapsed Extra window is probed once, then held for the gap', () => {
  const now = Date.parse('2026-09-23T11:25:00.000Z')
  const reset = '2026-09-23T01:20:00.000Z'
  const stale = {
    unified: {
      headers: {
        '5h': { utilization: 0, status: 'active', reset, stale_reason: 'reset_elapsed' },
        '7d': { utilization: 0.5, status: 'allowed', reset: '2026-09-24T07:00:00.000Z' },
      },
    },
  }
  assert.deepEqual(isUsageProbeDue(stale, { now }), {
    due: true,
    reason: 'extra_window_elapsed',
  })
  const probed = {
    ...stale,
    unified: {
      ...stale.unified,
      last_probe: { at: '2026-09-23T11:20:00.000Z', ok: true },
    },
  }
  assert.deepEqual(isUsageProbeDue(probed, { now }), {
    due: false,
    reason: 'probed_recently',
  })
})

test('invalid_grant slots are not usage-probe targets', () => {
  assert.equal(
    isUsageProbeTarget({
      ...live,
      refresh_error: 'invalid_grant',
      claude: { refresh_error: 'invalid_grant', has_refresh: true },
    }),
    false,
  )
})

const liveExtra = {
  headers: {
    '5h': { utilization: 0.2, status: 'allowed', reset: '2026-12-01T16:00:00.000Z' },
  },
}

test('monitor reconciles Extra and does not call probeAccount', async () => {
  const probed = []
  const reconciled = []
  const monitor = createUsageProbeMonitor({
    config: { interval_sec: 60, stale_sec: 300, run_on_start: false },
    listTargets: () => [live, { ...live, id: 'vm-05' }],
    accountForVm: (vm) => ({ account_id: vm.id, unified: liveExtra }),
    reconcile: (vm) => reconciled.push(vm.id),
    probeOne: async (vm) => {
      probed.push(vm.id)
      return { ok: true, source: 'vm-oauth-usage' }
    },
  })
  const run = await monitor.runOnce()
  assert.deepEqual(reconciled, ['vm-13', 'vm-05'])
  assert.equal(run.due, 0)
  assert.equal(probed.length, 0)
  assert.equal(
    run.items.every((item) => item.reason === 'reconcile_extra'),
    true,
  )
})

test('monitor hops /usage only for an elapsed Extra window', async () => {
  const probed = []
  const staleVm = { ...live, id: 'vm-05' }
  const monitor = createUsageProbeMonitor({
    config: { interval_sec: 60, stale_sec: 300, run_on_start: false },
    listTargets: () => [live, staleVm],
    accountForVm: (vm) =>
      vm.id === 'vm-05'
        ? {
            account_id: vm.id,
            unified: {
              headers: {
                '5h': {
                  utilization: 0,
                  status: 'active',
                  reset: '2026-09-23T01:20:00.000Z',
                  stale_reason: 'reset_elapsed',
                },
              },
            },
          }
        : { account_id: vm.id, unified: liveExtra },
    reconcile: () => {},
    probeOne: async (vm) => {
      probed.push(vm.id)
      return { ok: true, source: 'official-cc-usage' }
    },
  })
  const run = await monitor.runOnce()
  assert.deepEqual(probed, ['vm-05'])
  assert.equal(run.due, 1)
  assert.equal(run.items.find((item) => item.vm_id === 'vm-05')?.reason, 'extra_window_elapsed')
  assert.equal(run.items.find((item) => item.vm_id === 'vm-13')?.reason, 'reconcile_extra')
})
