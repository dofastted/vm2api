/**
 * worker.json telemetry block for the Go sidecar.
 * ON  → seed_policy.telemetry_disabled === false (kill-switch keys deleted)
 * OFF → { enabled: false }
 * Identity is official Claude Code init + guest OS, not random presets.
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadVmIdentity, OFFICIAL_CLI_VERSION } from '../identity/vm-identity.mjs'
import { acceptLanguageFromLocale } from '../identity/crs-headers.mjs'
import { defaultSeedPolicy, isTelemetryEnabled } from '../protocol/seed-policy.mjs'
import { resolveWorkstationProfile } from '../identity/workstation-profile.mjs'
import { snapshotOauth } from './execution-context.mjs'
import {
  buildFullEnvJson,
  DEFAULT_PROCESS_RANGES,
  distroVersionFromPretty,
  officialDeviceID,
  telemetryCodeUa,
  telemetryShell,
} from '../identity/telemetry-env.mjs'
import { readOfficialCcIdentity } from '../identity/official-fingerprint.mjs'
import { slotHost } from './slot-host.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { readRoutingConfigFile } from '../core/config.mjs'

const DROP_HEADER = /^(authorization|cookie|x-api-key|proxy-authorization)$/i

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

export function validateTelemetryRoutingPatch(body = {}) {
  if (!body || typeof body !== 'object' || body.telemetry == null) return []
  if (typeof body.telemetry !== 'object' || Array.isArray(body.telemetry)) return ['telemetry 必须是对象']
  if (!Object.hasOwn(body.telemetry, 'upload_interval_seconds')) return []
  const n = body.telemetry.upload_interval_seconds
  if (!Number.isInteger(n) || n % 60 !== 0 || n < TELEMETRY_UPLOAD_INTERVAL_MIN || n > TELEMETRY_UPLOAD_INTERVAL_MAX) {
    return ['telemetry.upload_interval_seconds 必须是 60–86400 之间、60 的整数倍']
  }
  return []
}

function routingFor(projectRoot, routing) {
  if (routing) return routing
  try {
    return readRoutingConfigFile(projectRoot)
  } catch {
    return null
  }
}

export function telemetryTouchPath(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', vmId, 'run', 'telemetry.touch')
}

/** `vm` given: the touch also reaches wherever that slot reads it (throttled for node slots). */
export function touchTelemetrySession(projectRoot, vmId, vm = null) {
  if (!projectRoot || !vmId) return { wrote: false }
  const file = telemetryTouchPath(projectRoot, vmId)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${new Date().toISOString()}\n`, { mode: 0o600 })
  } catch {
    return { wrote: false }
  }
  const publication = slotHost(vm).touch(vm, path.join(projectRoot, 'vms', vmId))
  return { wrote: true, publication }
}
function officialInstallTime(homeDir) {
  if (!homeDir) return ''
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude', 'kin-official-bootstrap.json'), 'utf8'))
  } catch {
    return ''
  }
  if (doc?.status !== 'ok' && doc?.hello_ok !== true) return ''
  const raw = String(doc.finished_at || '').trim()
  if (!raw) return ''
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) return raw
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function telemetryHeaders(identity) {
  const fp = identity.fingerprint || {}
  const lang = acceptLanguageFromLocale(fp.locale || identity.locale)
  const headers = {
    'user-agent': telemetryCodeUa(identity.cliVersion || OFFICIAL_CLI_VERSION),
    'x-app': 'cli',
    'x-service-name': 'claude-code',
    'anthropic-version': '2023-06-01',
    'x-stainless-lang': fp.stainless_lang || 'js',
    'x-stainless-os': fp.stainless_os || 'Linux',
    'x-stainless-arch': fp.stainless_arch || 'x64',
    'x-stainless-runtime': fp.stainless_runtime || 'node',
    'x-stainless-runtime-version': fp.stainless_runtime_version || 'v26.3.0',
    'x-stainless-package-version': fp.stainless_package_version || '0.128.0',
  }
  if (identity.sessionId) headers['x-claude-code-session-id'] = identity.sessionId
  if (lang) headers['accept-language'] = lang
  for (const key of Object.keys(headers)) {
    if (DROP_HEADER.test(key) || headers[key] == null || headers[key] === '') delete headers[key]
  }
  return headers
}

export function buildWorkerTelemetry(vm, projectRoot, routing = null) {
  const seed = defaultSeedPolicy(vm?.seed_policy || {})
  if (!isTelemetryEnabled(seed) || isCodexVm(vm)) {
    return { enabled: false }
  }
  const homeDir = projectRoot && vm?.id ? path.join(projectRoot, 'vms', vm.id, 'cli-home') : ''
  const official = homeDir ? readOfficialCcIdentity(homeDir) : {}
  const identity = loadVmIdentity({
    vmId: vm?.id,
    homeDir,
    timezone: vm?.timezone,
    locale: vm?.locale,
    oauth: snapshotOauth(vm),
    seedPolicy: seed,
    vm,
  })
  const fp = identity.fingerprint || {}
  const guest = vm?.fingerprint || {}
  const userId = officialDeviceID(official.user_id, guest.official_user_id)
  if (!userId) {
    return { enabled: false, reason: 'waiting_official_identity' }
  }
  const profile = resolveWorkstationProfile(vm || {})
  const hw = guest.hardware && typeof guest.hardware === 'object' ? guest.hardware : null
  const payload = {
    device_id: userId,
    user_id: userId,
    account_uuid: official.account_uuid || identity.accountUuid || '',
    org_uuid: official.org_uuid || identity.orgUuid || '',
    email: identity.email || official.email || '',
    session_id: identity.sessionId || fp.session_id || '',
    subscription_type: official.subscription_type || identity.subscriptionType || '',
    platform: 'linux',
    platform_raw: 'linux',
    arch: fp.stainless_arch || 'x64',
    locale: identity.locale,
    timezone: identity.timezone,
    cli_version: identity.cliVersion,
    entrypoint: 'cli',
    terminal: 'unknown',
    shell: telemetryShell((hw && hw.shell) || guest.shell || profile.shell),
    package_managers: String((hw && hw.package_managers) || guest.package_managers || '').trim(),
    vcs: String(guest.vcs || '').trim() || 'git',
    runtimes: String((hw && hw.runtimes) || guest.runtimes || '').trim() || 'node',
    build_time: officialInstallTime(homeDir),
    linux_distro_id: guest.os_id || '',
    linux_distro_version: distroVersionFromPretty(guest.os_pretty),
    linux_kernel: guest.kernel_release || '',
    process: { ...DEFAULT_PROCESS_RANGES },
    source: 'official-cc-init',
  }
  payload.env = buildFullEnvJson(payload)
  return {
    enabled: true,
    upload_interval_seconds: telemetryUploadInterval(routingFor(projectRoot, routing)),
    identity: payload,
    headers: telemetryHeaders(identity),
  }
}
