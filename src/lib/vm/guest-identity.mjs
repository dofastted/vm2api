/**
 * Merge guest-collected facts into vm.json fingerprint.
 * device_id / session_id / generated hostname / catalog kernel
 * are never rotated here (reset-fingerprint owns that).
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from './vm-file.mjs'
import { runtimeKind, isKvmRuntime } from './runtime-kind.mjs'
import { slotExec } from './slot-runtime.mjs'
import { readGuestIdentity, normalizeGuestHardware } from './guest-identity-reader.mjs'
import { OFFICIAL_STAINLESS } from '../identity/vm-identity.mjs'
import { applyOfficialFingerprintToVm } from '../identity/official-fingerprint.mjs'
import { isHostKernel } from '../identity/workstation-profile.mjs'
import { syncNativeTelemetry } from './vm-runtime.mjs'
import { slotHost } from './slot-host.mjs'
import { isGeneratedHostname } from '../identity/workstation-fingerprint.mjs'

export const GUEST_IDENTITY_SCHEMA = '1'

const DMI_KEYS = Object.freeze(['manufacturer', 'product', 'version', 'family', 'serial', 'uuid'])

function textOrNull(value) {
  if (value == null) return null
  const text = String(value).trim()
  return text ? text : null
}

function intOrNull(value) {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.trunc(n)
}

function pickText(next, prev) {
  return textOrNull(next) ?? textOrNull(prev)
}

function pickInt(next, prev) {
  return intOrNull(next) ?? intOrNull(prev)
}

/** Merge observed hardware; empty new facts keep previous values. */
export function mergeGuestHardware(prev, next, observedAt) {
  const p = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}
  const n = next && typeof next === 'object' && !Array.isArray(next) ? next : {}
  const pd = p.dmi && typeof p.dmi === 'object' ? p.dmi : {}
  const nd = n.dmi && typeof n.dmi === 'object' ? n.dmi : {}
  const dmi = {}
  for (const key of DMI_KEYS) {
    dmi[key] = pickText(nd[key], pd[key])
  }
  return {
    cpu_model: pickText(n.cpu_model, p.cpu_model),
    cpu_cores: pickInt(n.cpu_cores, p.cpu_cores),
    memory_bytes: pickInt(n.memory_bytes, p.memory_bytes),
    root_disk: pickText(n.root_disk, p.root_disk),
    mac: pickText(n.mac, p.mac),
    dmi,
    shell: pickText(n.shell, p.shell),
    package_managers: pickText(n.package_managers, p.package_managers),
    runtimes: pickText(n.runtimes, p.runtimes),
    observed_at: pickText(n.observed_at, observedAt) || textOrNull(p.observed_at),
  }
}

function stainlessArch(arch) {
  const a = String(arch || '').toLowerCase()
  if (a === 'amd64' || a === 'x86_64' || a === 'x64') return 'x64'
  if (a === 'arm64' || a === 'aarch64') return 'arm64'
  return a || 'x64'
}

function stainlessOs(goos) {
  const o = String(goos || '').toLowerCase()
  if (o === 'darwin') return 'MacOS'
  if (o === 'windows') return 'Windows'
  return 'Linux'
}

