import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PoolScheduler,
  quotaGuardConfigOf,
  quotaGuardLevel,
  quotaGuardUsage,
} from '../../src/lib/pool/pool-scheduler.mjs'
import { classifyUpstreamResult } from '../../src/lib/pool/upstream-error-policy.mjs'
import { RateLimitService } from '../../src/lib/pool/rate-limit-service.mjs'
import { adoptProviderResponseHeaders } from '../../src/lib/pool/failover-runner.mjs'

const HOUR = 3600_000
const on = quotaGuardConfigOf({ exhaustion_guard: true })
const off = quotaGuardConfigOf({})

const at = (ratio, extra = {}) => ({
  headers: { '5h': { utilization: ratio, status: 'allowed', reset: new Date(Date.now() + 2 * HOUR).toISOString() } },
  ...extra,
})

test('guard reads the worse of the header sample and the official /usage sample', () => {
  const now = Date.now()
  const reset = new Date(now + 2 * HOUR).toISOString()
  const unified = {
    headers: { '5h': { utilization: 0.97, status: 'allowed_warning', reset } },
    official: { '5h': { utilization: 1, status: 'rejected', reset } },
  }
  const usage = quotaGuardUsage(unified, now)
  assert.equal(usage.ratio, 1)
  assert.equal(usage.rejected, true)
  assert.equal(quotaGuardLevel(unified, off, now).level, 'stop')
})

test('switch off: only a rejected window stops; switch on: 85% continuing, 95% stop', () => {
  const now = Date.now()
  assert.equal(quotaGuardLevel(at(0.9), off, now).level, 'open')
  assert.equal(quotaGuardLevel(at(0.84), on, now).level, 'open')
  assert.equal(quotaGuardLevel(at(0.85), on, now).level, 'continuing')
  assert.equal(quotaGuardLevel(at(0.95), on, now).level, 'stop')
  const weekly = {
    headers: { '7d': { utilization: 96, status: 'allowed', reset: new Date(now + 48 * HOUR).toISOString() } },
  }
  assert.equal(quotaGuardLevel(weekly, on, now).level, 'stop')
})

test('elapsed windows and open extra usage do not stop the account', () => {
  const now = Date.now()
  const elapsed = {
    headers: { '5h': { utilization: 1, status: 'rejected', reset: new Date(now - 1000).toISOString() } },
  }
  assert.equal(quotaGuardLevel(elapsed, on, now).level, 'open')
  const reset = new Date(now + HOUR).toISOString()
  const overage = { overage_status: 'allowed', headers: { '5h': { utilization: 1, status: 'rejected', reset } } }
  assert.equal(quotaGuardLevel(overage, off, now).level, 'open')
  assert.equal(quotaGuardLevel(overage, on, now).level, 'stop')
})

test('thresholds come from quota config and new-session never exceeds stop', () => {
  assert.deepEqual(
    quotaGuardConfigOf({ exhaustion_guard: true, exhaustion_guard_new_session: 0.9, exhaustion_guard_stop: 0.8 }),
    {
      enabled: true,
      new_session_ratio: 0.8,
      stop_ratio: 0.8,
    },
  )
})

test('a long Retry-After alone does not prove a plan window; the hop adopts provider headers', () => {
  const now = Date.now()
  const result = adoptProviderResponseHeaders({
    ok: false,
    status: 429,
    terminalState: 'incomplete',
    headers: null,
    body: {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: "This request would exceed your account's rate limit. Please try again later.",
      },
    },
    providerResult: { response_headers: { 'retry-after': '7547', 'request-id': 'req_x' } },
  })
  assert.equal(result.headers['retry-after'], '7547')
  const policy = classifyUpstreamResult(result, { now, model: 'claude-sonnet-test' })
  assert.equal(policy.reason, 'rate_limited_unknown')
})

test('every upstream 429 asks the usage probe, at most once per account per 180s', () => {
  const asked = []
  const service = new RateLimitService({
    runtimeRepo: { updateWindow() {}, updateOverload() {} },
    onUsageProbe: ({ accountId }) => asked.push(accountId),
  })
  const r429 = { ok: false, status: 429, headers: {}, body: { error: { type: 'rate_limit_error', message: 'Error' } } }
  const t0 = 1_000_000
  for (const reason of ['rate_limited_unknown', 'rpm_limited', 'sonnet_rate_limited', 'rate_limited_request']) {
    service.handleUpstreamError({
      accountId: 'a1',
      vmId: 'vm-01',
      result: r429,
      policy: { scope: 'account', reason },
      now: t0,
    })
  }
  assert.deepEqual(asked, ['a1'])
  service.handleUpstreamError({
    accountId: 'a2',
    vmId: 'vm-02',
    result: r429,
    policy: { scope: 'model', reason: 'sonnet_rate_limited' },
    now: t0,
  })
  assert.deepEqual(asked, ['a1', 'a2'])
  service.handleUpstreamError({
    accountId: 'a1',
    vmId: 'vm-01',
    result: r429,
    policy: { scope: 'account', reason: 'rate_limited_unknown' },
    now: t0 + 179_000,
  })
  assert.equal(asked.length, 2)
  service.handleUpstreamError({
    accountId: 'a1',
    vmId: 'vm-01',
    result: r429,
    policy: { scope: 'account', reason: 'rate_limited_unknown' },
    now: t0 + 180_000,
  })
  assert.deepEqual(asked, ['a1', 'a2', 'a1'])
  service.handleUpstreamError({
    accountId: 'a3',
    vmId: 'vm-03',
    result: { ok: false, status: 500 },
    policy: { scope: 'account', reason: 'x' },
    now: t0,
  })
  assert.equal(asked.includes('a3'), false)
})

test('a short Retry-After 429 stays an unproven bare 429', () => {
  const now = Date.now()
  const policy = classifyUpstreamResult(
    {
      ok: false,
      status: 429,
      headers: { 'retry-after': '20' },
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'Error' } },
    },
    { now, model: 'claude-sonnet-test' },
  )
  assert.equal(policy.reason, 'rate_limited_unknown')
})

test('the hop keeps its own headers over provider ones', () => {
  const result = adoptProviderResponseHeaders({
    ok: false,
    headers: { 'Retry-After': '5' },
    providerResult: { response_headers: { 'retry-after': '7547', 'request-id': 'req_x' } },
  })
  assert.equal(result.headers['Retry-After'], '5')
  assert.equal(result.headers['retry-after'], undefined)
  assert.equal(result.headers['request-id'], 'req_x')
})

test('a legacy percent reading below 100 next to rejected is that percentage', () => {
  const now = Date.now()
  const reset = new Date(now + HOUR).toISOString()
  const legacy = { headers: { '5h': { utilization: 26, status: 'rejected', reset } } }
  assert.equal(quotaGuardLevel(legacy, off, now).level, 'open')
  assert.equal(quotaGuardUsage(legacy, now).ratio, 0.26)
  const full = { headers: { '5h': { utilization: 100, status: 'rejected', reset } } }
  assert.equal(quotaGuardLevel(full, off, now).level, 'stop')
})

test('M3 cutover (D4): PoolScheduler no longer exposes local eligibleCandidates or reserve paths', () => {
  assert.equal(typeof PoolScheduler.prototype.eligibleCandidates, 'undefined')
  assert.equal(typeof PoolScheduler.prototype.reserve, 'undefined')
})
