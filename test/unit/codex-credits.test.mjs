import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { admitCodexCandidate, handleCodexProtocol } from '../../src/lib/protocol/handle-codex.mjs'
import { getVm, listVms } from '../../src/lib/vm/vm-registry.mjs'
import { persistCodexQuotaSnapshot } from '../../src/lib/vm/codex-slot.mjs'
import {
  queryOpenaiQuota,
  resetStaleCodexCreditsRefreshState,
  CHATGPT_USAGE_URL,
  CHATGPT_RESET_CREDITS_URL,
  CHATGPT_RESET_CONSUME_URL,
} from '../../src/lib/oauth/openai-quota.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { SessionLimitRegistry } from '../../src/lib/pool/session-limit.mjs'
import {
  CODEX_CREDITS_TTL_MS,
  codexCreditsFromHeaders,
  hasSpendableCodexCredits,
  normalizeCodexCredits,
} from '../../src/lib/protocol/codex-usage.mjs'
import {
  codexAccountStatus,
  codexQuotaWindowReason,
  evaluateCodexQuotaSchedule,
  isCodexSlotParked,
  pickCodexSlots,
} from '../../src/lib/pool/codex-slot-pool.mjs'
import { evaluateOpenAIQuotaGate } from '../../src/lib/pool/openai-quota-policy.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

beforeEach(() => {
  resetOpenAIAccountRuntime()
  resetStaleCodexCreditsRefreshState()
})

const NOW = Date.parse('2026-10-17T12:00:00Z')
const WEEK_RESET = new Date(NOW + 3 * 86_400_000).toISOString()

// 7d window spent, 5h window healthy: only credits can keep this slot serving.
const WEEK_SPENT = {
  codex_primary_used_percent: 100,
  codex_primary_window_minutes: 10080,
  codex_primary_reset_at: WEEK_RESET,
  codex_secondary_used_percent: 20,
  codex_secondary_window_minutes: 300,
  codex_secondary_reset_at: new Date(NOW + 3_600_000).toISOString(),
}

function credits(patch = {}, fetchedAt = NOW) {
  return {
    has_credits: true,
    unlimited: false,
    balance: '12.5',
    fetched_at: new Date(fetchedAt).toISOString(),
    ...patch,
  }
}

function slot(codex = {}) {
  return { id: 'vm-a', platform: 'openai', family: 'codex', status: 'running', has_token: true, codex }
}

function fixture(t, codex = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-credits-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms', 'vm-a'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-a.json'),
    JSON.stringify({
      id: 'vm-a',
      platform: 'openai',
      family: 'codex',
      status: 'running',
      schedulable: true,
      proxy: { url: 'socks5h://127.0.0.1:1080' },
      codex: { has_access: true, has_refresh: true, chatgpt_account_id: 'acc-1', ...codex },
    }),
  )
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-a', 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ id: 'codex', access_token: 'at', refresh_token: 'rt', chatgpt_account_id: 'acc-1' }],
    }),
  )
  return root
}

async function hop(root, { status = 200, headers = {}, code = 'usage_limit_reached' } = {}) {
  await handleCodexProtocol({
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
      streamCodexKernel: async () => ({
        ok: status === 200,
        status,
        committed: false,
        headers,
        body: status === 200 ? { id: 'fixture-response' } : { error: { code, type: 'api_error' } },
      }),
    },
  })
}

function usageFetch(payload) {
  return async (url) => {
    if (String(url).startsWith(CHATGPT_USAGE_URL)) return { status: 200, json: async () => payload }
    if (String(url).startsWith(CHATGPT_RESET_CREDITS_URL)) return { status: 200, json: async () => [] }
    throw new Error(`unexpected ${url}`)
  }
}

const WEEK_SPENT_RATE_LIMIT = {
  primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_after_seconds: 3 * 86_400 },
  secondary_window: { used_percent: 20, limit_window_seconds: 18000, reset_after_seconds: 3600 },
}

const WEEK_SPENT_HEADERS = {
  'x-codex-primary-used-percent': '100',
  'x-codex-primary-window-minutes': '10080',
  'x-codex-primary-reset-after-seconds': String(3 * 86_400),
  'x-codex-secondary-used-percent': '20',
  'x-codex-secondary-window-minutes': '300',
  'x-codex-secondary-reset-after-seconds': '3600',
}

