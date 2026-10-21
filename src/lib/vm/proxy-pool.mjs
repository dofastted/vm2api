/**
 * SOCKS5 Proxy Pool (PostgreSQL-backed)
 * - Bulk import
 * - 1 proxy ↔ up to N VMs (`config.bind_limit`, default 5)
 * - Auto-assign a proxy with remaining capacity on VM create
 * - Health probe every 5/10/30/60 min
 * - On failure: disable proxy + disable bound VM scheduling
 *
 * Persistence: `proxies` table + `settings.proxy_pool_config`.
 * PostgreSQL is authoritative; synchronous accessors expose an explicit runtime cache.
 */
import { EventEmitter } from 'node:events'
import net from 'node:net'
import crypto from 'node:crypto'
import { resolveStoreDb, withTransaction, getActivityCoordinator } from '../db/database.mjs'
import { ProxiesRepo, PROXY_COLUMNS, PROXY_HEALTH_COLUMNS } from '../db/repos/proxies-repo.mjs'
import { ExecutionAdmissionsRepo } from '../db/repos/execution-admissions-repo.mjs'
import { isKubernetesMode } from '../core/control-plane-mode.mjs'
import { currentVmOperationIds } from './shared-vm-operations.mjs'
import { physicalVmAliases } from './vm-physical-target.mjs'
import { canBindProxyToVm, normalizeOwnerId, proxyOwnerId, vmOwnerId } from '../admin/resource-owner.mjs'
import { validTimezone } from '../core/timezone.mjs'
import { lookupProxyGeo, lookupProxyGeoV6 } from './proxy-geo.mjs'
import {
  DNS_PRIMARY_AUTO,
  DNS_UPSTREAMS,
  LOCAL_EGRESS_ID,
  isLocalEgressId,
  isLocalEgressProxy,
  localEgressIdForNode,
  localEgressNodeId,
  validDnsPrimary,
} from './egress.mjs'
import { normalizeSocksHost, socksEndpoint, socksProxyUrl, socksProxyFamily } from './socks-address.mjs'
import { proxyBlockedReason } from './proxy-policy.mjs'
import { canRevealClusterNodes, annotatePublicLocalProxy } from './local-proxy-nodes.mjs'

export const MAX_VMS_PER_PROXY = 5
export const BIND_LIMIT_MIN = 1
export const BIND_LIMIT_MAX = 32
export const PROXY_LABEL_MAX = 64

const DEFAULT_CONFIG = {
  probe_interval_min: 10, // 5 | 10 | 30 | 60
  probe_timeout_ms: 8000,
  max_failures: 2, // consecutive failures before disable
  enabled: true,
  disconnect_on_error: false, // experimental: stop slot + tear SOCKS on runtime errors
  geo_timeout_ms: 8000,
  // Bind a proxy -> the slot adopts that exit node's timezone unless the
  // operator pinned one by hand (vm.timezone_source === 'manual').
  follow_proxy_timezone: true,
  bind_limit: MAX_VMS_PER_PROXY,
  // Transparent-egress DNS tried first; the other built-ins remain as fallback.
  dns_primary: DNS_PRIMARY_AUTO,
  dns_disable_svcb_https: false,
  ipv6_enabled: false,
}

export function clampBindLimit(value, fallback = MAX_VMS_PER_PROXY) {
  const n = Number(value)
  if (!Number.isInteger(n)) return fallback
  return Math.min(BIND_LIMIT_MAX, Math.max(BIND_LIMIT_MIN, n))
}

export function parseBoundVmIds(value) {
  if (Array.isArray(value)) return normalizeVmIds(value)
  if (value && typeof value === 'object' && Array.isArray(value.ids)) return normalizeVmIds(value.ids)
  if (value == null || value === '') return []
  const raw = String(value).trim()
  if (!raw) return []
  if (raw.startsWith('[')) {
    try {
      return normalizeVmIds(JSON.parse(raw))
    } catch {
      return []
    }
  }
  if (raw.includes(',')) return normalizeVmIds(raw.split(','))
  return normalizeVmIds([raw])
}

export function encodeBoundVmIds(ids) {
  const next = parseBoundVmIds(ids)
  if (!next.length) return null
  if (next.length === 1) return next[0]
  return JSON.stringify(next)
}

function normalizeVmIds(list, limit = BIND_LIMIT_MAX) {
  const out = []
  const seen = new Set()
  const cap = clampBindLimit(limit, BIND_LIMIT_MAX)
  for (const item of list || []) {
    const id = String(item || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= cap) break
  }
  return out
}

export function boundVmIdsOf(proxy) {
  if (!proxy) return []
  if (Array.isArray(proxy.bound_vm_ids) && proxy.bound_vm_ids.length) {
    return parseBoundVmIds(proxy.bound_vm_ids)
  }
  return parseBoundVmIds(proxy.bound_vm_id)
}

export function proxyHasVm(proxy, vmId) {
  if (!proxy || !vmId) return false
  return boundVmIdsOf(proxy).includes(String(vmId))
}

/**
 * Flat `geo_*` columns -> one nested object, or null when the row was never
 * resolved. A failed lookup still returns an object (carrying `error`) so the
 * panel can tell "detection failed" from "not detected yet".
 */
export function proxyGeoOf(proxy) {
  if (!proxy) return null
  if (!proxy.geo_checked_at && !proxy.geo_ip && !proxy.geo_error) return null
  return {
    ip: proxy.geo_ip || null,
    country: proxy.geo_country || null,
    country_code: proxy.geo_country_code || null,
    region: proxy.geo_region || null,
    city: proxy.geo_city || null,
    isp: proxy.geo_isp || null,
    timezone: proxy.geo_timezone || null,
    checked_at: proxy.geo_checked_at || null,
    error: proxy.geo_error || null,
  }
}

export function proxyGeoV6Of(proxy) {
  if (!proxy) return null
  if (!proxy.geo_v6_checked_at && !proxy.geo_v6_ip && !proxy.geo_v6_error) return null
  return {
    ip: proxy.geo_v6_ip || null,
    country: proxy.geo_v6_country || null,
    country_code: proxy.geo_v6_country_code || null,
    region: proxy.geo_v6_region || null,
    city: proxy.geo_v6_city || null,
    isp: proxy.geo_v6_isp || null,
    timezone: proxy.geo_v6_timezone || null,
    checked_at: proxy.geo_v6_checked_at || null,
    error: proxy.geo_v6_error || null,
  }
}

function setBoundVmIds(proxy, ids) {
  const next = parseBoundVmIds(ids)
  proxy.bound_vm_ids = next
  proxy.bound_vm_id = next[0] || null
  return next
}

function hydrateProxy(proxy) {
  if (!proxy) return proxy
  const ids = parseBoundVmIds(proxy.bound_vm_ids?.length ? proxy.bound_vm_ids : proxy.bound_vm_id)
  return {
    ...proxy,
    host: normalizeSocksHost(proxy.host) || proxy.host,
    bound_vm_ids: ids,
    bound_vm_id: ids[0] || null,
  }
}

