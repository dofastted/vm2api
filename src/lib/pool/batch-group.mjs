/**
 * Elastic affinity groups for sessionless batch traffic.
 *
 * A request with no caller session / device id has no conversation to stick
 * to, so every call is placed from scratch and one workload fans out over the
 * whole pool. A group is keyed by (API key, workload id): the workload id is
 * the hash of the cached system prompt, or an explicit per-user id when the
 * caller supplies one. Each group is a list of numbered members; member i is
 * its own sticky key and its own seat, so the scheduler binds it to one
 * account and the seat book cannot collapse the group onto one VM.
 *
 * acquire() hands out the lowest-numbered member that still has room and
 * opens the next number when all are full (grow). Members that stay idle past
 * `idle_ttl_s` are dropped and unbound (shrink). `max = 0` means no ceiling.
 * With a ceiling and every member full the least loaded member takes the
 * request, so the group never leaks to the rest of the pool.
 *
 * Group state is in memory; the account binding of each member is the ordinary
 * sticky row, so a restart only forgets the counters.
 */

export const BATCH_MEMBER_MARK = ':bg:'

export const DEFAULT_BATCH_GROUP = Object.freeze({
  enabled: false,
  enabled_for_all: false,
  keys: [],
  min: 1,
  max: 0,
  per_member_concurrency: 3,
  idle_ttl_s: 900,
  observe: false,
})

function posInt(value, fallback, { min = 0 } = {}) {
  const n = Number(value)
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback
}

export function mergeBatchGroupConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const d = DEFAULT_BATCH_GROUP
  return {
    enabled: src.enabled === true,
    enabled_for_all: src.enabled_for_all === true,
    keys: Array.isArray(src.keys) ? src.keys.map(String).filter(Boolean) : [],
    min: posInt(src.min, d.min, { min: 1 }) || 1,
    max: posInt(src.max, d.max),
    per_member_concurrency: posInt(src.per_member_concurrency, d.per_member_concurrency, { min: 1 }) || 1,
    idle_ttl_s: posInt(src.idle_ttl_s, d.idle_ttl_s, { min: 1 }) || d.idle_ttl_s,
    // observe: compute and report the member, but leave routing untouched.
    observe: src.observe === true,
  }
}

export function batchGroupAppliesToKey(cfg, keyId) {
  if (!cfg?.enabled) return false
  if (cfg.enabled_for_all) return true
  const id = String(keyId ?? '')
  return !!id && cfg.keys.includes(id)
}

export class BatchGroups {
  /**
   * @param {{ now?: () => number, onExpire?: (memberKey: string) => void }} [opts]
   */
  constructor({ now = Date.now, onExpire = null } = {}) {
    this.now = now
    this.onExpire = onExpire
    /** @type {Map<string, Map<number, { inflight: number, lastUsed: number, served: number }>>} */
    this.groups = new Map()
    this.counters = { grown: 0, shrunk: 0, queued: 0 }
  }

  static memberKey(groupKey, index) {
    return `${groupKey}#${index}`
  }

  _members(groupKey) {
    let members = this.groups.get(groupKey)
    if (!members) {
      members = new Map()
      this.groups.set(groupKey, members)
    }
    return members
  }

  /** Drop idle members above `min`; returns the dropped member keys. */
  sweep(groupKey, cfg) {
    const members = this.groups.get(groupKey)
    if (!members) return []
    const cutoff = this.now() - cfg.idle_ttl_s * 1000
    const dropped = []
    for (const [index, member] of members) {
      if (index < cfg.min) continue
      if (member.inflight > 0 || member.lastUsed > cutoff) continue
      members.delete(index)
      dropped.push(BatchGroups.memberKey(groupKey, index))
    }
    if (!members.size) this.groups.delete(groupKey)
    for (const key of dropped) {
      this.counters.shrunk++
      try {
        this.onExpire?.(key)
      } catch {}
    }
    return dropped
  }

  /**
   * Pick (or open) a member for one request.
   * @returns {{ index: number, memberKey: string, size: number, grew: boolean, queued: boolean, release: () => void }}
   */
  acquire(groupKey, cfg) {
    this.sweep(groupKey, cfg)
    const members = this._members(groupKey)
    const cap = cfg.per_member_concurrency
    let index = -1
    let grew = false
    let queued = false
    for (let i = 0; ; i++) {
      if (cfg.max > 0 && i >= cfg.max) {
        // Ceiling reached with every member full: queue on the least loaded.
        let best = 0
        let bestLoad = Infinity
        for (const [idx, m] of members) {
          if (m.inflight < bestLoad) {
            best = idx
            bestLoad = m.inflight
          }
        }
        index = best
        queued = true
        this.counters.queued++
        break
      }
      const m = members.get(i)
      if (!m) {
        members.set(i, { inflight: 0, lastUsed: this.now(), served: 0 })
        index = i
        grew = i >= cfg.min
        if (grew) this.counters.grown++
        break
      }
      if (m.inflight < cap) {
        index = i
        break
      }
    }
    const member = members.get(index)
    member.inflight++
    member.served++
    member.lastUsed = this.now()
    let released = false
    return {
      index,
      memberKey: BatchGroups.memberKey(groupKey, index),
      size: members.size,
      grew,
      queued,
      release: () => {
        if (released) return
        released = true
        member.inflight = Math.max(0, member.inflight - 1)
        member.lastUsed = this.now()
      },
    }
  }

  snapshot() {
    const groups = []
    for (const [groupKey, members] of this.groups) {
      groups.push({
        groupKey,
        size: members.size,
        inflight: [...members.values()].reduce((sum, m) => sum + m.inflight, 0),
        members: [...members.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([index, m]) => ({ index, inflight: m.inflight, served: m.served, lastUsed: m.lastUsed })),
      })
    }
    return { groups, counters: { ...this.counters } }
  }
}

/**
 * Group key for a request, or null when it does not qualify. The caller has
 * already ruled out session / device / probe traffic.
 * @param {{ keyId: string|number, seatKey: string|null, workloadId?: string }} args
 */
export function batchGroupKey({ keyId, seatKey, workloadId = '' }) {
  const id = String(keyId ?? '')
  if (!id) return null
  const explicit = String(workloadId || '').trim()
  if (explicit) return `k${id}${BATCH_MEMBER_MARK}u:${explicit}`
  const raw = String(seatKey || '')
  const m = /^seat:h:([0-9a-f]{16,})$/.exec(raw)
  if (!m) return null
  return `k${id}${BATCH_MEMBER_MARK}s:${m[1]}`
}

/** Seat key of a member: one seat per member so members land on different VMs. */
export function batchMemberSeatKey(groupKey, index) {
  return `seat:bg:${groupKey}#${index}`
}