test('credits normalize like the Codex CLI and keep the balance as a string', () => {
  const long = '123456789012345678901234.000000000000000000000001'
  assert.deepEqual(normalizeCodexCredits({ has_credits: true, unlimited: false, balance: long }, NOW), {
    has_credits: true,
    unlimited: false,
    balance: long,
    fetched_at: new Date(NOW).toISOString(),
  })
  assert.equal(normalizeCodexCredits({ has_credits: true, unlimited: false, balance: '  ' }, NOW).balance, null)
  assert.equal(normalizeCodexCredits({ has_credits: true }, NOW), null, 'both flags are required')
  assert.equal(normalizeCodexCredits({ has_credits: 'maybe', unlimited: false }, NOW), null)
  assert.equal(normalizeCodexCredits(null, NOW), null)

  const fromHeaders = codexCreditsFromHeaders(
    { 'X-Codex-Credits-Has-Credits': '1', 'x-codex-credits-unlimited': 'FALSE', 'x-codex-credits-balance': ' 7.25 ' },
    NOW,
  )
  assert.deepEqual(fromHeaders, credits({ balance: '7.25' }))
  assert.equal(codexCreditsFromHeaders({ 'x-codex-credits-has-credits': 'true' }, NOW), null)
})

test('spendable means fresh and either has_credits or unlimited; a hidden balance still counts', () => {
  assert.equal(hasSpendableCodexCredits(slot({ credits: credits({ balance: null }) }), NOW), true)
  assert.equal(hasSpendableCodexCredits(slot({ credits: credits({ has_credits: false, unlimited: true }) }), NOW), true)
  assert.equal(hasSpendableCodexCredits(slot({ credits: credits({ has_credits: false, balance: '0' }) }), NOW), false)
  assert.equal(hasSpendableCodexCredits({ codex_credits: credits() }, NOW), true, 'summary projection')
  assert.equal(hasSpendableCodexCredits(slot({ credits: credits({}, NOW - CODEX_CREDITS_TTL_MS) }), NOW), true)
  assert.equal(hasSpendableCodexCredits(slot({ credits: credits({}, NOW - CODEX_CREDITS_TTL_MS - 1) }), NOW), false)
  assert.equal(hasSpendableCodexCredits(slot({ credits: credits({ fetched_at: 'garbage' }) }), NOW), false)
  assert.equal(hasSpendableCodexCredits(slot(), NOW), false)
})

test('a spent window with fresh credits passes every local quota gate', () => {
  const vm = slot({ extra: WEEK_SPENT, credits: credits() })
  for (const policy of [null, { limit_5h: 1, limit_7d: 1 }, { limit_5h: 0.9, limit_7d: 0.9 }]) {
    assert.equal(isCodexSlotParked(vm, NOW, policy), false)
    assert.equal(evaluateOpenAIQuotaGate(vm, policy || undefined, NOW).limited, false)
    assert.equal(codexAccountStatus(vm, NOW, policy), 'normal')
    assert.equal(evaluateCodexQuotaSchedule(vm, NOW, policy).reason, null)
  }
  assert.equal(codexQuotaWindowReason(vm, NOW), null)
  assert.deepEqual(pickCodexSlots([vm], { now: NOW }).ready, ['vm-a'])
})

test('credits never reopen an operator-disabled or credential-less slot', () => {
  const vm = slot({ extra: WEEK_SPENT, credits: credits() })
  assert.equal(codexAccountStatus({ ...vm, schedulable: false, schedule_manual: true }, NOW), 'disabled')
  assert.equal(codexAccountStatus({ ...vm, status: 'disabled' }, NOW), 'disabled')
  assert.equal(codexAccountStatus({ ...vm, has_token: false }, NOW), 'error')
  assert.equal(pickCodexSlots([{ ...vm, has_token: false }], { now: NOW }).error, 'no_codex_vm')
})

test('a fresh reading clears a restriction that the spent window wrote earlier', () => {
  const restricted = { temp_unschedulable_reason: 'quota_7d_header', temp_unschedulable_until: Date.parse(WEEK_RESET) }
  assert.equal(evaluateCodexQuotaSchedule({ ...slot({ extra: WEEK_SPENT }), ...restricted }, NOW).action, 'restrict')
  assert.equal(
    evaluateCodexQuotaSchedule({ ...slot({ extra: WEEK_SPENT, credits: credits() }), ...restricted }, NOW).action,
    'clear',
  )
})

