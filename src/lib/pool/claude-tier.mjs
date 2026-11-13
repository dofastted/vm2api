import { isInventedFableWindow } from '../oauth/crs-usage-probe.mjs'

function quotaView(vm = {}, quota = {}) {
  return {
    utilization_7d_oi: quota.utilization_7d_oi ?? vm.utilization_7d_oi,
    reset_7d_oi: quota.reset_7d_oi || vm.reset_7d_oi,
    status_7d_oi: quota.status_7d_oi || vm.status_7d_oi,
    '7d_oi': quota['7d_oi'] || vm['7d_oi'],
    usage_has_fable: quota.usage_has_fable ?? vm.usage_has_fable,
  }
}

/** Whether official /usage contains a real Fable window (not a subscription verdict). */
export function hasClaudeFableUsage(vm = {}, quota = {}) {
  const q = quotaView(vm, quota)
  if (q.usage_has_fable != null) return q.usage_has_fable === true
  const fb = quota.fable || vm.fable || {}
  const oi = q['7d_oi'] || {}
  const hasOi =
    q.utilization_7d_oi != null ||
    q.reset_7d_oi ||
    q.status_7d_oi ||
    oi.utilization != null ||
    oi.reset ||
    oi.resets_at ||
    oi.status
  if (!hasOi) return false
  return !isInventedFableWindow(fb, q)
}

/** Pro/Free OAuth rate metadata vetoes usage-derived Max; Max metadata never promotes it. */
export function isProRateLimitTier(tier) {
  return (
    String(tier || '')
      .trim()
      .toLowerCase() === 'default_claude_ai'
  )
}

export function guardUsageTier(tier, rateLimitTier) {
  return tier === 'max' && isProRateLimitTier(rateLimitTier) ? 'pro' : tier
}

/**
 * Scheduling tier: verified profile first, then usage constrained by OAuth rate metadata.
 * Subscription display is separate; Max rate metadata alone is not a scheduling upgrade.
 * Shared by the panel and the pool picker so they cannot drift.
 */
export function inferClaudeTier(vm = {}, quota = {}) {
  const hasToken = !!(vm.has_token || vm.has_access)
  if (!hasToken) return { key: 'none', label: null }
  const profile =
    vm.account_tier_source === 'profile' && ['pro', 'max'].includes(vm.account_tier)
      ? vm
      : quota.account_tier_source === 'profile' && ['pro', 'max'].includes(quota.account_tier)
        ? quota
        : null
  if (profile?.account_tier === 'pro') return { key: 'pro', label: 'Pro' }
  if (profile?.account_tier === 'max') return { key: 'max', label: 'Max' }
  const q = quotaView(vm, quota)
  if (q.usage_has_fable === false) return { key: 'pro', label: 'Pro' }
  if (isProRateLimitTier(vm.rate_limit_tier || quota.rate_limit_tier)) return { key: 'pro', label: 'Pro' }
  const stored = String(vm.account_tier || quota.account_tier || '').toLowerCase()
  if (hasClaudeFableUsage(vm, quota) || stored === 'max') {
    return { key: 'max', label: 'Max' }
  }
  if (stored === 'pro') {
    return { key: 'pro', label: 'Pro' }
  }
  return { key: 'pro', label: 'Pro' }
}
