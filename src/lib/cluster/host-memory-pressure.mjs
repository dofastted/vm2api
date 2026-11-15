/**
 * Live memory pressure per machine (this host or a cluster node), for admission.
 *
 * Container memory limits are ceilings, not reservations: a slot uses memory
 * only for the native Claude processes it actually holds. A machine can carry
 * more slot limits than RAM (overcommit) as long as new conversations stop
 * landing on it when its real free memory runs low. The crag kernel never
 * evicts an idle session, but each one ends after `session_idle_ttl_seconds`,
 * so holding back new conversations is enough for usage to come down.
 *
 * Levels, from MemAvailable / MemTotal:
 *   ok        new conversations may land here
 *   tight     < tight_available_ratio: new conversations go elsewhere when any
 *             other machine is ok; continuing ones (sticky) still land here
 *   critical  < critical_available_ratio: no new conversation lands here
 * A level is left only once the ratio is `recover_margin` above its threshold,
 * so a machine at the edge does not flap. A sample older than `stale_ms` counts
 * as ok: an unreadable machine is never blocked on stale data.
 *
 * Samples: this host from /proc/meminfo; cluster nodes from the cluster
 * manager's 30 s health probe (node-host.mjs), which already reads MemTotal and
 * MemAvailable over SSH.
 *
 * Config: routing.host_memory_pressure (all keys optional).
 */
import fs from 'node:fs'
import os from 'node:os'

export const HOST_PRESSURE_OK = 'ok'
export const HOST_PRESSURE_TIGHT = 'tight'
export const HOST_PRESSURE_CRITICAL = 'critical'
export const LOCAL_HOST_KEY = 'local'

export const HOST_MEMORY_PRESSURE_DEFAULTS = Object.freeze({
  enabled: true,
  tight_available_ratio: 0.2,
  critical_available_ratio: 0.1,
  recover_margin: 0.05,
  interval_ms: 15_000,
  stale_ms: 120_000,
})

function ratioIn(value, lo, hi, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback
}

export function normalizeHostMemoryPressure(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const d = HOST_MEMORY_PRESSURE_DEFAULTS
  const critical = ratioIn(src.critical_available_ratio, 0.01, 0.9, d.critical_available_ratio)
  const tight = Math.max(critical, ratioIn(src.tight_available_ratio, 0.01, 0.95, d.tight_available_ratio))
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : d.enabled,
    tight_available_ratio: tight,
    critical_available_ratio: critical,
    recover_margin: ratioIn(src.recover_margin, 0, 0.5, d.recover_margin),
    interval_ms: Math.round(ratioIn(src.interval_ms, 1_000, 600_000, d.interval_ms)),
    stale_ms: Math.round(ratioIn(src.stale_ms, 5_000, 3_600_000, d.stale_ms)),
  }
}

/** Next level from the previous one and the current MemAvailable / MemTotal. */
export function nextPressureLevel(prev, ratio, cfg) {
  const { tight_available_ratio: tight, critical_available_ratio: critical, recover_margin: margin } = cfg
  if (!Number.isFinite(ratio)) return HOST_PRESSURE_OK
  if (ratio < critical) return HOST_PRESSURE_CRITICAL
  if (prev === HOST_PRESSURE_CRITICAL && ratio < critical + margin) return HOST_PRESSURE_CRITICAL
  if (ratio < tight) return HOST_PRESSURE_TIGHT
  if (prev !== HOST_PRESSURE_OK && prev != null && ratio < tight + margin) return HOST_PRESSURE_TIGHT
  return HOST_PRESSURE_OK
}

/** Same key as placement.vmNodeId; kept import-free so schedule-state can use it. */
export function hostKeyOf(vm) {
  return vm?.node_id ? String(vm.node_id) : LOCAL_HOST_KEY
}

/** { total, available } bytes of this machine, or null. */
export function readLocalMemory({ meminfoPath = '/proc/meminfo' } = {}) {
  try {
    const text = fs.readFileSync(meminfoPath, 'utf8')
    const total = Number(/^MemTotal:\s+(\d+)/m.exec(text)?.[1]) * 1024
    const available = Number(/^MemAvailable:\s+(\d+)/m.exec(text)?.[1]) * 1024
    if (total > 0 && available >= 0) return { total, available }
  } catch {}
  const total = os.totalmem()
  return total > 0 ? { total, available: os.freemem() } : null
}

export function createHostMemoryPressure({
  getConfig = () => ({}),
  readLocal = readLocalMemory,
  /** () => node ids to sample. */
  listNodes = () => [],
  /** (id) => { total, available, at } | null, from the node's last health probe. */
  readNode = () => null,
  now = Date.now,
  log = console,
} = {}) {
  const hosts = new Map()
  let timer = null
  let timerMs = 0

  function config() {
    return normalizeHostMemoryPressure(getConfig())
  }

  function sample(key, figures, { at = now(), cfg = config() } = {}) {
    const total = Number(figures?.total)
    const available = Number(figures?.available)
    if (!(total > 0) || !(available >= 0)) return null
    const prev = hosts.get(key)
    const ratio = available / total
    const level = nextPressureLevel(prev?.level ?? HOST_PRESSURE_OK, ratio, cfg)
    const entry = { key, total, available, ratio, level, at: Number(at) || now() }
    hosts.set(key, entry)
    if ((prev?.level ?? HOST_PRESSURE_OK) !== level) {
      const pct = (ratio * 100).toFixed(1)
      try {
        log?.warn?.(
          `[host-memory] ${key} ${prev?.level ?? HOST_PRESSURE_OK} -> ${level} available=${pct}% (${Math.round(available / 1024 ** 2)} MiB of ${Math.round(total / 1024 ** 2)} MiB)`,
        )
      } catch {}
    }
    return entry
  }

  function refresh() {
    const cfg = config()
    if (!cfg.enabled) return { ok: true, skipped: 'disabled' }
    const local = readLocal()
    if (local) sample(LOCAL_HOST_KEY, local, { cfg })
    for (const id of listNodes() || []) {
      const figures = readNode(id)
      if (figures) sample(id, figures, { at: figures.at ?? now(), cfg })
    }
    return { ok: true }
  }

  /** Level of a machine key; disabled, unknown and stale count as ok. */
  function levelOf(key) {
    const cfg = config()
    if (!cfg.enabled) return HOST_PRESSURE_OK
    const entry = hosts.get(key)
    if (!entry || now() - entry.at > cfg.stale_ms) return HOST_PRESSURE_OK
    return entry.level
  }

  function schedule() {
    const ms = config().interval_ms
    if (timer && ms === timerMs) return
    if (timer) clearInterval(timer)
    timerMs = ms
    timer = setInterval(() => {
      try {
        refresh()
        schedule()
      } catch {}
    }, ms)
    timer.unref?.()
  }

  return {
    sample,
    refresh,
    levelOf,
    levelForVm: (vm) => levelOf(hostKeyOf(vm)),
    snapshot: () => [...hosts.values()].map((entry) => ({ ...entry, level: levelOf(entry.key) })),
    start() {
      refresh()
      schedule()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

let active = null

/** Installed by the server; schedulers read levels through hostMemoryLevelForVm(). */
export function installHostMemoryPressure(instance) {
  active = instance || null
  return active
}

export function hostMemoryLevelForVm(vm) {
  return active ? active.levelForVm(vm) : HOST_PRESSURE_OK
}
