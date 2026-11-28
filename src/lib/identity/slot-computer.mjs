/**
 * One computer per slot, created by the closed kin-computer binary before the
 * guest starts. The algorithm and device codes stay in that binary.
 * Hostname and the 32-bit machine-id come from the directory it writes.
 * device_id stays a control-plane 64-bit value and is never the SMBIOS UUID.
 */
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validTimezone } from '../core/timezone.mjs'
import { isCustomKvmMode } from '../vm/custom-os-runtime.mjs'
import { callAgentRpc, resolveSlotAgentConnection } from '../vm/kvm-slot-agent-client.mjs'
import { isKvmRuntime } from '../vm/runtime-kind.mjs'
import {
  DEFAULT_SLOT_USER,
  detectHostCpuVendor,
  isValidSlotUsername,
  slotHome,
  slotUser,
} from '../vm/slot-identity.mjs'
import { atomicWriteJson } from '../vm/vm-file.mjs'
import { repairKvmFingerprintUuid } from './kvm-fingerprint-uuid.mjs'
import { isRfc4122Uuid } from './rfc4122-uuid.mjs'
import {
  generateWorkstationFingerprint,
  HOSTNAME_RE,
  MACHINE_ID_RE,
  STANDARD_LOCALE,
} from './workstation-fingerprint.mjs'

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/
const SAFE_TZ_RE = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/
const MAX_LOCALTIME_BYTES = 64 * 1024
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const FORBIDDEN_PRESET_ENV_KEYS = new Set([
  'CLAUDE_CODE_ATTRIBUTION_HEADER',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_GATEWAY_HINT_HEADERS',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS',
  'DISABLE_AUTOUPDATER',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_UNIX_SOCKET',
])

const ALLOWED_PRESET_ENV_KEYS = new Set(['TZ', 'LANG', 'LC_ALL', 'DISABLE_TELEMETRY', 'DO_NOT_TRACK'])

const DEFAULT_DEBIAN_PASSWD_LINES = Object.freeze([
  'root:x:0:0:root:/root:/bin/bash',
  'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
  'bin:x:2:2:bin:/bin:/usr/sbin/nologin',
  'sys:x:3:3:sys:/dev:/usr/sbin/nologin',
  'sync:x:4:65534:sync:/bin:/bin/sync',
  'games:x:5:60:games:/usr/games:/usr/sbin/nologin',
  'man:x:6:12:man:/var/cache/man:/usr/sbin/nologin',
  'lp:x:7:7:lp:/var/spool/lpd:/usr/sbin/nologin',
  'mail:x:8:8:mail:/var/mail:/usr/sbin/nologin',
  'news:x:9:9:news:/var/spool/news:/usr/sbin/nologin',
  'uucp:x:10:10:uucp:/var/spool/uucp:/usr/sbin/nologin',
  'proxy:x:13:13:proxy:/bin:/usr/sbin/nologin',
  'www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin',
  'backup:x:34:34:backup:/var/backups:/usr/sbin/nologin',
  'list:x:38:38:Mailing List Manager:/var/list:/usr/sbin/nologin',
  'irc:x:39:39:ircd:/run/ircd:/usr/sbin/nologin',
  '_apt:x:42:65534::/nonexistent:/usr/sbin/nologin',
  'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
  'messagebus:x:100:101::/nonexistent:/usr/sbin/nologin',
  'sshd:x:101:65534::/run/sshd:/usr/sbin/nologin',
])

