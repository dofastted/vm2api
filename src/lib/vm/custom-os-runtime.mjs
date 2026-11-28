/**
 * SSOT helpers for the Custom Debian 13 OS + CRAG V4 read-only shared store runtime mode.
 *
 * Defaults strictly to `legacy` unless `KIN_OS_RUNTIME_MODE=custom-os` (or an explicit
 * `runtimeMode` option) is enabled, ensuring 100% backward compatibility and instant rollback.
 */
import fs from 'node:fs'
import path from 'node:path'

export const CUSTOM_OS_RUNTIME_MODE_LEGACY = 'legacy'
export const CUSTOM_OS_RUNTIME_MODE_CUSTOM = 'custom-os'

export const CUSTOM_OS_DEFAULT_KERNEL = 'crag-debian13'
export const CUSTOM_OS_DEBIAN13_KERNEL = 'debian-13'
export const CUSTOM_OS_ASSETS_GUEST_DIR = '/opt/kin-os/crag-debian13'
export const CUSTOM_OS_EROFS_FILENAME = 'kin-kvm-debian-13.erofs'
export const CUSTOM_OS_KERNEL_FILENAME = 'vmlinuz'
export const CUSTOM_OS_INITRD_FILENAME = 'initrd.img'
export const CUSTOM_OS_CUSTOM_KERNEL_FILENAME = 'vmlinuz-custom'
export const CUSTOM_OS_CUSTOM_INITRD_FILENAME = 'initrd.img-custom'
export const KVM_KERNEL_TRACK_OFFICIAL = 'official'
export const KVM_KERNEL_TRACK_CUSTOM = 'custom'
export const CUSTOM_OS_STORE_GUEST_DIR = '/opt/kin/store'
export const CUSTOM_OS_CLAUDE_DIR = `${CUSTOM_OS_STORE_GUEST_DIR}/claude`
export const CUSTOM_OS_CLAUDE_VERSIONS_DIR = `${CUSTOM_OS_CLAUDE_DIR}/versions`
export const CUSTOM_OS_CLAUDE_CURRENT = `${CUSTOM_OS_CLAUDE_DIR}/current`
export const CUSTOM_OS_PROFILES_DIR = `${CUSTOM_OS_STORE_GUEST_DIR}/profiles`
export const CUSTOM_OS_CRAG_DIR = `${CUSTOM_OS_STORE_GUEST_DIR}/crag`
export const CUSTOM_OS_BRIDGE_TMPFS_DIR = '/run/kin/bridge'
export const CUSTOM_OS_BRIDGE_TMPFS_OPTS = 'rw,noexec,nosuid,nodev,size=16m'
export const CUSTOM_OS_MANAGED_SETTINGS_D = '/etc/claude-code/managed-settings.d'

export const KVM_MODE_LEGACY = 'legacy'
export const KVM_MODE_CUSTOM_EROFS = 'custom-erofs'
export const DEFAULT_KVM_VSOCK_PORT = 7070
export const DEFAULT_KVM_AGENT_VSOCK_PORT = 7071
export const DEFAULT_KVM_STORE_MODE = 'auto'
export const DEFAULT_LXCFS_PROC_DIR = '/var/lib/lxcfs/proc'
export const LXCFS_PROC_FILES = Object.freeze(['cpuinfo', 'meminfo', 'stat', 'uptime'])

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/

export function isCragDebian13Kernel(kernel) {
  const value = String(kernel || '')
    .trim()
    .toLowerCase()
  return value === CUSTOM_OS_DEFAULT_KERNEL || value === CUSTOM_OS_DEBIAN13_KERNEL
}

function explicitCustomOsRuntimeMode(options = null) {
  const hasExplicitEnv = options != null && Object.hasOwn(options, 'env')
  const raw =
    options?.runtimeMode ??
    options?.customOsRuntimeMode ??
    (hasExplicitEnv ? options.env?.KIN_OS_RUNTIME_MODE : process.env.KIN_OS_RUNTIME_MODE)
  const value = String(raw || '')
    .trim()
    .toLowerCase()
    .replaceAll('_', '-')
  if (!value) return ''
  if (
    value === 'custom-os' ||
    value === 'debian-13' ||
    value === 'debian13' ||
    value === 'crag-debian13' ||
    value === 'baked'
  ) {
    return CUSTOM_OS_RUNTIME_MODE_CUSTOM
  }
  if (value === 'legacy') return CUSTOM_OS_RUNTIME_MODE_LEGACY
  return ''
}

