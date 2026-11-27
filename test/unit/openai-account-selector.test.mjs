import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as openaiSelector from '../../src/lib/pool/openai-account-selector.mjs'
import {
  reportOpenAIAttempt,
  resetOpenAIAccountRuntime,
  openAIRuntimeSignals,
  holdOpenAIAccount,
  openAIAccountHold,
} from '../../src/lib/pool/openai-account-runtime.mjs'
import { pickCodexSlots } from '../../src/lib/pool/codex-slot-pool.mjs'

test('M3 cutover removes legacy Node OpenAI selectors and retains stateless schedulingBlocker', () => {
  assert.equal(typeof openaiSelector.schedulingBlocker, 'function')
  assert.equal(openaiSelector.selectOpenAIAccount, undefined)
  assert.equal(openaiSelector.orderOpenAIAccounts, undefined)
  assert.equal(openaiSelector.smartScore, undefined)
})

test('schedulingBlocker classifies candidate unavailability states accurately', () => {
  const now = Date.parse('2026-09-22T00:00:00.000Z')
  assert.equal(openaiSelector.schedulingBlocker(null), 'invalid_candidate')
  assert.equal(openaiSelector.schedulingBlocker({ status: 'disabled' }), 'disabled')
  assert.equal(openaiSelector.schedulingBlocker({ status: 'credential_failed' }), 'credential_failed')
  assert.equal(openaiSelector.schedulingBlocker({ status: 'missing_token' }), 'missing_token')
  assert.equal(openaiSelector.schedulingBlocker({ status: 'not_running' }), 'not_running')
  assert.equal(openaiSelector.schedulingBlocker({ status: 'unschedulable' }), 'unschedulable')
  assert.equal(openaiSelector.schedulingBlocker({ status: 'normal', activeHoursBlocked: true }), 'active_hours')
  assert.equal(openaiSelector.schedulingBlocker({ status: 'normal', modelAllowed: false }), 'model_not_allowed')
  assert.equal(
    openaiSelector.schedulingBlocker(
      {
        status: 'normal',
        vm: {
          id: 'vm-spent',
          platform: 'openai',
          family: 'codex',
          has_token: true,
          schedulable: true,
          status: 'running',
          utilization_5h: 1,
          codex_limited_until: new Date(now + 60_000).toISOString(),
        },
      },
      { now },
    ),
    'quota_exhausted',
  )
  assert.equal(
    openaiSelector.schedulingBlocker(
      {
        status: 'normal',
        vm: {
          id: 'vm-ok',
          platform: 'openai',
          family: 'codex',
          has_token: true,
          schedulable: true,
          status: 'running',
          utilization_5h: 0.2,
        },
      },
      { now },
    ),
    null,
  )
})

test('pickCodexSlots partitions ready and parked GPT slots without legacy Node selection', () => {
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
      id: 'vm-warm',
      platform: 'openai',
      family: 'codex',
      has_token: true,
      schedulable: true,
      status: 'running',
      utilization_5h: 0.4,
    },
    {
      id: 'vm-fresh',
      platform: 'openai',
      family: 'codex',
      has_token: true,
      schedulable: true,
      status: 'running',
      utilization_5h: 0.05,
    },
  ]
  const picked = pickCodexSlots(vms, { now })
  assert.deepEqual(picked.ready, ['vm-fresh', 'vm-warm'])
  assert.deepEqual(picked.parked, ['vm-spent'])
})

test('attempt feedback and holds update OpenAI runtime signals for Rust telemetry', () => {
  resetOpenAIAccountRuntime()
  const now = Date.parse('2026-09-22T00:00:00.000Z')
  reportOpenAIAttempt('vm-a', 'failed', 20_000, now)
  const signals = openAIRuntimeSignals('vm-a', now)
  assert.equal(signals.failureRateBps, 2_000)
  assert.equal(signals.firstOutputLatencyMs, 20_000)
  holdOpenAIAccount('vm-a', { until: now + 60_000, reason: 'oauth_401', now })
  assert.equal(openAIAccountHold('vm-a', now)?.reason, 'oauth_401')
  assert.equal(openAIAccountHold('vm-a', now + 60_001), null)
  resetOpenAIAccountRuntime()
})
