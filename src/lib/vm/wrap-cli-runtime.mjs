/**
 * Wrap inference CLIs live in the slot home, next to the kernel.
 * share/wrap-cli holds both cli-node and cc-node. The dataplane picks which
 * one kernel.json.claude_bin runs:
 *   wrap: cli-node + wrap kin-kernel
 *   cc:   cc-node + wrap kin-kernel
 *   crag: cc-node + share/crag/kin-kernel
 * Engine rust only chooses which process serves /v1. Credentials stay out.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { kernelBinPath } from '../transport/rust-kernel-supervisor.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { resolveKernelDataplane } from './slot-engine.mjs'

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

export function wrapCliTemplateDir(projectRoot) {
  const env = String(process.env.KIN_WRAP_CLI_ROOT || '').trim()
  if (env) return env
  if (!projectRoot) return ''
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

function configuredKernelPath(projectRoot = '') {
  const env = kernelBinPath()
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
  const chosen = path.join(dir, name)
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
  for (const name of WRAP_CLI_FILES) {
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

function copyDir(src, dest) {
  if (!isDir(src)) return
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    if (SECRET_NAMES.has(name)) continue
    const from = path.join(src, name)
    const to = path.join(dest, name)
    let st
    try {
      st = fs.lstatSync(from)
    } catch {
      continue
    }
    if (st.isDirectory()) copyDir(from, to)
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
  const src = cragKernelPath(projectRoot)
  if (!src) {
    return {
      ok: false,
      code: 'crag_kernel_missing',
      error: 'Crag kernel ELF missing (share/crag/kin-kernel)',
    }
  }
  const cliSrc = path.join(wrapCliTemplateDir(projectRoot) || '', CC_NODE_BIN)
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
  if (dataplane === 'crag') return materializeCragKernel(projectRoot, vm, opts)
  return materializeWrapCli(projectRoot, vm, opts)
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
  const glibcSrc = path.join(src, WRAP_GLIBC_DIR)
  if (isDir(glibcSrc)) copyDir(glibcSrc, path.join(dest, WRAP_GLIBC_DIR))
  writeWrapper(dest)
  return kernelChanged
}

export function materializeWrapCli(projectRoot, vm, { uid = null, gid = null } = {}) {
  if (!projectRoot || !vm?.id) {
    return { ok: false, code: 'vm_required', error: 'projectRoot and vm id required' }
  }
  const src = wrapCliTemplateDir(projectRoot)
  const status = inspectWrapCliDir(src)
  if (!status.ok) return status
  const dest = wrapCliHomeDir(projectRoot, vm.id)
  fs.mkdirSync(dest, { recursive: true })
  let payloadChanged = false
  for (const name of WRAP_CLI_FILES) {
    payloadChanged = replaceFile(path.join(src, name), path.join(dest, name)) || payloadChanged
  }
  const kernelChanged = installKernelPayload(src, dest, projectRoot)
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
  const dir = wrapCliTemplateDir(projectRoot)
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

function payloadWouldChange(srcDir, destDir, projectRoot) {
  const pairs = [
    ...WRAP_CLI_FILES.map((name) => [path.join(srcDir, name), path.join(destDir, name)]),
    [kernelPayloadPath(srcDir, projectRoot), path.join(destDir, WRAP_KERNEL_BIN)],
  ]
  return pairs.some(([src, dest]) => kernelWouldChange(src, dest))
}
export function inspectKernelChanges(projectRoot, vms, { routing } = {}) {
  const sample = describeWrapSample(projectRoot)
  const crag = describeCragPayload(projectRoot)
  const items = []
  for (const vm of vms || []) {
    if (isCodexVm(vm)) continue
    const dataplane = resolveKernelDataplane(vm, routing) || 'wrap'
    const destDir = wrapCliHomeDir(projectRoot, vm.id)
    const src = dataplane === 'crag' ? crag.path : kernelPayloadPath(sample.dir, projectRoot)
    if (dataplane === 'crag' && !crag.ok) {
      items.push({ id: vm.id, dataplane, ok: false, code: 'crag_kernel_missing', kernel_changed: false })
      continue
    }
    if (dataplane !== 'crag' && !sample.ok) {
      items.push({ id: vm.id, dataplane, ok: false, code: sample.code, kernel_changed: false })
      continue
    }
    const kernelChanged =
      (dataplane === 'crag'
        ? kernelWouldChange(src, path.join(destDir, WRAP_KERNEL_BIN))
        : payloadWouldChange(sample.dir, destDir, projectRoot)) || Boolean(vm?.kernel_restart_pending)
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
    if ((dataplane === 'wrap' || dataplane === 'cc') && !sample.ok) {
      items.push({ id: vm.id, dataplane, ok: false, code: sample.code, error: sample.error })
      continue
    }
    if (dataplane === 'crag' && !crag.ok) {
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