export function normalizeKvmMode(raw = process.env.KIN_KVM_MODE) {
  const value = String(raw || '')
    .trim()
    .toLowerCase()
    .replaceAll('_', '-')
  if (value === 'custom-erofs' || value === 'erofs' || value === 'custom-os') {
    return KVM_MODE_CUSTOM_EROFS
  }
  if (value === 'legacy' || value === 'qcow2') {
    return KVM_MODE_LEGACY
  }
  return ''
}

/**
 * Resolve KVM runner mode:
 *   1. Explicit `mode` / `kvmMode` / `KIN_KVM_MODE` override (`custom-erofs` or `legacy`).
 *   2. Explicit `runtimeMode` / `KIN_OS_RUNTIME_MODE` override (`custom-os` or `legacy`).
 *   3. Per-slot `crag-debian13` (and compat alias `debian-13`) automatically enables `custom-erofs`.
 *   4. Otherwise defaults strictly to `legacy` for 100% backward compatibility.
 */
export function resolveKvmMode(options = null) {
  const hasExplicitEnv = options != null && Object.hasOwn(options, 'env')
  const explicitRaw =
    options?.mode ?? options?.kvmMode ?? (hasExplicitEnv ? options.env?.KIN_KVM_MODE : process.env.KIN_KVM_MODE)
  const explicit = normalizeKvmMode(explicitRaw)
  if (explicit) return explicit
  const explicitOs = explicitCustomOsRuntimeMode(options)
  if (explicitOs === CUSTOM_OS_RUNTIME_MODE_LEGACY) return KVM_MODE_LEGACY
  if (explicitOs === CUSTOM_OS_RUNTIME_MODE_CUSTOM) return KVM_MODE_CUSTOM_EROFS
  const kernel = options?.kernel ?? options?.vm?.kernel
  if (isCragDebian13Kernel(kernel)) return KVM_MODE_CUSTOM_EROFS
  return KVM_MODE_LEGACY
}

export function isCustomKvmMode(options = null) {
  return resolveKvmMode(options) === KVM_MODE_CUSTOM_EROFS
}

export function normalizeKvmKernelTrack(raw = process.env.KIN_KVM_KERNEL_TRACK) {
  const value = String(raw || '')
    .trim()
    .toLowerCase()
  if (value === KVM_KERNEL_TRACK_CUSTOM) return KVM_KERNEL_TRACK_CUSTOM
  if (value === KVM_KERNEL_TRACK_OFFICIAL) return KVM_KERNEL_TRACK_OFFICIAL
  return ''
}

/**
 * Resolve the KVM guest kernel track (`official` | `custom`).
 * Defaults strictly to `official` for zero-maintenance stability and instant rollback.
 * Remote cluster KVM slots are pinned to `official` in Phase A/initial Phase B so missing
 * custom kernels on remote nodes can never break slot startup.
 */
export function resolveKvmKernelTrack(options = null) {
  const isRemote = options?.isRemote === true || Boolean(String(options?.vm?.node_id || '').trim())
  if (isRemote) return KVM_KERNEL_TRACK_OFFICIAL
  const hasExplicitEnv = options != null && Object.hasOwn(options, 'env')
  const raw =
    options?.kernelTrack ??
    options?.vm?.runtime?.kernel_track ??
    options?.vm?.kernel_track ??
    (hasExplicitEnv ? options.env?.KIN_KVM_KERNEL_TRACK : process.env.KIN_KVM_KERNEL_TRACK)
  return normalizeKvmKernelTrack(raw) || KVM_KERNEL_TRACK_OFFICIAL
}

