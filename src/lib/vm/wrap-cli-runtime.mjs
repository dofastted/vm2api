/**
 * Wrap inference CLIs live in the slot home, next to the kernel.
 * share/wrap-cli holds the factory CLIs; an atomic sibling-cache pointer may
 * select a pulled cli-node/kernel pair. cc-node remains a separate legacy asset.
 * The dataplane picks which executable kernel.json.claude_bin runs:
 *   wrap: cli-node + wrap kin-kernel
 *   cc:   cc-node + wrap kin-kernel
 *   crag + legacy: cc-node + share/crag/kin-kernel
 *   crag + v2: native CRAG worker, only when this VM pins crag_kernel_version=v2
 * Engine rust only chooses which process serves /v1. Credentials stay out.
 * Switching one VM never deletes cli-node and never rewrites routing.json.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { kernelBinPath } from '../transport/rust-kernel-supervisor.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { nativeCliForVm, NATIVE_CLI_FILES } from './native-cli.mjs'
import { resolveCragKernelVersion, resolveKernelDataplane } from './slot-engine.mjs'
import { checkCragLicense, decodeLicenseBytes } from './crag-license.mjs'

export const WRAP_CLI_BIN = 'cli-node'
export const CC_NODE_BIN = 'cc-node'
export const WRAP_CLI_FILES = Object.freeze([WRAP_CLI_BIN, CC_NODE_BIN])
export const WRAP_KERNEL_BIN = 'kin-kernel.bin'
export const WRAP_KERNEL_WRAPPER = 'kin-kernel'
export const WRAP_GLIBC_DIR = 'glibc239'
export const WRAP_GLIBC_LIBS = Object.freeze(['ld-linux-x86-64.so.2', 'libc.so.6', 'libm.so.6', 'libgcc_s.so.1'])

const SECRET_NAMES = new Set(['credentials.json', '.credentials.json', 'oauth.json', '.claude.json', 'internal.token'])

/**
 * The kernel job watchdog reads the unprefixed env JOB_IDLE_SECS (default 180s)
 * only at start; KIN_JOB_IDLE_SECS is ignored by the kernel. Take it from
 * kernel.json idle_timeout_seconds so it follows the panel stream idle setting.
 */
export function wrapKernelWrapperScript() {
  return `#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -z "$JOB_IDLE_SECS" ]; then
  CONF=
  PREV=
  for ARG in "$@"; do
    [ "$PREV" = "--config" ] && CONF=$ARG
    PREV=$ARG
  done
  if [ -n "$CONF" ] && [ -r "$CONF" ]; then
    IDLE=$(grep -o '"idle_timeout_seconds": *[0-9]*' "$CONF" | head -n 1 | tr -dc '0-9')
    [ -n "$IDLE" ] && [ "$IDLE" -gt 0 ] && export JOB_IDLE_SECS="$IDLE"
  fi
fi
BIN="$DIR/${WRAP_KERNEL_BIN}"
LOADER="$DIR/${WRAP_GLIBC_DIR}/ld-linux-x86-64.so.2"
if [ -x "$LOADER" ] && [ -x "$BIN" ]; then
  exec "$LOADER" --library-path "$DIR/${WRAP_GLIBC_DIR}" "$BIN" "$@"
fi
if [ -x "$BIN" ]; then
  exec "$BIN" "$@"
fi
exec "$DIR/${WRAP_KERNEL_WRAPPER}.real" "$@"
`
}

export function cragKernelWrapperScript() {
  return `#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIN="$DIR/${WRAP_KERNEL_BIN}"
LOADER="$DIR/${WRAP_GLIBC_DIR}/ld-linux-x86-64.so.2"
if [ -x "$LOADER" ] && [ -x "$BIN" ]; then
  exec "$LOADER" --library-path "$DIR/${WRAP_GLIBC_DIR}" "$BIN" "$@"
fi
if [ -x "$BIN" ]; then
  exec "$BIN" "$@"
fi
exec "$DIR/${WRAP_KERNEL_WRAPPER}.real" "$@"
`
}

export const CRAG_V2_DIR = 'crag-v2'
const CRAG_V2_ENTRY = 'crag-v2'
const CRAG_V2_CLAUDE = 'claude-code-2.1.317/claude'
const CRAG_V2_CAPS = Object.freeze(['official_full', 'zero', 'cancel', 'telemetry', 'unix_socket_envelope'])

export function cragV2Arch() {
  if (process.arch === 'x64') return 'amd64'
  if (process.arch === 'arm64') return 'arm64'
  return process.arch
}

// A cache pointer is data, never a symlink or an arbitrary filesystem path.
function cachedPackageRoot(base, arch) {
  const pointer = path.join(base, `current-${arch}.json`)
  const invalid = () =>
    Object.assign(new Error('内核缓存选择无效或不可读，请重新拉取内核'), { code: 'kernel_cache_invalid' })
  let st
  try {
    st = fs.lstatSync(pointer)
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw invalid()
  }
  try {
    if (!st.isFile() || st.size > 4096) throw invalid()
    const value = JSON.parse(fs.readFileSync(pointer, 'utf8'))
    if (!new RegExp(`^packages/${arch}-[a-f0-9-]{36}$`).test(value?.package)) throw invalid()
    const packages = path.join(base, 'packages')
    const target = path.join(base, value.package)
    if (!fs.lstatSync(packages).isDirectory() || !fs.lstatSync(target).isDirectory()) throw invalid()
    return target
  } catch {
    throw invalid()
  }
}
/** Package location only. This does not select v2 for VMs that omitted the version. */
export function cragV2PackageRoot(projectRoot) {
  const env = String(process.env.KIN_CRAG_V2_ROOT || '').trim()
  if (env && isFile(path.join(env, 'manifest.json'))) return env
  if (!projectRoot) return ''
  const base = path.join(projectRoot, 'share', 'crag', 'kernels', 'v2')
  const cached = cachedPackageRoot(base, cragV2Arch())
  if (cached) {
    if (!isFile(path.join(cached, 'manifest.json')))
      throw Object.assign(new Error('CRAG 缓存缺少发行清单，请重新拉取'), { code: 'kernel_cache_invalid' })
    return cached
  }
  const staged = path.join(base, cragV2Arch())
  return isFile(path.join(staged, 'manifest.json')) ? staged : ''
}

export function cragV2KernelWrapperScript() {
  return `#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$DIR/${CRAG_V2_DIR}/${CRAG_V2_ENTRY}" "$@"
`
}

