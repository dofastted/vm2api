/**
 * M3 parity: per-node and per-model admission gates v1.4.238's JS
 * PoolScheduler.checkEligibility applied and the Rust cutover dropped.
 * Expected values are 238's `checkEligibility` reasons.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createSchedulerRuntime } from '../../src/lib/scheduler/scheduler-runtime.mjs'
import { claudeModelWaitGate } from '../../src/lib/scheduler/node-gates.mjs'

const NOW = Date.parse('2026-11-28T08:00:00Z')
const FUTURE = NOW + 3_600_000

function slot(overrides = {}) {
  return {
    id: 'vm-a',
    kind: 'claude',
    status: 'running',
    schedulable: true,
    proxy_cli_enabled: true,
    proxy: { host: '10.0.0.7', port: 1080 },
    claude: {
      has_access: true,
      has_refresh: true,
      expires_at: FUTURE,
      account_tier: 'pro',
      account_tier_source: 'profile',
    },
    ...overrides,
  }
}

test('claudeModelWaitGate: per-model cooldown incl. Fable family key, Fable 7d_oi window, weekly split', () => {
  const famState = { model_states: { fable: { cooldown_until: NOW + 60_000, reason: 'fable_credits_required' } } }
  assert.equal(claudeModelWaitGate({ state: famState, model: 'claude-fable-5-1', now: NOW }), 'fable_cooldown')
  assert.equal(claudeModelWaitGate({ state: famState, model: 'claude-opus-4-6', now: NOW }), null)
  const rl = { model_states: { 'claude-fable-5': { cooldown_until: NOW + 60_000, reason: 'fable_rate_limited' } } }
  assert.equal(claudeModelWaitGate({ state: rl, model: 'claude-fable-5', now: NOW }), 'fable_quota')
  const mc = { model_states: { 'claude-opus-4-6': { cooldown_until: NOW + 60_000 } } }
  assert.equal(claudeModelWaitGate({ state: mc, model: 'claude-opus-4-6', now: NOW }), 'model_cooldown')
  assert.equal(claudeModelWaitGate({ state: mc, model: 'claude-opus-4-6', now: NOW + 120_000 }), null)
  const quota = { fableWindowLimited: () => true }
  assert.equal(
    claudeModelWaitGate({ accountId: 'a', model: 'claude-fable-5-2', accountQuota: quota, now: NOW }),
    'fable_quota',
  )
  assert.equal(claudeModelWaitGate({ accountId: 'a', model: 'claude-opus-4-6', accountQuota: quota, now: NOW }), null)
  const split = { weeklySplitOf: () => ({ enabled: true, fable_blocked: true, regular_blocked: false }) }
  assert.equal(
    claudeModelWaitGate({ accountId: 'a', model: 'claude-fable-5', accountQuota: split, now: NOW }),
    'fable_split',
  )
  assert.equal(claudeModelWaitGate({ accountId: 'a', model: 'claude-opus-4-6', accountQuota: split, now: NOW }), null)
})
