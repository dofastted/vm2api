import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderOpenAIAccounts, selectOpenAIAccount, smartScore } from '../../src/lib/pool/openai-account-selector.mjs'
import {
  reportOpenAIAttempt,
  resetOpenAIAccountRuntime,
  openAIRuntimeSignals,
} from '../../src/lib/pool/openai-account-runtime.mjs'
import { orderCodexSessionSlots } from '../../src/lib/pool/codex-slot-pool.mjs'

function account(id, patch = {}) {
  return {
    id,
    weight: 1,
    concurrency: 2,
    status: 'normal',
    inFlight: 0,
    lastStartedAt: null,
    quotaResetAt: null,
    quotaRemainingRank: 10_000,
    failureRateBps: 0,
    firstOutputLatencyMs: null,
    ...patch,
  }
}

test('smart keeps only the highest weight, then the best score', () => {
  const low = account('low', { weight: 1, quotaRemainingRank: 10_000 })
  const highBusy = account('high-busy', { weight: 5, quotaRemainingRank: 1_000, inFlight: 1 })
  const highFresh = account('high-fresh', { weight: 5, quotaRemainingRank: 9_000 })
  const selected = selectOpenAIAccount([low, highBusy, highFresh], {
    strategy: 'smart',
    maxConcurrent: 2,
    roundRobinCursor: 0,
  })
  assert.equal(selected.candidate.id, 'high-fresh')
  assert.equal(selected.preferred, 'not_requested')
  assert.ok(smartScore(highFresh, 2) > smartScore(highBusy, 2))
})

test('session affinity hits even when another account scores higher', () => {
  const bound = account('bound', { quotaRemainingRank: 2_000 })
  const better = account('better', { quotaRemainingRank: 10_000 })
  const selected = selectOpenAIAccount([bound, better], {
    strategy: 'smart',
    preferredAccountId: 'bound',
    preferredOverridesWeight: true,
    roundRobinCursor: 0,
  })
  assert.equal(selected.candidate.id, 'bound')
  assert.equal(selected.preferred, 'hit')
})

test('quota exhausted affinity escapes and the next normal account is used', () => {
  const ordered = orderOpenAIAccounts(
    [account('bound', { status: 'quota_exhausted' }), account('other', { quotaRemainingRank: 8_000 })],
    { strategy: 'smart', preferredAccountId: 'bound', preferredOverridesWeight: true, roundRobinCursor: 0 },
  )
  assert.deepEqual(ordered.ids, ['other'])
  assert.equal(ordered.preferred, 'blocked')
  assert.equal(ordered.blocker, 'local_availability')
})

test('scores inside 0.05 rotate by account id', () => {
  const left = account('a', { quotaRemainingRank: 8_000 })
  const right = account('b', { quotaRemainingRank: 8_100 })
  assert.ok(Math.abs(smartScore(left, 2) - smartScore(right, 2)) <= 0.05)
  const first = selectOpenAIAccount([right, left], { strategy: 'smart', roundRobinCursor: 0 })
  const second = selectOpenAIAccount([right, left], { strategy: 'smart', roundRobinCursor: 1 })
  assert.equal(first.candidate.id, 'a')
  assert.equal(second.candidate.id, 'b')
})

test('concurrency and request interval block before scoring', () => {
  const now = 1_000_000
  const busy = account('busy', { inFlight: 2, concurrency: 2, quotaRemainingRank: 10_000 })
  const cooling = account('cooling', { lastStartedAt: now - 100, quotaRemainingRank: 10_000 })
  const free = account('free', { quotaRemainingRank: 1_000 })
  const selected = selectOpenAIAccount([busy, cooling, free], {
    strategy: 'smart',
    now,
    requestIntervalMs: 500,
    roundRobinCursor: 0,
  })
  assert.equal(selected.candidate.id, 'free')
})

test('openai pool order skips a spent window and keeps a bound session', () => {
  resetOpenAIAccountRuntime()
  const now = Date.parse('2026-09-22T00:00:00.000Z')
  const vms = [
    {
      id: 'vm-spent',
      platform: 'openai',
      family: 'codex',
      has_token: true,
      schedulable: true,
      status: 'running',
      utilization_5h: 1,
      codex_limited_until: new Date(now + 60_000).toISOString(),
    },
    {
      id: 'vm-bound',
      platform: 'openai',
      family: 'codex',
      has_token: true,
      schedulable: true,
      status: 'running',
      utilization_5h: 0.4,
      policy: { weight: 1, maxConcurrency: 2 },
    },
    {
      id: 'vm-fresh',
      platform: 'openai',
      family: 'codex',
      has_token: true,
      schedulable: true,
      status: 'running',
      utilization_5h: 0.05,
      policy: { weight: 1, maxConcurrency: 2 },
    },
  ]
  const bound = orderCodexSessionSlots(vms, { boundVmId: 'vm-bound', now, roundRobinCursor: 0 })
  assert.equal(bound.sticky, true)
  assert.equal(bound.ids[0], 'vm-bound')
  assert.equal(bound.ids.includes('vm-spent'), false)
  const fresh = orderCodexSessionSlots(vms, { now, roundRobinCursor: 0 })
  assert.equal(fresh.ids[0], 'vm-fresh')
  assert.equal(fresh.sticky, false)
})

test('attempt feedback raises the failure rate used by the next decision', () => {
  resetOpenAIAccountRuntime()
  const now = Date.parse('2026-09-22T00:00:00.000Z')
  reportOpenAIAttempt('vm-a', 'failed', 20_000, now)
  const signals = openAIRuntimeSignals('vm-a', now)
  assert.equal(signals.failureRateBps, 2_000)
  assert.equal(signals.firstOutputLatencyMs, 20_000)
})