test('no credits, stale credits, or an explicit park keep the existing parking', () => {
  const cases = {
    missing: slot({ extra: WEEK_SPENT }),
    exhausted: slot({ extra: WEEK_SPENT, credits: credits({ has_credits: false, unlimited: false, balance: '0' }) }),
    stale: slot({ extra: WEEK_SPENT, credits: credits({}, NOW - CODEX_CREDITS_TTL_MS - 1) }),
  }
  for (const [name, vm] of Object.entries(cases)) {
    assert.equal(isCodexSlotParked(vm, NOW), true, name)
    assert.equal(evaluateOpenAIQuotaGate(vm, undefined, NOW).reason, 'quota_7d_local', name)
    assert.equal(codexQuotaWindowReason(vm, NOW), 'quota_7d_header', name)
    assert.equal(codexAccountStatus(vm, NOW), 'quota_exhausted', name)
    assert.deepEqual(pickCodexSlots([vm], { now: NOW }).parked, ['vm-a'], name)
  }

  const parkedUntil = new Date(NOW + 60_000).toISOString()
  const refused = slot({ extra: { ...WEEK_SPENT, codex_limited_until: parkedUntil }, credits: credits() })
  assert.equal(isCodexSlotParked(refused, NOW), true, 'an explicit park outranks credits')
  assert.equal(codexQuotaWindowReason(refused, NOW), 'quota_5h_header')
  assert.equal(evaluateCodexQuotaSchedule(refused, NOW).until, Date.parse(parkedUntil))
})

test('/wham/usage credits are persisted next to, not inside, reset credits and reach the pool summary', async (t) => {
  const root = fixture(t, { extra: WEEK_SPENT })
  const long = '987654321987654321.123456789123456789'
  const result = await queryOpenaiQuota({
    projectRoot: root,
    vmId: 'vm-a',
    fetchImpl: usageFetch({
      rate_limit: WEEK_SPENT_RATE_LIMIT,
      rate_limit_reset_credits: { available_count: 0 },
      credits: { has_credits: true, unlimited: false, balance: long },
    }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.credits.balance, long)
  assert.equal(result.reset_credits.available_count, 0)

  const vm = getVm(root, 'vm-a')
  assert.equal(vm.codex.credits.balance, long)
  assert.equal(vm.codex.credits.has_credits, true)
  assert.deepEqual(vm.codex.reset_credits.credits, [])

  const summary = listVms(root).find((item) => item.id === 'vm-a')
  assert.equal(summary.codex_credits.balance, long)
  assert.equal(summary.utilization_7d, 1)
  assert.deepEqual(pickCodexSlots([summary]).ready, ['vm-a'])
})

test('/wham/usage without credits leaves the reset-credit path unchanged', async (t) => {
  const root = fixture(t)
  const result = await queryOpenaiQuota({
    projectRoot: root,
    vmId: 'vm-a',
    fetchImpl: usageFetch({ rate_limit: WEEK_SPENT_RATE_LIMIT, rate_limit_reset_credits: { available_count: 0 } }),
  })
  assert.equal(result.credits, null)
  assert.equal(getVm(root, 'vm-a').codex.credits, undefined)
  const summary = listVms(root).find((item) => item.id === 'vm-a')
  assert.equal(summary.codex_credits, null)
  assert.deepEqual(pickCodexSlots([summary]).parked, ['vm-a'])
})

test('a spendable refresh supersedes an older park; an empty balance does not', (t) => {
  const parkedUntil = new Date(Date.now() + 86_400_000).toISOString()
  const root = fixture(t, { extra: { ...WEEK_SPENT, codex_limited_until: parkedUntil } })
  persistCodexQuotaSnapshot(root, 'vm-a', { credits: normalizeCodexCredits({ has_credits: false, unlimited: false }) })
  assert.equal(getVm(root, 'vm-a').codex.extra.codex_limited_until, parkedUntil)
  persistCodexQuotaSnapshot(root, 'vm-a', { credits: normalizeCodexCredits({ has_credits: true, unlimited: false }) })
  assert.equal(getVm(root, 'vm-a').codex.extra.codex_limited_until, undefined)
})

test('a successful reply past the weekly cap keeps the slot schedulable while credits last', async (t) => {
  const root = fixture(t)
  await hop(root, {
    headers: {
      ...WEEK_SPENT_HEADERS,
      'x-codex-credits-has-credits': 'true',
      'x-codex-credits-unlimited': 'false',
      'x-codex-credits-balance': '3.14',
    },
  })
  const vm = getVm(root, 'vm-a')
  assert.equal(vm.codex.credits.balance, '3.14')
  assert.equal(vm.codex.usage.quota.utilization_7d, 1)
  assert.equal(vm.codex.extra.codex_limited_until, undefined, 'no park derived from a waived window')
  assert.equal(vm.temp_unschedulable_reason, undefined)
  const summary = listVms(root).find((item) => item.id === 'vm-a')
  assert.deepEqual(pickCodexSlots([summary]).ready, ['vm-a'])
})

test('without credit headers a successful reply past the cap still parks as before', async (t) => {
  const root = fixture(t)
  await hop(root, { headers: WEEK_SPENT_HEADERS })
  const vm = getVm(root, 'vm-a')
  assert.ok(Date.parse(vm.codex.extra.codex_limited_until) > Date.now())
  assert.equal(vm.temp_unschedulable_reason, 'quota_7d_header')
})

test('an upstream 429 drops the credits reading and parks the slot', async (t) => {
  const root = fixture(t, { extra: WEEK_SPENT, credits: credits({}, Date.now()) })
  assert.deepEqual(pickCodexSlots(listVms(root)).ready, ['vm-a'])
  await hop(root, {
    status: 429,
    headers: {
      ...WEEK_SPENT_HEADERS,
      'x-codex-credits-has-credits': 'true',
      'x-codex-credits-unlimited': 'false',
    },
  })
  const vm = getVm(root, 'vm-a')
  assert.equal(vm.codex.credits, undefined)
  assert.ok(Date.parse(vm.codex.extra.codex_limited_until) > Date.now() + 86_400_000)
  assert.equal(vm.temp_unschedulable_reason, 'quota_7d_header')
  assert.deepEqual(pickCodexSlots(listVms(root)).parked, ['vm-a'])
})

test('credit-only reply headers refresh the reading', async (t) => {
  // A quota-exhausted slot gets no traffic; only a slot still in rotation can refresh from replies.
  const root = fixture(t)
  await hop(root, { headers: { 'x-codex-credits-has-credits': 'false', 'x-codex-credits-unlimited': 'true' } })
  const summary = listVms(root).find((item) => item.id === 'vm-a')
  assert.equal(summary.codex_credits.unlimited, true)
  assert.equal(summary.codex_credits.has_credits, false)
})

function writePoolVm(root, id, codex = {}) {
  fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      platform: 'openai',
      family: 'codex',
      status: 'running',
      schedulable: true,
      proxy: { url: 'socks5h://127.0.0.1:1080' },
      codex: { has_access: true, has_refresh: true, chatgpt_account_id: `${id}-acc`, ...codex },
    }),
  )
  fs.writeFileSync(
    path.join(root, 'vms', id, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ id: 'codex', access_token: `at-${id}`, refresh_token: `rt-${id}`, chatgpt_account_id: `${id}-acc` }],
    }),
  )
}

