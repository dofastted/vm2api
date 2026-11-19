/**
 * Egress subnet allocation. `docker network create` without `--subnet` draws from
 * the daemon's `default-address-pools`, which is why the fleet dies at ~200 VMs:
 * one SOCKS VM holds one docker network (see slotEgressNames in remote-slot.mjs)
 * and the pool runs out. An explicit `--subnet` bypasses that pool entirely, so
 * the fix needs no dockerd restart and does not disturb running containers.
 *
 * Allocation is stateless and deterministic: the index is derived from the id and
 * linearly probed past whatever is already taken. A VM rebuild therefore lands on
 * its previous subnet, which matches the "reuse if the network already exists"
 * branch in ensureEgressNetwork, and nothing has to be migrated or reconciled —
 * subnets operators carved out by hand are read back as occupied facts.
 *
 * Subnets are reused per node. An IP is not a VM's durable identity (vm-registry
 * stores none) and `enable_icc=false` forbids VM-to-VM traffic, so two nodes may
 * hold the same subnet without conflict.
 */
import crypto from 'node:crypto'
import { getDb, isDbOpen } from '../db/database.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'

/** RFC 6598 carrier-grade NAT space: unused by cloud VPCs, WireGuard and docker's own pools. */
export const DEFAULT_SUBNET_POOL = '100.64.0.0/10'

/**
 * A network holds only a gateway and the VM container; the egress helper runs with
 * `--network host` and takes no address (see egressContainerSpec). /28 leaves room
 * to spare and still yields 262144 subnets per node out of 100.64.0.0/10.
 */
export const DEFAULT_SUBNET_PREFIX = 28

const MAX_PROBE = 4096
const INSPECT_BATCH = 200

const FULL_MASK = 0xffffffff

function maskFor(prefix) {
  return prefix === 0 ? 0 : (FULL_MASK << (32 - prefix)) >>> 0
}

export function parseCidr(value) {
  const m = String(value || '')
    .trim()
    .match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/)
  if (!m) return null
  const octets = [m[1], m[2], m[3], m[4]].map(Number)
  if (octets.some((o) => o > 255)) return null
  const prefix = Number(m[5])
  if (prefix > 32) return null
  const addr = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  const network = (addr & maskFor(prefix)) >>> 0
  return { network, prefix, size: 2 ** (32 - prefix) }
}

