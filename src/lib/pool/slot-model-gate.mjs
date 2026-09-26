import { inferClaudeTier } from './claude-tier.mjs'
import { isFableModel } from './upstream-error-policy.mjs'
import { getModelEntry, getPolicyCatalogIds, resolvePolicyModelId } from '../protocol/model-policy.mjs'
import { getGptPolicyCatalogIds } from '../protocol/gpt-model-policy.mjs'
import { isCodexCatalogModel } from '../protocol/models.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'

export function normalizeAllowedModels(raw) {
  if (raw == null) return null
  if (!Array.isArray(raw)) return null
  const ids = [...new Set(raw.map((item) => String(item || '').trim()).filter(Boolean))]
  return ids.length ? ids : null
}

function modelKeys(model) {
  const raw = String(model || '').trim()
  if (!raw) return []
  const resolved = resolvePolicyModelId(raw) || raw
  const entry = getModelEntry(raw)
  return [
    ...new Set(
      [
        raw.toLowerCase(),
        resolved.toLowerCase(),
        String(entry?.id || '').toLowerCase(),
        ...(entry?.aliases || []).map((alias) => String(alias).toLowerCase()),
      ].filter(Boolean),
    ),
  ]
}

function keysIntersect(left, right) {
  for (const a of left) {
    for (const b of right) {
      if (a === b) return true
      // The corrected 5-1 id must not widen a Fable 5 allowlist (or vice versa).
      const fable51 = /^claude-fable-5(?:-1|\.1)(?:-|$)/
      if (fable51.test(a) !== fable51.test(b)) continue
      // claude-opus-5 is a prefix of claude-opus-5-5. They are different models.
      const opus55 = /^claude-opus-5(?:-5|\.5)(?:-|$)/
      if (opus55.test(a) !== opus55.test(b)) continue
      if (a.startsWith(`${b}-`) || b.startsWith(`${a}-`)) return true
    }
  }
  return false
}

export function modelMatchesAllowlist(model, allowed) {
  const list = normalizeAllowedModels(allowed)
  if (!list) return true
  const requestKeys = modelKeys(model)
  if (!requestKeys.length) return false
  for (const item of list) {
    if (keysIntersect(requestKeys, modelKeys(item))) return true
  }
  return false
}

export function parseAllowedModelsPatch(raw, opts = {}) {
  if (raw == null) return { ok: true, value: null }
  if (!Array.isArray(raw)) return { ok: false, error: 'allowed_models must be an array' }
  const gpt = opts.platform === 'openai' || opts.platform === 'gpt' || opts.platform === 'codex' || isCodexVm(opts.vm)
  const catalog = new Set(
    (gpt ? getGptPolicyCatalogIds({ enabledOnly: false }) : getPolicyCatalogIds({ enabledOnly: false })).map((id) =>
      id.toLowerCase(),
    ),
  )
  const ids = []
  for (const item of raw) {
    const value = String(item || '').trim()
    if (!value) continue
    if (gpt) {
      const known = catalog.has(value.toLowerCase())
      if (!known) return { ok: false, error: `unknown model: ${value}` }
      ids.push(value)
      continue
    }
    const resolved = resolvePolicyModelId(value) || value
    const entry = getModelEntry(value)
    const known =
      catalog.has(resolved.toLowerCase()) ||
      catalog.has(value.toLowerCase()) ||
      catalog.has(String(entry?.id || '').toLowerCase()) ||
      (entry?.aliases || []).some((alias) => String(alias).toLowerCase() === value.toLowerCase())
    if (!known) return { ok: false, error: `unknown model: ${value}` }
    ids.push(entry?.id || resolved)
  }
  return { ok: true, value: normalizeAllowedModels(ids) }
}

function quotaView(vm, account) {
  const unified = account?.unified && typeof account.unified === 'object' ? account.unified : {}
  const fable = unified.fable || vm?.claude?.fable || vm?.fable || {}
  return {
    fable,
    utilization_7d_oi: unified.utilization_7d_oi ?? unified['7d_oi']?.utilization ?? vm?.utilization_7d_oi,
    reset_7d_oi: unified.reset_7d_oi || unified['7d_oi']?.reset || vm?.reset_7d_oi,
    status_7d_oi: unified.status_7d_oi || unified['7d_oi']?.status || vm?.status_7d_oi,
    '7d_oi': unified['7d_oi'],
    account_tier: unified.account_tier || vm?.claude?.account_tier || vm?.account_tier,
    usage_has_fable: unified.usage_has_fable ?? vm?.usage_has_fable ?? null,
  }
}

export function resolveSlotTier(vm, account = null) {
  const quota = quotaView(vm, account)
  // An explicit Pro classification must veto stale Max usage evidence. The
  // latter can survive a credential change or a Fable entitlement rejection.
  if (
    String(vm?.claude?.account_tier || vm?.account_tier || '').toLowerCase() === 'pro' ||
    String(account?.unified?.account_tier || '').toLowerCase() === 'pro'
  ) {
    return 'pro'
  }
  return inferClaudeTier(
    {
      has_token: true,
      account_tier: quota.account_tier,
      fable: quota.fable,
      utilization_7d_oi: quota.utilization_7d_oi,
      reset_7d_oi: quota.reset_7d_oi,
      status_7d_oi: quota.status_7d_oi,
      usage_has_fable: quota.usage_has_fable,
    },
    quota,
  ).key
}

export function slotAllowsModel({ vm, account = null, model } = {}) {
  const modelKey = String(model || '').trim()
  if (!modelKey) return { ok: true }
  if (isCodexVm(vm)) {
    if (!isCodexCatalogModel(modelKey)) return { ok: false, reason: 'codex_model_required' }
  } else if (isCodexCatalogModel(modelKey)) {
    return { ok: false, reason: 'claude_model_required' }
  }
  const canonical = resolvePolicyModelId(modelKey) || modelKey
  const deniedUntil = Number(account?.unified?.model_denied_until?.[canonical]) || 0
  if (deniedUntil > Date.now()) return { ok: false, reason: 'model_not_supported' }
  if (isFableModel(modelKey) && resolveSlotTier(vm, account) !== 'max') {
    return { ok: false, reason: 'fable_requires_max' }
  }
  const allowed = normalizeAllowedModels(vm?.policy?.allowed_models)
  if (allowed && !modelMatchesAllowlist(modelKey, allowed)) {
    return { ok: false, reason: 'model_not_allowed' }
  }
  return { ok: true }
}