const DEFAULT_DEBIAN_GROUP_LINES = Object.freeze([
  'root:x:0:',
  'daemon:x:1:',
  'bin:x:2:',
  'sys:x:3:',
  'adm:x:4:',
  'tty:x:5:',
  'disk:x:6:',
  'lp:x:7:',
  'mail:x:8:',
  'news:x:9:',
  'uucp:x:10:',
  'man:x:12:',
  'proxy:x:13:',
  'kmem:x:15:',
  'dialout:x:20:',
  'fax:x:21:',
  'voice:x:22:',
  'cdrom:x:24:',
  'floppy:x:25:',
  'tape:x:26:',
  'sudo:x:27:',
  'audio:x:29:',
  'dip:x:30:',
  'www-data:x:33:',
  'backup:x:34:',
  'operator:x:37:',
  'list:x:38:',
  'irc:x:39:',
  'src:x:40:',
  'shadow:x:42:',
  'utmp:x:43:',
  'video:x:44:',
  'sasl:x:45:',
  'plugdev:x:46:',
  'staff:x:50:',
  'games:x:60:',
  'users:x:100:',
  'messagebus:x:101:',
  'nogroup:x:65534:',
])

export function computerBin() {
  const fromEnv = String(process.env.KIN_COMPUTER_BIN || '').trim()
  if (fromEnv) return fromEnv
  return path.join(REPO_ROOT, 'bin', 'kin-computer')
}

export function fingerprintDir(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', vmId, 'kvm', 'fingerprint')
}

export function slotComputerSystemEtcDir(projectRoot, vmId) {
  return path.join(fingerprintDir(projectRoot, vmId), 'system', 'etc')
}

export function slotComputerRuntimeEtcDir(projectRoot, vmId) {
  return path.join(fingerprintDir(projectRoot, vmId), 'runtime-etc')
}

function readTrimmed(file) {
  return fs.readFileSync(file, 'utf8').replace(/\s+/g, '')
}

function readIdentityMeta(dir) {
  for (const name of ['identity.json', 'pc_identity.json']) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) continue
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (data && typeof data === 'object' && !Array.isArray(data)) return data
    } catch {}
  }
  return null
}

function extractIdentityExtras(data) {
  if (!data || typeof data !== 'object') {
    return {
      username: '',
      os_release: null,
      kernel_profile: null,
      cpuid_vendor: '',
      cpu_model_id: '',
      acpi: null,
    }
  }
  const rawUser = String(data.username || '').trim()
  const username = isValidSlotUsername(rawUser) ? rawUser : ''
  const os_release = data.os_release && typeof data.os_release === 'object' ? data.os_release : null
  const kernel_profile = data.kernel_profile && typeof data.kernel_profile === 'object' ? data.kernel_profile : null
  const cpuid_vendor = String(data.cpuid_vendor || '').trim()
  const cpu_model_id = String(data.cpu_model_id || '').trim()
  const acpi = data.acpi && typeof data.acpi === 'object' ? data.acpi : null
  return { username, os_release, kernel_profile, cpuid_vendor, cpu_model_id, acpi }
}

function linuxComputer(dir) {
  const identPath = path.join(dir, 'identity.json')
  const smbios = path.join(dir, 'qemu-smbios.args')
  if (!fs.existsSync(identPath) || !fs.existsSync(smbios)) return null
  let data
  try {
    data = JSON.parse(fs.readFileSync(identPath, 'utf8'))
  } catch {
    return null
  }
  const hostname = String(data.hostname || '').trim()
  const guest_machine_id = String(data.machine_id || '')
    .trim()
    .toLowerCase()
  const uuid = String(data.uuid || '').trim()
  if (!HOSTNAME_RE.test(hostname) || !MACHINE_ID_RE.test(guest_machine_id) || !isRfc4122Uuid(uuid)) return null
  try {
    if (!fs.statSync(smbios).size) return null
  } catch {
    return null
  }
  return { hostname, guest_machine_id, mac: '', dir, kvm: true, ...extractIdentityExtras(data) }
}