export function formatIp(addr) {
  const n = addr >>> 0
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`
}

export function formatCidr(network, prefix) {
  return `${formatIp(network)}/${prefix}`
}

/**
 * Docker's bridge gateway convention: the first usable address. Taking the third
 * octet and appending `.1` only works for /24 and shorter — a /28 at `.16` would
 * yield `.1`, outside its own range. /31 and /32 cannot host a gateway at all.
 */
export function gatewayOf(subnet) {
  const cidr = typeof subnet === 'string' ? parseCidr(subnet) : subnet
  if (!cidr || cidr.size < 4) return ''
  return formatIp(cidr.network + 1)
}

/** Two ranges overlap when the shorter prefix covers both network addresses. */
export function overlaps(a, b) {
  if (!a || !b) return false
  const mask = maskFor(Math.min(a.prefix, b.prefix))
  return (a.network & mask) >>> 0 === (b.network & mask) >>> 0
}

export function subnetAt(pool, prefix, index) {
  const step = 2 ** (32 - prefix)
  return (pool.network + index * step) >>> 0
}

/**
 * Deterministic start index for an id. Kept separate from what is being handed out
 * so the shared-network task can reuse it for host bits inside one subnet.
 */
export function hashIndex(id, total) {
  if (!Number.isInteger(total) || total < 1) throw new Error('hash total must be a positive integer')
  return crypto.createHash('sha1').update(String(id)).digest().readUInt32BE(0) % total
}

/**
 * Probe core, independent of what an index means. Returns -1 when every candidate
 * within the probe budget is taken, leaving the error wording to the caller.
 */
export function probeIndex(id, total, isTaken, maxProbe = MAX_PROBE) {
  const base = hashIndex(id, total)
  const limit = Math.min(Math.max(1, maxProbe), total)
  for (let probe = 0; probe < limit; probe++) {
    const index = (base + probe) % total
    if (!isTaken(index)) return index
  }
  return -1
}

function toCidrList(taken) {
  const out = []
  for (const entry of taken || []) {
    const cidr = typeof entry === 'string' ? parseCidr(entry) : entry?.prefix === undefined ? null : entry
    if (cidr) out.push(cidr)
  }
  return out
}

function exhausted(pool, used, total) {
  const err = new Error(`subnet_pool_exhausted: ${used}/${total} allocated in ${pool}`)
  err.code = 'subnet_pool_exhausted'
  err.water = { used, total, pool, ratio: total ? used / total : 1 }
  return err
}

/**
 * Stateful view over one pool. `allocate` marks what it hands out, so a run of
 * calls never repeats even before the networks exist in docker. Occupied indexes
 * are a Set, keeping allocation O(1) instead of rescanning the taken list.
 */
export function createSubnetAllocator({
  pool = DEFAULT_SUBNET_POOL,
  prefix = DEFAULT_SUBNET_PREFIX,
  taken = [],
  maxProbe = MAX_PROBE,
} = {}) {
  const poolCidr = parseCidr(pool)
  if (!poolCidr) throw new Error(`invalid subnet pool: ${pool}`)
  if (!Number.isInteger(prefix) || prefix < poolCidr.prefix || prefix > 30) {
    throw new Error(`invalid subnet prefix /${prefix} for pool ${pool}`)
  }

  const total = 2 ** (prefix - poolCidr.prefix)
  const step = 2 ** (32 - prefix)
  const poolEnd = poolCidr.network + poolCidr.size - 1
  const used = new Set()
  const label = formatCidr(poolCidr.network, poolCidr.prefix)

  const markRange = (cidr) => {
    if (!overlaps(cidr, poolCidr)) return
    const start = Math.max(cidr.network, poolCidr.network)
    const end = Math.min(cidr.network + cidr.size - 1, poolEnd)
    const first = Math.floor((start - poolCidr.network) / step)
    const last = Math.min(Math.floor((end - poolCidr.network) / step), total - 1)
    for (let i = first; i <= last; i++) used.add(i)
  }

  for (const cidr of toCidrList(taken)) markRange(cidr)

  return {
    pool: label,
    prefix,
    total,
    get used() {
      return used.size
    },
    /** Record an outside subnet as occupied; ranges outside the pool are ignored. */
    reserve(value) {
      const cidr = typeof value === 'string' ? parseCidr(value) : value
      if (cidr) markRange(cidr)
    },
    isTaken(value) {
      const cidr = typeof value === 'string' ? parseCidr(value) : value
      if (!cidr || !overlaps(cidr, poolCidr)) return false
      return used.has(Math.floor((Math.max(cidr.network, poolCidr.network) - poolCidr.network) / step))
    },
    /** Deterministic subnet for `id`, marked as used before returning. */
    allocate(id) {
      const index = probeIndex(id, total, (i) => used.has(i), maxProbe)
      if (index < 0) throw exhausted(label, used.size, total)
      used.add(index)
      return formatCidr(subnetAt(poolCidr, prefix, index), prefix)
    },
  }
}

/** One-shot wrapper; prefer the allocator when handing out several subnets. */
export function allocateSubnet(id, options = {}) {
  return createSubnetAllocator(options).allocate(id)
}

function dockerNetworkSubnets(runDocker) {
  const ls = runDocker(['network', 'ls', '--format', '{{.ID}}'])
  if (!ls?.ok) return []
  const ids = String(ls.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const out = []
  for (let i = 0; i < ids.length; i += INSPECT_BATCH) {
    const batch = ids.slice(i, i + INSPECT_BATCH)
    const r = runDocker(['network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Subnet}} {{end}}', ...batch])
    if (!r?.ok) continue
    for (const token of String(r.stdout || '').split(/\s+/)) {
      const cidr = parseCidr(token)
      if (cidr) out.push(cidr)
    }
  }
  return out
}

/** Host routes, so a pool overlapping the VPS network or a tunnel is avoided. */
export function parseRouteSubnets(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const token = line.trim().split(/\s+/)[0]
    if (!token || token === 'default') continue
    const cidr = parseCidr(token.includes('/') ? token : `${token}/32`)
    if (cidr) out.push(cidr)
  }
  return out
}

/**
 * Everything already spoken for on this node: docker's own networks (including
 * hand-carved ones and whatever the daemon auto-assigned earlier) plus host routes.
 * Recomputed per allocation round, so a destroyed VM's subnet returns to the pool
 * with no explicit release step.
 */
export function collectTakenSubnets({ runDocker, runIp } = {}) {
  const out = []
  if (typeof runDocker === 'function') out.push(...dockerNetworkSubnets(runDocker))
  if (typeof runIp === 'function') {
    const r = runIp(['route'])
    if (r?.ok) out.push(...parseRouteSubnets(r.stdout))
  }
  return out
}

/**
 * Pool and prefix overrides live beside the other egress settings. Mirrors
 * configuredDnsUpstream: no DB open means defaults, never a throw.
 */
export function subnetPoolConfig() {
  const fallback = { pool: DEFAULT_SUBNET_POOL, prefix: DEFAULT_SUBNET_PREFIX }
  if (!isDbOpen()) return fallback
  try {
    const cfg = new SettingsRepo(getDb()).get('proxy_pool_config')
    const pool = String(cfg?.egress_subnet_pool || '').trim()
    const prefix = Number(cfg?.egress_subnet_prefix)
    const poolCidr = parseCidr(pool)
    return {
      pool: poolCidr ? pool : fallback.pool,
      prefix:
        Number.isInteger(prefix) && poolCidr && prefix >= poolCidr.prefix && prefix <= 30 ? prefix : fallback.prefix,
    }
  } catch {
    return fallback
  }
}
