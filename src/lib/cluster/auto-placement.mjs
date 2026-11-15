/**
 * Automatic placement for new Docker slots: pick the machine (this host or a
 * cluster node) with the most memory headroom when the create request names
 * no `node_id`.
 *
 * Headroom is booked, not sampled: every slot already placed on a machine holds
 * its container memory limit (`slotMemory`, or `slot_reserve_memory` when that
 * is larger, since a capacity reconciler may raise the limit after create)
 * against `mem_total × max_commit_ratio` (above 1 overcommits: limits are
 * ceilings, and live admission keeps new work off a machine short of memory).
 * Live figures only veto a machine:
 * MemAvailable below `min_free_memory`, or load1 per core above
 * `max_load_per_core`. Booking keeps the choice stable when slots sit idle and
 * do not yet use their limit.
 *
 * Candidates are ranked by usable room (the smaller of booked headroom and live
 * MemAvailable above the floor, so other workloads on a shared node count) as a
 * share of capacity, then by absolute usable room, then local first. A node must also pass `preflightNode`; one that
 * fails is skipped and the next candidate is tried. Placements still in flight
 * are booked in memory so two concurrent creates do not both take the last room.
 *
 * Off by default (`cluster.auto_placement.enabled`). A request may still ask
 * for `placement: "auto"` or pin `placement: "local"`.
 */

import fs from 'node:fs'
import os from 'node:os'
import { memoryMiB, slotMemory } from '../vm/machine-spec.mjs'

export const LOCAL_PLACEMENT = 'local'

export const AUTO_PLACEMENT_DEFAULTS = Object.freeze({
  enabled: false,
  include_local: true,
  nodes: null,
  exclude_nodes: [],
  max_commit_ratio: 0.85,
  min_free_memory: '2g',
  max_load_per_core: 0.8,
  slot_reserve_memory: null,
  on_full: 'local',
})

/** Booked limits may reach up to 3× RAM (overcommit); live vetoes still apply. */
export const MAX_COMMIT_RATIO_LIMIT = 3

const ratioIn = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v > lo && v <= hi
const memOk = (v) => typeof v === 'string' && memoryMiB(v) > 0
const idList = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x || '').trim()).filter(Boolean))] : null)

export function normalizeAutoPlacement(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const d = AUTO_PLACEMENT_DEFAULTS
  return {
    enabled: src.enabled === true,
    include_local: src.include_local !== false,
    nodes: idList(src.nodes),
    exclude_nodes: idList(src.exclude_nodes) || [],
    max_commit_ratio: ratioIn(src.max_commit_ratio, 0, MAX_COMMIT_RATIO_LIMIT)
      ? src.max_commit_ratio
      : d.max_commit_ratio,
    min_free_memory: memOk(src.min_free_memory) ? src.min_free_memory.trim().toLowerCase() : d.min_free_memory,
    max_load_per_core: ratioIn(src.max_load_per_core, 0, 64) ? src.max_load_per_core : d.max_load_per_core,
    slot_reserve_memory: memOk(src.slot_reserve_memory) ? src.slot_reserve_memory.trim().toLowerCase() : null,
    on_full: src.on_full === 'reject' ? 'reject' : 'local',
  }
}

/**
 * Where a create request wants the slot: an explicit node id, 'local', or
 * 'auto'. `placement` in the body overrides the configured default; a
 * `node_id` always wins.
 */
export function requestedPlacement(body, policy) {
  if (body?.node_id) return { mode: 'node', nodeId: String(body.node_id) }
  const asked = typeof body?.placement === 'string' ? body.placement.trim().toLowerCase() : ''
  if (asked === LOCAL_PLACEMENT) return { mode: LOCAL_PLACEMENT }
  if (asked === 'auto' || (!asked && policy.enabled)) return { mode: 'auto' }
  return { mode: LOCAL_PLACEMENT }
}

/** MiB one slot books on its machine. */
export function bookedMiB(vm, routing, policy) {
  const limit = memoryMiB(slotMemory(vm, routing))
  const reserve = policy.slot_reserve_memory ? memoryMiB(policy.slot_reserve_memory) : 0
  return Math.max(limit, reserve)
}

/** Booked MiB per machine key ('local' or node id). */
export function bookedByMachine(vms, routing, policy) {
  const out = new Map()
  for (const vm of vms || []) {
    const key = vm?.node_id ? String(vm.node_id) : LOCAL_PLACEMENT
    out.set(key, (out.get(key) || 0) + bookedMiB(vm, routing, policy))
  }
  return out
}

/** This host, read the way the node probe reads a node (MemAvailable, not MemFree). */
export function readLocalHost({ meminfo = '/proc/meminfo' } = {}) {
  let memTotal = os.totalmem()
  let memAvailable = os.freemem()
  try {
    const text = fs.readFileSync(meminfo, 'utf8')
    const kib = (key) => {
      const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)
      return m ? Number(m[1]) * 1024 : null
    }
    memTotal = kib('MemTotal') ?? memTotal
    memAvailable = kib('MemAvailable') ?? memAvailable
  } catch {}
  return {
    cpu_count: os.cpus()?.length || 1,
    load1: os.loadavg()[0],
    mem_total: memTotal,
    mem_used: Math.max(0, memTotal - memAvailable),
  }
}

/**
 * Machines a new slot may go to, with the facts ranking needs. Nodes need a
 * ready link, Linux, working Docker and a fresh host probe.
 */