export function mergeGuestFingerprint(prev = {}, guest = {}) {
  const officialMachine = prev.official_machine_id || null
  const deviceId = officialMachine || prev.device_id || guest.device_id || ''
  const sessionId = prev.session_id || guest.session_id || ''
  const arch = stainlessArch(guest.arch || prev.stainless_arch)
  const os = stainlessOs(guest.goos || guest.os || prev.stainless_os)
  const keepHost = isGeneratedHostname(prev.hostname)
  const hostname = keepHost ? prev.hostname : guest.hostname || prev.hostname || null
  const guestHostname = guest.hostname && guest.hostname !== hostname ? guest.hostname : prev.guest_hostname || null
  const hostLeak = isHostKernel(guest.kernel_release)
  const outboundKernel =
    prev.linux_kernel ||
    (!hostLeak && guest.kernel_release) ||
    (!isHostKernel(prev.kernel_release) && prev.kernel_release) ||
    guest.kernel_release ||
    prev.kernel_release ||
    null
  const guestKernel =
    guest.kernel_release && guest.kernel_release !== outboundKernel
      ? guest.kernel_release
      : prev.guest_kernel_release || null
  const guestMachine = prev.guest_machine_id
    ? prev.guest_machine_id
    : guest.machine_id || (prev.machine_id && prev.machine_id !== officialMachine ? prev.machine_id : null)
  const next = {
    ...prev,
    device_id: deviceId,
    session_id: sessionId,
    source: prev.source === 'generated' ? 'generated' : 'guest',
    schema_version: guest.schema_version || GUEST_IDENTITY_SCHEMA,
    runtime_kind: guest.runtime_kind || prev.runtime_kind || null,
    hostname,
    guest_hostname: guestHostname,
    os_id: guest.os_id || prev.os_id || null,
    os_pretty: guest.os_pretty || prev.os_pretty || null,
    kernel_release: outboundKernel,
    linux_kernel: prev.linux_kernel || null,
    guest_kernel_release: guestKernel,
    official_machine_id: officialMachine || prev.official_machine_id || null,
    official_user_id: prev.official_user_id || null,
    identity_source: officialMachine ? 'official-cc-init' : prev.identity_source || null,
    guest_machine_id: guestMachine || prev.guest_machine_id || null,
    timezone: prev.timezone || guest.timezone || null,
    locale: prev.locale || guest.locale || null,
    worker_version: guest.worker_version || prev.worker_version || null,
    collected_at: guest.collected_at || new Date().toISOString(),
    user_agent: prev.user_agent || null,
    x_app: prev.x_app || 'cli',
    stainless_lang: OFFICIAL_STAINLESS.stainless_lang,
    stainless_os: os,
    stainless_arch: arch,
    stainless_runtime: OFFICIAL_STAINLESS.stainless_runtime,
    stainless_runtime_version: OFFICIAL_STAINLESS.stainless_runtime_version,
    stainless_package_version: OFFICIAL_STAINLESS.stainless_package_version,
    reset_at: prev.reset_at || null,
    updated_at: new Date().toISOString(),
  }
  const guestHw = guest.hardware != null ? normalizeGuestHardware(guest.hardware) : null
  if (guestHw) {
    next.hardware = mergeGuestHardware(
      prev.hardware,
      { ...guestHw, observed_at: guest.hardware?.observed_at },
      guest.collected_at,
    )
  }
  if (officialMachine) delete next.machine_id
  return next
}

export async function collectSlotIdentity(projectRoot, vm, { callGet = readGuestIdentity, timeoutMs } = {}) {
  if (!vm?.id) return { ok: false, error: 'vm required' }
  const exec = slotExec(projectRoot, vm)
  const ms = timeoutMs ?? (isKvmRuntime(vm) ? 20_000 : 5_000)
  const res = await callGet(exec, '/internal/identity', { timeoutMs: ms })
  if (!res?.ok) {
    const message = res?.body?.error?.message || res?.body?.error || `identity status ${res?.status || 0}`
    return {
      ok: false,
      id: vm.id,
      error: String(message).slice(0, 300),
      code: res?.status === 404 ? 'worker_identity_unsupported' : res?.body?.error?.code || 'worker_identity_failed',
    }
  }
  const guest = res.body?.identity && typeof res.body.identity === 'object' ? res.body.identity : res.body
  const vmPath = exec.vmPath
  let current
  try {
    current = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  } catch {
    return { ok: false, id: vm.id, error: 'vm.json unreadable' }
  }
  if (!guest.runtime_kind) guest.runtime_kind = runtimeKind(current)
  current.fingerprint = mergeGuestFingerprint(current.fingerprint, guest)
  current.runtime = {
    ...(current.runtime || {}),
    type: runtimeKind(current),
    guest_hostname: current.fingerprint.guest_hostname || current.fingerprint.hostname,
    guest_os: current.fingerprint.os_pretty,
    guest_os_version: guest.os_version || null,
    guest_platform: guest.goos || null,
    guest_arch: guest.arch || null,
    guest_kernel: current.fingerprint.guest_kernel_release || current.fingerprint.kernel_release,
    identity_collected_at: current.fingerprint.collected_at,
  }
  current.updated_at = new Date().toISOString()
  atomicWriteJson(vmPath, current, { mode: 0o600 })
  const homeDir = path.join(projectRoot, 'vms', vm.id, 'cli-home')
  applyOfficialFingerprintToVm(vmPath, homeDir)
  try {
    current = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  } catch {}
  try {
    const telemetry = syncNativeTelemetry(current, projectRoot)
    if (telemetry.wrote) {
      await slotHost(current).syncRun(current, path.join(projectRoot, 'vms', current.id))
    }
    return {
      ok: true,
      id: vm.id,
      fingerprint: current.fingerprint,
      runtime_kind: current.runtime.type,
      telemetry_sync: telemetry,
    }
  } catch (error) {
    return {
      ok: false,
      id: vm.id,
      fingerprint: current.fingerprint,
      runtime_kind: current.runtime.type,
      error: `telemetry sync failed: ${String(error?.message || error).slice(0, 300)}`,
      code: 'telemetry_sync_failed',
    }
  }
}