test('single-slot 5h=100% with >10m stale positive credits refreshes on admission and forwards without consuming reset vouchers', async (t) => {
  const liveNow = Date.now()
  const fiveReset = new Date(liveNow + 2 * 3_600_000).toISOString()
  const staleCredits = credits({ balance: '62408.90' }, liveNow - CODEX_CREDITS_TTL_MS - 5 * 60_000)
  const root = fixture(t, {
    extra: {
      codex_primary_used_percent: 100,
      codex_primary_window_minutes: 300,
      codex_primary_reset_at: fiveReset,
      codex_secondary_used_percent: 16,
      codex_secondary_window_minutes: 10080,
      codex_limited_until: fiveReset,
    },
    credits: staleCredits,
  })

  const quotaUrls = []
  let kernelCalls = 0
  const res = { statusCode: 0, body: null, headersSent: false, write() {}, end() {} }
  await handleCodexProtocol({
    req: { headers: {}, apiKeyKind: 'user' },
    res,
    protocol: 'openai.responses',
    ctx: { body: { model: 'gpt-5.4', input: 'continue with credits', stream: false } },
    inbound: { stream: false },
    logBag: {},
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_r, status, body) => {
      res.statusCode = status
      res.body = body
      return body
    },
    writeSSEHeaders() {},
    routing: {},
    projectRoot: root,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      quotaFetchImpl: async (url) => {
        quotaUrls.push(String(url))
        if (String(url) === CHATGPT_RESET_CONSUME_URL) {
          assert.fail('must never consume reset vouchers during stale credits refresh')
        }
        if (String(url).startsWith(CHATGPT_USAGE_URL)) {
          return {
            status: 200,
            json: async () => ({
              rate_limit: {
                primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_after_seconds: 7200 },
                secondary_window: { used_percent: 16, limit_window_seconds: 604800, reset_after_seconds: 86400 },
              },
              rate_limit_reset_credits: { available_count: 1 },
              credits: { has_credits: true, unlimited: false, balance: '62408.90' },
            }),
          }
        }
        if (String(url).startsWith(CHATGPT_RESET_CREDITS_URL)) return { status: 200, json: async () => [] }
        throw new Error(`unexpected ${url}`)
      },
      streamCodexKernel: async () => {
        kernelCalls += 1
        return {
          ok: true,
          status: 200,
          committed: false,
          headers: {},
          body: { id: 'resp_recovered' },
        }
      },
    },
  })

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.id, 'resp_recovered')
  assert.equal(kernelCalls, 1)
  assert.ok(quotaUrls.some((u) => u.startsWith(CHATGPT_USAGE_URL)))
  assert.equal(quotaUrls.includes(CHATGPT_RESET_CONSUME_URL), false)

  const vmAfter = getVm(root, 'vm-a')
  assert.equal(vmAfter.codex.credits.balance, '62408.90')
  assert.equal(hasSpendableCodexCredits(vmAfter), true)
  assert.equal(vmAfter.codex.extra.codex_limited_until, undefined)
  assert.equal(vmAfter.temp_unschedulable_reason, undefined)
})