function cragV2PlacementError(vm) {
  if (String(vm?.node_id || '').trim() || isKvmRuntime(vm)) {
    return {
      ok: false,
      code: 'crag_v2_unsupported_placement',
      error: 'CRAG v2 only runs on a local Linux Docker slot',
    }
  }
  return null
}

function listCragV2Files(dir, prefix = '') {
  const rows = []
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { ok: false, code: 'crag_v2_package_missing', error: 'CRAG v2 package directory is missing' }
  }
  for (const name of names) {
    const rel = prefix ? `${prefix}/${name}` : name
    if (rel.split('/').some((part) => part === '..' || part === '')) {
      return { ok: false, code: 'crag_v2_manifest_invalid', error: `CRAG v2 path is unsafe: ${rel}` }
    }
    const abs = path.join(dir, name)
    let st
    try {
      st = fs.lstatSync(abs)
    } catch {
      return { ok: false, code: 'crag_v2_package_missing', error: `CRAG v2 package missing ${rel}` }
    }
    if (st.isSymbolicLink()) {
      return { ok: false, code: 'crag_v2_symlink', error: `CRAG v2 package symlink is not allowed: ${rel}` }
    }
    if (st.isDirectory()) {
      const nested = listCragV2Files(abs, rel)
      if (nested.ok === false) return nested
      rows.push(...nested)
    } else if (st.isFile()) rows.push(rel)
    else
      return {
        ok: false,
        code: 'crag_v2_manifest_invalid',
        error: `CRAG v2 package member is not a regular file: ${rel}`,
      }
  }
  return rows
}

