/**
 * SOCKS5 Proxy Pool (SQLite-backed)
 * - Bulk import
 * - 1 proxy ↔ up to N VMs (`config.bind_limit`, default 5)
 * - Auto-assign a proxy with remaining capacity on VM create
 * - Health probe every 5/10/30/60 min
 * - On failure: disable proxy + disable bound VM scheduling
 *
 * Persistence: `proxies` table + `settings.proxy_pool_config`.
 * Working set stays in memory (probe loop mutates it); save() writes through.
 */
import net from 'node:net'
import crypto from 'node:crypto'
import { resolveStoreDb } from '../db/database.mjs'
import { ProxiesRepo } from '../db/repos/proxies-repo.mjs'
import { canBindProxyToVm, normalizeOwnerId, proxyOwnerId } from '../admin/resource-owner.mjs'
import { validTimezone } from '../core/timezone.mjs'
import { lookupProxyGeo, lookupProxyGeoV6 } from './proxy-geo.mjs'
import { DNS_PRIMARY_AUTO, DNS_UPSTREAMS, LOCAL_EGRESS_ID, isLocalEgressProxy, validDnsPrimary } from './egress.mjs'
import { normalizeSocksHost, socksEndpoint, socksProxyUrl, socksProxyFamily } from './socks-address.mjs'
import { proxyBlockedReason } from './proxy-policy.mjs'

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

