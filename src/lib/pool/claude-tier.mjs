import { isFableUnavailablePro, isInventedFableWindow } from '../oauth/crs-usage-probe.mjs'

function quotaView(vm = {}, quota = {}) {
  return {
    utilization_7d_oi: quota.utilization_7d_oi ?? vm.utilization_7d_oi,
    reset_7d_oi: quota.reset_7d_oi || vm.reset_7d_oi,
    status_7d_oi: quota.status_7d_oi || vm.status_7d_oi,
    '7d_oi': quota['7d_oi'] || vm['7d_oi'],
    usage_has_fable: quota.usage_has_fable ?? vm.usage_has_fable,
  }
}

/** Official /usage listing a Fable model, or a real 7d_oi window, is Max. */
export function hasClaudeFableUsage(vm = {}, quota = {}) {
  const q = quotaView(vm, quota)
  if (q.usage_has_fable === true) return true
  const fb = quota.fable || vm.fable || {}
  if (fb.ok) return true
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

/**
 * Claude-only: official /usage 有 Fable 模型或真实 7d_oi=Max。
 * 落盘 pro / Fable hop 拒绝不能盖掉 usage 里的 Fable。
 * Shared by the panel and the pool picker so they cannot drift.
 */
export function inferClaudeTier(vm = {}, quota = {}) {
  const hasToken = !!(vm.has_token || vm.has_access)
  if (!hasToken) return { key: 'none', label: null }
  const fb = quota.fable || vm.fable || {}
  const q = quotaView(vm, quota)
  const stored = String(vm.account_tier || quota.account_tier || '').toLowerCase()
  if (hasClaudeFableUsage(vm, quota) || stored === 'max') {
    return { key: 'max', label: 'Max' }
  }
  if (stored === 'pro' || isFableUnavailablePro(fb, q)) {
    return { key: 'pro', label: 'Pro' }
  }
  return { key: 'unknown', label: null }
}