export function verifyCragV2Tree(dir) {
  try {
    const root = fs.lstatSync(dir)
    if (root.isSymbolicLink())
      return { ok: false, code: 'crag_v2_symlink', error: 'CRAG v2 package root must not be a symlink' }
    if (!root.isDirectory())
      return { ok: false, code: 'crag_v2_package_missing', error: 'CRAG v2 package root must be a directory' }
  } catch {
    return { ok: false, code: 'crag_v2_package_missing', error: 'CRAG v2 package directory is missing' }
  }
  const listed = listCragV2Files(dir)
  if (listed.ok === false) return listed
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  } catch {
    return { ok: false, code: 'crag_v2_manifest_invalid', error: 'CRAG v2 manifest.json is missing or invalid' }
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, code: 'crag_v2_manifest_invalid', error: 'CRAG v2 manifest must be an object' }
  }
  if (manifest.family !== 'crag' || manifest.version !== 'v2') {
    return { ok: false, code: 'crag_v2_manifest_invalid', error: 'CRAG v2 manifest family/version mismatch' }
  }
  if (!['amd64', 'arm64'].includes(manifest.arch) || manifest.arch !== cragV2Arch()) {
    return {
      ok: false,
      code: 'crag_v2_arch_mismatch',
      error: `CRAG v2 arch ${manifest.arch} does not match ${cragV2Arch()}`,
    }
  }
  if (manifest.encrypted !== true || manifest.runtime !== 'native' || manifest.entrypoint !== CRAG_V2_ENTRY) {
    return {
      ok: false,
      code: 'crag_v2_manifest_invalid',
      error: 'CRAG v2 requires runtime=native and entrypoint=crag-v2',
    }
  }
  if (!Array.isArray(manifest.capabilities) || CRAG_V2_CAPS.some((cap) => !manifest.capabilities.includes(cap))) {
    return { ok: false, code: 'crag_v2_capabilities', error: 'CRAG v2 manifest is missing required capabilities' }
  }
  if (!manifest.sha256 || typeof manifest.sha256 !== 'object' || Array.isArray(manifest.sha256)) {
    return { ok: false, code: 'crag_v2_manifest_invalid', error: 'CRAG v2 manifest sha256 map is missing' }
  }
  const expected = new Set(Object.keys(manifest.sha256))
  for (const required of [CRAG_V2_ENTRY, CRAG_V2_CLAUDE, 'crag-license-public.pem', 'crag-v2.payload.enc']) {
    if (!expected.has(required)) {
      return { ok: false, code: 'crag_v2_manifest_invalid', error: `CRAG v2 manifest does not hash ${required}` }
    }
  }
  const present = new Set(listed.filter((rel) => rel !== 'manifest.json'))
  for (const rel of expected) {
    if (
      rel.includes('\\') ||
      rel.includes('\0') ||
      rel.includes(':') ||
      rel.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      return { ok: false, code: 'crag_v2_manifest_invalid', error: `CRAG v2 manifest path is unsafe: ${rel}` }
    }
    if (!/^[a-f0-9]{64}$/.test(manifest.sha256[rel])) {
      return { ok: false, code: 'crag_v2_manifest_invalid', error: 'CRAG v2 hashes must be lowercase SHA-256' }
    }
    if (
      rel === 'crag-v2-core' ||
      /(?:^|\/)(?:src|node_modules)(?:\/|$)/.test(rel) ||
      /\.(?:[cm]?js|rs|pem\.key)$/.test(rel) ||
      /(?:private|payload-key|crag-license(?:\.exe)?$)/i.test(rel)
    ) {
      return {
        ok: false,
        code: 'crag_v2_manifest_invalid',
        error: 'CRAG v2 package contains prohibited plaintext or supplier material',
      }
    }
    if (!present.has(rel)) return { ok: false, code: 'crag_v2_hash_mismatch', error: `CRAG v2 package missing ${rel}` }
  }
  for (const rel of present) {
    if (!expected.has(rel)) {
      return { ok: false, code: 'crag_v2_hash_mismatch', error: `CRAG v2 package has unlisted file ${rel}` }
    }
    const file = path.join(dir, rel)
    const body = fs.readFileSync(file)
    const digest = crypto.createHash('sha256').update(body).digest('hex')
    if (digest !== manifest.sha256[rel]) {
      return { ok: false, code: 'crag_v2_hash_mismatch', error: `CRAG v2 hash mismatch: ${rel}` }
    }
    const requiredElf = rel === CRAG_V2_ENTRY || rel === CRAG_V2_CLAUDE
    if (requiredElf || body.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      if (!requiredElf)
        return {
          ok: false,
          code: 'crag_v2_manifest_invalid',
          error: 'CRAG v2 may only ship the native bootstrap and separate official Claude executables',
        }
      if (
        body.length < 64 ||
        body.readUInt32BE(0) !== 0x7f454c46 ||
        body[4] !== 2 ||
        body[5] !== 1 ||
        body[6] !== 1 ||
        ![2, 3].includes(body.readUInt16LE(16))
      ) {
        return { ok: false, code: 'crag_v2_elf_invalid', error: `CRAG v2 requires a Linux ELF64 executable: ${rel}` }
      }
      const machine = body.readUInt16LE(18)
      if (machine !== (manifest.arch === 'amd64' ? 62 : 183)) {
        return {
          ok: false,
          code: 'crag_v2_arch_mismatch',
          error: `CRAG v2 ELF machine does not match ${manifest.arch}: ${rel}`,
        }
      }
      if (requiredElf && !(fs.statSync(file).mode & 0o111)) {
        return { ok: false, code: 'crag_v2_elf_invalid', error: `CRAG v2 executable permission is missing: ${rel}` }
      }
    }
  }
  try {
    const auth = manifest.authorization
    const payload = manifest.payload
    const pem = fs.readFileSync(path.join(dir, 'crag-license-public.pem'), 'utf8')
    if (!/^-----BEGIN PUBLIC KEY-----\s+[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(pem))
      throw new Error('public key')
    const pub = crypto.createPublicKey(pem)
    const raw = pub.export({ format: 'der', type: 'spki' }).subarray(-32)
    if (
      pub.asymmetricKeyType !== 'ed25519' ||
      auth?.scheme !== 'ed25519-x25519-v1' ||
      auth.product !== 'crag-v2' ||
      !decodeLicenseBytes(auth.public_key, 32).equals(raw) ||
      auth.public_key_id !== crypto.createHash('sha256').update(raw).digest('hex') ||
      payload?.path !== 'crag-v2.payload.enc' ||
      payload.format !== 'CRAGV2E1' ||
      payload.algorithm !== 'aes-256-gcm' ||
      ![payload.key_id, payload.plaintext_sha256, payload.ciphertext_sha256].every(
        (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
      ) ||
      payload.ciphertext_sha256 !== manifest.sha256[payload.path]
    )
      throw new Error('metadata')
    const bytes = fs.readFileSync(path.join(dir, payload.path))
    if (bytes.length <= 36 || bytes.subarray(0, 8).toString('ascii') !== 'CRAGV2E1') throw new Error('payload')
    const signed = {
      product: 'crag-v2',
      format: payload.format,
      algorithm: payload.algorithm,
      key_id: payload.key_id,
      plaintext_sha256: payload.plaintext_sha256,
      ciphertext_sha256: payload.ciphertext_sha256,
    }
    if (
      !crypto.verify(
        null,
        Buffer.concat([Buffer.from('CRAG-PAYLOAD-V1\0'), Buffer.from(JSON.stringify(signed))]),
        pub,
        decodeLicenseBytes(payload.signature, 64),
      )
    )
      throw new Error('signature')
  } catch {
    return { ok: false, code: 'crag_v2_manifest_invalid', error: 'CRAG v2 encrypted package authorization is invalid' }
  }
  return { ok: true, manifest }
}

function stageCragV2Tree(src, dest) {
  const parent = path.dirname(dest)
  const staging = fs.mkdtempSync(path.join(parent, `.${path.basename(dest)}.new-`))
  const backup = `${staging}.bak`
  let had = false
  try {
    fs.cpSync(src, staging, { recursive: true, dereference: false })
    // mkdtemp is 0700. The slot user is not root, so it cannot exec the bootstrap inside it.
    fs.chmodSync(staging, 0o755)
    const verified = verifyCragV2Tree(staging)
    if (!verified.ok) {
      fs.rmSync(staging, { recursive: true, force: true })
      return verified
    }
    try {
      fs.lstatSync(dest)
      had = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (had) fs.renameSync(dest, backup)
    try {
      fs.renameSync(staging, dest)
    } catch (error) {
      if (had) fs.renameSync(backup, dest)
      throw error
    }
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    return { ok: false, code: 'crag_v2_stage_failed', error: String(error?.message || error) }
  }
  return {
    ok: true,
    rollback() {
      fs.rmSync(dest, { recursive: true, force: true })
      if (had) fs.renameSync(backup, dest)
    },
    commit() {
      fs.rmSync(backup, { recursive: true, force: true })
    },
  }
}

function cragV2WouldChange(src, destDir) {
  const destRoot = path.join(destDir, CRAG_V2_DIR)
  if (!filesEqual(path.join(src, 'manifest.json'), path.join(destRoot, 'manifest.json'))) return true
  if (verifyCragV2Tree(destRoot).ok !== true) return true
  try {
    const wrapper = fs.lstatSync(path.join(destDir, WRAP_KERNEL_WRAPPER))
    if (!wrapper.isFile() || !(wrapper.mode & 0o111)) return true
    if (fs.readFileSync(path.join(destDir, WRAP_KERNEL_WRAPPER), 'utf8') !== cragV2KernelWrapperScript()) return true
  } catch {
    return true
  }
  return false
}

function writeCragV2Wrapper(destDir) {
  const wrapper = path.join(destDir, WRAP_KERNEL_WRAPPER)
  const body = cragV2KernelWrapperScript()
  try {
    const st = fs.lstatSync(wrapper)
    if (st.isFile() && st.mode & 0o111 && fs.readFileSync(wrapper, 'utf8') === body) return
  } catch {}
  const tmp = path.join(destDir, `.${WRAP_KERNEL_WRAPPER}.${crypto.randomUUID()}.new`)
  try {
    fs.writeFileSync(tmp, body, { mode: 0o755, flag: 'wx' })
    fs.renameSync(tmp, wrapper)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
}

export function materializeCragV2(projectRoot, vm, { uid = null, gid = null } = {}) {
  if (!projectRoot || !vm?.id) {
    return { ok: false, code: 'vm_required', error: 'projectRoot and vm id required' }
  }
  const placement = cragV2PlacementError(vm)
  if (placement) return placement
  let src
  try {
    src = cragV2PackageRoot(projectRoot)
  } catch (error) {
    return { ok: false, code: error.code, error: error.message }
  }
  if (!src) {
    return {
      ok: false,
      code: 'crag_v2_package_missing',
      error: 'CRAG v2 package missing (share/crag/kernels/v2/<arch> or KIN_CRAG_V2_ROOT)',
    }
  }
  const verified = verifyCragV2Tree(src)
  if (!verified.ok) return verified
  const licensed = checkCragLicense(projectRoot, { ...vm, dataplane: 'crag' })
  if (!licensed.ok) return licensed
  const dest = wrapCliHomeDir(projectRoot, vm.id)
  fs.mkdirSync(dest, { recursive: true })
  if (!cragV2WouldChange(src, dest)) {
    try {
      fs.chmodSync(path.join(dest, CRAG_V2_DIR), 0o755)
    } catch {}
    chownTree(dest, uid, gid)
    return {
      ok: true,
      dest,
      src,
      dataplane: 'crag',
      kernel_version: 'v2',
      runtime_variant: 'crag-v2',
      changed: false,
      kernel_changed: false,
      glibc_shim: false,
      wrapper: true,
      kernel_bin: true,
    }
  }
  const tree = stageCragV2Tree(src, path.join(dest, CRAG_V2_DIR))
  if (!tree.ok) return tree
  try {
    writeCragV2Wrapper(dest)
  } catch (error) {
    tree.rollback()
    return { ok: false, code: 'crag_v2_stage_failed', error: String(error?.message || error) }
  }
  tree.commit()
  chownTree(dest, uid, gid)
  return {
    ok: true,
    dest,
    src,
    dataplane: 'crag',
    kernel_version: 'v2',
    runtime_variant: 'crag-v2',
    changed: true,
    kernel_changed: true,
    glibc_shim: false,
    wrapper: isFile(path.join(dest, WRAP_KERNEL_WRAPPER)),
    kernel_bin: isFile(path.join(dest, CRAG_V2_DIR, CRAG_V2_ENTRY)),
  }
}

export function cragTemplateDir(projectRoot) {
  const env = String(process.env.KIN_CRAG_KERNEL_ROOT || '').trim()
  if (env) return env
  if (!projectRoot) return ''
  return path.join(projectRoot, 'share', 'crag')
}

export function cragKernelPath(projectRoot) {
  const env = String(process.env.KIN_CRAG_KERNEL_BIN || '').trim()
  if (env && isFile(env)) return env
  const dir = cragTemplateDir(projectRoot)
  if (!dir) return ''
  const bin = path.join(dir, 'kin-kernel')
  if (isFile(bin)) return bin
  const alt = path.join(dir, WRAP_KERNEL_BIN)
  return isFile(alt) ? alt : ''
}

function cliPayloadPath(projectRoot, name, dir = wrapCliTemplateDir(projectRoot)) {
  const selected = path.join(dir, name)
  if (isFile(selected) || name !== CC_NODE_BIN) return selected
  // Pulling the free pair does not remove the separately shipped legacy CLI.
  const factory = String(process.env.KIN_WRAP_CLI_ROOT || '').trim() || path.join(projectRoot, 'share', 'wrap-cli')
  return path.join(factory, name)
}

export function wrapCliTemplateDir(projectRoot) {
  const env = String(process.env.KIN_WRAP_CLI_ROOT || '').trim()
  if (env) return env
  if (!projectRoot) return ''
  const cached = cachedPackageRoot(path.join(projectRoot, 'share', 'wrap-cli-releases'), 'amd64')
  if (cached) {
    if (!isFile(path.join(cached, WRAP_KERNEL_BIN)) || !isFile(path.join(cached, WRAP_CLI_BIN)))
      throw Object.assign(new Error('cli-node 缓存不完整，请重新拉取'), { code: 'kernel_cache_invalid' })
    return cached
  }
  return path.join(projectRoot, 'share', 'wrap-cli')
}

export function wrapCliHomeDir(projectRoot, vmId) {
  if (!projectRoot || !vmId) return ''
  return path.join(projectRoot, 'vms', vmId, 'cli-home', '.kin')
}

function isFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function isDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function hasKernelPayload(dir) {
  return isFile(path.join(dir, WRAP_KERNEL_BIN)) || isFile(path.join(dir, WRAP_KERNEL_WRAPPER))
}

export function hasCustomKernelOverride(projectRoot) {
  const configured = String(process.env.KIN_KERNEL_BIN || '').trim()
  return Boolean(
    configured && (!projectRoot || path.resolve(configured) !== path.resolve(projectRoot, 'bin', 'kin-kernel')),
  )
}

function configuredKernelPath(projectRoot = '') {
  const env = kernelBinPath()
  // Explicit kernel overrides win, but a pulled pair must not use an older bundled kernel.
  if (!hasCustomKernelOverride(projectRoot) && !String(process.env.KIN_WRAP_CLI_ROOT || '').trim() && projectRoot) {
    const cached = cachedPackageRoot(path.join(projectRoot, 'share', 'wrap-cli-releases'), 'amd64')
    if (cached) {
      if (!isFile(path.join(cached, WRAP_KERNEL_BIN)))
        throw Object.assign(new Error('cli-node 缓存缺少 kin-kernel，请重新拉取'), { code: 'kernel_cache_invalid' })
      return path.join(cached, WRAP_KERNEL_BIN)
    }
  }
  if (isFile(env)) return env
  if (projectRoot) {
    const bundled = path.join(projectRoot, 'bin', 'kin-kernel')
    if (isFile(bundled)) return bundled
  }
  return ''
}

function kernelPayloadPath(dir, projectRoot = '') {
  const configured = configuredKernelPath(projectRoot)
  if (configured) return configured
  const bin = path.join(dir, WRAP_KERNEL_BIN)
  if (isFile(bin)) return bin
  return path.join(dir, WRAP_KERNEL_WRAPPER)
}

function fileInfo(p) {
  if (!isFile(p)) return null
  const st = fs.statSync(p)
  return { path: p, size: st.size, mtime: st.mtime.toISOString() }
}

export function describeKernelPayload(projectRoot) {
  const dir = wrapCliTemplateDir(projectRoot)
  const configured = configuredKernelPath(projectRoot)
  const sampleBin = path.join(dir, WRAP_KERNEL_BIN)
  const sampleWrap = path.join(dir, WRAP_KERNEL_WRAPPER)
  const chosen = configured || (isFile(sampleBin) ? sampleBin : isFile(sampleWrap) ? sampleWrap : '')
  const info = fileInfo(chosen)
  return {
    source: configured ? 'configured' : chosen ? 'sample' : 'missing',
    path: info?.path || '',
    size: info?.size || 0,
    mtime: info?.mtime || '',
  }
}
export function describeCliPayload(projectRoot, name) {
  const dir = wrapCliTemplateDir(projectRoot)
  const chosen = cliPayloadPath(projectRoot, name, dir)
  const info = fileInfo(chosen)
  return {
    source: info ? 'sample' : 'missing',
    path: info?.path || '',
    size: info?.size || 0,
    mtime: info?.mtime || '',
  }
}

export function describeCliNodePayload(projectRoot) {
  return describeCliPayload(projectRoot, WRAP_CLI_BIN)
}

export function describeCcNodePayload(projectRoot) {
  return describeCliPayload(projectRoot, CC_NODE_BIN)
}

export function inspectLinuxAmd64Elf(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  if (bytes.length < 64) {
    return { ok: false, code: 'kernel_too_small', error: 'kernel binary is too small to be an ELF' }
  }
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    return { ok: false, code: 'kernel_not_elf', error: 'kernel binary is not ELF' }
  }
  if (bytes[4] !== 2) {
    return { ok: false, code: 'kernel_not_elf64', error: 'kernel binary is not ELF64' }
  }
  if (bytes[5] !== 1) {
    return { ok: false, code: 'kernel_not_le', error: 'kernel binary is not little-endian ELF' }
  }
  if (bytes.readUInt16LE(18) !== 62) {
    return { ok: false, code: 'kernel_not_amd64', error: 'kernel binary is not linux amd64' }
  }
  return { ok: true, size: bytes.length }
}

export function inspectWrapCliDir(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return { ok: false, code: 'wrap_cli_template_missing', error: `wrap CLI template missing: ${dir || '(unset)'}` }
  }
  for (const name of [WRAP_CLI_BIN]) {
    const p = path.join(dir, name)
    if (!isFile(p)) {
      return { ok: false, code: 'wrap_cli_incomplete', error: `wrap CLI missing ${name}` }
    }
  }
  if (!hasKernelPayload(dir)) {
    return { ok: false, code: 'wrap_cli_incomplete', error: 'wrap CLI missing kin-kernel' }
  }
  return {
    ok: true,
    dir,
    kernel_bin: isFile(path.join(dir, WRAP_KERNEL_BIN)),
    glibc_shim: isDir(path.join(dir, WRAP_GLIBC_DIR)),
    wrapper: isFile(path.join(dir, WRAP_KERNEL_WRAPPER)),
  }
}

function sameFile(src, dest) {
  try {
    const a = fs.statSync(src)
    const b = fs.statSync(dest)
    return a.dev === b.dev && a.ino === b.ino
  } catch {
    return false
  }
}

function filesEqual(src, dest) {
  let a
  let b
  try {
    a = fs.openSync(src, 'r')
    b = fs.openSync(dest, 'r')
    const aStat = fs.fstatSync(a)
    const bStat = fs.fstatSync(b)
    if (aStat.size !== bStat.size) return false
    const aBuf = Buffer.allocUnsafe(64 * 1024)
    const bBuf = Buffer.allocUnsafe(64 * 1024)
    let offset = 0
    while (offset < aStat.size) {
      const length = Math.min(aBuf.length, aStat.size - offset)
      const aRead = fs.readSync(a, aBuf, 0, length, offset)
      const bRead = fs.readSync(b, bBuf, 0, length, offset)
      if (aRead !== bRead || !aBuf.subarray(0, aRead).equals(bBuf.subarray(0, bRead))) return false
      offset += aRead
    }
    return true
  } catch {
    return false
  } finally {
    if (a != null) fs.closeSync(a)
    if (b != null) fs.closeSync(b)
  }
}

function replaceFile(src, dest) {
  if (!src || src === dest || sameFile(src, dest)) return false
  if (filesEqual(src, dest)) return false
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.new`)
  fs.copyFileSync(src, tmp)
  try {
    fs.chmodSync(tmp, 0o755)
  } catch {}
  try {
    fs.unlinkSync(dest)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try {
        fs.unlinkSync(tmp)
      } catch {}
      throw error
    }
  }
  fs.renameSync(tmp, dest)
  return true
}

function copyFile(src, dest) {
  replaceFile(src, dest)
}

function copyDir(src, dest, { exclude = [] } = {}) {
  if (!isDir(src)) return
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    if (SECRET_NAMES.has(name) || exclude.includes(name)) continue
    const from = path.join(src, name)
    const to = path.join(dest, name)
    let st
    try {
      st = fs.lstatSync(from)
    } catch {
      continue
    }
    if (st.isDirectory()) copyDir(from, to, { exclude })
    else if (st.isFile()) replaceFile(from, to)
  }
}

function chownTree(root, uid, gid) {
  if (uid == null && gid == null) return
  const u = Number(uid)
  const g = Number(gid)
  if (!Number.isInteger(u) || !Number.isInteger(g) || u < 0 || g < 0) return
  const walk = (p) => {
    try {
      fs.chownSync(p, u, g)
    } catch {}
    let st
    try {
      st = fs.lstatSync(p)
    } catch {
      return
    }
    if (!st.isDirectory()) return
    let names = []
    try {
      names = fs.readdirSync(p)
    } catch {
      return
    }
    for (const name of names) walk(path.join(p, name))
  }
  walk(root)
}

function writeCragWrapper(destDir) {
  const wrapper = path.join(destDir, WRAP_KERNEL_WRAPPER)
  const body = cragKernelWrapperScript()
  try {
    if (fs.readFileSync(wrapper, 'utf8') === body) return
  } catch {}
  const tmp = path.join(destDir, `.${WRAP_KERNEL_WRAPPER}.${process.pid}.new`)
  fs.writeFileSync(tmp, body, { mode: 0o755 })
  try {
    fs.unlinkSync(wrapper)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try {
        fs.unlinkSync(tmp)
      } catch {}
      throw error
    }
  }
  fs.renameSync(tmp, wrapper)
}

export function describeCragPayload(projectRoot) {
  const chosen = cragKernelPath(projectRoot)
  const info = fileInfo(chosen)
  return {
    source: info ? 'sample' : 'missing',
    path: info?.path || '',
    size: info?.size || 0,
    mtime: info?.mtime || '',
    ok: Boolean(info),
  }
}

export function materializeCragKernel(projectRoot, vm, { uid = null, gid = null } = {}) {
  if (!projectRoot || !vm?.id) {
    return { ok: false, code: 'vm_required', error: 'projectRoot and vm id required' }
  }
  const licensed = checkCragLicense(projectRoot, { ...vm, dataplane: 'crag' })
  if (!licensed.ok) return licensed
  const src = cragKernelPath(projectRoot)
  if (!src) {
    return {
      ok: false,
      code: 'crag_kernel_missing',
      error: 'Crag kernel ELF missing (share/crag/kin-kernel)',
    }
  }
  const cliSrc = cliPayloadPath(projectRoot, CC_NODE_BIN)
  if (!isFile(cliSrc)) {
    return {
      ok: false,
      code: 'cc_node_missing',
      error: 'cc-node missing (share/wrap-cli/cc-node)',
    }
  }
  const dest = wrapCliHomeDir(projectRoot, vm.id)
  fs.mkdirSync(dest, { recursive: true })
  const kernelChanged = replaceFile(src, path.join(dest, WRAP_KERNEL_BIN))
  copyFile(cliSrc, path.join(dest, CC_NODE_BIN))
  writeCragWrapper(dest)
  chownTree(dest, uid, gid)
  return {
    ok: true,
    dest,
    src,
    dataplane: 'crag',
    changed: kernelChanged,
    kernel_changed: kernelChanged,
    glibc_shim: false,
    wrapper: isFile(path.join(dest, WRAP_KERNEL_WRAPPER)),
    kernel_bin: isFile(path.join(dest, WRAP_KERNEL_BIN)),
  }
}

export function replaceCragKernelBinary(projectRoot, buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  const check = inspectLinuxAmd64Elf(bytes)
  if (!check.ok) {
    return { ok: false, code: check.code || 'kernel_not_elf', error: check.error }
  }
  const destDir = cragTemplateDir(projectRoot)
  if (!destDir) return { ok: false, code: 'crag_template_missing', error: 'crag kernel dir unset' }
  fs.mkdirSync(destDir, { recursive: true })
  const dest = path.join(destDir, 'kin-kernel')
  writeKernelBytes(dest, bytes)
  return { ok: true, written: [dest], size: bytes.length, dataplane: 'crag' }
}

export function materializeSlotDataplane(projectRoot, vm, dataplane, opts = {}) {
  const resolved = dataplane || resolveKernelDataplane(vm, opts.routing) || 'wrap'
  if (resolved === 'crag' && resolveCragKernelVersion(vm, opts.routing) === 'v2') {
    return materializeCragV2(projectRoot, vm, opts)
  }
  if (resolved === 'crag') return materializeCragKernel(projectRoot, vm, opts)
  return materializeWrapCli(projectRoot, vm, opts)
}

export function materializeResolvedKernel(projectRoot, vm, opts = {}) {
  const dataplane = resolveKernelDataplane(vm, opts.routing) || 'wrap'
  return materializeSlotDataplane(projectRoot, vm, dataplane, opts)
}

function writeWrapper(destDir) {
  const wrapper = path.join(destDir, WRAP_KERNEL_WRAPPER)
  const body = wrapKernelWrapperScript()
  try {
    if (fs.readFileSync(wrapper, 'utf8') === body) return
  } catch {}
  const tmp = path.join(destDir, `.${WRAP_KERNEL_WRAPPER}.${process.pid}.new`)
  fs.writeFileSync(tmp, body, { mode: 0o755 })
  try {
    fs.unlinkSync(wrapper)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try {
        fs.unlinkSync(tmp)
      } catch {}
      throw error
    }
  }
  fs.renameSync(tmp, wrapper)
}

function installKernelPayload(src, dest, projectRoot = '') {
  const binSrc = kernelPayloadPath(src, projectRoot)
  const kernelChanged = binSrc && isFile(binSrc) ? replaceFile(binSrc, path.join(dest, WRAP_KERNEL_BIN)) : false
  const selectedGlibc = path.join(src, WRAP_GLIBC_DIR)
  const glibcSrc = isDir(selectedGlibc) ? selectedGlibc : path.join(projectRoot, 'share', 'wrap-cli', WRAP_GLIBC_DIR)
  if (isDir(glibcSrc)) copyDir(glibcSrc, path.join(dest, WRAP_GLIBC_DIR), { exclude: ['arm64'] })
  writeWrapper(dest)
  return kernelChanged
}

export function materializeWrapCli(projectRoot, vm, { uid = null, gid = null, nativeCliOptions } = {}) {
  if (!projectRoot || !vm?.id) {
    return { ok: false, code: 'vm_required', error: 'projectRoot and vm id required' }
  }
  let src
  try {
    src = wrapCliTemplateDir(projectRoot)
  } catch (error) {
    return { ok: false, code: error.code, error: error.message }
  }
  const status = inspectWrapCliDir(src)
  if (!status.ok) return status
  const native = nativeCliForVm(vm, src, nativeCliOptions)
  if (native && !native.ok) return native
  const dest = wrapCliHomeDir(projectRoot, vm.id)
  fs.mkdirSync(dest, { recursive: true })
  const kernelChanged = installKernelPayload(src, dest, projectRoot)
  let payloadChanged = false
  // Install runtime dependencies before making the native entry point visible.
  if (native?.ok) {
    for (const name of NATIVE_CLI_FILES.filter((file) => file !== WRAP_CLI_BIN)) {
      payloadChanged = replaceFile(path.join(native.dir, name), path.join(dest, name)) || payloadChanged
    }
  }
  for (const name of WRAP_CLI_FILES) {
    const from =
      native?.ok && name === WRAP_CLI_BIN ? path.join(native.dir, name) : cliPayloadPath(projectRoot, name, src)
    if (name === CC_NODE_BIN && !isFile(from)) continue
    payloadChanged = replaceFile(from, path.join(dest, name)) || payloadChanged
  }
  const changed = payloadChanged || kernelChanged
  chownTree(dest, uid, gid)
  return {
    ok: true,
    dest,
    src,
    changed,
    kernel_changed: changed,
    glibc_shim: isDir(path.join(dest, WRAP_GLIBC_DIR)),
    wrapper: isFile(path.join(dest, WRAP_KERNEL_WRAPPER)),
    kernel_bin: isFile(path.join(dest, WRAP_KERNEL_BIN)),
  }
}

function copyWrapTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const name of WRAP_CLI_FILES) {
    const from = path.join(src, name)
    if (!isFile(from)) continue
    if (SECRET_NAMES.has(name)) continue
    copyFile(from, path.join(dest, name))
  }
  const glibc = path.join(src, WRAP_GLIBC_DIR)
  if (isDir(glibc)) copyDir(glibc, path.join(dest, WRAP_GLIBC_DIR))
  const bin = isFile(path.join(src, WRAP_KERNEL_BIN))
    ? path.join(src, WRAP_KERNEL_BIN)
    : path.join(src, WRAP_KERNEL_WRAPPER)
  if (isFile(bin)) copyFile(bin, path.join(dest, WRAP_KERNEL_BIN))
  writeWrapper(dest)
}

export function captureWrapSample(projectRoot, vm) {
  if (!projectRoot || !vm?.id) {
    return { ok: false, code: 'vm_required', error: 'projectRoot and vm id required' }
  }
  if (nativeCliForVm(vm, wrapCliTemplateDir(projectRoot)) !== null) {
    return {
      ok: false,
      code: 'native_cli_capture_unsupported',
      error: 'Do not promote a native slot into the portable template',
    }
  }
  const src = wrapCliHomeDir(projectRoot, vm.id)
  const status = inspectWrapCliDir(src)
  if (!status.ok) {
    return {
      ok: false,
      code: status.code || 'wrap_cli_incomplete',
      error: `slot ${vm.id} is not a usable wrap sample: ${status.error}`,
    }
  }
  const dest = wrapCliTemplateDir(projectRoot)
  if (!dest) return { ok: false, code: 'wrap_cli_template_missing', error: 'wrap CLI template dir unset' }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-sample-'))
  try {
    copyWrapTree(src, staging)
    const check = inspectWrapCliDir(staging)
    if (!check.ok) return check
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const bak = `${dest}.bak`
    if (fs.existsSync(dest)) {
      fs.rmSync(bak, { recursive: true, force: true })
      fs.renameSync(dest, bak)
    }
    fs.cpSync(staging, dest, { recursive: true, force: true })
    fs.writeFileSync(
      path.join(dest, 'SAMPLE.json'),
      JSON.stringify(
        {
          source_vm: vm.id,
          captured_at: new Date().toISOString(),
          files: WRAP_CLI_FILES.slice(),
          kernel: WRAP_KERNEL_BIN,
          glibc_shim: isDir(path.join(dest, WRAP_GLIBC_DIR)),
        },
        null,
        2,
      ) + '\n',
    )
    return inspectWrapCliDir(dest)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

export function describeWrapSample(projectRoot) {
  let dir
  try {
    dir = wrapCliTemplateDir(projectRoot)
  } catch (error) {
    return { ok: false, code: error.code, error: error.message, dir: '', meta: null }
  }
  const inspect = inspectWrapCliDir(dir)
  let meta = null
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'SAMPLE.json'), 'utf8'))
  } catch {}
  return {
    ...inspect,
    dir,
    meta,
    kernel: describeKernelPayload(projectRoot),
    cli_node: describeCliNodePayload(projectRoot),
    cc_node: describeCcNodePayload(projectRoot),
  }
}

export function makeWrapSample(projectRoot, { glibcFromDir = '' } = {}) {
  const dest = wrapCliTemplateDir(projectRoot)
  if (!dest) {
    return { ok: false, code: 'wrap_cli_template_missing', error: 'wrap CLI template dir unset' }
  }
  fs.mkdirSync(dest, { recursive: true })
  const kernelDest = path.join(dest, WRAP_KERNEL_BIN)
  const kernelSrc = kernelPayloadPath(dest, projectRoot)
  if (kernelSrc && isFile(kernelSrc) && path.resolve(kernelSrc) !== path.resolve(kernelDest)) {
    replaceFile(kernelSrc, kernelDest)
  }
  const glibcDest = path.join(dest, WRAP_GLIBC_DIR)
  if (!isDir(glibcDest) && glibcFromDir && isDir(glibcFromDir)) {
    copyDir(glibcFromDir, glibcDest)
  }
  writeWrapper(dest)
  const check = inspectWrapCliDir(dest)
  if (!check.ok) {
    return {
      ...check,
      error: `${check.error}。单独制作需要 share/wrap-cli 已有 cli-node 和 cc-node；kernel 可从主机 kin-kernel 补。不要从正在跑 wrap 的槽原地覆盖。`,
    }
  }
  fs.writeFileSync(
    path.join(dest, 'SAMPLE.json'),
    JSON.stringify(
      {
        source: 'manual',
        source_vm: '',
        captured_at: new Date().toISOString(),
        files: WRAP_CLI_FILES.slice(),
        kernel: WRAP_KERNEL_BIN,
        glibc_shim: isDir(glibcDest),
      },
      null,
      2,
    ) + '\n',
  )
  return inspectWrapCliDir(dest)
}

function isInsideProject(projectRoot, target) {
  if (!projectRoot || !target) return false
  const root = path.resolve(projectRoot)
  const abs = path.resolve(target)
  return abs === root || abs.startsWith(root + path.sep)
}

function writeKernelBytes(dest, bytes) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.new`)
  fs.writeFileSync(tmp, bytes, { mode: 0o755 })
  try {
    fs.unlinkSync(dest)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try {
        fs.unlinkSync(tmp)
      } catch {}
      throw error
    }
  }
  fs.renameSync(tmp, dest)
}