function normalizeVmIds(list) {
  const out = []
  const seen = new Set()
  for (const item of list || []) {
    const id = String(item || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
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

function localEgressRecord() {
  return {
    id: LOCAL_EGRESS_ID,
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

export class ProxyPool {
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
    listVms = () => [],
    listNodes = () => [],
    getVmNodeId,
    nodeExitProxyUrl,
  } = {}) {
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
    this.listVms = listVms
    this.listNodes = listNodes
    this.getVmNodeId = getVmNodeId
    this.nodeExitProxyUrl = nodeExitProxyUrl
    this.state = { config: { ...DEFAULT_CONFIG }, proxies: [] }
    this._timer = null
    this._probing = false
    this._probeSockets = new Map()
    // Node exits are not pool rows: px-local's geo is the control plane's, a node slot leaves elsewhere.
    this._exitGeo = new Map()
    this._nodeProbes = new Map()
    this.load()
  }

  /** Re-read working set from DB (startup + post-restore). */
  load() {
    try {
      this.state.config = { ...DEFAULT_CONFIG, ...(this.repo.getConfig({}) || {}) }
      this.state.proxies = this.repo.loadAll().map(hydrateProxy)
    } catch {
      this.state = { config: { ...DEFAULT_CONFIG }, proxies: [] }
    }
  }

  reload() {
    this.load()
  }

  /** Re-bind to a fresh DB connection (after backup restore) and re-read. */
  rebind(db) {
    this.db = db
    this.repo = new ProxiesRepo(db)
    this.load()
  }

  save() {
    this.repo.setConfig(this.state.config)
    this.repo.replaceAll(
      this.state.proxies.map((p) => ({
        ...p,
        bound_vm_id: encodeBoundVmIds(boundVmIdsOf(p)),
      })),
    )
  }

  bindLimit() {
    return clampBindLimit(this.state.config?.bind_limit, MAX_VMS_PER_PROXY)
  }

  /** Placement stays on the VM; px-local remains the persisted/runtime proxy id. */
  nodeIdForVm(vmId) {
    if (typeof this.getVmNodeId === 'function') return this.getVmNodeId(vmId) || null
    return this.listVms().find((vm) => vm.id === vmId)?.node_id || null
  }

  _scopeContext() {
    return {
      vmNodes: new Map(this.listVms().map((vm) => [vm.id, vm.node_id || null])),
      nodes: this.listNodes(),
    }
  }

  boundIdsForNode(proxy, nodeId, context = this._scopeContext()) {
    // Historical/orphaned bindings remain visible on the control plane until reconciled.
    return boundVmIdsOf(proxy).filter((id) => (context.vmNodes.get(id) || null) === (nodeId || null))
  }

  localExitViews(proxy, context = this._scopeContext()) {
    const nodes = new Set(context.nodes.map((node) => node.id).filter(Boolean))
    for (const id of boundVmIdsOf(proxy)) {
      const nodeId = context.vmNodes.get(id)
      if (nodeId) nodes.add(nodeId)
    }
    return [null, ...nodes].map((nodeId) => this.publicProxy(proxy, { nodeId, context }))
  }

  /** Public proxy for a VM's actual exit, useful to all panel/import entry points. */
  proxyForVm(proxyId, vmId) {
    const proxy = this.state.proxies.find((p) => p.id === proxyId)
    if (!proxy) return null
    const context = this._scopeContext()
    return this.publicProxy(proxy, { nodeId: context.vmNodes.get(vmId) || null, context })
  }

  snapshot({ ownerUserId = undefined, nodeId = undefined } = {}) {
    const limit = this.bindLimit()
    const owner = ownerUserId === undefined ? undefined : normalizeOwnerId(ownerUserId)
    const stored =
      ownerUserId === undefined ? this.state.proxies : this.state.proxies.filter((p) => proxyOwnerId(p) === owner)
    const context = this._scopeContext()
    const localExits = stored.filter(isLocalEgressProxy).flatMap((p) => this.localExitViews(p, context))
    const proxies = stored.map((p) => this.publicProxy(p, { nodeId, context }))
    const exits = nodeId === undefined ? [...proxies.filter((p) => !isLocalEgressProxy(p)), ...localExits] : proxies
    const available = exits.filter((p) => !p.blocked_reason)
    const unused = available.filter((p) => p.enabled && boundVmIdsOf(p).length === 0 && p.status !== 'dead').length
    const open = available.filter((p) => p.enabled && p.status !== 'dead' && boundVmIdsOf(p).length < limit).length
    const bound = exits.filter((p) => boundVmIdsOf(p).length > 0).length
    const dead = exits.filter((p) => !p.enabled || p.status === 'dead').length
    const ok = available.filter((p) => p.enabled && p.status === 'ok').length
    const slotsUsed = exits.reduce((n, p) => n + boundVmIdsOf(p).length, 0)
    return {
      config: { ...this.state.config, bind_limit: limit },
      totals: {
        total: exits.length,
        free: unused,
        open,
        bound,
        ok,
        dead,
        blocked: exits.length - available.length,
        probing: this._probing,
        slots_used: slotsUsed,
        slots_cap: exits.length * limit,
        bind_limit: limit,
      },
      proxies,
      local_exits: nodeId === undefined ? localExits : localExits.filter((p) => p.node_id === nodeId),
    }
  }

  publicProxy(p, { nodeId = undefined, context = undefined } = {}) {
    const scoped = isLocalEgressProxy(p) && nodeId !== undefined
    if (scoped && !context) context = this._scopeContext()
    const ids = scoped ? this.boundIdsForNode(p, nodeId, context) : boundVmIdsOf(p)
    const limit = this.bindLimit()
    const blocked = proxyBlockedReason(p, this.state.config.ipv6_enabled)
    const result = {
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
      scheme: isLocalEgressProxy(p) ? 'local' : p.scheme || 'socks5',
      domain_forward: !!p.domain_forward,
      geo: proxyGeoOf(p),
      geo_v6: proxyGeoV6Of(p),
    }
    if (!scoped) return result
    const node = nodeId ? context.nodes.find((item) => item.id === nodeId) : null
    const previousProbe = this._nodeProbes.get(nodeId || null)
    // Startup can precede SSH readiness; an old offline observation is not a failed exit probe.
    const probe = previousProbe?.error === 'node_unavailable' && node?.link?.state === 'ready' ? null : previousProbe
    return {
      ...result,
      view_id: `${p.id}@${nodeId || 'local'}`,
      node_id: nodeId || null,
      node_name: nodeId ? node?.name || nodeId : null,
      ...(nodeId
        ? {
            // A node's SSH endpoint and the control-plane geo are not its observed exit IP.
            label: null,
            status: !p.enabled
              ? 'dead'
              : node?.link?.state !== 'ready'
                ? 'fail'
                : probe?.ok
                  ? 'ok'
                  : probe
                    ? 'fail'
                    : 'unknown',
            blocked_reason: node?.link?.state !== 'ready' ? 'node_unavailable' : blocked,
            latency_ms: probe?.latency_ms ?? null,
            last_probe_at: probe?.checked_at || null,
            last_error: node?.link?.state !== 'ready' ? 'node_unavailable' : probe?.error || null,
            consecutive_failures: 0,
            geo: this._exitGeo.get(`node:${nodeId}`) || null,
            geo_v6: null,
          }
        : probe
          ? {
              status: !p.enabled ? 'dead' : probe.ok ? 'ok' : 'fail',
              latency_ms: probe.latency_ms ?? null,
              last_probe_at: probe.checked_at || null,
              last_error: probe.error || null,
            }
          : {}),
    }
  }

  ensureLocal() {
    const existing = this.state.proxies.find((p) => isLocalEgressProxy(p))
    if (existing) return { ok: true, created: false, proxy: this.publicProxy(existing) }
    const proxy = localEgressRecord()
    this.state.proxies.unshift(proxy)
    this.save()
    return { ok: true, created: true, proxy: this.publicProxy(proxy) }
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
  ensureSocks(fields = {}, { ownerUserId = null, label = null } = {}) {
    const parsed = parseSocks5Fields(fields)
    if (!parsed) return { ok: false, error: 'invalid_proxy' }
    const found = this._findSocksRow(parsed)
    if (found) return { ok: true, created: false, proxy: this._withAuth(found) }
    const imported = this.importParsed([parsed], { ownerUserId })
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

  importLines(text, extra = {}) {
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
    return this.importParsed(parsed, extra)
  }

  importParsed(records = [], extra = {}) {
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
  ensureBoundToVm(vmId, preferredId = null) {
    if (!vmId) return null
    const current = this.state.proxies.find((p) => proxyHasVm(p, vmId))
    const preferred = this.state.proxies.find((p) => p.id === preferredId)
    if (isLocalEgressProxy(current) || isLocalEgressProxy(preferred) || preferredId === LOCAL_EGRESS_ID) {
      const nodeId = this.nodeIdForVm(vmId)
      // An unavailable node cannot change a saved local exit into a different proxy on restart.
      if (nodeId && !this.listNodes().some((node) => node.id === nodeId && node.link?.state === 'ready')) return null
    }
    if (this.state.proxies.some((p) => proxyHasVm(p, vmId) && proxyBlockedReason(p, this.state.config.ipv6_enabled)))
      return null
    const existing = this.getProxyForVm(vmId)
    if (existing) return existing
    if (preferredId) {
      if (proxyBlockedReason(preferred, this.state.config.ipv6_enabled)) return null
      const bound = this.bind(preferredId, vmId)
      if (bound.ok) return this.getProxyForVm(vmId)
    }
    return this.allocateForVm(vmId) ? this.getProxyForVm(vmId) : null
  }

  /** Allocate one healthy proxy with remaining capacity and bind to vmId */
  allocateForVm(vmId, { ownerUserId = null, role = 'admin' } = {}) {
    if (!vmId) return null
    const context = this._scopeContext()
    const nodeId = context.vmNodes.get(vmId) || null
    if (this.state.proxies.some((p) => proxyHasVm(p, vmId) && proxyBlockedReason(p, this.state.config.ipv6_enabled)))
      return null
    const existing = this.state.proxies.find(
      (p) => p.enabled && !proxyBlockedReason(p, this.state.config.ipv6_enabled) && proxyHasVm(p, vmId),
    )
    if (existing) {
      const view = this.publicProxy(existing, { nodeId, context })
      return view.blocked_reason ? null : view
    }

    const limit = this.bindLimit()
    const owner = normalizeOwnerId(ownerUserId)
    const candidates = this.state.proxies.filter((p) => {
      const view = this.publicProxy(p, { nodeId, context })
      if (!view.enabled || view.status === 'dead' || view.status === 'fail') return false
      if (view.blocked_reason) return false
      if (boundVmIdsOf(view).length >= limit) return false
      return proxyOwnerId(p) === owner
    })
    candidates.sort((a, b) => {
      a = this.publicProxy(a, { nodeId, context })
      b = this.publicProxy(b, { nodeId, context })
      const score = (x) => (x.status === 'ok' ? 0 : x.status === 'unknown' ? 1 : 2)
      if (score(a) !== score(b)) return score(a) - score(b)
      return boundVmIdsOf(a).length - boundVmIdsOf(b).length
    })
    const pick = candidates[0]
    if (!pick) return null
    const bound = this.bind(pick.id, vmId, { role })
    return bound.ok ? bound.proxy : null
  }

  bind(proxyId, vmId, { nodeId = undefined } = {}) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    if (!p.enabled || p.status === 'dead') return { ok: false, error: 'proxy_disabled' }
    const blocked = proxyBlockedReason(p, this.state.config.ipv6_enabled)
    if (blocked) return { ok: false, error: blocked }
    const vm = String(vmId || '').trim()
    if (!vm) return { ok: false, error: 'vm_id_required' }
    const context = this._scopeContext()
    const actualNodeId = context.vmNodes.get(vm) || null
    if (isLocalEgressProxy(p) && nodeId !== undefined && nodeId !== actualNodeId) {
      return { ok: false, error: 'proxy_node_mismatch' }
    }
    const view = this.publicProxy(p, { nodeId: actualNodeId, context })
    if (view.blocked_reason) return { ok: false, error: view.blocked_reason }
    const ids = boundVmIdsOf(p)
    const scopedIds = boundVmIdsOf(view)
    const limit = this.bindLimit()
    // Check first: a rejected move must keep its previous binding intact.
    if (!ids.includes(vm) && scopedIds.length >= limit) {
      return { ok: false, error: 'proxy_bind_limit', max: limit, bound_vm_ids: scopedIds }
    }
    for (const x of this.state.proxies) {
      if (x.id === proxyId) continue
      const ids = boundVmIdsOf(x)
      if (ids.includes(vm))
        setBoundVmIds(
          x,
          ids.filter((id) => id !== vm),
        )
    }
    if (ids.includes(vm)) {
      this.save()
      return { ok: true, proxy: this.publicProxy(p, { nodeId: actualNodeId, context }) }
    }
    setBoundVmIds(p, [...ids, vm])
    this.save()
    return { ok: true, proxy: this.publicProxy(p, { nodeId: actualNodeId, context }) }
  }

  unbind(proxyId, vmId = null, { nodeId = undefined } = {}) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    const ids = boundVmIdsOf(p)
    const target = vmId == null || vmId === '' ? null : String(vmId).trim()
    if (target && isLocalEgressProxy(p) && nodeId !== undefined && this.nodeIdForVm(target) !== nodeId) {
      return { ok: false, error: 'proxy_node_mismatch' }
    }
    const scope = isLocalEgressProxy(p) && nodeId !== undefined ? this.boundIdsForNode(p, nodeId) : ids
    const removed = target ? scope.filter((id) => id === target) : scope
    setBoundVmIds(
      p,
      ids.filter((id) => !removed.includes(id)),
    )
    this.save()
    return { ok: true, proxy: this.publicProxy(p, { nodeId }), unbound_vm_ids: removed }
  }

  unbindVm(vmId) {
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

  setEnabled(proxyId, enabled) {
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

  remove(proxyId) {
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
  update(proxyId, patch = {}) {
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

  updateConfig(patch = {}) {
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
      for (const [socket, proxy] of this._probeSockets) {
        if (socksProxyFamily(proxy) === 6) socket.destroy()
      }
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
  reportRuntimeFailure(vmId, error = 'runtime_socks_failure') {
    if (!this.disconnectOnErrorEnabled()) {
      return { ok: true, skipped: true, reason: 'disconnect_on_error_disabled' }
    }
    if (!vmId) return { ok: false, error: 'vm_id_required' }
    const p = this.state.proxies.find((x) => proxyHasVm(x, vmId))
    if (!p) return { ok: false, error: 'no_bound_proxy' }
    const blocked = proxyBlockedReason(p, this.state.config.ipv6_enabled)
    if (blocked) return { ok: true, skipped: true, reason: blocked }
    if (isLocalEgressProxy(p)) {
      const nodeId = this.nodeIdForVm(vmId)
      const reason = String(error || 'runtime_socks_failure')
      this._nodeProbes.set(nodeId, {
        ok: false,
        error: reason,
        latency_ms: null,
        checked_at: new Date().toISOString(),
      })
      const scoped = this.publicProxy(p, { nodeId })
      this._cascadeDisconnectVm(scoped, `proxy_disconnect:${reason}`)
      return { ok: true, skipped: false, proxy: scoped }
    }
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
      // Host default route. A down kin-egress is not "no proxy".
      return { ok: true, scope: 'local', mode: 'direct', latency_ms: 0 }
    }
    const socks = await this._probeSocks(proxy)
    if (socks.scope === 'policy') return socks
    if (!socks.ok) return { ...socks, scope: 'socks' }
    if (typeof this.egressCheck !== 'function') return { ...socks, scope: 'socks' }
    let eg = this.egressCheck(proxy)
    if (!eg?.ok && typeof this.repairEgress === 'function') {
      try {
        this.repairEgress(proxy)
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

  async probeById(proxyId, { nodeId = undefined } = {}) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    if (isLocalEgressProxy(p) && nodeId) {
      const view = this.publicProxy(p, { nodeId })
      const started = Date.now()
      let result
      try {
        if (view.blocked_reason) throw new Error(view.blocked_reason)
        const url = this.nodeExitProxyUrl?.(nodeId)
        if (!url) throw new Error('node_egress_unavailable')
        // Test a real request through the node's SSH-backed SOCKS forwarder.
        const lookup = await this.geoLookup(url, { timeoutMs: this.state.config.probe_timeout_ms })
        result = { ok: !!lookup?.ok, error: lookup?.ok ? null : lookup?.error || 'node_probe_failed' }
      } catch (error) {
        result = { ok: false, error: error?.code || error?.message || 'node_probe_failed' }
      }
      result = { ...result, scope: 'node', latency_ms: Date.now() - started, checked_at: new Date().toISOString() }
      this._applyLocalProbeResult(p, nodeId, result)
      // Node diagnostics must never change the shared row or cascade to sibling nodes.
      return { ok: true, proxy: this.publicProxy(p, { nodeId }), probe: result }
    }
    const result = await this.probeOne(p)
    if (isLocalEgressProxy(p)) {
      const enabled = p.enabled
      this._applyProbeResult(p, result, { cascade: false })
      // Local enablement is an explicit global control, never inferred from one host's health.
      p.enabled = enabled
      if (!enabled) p.status = 'dead'
      this._applyLocalProbeResult(p, null, result)
    } else this._applyProbeResult(p, result)
    this.save()
    return { ok: true, proxy: this.publicProxy(p, { nodeId }), probe: result }
  }

  _applyLocalProbeResult(proxy, nodeId, result) {
    const previous = this._nodeProbes.get(nodeId)
    this._nodeProbes.set(nodeId, { ...result, checked_at: new Date().toISOString() })
    if (!result.ok || !proxy.enabled) return
    const scoped = this.publicProxy(proxy, { nodeId })
    // The VM reason survives a server restart even though node probe caches do not.
    const recoverable = new Set(
      this.listVms()
        .filter((vm) => {
          const reason = String(vm.schedule_disabled_reason || '')
          return reason.includes(`proxy=${proxy.id}`) || /egress_down|proxy_probe_failed/.test(reason)
        })
        .map((vm) => vm.id),
    )
    const ids = boundVmIdsOf(scoped).filter((id) => (previous && !previous.ok) || recoverable.has(id))
    this._cascadeEnableVm({ ...scoped, bound_vm_ids: ids, bound_vm_id: ids[0] || null }, 'proxy_recovered')
  }

  async probeAll({ onlyEnabled = true } = {}) {
    if (this._probing) return { ok: false, error: 'probe_in_progress' }
    this._probing = true
    const results = []
    try {
      const list = this.state.proxies.filter((p) => {
        if (proxyBlockedReason(p, this.state.config.ipv6_enabled)) return false
        if (!onlyEnabled) return true
        if (p.enabled) return true
        return p.status === 'fail' || (p.status === 'dead' && p.last_error)
      })
      for (const p of list) {
        if (isLocalEgressProxy(p)) {
          for (const view of this.localExitViews(p)) {
            const scoped = await this.probeById(p.id, { nodeId: view.node_id })
            results.push({
              id: p.id,
              node_id: view.node_id,
              ...scoped.probe,
              status: scoped.proxy.status,
              enabled: p.enabled,
            })
          }
        } else {
          const result = await this.probeOne(p)
          this._applyProbeResult(p, result)
          results.push({ id: p.id, ...result, status: p.status, enabled: p.enabled })
        }
      }
      this.save()
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
  async detectGeo(proxyId, { force = false, nodeId = undefined } = {}) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    if (isLocalEgressProxy(p) && nodeId) {
      const view = this.publicProxy(p, { nodeId })
      if (view.blocked_reason) return { ok: false, error: view.blocked_reason, proxy: view }
      try {
        const url = this.nodeExitProxyUrl?.(nodeId)
        if (!url) throw new Error('node_egress_unavailable')
        const key = `node:${nodeId}`
        const result = await this.exitGeo(key, url, { force })
        return { ...result, proxy: this.publicProxy(p, { nodeId }), geo_v6: null }
      } catch (error) {
        return { ok: false, error: error?.code || error?.message || 'geo_lookup_failed', proxy: view }
      }
    }
    const blocked = proxyBlockedReason(p, this.state.config.ipv6_enabled)
    if (blocked) return { ok: false, error: blocked, proxy: this.publicProxy(p) }
    const v4Cached = !force && p.geo_checked_at && p.geo_ip
    const v6Cached = !force && p.geo_v6_checked_at
    if (v4Cached && v6Cached) {
      return {
        ok: true,
        cached: true,
        proxy: this.publicProxy(p, { nodeId }),
        geo: proxyGeoOf(p),
        geo_v6: proxyGeoV6Of(p),
      }
    }
    // Local egress has no SOCKS URL: the lookup then leaves over the host
    // default route, which is precisely that row's exit path.
    const url = isLocalEgressProxy(p) ? '' : this._withAuth(p).url
    const timeoutMs = this.state.config?.geo_timeout_ms
    let v4Result = v4Cached ? { ok: true } : await this.geoLookup(url, { timeoutMs })
    if (!v4Cached) this._applyGeoResult(p, v4Result)
    let v6Result = v6Cached ? { ok: true } : await this.geoV6Lookup(url, { timeoutMs })
    if (!v6Cached) this._applyGeoV6Result(p, v6Result)
    this.save()
    const pub = this.publicProxy(p, { nodeId })
    if (!v4Result?.ok) {
      return {
        ok: false,
        error: v4Result?.error || 'geo_lookup_failed',
        proxy: pub,
        geo: proxyGeoOf(p),
        geo_v6: proxyGeoV6Of(p),
      }
    }
    return {
      ok: true,
      cached: v4Cached && v6Cached,
      proxy: pub,
      geo: proxyGeoOf(p),
      geo_v6: proxyGeoV6Of(p),
    }
  }

  async detectGeoAll({ onlyEnabled = true, force = false } = {}) {
    const list = this.state.proxies
      .filter((p) => (onlyEnabled ? p.enabled : true))
      .flatMap((p) => (isLocalEgressProxy(p) ? this.localExitViews(p) : [this.publicProxy(p)]))
    const results = []
    for (const p of list) {
      const result = await this.detectGeo(p.id, { force, nodeId: p.node_id })
      results.push({
        id: p.id,
        ...(p.node_id !== undefined ? { node_id: p.node_id } : {}),
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

  _applyProbeResult(p, result, { cascade = true } = {}) {
    // Disabled by policy is not a failed probe and must not damage health/history.
    if (result.scope === 'policy' || proxyBlockedReason(p, this.state.config.ipv6_enabled)) return
    p.last_probe_at = new Date().toISOString()
    p.latency_ms = result.latency_ms
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

  startScheduler() {
    this.stopScheduler()
    if (!this.state.config.enabled) return
    const min = this.state.config.probe_interval_min || 10
    const ms = min * 60 * 1000
    void this.probeAll({ onlyEnabled: true }).catch(() => {})
    this._timer = setInterval(() => {
      this.probeAll({ onlyEnabled: true }).catch(() => {})
    }, ms)
    this._timer.unref?.()
  }

  stopScheduler() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  restartScheduler() {
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
    if (isLocalEgressProxy(p)) {
      const nodeId = this.nodeIdForVm(vmId)
      if (nodeId && !this.listNodes().some((node) => node.id === nodeId && node.link?.state === 'ready')) return null
    }
    // Never return view_id as id: runtime derives its Docker network from this id.
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