function containerComputer(dir) {
  const hostFile = path.join(dir, 'system', 'etc', 'hostname')
  const midFile = path.join(dir, 'system', 'etc', 'machine-id')
  const macFile = path.join(dir, 'system', 'hardware', 'mac')
  const dmi = path.join(dir, 'system', 'dmi', 'id')
  for (const file of [hostFile, midFile, macFile]) {
    try {
      if (!fs.statSync(file).isFile()) return null
    } catch {
      return null
    }
  }
  try {
    if (!fs.statSync(dmi).isDirectory()) return null
  } catch {
    return null
  }
  const hostname = readTrimmed(hostFile)
  const guest_machine_id = readTrimmed(midFile).toLowerCase()
  const mac = readTrimmed(macFile).toLowerCase()
  if (!HOSTNAME_RE.test(hostname) || !MACHINE_ID_RE.test(guest_machine_id) || !MAC_RE.test(mac)) return null
  const ident = readIdentityMeta(dir)
  return { hostname, guest_machine_id, mac, dir, kvm: false, ...extractIdentityExtras(ident) }
}

function ensureContainerComputerSourceFile(dir) {
  const compFile = path.join(dir, 'system', 'etc', 'kin-computer')
  try {
    const stat = fs.lstatSync(compFile)
    if (stat.isFile() && stat.size > 0) return
    fs.rmSync(compFile, { recursive: true, force: true })
  } catch {}
  fs.mkdirSync(path.dirname(compFile), { recursive: true, mode: 0o755 })
  fs.writeFileSync(compFile, 'source=linux-pc\n', { encoding: 'utf8', mode: 0o644 })
}

/**
 * Normalize fingerprint directories to 0755 and regular files to 0644 so a
 * restrictive host umask (077) never leaves /etc/kin-computer or DMI files
 * unreadable (0600 root-only) for non-root container UID 10000+n.
 */
export function normalizeFingerprintModes(dir) {
  let stat
  try {
    stat = fs.lstatSync(dir)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) {
    if ((stat.mode & 0o777) !== 0o755) fs.chmodSync(dir, 0o755)
    for (const entry of fs.readdirSync(dir)) {
      normalizeFingerprintModes(path.join(dir, entry))
    }
    return
  }
  if (stat.isFile() && (stat.mode & 0o777) !== 0o644) {
    fs.chmodSync(dir, 0o644)
  }
}

/**
 * Render per-slot `/etc/passwd` and `/etc/group` content for Docker slots
 * (both local and remote cluster nodes) mapping the real runtime `uid:gid`
 * to `<username>` and `<homeDir>` while stripping any legacy `kincli`/999/987
 * and conflicting UID/GID lines. Never produces `/etc/shadow` or secrets.
 */
