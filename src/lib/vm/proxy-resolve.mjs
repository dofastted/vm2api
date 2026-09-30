/**
 * Resolve a usable SOCKS5 URL for sessionKey conversion.
 * Prefer the pool's internal credentials; never read username/password
 * from the redacted public snapshot.
 *
 * Local egress (`px-local`) is a bound exit with no SOCKS URL. Import and
 * host hops may then use the control-plane default route (`proxyUrl` empty,
 * `direct: true`). That is not "unbound".
 */
import { boundProxyUrl, isLocalEgressProxy } from './egress.mjs'
import { configuredIpv6Enabled, proxyBlockedReason } from './proxy-policy.mjs'

function poolHitForVm(proxyPool, vm) {
  if (!proxyPool || typeof proxyPool.snapshot !== 'function') return null
  const list = proxyPool.snapshot()?.proxies || []
  const id = vm?.proxy?.id || vm?.proxy_id
  const vmId = vm?.id
  return (
    list.find((p) => {
      if (id && p.id === id) return true
      if (!vmId) return false
      if (p.bound_vm_id === vmId) return true
      return Array.isArray(p.bound_vm_ids) && p.bound_vm_ids.includes(vmId)
    }) || null
  )
}

function socksUrlFromVm(vm) {
  const px = vm?.proxy
  if (!px) return null
  return boundProxyUrl(px) || null
}

export function poolProxyUnavailable(hit) {
  if (!hit) return false
  if (hit.blocked_reason) return true
  // Direct exit. A stale fail/dead from the old kin-egress probe is not "no proxy".
  if (isLocalEgressProxy(hit)) return hit.enabled === false
  return !hit.enabled || hit.status === 'dead' || hit.status === 'fail'
}

export function resolveImportProxy({ vm, proxyPool, overrideUrl = null } = {}) {
  const hit = poolHitForVm(proxyPool, vm)
  const ipv6Enabled = proxyPool?.snapshot?.().config?.ipv6_enabled ?? configuredIpv6Enabled()
  const blocked = proxyBlockedReason(overrideUrl ? { url: overrideUrl } : hit || vm?.proxy, ipv6Enabled)
  if (blocked || hit?.blocked_reason) {
    return { ok: false, proxyUrl: null, blocked: true, reason: blocked || hit.blocked_reason }
  }
  if (poolProxyUnavailable(hit)) {
    return { ok: false, proxyUrl: null, blocked: true, reason: 'proxy_unavailable' }
  }
  if (overrideUrl) {
    return { ok: true, proxyUrl: boundProxyUrl({ url: overrideUrl }), blocked: false, reason: null }
  }
  const allocated = vm?.id && typeof proxyPool?.getProxyForVm === 'function' ? proxyPool.getProxyForVm(vm.id) : null
  if (isLocalEgressProxy(hit) || isLocalEgressProxy(allocated) || isLocalEgressProxy(vm?.proxy)) {
    return { ok: true, proxyUrl: '', blocked: false, reason: null, direct: true }
  }
  if (allocated?.url) {
    return {
      ok: true,
      proxyUrl: String(allocated.url).replace(/^socks5:\/\//i, 'socks5h://'),
      blocked: false,
      reason: null,
    }
  }
  const fallback = socksUrlFromVm(vm)
  if (fallback) return { ok: true, proxyUrl: fallback, blocked: false, reason: null }
  return { ok: false, proxyUrl: null, blocked: false, reason: 'proxy_required' }
}
