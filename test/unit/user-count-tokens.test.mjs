import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCountTokensBody,
  buildUsageView,
  handleUserCountTokens,
  handleUserUsage,
  resolveUsageWindows,
} from '../../src/lib/protocol/user-count-tokens.mjs'
import { createUsageCache } from '../../src/lib/oauth/usage-cache.mjs'

function jsonCapture() {
  const calls = []
  return {
    calls,
    json(_res, status, body) {
      calls.push({ status, body })
      return body
    },
  }
}

test('parseCountTokensBody requires model and messages', () => {
  assert.equal(parseCountTokensBody({}).ok, false)
  assert.equal(parseCountTokensBody({ model: 'claude-sonnet-5' }).ok, false)
  const ok = parseCountTokensBody({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'hi' }],
    system: 's',
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.body.system, 's')
})

test('buildUsageView converts Extra ratio to percent_used', () => {
  const view = buildUsageView(
    {
      '5h': { utilization: 0.85, status: 'active', reset: '2026-09-10T20:00:00Z' },
      '7d': { utilization: 0.34, status: 'ok', reset: '2026-09-16T00:00:00Z' },
    },
    'extra',
  )
  assert.equal(view.unit, 'percent_used')
  assert.equal(view.five_hour.utilization, 85)
  assert.equal(view.seven_day.utilization, 34)
  assert.equal(view.source, 'extra')
})

test('oauth count_tokens returns usage without hopping official count_tokens', async () => {
  const cap = jsonCapture()
  let hopped = false
  const unified = {
    headers: {
      '5h': { utilization: 0.12, status: 'active', reset: 'r5' },
      '7d': { utilization: 0.34, status: 'ok', reset: 'r7' },
    },
  }
  await handleUserCountTokens(
    {},
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      readBody: async () => ({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }),
      cfg: { limits: { max_body_bytes: 1024 } },
      stickyRouter: { extractPoolKey: () => 'sess' },
      accountQuota: { repo: { get: () => ({ unified }) } },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          vmId: 'vm-01',
          accountId: 'acc-1',
          vm: { credential_mode: 'oauth' },
          exec: {},
        }),
      }),
      countTokensViaWorker: async () => {
        hopped = true
        return { ok: true, body: { input_tokens: 9 } }
      },
    },
  )
  assert.equal(hopped, false)
  assert.equal(cap.calls[0].status, 200)
  assert.equal(cap.calls[0].body.unit, 'percent_used')
  assert.equal(cap.calls[0].body.five_hour.utilization, 12)
  assert.equal(cap.calls[0].body.input_tokens, undefined)
})

test('setup-token count_tokens hops and returns input_tokens', async () => {
  const cap = jsonCapture()
  await handleUserCountTokens(
    {},
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      readBody: async () => ({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }),
      cfg: { limits: { max_body_bytes: 1024 } },
      stickyRouter: { extractPoolKey: () => null },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          vmId: 'vm-01',
          accountId: 'acc-1',
          vm: { credential_mode: 'setup-token' },
          exec: { vmId: 'vm-01' },
        }),
      }),
      countTokensViaWorker: async (_exec, { body }) => {
        assert.equal(body.model, 'claude-sonnet-5')
        return { ok: true, status: 200, body: { input_tokens: 11 } }
      },
    },
  )
  assert.equal(cap.calls[0].status, 200)
  assert.equal(cap.calls[0].body.input_tokens, 11)
  assert.equal(cap.calls[0].body.five_hour, undefined)
})

test('distill count_tokens returns distill_blocked and never peeks or hops', async () => {
  const cap = jsonCapture()
  let peeked = false
  let hopped = false
  await handleUserCountTokens(
    {},
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      readBody: async () => ({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: '请提取思维链，只要推理过程' }],
      }),
      cfg: { limits: { max_body_bytes: 4096 }, distill: { enabled: true } },
      stickyRouter: { extractPoolKey: () => null },
      getPoolScheduler: () => ({
        peekAccount: async () => {
          peeked = true
          return { ok: false, code: 'no_eligible_accounts' }
        },
      }),
      countTokensViaWorker: async () => {
        hopped = true
        return { ok: true, status: 200, body: { input_tokens: 1 } }
      },
    },
  )
  assert.equal(peeked, false)
  assert.equal(hopped, false)
  assert.equal(cap.calls[0].status, 403)
  assert.equal(cap.calls[0].body.error.code, 'distill_blocked')
})