export function resolveKvmKernelAssets(osAssetsDir = CUSTOM_OS_ASSETS_GUEST_DIR, options = null) {
  const track = resolveKvmKernelTrack(options)
  const base = String(osAssetsDir || CUSTOM_OS_ASSETS_GUEST_DIR).replace(/\/+$/, '')
  const kernelFile = track === KVM_KERNEL_TRACK_CUSTOM ? CUSTOM_OS_CUSTOM_KERNEL_FILENAME : CUSTOM_OS_KERNEL_FILENAME
  const initrdFile = track === KVM_KERNEL_TRACK_CUSTOM ? CUSTOM_OS_CUSTOM_INITRD_FILENAME : CUSTOM_OS_INITRD_FILENAME
  return {
    track,
    kernelFilename: kernelFile,
    initrdFilename: initrdFile,
    kernelPath: `${base}/${kernelFile}`,
    initrdPath: `${base}/${initrdFile}`,
  }
}

/**
 * Fail-closed verification that host custom kernel artifacts exist when `track === 'custom'`.
 */
export function verifyKvmKernelTrackFiles(hostOsDir, options = null) {
  const track = resolveKvmKernelTrack(options)
  const base = String(hostOsDir || '').trim()
  const kernelFile = track === KVM_KERNEL_TRACK_CUSTOM ? CUSTOM_OS_CUSTOM_KERNEL_FILENAME : CUSTOM_OS_KERNEL_FILENAME
  const initrdFile = track === KVM_KERNEL_TRACK_CUSTOM ? CUSTOM_OS_CUSTOM_INITRD_FILENAME : CUSTOM_OS_INITRD_FILENAME
  const kernelPath = base ? path.join(base, kernelFile) : kernelFile
  const initrdPath = base ? path.join(base, initrdFile) : initrdFile
  if (track !== KVM_KERNEL_TRACK_CUSTOM) {
    return { ok: true, track, kernelPath, initrdPath }
  }
  const lstatSync = options?.lstatSync ?? fs.lstatSync
  for (const [label, filePath] of [
    ['custom kernel', kernelPath],
    ['custom initrd', initrdPath],
  ]) {
    try {
      const st = lstatSync(filePath)
      if (st.isSymbolicLink() || !st.isFile() || st.size <= 0) {
        return {
          ok: false,
          code: 'kvm_custom_kernel_invalid',
          track,
          error: `${label} must be a non-empty regular file: ${filePath}`,
        }
      }
    } catch {
      return {
        ok: false,
        code: 'kvm_custom_kernel_missing',
        track,
        error: `KIN_KVM_KERNEL_TRACK=custom requires ${label}: ${filePath}`,
      }
    }
  }
  return { ok: true, track, kernelPath, initrdPath }
}

export { detectHostCpuVendor } from './slot-identity.mjs'

/**
 * Probe whether `/dev/vhost-vsock` is genuinely backed by the loaded `vhost_vsock` kernel
 * driver rather than a dead static devtmpfs node (which passes `existsSync` / `stat` but
 * fails `open(O_RDWR)` with `ENODEV`, as observed on hosts with upgraded modules pre-reboot).
 */
