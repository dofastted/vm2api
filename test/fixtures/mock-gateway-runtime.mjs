// Only harness-spawned gateways load this module. Pure policy/formatting logic
// stays real; egress effects use an in-memory registry, not the host daemon.
export * from '../../src/lib/vm/egress.mjs?mock-gateway-original'
export * from '../../src/lib/vm/proxy-geo.mjs?mock-gateway-original'
export * from '../../src/lib/cluster/docker-remote.mjs?mock-gateway-original'
import {
  boundProxyUrl,
  isLocalEgressProxy,
  networkName,
} from '../../src/lib/vm/egress.mjs?mock-gateway-original'
import { proxyBlockedReason } from '../../src/lib/vm/proxy-policy.mjs'

const networks = new Set()

function ensure(proxy) {
  const blocked = proxyBlockedReason(proxy)
  if (blocked) return { ok: false, error: blocked, vmOperationNotStarted: true }
  if (!proxy?.id || (!isLocalEgressProxy(proxy) && !boundProxyUrl(proxy)))
    return { ok: false, error: 'bound SOCKS5 id and url required', vmOperationNotStarted: true }
  const name = networkName(proxy.id)
  const reused = networks.has(name)
  networks.add(name)
  return { ok: true, mock: true, reused, network: name, proxy_id: proxy.id }
}

export async function ensureProxyEgress(_projectRoot, proxy) {
  return ensure(proxy)
}

export function ensureLocalProxyEgress(proxy) {
  return ensure(proxy)
}

export async function startProxyEgress(_projectRoot, proxy) {
  return ensure(proxy)
}

export async function stopProxyEgress(_projectRoot, proxyId) {
  networks.delete(networkName(proxyId))
  return { ok: true, ended: true, mock: true }
}

export function proxyEgressReady(proxy) {
  const blocked = proxyBlockedReason(proxy)
  if (blocked) return { ok: false, reason: blocked }
  if (isLocalEgressProxy(proxy)) return { ok: true, mode: 'direct' }
  return networks.has(networkName(proxy?.id)) ? { ok: true, mock: true } : { ok: false, reason: 'not_running' }
}

export function localEgressStatus(proxyOrId) {
  const proxy = typeof proxyOrId === 'string' ? { id: proxyOrId } : proxyOrId
  if (!isLocalEgressProxy(proxy)) return null
  const name = networkName(proxy.id)
  return networks.has(name) ? { ok: true, mode: 'local', name, network: name } : { ok: false, reason: 'local_network_missing' }
}

// Geo remains unavailable instead of inventing a successful provider response.
export async function lookupProxyGeo() {
  return { ok: false, error: 'mock_geo_unavailable' }
}

export async function lookupProxyGeoV6() {
  return { ok: false, error: 'mock_geo_unavailable' }
}

export function localDocker() {
  return async () => {
    throw Object.assign(new Error('mock gateway has no Docker daemon'), { code: 'docker_unavailable' })
  }
}