test('sticky-bound slot with 5h=100% and >10m stale credits refreshes before unbinding and preserves response continuation', async (t) => {
  const liveNow = Date.now()
  const fiveReset = new Date(liveNow + 2 * 3_600_000).toISOString()
  const root = fixture(t, {
    extra: {
      codex_primary_used_percent: 100,
      codex_primary_window_minutes: 300,
      codex_primary_reset_at: fiveReset,
      codex_secondary_used_percent: 16,
      codex_secondary_window_minutes: 10080,
      codex_limited_until: fiveReset,
    },
    credits: credits({ balance: '62408.90' }, liveNow - CODEX_CREDITS_TTL_MS - 60_000),
  })
  // Add a second healthy slot: sticky session on vm-a must still stay on vm-a instead of dropping as gone!
  writePoolVm(root, 'vm-b', {
    extra: {
      codex_primary_used_percent: 10,
      codex_primary_window_minutes: 300,
      codex_secondary_used_percent: 5,
      codex_secondary_window_minutes: 10080,
    },
  })

  const stickyRouter = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
  const sessions = new SessionLimitRegistry()
  const req = { headers: { 'x-session-id': 'conv-sticky-1' }, apiKeyKind: 'user' }
  const body = { model: 'gpt-5.4', previous_response_id: 'resp_prev_1', input: 'follow up', stream: false }
  const sessionKey = stickyRouter.extractPoolKey(req, body, { platform: 'openai' })
  stickyRouter.bind(sessionKey, { accountId: 'vm-a', vmId: 'vm-a', sessionId: 'sess-a' })
  sessions.touch('vm-a', sessionKey)

  const admitted = await admitCodexCandidate(
    root,
    req,
    { stickyRouter, sessions, body, excluded: new Set(), routing: {} },
    {
      deadline: liveNow + 5_000,
      signal: new AbortController().signal,
      fetchImpl: usageFetch({
        rate_limit: {
          primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_after_seconds: 7200 },
          secondary_window: { used_percent: 16, limit_window_seconds: 604800, reset_after_seconds: 86400 },
        },
        rate_limit_reset_credits: { available_count: 0 },
        credits: { has_credits: true, unlimited: false, balance: '62400.00' },
      }),
    },
  )

  assert.ok(admitted.lease)
  admitted.lease.release()
  assert.equal(admitted.vmId, 'vm-a')
  assert.equal(admitted.picked.boundState, 'live')
  assert.equal(admitted.picked.sticky, true)
  assert.equal(stickyRouter.resolve(sessionKey)?.vmId, 'vm-a')
})

