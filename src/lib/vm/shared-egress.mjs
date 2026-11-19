/**
 * Shared egress: one network, one bridge, one helper per node instead of one of
 * each per VM.
 *
 * A per-VM helper serves one upstream, so giving each VM its own exit meant
 * giving each VM its own network, bridge, iptables chain and run directory. That
 * is what exhausts Docker's address pool long before CPU or memory run out. Here
 * every VM on a node shares one bridge and one helper, and the helper tells them
 * apart by the address this module hands each one — see `Config.Routes` in
 * `worker/internal/egress/server.go`.
 *
 * The addresses are the contract between the two sides: the IP written into a
 * VM's endpoint is the same IP written into the helper's route table, so this
 * module owns both and derives them from one allocation.
 */

import { createSubnetAllocator, formatIp, parseCidr, probeIndex } from './subnet-pool.mjs'

/** One shared network per node; the node id keeps two nodes' names distinct. */
export const SHARED_NETWORK_PREFIX = 'kin-eg-shared'

/**
 * A /20 holds 4094 usable addresses. Per-VM networks are /28 because a VM needs
 * two addresses; the shared network needs one per VM on the node, so it is sized
 * for the whole node at once rather than per VM.
 */
export const DEFAULT_SHARED_PREFIX = 20

/**
 * Host-bit probing stops after this many misses. Same reasoning as the subnet
 * allocator: a deterministic first choice keeps a VM's address stable across
 * rebuilds, and linear probing resolves the rare collision without a registry.
 */
export const MAX_HOST_PROBE = 512

export function sharedNetworkName(nodeId = '') {
  const id = String(nodeId || '').trim()
  return id ? `${SHARED_NETWORK_PREFIX}-${id}` : SHARED_NETWORK_PREFIX
}

/**
 * Docker derives a bridge name from the network id, which is not knowable before
 * creation, so the bridge is named explicitly to keep the iptables rules
 * predictable. Mirrors `bridgeName` in egress.mjs.
 */
export function sharedBridgeName(nodeId = '') {
  const id = String(nodeId || '')
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 8)
  return id ? `kegsh${id}` : 'kegsh'
}

export function sharedChainName(nodeId = '') {
  return sharedBridgeName(nodeId).toUpperCase()
}

/** True for a network this module owns, whichever node it belongs to. */
export function isSharedNetwork(name) {
  return String(name || '').startsWith(SHARED_NETWORK_PREFIX)
}

/**
 * The shared helper's identity.
 *
 * It is shaped like a proxy id so the whole per-proxy helper lifecycle applies
 * unchanged: its own run directory, port pair, pid file and container name, and
 * — the part that matters most — the existing SIGHUP reload. A membership change
 * is a config rewrite plus a signal, not a restart, so VMs already connected
 * through the helper keep their connections when another VM joins or leaves.
 */
export const SHARED_EGRESS_PREFIX = 'eg-shared'

export function sharedEgressId(nodeId = '') {
  const id = String(nodeId || '').trim()
  return id ? `${SHARED_EGRESS_PREFIX}-${id}` : SHARED_EGRESS_PREFIX
}

export function isSharedEgressId(proxyId) {
  const id = String(proxyId || '')
  return id === SHARED_EGRESS_PREFIX || id.startsWith(`${SHARED_EGRESS_PREFIX}-`)
}

/** The node a shared helper id belongs to; '' for the control plane's own. */
export function sharedEgressNodeId(proxyId) {
  const id = String(proxyId || '')
  return id.startsWith(`${SHARED_EGRESS_PREFIX}-`) ? id.slice(SHARED_EGRESS_PREFIX.length + 1) : ''
}

/**
 * The node's shared subnet. Allocated before any per-VM subnet and reserved
 * against that allocator, because a /20 carved out of an already-fragmented pool
 * may have nowhere to land once the /28s are placed.
 */
export function allocateSharedSubnet(nodeId, { pool, taken = [], prefix = DEFAULT_SHARED_PREFIX } = {}) {
  const allocator = createSubnetAllocator({ ...(pool ? { pool } : {}), prefix, taken })
  return allocator.allocate(sharedNetworkName(nodeId))
}

function ipToInt(value) {
  const cidr = parseCidr(`${String(value || '').trim()}/32`)
  return cidr ? cidr.network : null
}

/**
 * Usable host range of a subnet: the network address, the gateway (network+1)
 * and the broadcast address are not handed out.
 */
export function hostRange(subnet) {
  const cidr = parseCidr(subnet)
  if (!cidr) return null
  const first = cidr.network + 2
  const last = cidr.network + cidr.size - 2
  if (last < first) return null
  return { first, last, total: last - first + 1, gateway: cidr.network + 1 }
}

/**
 * The address this VM gets on the shared bridge.
 *
 * Derived from the VM id so a rebuilt VM keeps the address already written into
 * the helper's route table, and probed linearly so a collision shifts one VM
 * rather than failing the node. `taken` is the set of addresses currently held
 * by endpoints on the network, read from live state rather than a registry — the
 * same reason the subnet allocator recomputes it.
 */
export function allocateHostIp(vmId, { subnet, taken = [], maxProbe = MAX_HOST_PROBE } = {}) {
  const range = hostRange(subnet)
  if (!range) throw new Error(`invalid shared subnet: ${subnet}`)
  const used = new Set()
  for (const entry of taken) {
    const addr = ipToInt(entry)
    if (addr !== null && addr >= range.first && addr <= range.last) used.add(addr - range.first)
  }
  const index = probeIndex(String(vmId || ''), range.total, (i) => used.has(i), maxProbe)
  if (index < 0) {
    throw new Error(`shared subnet ${subnet} is full (${used.size} of ${range.total} addresses in use)`)
  }
  return formatIp(range.first + index)
}

/** Capacity of a shared subnet, for placement decisions and operator output. */
export function sharedCapacity(subnet, taken = []) {
  const range = hostRange(subnet)
  if (!range) return { total: 0, used: 0, free: 0 }
  let used = 0
  for (const entry of taken) {
    const addr = ipToInt(entry)
    if (addr !== null && addr >= range.first && addr <= range.last) used += 1
  }
  return { total: range.total, used, free: Math.max(0, range.total - used) }
}

/**
 * The helper's route table: which VM address leaves through which upstream.
 *
 * A VM without a usable upstream is left out rather than given a placeholder.
 * The helper refuses a source it has no route for, so omission means that VM
 * cannot reach the internet — which is the intended outcome, and far better than
 * an entry pointing somewhere it should not go.
 */
export function sharedRoutes(members = []) {
  const routes = []
  const seen = new Set()
  for (const member of members) {
    const ip = String(member?.ip || '').trim()
    const proxyUrl = String(member?.proxyUrl || '').trim()
    if (!ip || !proxyUrl || seen.has(ip)) continue
    seen.add(ip)
    routes.push({ vm_ip: ip, proxy_url: proxyUrl })
  }
  // Sorted so an unchanged membership produces an unchanged config, and the
  // helper is not reloaded just because a map iterated differently.
  routes.sort((a, b) => {
    const left = ipToInt(a.vm_ip) ?? 0
    const right = ipToInt(b.vm_ip) ?? 0
    return left - right
  })
  return routes
}

/** VMs that would be refused by the helper for the given route table. */
export function unroutedMembers(members = []) {
  const routed = new Set(sharedRoutes(members).map((r) => r.vm_ip))
  return members.filter((m) => !routed.has(String(m?.ip || '').trim())).map((m) => m?.vmId || m?.ip || '')
}
