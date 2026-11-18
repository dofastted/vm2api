/** Native VM telemetry configuration. Policy and identity stay inside cli-node. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { validTimezone } from '../core/timezone.mjs'
import { readRoutingConfigFile } from '../core/config.mjs'
import { isDbOpen } from '../db/database.mjs'
import { ProxiesRepo } from '../db/repos/proxies-repo.mjs'
import { runtimeFileOwner } from '../oauth/oauth-credentials.mjs'

export const TELEMETRY_UPLOAD_INTERVAL_DEFAULT = 600
export const TELEMETRY_UPLOAD_INTERVAL_MIN = 60
export const TELEMETRY_UPLOAD_INTERVAL_MAX = 86_400

/** routing.telemetry.upload_interval_seconds, whole minutes within 1 min–24 h; otherwise the 10 min default. */
export function telemetryUploadInterval(routing) {
  const raw = routing?.telemetry?.upload_interval_seconds
  const n = typeof raw === 'number' ? raw : Number.NaN
  if (Number.isInteger(n) && n % 60 === 0 && n >= TELEMETRY_UPLOAD_INTERVAL_MIN && n <= TELEMETRY_UPLOAD_INTERVAL_MAX)
    return n
  return TELEMETRY_UPLOAD_INTERVAL_DEFAULT
}

/** routing.telemetry.default_enabled. Only an explicit true opts new Claude VMs in. */
export function telemetryDefaultEnabled(routing) {
  return routing?.telemetry?.default_enabled === true
}

export function validateTelemetryRoutingPatch(body = {}) {
  if (!body || typeof body !== 'object' || body.telemetry == null) return []
  if (typeof body.telemetry !== 'object' || Array.isArray(body.telemetry)) return ['telemetry 必须是对象']
  const problems = []
  if (Object.hasOwn(body.telemetry, 'default_enabled') && typeof body.telemetry.default_enabled !== 'boolean') {
    problems.push('telemetry.default_enabled 必须是布尔值')
  }
  if (Object.hasOwn(body.telemetry, 'upload_interval_seconds')) {
    const n = body.telemetry.upload_interval_seconds
    if (
      !Number.isInteger(n) ||
      n % 60 !== 0 ||
      n < TELEMETRY_UPLOAD_INTERVAL_MIN ||
      n > TELEMETRY_UPLOAD_INTERVAL_MAX
    ) {
      problems.push('telemetry.upload_interval_seconds 必须是 60–86400 之间、60 的整数倍')
    }
  }
  return problems
}

function routingFor(projectRoot, routing) {
  if (routing) return routing
  try {
    return readRoutingConfigFile(projectRoot)
  } catch {
    return null
  }
}

/** Identity only. The slot network's egress forwarder is the only proxy. */
export function buildNativeTelemetry(vm, projectRoot, routing = null) {
  return {
    upload_interval_seconds: telemetryUploadInterval(routingFor(projectRoot, routing)),
    proxy_id: String(vm?.proxy?.id || '').trim() || null,
    proxy_url: '',
    proxy_required: false,
  }
}

/** Same SHA-256 of JSON.stringify used by the native sender's binding and epoch. */
export function telemetryFactHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function proxyGeoFromRow(row) {
  if (!row || (!row.geo_checked_at && !row.geo_ip && !row.geo_error)) return null
  return {
    ip: row.geo_ip || null,
    country: row.geo_country || null,
    country_code: row.geo_country_code || null,
    region: row.geo_region || null,
    city: row.geo_city || null,
    isp: row.geo_isp || null,
    timezone: row.geo_timezone || null,
    checked_at: row.geo_checked_at || null,
    error: row.geo_error || null,
  }
}

/** Geo already recorded for the proxy selected in the VM config. Never probes. */
export function readVmProxyGeo(vm, lookup = null) {
  const embedded = vm?.proxy?.geo
  if (embedded && typeof embedded === 'object' && !Array.isArray(embedded)) return embedded
  if (lookup) return lookup(vm)
  const id = String(vm?.proxy?.id || '').trim()
  if (!id || !isDbOpen()) return null
  try {
    return proxyGeoFromRow(new ProxiesRepo().loadAll().find((row) => row.id === id))
  } catch {
    return null
  }
}

/**
 * Snapshot the native sender loads. Location comes from the proxy feature's
 * saved geo. checked_at records this publication, not a sender probe.
 */
export function telemetryEgressSnapshot(vm, geo, now = Date.now()) {
  if (!vm?.id || !geo || geo.error || !net.isIP(String(geo.ip || ''))) return null
  const timezone = validTimezone(geo.timezone)
  if (!timezone) return null
  const projection = buildNativeTelemetry(vm, '', { telemetry: {} })
  if (!projection.proxy_id && projection.proxy_required) return null
  const binding = telemetryFactHash([projection.proxy_id, projection.proxy_url, projection.proxy_required])
  const text = (value, max) => {
    const trimmed = String(value || '').trim()
    return trimmed ? trimmed.slice(0, max) : ''
  }
  return {
    vm_id: vm.id,
    binding,
    epoch: telemetryFactHash([binding, geo.ip]),
    ip: geo.ip,
    timezone,
    checked_at: now,
    error: null,
    ...(text(geo.country, 128) ? { country: text(geo.country, 128) } : {}),
    ...(text(geo.country_code, 8) ? { country_code: text(geo.country_code, 8) } : {}),
    ...(text(geo.region, 128) ? { region: text(geo.region, 128) } : {}),
    ...(text(geo.city, 128) ? { city: text(geo.city, 128) } : {}),
    ...(text(geo.isp, 128) ? { isp: text(geo.isp, 128) } : {}),
  }
}

function replaceOwnedJson(file, body, vm) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`
  let fd
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    fs.writeFileSync(fd, body)
    fs.fchmodSync(fd, 0o600)
    const { uid, gid } = runtimeFileOwner(vm)
    try {
      fs.fchownSync(fd, uid, gid)
    } catch (error) {
      if (process.getuid?.() === 0) throw error
    }
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tmp, file)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try {
      fs.unlinkSync(tmp)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

/** Overwrite the guest egress snapshot from the VM's configured proxy geo. */
export function writeVmProxyTelemetryEgress(projectRoot, vm, geo = readVmProxyGeo(vm), now = Date.now()) {
  const snapshot = telemetryEgressSnapshot(vm, geo, now)
  if (!snapshot) return { wrote: false, overwritten: false, reason: 'proxy_geo_unavailable' }
  const file = path.join(projectRoot, 'vms', vm.id, 'cli-home', '.claude', 'telemetry', 'egress.json')
  const overwritten = fs.existsSync(file)
  replaceOwnedJson(file, `${JSON.stringify(snapshot, null, 2)}\n`, vm)
  return { wrote: true, overwritten, reason: null, snapshot }
}