export function renderSlotPasswdGroupContent({
  username,
  uid,
  gid,
  homeDir = '',
  basePasswd = '',
  baseGroup = '',
} = {}) {
  const cleanUser = String(username || '').trim()
  if (cleanUser !== DEFAULT_SLOT_USER && !isValidSlotUsername(cleanUser)) {
    throw new Error(`invalid slot username for passwd/group rendering: ${cleanUser}`)
  }
  const numUid = Number(uid)
  const numGid = Number(gid)
  if (!Number.isInteger(numUid) || numUid <= 0 || numUid > 0x7fffffff) {
    throw new Error(`invalid slot uid: ${uid}`)
  }
  if (!Number.isInteger(numGid) || numGid <= 0 || numGid > 0x7fffffff) {
    throw new Error(`invalid slot gid: ${gid}`)
  }
  const resolvedHome = String(homeDir || '').trim() || `/home/${cleanUser}`
  if (!resolvedHome.startsWith('/') || /[:\r\n\0]/.test(resolvedHome)) {
    throw new Error(`invalid slot homeDir: ${resolvedHome}`)
  }

  const uidStr = String(numUid)
  const gidStr = String(numGid)
  const rawPasswdLines = basePasswd
    ? String(basePasswd)
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : [...DEFAULT_DEBIAN_PASSWD_LINES]
  const rawGroupLines = baseGroup
    ? String(baseGroup)
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : [...DEFAULT_DEBIAN_GROUP_LINES]

  const filteredPasswd = []
  for (const line of rawPasswdLines) {
    const parts = line.split(':')
    if (parts.length < 7) continue
    const [name, , entryUid, entryGid] = parts
    if (
      name === DEFAULT_SLOT_USER ||
      name === cleanUser ||
      entryUid === '999' ||
      entryGid === '987' ||
      entryUid === uidStr
    ) {
      continue
    }
    filteredPasswd.push(line)
  }
  filteredPasswd.push(`${cleanUser}:x:${uidStr}:${gidStr}::${resolvedHome}:/bin/bash`)

  const filteredGroup = []
  for (const line of rawGroupLines) {
    const parts = line.split(':')
    if (parts.length < 4) continue
    const [name, passwdField, entryGid, members] = parts
    if (name === DEFAULT_SLOT_USER || name === cleanUser || entryGid === '987' || entryGid === gidStr) {
      continue
    }
    const cleanMembers = members
      ? members
          .split(',')
          .map((m) => m.trim())
          .filter((m) => m && m !== DEFAULT_SLOT_USER && m !== cleanUser)
          .join(',')
      : ''
    filteredGroup.push(`${name}:${passwdField}:${entryGid}:${cleanMembers}`)
  }
  filteredGroup.push(`${cleanUser}:x:${gidStr}:`)

  return {
    passwd: `${filteredPasswd.join('\n')}\n`,
    group: `${filteredGroup.join('\n')}\n`,
  }
}