function kernelWriteTargets(projectRoot) {
  const destDir = wrapCliTemplateDir(projectRoot)
  const seen = new Set()
  const targets = []
  const add = (p) => {
    if (!p) return
    const abs = path.resolve(p)
    if (seen.has(abs)) return
    seen.add(abs)
    targets.push(abs)
  }
  add(path.join(destDir, WRAP_KERNEL_BIN))
  if (projectRoot) add(path.join(projectRoot, 'bin', 'kin-kernel'))
  const env = kernelBinPath()
  if (env && isInsideProject(projectRoot, env)) add(env)
  return targets
}

export function replaceKernelBinary(projectRoot, buf, extra = {}) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  const check = inspectLinuxAmd64Elf(bytes)
  if (!check.ok) return check
  const metaExtra = extra && typeof extra === 'object' ? extra : {}
  const source =
    String(metaExtra.source || 'upload')
      .trim()
      .slice(0, 32) || 'upload'
  const releaseTag = /^v\d+\.\d+\.\d+$/.test(String(metaExtra.release_tag || '').trim())
    ? String(metaExtra.release_tag).trim()
    : ''
  const destDir = wrapCliTemplateDir(projectRoot)
  if (!destDir) {
    return { ok: false, code: 'wrap_cli_template_missing', error: 'wrap CLI template dir unset' }
  }
  fs.mkdirSync(destDir, { recursive: true })
  const written = []
  for (const dest of kernelWriteTargets(projectRoot)) {
    writeKernelBytes(dest, bytes)
    written.push(dest)
  }
  writeWrapper(destDir)
  let meta = {}
  try {
    meta = JSON.parse(fs.readFileSync(path.join(destDir, 'SAMPLE.json'), 'utf8'))
  } catch {}
  fs.writeFileSync(
    path.join(destDir, 'SAMPLE.json'),
    JSON.stringify(
      {
        ...meta,
        source,
        captured_at: new Date().toISOString(),
        files: WRAP_CLI_FILES.slice(),
        kernel: WRAP_KERNEL_BIN,
        glibc_shim: isDir(path.join(destDir, WRAP_GLIBC_DIR)),
        ...(releaseTag ? { release_tag: releaseTag } : { release_tag: undefined }),
      },
      null,
      2,
    ) + '\n',
  )
  const described = describeWrapSample(projectRoot)
  return { ...described, ok: true, sample_ok: described.ok, written }
}
function replaceNamedCliBinary(projectRoot, buf, name) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  const check = inspectLinuxAmd64Elf(bytes)
  if (!check.ok) {
    return {
      ok: false,
      code: `${name.replace('-', '_')}_not_elf`,
      error: check.error || `${name} binary is not a linux amd64 ELF`,
    }
  }
  const destDir = wrapCliTemplateDir(projectRoot)
  if (!destDir) return { ok: false, code: 'wrap_cli_template_missing', error: 'wrap CLI template dir unset' }
  fs.mkdirSync(destDir, { recursive: true })
  const dest = path.join(destDir, name)
  writeKernelBytes(dest, bytes)
  return { ok: true, written: [dest], size: bytes.length }
}

