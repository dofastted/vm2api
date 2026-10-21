/**
 * First-run usage profiles. Only the fields named here change.
 * personal opens VM quota to the panel maximum and turns risk gates off.
 * relay writes the shipped quota and risk defaults back.
 * Persona, probes, health cache, and every other switch stay untouched.
 */
import { saveDistillRules } from '../core/distill-detect.mjs'
import { applyRefusalGuardPatch } from '../core/refusal-guard.mjs'
import { DEFAULT_TIER_POLICIES } from '../pool/quota-tiers.mjs'
import { OPENAI_QUOTA_DEFAULTS } from '../pool/openai-quota-policy.mjs'
import { applyJevPatch, POLICY_NOUL } from '../protocol/jev-intercept.mjs'

export const USAGE_PROFILES = Object.freeze(['personal', 'relay'])

const PERSONAL_TIER = Object.freeze({
  max_concurrency: 256,
  max_rpm: 0,
  limit_5h: 1,
  limit_7d: 1,
})

const RELAY_CONCURRENCY = Object.freeze({
  default_max_per_account: 2,
  fable_max_per_account: 4,
  default_max_rpm: 0,
})

const PERSONAL_CONCURRENCY = Object.freeze({
  default_max_per_account: 256,
  fable_max_per_account: 256,
  default_max_rpm: 0,
})

function tierPatch(source) {
  const out = {}
  for (const key of Object.keys(DEFAULT_TIER_POLICIES)) {
    const row = source === 'personal' ? PERSONAL_TIER : DEFAULT_TIER_POLICIES[key]
    out[key] = {
      max_concurrency: row.max_concurrency,
      max_rpm: row.max_rpm,
      limit_5h: row.limit_5h,
      limit_7d: row.limit_7d,
    }
  }
  return out
}

export function normalizeUsageProfile(value) {
  return USAGE_PROFILES.includes(value) ? value : null
}

/** Routing fragment passed to persistRoutingPatch. */
export function routingPatchForProfile(mode) {
  const profile = normalizeUsageProfile(mode)
  if (!profile) return null
  const personal = profile === 'personal'
  const codexBase = personal ? { ...OPENAI_QUOTA_DEFAULTS, max_concurrency: 256 } : { ...OPENAI_QUOTA_DEFAULTS }
  return {
    quota: {
      block_on_5h: !personal,
      block_on_7d: !personal,
    },
    concurrency: personal ? { ...PERSONAL_CONCURRENCY } : { ...RELAY_CONCURRENCY },
    tiers: tierPatch(profile),
    codex: { quota: codexBase },
  }
}

export function riskPatchForProfile(mode) {
  const profile = normalizeUsageProfile(mode)
  if (!profile) return null
  const personal = profile === 'personal'
  return {
    distill: { enabled: !personal },
    jev: {
      enabled: false,
      hard_regex_enabled: !personal,
      safety_threshold: personal ? 0 : POLICY_NOUL,
    },
    refusal: {
      enabled: !personal,
      similarity_enabled: !personal,
      device_block_enabled: !personal,
    },
  }
}

/**
 * @param {{ mode: string, persistRouting: (patch: object) => unknown, settings: { get: Function, set: Function }, distillFile: string, setDistill?: (rules: object) => void }} input
 */
export async function applyUsageProfile({ mode, persistRouting, settings, distillFile, setDistill } = {}) {
  const profile = normalizeUsageProfile(mode)
  if (!profile) {
    const err = new Error('mode 必须是 personal 或 relay')
    err.code = 'invalid_profile'
    throw err
  }
  const routing = await persistRouting(routingPatchForProfile(profile))
  const risk = riskPatchForProfile(profile)
  const distill = saveDistillRules(distillFile, risk.distill)
  if (typeof setDistill === 'function') setDistill(distill)
  const jev = await applyJevPatch(settings, risk.jev)
  if (!jev.ok) {
    const err = new Error(jev.problems.join('；'))
    err.code = 'invalid_profile'
    throw err
  }
  const refusal = await applyRefusalGuardPatch(settings, risk.refusal)
  if (!refusal.ok) {
    const err = new Error(refusal.problems.join('；'))
    err.code = 'invalid_profile'
    throw err
  }
  return { mode: profile, routing, distill_enabled: distill.enabled, jev, refusal }
}