function writeFileAtomicMode644(dest, data) {
  const dir = path.dirname(dest)
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
  const tmp = `${dest}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  try {
    fs.writeFileSync(tmp, data, { mode: 0o644 })
    if (process.platform !== 'win32') fs.chmodSync(tmp, 0o644)
    fs.renameSync(tmp, dest)
    if (process.platform !== 'win32') fs.chmodSync(dest, 0o644)
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {}
    throw err
  }
}

/**
 * Overwrite an existing regular file in-place without O_TRUNC before write so
 * single-file `:ro` Docker bind mounts preserve their inode and never expose an
 * empty file to concurrent readers. Creates fresh when absent or non-regular.
 */
function overwriteRegularFileInPlaceOrCreate(dest, buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8')
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 })
  let existingRegular = false
  try {
    const st = fs.lstatSync(dest)
    if (st.isFile() && !st.isSymbolicLink()) {
      existingRegular = true
    } else {
      fs.rmSync(dest, { recursive: true, force: true })
    }
  } catch {}
  if (!existingRegular) {
    writeFileAtomicMode644(dest, bytes)
    return
  }
  const fd = fs.openSync(dest, 'r+')
  try {
    let written = 0
    while (written < bytes.length) {
      written += fs.writeSync(fd, bytes, written, bytes.length - written, written)
    }
    fs.ftruncateSync(fd, bytes.length)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o644)
}

/**
 * Write `vms/<id>/kvm/fingerprint/runtime-etc/{passwd,group}` (0644) for a local
 * Docker slot. Never writes `/etc/shadow` or private keys.
 */
export function ensureDockerSlotPasswdFiles(projectRoot, vm, { uid, gid, basePasswd, baseGroup } = {}) {
  if (!projectRoot || !vm?.id) throw new Error('projectRoot and vm id required')
  const username = slotUser(vm)
  const homeDir = slotHome(vm)
  const { passwd, group } = renderSlotPasswdGroupContent({
    username,
    uid,
    gid,
    homeDir,
    basePasswd,
    baseGroup,
  })
  const dir = slotComputerRuntimeEtcDir(projectRoot, vm.id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o755)
  const passwdPath = path.join(dir, 'passwd')
  const groupPath = path.join(dir, 'group')
  writeFileAtomicMode644(passwdPath, passwd)
  writeFileAtomicMode644(groupPath, group)
  return { dir, passwdPath, groupPath, username, uid: Number(uid), gid: Number(gid), homeDir }
}

function readValidatedZoneinfoBytes(zone, zoneinfoRoot = '/usr/share/zoneinfo') {
  const clean = String(zone || '').trim()
  if (!clean || clean.length > 64 || clean.includes('..') || !SAFE_TZ_RE.test(clean)) return null
  let rootReal
  try {
    rootReal = fs.realpathSync(zoneinfoRoot)
  } catch {
    return null
  }
  const candidate = path.resolve(rootReal, clean)
  const rel = path.relative(rootReal, candidate)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  let resolved
  try {
    resolved = fs.realpathSync(candidate)
  } catch {
    return null
  }
  const relReal = path.relative(rootReal, resolved)
  if (!relReal || relReal.startsWith('..') || path.isAbsolute(relReal)) return null
  try {
    const st = fs.statSync(resolved)
    if (!st.isFile() || st.size < 44 || st.size > MAX_LOCALTIME_BYTES) return null
    const buf = fs.readFileSync(resolved)
    if (buf.subarray(0, 4).toString('ascii') !== 'TZif') return null
    return buf
  } catch {
    return null
  }
}

function sanitizeSlotPresetObject(existing, { timezone, locale, telemetryEnabled }) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}
  const theme = typeof base.theme === 'string' && base.theme.trim() ? base.theme.trim() : 'dark'
  const prevEnv = base.env && typeof base.env === 'object' && !Array.isArray(base.env) ? base.env : {}
  const env = {}
  for (const [k, v] of Object.entries(prevEnv)) {
    if (FORBIDDEN_PRESET_ENV_KEYS.has(k) || !ALLOWED_PRESET_ENV_KEYS.has(k)) continue
    if ((k === 'DISABLE_TELEMETRY' || k === 'DO_NOT_TRACK') && v !== '1') continue
    if (typeof v === 'string' && v.trim()) env[k] = v
  }
  env.TZ = timezone
  env.LANG = locale
  env.LC_ALL = locale
  if (typeof telemetryEnabled === 'boolean') {
    if (telemetryEnabled) {
      delete env.DISABLE_TELEMETRY
      delete env.DO_NOT_TRACK
    } else {
      env.DISABLE_TELEMETRY = '1'
      env.DO_NOT_TRACK = '1'
    }
  } else if (
    !Object.hasOwn(prevEnv, 'DISABLE_TELEMETRY') &&
    !Object.hasOwn(prevEnv, 'DO_NOT_TRACK') &&
    !Object.keys(prevEnv).length
  ) {
    env.DISABLE_TELEMETRY = '1'
    env.DO_NOT_TRACK = '1'
  }
  return { theme, env }
}

/**
 * Atomically synchronize `10-slot-preset.json`, `system/etc/timezone`, and
 * `system/etc/localtime` under `vms/<id>/kvm/fingerprint/system/etc` whenever
 * a slot's timezone or locale changes.
 */
export function syncSlotIdentityTimezoneAndPreset(projectRoot, vm, opts = {}) {
  if (!projectRoot || !vm?.id) {
    return { ok: false, skipped: true, reason: 'vm_required' }
  }
  const zone = validTimezone(opts.timezone ?? vm?.timezone ?? vm?.fingerprint?.timezone)
  if (!zone || !SAFE_TZ_RE.test(zone) || zone.includes('..')) {
    return { ok: false, skipped: true, reason: 'invalid_timezone' }
  }
  const locale = String(opts.locale ?? vm?.locale ?? vm?.fingerprint?.locale ?? '').trim() || STANDARD_LOCALE
  const etcDir = slotComputerSystemEtcDir(projectRoot, vm.id)
  const presetDir = path.join(etcDir, 'claude-code', 'managed-settings.d')
  const presetPath = path.join(presetDir, '10-slot-preset.json')
  const timezonePath = path.join(etcDir, 'timezone')
  const localtimePath = path.join(etcDir, 'localtime')

  let prevPresetRaw = ''
  let existingPreset = null
  try {
    prevPresetRaw = fs.readFileSync(presetPath, 'utf8')
    existingPreset = JSON.parse(prevPresetRaw)
  } catch {}

  const telemetryOpt =
    typeof opts.telemetryEnabled === 'boolean'
      ? opts.telemetryEnabled
      : typeof vm?.seed_policy?.telemetry?.enabled === 'boolean'
        ? vm.seed_policy.telemetry.enabled
        : undefined
  const nextPreset = sanitizeSlotPresetObject(existingPreset, {
    timezone: zone,
    locale,
    telemetryEnabled: telemetryOpt,
  })
  const nextPresetRaw = `${JSON.stringify(nextPreset, null, 2)}\n`
  const presetChanged = prevPresetRaw !== nextPresetRaw
  if (presetChanged || !fs.existsSync(presetPath)) {
    fs.mkdirSync(presetDir, { recursive: true, mode: 0o755 })
    if (process.platform !== 'win32') fs.chmodSync(presetDir, 0o755)
    writeFileAtomicMode644(presetPath, nextPresetRaw)
  }

  const nextTzText = `${zone}\n`
  let prevTzText = ''
  try {
    prevTzText = fs.readFileSync(timezonePath, 'utf8')
  } catch {}
  const timezoneChanged = prevTzText !== nextTzText
  if (timezoneChanged || !fs.existsSync(timezonePath)) {
    overwriteRegularFileInPlaceOrCreate(timezonePath, nextTzText)
  }

  const zoneinfoRoot = opts.zoneinfoRoot || '/usr/share/zoneinfo'
  const tzBytes = readValidatedZoneinfoBytes(zone, zoneinfoRoot)
  let localtimeWritten = false
  let localtimeChanged = false
  if (tzBytes) {
    let prevLocaltime = null
    try {
      prevLocaltime = fs.readFileSync(localtimePath)
    } catch {}
    localtimeChanged = !prevLocaltime || !prevLocaltime.equals(tzBytes)
    if (localtimeChanged || !fs.existsSync(localtimePath)) {
      overwriteRegularFileInPlaceOrCreate(localtimePath, tzBytes)
    }
    localtimeWritten = true
  }

  const isRunningDocker = vm?.status === 'running' && !isKvmRuntime(vm)
  return {
    ok: true,
    timezone: zone,
    locale,
    presetPath,
    timezonePath,
    localtimePath,
    presetChanged,
    timezoneChanged,
    localtimeWritten,
    localtimeChanged,
    restart_recommended_for_tz: Boolean(isRunningDocker && (timezoneChanged || localtimeChanged)),
  }
}

/**
 * Push updated timezone / localtime / 10-slot-preset.json to a running KVM
 * `custom-erofs` guest via `kin-slot-agent` `sync_preset_tz` RPC (best-effort).
 */
export async function pushLiveSlotTimezoneSync(projectRoot, vm, syncResult = null, opts = {}) {
  if (!projectRoot || !vm?.id) return { ok: false, skipped: true, reason: 'vm_required' }
  if (!isKvmRuntime(vm) || !isCustomKvmMode({ vm })) {
    return { ok: false, skipped: true, reason: 'not_custom_kvm' }
  }
  const conn = resolveSlotAgentConnection(projectRoot, vm, opts)
  if (!conn.socketPath || !conn.token || !fs.existsSync(conn.socketPath)) {
    return { ok: false, skipped: true, reason: 'agent_unavailable' }
  }
  const etcDir = slotComputerSystemEtcDir(projectRoot, vm.id)
  const timezone = validTimezone(syncResult?.timezone ?? vm?.timezone ?? vm?.fingerprint?.timezone)
  const params = {}
  if (timezone) params.timezone = timezone

  const presetPath =
    syncResult?.presetPath || path.join(etcDir, 'claude-code', 'managed-settings.d', '10-slot-preset.json')
  try {
    const presetBuf = fs.readFileSync(presetPath)
    if (presetBuf.length > 0) {
      params.preset_name = '10-slot-preset.json'
      params.preset_b64 = presetBuf.toString('base64')
      params.preset_sha256 = crypto.createHash('sha256').update(presetBuf).digest('hex')
    }
  } catch {}

  const localtimePath = syncResult?.localtimePath || path.join(etcDir, 'localtime')
  try {
    const ltBuf = fs.readFileSync(localtimePath)
    if (
      ltBuf.length >= 44 &&
      ltBuf.length <= MAX_LOCALTIME_BYTES &&
      ltBuf.subarray(0, 4).toString('ascii') === 'TZif'
    ) {
      params.localtime_b64 = ltBuf.toString('base64')
      params.localtime_sha256 = crypto.createHash('sha256').update(ltBuf).digest('hex')
    }
  } catch {}

  if (!params.timezone && !params.localtime_b64 && !params.preset_b64) {
    return { ok: false, skipped: true, reason: 'nothing_to_push' }
  }
  return callAgentRpc({
    socketPath: conn.socketPath,
    token: conn.token,
    op: 'sync_preset_tz',
    params,
    timeoutMs: opts.timeoutMs ?? 5_000,
  })
}

function runChecked(argv, timeout) {
  try {
    execFileSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    const detail = String(e.stderr || e.stdout || e.message || e).trim()
    throw new Error(detail || 'vm-os computer identity failed')
  }
}

/**
 * Read an existing computer. Create it once when the directory has no identity.
 * The binary's vm-id pick is stable, so a second call must not run it again.
 */
export function ensureSlotComputer(projectRoot, vm, opts = {}) {
  if (!projectRoot || !vm?.id) throw new Error('projectRoot and vm id required')
  const kvm = isKvmRuntime(vm)
  const dir = fingerprintDir(projectRoot, vm.id)
  const ready = kvm ? linuxComputer(dir) : containerComputer(dir)
  if (ready) {
    if (!kvm) ensureContainerComputerSourceFile(dir)
    normalizeFingerprintModes(dir)
    return { ...ready, created: false }
  }
  if (kvm && fs.existsSync(dir)) {
    repairKvmFingerprintUuid(dir)
    const repaired = linuxComputer(dir)
    if (repaired) {
      normalizeFingerprintModes(dir)
      return { ...repaired, created: false }
    }
  }
  const bin = computerBin()
  if (!fs.existsSync(bin)) {
    const missing = new Error('计算机服务未安装。放好 kin-computer 后可再次创建，已完成的身份不会重抽。')
    missing.code = 'computer_service_missing'
    throw missing
  }
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })

  const argv = [bin, 'create', '--runtime', kvm ? 'kvm' : 'docker', '--vm-id', vm.id, '--out', dir]
  const cpuVendor = String(opts.cpuVendor || (kvm ? detectHostCpuVendor() : 'any'))
    .trim()
    .toLowerCase()
  if (cpuVendor === 'amd' || cpuVendor === 'intel' || cpuVendor === 'any') {
    argv.push('--cpu-vendor', cpuVendor)
  }
  argv.push('--os-family', 'debian')
  const tz = validTimezone(opts.timezone ?? vm.timezone ?? vm?.fingerprint?.timezone)
  if (tz) argv.push('--tz', tz)
  const locale = String(opts.locale ?? vm.locale ?? vm?.fingerprint?.locale ?? '').trim()
  if (locale) argv.push('--locale', locale)
  if (vm?.seed_policy?.telemetry?.enabled === true) {
    argv.push('--telemetry', 'on')
  }
  const explicitUser = String(opts.username ?? vm?.fingerprint?.username ?? '').trim()
  if (isValidSlotUsername(explicitUser)) {
    argv.push('--username', explicitUser)
  }
  if (opts.taken?.username && opts.taken.username.size > 0) {
    const excludeList = [...opts.taken.username]
      .map((u) =>
        String(u || '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean)
    if (excludeList.length) argv.push('--exclude-usernames', excludeList.join(','))
  }

  try {
    runChecked(argv, kvm ? 120_000 : 180_000)
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true })
    const failed = new Error(`计算机身份创建失败，目录已清掉，可再次创建：${String(e.message || e).slice(0, 240)}`)
    failed.code = 'computer_create_failed'
    throw failed
  }
  if (kvm) repairKvmFingerprintUuid(dir)
  const written = kvm ? linuxComputer(dir) : containerComputer(dir)
  if (!written) {
    fs.rmSync(dir, { recursive: true, force: true })
    const incomplete = new Error('计算机身份不完整，目录已清掉，可再次创建。')
    incomplete.code = 'computer_create_failed'
    throw incomplete
  }
  if (!kvm) ensureContainerComputerSourceFile(dir)
  normalizeFingerprintModes(dir)
  return { ...written, created: true }
}

/** Control-plane device_id plus the computer hostname, machine-id, and random username. */
export function assignComputerFingerprint(projectRoot, vm, { taken, now, cpuVendor } = {}) {
  const computer = ensureSlotComputer(projectRoot, vm, { taken, cpuVendor })
  if (
    taken?.hostname?.has(computer.hostname) ||
    taken?.guest_machine_id?.has(computer.guest_machine_id) ||
    (computer.username && taken?.username?.has(computer.username))
  ) {
    throw new Error('workstation fingerprint collision')
  }
  const generated = generateWorkstationFingerprint(vm, { taken, now })
  const out = {
    ...generated,
    hostname: computer.hostname,
    guest_machine_id: computer.guest_machine_id,
  }
  if (computer.kernel_profile?.release) {
    out.linux_kernel = String(computer.kernel_profile.release).trim()
  }
  if (isValidSlotUsername(computer.username)) {
    out.username = computer.username
    if (isKvmRuntime(vm) && isCustomKvmMode({ vm })) {
      out.guest_uid = 1000
      out.guest_gid = 1000
    }
  }
  return out
}

/** Point the slot record at the computer. Does not touch device_id or legacy kincli slots. */
export function rememberComputer(projectRoot, vm, computer) {
  if (!computer?.hostname || !vm?.id) return false
  const fp = vm.fingerprint && typeof vm.fingerprint === 'object' ? vm.fingerprint : {}
  const nextUsername =
    !fp.username && !fp.hostname && !fp.device_id && isValidSlotUsername(computer.username) ? computer.username : ''
  const nextGuestIds =
    nextUsername && isKvmRuntime(vm) && isCustomKvmMode({ vm }) && !fp.guest_uid && !fp.guest_gid
      ? { guest_uid: 1000, guest_gid: 1000 }
      : {}
  const same =
    fp.hostname === computer.hostname &&
    String(fp.guest_machine_id || '')
      .trim()
      .toLowerCase() === computer.guest_machine_id &&
    !nextUsername
  if (same) return false
  const patch = {
    hostname: computer.hostname,
    guest_machine_id: computer.guest_machine_id,
    ...(nextUsername ? { username: nextUsername } : {}),
    ...nextGuestIds,
  }
  vm.fingerprint = {
    ...fp,
    ...patch,
  }
  const vmPath = path.join(projectRoot, 'vms', `${vm.id}.json`)
  if (!fs.existsSync(vmPath)) return true
  const disk = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  disk.fingerprint = {
    ...(disk.fingerprint && typeof disk.fingerprint === 'object' ? disk.fingerprint : {}),
    ...patch,
  }
  disk.updated_at = new Date().toISOString()
  atomicWriteJson(vmPath, disk, { mode: 0o600 })
  return true
}
