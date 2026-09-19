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
import { lookupProxyGeo } from './proxy-geo.mjs'
import { LOCAL_EGRESS_ID, isLocalEgressProxy } from './egress.mjs'

export const MAX_VMS_PER_PROXY = 5
export const BIND_LIMIT_MIN = 1
export const BIND_LIMIT_MAX = 32

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

function setBoundVmIds(proxy, ids) {
  const next = parseBoundVmIds(ids)
  proxy.bound_vm_ids = next
  proxy.bound_vm_id = next[0] || null
  return next
}

function hydrateProxy(proxy) {
  if (!proxy) return proxy
  const ids = parseBoundVmIds(proxy.bound_vm_ids?.length ? proxy.bound_vm_ids : proxy.bound_vm_id)
  return { ...proxy, bound_vm_ids: ids, bound_vm_id: ids[0] || null }
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
  if (!looksLikeHost(host) || !isSocksPort(port)) return null
  const user = username == null || username === '' ? null : String(username)
  const pass = user == null ? null : password == null ? '' : String(password)
  return {
    scheme: 'socks5',
    host: String(host).trim(),
    port: Number(port),
    username: user,
    password: pass,
    raw: String(raw || `${host}:${port}`),
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
      const segs = hostPort.split(':')
      if (segs.length >= 2 && isSocksPort(segs[segs.length - 1])) {
        const port = segs.pop()
        const host = segs.join(':')
        const colon = cred.indexOf(':')
        return socks5Record({
          host,
          port,
          username: colon >= 0 ? cred.slice(0, colon) : cred,
          password: colon >= 0 ? cred.slice(colon + 1) : '',
          raw,
        })
      }
    }
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
    this.state = { config: { ...DEFAULT_CONFIG }, proxies: [] }
    this._timer = null
    this._probing = false
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

  snapshot({ ownerUserId = undefined } = {}) {
    const limit = this.bindLimit()
    const owner = ownerUserId === undefined ? undefined : normalizeOwnerId(ownerUserId)
    const proxies =
      ownerUserId === undefined ? this.state.proxies : this.state.proxies.filter((p) => proxyOwnerId(p) === owner)
    const unused = proxies.filter((p) => p.enabled && boundVmIdsOf(p).length === 0 && p.status !== 'dead').length
    const open = proxies.filter((p) => p.enabled && p.status !== 'dead' && boundVmIdsOf(p).length < limit).length
    const bound = proxies.filter((p) => boundVmIdsOf(p).length > 0).length
    const dead = proxies.filter((p) => !p.enabled || p.status === 'dead').length
    const ok = proxies.filter((p) => p.enabled && p.status === 'ok').length
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
        probing: this._probing,
        slots_used: slotsUsed,
        slots_cap: proxies.length * limit,
        bind_limit: limit,
      },
      proxies: proxies.map((p) => this.publicProxy(p)),
    }
  }

  publicProxy(p) {
    const ids = boundVmIdsOf(p)
    const limit = this.bindLimit()
    return {
      id: p.id,
      host: p.host,
      port: p.port,
      has_auth: !!(p.username || p.password),
      status: p.status, // unknown | ok | fail | dead
      enabled: p.enabled,
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
      geo: proxyGeoOf(p),
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
    const existing = new Set(this.state.proxies.map((p) => `${p.host}:${p.port}:${p.username || ''}`))
    for (const parsed of records) {
      if (!parsed || parsed.__invalid || !parsed.host || !parsed.port) {
        const label = parsed?.__invalid || ''
        if (label) skipped.push({ line: label, reason: 'parse_failed' })
        continue
      }
      const key = `${parsed.host}:${parsed.port}:${parsed.username || ''}`
      if (existing.has(key)) {
        skipped.push({ line: `${parsed.host}:${parsed.port}`, reason: 'duplicate' })
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
    const existing = this.getProxyForVm(vmId)
    if (existing) return existing
    if (preferredId) {
      const bound = this.bind(preferredId, vmId)
      if (bound.ok) return this.getProxyForVm(vmId)
    }
    return this.allocateForVm(vmId)
  }

  /** Allocate one healthy proxy with remaining capacity and bind to vmId */
  allocateForVm(vmId, { ownerUserId = null, role = 'admin' } = {}) {
    if (!vmId) return null
    const existing = this.state.proxies.find((p) => p.enabled && proxyHasVm(p, vmId))
    if (existing) return this.publicProxy(existing)

    const limit = this.bindLimit()
    const owner = normalizeOwnerId(ownerUserId)
    const candidates = this.state.proxies.filter((p) => {
      if (!p.enabled || p.status === 'dead' || p.status === 'fail') return false
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
    const bound = this.bind(pick.id, vmId, { role })
    return bound.ok ? bound.proxy : null
  }

  bind(proxyId, vmId) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    if (!p.enabled || p.status === 'dead') return { ok: false, error: 'proxy_disabled' }
    const vm = String(vmId || '').trim()
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
    if (ids.length >= limit) {
      return { ok: false, error: 'proxy_bind_limit', max: limit, bound_vm_ids: ids }
    }
    setBoundVmIds(p, [...ids, vm])
    this.save()
    return { ok: true, proxy: this.publicProxy(p) }
  }

  unbind(proxyId, vmId = null) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    const ids = boundVmIdsOf(p)
    const target = vmId == null || vmId === '' ? null : String(vmId).trim()
    const removed = target ? ids.filter((id) => id === target) : ids.slice()
    setBoundVmIds(p, target ? ids.filter((id) => id !== target) : [])
    this.save()
    return { ok: true, proxy: this.publicProxy(p), unbound_vm_ids: removed }
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
   * Edit one proxy in place. Only keys present in `patch` are touched, so the
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
    if (!['host', 'port', 'username', 'password'].some(has)) {
      return { ok: false, error: 'no_editable_fields' }
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
    p.raw = `${next.host}:${next.port}`
    this.save()
    return { ok: true, proxy: this.publicProxy(p) }
  }

  updateConfig(patch = {}) {
    const allowed = [5, 10, 30, 60]
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
    this.save()
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
    if (isLocalEgressProxy(proxy)) {
      if (typeof this.egressCheck !== 'function') {
        return { ok: true, scope: 'local', latency_ms: 0 }
      }
      let eg = this.egressCheck(proxy)
      if (!eg?.ok && typeof this.repairEgress === 'function') {
        try {
          this.repairEgress(proxy)
        } catch {
          /* keep */
        }
        eg = this.egressCheck(proxy)
      }
      if (eg?.ok) return { ok: true, scope: 'local', latency_ms: 0 }
      return { ok: false, scope: 'egress', socks_ok: true, latency_ms: 0, error: eg?.reason || 'local_network_missing' }
    }
    const socks = await this._probeSocks(proxy)
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
    const timeout = this.state.config.probe_timeout_ms || 8000
    const started = Date.now()
    return new Promise((resolve) => {
      const socket = net.connect({ host: proxy.host, port: proxy.port })
      let done = false
      let connected = false
      const finish = (ok, error) => {
        if (done) return
        done = true
        try {
          socket.destroy()
        } catch {
          /* */
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
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    const result = await this.probeOne(p)
    this._applyProbeResult(p, result)
    this.save()
    return { ok: true, proxy: this.publicProxy(p), probe: result }
  }

  async probeAll({ onlyEnabled = true } = {}) {
    if (this._probing) return { ok: false, error: 'probe_in_progress' }
    this._probing = true
    const results = []
    try {
      const list = this.state.proxies.filter((p) => {
        if (!onlyEnabled) return true
        if (p.enabled) return true
        return p.status === 'fail' || (p.status === 'dead' && p.last_error)
      })
      for (const p of list) {
        const result = await this.probeOne(p)
        this._applyProbeResult(p, result)
        results.push({ id: p.id, ...result, status: p.status, enabled: p.enabled })
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
  async detectGeo(proxyId, { force = false } = {}) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    if (!force && p.geo_checked_at && p.geo_ip) {
      return { ok: true, cached: true, proxy: this.publicProxy(p), geo: proxyGeoOf(p) }
    }
    // Local egress has no SOCKS URL: the lookup then leaves over the host
    // default route, which is precisely that row's exit path.
    const url = isLocalEgressProxy(p) ? '' : this._withAuth(p).url
    const result = await this.geoLookup(url, { timeoutMs: this.state.config?.geo_timeout_ms })
    this._applyGeoResult(p, result)
    this.save()
    if (!result?.ok) return { ok: false, error: result?.error || 'geo_lookup_failed', proxy: this.publicProxy(p) }
    return { ok: true, cached: false, proxy: this.publicProxy(p), geo: proxyGeoOf(p) }
  }

  async detectGeoAll({ onlyEnabled = true, force = false } = {}) {
    const list = this.state.proxies.filter((p) => (onlyEnabled ? p.enabled : true))
    const results = []
    for (const p of list) {
      const result = await this.detectGeo(p.id, { force })
      results.push({
        id: p.id,
        ok: !!result.ok,
        cached: !!result.cached,
        error: result.ok ? null : result.error || null,
        geo: result.ok ? result.geo : null,
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
    this._timer = setInterval(() => {
      this.probeAll({ onlyEnabled: true }).catch(() => {})
    }, ms)
    // optional: don't block startup with immediate full probe
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
    const p = this.state.proxies.find((x) => proxyHasVm(x, vmId) && x.enabled && x.status !== 'dead')
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
    const auth = p.username != null ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password || '')}@` : ''
    return {
      id: p.id,
      url: `socks5://${auth}${p.host}:${p.port}`,
      host: p.host,
      port: p.port,
      username: p.username || null,
      password: p.password == null ? null : p.password,
    }
  }
}