function uid(prefix = 'px') {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`
}

function isSocksPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

function looksLikeHost(value) {
  const host = String(value || '').trim()
  if (!host || /^\d+$/.test(host)) return false
  return true
}

function localEgressRecord(nodeId = null) {
  return {
    id: localEgressIdForNode(nodeId),
    scheme: 'local',
    kind: 'local',
    host: 'local',
    port: 0,
    username: null,
    password: null,
    raw: 'local',
    enabled: true,
    status: 'ok',
    bound_vm_ids: [],
    created_at: new Date().toISOString(),
  }
}

function socks5Record({ host, port, username = null, password = null, raw = '' }) {
  host = normalizeSocksHost(host)
  if (!looksLikeHost(host) || !isSocksPort(port)) return null
  const user = username == null || username === '' ? null : String(username)
  const pass = user == null ? null : password == null ? '' : String(password)
  return {
    scheme: 'socks5',
    host: String(host).trim(),
    port: Number(port),
    username: user,
    password: pass,
    raw: String(raw || socksEndpoint(host, port)),
  }
}

/** Structured host / port / username / password import. */
export function parseSocks5Fields(fields = {}) {
  return socks5Record({
    host: fields.host,
    port: fields.port,
    username: fields.username ?? fields.user,
    password: fields.password ?? fields.pass,
    raw: fields.raw,
  })
}

/** Parse line forms:
 *  socks5://user:pass@host:port
 *  socks5h://user:pass@host:port
 *  user:pass@host:port
 *  host:port
 *  host:port:user:pass
 *  user:pass:host:port
 */
export function parseSocks5Line(line) {
  let raw = String(line || '').trim()
  if (!raw || raw.startsWith('#')) return null
  raw = raw.replace(/^['"]|['"]$/g, '').trim()
  try {
    if (/^socks5h?:\/\//i.test(raw)) {
      const u = new URL(raw.replace(/^socks5h:\/\//i, 'socks5://'))
      return socks5Record({
        host: u.hostname,
        port: u.port || 1080,
        username: u.username ? decodeURIComponent(u.username) : null,
        password: u.password ? decodeURIComponent(u.password) : null,
        raw,
      })
    }
    const at = raw.lastIndexOf('@')
    if (at > 0) {
      const cred = raw.slice(0, at)
      const hostPort = raw.slice(at + 1)
      const match = hostPort.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/)
      if (match) {
        const [, host, port] = match
        const colon = cred.indexOf(':')
        return socks5Record({
          host,
          port,
          username: colon >= 0 ? cred.slice(0, colon) : cred,
          password: colon >= 0 ? cred.slice(colon + 1) : '',
          raw,
        })
      }
      return null
    }
    if (raw.includes('[') || raw.includes(']')) {
      const match = raw.match(/^\[([^\]]+)\]:(\d+)(?::([^:]*)(?::(.*))?)?$/)
      if (!match || !net.isIPv6(match[1])) return null
      return socks5Record({ host: match[1], port: match[2], username: match[3], password: match[4], raw })
    }
    // A colon-delimited IPv6 endpoint has no unambiguous port boundary.
    if (net.isIPv6(raw) || net.isIPv6(raw.slice(0, raw.lastIndexOf(':')))) return null
    const parts = raw.split(':')
    if (parts.length === 2) {
      return socks5Record({ host: parts[0], port: parts[1], raw })
    }
    if (parts.length === 3 && looksLikeHost(parts[0]) && isSocksPort(parts[1])) {
      return socks5Record({ host: parts[0], port: parts[1], username: parts[2], password: '', raw })
    }
    if (parts.length >= 4 && looksLikeHost(parts[0]) && isSocksPort(parts[1])) {
      return socks5Record({
        host: parts[0],
        port: parts[1],
        username: parts[2],
        password: parts.slice(3).join(':'),
        raw,
      })
    }
    if (parts.length >= 4 && isSocksPort(parts[parts.length - 1]) && looksLikeHost(parts[parts.length - 2])) {
      return socks5Record({
        host: parts[parts.length - 2],
        port: parts[parts.length - 1],
        username: parts[0],
        password: parts.slice(1, parts.length - 2).join(':'),
        raw,
      })
    }
  } catch {
    return null
  }
  return null
}

/** Emits 'change' whenever proxy health or bindings may have moved (panel live stream). */
export class ProxyPool extends EventEmitter {
  constructor({
    dataDir,
    db,
    onDisableVm,
    onDisconnectVm,
    onEnableVm,
    egressCheck,
    repairEgress,
    geoLookup,
    geoV6Lookup,
    vmNodeOf,
    localExitUrl,
    localExitHealth,
  } = {}) {
    super()
    // One listener per open panel stream.
    this.setMaxListeners(100)
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new ProxiesRepo(this.db)
    this.onDisableVm = onDisableVm // (vmId, reason, proxyId) => void
    this.onDisconnectVm = onDisconnectVm // (vmId, reason, proxyId) => void — experimental tear-down
    this.onEnableVm = onEnableVm // (vmId, reason, proxyId) => void
    this.egressCheck = egressCheck
    this.repairEgress = repairEgress
    // Injectable so geo detection is testable without leaving the machine.
    this.geoLookup = geoLookup || lookupProxyGeo
    this.geoV6Lookup = geoV6Lookup || lookupProxyGeoV6
    // Per-node local egress: which node a slot runs on, and how to reach / check that node's own route.
    this.vmNodeOf = vmNodeOf // (vmId) => nodeId | null
    this.localExitUrl = localExitUrl // (nodeId) => SOCKS url through the node
    this.localExitHealth = localExitHealth // (nodeId) => { ok, latency_ms, error }
    this.state = { config: { ...DEFAULT_CONFIG }, proxies: [] }
    this._timer = null
    this._probing = false
    this._probeSockets = new Map()
    // Node exits are not pool rows: px-local's geo is the control plane's, a node slot leaves elsewhere.
    this._exitGeo = new Map()
    this._operations = new Set()
    this._cacheVersion = 0
    this._refreshIssued = 0
    this._refreshPublished = 0
    this.db.pendingWriteQueues ||= new Set()
    this.db.pendingWriteQueues.add(this)
  }

  _emitChange() {
    if (!this._mutation) this.emit('change')
  }

  _publish(snapshot) {
    const previous = new Map(this.state.proxies.map((proxy) => [proxy.id, proxy]))
    const proxies = snapshot.proxies.map((record) => {
      const proxy = hydrateProxy(record)
      const existing = previous.get(proxy.id)
      return existing ? Object.assign(existing, proxy) : proxy
    })
    this.state = { config: { ...DEFAULT_CONFIG, ...snapshot.config }, proxies }
    this._savedState = structuredClone(this.state)
  }

  /** Refresh committed PostgreSQL state without waiting for network probes. */
  async refresh() {
    const issued = ++this._refreshIssued
    const version = this._cacheVersion
    const snapshot = await this.repo.snapshot()
    if (issued > this._refreshPublished && version === this._cacheVersion) {
      this._refreshPublished = issued
      this._publish(snapshot)
    }
    return this
  }

  async load() {
    await this.flush()
    return this.refresh()
  }

  async init() {
    return this.load()
  }
  async reload() {
    return this.load()
  }

  async rebind(db) {
    await this.flush()
    this.db.pendingWriteQueues?.delete(this)
    this.db = db
    this.repo = new ProxiesRepo(db)
    db.pendingWriteQueues ||= new Set()
    db.pendingWriteQueues.add(this)
    return this.load()
  }

  async flush() {
    while (this._probing) await new Promise((resolve) => setTimeout(resolve, 10))
    while (this._operations.size) await Promise.all([...this._operations])
  }

  _track(operation) {
    this._operations.add(operation)
    operation.finally(() => this._operations.delete(operation)).catch(() => {})
    return operation
  }

  _stored(proxy) {
    return { ...proxy, protocol: proxy.protocol ?? proxy.scheme, bound_vm_id: encodeBoundVmIds(boundVmIdsOf(proxy)) }
  }

  _changes(before, after, columns = PROXY_COLUMNS) {
    return Object.fromEntries(
      columns
        .filter(
          (column) =>
            column !== 'id' && JSON.stringify(before[column] ?? null) !== JSON.stringify(after[column] ?? null),
        )
        .map((column) => [column, after[column] ?? null]),
    )
  }

  /** Each control mutation starts from PG and writes only its changed rows/fields. */
  _mutate(change, { observation = false } = {}) {
    const operation = withTransaction(this.db, async () => {
      await this.repo.lockMutations()
      const snapshot = await this.repo.snapshot()
      const working = { config: { ...DEFAULT_CONFIG, ...snapshot.config }, proxies: snapshot.proxies.map(hydrateProxy) }
      const before = structuredClone(working)
      const cached = this.state
      const context = { callbacks: [], restartScheduler: false }
      let result
      this.state = working
      this._mutation = context
      try {
        result = change()
      } finally {
        this.state = cached
        this._mutation = null
      }
      if (result?.ok === false) return result
      if (!observation && isKubernetesMode()) await this._assertVmMutationClaims(before, working)
      const previous = new Map(before.proxies.map((proxy) => [proxy.id, proxy]))
      for (const proxy of working.proxies) {
        const old = previous.get(proxy.id)
        let row
        if (!old) row = await this.repo.insert(this._stored(proxy))
        else {
          const patch = this._changes(this._stored(old), this._stored(proxy))
          if (Object.keys(patch).length) row = await this.repo.patchConfig(proxy.id, patch)
        }
        if (row) Object.assign(proxy, hydrateProxy(row))
        previous.delete(proxy.id)
      }
      for (const id of previous.keys()) await this.repo.remove(id)
      const configPatch = this._changes(before.config, working.config, Object.keys(DEFAULT_CONFIG))
      if (Object.keys(configPatch).length) {
        working.config = { ...DEFAULT_CONFIG, ...(await this.repo.patchPoolConfig(configPatch)) }
      }
      this.db.afterCommit(() => {
        this._cacheVersion++
        this._publish(working)
        for (const callback of context.callbacks) callback()
        this._emitChange()
        if (context.restartScheduler) this.restartScheduler()
      })
      return result
    })
    return this._track(operation)
  }

  async _assertVmMutationClaims(before, after) {
    const configChanged =
      Object.keys(this._changes(before.config, after.config, Object.keys(DEFAULT_CONFIG))).length > 0
    const previous = new Map(before.proxies.map((proxy) => [proxy.id, proxy]))
    const next = new Map(after.proxies.map((proxy) => [proxy.id, proxy]))
    const involved = new Set()
    const required = new Set()
    for (const id of new Set([...previous.keys(), ...next.keys()])) {
      const old = previous.get(id)
      const updated = next.get(id)
      const patch = old && updated ? this._changes(this._stored(old), this._stored(updated)) : null
      if (!configChanged && old && updated && !Object.keys(patch).length) continue
      const oldIds = boundVmIdsOf(old)
      const newIds = boundVmIdsOf(updated)
      for (const vmId of [...oldIds, ...newIds]) involved.add(vmId)
      // A binding-only change owns its added/removed targets. Configuration and
      // deletion affect every existing member of the shared proxy.
      const bindingOnly =
        !configChanged &&
        old &&
        updated &&
        Object.keys(patch).every((key) => ['bound_vm_id', 'updated_at'].includes(key))
      for (const vmId of [...oldIds, ...newIds]) {
        if (!bindingOnly || oldIds.includes(vmId) !== newIds.includes(vmId)) required.add(vmId)
      }
    }
    if (!involved.size) return
    // Serialize these checks with acquisition of each logical/physical VM claim.
    await new ExecutionAdmissionsRepo(this.db).lockResources({ vmIds: [...involved] })
    const aliases = [...new Set([...involved].flatMap(physicalVmAliases))]
    const rows = await this.db
      .prepare(`SELECT id, vm_id, uncertain_at FROM vm_operations
      WHERE vm_id = ANY($1::text[]) AND released_at IS NULL`)
      .all(aliases)
    const current = currentVmOperationIds(this.db)
    if (rows.some((row) => !current.has(row.id) || row.uncertain_at)) {
      throw Object.assign(new Error('A proxy VM operation is active'), { code: 'vm_operation_active', status: 409 })
    }
    if (
      [...required].some(
        (vmId) => !rows.some((row) => current.has(row.id) && physicalVmAliases(vmId).includes(row.vm_id)),
      )
    ) {
      throw Object.assign(new Error('Current VM operation claims do not cover the proxy binding set'), {
        code: 'vm_mutation_claim_required',
        status: 409,
      })
    }
  }

  /** Compatibility for explicit state edits; production operations use the methods below. */
  save() {
    if (this._mutation) return
    const desired = structuredClone(this.state)
    const baseline = structuredClone(this._savedState || { config: DEFAULT_CONFIG, proxies: [] })
    return this._mutate(() => {
      Object.assign(this.state.config, this._changes(baseline.config, desired.config, Object.keys(DEFAULT_CONFIG)))
      const old = new Map(baseline.proxies.map((proxy) => [proxy.id, proxy]))
      const desiredIds = new Set(desired.proxies.map((proxy) => proxy.id))
      for (const proxy of desired.proxies) {
        const previous = old.get(proxy.id)
        const current = this.state.proxies.find((row) => row.id === proxy.id)
        if (!previous) {
          if (!current) this.state.proxies.push(proxy)
          continue
        }
        if (!current) continue
        const patch = this._changes(this._stored(previous), this._stored(proxy))
        if (Object.keys(patch).length && previous.config_revision !== current.config_revision) {
          throw Object.assign(new Error('proxy changed'), { code: 'proxy_changed' })
        }
        Object.assign(current, patch)
        if (Object.hasOwn(patch, 'bound_vm_id')) setBoundVmIds(current, patch.bound_vm_id)
      }
      this.state.proxies = this.state.proxies.filter((proxy) => !old.has(proxy.id) || desiredIds.has(proxy.id))
      return { ok: true }
    })
  }

  async ensureLocal(...args) {
    return this._mutate(() => this._ensureLocal(...args))
  }
  async ensureLocalForNode(...args) {
    return this._mutate(() => this._ensureLocalForNode(...args))
  }
  async syncLocalNodes(...args) {
    return this._mutate(() => this._syncLocalNodes(...args))
  }
  async resolveLocalTarget(...args) {
    return this._mutate(() => this._resolveLocalTarget(...args))
  }
  async adoptNodeLocalBindings(...args) {
    return this._mutate(() => this._collectNodeLocalBindings(...args))
  }
  async ensureSocks(...args) {
    return this._mutate(() => this._ensureSocks(...args))
  }
  async importLines(...args) {
    return this._mutate(() => this._importLines(...args))
  }
  async importParsed(...args) {
    return this._mutate(() => this._importParsed(...args))
  }
  async ensureBoundToVm(...args) {
    return this._mutate(() => this._ensureBoundToVm(...args))
  }
  async allocateForVm(...args) {
    return this._mutate(() => this._allocateForVm(...args))
  }
  async bind(...args) {
    return this._mutate(() => this._bind(...args))
  }
  async unbind(...args) {
    return this._mutate(() => this._unbind(...args))
  }
  async unbindVm(...args) {
    return this._mutate(() => this._unbindVm(...args))
  }
  async setEnabled(...args) {
    return this._mutate(() => this._setEnabled(...args))
  }
  async remove(...args) {
    return this._mutate(() => this._remove(...args))
  }
  async update(...args) {
    return this._mutate(() => this._update(...args))
  }
  async updateConfig(...args) {
    return this._mutate(() => this._updateConfig(...args))
  }
  async reportRuntimeFailure(...args) {
    return this._mutate(() => this._reportRuntimeFailure(...args), { observation: true })
  }

  /**
   * Live health per bound VM for the panel stream: what a VM row shows next to
   * its SOCKS5 chip, refreshed on every probe instead of the list poll.
   */
  liveStatusByVm() {
    const out = {}
    for (const p of this.state.proxies) {
      const view = {
        id: p.id,
        status: p.status ?? null,
        enabled: p.enabled ?? null,
        blocked_reason: proxyBlockedReason(p, this.state.config.ipv6_enabled) || null,
        latency_ms: p.latency_ms ?? null,
        last_error: p.last_error || null,
        last_probe_at: p.last_probe_at || null,
      }
      for (const vmId of boundVmIdsOf(p)) out[vmId] = view
    }
    return out
  }

  bindLimit() {
    return clampBindLimit(this.state.config?.bind_limit, MAX_VMS_PER_PROXY)
  }

  snapshot({ ownerUserId = undefined } = {}) {
    const limit = this.bindLimit()
    const owner = ownerUserId === undefined ? undefined : normalizeOwnerId(ownerUserId)
    const proxies =
      ownerUserId === undefined ? this.state.proxies : this.state.proxies.filter((p) => proxyOwnerId(p) === owner)
    const available = proxies.filter((p) => !proxyBlockedReason(p, this.state.config.ipv6_enabled))
    const unused = available.filter((p) => p.enabled && boundVmIdsOf(p).length === 0 && p.status !== 'dead').length
    const open = available.filter((p) => p.enabled && p.status !== 'dead' && boundVmIdsOf(p).length < limit).length
    const bound = proxies.filter((p) => boundVmIdsOf(p).length > 0).length
    const dead = proxies.filter((p) => !p.enabled || p.status === 'dead').length
    const ok = available.filter((p) => p.enabled && p.status === 'ok').length
    const slotsUsed = proxies.reduce((n, p) => n + boundVmIdsOf(p).length, 0)
    return {
      config: { ...this.state.config, bind_limit: limit },
      totals: {
        total: proxies.length,
        free: unused,
        open,
        bound,
        ok,
        dead,
        blocked: proxies.length - available.length,
        probing: this._probing,
        slots_used: slotsUsed,
        slots_cap: proxies.length * limit,
        bind_limit: limit,
      },
      proxies: proxies.map((p) => this.publicProxy(p)),
    }
  }

  /**
   * Panel-facing snapshot. Quota is still the shared px-local row; this only
   * attaches per-node bound groups for admin and redacts node names / other
   * tenants' VM ids for `user`.
   */
  panelSnapshot({ role = 'admin', ownerUserId = undefined, vms = [], nodes = [] } = {}) {
    const reveal = canRevealClusterNodes(role)
    const owner = role === 'user' ? normalizeOwnerId(ownerUserId) : undefined
    const snap = this.snapshot({ ownerUserId: owner ? ownerUserId : undefined })
    const vmList = Array.isArray(vms) ? vms : []
    const nodeList = Array.isArray(nodes) ? nodes : []
    const ownerVmIds = owner ? new Set(vmList.filter((vm) => vmOwnerId(vm) === owner).map((vm) => String(vm.id))) : null
    if (owner) {
      const shown = new Set(snap.proxies.map((p) => p.id))
      const locals = this.state.proxies.filter(
        (p) => isLocalEgressProxy(p) && !shown.has(p.id) && boundVmIdsOf(p).some((id) => ownerVmIds.has(String(id))),
      )
      snap.proxies.unshift(...locals.map((p) => this.publicProxy(p)))
    }
    snap.proxies = snap.proxies
      .map((p) => annotatePublicLocalProxy(p, { reveal, nodes: nodeList, ownerVmIds }))
      .filter(Boolean)
    return snap
  }

  publicProxy(p) {
    const ids = boundVmIdsOf(p)
    const limit = this.bindLimit()
    const blocked = proxyBlockedReason(p, this.state.config.ipv6_enabled)
    return {
      id: p.id,
      host: p.host,
      port: p.port,
      label: p.label || null,
      has_auth: !!(p.username || p.password),
      status: p.status, // unknown | ok | fail | dead
      enabled: p.enabled,
      blocked_reason: blocked,
      address_family: socksProxyFamily(p) || null,
      owner_user_id: proxyOwnerId(p),
      bound_vm_id: ids[0] || null,
      bound_vm_ids: ids,
      bound_count: ids.length,
      bind_limit: limit,
      consecutive_failures: p.consecutive_failures || 0,
      latency_ms: p.latency_ms ?? null,
      last_probe_at: p.last_probe_at || null,
      last_error: p.last_error || null,
      created_at: p.created_at,
      kind: isLocalEgressProxy(p) ? 'local' : 'socks5',
      node_id: isLocalEgressProxy(p) ? localEgressNodeId(p.id) : undefined,
      scheme: isLocalEgressProxy(p) ? 'local' : p.scheme || 'socks5',
      domain_forward: !!p.domain_forward,
      geo: proxyGeoOf(p),
      geo_v6: proxyGeoV6Of(p),
    }
  }

  /** The control plane's local row (`px-local`). */
  _ensureLocal() {
    return this._ensureLocalForNode(null)
  }

  /** One local row per VPS: `px-local` for the control plane, `px-local-<nodeId>` per node. */
  _ensureLocalForNode(nodeId = null) {
    const id = localEgressIdForNode(nodeId)
    const existing = this.state.proxies.find((p) => p.id === id)
    if (existing) return { ok: true, created: false, proxy: this.publicProxy(existing) }
    const proxy = localEgressRecord(nodeId)
    const after = this.state.proxies.reduce((at, p, i) => (isLocalEgressProxy(p) ? i + 1 : at), 0)
    this.state.proxies.splice(after, 0, proxy)
    this.save()
    return { ok: true, created: true, proxy: this.publicProxy(proxy) }
  }

  /**
   * Keep node local rows in step with the cluster: a row per node once local
   * egress is in use, and drop rows of removed nodes that hold no slot.
   */
  _syncLocalNodes(nodeIds = []) {
    if (!this.state.proxies.some((p) => p.id === LOCAL_EGRESS_ID)) return { created: [], removed: [] }
    const wanted = new Set(nodeIds.map((id) => localEgressIdForNode(id)).filter((id) => id !== LOCAL_EGRESS_ID))
    const created = []
    for (const id of wanted) {
      if (this.state.proxies.some((p) => p.id === id)) continue
      this._ensureLocalForNode(localEgressNodeId(id))
      created.push(id)
    }
    const removed = this.state.proxies
      .filter((p) => localEgressNodeId(p.id) && !wanted.has(p.id) && !boundVmIdsOf(p).length)
      .map((p) => p.id)
    if (removed.length) {
      this.state.proxies = this.state.proxies.filter((p) => !removed.includes(p.id))
      this.save()
    }
    if (created.length || removed.length) this._emitChange()
    return { created, removed }
  }

  _vmNodeOrUndefined(vmId) {
    try {
      return this.vmNodeOf?.(vmId)
    } catch {
      return undefined
    }
  }

  /** Re-probe one node's local row (its SSH link just changed state). */
  async probeLocalNode(nodeId) {
    await this.refresh()
    const p = this.state.proxies.find((x) => x.id === localEgressIdForNode(nodeId) && localEgressNodeId(x.id))
    // An operator-disabled row stays out of automatic probes, as in probeAll.
    if (!p || !p.enabled) return null
    const observed = structuredClone(p)
    const result = await this.probeOne(observed)
    await this._persistObservation(observed, (current) => this._applyProbeResultInner(current, result))
    return result
  }

  /** The local row a slot must use: its own node's, else the control plane's. */
  localTargetForVm(vmId) {
    return localEgressIdForNode(this._vmNodeOrUndefined(vmId) || null)
  }

  /**
   * Which local row a request for `proxyId` lands on when the slot runs on
   * `nodeId` (null = control plane). The generic px-local resolves to the
   * slot's own VPS; another machine's local row is refused.
   */
  _resolveLocalTarget(proxyId, nodeId) {
    const target = localEgressIdForNode(nodeId || null)
    if (proxyId !== target && proxyId !== LOCAL_EGRESS_ID) {
      return { ok: false, error: 'local_proxy_node_mismatch', expected: target }
    }
    const targetNode = localEgressNodeId(target)
    if (targetNode) this._ensureLocalForNode(targetNode)
    return { ok: true, id: target }
  }

  /**
   * Move slots off a local row that is not their own VPS's (the shared
   * px-local before per-node rows). Returns the moves so the caller can
   * rewrite each slot's recorded proxy.
   */
  _collectNodeLocalBindings() {
    const moves = []
    this._adoptNodeLocalBindings(moves)
    return moves
  }

  _adoptNodeLocalBindings(moves) {
    for (const p of this.state.proxies.filter((x) => isLocalEgressProxy(x))) {
      for (const vmId of boundVmIdsOf(p)) {
        // `undefined` = the slot no longer exists; leave stale ids where they are.
        if (this.vmNodeOf && this._vmNodeOrUndefined(vmId) === undefined) continue
        const target = this.localTargetForVm(vmId)
        if (target === p.id) continue
        const bound = this._bind(target, vmId, { force: true })
        if (bound.ok) moves.push({ vm_id: vmId, from: p.id, to: target })
      }
    }
  }

  _findSocksRow(parsed) {
    const key = (p) => JSON.stringify([p.host, p.port, p.username || '', p.password || ''])
    const wanted = key(parsed)
    return this.state.proxies.find((p) => key(p) === wanted) || null
  }

  /** Public view of the SOCKS row with these credentials, or null. Never creates. */
  findSocks(fields = {}) {
    const parsed = parseSocks5Fields(fields)
    const found = parsed ? this._findSocksRow(parsed) : null
    return found ? this.publicProxy(found) : null
  }

  /**
   * Return the SOCKS row with this host/port/username/password, creating it
   * when absent. Same credentials must not allocate a second id.
   */
  _ensureSocks(fields = {}, { ownerUserId = null, label = null } = {}) {
    const parsed = parseSocks5Fields(fields)
    if (!parsed) return { ok: false, error: 'invalid_proxy' }
    const found = this._findSocksRow(parsed)
    if (found) return { ok: true, created: false, proxy: this._withAuth(found) }
    const imported = this._importParsed([parsed], { ownerUserId })
    const id = imported.items[0]?.id
    const row = this.state.proxies.find((p) => p.id === id)
    if (!row) return { ok: false, error: 'proxy_import_failed' }
    const name = label == null ? '' : String(label).trim().slice(0, 80)
    if (name) {
      row.label = name
      this.save()
    }
    return { ok: true, created: true, proxy: this._withAuth(row) }
  }

  _importLines(text, extra = {}) {
    const parsed = []
    for (const line of String(text || '').split(/\r?\n/)) {
      if (!String(line || '').trim()) continue
      parsed.push(parseSocks5Line(line) || { __invalid: String(line).trim() })
    }
    const fields = extra.fields || extra.proxies || extra.entries || []
    for (const item of Array.isArray(fields) ? fields : [fields]) {
      if (!item || typeof item !== 'object') continue
      parsed.push(parseSocks5Fields(item) || { __invalid: `${item.host || ''}:${item.port || ''}` })
    }
    if (extra.host || extra.port) {
      parsed.push(parseSocks5Fields(extra) || { __invalid: `${extra.host || ''}:${extra.port || ''}` })
    }
    return this._importParsed(parsed, extra)
  }

  _importParsed(records = [], extra = {}) {
    const added = []
    const skipped = []
    // Credentials can select distinct proxies at the same endpoint. Encode a
    // tuple so colons inside credentials cannot collide with field separators.
    const proxyKey = (p) => JSON.stringify([p.host, p.port, p.username || '', p.password || ''])
    const existing = new Set(this.state.proxies.map(proxyKey))
    for (const parsed of records) {
      if (!parsed || parsed.__invalid || !parsed.host || !parsed.port) {
        const label = parsed?.__invalid || ''
        if (label)
          skipped.push({
            line: label,
            reason: 'parse_failed',
            message: 'Invalid SOCKS5 endpoint; IPv6 requires [host]:port or socks5h://[host]:port',
          })
        continue
      }
      const key = proxyKey(parsed)
      if (existing.has(key)) {
        skipped.push({ line: socksEndpoint(parsed.host, parsed.port), reason: 'duplicate' })
        continue
      }
      existing.add(key)
      const proxy = {
        id: uid('px'),
        scheme: 'socks5',
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        password: parsed.password,
        raw: parsed.raw,
        status: 'unknown',
        enabled: true,
        owner_user_id: normalizeOwnerId(extra.ownerUserId || extra.owner_user_id),
        bound_vm_id: null,
        bound_vm_ids: [],
        consecutive_failures: 0,
        latency_ms: null,
        last_probe_at: null,
        last_error: null,
        created_at: new Date().toISOString(),
      }
      this.state.proxies.push(proxy)
      added.push(this.publicProxy(proxy))
    }
    this.save()
    return { added: added.length, skipped: skipped.length, items: added, skip_details: skipped.slice(0, 20) }
  }

  /**
   * Restore pool↔VM binding after start/restart.
   * Prefer an existing bind, then the VM's last proxy id, then a free allocate.
   */
  _ensureBoundToVm(vmId, preferredId = null) {
    if (!vmId) return null
    if (this.state.proxies.some((p) => proxyHasVm(p, vmId) && proxyBlockedReason(p, this.state.config.ipv6_enabled)))
      return null
    const existing = this.getProxyForVm(vmId)
    if (existing) return existing
    if (preferredId) {
      const preferred = this.state.proxies.find((p) => p.id === preferredId)
      if (proxyBlockedReason(preferred, this.state.config.ipv6_enabled)) return null
      const bound = this._bind(preferredId, vmId)
      if (bound.ok) return this.getProxyForVm(vmId)
    }
    return this._allocateForVm(vmId)
  }

  /** Allocate one healthy proxy with remaining capacity and bind to vmId */
  _allocateForVm(vmId, { ownerUserId = null, role = 'admin' } = {}) {
    if (!vmId) return null
    if (this.state.proxies.some((p) => proxyHasVm(p, vmId) && proxyBlockedReason(p, this.state.config.ipv6_enabled)))
      return null
    const existing = this.state.proxies.find(
      (p) => p.enabled && !proxyBlockedReason(p, this.state.config.ipv6_enabled) && proxyHasVm(p, vmId),
    )
    if (existing) return this.publicProxy(existing)

    const limit = this.bindLimit()
    const owner = normalizeOwnerId(ownerUserId)
    const localTarget = this.localTargetForVm(vmId)
    if (localTarget !== LOCAL_EGRESS_ID && this.state.proxies.some((p) => p.id === LOCAL_EGRESS_ID)) {
      this._ensureLocalForNode(localEgressNodeId(localTarget))
    }
    const candidates = this.state.proxies.filter((p) => {
      if (isLocalEgressProxy(p) && p.id !== localTarget) return false
      if (!p.enabled || p.status === 'dead' || p.status === 'fail') return false
      if (proxyBlockedReason(p, this.state.config.ipv6_enabled)) return false
      if (boundVmIdsOf(p).length >= limit) return false
      return proxyOwnerId(p) === owner
    })
    candidates.sort((a, b) => {
      const score = (x) => (x.status === 'ok' ? 0 : x.status === 'unknown' ? 1 : 2)
      if (score(a) !== score(b)) return score(a) - score(b)
      return boundVmIdsOf(a).length - boundVmIdsOf(b).length
    })
    const pick = candidates[0]
    if (!pick) return null
    const bound = this._bind(pick.id, vmId, { role })
    return bound.ok ? bound.proxy : null
  }

  _bind(proxyId, vmId, { force = false } = {}) {
    const vm = String(vmId || '').trim()
    if (isLocalEgressId(proxyId) && vm) {
      // Local egress is the slot's own VPS route: a generic px-local request lands
      // on the slot's node row; another machine's local row is refused.
      const resolved = this._resolveLocalTarget(proxyId, this._vmNodeOrUndefined(vm) || null)
      if (!resolved.ok) return resolved
      proxyId = resolved.id
    }
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    // Migration moves a slot onto its node row even while that row is marked down.
    if (!force && (!p.enabled || p.status === 'dead')) return { ok: false, error: 'proxy_disabled' }
    const blocked = proxyBlockedReason(p, this.state.config.ipv6_enabled)
    if (blocked) return { ok: false, error: blocked }
    if (!vm) return { ok: false, error: 'vm_id_required' }
    for (const x of this.state.proxies) {
      if (x.id === proxyId) continue
      const ids = boundVmIdsOf(x)
      if (ids.includes(vm))
        setBoundVmIds(
          x,
          ids.filter((id) => id !== vm),
        )
    }
    const ids = boundVmIdsOf(p)
    if (ids.includes(vm)) {
      this.save()
      return { ok: true, proxy: this.publicProxy(p) }
    }
    const limit = this.bindLimit()
    if (!force && ids.length >= limit) {
      return { ok: false, error: 'proxy_bind_limit', max: limit, bound_vm_ids: ids }
    }
    setBoundVmIds(p, [...ids, vm])
    this.save()
    return { ok: true, proxy: this.publicProxy(p) }
  }

  _unbind(proxyId, vmId = null) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    const ids = boundVmIdsOf(p)
    const target = vmId == null || vmId === '' ? null : String(vmId).trim()
    const removed = target ? ids.filter((id) => id === target) : ids.slice()
    setBoundVmIds(p, target ? ids.filter((id) => id !== target) : [])
    this.save()
    return { ok: true, proxy: this.publicProxy(p), unbound_vm_ids: removed }
  }

  _unbindVm(vmId) {
    const vm = String(vmId || '').trim()
    if (!vm) return
    for (const p of this.state.proxies) {
      const ids = boundVmIdsOf(p)
      if (ids.includes(vm))
        setBoundVmIds(
          p,
          ids.filter((id) => id !== vm),
        )
    }
    this.save()
  }

  _setEnabled(proxyId, enabled) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    p.enabled = !!enabled
    if (!enabled) {
      p.status = 'dead'
      this._cascadeDisableVm(p, 'proxy_manually_disabled')
    } else {
      p.status = 'unknown'
      p.consecutive_failures = 0
      p.last_error = null
    }
    this.save()
    return { ok: true, proxy: this.publicProxy(p) }
  }

  _remove(proxyId) {
    const idx = this.state.proxies.findIndex((x) => x.id === proxyId)
    if (idx < 0) return { ok: false, error: 'proxy_not_found' }
    const [p] = this.state.proxies.splice(idx, 1)
    this.save()
    return { ok: true, removed: this.publicProxy(p) }
  }

  /**
   * Edit one proxy in place. `label` is display-only: a label-only patch skips
   * endpoint validation and reports `connection_changed: false` so the caller
   * can leave bound workers alone. Only keys present in `patch` are touched, so the
   * caller can clear credentials (`username: ''`) without having to resend host
   * and port. Absent key = leave alone; empty string = clear.
   *
   * The merged record goes through socks5Record() so this shares the exact
   * validation and normalization the import path uses.
   */
  _update(proxyId, patch = {}) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k)
    const connection = ['host', 'port', 'username', 'password'].some(has)
    if (!connection && !has('label') && !has('domain_forward')) {
      return { ok: false, error: 'no_editable_fields' }
    }
    let label = p.label || null
    if (has('label')) {
      if (patch.label != null && typeof patch.label !== 'string') return { ok: false, error: 'invalid_label' }
      label = String(patch.label || '').trim() || null
      if (label && label.length > PROXY_LABEL_MAX) return { ok: false, error: 'label_too_long', max: PROXY_LABEL_MAX }
    }
    let domainForward = !!p.domain_forward
    if (has('domain_forward')) {
      if (typeof patch.domain_forward !== 'boolean') return { ok: false, error: 'invalid_domain_forward' }
      if (patch.domain_forward && isLocalEgressProxy(p)) return { ok: false, error: 'domain_forward_unsupported' }
      domainForward = patch.domain_forward
    }
    const domainChanged = domainForward !== !!p.domain_forward
    if (!connection) {
      p.label = label
      p.domain_forward = domainForward
      this.save()
      return { ok: true, proxy: this.publicProxy(p), connection_changed: false, domain_forward_changed: domainChanged }
    }
    const username = has('username') ? patch.username : p.username
    // SOCKS5 has no password-only auth: socks5Record() drops the password
    // whenever the username is empty. Setting one without the other would
    // therefore report ok while storing nothing — reject instead of no-op'ing.
    if (has('password') && patch.password !== '' && (username == null || username === '')) {
      return { ok: false, error: 'password_without_username' }
    }
    const next = socks5Record({
      host: has('host') ? patch.host : p.host,
      port: has('port') ? patch.port : p.port,
      username,
      // Clearing the username drops the password with it — socks5Record()
      // nulls the password whenever the username is empty, so mirror that here
      // rather than carrying over a password that can no longer be sent.
      password: has('password') ? patch.password : username ? p.password : null,
    })
    if (!next) return { ok: false, error: 'invalid_proxy' }
    p.host = next.host
    p.port = next.port
    p.username = next.username
    p.password = next.password
    // Imported rows keep the original line in `raw`, which for a
    // socks5://user:pass@host form means a plaintext password sitting in the
    // store. Rewrite it to host:port so editing also cleans that up.
    p.raw = socksEndpoint(next.host, next.port)
    p.label = label
    p.domain_forward = domainForward
    this.save()
    return { ok: true, proxy: this.publicProxy(p), connection_changed: true, domain_forward_changed: domainChanged }
  }

  _updateConfig(patch = {}) {
    const allowed = [5, 10, 30, 60]
    if (Object.hasOwn(patch, 'dns_disable_svcb_https') && typeof patch.dns_disable_svcb_https !== 'boolean') {
      return { ok: false, error: 'invalid_dns_disable_svcb_https' }
    }
    if (patch.ipv6_enabled != null && typeof patch.ipv6_enabled !== 'boolean') {
      return { ok: false, error: 'invalid_ipv6_enabled' }
    }
    if (patch.dns_primary != null && !validDnsPrimary(patch.dns_primary)) {
      return {
        ok: false,
        error: 'invalid_dns_primary',
        message:
          'dns_primary must be auto, a built-in DNS upstream, or a valid https:// URL with a valid host and port, without userinfo, fragment, whitespace, backslash, or raw comma',
        allowed: [DNS_PRIMARY_AUTO, ...DNS_UPSTREAMS],
      }
    }
    if (patch.dns_primary != null) this.state.config.dns_primary = patch.dns_primary
    if (patch.dns_disable_svcb_https != null) this.state.config.dns_disable_svcb_https = patch.dns_disable_svcb_https
    if (patch.probe_interval_min != null) {
      const n = Number(patch.probe_interval_min)
      if (!allowed.includes(n)) {
        return { ok: false, error: 'invalid_interval', allowed }
      }
      this.state.config.probe_interval_min = n
    }
    if (patch.probe_timeout_ms != null) {
      this.state.config.probe_timeout_ms = Math.max(1000, Number(patch.probe_timeout_ms) || 8000)
    }
    if (patch.geo_timeout_ms != null) {
      this.state.config.geo_timeout_ms = Math.max(1000, Number(patch.geo_timeout_ms) || 8000)
    }
    if (patch.follow_proxy_timezone != null) {
      this.state.config.follow_proxy_timezone = !!patch.follow_proxy_timezone
    }
    if (patch.max_failures != null) {
      this.state.config.max_failures = Math.max(1, Number(patch.max_failures) || 2)
    }
    if (patch.enabled != null) this.state.config.enabled = !!patch.enabled
    if (patch.disconnect_on_error != null) this.state.config.disconnect_on_error = !!patch.disconnect_on_error
    if (patch.bind_limit != null) {
      const n = Number(patch.bind_limit)
      if (!Number.isInteger(n) || n < BIND_LIMIT_MIN || n > BIND_LIMIT_MAX) {
        return { ok: false, error: 'invalid_bind_limit', min: BIND_LIMIT_MIN, max: BIND_LIMIT_MAX }
      }
      this.state.config.bind_limit = n
    }
    if (patch.ipv6_enabled != null) this.state.config.ipv6_enabled = patch.ipv6_enabled
    this.save()
    if (patch.ipv6_enabled === false) {
      this._mutation.callbacks.push(() => {
        for (const [socket, proxy] of this._probeSockets) {
          if (socksProxyFamily(proxy) === 6) socket.destroy()
        }
      })
    }
    this.restartScheduler()
    return { ok: true, config: this.state.config }
  }

  disconnectOnErrorEnabled() {
    return !!this.state.config.disconnect_on_error
  }

  /**
   * Runtime SOCKS5 failure from a live request.
   * When disconnect_on_error is off this is a no-op (existing cooldown/failover stays).
   */
  _reportRuntimeFailure(vmId, error = 'runtime_socks_failure') {
    if (!this.disconnectOnErrorEnabled()) {
      return { ok: true, skipped: true, reason: 'disconnect_on_error_disabled' }
    }
    if (!vmId) return { ok: false, error: 'vm_id_required' }
    const p = this.state.proxies.find((x) => proxyHasVm(x, vmId))
    if (!p) return { ok: false, error: 'no_bound_proxy' }
    const blocked = proxyBlockedReason(p, this.state.config.ipv6_enabled)
    if (blocked) return { ok: true, skipped: true, reason: blocked }
    this._applyProbeResult(
      p,
      {
        ok: false,
        latency_ms: p.latency_ms ?? null,
        error: String(error || 'runtime_socks_failure'),
      },
      { cascade: false },
    )
    this._cascadeDisconnectVm(p, `proxy_disconnect:${p.last_error || error}`)
    this.save()
    return { ok: true, skipped: false, proxy: this.publicProxy(p) }
  }

  _cascadeDisconnectVm(proxy, reason) {
    if (this._mutation) {
      const committed = structuredClone(proxy)
      this._mutation.callbacks.push(() => this._cascadeDisconnectVm(committed, reason))
      return
    }
    const cb = this.onDisconnectVm || this.onDisableVm
    if (typeof cb !== 'function') return
    for (const vmId of boundVmIdsOf(proxy)) {
      try {
        cb(vmId, reason, proxy.id)
      } catch {
        /* ignore */
      }
    }
  }

  _cascadeDisableVm(proxy, reason) {
    if (this._mutation) {
      const committed = structuredClone(proxy)
      this._mutation.callbacks.push(() => this._cascadeDisableVm(committed, reason))
      return
    }
    if (typeof this.onDisableVm !== 'function') return
    for (const vmId of boundVmIdsOf(proxy)) {
      try {
        this.onDisableVm(vmId, reason, proxy.id)
      } catch {
        /* ignore */
      }
    }
  }

  _cascadeEnableVm(proxy, reason) {
    if (this._mutation) {
      const committed = structuredClone(proxy)
      this._mutation.callbacks.push(() => this._cascadeEnableVm(committed, reason))
      return
    }
    if (typeof this.onEnableVm !== 'function') return
    for (const vmId of boundVmIdsOf(proxy)) {
      try {
        this.onEnableVm(vmId, reason, proxy.id)
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * TCP connect probe to host:port (SOCKS5 handshake optional lightweight).
   * Full SOCKS5 auth handshake is best-effort.
   */
  async probeOne(proxy) {
    const blocked = proxyBlockedReason(proxy, this.state.config.ipv6_enabled)
    if (blocked) return { ok: false, scope: 'policy', error: blocked, latency_ms: null }
    if (isLocalEgressProxy(proxy)) {
      const nodeId = localEgressNodeId(proxy.id)
      // Control plane: host default route. A down kin-egress is not "no proxy".
      if (!nodeId || typeof this.localExitHealth !== 'function') {
        return { ok: true, scope: 'local', mode: 'direct', latency_ms: 0 }
      }
      // A node row is as reachable as the node's own link.
      try {
        const h = (await this.localExitHealth(nodeId)) || {}
        // Link still coming up: no verdict yet, keep the row as it was.
        if (h.pending) return { ok: false, scope: 'pending', error: h.error || 'node_link_pending', latency_ms: null }
        return h.ok
          ? { ok: true, scope: 'node', mode: 'direct', latency_ms: h.latency_ms ?? null }
          : { ok: false, scope: 'node', error: h.error || 'node_unreachable', latency_ms: null }
      } catch (err) {
        return { ok: false, scope: 'node', error: String(err?.message || err), latency_ms: null }
      }
    }
    const socks = await this._probeSocks(proxy)
    if (socks.scope === 'policy') return socks
    if (!socks.ok) return { ...socks, scope: 'socks' }
    if (typeof this.egressCheck !== 'function') return { ...socks, scope: 'socks' }
    let eg = this.egressCheck(proxy)
    if (!eg?.ok && typeof this.repairEgress === 'function') {
      const current = await this.repo.getById(proxy.id)
      if (!current || current.config_revision !== proxy.config_revision) {
        return { ok: false, scope: 'pending', error: 'proxy_changed', latency_ms: socks.latency_ms }
      }
      try {
        await this.repairEgress(proxy)
      } catch {
        /* keep egress failure */
      }
      eg = this.egressCheck(proxy)
    }
    if (eg?.ok) return { ...socks, scope: 'socks' }
    return {
      ok: false,
      scope: 'egress',
      socks_ok: true,
      latency_ms: socks.latency_ms,
      error: eg?.reason || 'egress_down',
    }
  }

  async _probeSocks(proxy) {
    const blocked = proxyBlockedReason(proxy, this.state.config.ipv6_enabled)
    if (blocked) return { ok: false, scope: 'policy', error: blocked, latency_ms: null }
    const host = normalizeSocksHost(proxy.host)
    if (!host) return { ok: false, error: 'invalid_proxy_host', latency_ms: null }
    const timeout = this.state.config.probe_timeout_ms || 8000
    const started = Date.now()
    return new Promise((resolve) => {
      const socket = net.connect({ host, port: proxy.port })
      this._probeSockets.set(socket, proxy)
      let done = false
      let connected = false
      const finish = (ok, error) => {
        if (done) return
        done = true
        this._probeSockets.delete(socket)
        try {
          socket.destroy()
        } catch {
          /* */
        }
        const reason = proxyBlockedReason(proxy, this.state.config.ipv6_enabled)
        if (reason) {
          resolve({ ok: false, scope: 'policy', error: reason, latency_ms: null })
          return
        }
        resolve({
          ok,
          latency_ms: Date.now() - started,
          error: error || null,
        })
      }
      socket.setTimeout(timeout)
      socket.on('connect', () => {
        connected = true
        // Offer no-auth and user/pass so a working endpoint is not 0xff-killed.
        socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]))
      })
      socket.on('data', (data) => {
        if (data.length >= 2 && data[0] === 0x05) {
          if (data[1] === 0x00 || data[1] === 0x02) {
            finish(true, null)
            return
          }
          if (data[1] === 0xff) {
            finish(true, null)
            return
          }
        }
        finish(true, null)
      })
      socket.on('timeout', () => finish(connected, connected ? null : 'timeout'))
      socket.on('error', (e) => {
        if (connected) finish(true, null)
        else finish(false, String(e.message || e))
      })
      socket.on('close', () => {
        if (!done) finish(connected, connected ? null : 'connection_closed')
      })
    })
  }

  async probeById(proxyId) {
    await this.refresh()
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    const observed = structuredClone(p)
    const result = await this.probeOne(observed)
    const current = await this._persistObservation(observed, (row) => this._applyProbeResultInner(row, result))
    return { ok: true, proxy: this.publicProxy(current || p), probe: result, ...(current ? {} : { stale: true }) }
  }

  async probeAll({ onlyEnabled = true } = {}) {
    if (this._probing) return { ok: false, error: 'probe_in_progress' }
    this._probing = true
    const results = []
    try {
      await this.refresh()
      const list = this.state.proxies.filter((p) => {
        if (proxyBlockedReason(p, this.state.config.ipv6_enabled)) return false
        if (!onlyEnabled) return true
        if (p.enabled) return true
        return p.status === 'fail' || (p.status === 'dead' && p.last_error)
      })
      for (const p of list) {
        const observed = structuredClone(p)
        const result = await this.probeOne(observed)
        const current = await this._persistObservation(observed, (row) => this._applyProbeResultInner(row, result))
        results.push({
          id: p.id,
          ...result,
          status: current?.status ?? p.status,
          enabled: current?.enabled ?? p.enabled,
          ...(current ? {} : { stale: true }),
        })
      }
      return { ok: true, total: results.length, results }
    } finally {
      this._probing = false
    }
  }

  /** Config switch for "a freshly bound slot adopts its proxy's timezone". */
  followProxyTimezoneEnabled() {
    return this.state.config?.follow_proxy_timezone !== false
  }

  /**
   * Resolve one proxy's exit-node location through the proxy itself.
   * `force` re-queries a row that already has a location; without it a cached
   * hit is returned untouched so bind-time detection stays cheap.
   */
  async detectGeo(proxyId, { force = false } = {}) {
    await this.refresh()
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    const observed = structuredClone(p)
    const blocked = proxyBlockedReason(p, this.state.config.ipv6_enabled)
    if (blocked) return { ok: false, error: blocked, proxy: this.publicProxy(p) }
    const v4Cached = !force && p.geo_checked_at && p.geo_ip
    const v6Cached = !force && p.geo_v6_checked_at
    if (v4Cached && v6Cached) {
      return {
        ok: true,
        cached: true,
        proxy: this.publicProxy(p),
        geo: proxyGeoOf(p),
        geo_v6: proxyGeoV6Of(p),
      }
    }
    // Control-plane local egress has no SOCKS URL: the lookup leaves over the
    // host default route. A node row looks up through that node's own route.
    let url = this._withAuth(p).url
    const nodeId = isLocalEgressProxy(p) ? localEgressNodeId(p.id) : null
    if (isLocalEgressProxy(p)) url = ''
    if (nodeId) {
      if (typeof this.localExitUrl !== 'function') return { ok: false, error: 'node_egress_unavailable' }
      try {
        url = await this.localExitUrl(nodeId)
      } catch (err) {
        return { ok: false, error: err?.code || 'node_egress_unavailable', proxy: this.publicProxy(p) }
      }
    }
    const timeoutMs = this.state.config?.geo_timeout_ms
    let v4Result = v4Cached ? { ok: true } : await this.geoLookup(url, { timeoutMs })
    let v6Result = v6Cached ? { ok: true } : await this.geoV6Lookup(url, { timeoutMs })
    const current = await this._persistObservation(observed, (row) => {
      if (!v4Cached) this._applyGeoResult(row, v4Result)
      if (!v6Cached) this._applyGeoV6Result(row, v6Result)
    })
    if (!current) return { ok: false, error: 'proxy_changed', stale: true }
    const pub = this.publicProxy(current)
    if (!v4Result?.ok) {
      return {
        ok: false,
        error: v4Result?.error || 'geo_lookup_failed',
        proxy: pub,
        geo: proxyGeoOf(current),
        geo_v6: proxyGeoV6Of(current),
      }
    }
    return {
      ok: true,
      cached: v4Cached && v6Cached,
      proxy: pub,
      geo: proxyGeoOf(current),
      geo_v6: proxyGeoV6Of(current),
    }
  }

  async detectGeoAll({ onlyEnabled = true, force = false } = {}) {
    await this.refresh()
    const list = this.state.proxies.filter((p) => (onlyEnabled ? p.enabled : true))
    const results = []
    for (const p of list) {
      const result = await this.detectGeo(p.id, { force })
      results.push({
        id: p.id,
        ok: !!result.ok,
        cached: !!result.cached,
        error: result.ok ? null : result.error || null,
        geo: result.geo ?? null,
        geo_v6: result.geo_v6 ?? null,
      })
    }
    return { ok: true, total: results.length, results }
  }

  _applyGeoResult(p, result) {
    p.geo_checked_at = new Date().toISOString()
    if (!result?.ok) {
      // Keep the previous location: a transient lookup failure should not blank
      // out a known exit node the slot timezone may already follow.
      p.geo_error = String(result?.error || 'geo_lookup_failed').slice(0, 200)
      return
    }
    const geo = result.geo || {}
    p.geo_error = null
    p.geo_ip = geo.ip || null
    p.geo_country = geo.country || null
    p.geo_country_code = geo.country_code || null
    p.geo_region = geo.region || null
    p.geo_city = geo.city || null
    p.geo_isp = geo.isp || null
    p.geo_timezone = validTimezone(geo.timezone) || null
  }

  _applyGeoV6Result(p, result) {
    p.geo_v6_checked_at = new Date().toISOString()
    if (!result?.ok) {
      p.geo_v6_error = String(result?.error || 'geo_ipv6_lookup_failed').slice(0, 200)
      return
    }
    const geo = result.geo || {}
    p.geo_v6_error = null
    p.geo_v6_ip = geo.ip || null
    p.geo_v6_country = geo.country || null
    p.geo_v6_country_code = geo.country_code || null
    p.geo_v6_region = geo.region || null
    p.geo_v6_city = geo.city || null
    p.geo_v6_isp = geo.isp || null
    p.geo_v6_timezone = validTimezone(geo.timezone) || null
  }

  /**
   * Location of an exit that is not a pool row (a node slot on local egress,
   * looked up through that node's forwarder). Cached per key for the process;
   * failures are not cached so the next bind retries.
   */
  async exitGeo(key, url, { detect = true, force = false } = {}) {
    const hit = this._exitGeo.get(key)
    if (hit && !force) return { ok: true, cached: true, geo: hit }
    if (!detect) return { ok: false, error: 'exit_geo_unknown' }
    const result = await this.geoLookup(url, { timeoutMs: this.state.config?.geo_timeout_ms })
    if (!result?.ok) return { ok: false, error: result?.error || 'geo_lookup_failed' }
    const geo = result.geo || {}
    this._exitGeo.set(key, geo)
    return { ok: true, cached: false, geo }
  }

  /** Detected IANA zone of one proxy, '' when unknown. */
  proxyTimezone(proxyId) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    return p ? validTimezone(p.geo_timezone) : ''
  }

  /** Detected IANA zone of whatever proxy currently serves this VM, '' when unknown. */
  timezoneForVm(vmId) {
    const p = this.state.proxies.find((x) => proxyHasVm(x, vmId))
    return p ? validTimezone(p.geo_timezone) : ''
  }

  _applyProbeResultInner(p, result, { cascade = true } = {}) {
    // Disabled by policy is not a failed probe and must not damage health/history.
    if (result.scope === 'policy' || proxyBlockedReason(p, this.state.config.ipv6_enabled)) return
    if (result.scope === 'pending') return
    p.last_probe_at = new Date().toISOString()
    p.latency_ms = result.latency_ms
    // Node rows are only ever disabled by an operator; a link result must not undo that.
    if (result.scope === 'node' && !p.enabled) return
    if (result.scope === 'node' && !result.ok) {
      // The cluster link owns node health; a node hiccup must not disable the row or park its slots.
      p.status = 'fail'
      p.last_error = result.error || 'node_unreachable'
      return
    }
    if (result.scope === 'egress') {
      p.last_error = `egress_down:${result.error || 'down'}`
      if (p.enabled) p.status = 'ok'
      if (cascade) this._cascadeDisableVm(p, p.last_error)
      return
    }
    if (result.ok) {
      const resume =
        /egress_down|proxy_probe_failed/.test(String(p.last_error || '')) ||
        p.status === 'fail' ||
        (p.status === 'dead' && !!p.last_error)
      p.status = 'ok'
      p.consecutive_failures = 0
      p.last_error = null
      if (resume && !p.enabled) p.enabled = true
      if (cascade && resume) this._cascadeEnableVm(p, 'proxy_recovered')
      return
    }
    p.consecutive_failures = (p.consecutive_failures || 0) + 1
    p.last_error = result.error || 'probe_failed'
    p.status = 'fail'
    const maxFail = this.state.config.max_failures || 2
    if (p.consecutive_failures >= maxFail) {
      p.enabled = false
      p.status = 'dead'
      if (cascade) this._cascadeDisableVm(p, `proxy_probe_failed:${p.last_error}`)
    }
  }

  _applyProbeResult(p, result, opts = {}) {
    this._applyProbeResultInner(p, result, opts)
    this._emitChange()
  }

  async _persistObservation(observed, apply) {
    const operation = withTransaction(this.db, async () => {
      await this.repo.lockMutations()
      const row = await this.repo.getById(observed.id, { forUpdate: true })
      if (!row || row.config_revision !== observed.config_revision) return null
      const current = hydrateProxy(row)
      const before = this._stored(current)
      const cached = this.state
      const context = { callbacks: [] }
      this.state = { config: { ...DEFAULT_CONFIG, ...(await this.repo.getConfig({})) }, proxies: [current] }
      this._mutation = context
      try {
        apply(current)
      } finally {
        this.state = cached
        this._mutation = null
      }
      const patch = this._changes(before, this._stored(current), PROXY_HEALTH_COLUMNS)
      const stored = await this.repo.patchHealth(current.id, patch, observed.config_revision)
      if (!stored) return null
      const fresh = hydrateProxy(stored)
      this.db.afterCommit(() => {
        this._cacheVersion++
        const previous = this.state.proxies.find((proxy) => proxy.id === fresh.id)
        if (previous) Object.assign(previous, fresh)
        else this.state.proxies.push(fresh)
        this._savedState = structuredClone(this.state)
        for (const callback of context.callbacks) callback()
        this._emitChange()
      })
      return fresh
    })
    return this._track(operation)
  }

  startScheduler() {
    this.stopScheduler()
    if (!this.state.config.enabled) return
    const min = this.state.config.probe_interval_min || 10
    const ms = min * 60 * 1000
    const run = () => {
      const coordinator = getActivityCoordinator(this.db)
      const pending = coordinator
        ? coordinator.runActivity({ kind: 'proxy_probe' }, async () => ({
            ended: true,
            value: await this.probeAll({ onlyEnabled: true }),
          }))
        : this.probeAll({ onlyEnabled: true })
      return this._track(pending).catch(() => {})
    }
    void run()
    this._timer = setInterval(run, ms)
    this._timer.unref?.()
  }

  stopScheduler() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  restartScheduler() {
    if (this._mutation) {
      this._mutation.restartScheduler = true
      return
    }
    this.startScheduler()
  }

  /** For upstream: get socks URL for a VM */
  getProxyForVm(vmId) {
    const p = this.state.proxies.find(
      (x) =>
        proxyHasVm(x, vmId) &&
        x.enabled &&
        x.status !== 'dead' &&
        !proxyBlockedReason(x, this.state.config.ipv6_enabled),
    )
    if (!p) return null
    return this._withAuth(p)
  }

  /**
   * Look one up by id, credentials included, WITHOUT the enabled/status filter
   * getProxyForVm() applies — an operator editing or copying a proxy needs it to
   * work on the disabled and dead ones too, which are exactly the rows they are
   * most likely to be fixing.
   *
   * The `WithAuth` suffix is deliberate: the return value carries a plaintext
   * password, so it must never be handed to a panel response untouched. Only
   * `POST /api/panel/proxies/:id/reveal` may surface it, and only as a URI.
   */
  /** Display name only — safe for panel responses, unlike getProxyByIdWithAuth(). */
  labelOf(proxyId) {
    return this.state.proxies.find((x) => x.id === proxyId)?.label || null
  }

  getProxyByIdWithAuth(proxyId) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return null
    return this._withAuth(p)
  }

  _withAuth(p) {
    if (isLocalEgressProxy(p)) {
      return {
        id: p.id || LOCAL_EGRESS_ID,
        url: '',
        host: 'local',
        port: 0,
        scheme: 'local',
        kind: 'local',
        username: null,
        password: null,
      }
    }
    return {
      id: p.id,
      url: socksProxyUrl(p, 'socks5'),
      host: p.host,
      port: p.port,
      username: p.username || null,
      password: p.password == null ? null : p.password,
    }
  }
}
