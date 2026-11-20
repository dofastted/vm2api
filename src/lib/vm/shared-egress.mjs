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
 * The node a shared network's name belongs to.
 *
 * Needed because a shared network carries no per-VM label — it belongs to the
 * node, not to any one VM — so code that reclaims an exit from its network name
 * has nothing else to go on. Without this it falls through to the per-proxy
 * parse, which reads 'shared-<nodeId>' as a proxy id and derives a chain and
 * bridge that do not exist.
 */
export function sharedNodeIdFromNetwork(name) {
  const value = String(name || '')
  if (!isSharedNetwork(value)) return null
  const rest = value.slice(SHARED_NETWORK_PREFIX.length)
  if (!rest) return ''
  return rest.startsWith('-') ? rest.slice(1) : null
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

export const NETWORK_MODES = Object.freeze(['per-vm', 'shared'])

export function normalizeNetworkMode(value, fallback = 'per-vm') {
  const mode = String(value || '').trim()
  return NETWORK_MODES.includes(mode) ? mode : fallback
}

/**
 * A VM's own egress mode, recorded on the VM rather than read from the setting.
 *
 * This is the difference that makes the switch safe to turn off. The setting
 * decides the mode a VM is *created* with; after that the VM carries it. Were
 * the mode read live, flipping the setting back to per-vm would make the
 * control plane look for a per-VM bridge for a VM whose container is attached
 * to the shared network at a fixed address — it would be rebuilt onto a
 * different network, or simply not found. An existing VM therefore keeps the
 * mode it was built with, and a VM with nothing recorded is per-vm, which is
 * every VM that exists today.
 *
 * Deliberately not `runtime.network_mode`: that key already holds the
 * container's Docker NetworkMode (a network name, or 'host'), written on every
 * refresh. Sharing it would let a refresh overwrite the egress mode with a
 * network name, which normalises back to per-vm — and the control plane would
 * then hunt for a per-VM bridge for a VM sitting on the shared one.
 */
export function networkModeOf(vm) {
  return normalizeNetworkMode(vm?.runtime?.egress_mode)
}

export function isSharedModeVm(vm) {
  return networkModeOf(vm) === 'shared'
}

/**
 * Which node's shared network a VM belongs to. Cluster VMs carry a node id;
 * a VM on the control plane host has none, and shares that host's network.
 */
export function sharedNodeIdForVm(vm) {
  return String(vm?.node_id || '').trim()
}

/**
 * The shared members of one node, from that node's VMs.
 *
 * This is the shape difference between the two modes. A per-VM helper is
 * ensured from one proxy, which is why `ensureProxyEgress` takes one; a shared
 * helper is ensured from the whole node's membership, so its caller has to be
 * somewhere that can see the VM list. A VM whose mode is per-vm is not a member
 * even if it lives on this node — both modes run side by side.
 */
export function sharedMembersOf(vms = [], { nodeId = '', proxyUrlOf = () => '' } = {}) {
  const node = String(nodeId || '').trim()
  const members = []
  for (const vm of vms) {
    if (!vm?.id || !isSharedModeVm(vm)) continue
    if (sharedNodeIdForVm(vm) !== node) continue
    members.push({ vmId: vm.id, ip: sharedIpOf(vm), proxyUrl: String(proxyUrlOf(vm) || '').trim() })
  }
  return members
}

/** The address a shared-network VM was given, recorded on the VM. */
export function sharedIpOf(vm) {
  return String(vm?.runtime?.shared_ip || '').trim()
}

/**
 * The address to record for a VM joining the shared network.
 *
 * An address already recorded is kept when it is still this VM's to keep: it is
 * what the container is attached with and what the helper's route table names,
 * so re-deriving it would strand both.
 *
 * But a record is not proof of ownership. A slot whose container was removed
 * loses its endpoint, so its address leaves the live set and the allocator may
 * hand it to another VM — while the stale record still names it. Reusing it
 * unconditionally then puts two slots on one address, and the second container
 * fails to start. So a recorded address that now belongs to someone else is
 * given up and a fresh one allocated; `taken` here is the addresses held by
 * *others*, never this VM's own.
 */
export function assignSharedIp(vm, { subnet, taken = [], maxProbe = MAX_HOST_PROBE } = {}) {
  const existing = sharedIpOf(vm)
  if (existing && !taken.some((ip) => String(ip || '').trim() === existing)) {
    return { ip: existing, reused: true }
  }
  const ip = allocateHostIp(vm?.id || '', { subnet, taken, maxProbe })
  return { ip, reused: false, ...(existing ? { displaced: existing } : {}) }
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

/**
 * Drop routes for addresses no longer held on the shared network.
 *
 * The danger a stale route creates is not a dead entry — it is that the
 * allocator hands out addresses by what the network currently holds, so a
 * departed VM's address can be given to a new VM while the old route still
 * names the departed VM's upstream. The new VM would then leave through
 * someone else's exit, which is the exact failure the route table exists to
 * prevent, arriving by the back door.
 *
 * `keep` is for an address that is about to exist: a VM is routed before its
 * container is created, so its own address is not on the network yet.
 */
export function pruneSharedRoutes(routes = [], liveIps = [], { keep = [] } = {}) {
  const live = new Set([...liveIps, ...keep].map((ip) => String(ip || '').trim()).filter(Boolean))
  return routes.filter((r) => live.has(String(r?.vm_ip || '').trim()))
}

/**
 * Put one member into a route table, replacing any entry for its address.
 *
 * Replacing rather than appending is the point: two entries for one address
 * would make the whole table invalid at the helper, which fails the reload and
 * leaves every VM on the node on the previous table.
 */
export function mergeSharedRoute(routes = [], member) {
  const ip = String(member?.ip || '').trim()
  const proxyUrl = String(member?.proxyUrl || '').trim()
  const others = routes.filter((r) => String(r?.vm_ip || '').trim() !== ip)
  if (!ip || !proxyUrl) return sharedRoutes(others.map((r) => ({ ip: r.vm_ip, proxyUrl: r.proxy_url })))
  return sharedRoutes([
    ...others.map((r) => ({ ip: r.vm_ip, proxyUrl: r.proxy_url })),
    { vmId: member?.vmId || '', ip, proxyUrl },
  ])
}

/** A route table as members, for the helpers above. */
export function routesAsMembers(routes = []) {
  return routes.map((r) => ({
    vmId: '',
    ip: String(r?.vm_ip || '').trim(),
    proxyUrl: String(r?.proxy_url || '').trim(),
  }))
}