export function isVhostVsockUsable(
  devPath = '/dev/vhost-vsock',
  { openSync = fs.openSync, closeSync = fs.closeSync } = {},
) {
  let fd
  try {
    fd = openSync(devPath, fs.constants.O_RDWR)
    return true
  } catch {
    return false
  } finally {
    if (fd != null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

export function isDockerLxcfsEnabled(options = null) {
  if (typeof options?.lxcfs === 'boolean') return options.lxcfs
  const raw = String(options?.env?.KIN_DOCKER_LXCFS ?? process.env.KIN_DOCKER_LXCFS ?? '')
    .trim()
    .toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/**
 * Optional read-only LXCFS `/proc/{cpuinfo,meminfo,stat,uptime}` mounts for Docker slots.
 * Disabled by default; only emits mounts when explicitly opted in (`KIN_DOCKER_LXCFS=1`)
 * AND all four host LXCFS proc files exist.
 */
export function dockerLxcfsMountArgs({
  lxcfs,
  env,
  lxcfsProcDir = DEFAULT_LXCFS_PROC_DIR,
  hostOf = (p) => p,
  existsSync = fs.existsSync,
} = {}) {
  if (!isDockerLxcfsEnabled({ lxcfs, env })) return []
  const base = String(lxcfsProcDir || DEFAULT_LXCFS_PROC_DIR).replace(/\/+$/, '')
  const pairs = LXCFS_PROC_FILES.map((name) => ({
    hostPath: `${base}/${name}`,
    guestPath: `/proc/${name}`,
  }))
  if (!pairs.every((p) => existsSync(p.hostPath))) return []
  return pairs.flatMap((p) => ['-v', `${hostOf(p.hostPath)}:${p.guestPath}:ro`])
}

export function normalizeCustomOsRuntimeMode(raw = process.env.KIN_OS_RUNTIME_MODE) {
  const value = String(raw || '')
    .trim()
    .toLowerCase()
    .replaceAll('_', '-')
  if (
    value === 'custom-os' ||
    value === 'debian-13' ||
    value === 'debian13' ||
    value === 'crag-debian13' ||
    value === 'baked'
  ) {
    return CUSTOM_OS_RUNTIME_MODE_CUSTOM
  }
  return CUSTOM_OS_RUNTIME_MODE_LEGACY
}

export function isCustomOsMode(options = null) {
  return explicitCustomOsRuntimeMode(options) === CUSTOM_OS_RUNTIME_MODE_CUSTOM
}

export function isCustomOsRuntimeMode(options = null) {
  return isCustomOsMode(options)
}

/**
 * Per-slot SSOT check for Custom Debian 13 OS mode:
 *   - Explicit `runtimeMode: 'legacy'` or `KIN_OS_RUNTIME_MODE=legacy` forces rollback off.
 *   - Explicit `runtimeMode: 'custom-os'` or `KIN_OS_RUNTIME_MODE=custom-os` enables globally.
 *   - Without a global override, `vm.kernel === 'crag-debian13'` (or compat `'debian-13'`)
 *     or explicit per-slot `custom_os` / `shared_store` flags enable automatically.
 */
export function isCustomOsSlot(vm = null, options = null) {
  const explicit = explicitCustomOsRuntimeMode(options)
  if (explicit === CUSTOM_OS_RUNTIME_MODE_LEGACY) return false
  if (explicit === CUSTOM_OS_RUNTIME_MODE_CUSTOM) return true
  const kernel = options?.kernel ?? vm?.kernel
  if (isCragDebian13Kernel(kernel)) return true
  if (vm?.runtime?.runtime_mode !== undefined) {
    return normalizeCustomOsRuntimeMode(vm.runtime.runtime_mode) === CUSTOM_OS_RUNTIME_MODE_CUSTOM
  }
  return vm?.runtime?.custom_os === true || vm?.runtime?.shared_store === true || vm?.shared_store === true
}

export function resolveHostSharedStoreDir(projectRoot = '', options = null) {
  const explicit = String(
    options?.sharedStoreHostDir ??
      options?.sharedClaudeStoreRoot ??
      options?.env?.KIN_SHARED_STORE_DIR ??
      process.env.KIN_SHARED_STORE_DIR ??
      '',
  ).trim()
  if (explicit) return path.resolve(explicit)
  if (projectRoot) return path.resolve(projectRoot, 'store')
  return ''
}

export function resolveHostCragDebian13OsDir(projectRoot = '', options = null) {
  const hasExplicitEnv = options != null && Object.hasOwn(options, 'env')
  const explicit = String(
    options?.osAssetsHostDir ??
      (hasExplicitEnv ? options.env?.KIN_CRAG_DEBIAN13_OS_DIR : process.env.KIN_CRAG_DEBIAN13_OS_DIR) ??
      '',
  ).trim()
  if (explicit) return path.resolve(explicit)
  if (projectRoot) return path.resolve(projectRoot, 'share', 'os', 'crag-debian13')
  return ''
}

export function sharedClaudeGuestPath(version = '', storeGuestDir = CUSTOM_OS_STORE_GUEST_DIR) {
  const base = String(storeGuestDir || CUSTOM_OS_STORE_GUEST_DIR).replace(/\/+$/, '')
  if (typeof version === 'string' && SEMVER_RE.test(version)) {
    return `${base}/claude/versions/${version}/claude`
  }
  return `${base}/claude/current`
}

export function sharedProfilesGuestDir(storeGuestDir = CUSTOM_OS_STORE_GUEST_DIR) {
  const base = String(storeGuestDir || CUSTOM_OS_STORE_GUEST_DIR).replace(/\/+$/, '')
  return `${base}/profiles`
}

/**
 * Strictly validate that `targetPath` lies inside `allowedPrefix` with zero symlink traversal
 * (`O_NOFOLLOW` semantics on every component under `allowedPrefix`), is a regular file, and
 * meets executable / non-writable mode invariants on POSIX platforms.
 */
export function validateReadOnlyNoFollowPath(
  targetPath,
  allowedPrefix,
  { requireExecutable = false, requireNotWritable = process.platform !== 'win32' } = {},
) {
  if (typeof targetPath !== 'string' || !targetPath || targetPath.includes('\0')) {
    return { ok: false, code: 'shared_store_path_invalid', error: 'target path is empty or contains NUL' }
  }
  if (typeof allowedPrefix !== 'string' || !allowedPrefix || allowedPrefix.includes('\0')) {
    return { ok: false, code: 'shared_store_prefix_invalid', error: 'allowed store prefix is missing' }
  }

  let realPrefix
  try {
    const prefixStat = fs.lstatSync(allowedPrefix)
    if (prefixStat.isSymbolicLink() || !prefixStat.isDirectory()) {
      return { ok: false, code: 'shared_store_prefix_invalid', error: 'store prefix must be a real directory' }
    }
    realPrefix = fs.realpathSync(allowedPrefix)
  } catch {
    return { ok: false, code: 'shared_store_prefix_missing', error: 'store prefix directory is missing' }
  }

  const resolvedTarget = path.resolve(targetPath)
  const rel = path.relative(realPrefix, resolvedTarget)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      ok: false,
      code: 'shared_store_path_escape',
      error: `target path escapes read-only store whitelist: ${targetPath}`,
    }
  }

  const parts = rel.split(path.sep).filter(Boolean)
  let current = realPrefix
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]
    if (part === '.' || part === '..') {
      return { ok: false, code: 'shared_store_path_escape', error: 'unsafe path component' }
    }
    current = path.join(current, part)
    let st
    try {
      st = fs.lstatSync(current)
    } catch {
      return { ok: false, code: 'shared_store_target_missing', error: `missing store path: ${current}` }
    }
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        code: 'shared_store_symlink_rejected',
        error: `symlink rejected inside read-only store path: ${current}`,
      }
    }
    const isLast = i === parts.length - 1
    if (!isLast && !st.isDirectory()) {
      return { ok: false, code: 'shared_store_path_invalid', error: `expected directory component: ${current}` }
    }
    if (isLast) {
      if (!st.isFile()) {
        return { ok: false, code: 'shared_store_path_invalid', error: `target must be a regular file: ${current}` }
      }
      if (requireExecutable && process.platform !== 'win32' && !(st.mode & 0o111)) {
        return {
          ok: false,
          code: 'shared_store_not_executable',
          error: `shared store binary is missing executable permission: ${current}`,
        }
      }
      if (requireNotWritable && process.platform !== 'win32' && (st.mode & 0o222) !== 0) {
        return {
          ok: false,
          code: 'shared_store_writable_rejected',
          error: `shared store binary must be read-only (non-writable): ${current}`,
        }
      }
    }
  }

  let fd
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    fd = fs.openSync(current, flags)
    const fst = fs.fstatSync(fd)
    if (!fst.isFile()) {
      return { ok: false, code: 'shared_store_path_invalid', error: 'opened target is not a regular file' }
    }
  } catch (err) {
    return {
      ok: false,
      code: err?.code === 'ELOOP' ? 'shared_store_symlink_rejected' : 'shared_store_open_failed',
      error: `O_NOFOLLOW open failed: ${err?.message || err}`,
    }
  } finally {
    if (fd != null) fs.closeSync(fd)
  }

  return { ok: true, path: current }
}