export function placementCandidates({ nodes = [], localHost = null, policy }) {
  const out = []
  if (policy.include_local && localHost) out.push({ id: LOCAL_PLACEMENT, local: true, host: localHost })
  const allow = policy.nodes ? new Set(policy.nodes) : null
  const deny = new Set(policy.exclude_nodes)
  for (const node of nodes) {
    if (!node?.id || deny.has(node.id) || (allow && !allow.has(node.id))) continue
    const skip = nodeSkipReason(node)
    out.push(skip ? { id: node.id, local: false, skip } : { id: node.id, local: false, host: node.health.host })
  }
  return out
}

function nodeSkipReason(node) {
  if (node.link?.state !== 'ready') return 'link_not_ready'
  if (node.platform && node.platform !== 'linux') return 'not_linux'
  if (!node.health?.docker?.ok) return 'docker_unavailable'
  if (!node.health?.host?.mem_total) return 'no_host_facts'
  return null
}

const MiB = 1024 * 1024

/**
 * Score every candidate for a slot booking `needMiB`. Pure: the caller passes
 * booked memory (placed slots + in-flight placements).
 */
export function rankPlacement({ candidates, booked, needMiB, policy }) {
  const minFree = memoryMiB(policy.min_free_memory)
  const rows = candidates.map((c) => {
    if (c.skip) return { id: c.id, local: c.local, eligible: false, reason: c.skip }
    const totalMiB = Math.floor(c.host.mem_total / MiB)
    const availMiB = Math.floor(Math.max(0, c.host.mem_total - (c.host.mem_used || 0)) / MiB)
    const capacityMiB = Math.floor(totalMiB * policy.max_commit_ratio)
    const bookedMiB = booked.get(c.id) || 0
    const headroomMiB = capacityMiB - bookedMiB
    const loadPerCore = c.host.cpu_count > 0 ? (c.host.load1 || 0) / c.host.cpu_count : 0
    const row = {
      id: c.id,
      local: c.local,
      capacity_mib: capacityMiB,
      booked_mib: bookedMiB,
      headroom_mib: headroomMiB,
      available_mib: availMiB,
      load_per_core: Math.round(loadPerCore * 100) / 100,
      eligible: true,
      reason: null,
    }
    if (headroomMiB < needMiB) Object.assign(row, { eligible: false, reason: 'memory_booked' })
    else if (availMiB - needMiB < minFree) Object.assign(row, { eligible: false, reason: 'memory_available' })
    else if (loadPerCore > policy.max_load_per_core) Object.assign(row, { eligible: false, reason: 'cpu_load' })
    // A shared node also runs workloads that book nothing here: what is really
    // left is the smaller of booked headroom and live MemAvailable.
    row.usable_mib = Math.min(headroomMiB, availMiB - minFree)
    row.score = capacityMiB > 0 ? (row.usable_mib - needMiB) / capacityMiB : -1
    return row
  })
  const order = rows
    .filter((r) => r.eligible)
    .sort((a, b) => b.score - a.score || b.usable_mib - a.usable_mib || Number(b.local) - Number(a.local))
  return { rows, order }
}

/**
 * In-flight bookings, so concurrent creates see each other's choice before the
 * slot record is written. `release` runs once the record is on disk; a hold a
 * failed request never released lapses after `ttlMs`.
 */
export function createPlacementLedger({ ttlMs = 120_000, now = Date.now } = {}) {
  const pending = new Map()
  return {
    snapshot() {
      const out = new Map()
      const t = now()
      for (const [token, { machine, mib, until }] of pending) {
        if (until <= t) pending.delete(token)
        else out.set(machine, (out.get(machine) || 0) + mib)
      }
      return out
    },
    hold(machine, mib) {
      const token = Symbol(machine)
      pending.set(token, { machine, mib, until: now() + ttlMs })
      return () => pending.delete(token)
    },
  }
}

const sharedLedger = createPlacementLedger()

/**
 * Choose where a new slot goes. Returns
 *   { node_id: string|null, release(), report }
 * or { error: { status, code, message, report } } when every machine is full
 * and `on_full` is 'reject'.
 */
export async function pickPlacement({ vm, vms, routing, policy, nodes, localHost, preflight, ledger = sharedLedger }) {
  const needMiB = bookedMiB(vm, routing, policy)
  const booked = bookedByMachine(vms, routing, policy)
  for (const [machine, mib] of ledger.snapshot()) booked.set(machine, (booked.get(machine) || 0) + mib)
  const candidates = placementCandidates({ nodes, localHost, policy })
  const { rows, order } = rankPlacement({ candidates, booked, needMiB, policy })
  const report = { mode: 'auto', need_mib: needMiB, candidates: rows, chosen: null, fallback: false }
  for (const row of order) {
    if (!row.local) {
      let checked
      try {
        checked = await preflight(row.id)
      } catch (err) {
        checked = { ok: false, checks: [{ id: 'preflight', ok: false, message: String(err?.message || err) }] }
      }
      if (!checked?.ok) {
        Object.assign(row, { eligible: false, reason: 'preflight_failed', checks: checked?.checks || [] })
        continue
      }
    }
    report.chosen = row.id
    return { node_id: row.local ? null : row.id, release: ledger.hold(row.id, needMiB), report }
  }
  if (policy.on_full === 'reject') {
    return {
      error: {
        status: 409,
        code: 'placement_no_capacity',
        message: '没有内存或负载余量足够的机器可放新槽位',
        report,
      },
    }
  }
  report.chosen = LOCAL_PLACEMENT
  report.fallback = true
  return { node_id: null, release: ledger.hold(LOCAL_PLACEMENT, needMiB), report }
}