export function replaceCliNodeBinary(projectRoot, buf) {
  return replaceNamedCliBinary(projectRoot, buf, WRAP_CLI_BIN)
}

export function replaceCcNodeBinary(projectRoot, buf) {
  return replaceNamedCliBinary(projectRoot, buf, CC_NODE_BIN)
}

function kernelWouldChange(src, dest) {
  if (!src || !isFile(src)) return false
  if (!isFile(dest)) return true
  if (sameFile(src, dest)) return false
  return !filesEqual(src, dest)
}

function payloadWouldChange(srcDir, destDir, projectRoot, native) {
  const pairs = [
    ...WRAP_CLI_FILES.map((name) => [
      path.join(native?.ok && name === WRAP_CLI_BIN ? native.dir : srcDir, name),
      path.join(destDir, name),
    ]),
    ...(native?.ok
      ? NATIVE_CLI_FILES.filter((name) => name !== WRAP_CLI_BIN).map((name) => [
          path.join(native.dir, name),
          path.join(destDir, name),
        ])
      : []),
    [kernelPayloadPath(srcDir, projectRoot), path.join(destDir, WRAP_KERNEL_BIN)],
  ]
  return pairs.some(([src, dest]) => kernelWouldChange(src, dest))
}
export function inspectKernelChanges(projectRoot, vms, { routing, nativeCliOptions } = {}) {
  const sample = describeWrapSample(projectRoot)
  const crag = describeCragPayload(projectRoot)
  const items = []
  for (const vm of vms || []) {
    if (isCodexVm(vm)) continue
    const dataplane = resolveKernelDataplane(vm, routing) || 'wrap'
    const version = dataplane === 'crag' ? resolveCragKernelVersion(vm, routing) : null
    const destDir = wrapCliHomeDir(projectRoot, vm.id)
    if (version === 'v2') {
      const placement = cragV2PlacementError(vm)
      let src
      try {
        src = cragV2PackageRoot(projectRoot)
      } catch (error) {
        items.push({ id: vm.id, dataplane, kernel_version: 'v2', ok: false, code: error.code, kernel_changed: false })
        continue
      }
      if (placement) {
        items.push({
          id: vm.id,
          dataplane,
          kernel_version: 'v2',
          ok: false,
          code: placement.code,
          kernel_changed: false,
        })
        continue
      }
      if (!src) {
        items.push({
          id: vm.id,
          dataplane,
          kernel_version: 'v2',
          ok: false,
          code: 'crag_v2_package_missing',
          kernel_changed: false,
        })
        continue
      }
      const verified = verifyCragV2Tree(src)
      if (!verified.ok) {
        items.push({
          id: vm.id,
          dataplane,
          kernel_version: 'v2',
          ok: false,
          code: verified.code,
          kernel_changed: false,
        })
        continue
      }
      const kernelChanged = cragV2WouldChange(src, destDir) || Boolean(vm?.kernel_restart_pending)
      items.push({ id: vm.id, dataplane, kernel_version: 'v2', ok: true, kernel_changed: kernelChanged })
      continue
    }
    if (dataplane === 'crag' && !crag.ok) {
      items.push({ id: vm.id, dataplane, ok: false, code: 'crag_kernel_missing', kernel_changed: false })
      continue
    }
    if (dataplane !== 'crag' && !sample.ok) {
      items.push({ id: vm.id, dataplane, ok: false, code: sample.code, kernel_changed: false })
      continue
    }
    const src = dataplane === 'crag' ? crag.path : kernelPayloadPath(sample.dir, projectRoot)
    const native = dataplane === 'crag' ? null : nativeCliForVm(vm, sample.dir, nativeCliOptions)
    if (native && !native.ok) {
      items.push({ id: vm.id, dataplane, ...native, kernel_changed: false })
      continue
    }
    const kernelChanged =
      (dataplane === 'crag'
        ? kernelWouldChange(src, path.join(destDir, WRAP_KERNEL_BIN))
        : payloadWouldChange(sample.dir, destDir, projectRoot, native)) || Boolean(vm?.kernel_restart_pending)
    items.push({ id: vm.id, dataplane, ok: true, kernel_changed: kernelChanged })
  }
  const failed = items.filter((item) => !item.ok)
  const changed = items.filter((item) => item.kernel_changed === true)
  return {
    ok: failed.length === 0,
    changed: changed.length > 0,
    total: items.length,
    ok_count: items.length - failed.length,
    failed_count: failed.length,
    changed_count: changed.length,
    items,
  }
}

