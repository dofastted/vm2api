import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadDistillRules } from '../../src/lib/core/distill-detect.mjs'
import { refusalGuardPolicy } from '../../src/lib/core/refusal-guard.mjs'
import { readJevConfig } from '../../src/lib/protocol/jev-intercept.mjs'
import { applyUsageProfile, riskPatchForProfile, routingPatchForProfile } from '../../src/lib/admin/usage-profile.mjs'
import { setOnboardingProfile, recordOf, applyOnboardingAction } from '../../src/lib/admin/onboarding.mjs'

function memorySettings(seed = {}) {
  const bag = { ...seed }
  return {
    bag,
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : fallback
    },
    set(key, value) {
      bag[key] = value
      return value
    },
  }
}

test('personal opens VM limits and drops every risk gate', () => {
  const routing = routingPatchForProfile('personal')
  assert.equal(routing.quota.block_on_5h, false)
  assert.equal(routing.quota.block_on_7d, false)
  for (const tier of ['default', 'pro', 'max']) {
    assert.equal(routing.tiers[tier].limit_5h, 1)
    assert.equal(routing.tiers[tier].limit_7d, 1)
    assert.equal(routing.tiers[tier].max_concurrency, 256)
    assert.equal(routing.tiers[tier].max_rpm, 0)
  }
  assert.equal(routing.concurrency.default_max_per_account, 256)
  assert.equal(routing.concurrency.fable_max_per_account, 256)
  assert.equal(routing.codex.quota.max_concurrency, 256)
  assert.equal(routing.codex.quota.limit_5h, 1)
  assert.equal(routing.codex.quota.max_sessions, 0)
  assert.equal(routing.compatibility, undefined)
  assert.equal(routing.health_probe, undefined)
  assert.equal(routing.usage_probe, undefined)

  const risk = riskPatchForProfile('personal')
  assert.equal(risk.distill.enabled, false)
  assert.equal(risk.jev.enabled, false)
  assert.equal(risk.jev.hard_regex_enabled, false)
  assert.equal(risk.jev.safety_threshold, 0)
  assert.equal(risk.refusal.enabled, false)
  assert.equal(risk.refusal.similarity_enabled, false)
  assert.equal(risk.refusal.device_block_enabled, false)
})

test('relay restores the shipped quota and risk defaults only', () => {
  const routing = routingPatchForProfile('relay')
  assert.equal(routing.quota.block_on_5h, true)
  assert.equal(routing.quota.block_on_7d, true)
  assert.equal(routing.tiers.default.limit_5h, 0.85)
  assert.equal(routing.tiers.default.limit_7d, 0.8)
  assert.equal(routing.tiers.default.max_concurrency, 2)
  assert.equal(routing.tiers.max.limit_5h, 0.95)
  assert.equal(routing.tiers.max.max_concurrency, 4)
  assert.equal(routing.concurrency.default_max_per_account, 2)
  assert.equal(routing.concurrency.fable_max_per_account, 4)
  assert.equal(routing.codex.quota.max_concurrency, 2)
  assert.equal(routing.health_probe, undefined)

  const risk = riskPatchForProfile('relay')
  assert.equal(risk.distill.enabled, true)
  assert.equal(risk.jev.enabled, false)
  assert.equal(risk.jev.hard_regex_enabled, true)
  assert.equal(risk.jev.safety_threshold, 0.5)
  assert.equal(risk.refusal.enabled, true)
})

test('applyUsageProfile writes routing, distill, and risk settings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-profile-'))
  const distillFile = path.join(dir, 'distill-rules.json')
  const settings = memorySettings()
  const seen = []
  try {
    const applied = await applyUsageProfile({
      mode: 'personal',
      persistRouting: (patch) => {
        seen.push(patch)
        return { ok: true }
      },
      settings,
      distillFile,
    })
    assert.equal(applied.mode, 'personal')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].quota.block_on_5h, false)
    assert.equal(loadDistillRules(distillFile).enabled, false)
    assert.equal(readJevConfig((key, fallback) => settings.get(key, fallback)).hard_regex_enabled, false)
    assert.equal(refusalGuardPolicy((key, fallback) => settings.get(key, fallback)).enabled, false)

    await applyUsageProfile({
      mode: 'relay',
      persistRouting: (patch) => {
        seen.push(patch)
        return { ok: true }
      },
      settings,
      distillFile,
    })
    assert.equal(loadDistillRules(distillFile).enabled, true)
    assert.equal(readJevConfig((key, fallback) => settings.get(key, fallback)).hard_regex_enabled, true)
    assert.equal(refusalGuardPolicy((key, fallback) => settings.get(key, fallback)).enabled, true)
    assert.equal(seen[1].tiers.pro.max_concurrency, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('unknown profile is rejected and a saved profile survives complete', async () => {
  assert.equal(routingPatchForProfile('nope'), null)
  await assert.rejects(
    async () =>
      await applyUsageProfile({
        mode: 'station',
        persistRouting() {},
        settings: memorySettings(),
        distillFile: '/tmp/x',
      }),
    (error) => error.code === 'invalid_profile',
  )
  const saved = setOnboardingProfile({}, 'admin', 'personal', '2026-10-13T00:00:00.000Z')
  assert.equal(recordOf(saved, 'admin').profile, 'personal')
  const done = applyOnboardingAction(saved, 'admin', 'complete', '2026-10-13T00:01:00.000Z')
  assert.equal(recordOf(done, 'admin').status, 'completed')
  assert.equal(recordOf(done, 'admin').profile, 'personal')
  const reset = applyOnboardingAction(done, 'admin', 'reset')
  assert.equal(recordOf(reset, 'admin').profile, null)
})