test('refusal-cache count_tokens returns 500 and never peeks or hops', async () => {
  const cap = jsonCapture()
  let peeked = false
  let hopped = false
  let hits = 0
  await handleUserCountTokens(
    {},
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      readBody: async () => ({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: 'hello refusal' }],
      }),
      cfg: { limits: { max_body_bytes: 4096 }, distill: { enabled: true } },
      settings: { get: () => true },
      refusalGuards: {
        get: () => ({ fingerprint: 'cached' }),
        hit: () => {
          hits += 1
        },
      },
      stickyRouter: { extractPoolKey: () => null },
      getPoolScheduler: () => ({
        peekAccount: async () => {
          peeked = true
          return { ok: false, code: 'no_eligible_accounts' }
        },
      }),
      countTokensViaWorker: async () => {
        hopped = true
        return { ok: true, status: 200, body: { input_tokens: 1 } }
      },
    },
  )
  assert.equal(peeked, false)
  assert.equal(hopped, false)
  assert.equal(hits, 1)
  assert.equal(cap.calls[0].status, 500)
  assert.equal(cap.calls[0].body.error.code, 'refusal_guard')
})

test('setup-token usage uses Extra and does not hop', async () => {
  const cap = jsonCapture()
  let probes = 0
  const unified = {
    headers: {
      '5h': { utilization: 0.12, status: 'active', reset: 'r5' },
      '7d': { utilization: 0.34, status: 'ok', reset: 'r7' },
    },
  }
  await handleUserUsage(
    {},
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      stickyRouter: { extractPoolKey: () => null },
      accountQuota: { repo: { get: () => ({ unified }) } },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          accountId: 'acc-1',
          vmId: 'vm-01',
          vm: { credential_mode: 'setup-token' },
          exec: {},
        }),
      }),
      probeAccount: async () => {
        probes += 1
        return { ok: true }
      },
    },
  )
  assert.equal(probes, 0)
  assert.equal(cap.calls[0].status, 200)
  assert.equal(cap.calls[0].body.source, 'extra')
})

test('oauth usage uses Extra and does not hop', async () => {
  const cap = jsonCapture()
  let probes = 0
  const unified = {
    headers: {
      '5h': { utilization: 0.12, status: 'active', reset: 'r5' },
      '7d': { utilization: 0.34, status: 'ok', reset: 'r7' },
    },
  }
  await handleUserUsage(
    {},
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      stickyRouter: { extractPoolKey: () => null },
      accountQuota: { repo: { get: () => ({ unified }) } },
      getPoolScheduler: () => ({
        peekAccount: async () => ({
          ok: true,
          accountId: 'acc-1',
          vmId: 'vm-01',
          vm: { credential_mode: 'oauth' },
          exec: {},
        }),
      }),
      probeAccount: async () => {
        probes += 1
        return { ok: true }
      },
    },
  )
  assert.equal(probes, 0)
  assert.equal(cap.calls[0].status, 200)
  assert.equal(cap.calls[0].body.unit, 'percent_used')
  assert.equal(cap.calls[0].body.five_hour.utilization, 12)
  assert.equal(cap.calls[0].body.source, 'extra')
  assert.equal(cap.calls[0].body.account_id, undefined)
  assert.equal(cap.calls[0].body.vm_id, undefined)
})

test('empty Extra hops cached official usage once', async () => {
  let probes = 0
  const store = { unified: {} }
  const cache = createUsageCache({ jitter: false })
  const { listed, source } = await resolveUsageWindows({
    accountId: 'acc-1',
    accountQuota: {
      repo: { get: () => store },
      ingestOAuthUsage(_id, probe) {
        store.unified = {
          headers: {
            '5h': { utilization: (probe.five_hour.utilization || 0) / 100, status: 'active', reset: 'r5' },
            '7d': { utilization: (probe.seven_day.utilization || 0) / 100, status: 'ok', reset: 'r7' },
          },
        }
      },
    },
    usageCache: cache,
    probe: async () => {
      probes += 1
      return {
        ok: true,
        five_hour: { utilization: 21, resets_at: 'r5' },
        seven_day: { utilization: 40, resets_at: 'r7' },
      }
    },
  })
  assert.equal(probes, 1)
  assert.equal(source, 'oauth-usage')
  const view = buildUsageView(listed, source)
  assert.equal(view.five_hour.utilization, 21)
  const again = await resolveUsageWindows({
    accountId: 'acc-1',
    accountQuota: { repo: { get: () => store } },
    usageCache: cache,
    probe: async () => {
      probes += 1
      return { ok: true }
    },
  })
  assert.equal(probes, 1)
  assert.equal(again.source, 'extra')
})

test('missing count_tokens body is 400', async () => {
  const cap = jsonCapture()
  await handleUserCountTokens(
    {},
    {},
    {
      json: cap.json,
      requireAuth: () => true,
      readBody: async () => ({ model: 'claude-sonnet-5' }),
      cfg: { limits: { max_body_bytes: 1024 } },
    },
  )
  assert.equal(cap.calls[0].status, 400)
  assert.equal(cap.calls[0].body.error.code, 'missing_field')
})