export function syncWrapSample(projectRoot, vms, { uidOf, routing } = {}) {
  const sample = describeWrapSample(projectRoot)
  const crag = describeCragPayload(projectRoot)
  const items = []
  for (const vm of vms || []) {
    if (isCodexVm(vm)) continue
    const dataplane = resolveKernelDataplane(vm, routing) || 'wrap'
    const version = dataplane === 'crag' ? resolveCragKernelVersion(vm, routing) : null
    if ((dataplane === 'wrap' || dataplane === 'cc') && !sample.ok) {
      items.push({ id: vm.id, dataplane, ok: false, code: sample.code, error: sample.error })
      continue
    }
    if (version !== 'v2' && dataplane === 'crag' && !crag.ok) {
      items.push({
        id: vm.id,
        dataplane,
        ok: false,
        code: 'crag_kernel_missing',
        error: crag.error || 'Crag kernel ELF missing (share/crag/kin-kernel)',
      })
      continue
    }
    const uid = typeof uidOf === 'function' ? uidOf(vm) : null
    const gid = uid?.gid
    const out = materializeSlotDataplane(projectRoot, vm, dataplane, {
      uid: uid?.uid ?? uid,
      gid: gid ?? null,
      routing,
    })
    if (vm?.kernel_restart_pending) out.kernel_changed = true
    items.push({ id: vm.id, dataplane, ...out })
  }
  const failed = items.filter((item) => !item.ok)
  const changed = items.filter((item) => item.kernel_changed === true)
  return {
    ok: failed.length === 0,
    changed: changed.length > 0,
    src: sample.dir,
    meta: sample.meta,
    crag,
    total: items.length,
    ok_count: items.length - failed.length,
    failed_count: failed.length,
    changed_count: changed.length,
    items,
  }
}
