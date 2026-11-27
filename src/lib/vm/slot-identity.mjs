/**
 * Single source of truth (SSOT) for per-slot OS username, home directory,
 * KVM custom-erofs guest UID/GID, and host CPU vendor detection.
 *
 * Legacy slots without a valid `vm.fingerprint.username` always fall back to
 * `kincli` / `/home/kincli` (and `999:987` for KVM custom-erofs) for zero-break
 * backward compatibility.
 */
import fs from 'node:fs'

export const DEFAULT_SLOT_USER = 'kincli'
export const DEFAULT_SLOT_HOME = '/home/kincli'

export const SLOT_USERNAME_RE = /^[a-z][a-z0-9_-]{2,15}$/

export const RESERVED_SLOT_USERNAMES = Object.freeze(
  new Set([
    // Linux / Debian system accounts & groups
    'root',
    'daemon',
    'bin',
    'sys',
    'sync',
    'games',
    'man',
    'lp',
    'mail',
    'news',
    'uucp',
    'proxy',
    'www-data',
    'backup',
    'list',
    'irc',
    '_apt',
    'apt',
    'nobody',
    'nogroup',
    'systemd',
    'systemd-network',
    'systemd-resolve',
    'systemd-timesync',
    'systemd-journal',
    'messagebus',
    'sshd',
    'ssh',
    'tss',
    'polkitd',
    'chrony',
    'ntp',
    'postfix',
    'docker',
    'kvm',
    'libvirt',
    'qemu',
    'ubuntu',
    'debian',
    'fedora',
    'arch',
    'alpine',
    'centos',
    'sudo',
    'wheel',
    'staff',
    'adm',
    'shadow',
    'tty',
    'disk',
    'audio',
    'video',
    'plugdev',
    'netdev',
    'users',
    // Platform / product / generic test names
    'kin',
    'kincli',
    'kinslot',
    'vm2api',
    'crag',
    'claude',
    'anthropic',
    'admin',
    'administrator',
    'user',
    'guest',
    'test',
    'tester',
    'demo',
    'default',
    'operator',
    'service',
    'sandbox',
    'container',
    'worker',
    'bot',
    'agent',
    'dev',
    'devbox',
  ]),
)

export function isValidSlotUsername(name) {
  if (typeof name !== 'string') return false
  const trimmed = name.trim()
  if (trimmed !== name) return false
  if (!SLOT_USERNAME_RE.test(trimmed)) return false
  if (trimmed.endsWith('-') || trimmed.endsWith('_')) return false
  if (trimmed.includes('--')) return false
  if (trimmed.startsWith('systemd-')) return false
  if (RESERVED_SLOT_USERNAMES.has(trimmed)) return false
  return true
}

export function slotUser(vm) {
  const raw = vm?.fingerprint?.username
  return isValidSlotUsername(raw) ? raw : DEFAULT_SLOT_USER
}

export function slotHome(vm) {
  return `/home/${slotUser(vm)}`
}

export function slotClaudeDir(vm) {
  return `${slotHome(vm)}/.claude`
}

export function isCustomSlotUser(vm) {
  return slotUser(vm) !== DEFAULT_SLOT_USER
}

function positiveUidGid(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 && value <= 0x7fffffff ? value : null
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim())
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 0x7fffffff ? parsed : null
  }
  return null
}

/**
 * Resolve KVM custom-erofs Guest UID/GID for a slot.
 * - Explicit positive integer `vm.fingerprint.guest_uid/gid` wins.
 * - Otherwise `kincli` (legacy slots) -> 999:987; custom random user -> 1000:1000.
 */
export function slotGuestUidGid(vm) {
  const uid = positiveUidGid(vm?.fingerprint?.guest_uid)
  const gid = positiveUidGid(vm?.fingerprint?.guest_gid)
  if (uid !== null && gid !== null) return { uid, gid }
  if (slotUser(vm) === DEFAULT_SLOT_USER) return { uid: 999, gid: 987 }
  return { uid: 1000, gid: 1000 }
}

/**
 * Detect host CPU vendor (`'amd' | 'intel' | 'any'`) from `/proc/cpuinfo`
 * (or explicit `KIN_KVM_HOST_CPU_VENDOR` / `KIN_HOST_CPU_VENDOR` override).
 */
export function detectHostCpuVendor({
  cpuinfoPath = '/proc/cpuinfo',
  readFileSync = fs.readFileSync,
  env = process.env,
} = {}) {
  const override = String(env?.KIN_KVM_HOST_CPU_VENDOR ?? env?.KIN_HOST_CPU_VENDOR ?? '')
    .trim()
    .toLowerCase()
  if (override === 'amd' || override === 'authenticamd') return 'amd'
  if (override === 'intel' || override === 'genuineintel') return 'intel'
  if (override === 'any') return 'any'
  try {
    const text = readFileSync(cpuinfoPath, 'utf8')
    const match = text.match(/^\s*vendor_id\s*:\s*(\S+)/m)
    const vendor = String(match?.[1] || '').trim()
    if (vendor === 'AuthenticAMD') return 'amd'
    if (vendor === 'GenuineIntel') return 'intel'
  } catch {}
  return 'any'
}