test('multi-slot pool serves immediately on healthy slot while background-refreshing idle stale-credit slot', async (t) => {
  const liveNow = Date.now()
  const fiveReset = new Date(liveNow + 2 * 3_600_000).toISOString()
  const root = fixture(t, {
    extra: {
      codex_primary_used_percent: 100,
      codex_primary_window_minutes: 300,
      codex_primary_reset_at: fiveReset,
      codex_secondary_used_percent: 16,
      codex_secondary_window_minutes: 10080,
      codex_limited_until: fiveReset,
    },
    credits: credits({ balance: '62408.90' }, liveNow - CODEX_CREDITS_TTL_MS - 120_000),
  })
  writePoolVm(root, 'vm-healthy', {
    extra: {
      codex_primary_used_percent: 12,
      codex_primary_window_minutes: 300,
      codex_secondary_used_percent: 8,
      codex_secondary_window_minutes: 10080,
    },
  })

  let bgStarted = false
  let finishBgRefresh
  const bgDone = new Promise((resolve) => {
    finishBgRefresh = resolve
  })

  let routedVmId = null
  const res = { statusCode: 0, body: null, headersSent: false, write() {}, end() {} }
  await handleCodexProtocol({
    req: { headers: {}, apiKeyKind: 'user' },
    res,
    protocol: 'openai.responses',
    ctx: { body: { model: 'gpt-5.4', input: 'fast path', stream: false } },
    inbound: { stream: false },
    logBag: {},
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_r, status, body) => {
      res.statusCode = status
      res.body = body
      return body
    },
    writeSSEHeaders() {},
    routing: {},
    projectRoot: root,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      quotaFetchImpl: async (url) => {
        if (String(url).startsWith(CHATGPT_USAGE_URL)) {
          bgStarted = true
          await bgDone
          return {
            status: 200,
            json: async () => ({
              rate_limit: {
                primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_after_seconds: 7200 },
                secondary_window: { used_percent: 16, limit_window_seconds: 604800, reset_after_seconds: 86400 },
              },
              rate_limit_reset_credits: { available_count: 0 },
              credits: { has_credits: true, unlimited: false, balance: '62408.90' },
            }),
          }
        }
        return { status: 200, json: async () => [] }
      },
      streamCodexKernel: async ({ exec }) => {
        routedVmId = exec.vmId
        return {
          ok: true,
          status: 200,
          committed: false,
          headers: {},
          body: { id: 'resp_fast' },
        }
      },
    },
  })

  // Foreground request completed immediately on vm-healthy BEFORE bgDone resolved!
  assert.equal(res.statusCode, 200)
  assert.equal(routedVmId, 'vm-healthy')
  assert.equal(bgStarted, true)

  finishBgRefresh()
  for (let i = 0; i < 20 && !hasSpendableCodexCredits(getVm(root, 'vm-a')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(hasSpendableCodexCredits(getVm(root, 'vm-a')), true)
  assert.deepEqual(pickCodexSlots(listVms(root)).ready.sort(), ['vm-a', 'vm-healthy'])
})

test('single-slot stale credits returns 503 quota_exhausted and throttles repeated requests when upstream refresh fails', async (t) => {
  const liveNow = Date.now()
  const fiveReset = new Date(liveNow + 2 * 3_600_000).toISOString()
  const root = fixture(t, {
    extra: {
      codex_primary_used_percent: 100,
      codex_primary_window_minutes: 300,
      codex_primary_reset_at: fiveReset,
      codex_limited_until: fiveReset,
    },
    credits: credits({ balance: '100.00' }, liveNow - CODEX_CREDITS_TTL_MS - 60_000),
  })

  let refreshCount = 0
  const runOnce = async () => {
    const res = { statusCode: 0, body: null, headersSent: false, write() {}, end() {} }
    await handleCodexProtocol({
      req: { headers: {}, apiKeyKind: 'user' },
      res,
      protocol: 'openai.responses',
      ctx: { body: { model: 'gpt-5.4', input: 'blocked', stream: false } },
      inbound: { stream: false },
      logBag: {},
      stats: { errors: 0, requests: 0, by_route: {} },
      json: (_r, status, body) => {
        res.statusCode = status
        res.body = body
        return body
      },
      writeSSEHeaders() {},
      routing: {},
      projectRoot: root,
      ops: {
        writeCodexKernelConfig() {},
        ensureCodexKernel: async () => ({ ok: true }),
        quotaFetchImpl: async (url) => {
          if (String(url).startsWith(CHATGPT_USAGE_URL)) {
            refreshCount += 1
            return { status: 200, json: async () => ({ rate_limit: WEEK_SPENT_RATE_LIMIT, credits: null }) }
          }
          return { status: 200, json: async () => [] }
        },
        streamCodexKernel: async () => assert.fail('must not forward when quota remains exhausted'),
      },
    })
    return res
  }

  const first = await runOnce()
  const second = await runOnce()
  assert.equal(first.statusCode, 503)
  assert.equal(first.body.error.code, 'quota_exhausted')
  assert.equal(second.statusCode, 503)
  assert.equal(second.body.error.code, 'quota_exhausted')
  assert.equal(refreshCount, 1, 'second request within cooldown does not re-query /wham/usage')
})
