/**
 * Wrap inference CLI lives in the slot home, next to the Go worker.
 * Create/start copies a prebuilt cli-node ELF (not JS dist / in-slot patch).
 * Engine rust|go only chooses which process serves /v1; both stay on disk.
 * CLI always pre-opens 20 native_messages slots; Node maxConcurrency uses N.
 *
 * Mother sample: share/wrap-cli (or KIN_WRAP_CLI_ROOT). Promote from a proven
 * slot, then one-click sync/reinstall. Never copies credentials or proxy URLs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { kernelBinPath } from '../transport/rust-kernel-supervisor.mjs'

export const WRAP_CLI_FILES = Object.freeze(['cli-node'])
export const WRAP_KERNEL_BIN = 'kin-kernel.bin'
export const WRAP_KERNEL_WRAPPER = 'kin-kernel'
export const WRAP_GLIBC_DIR = 'glibc239'
export const WRAP_GLIBC_LIBS = Object.freeze(['ld-linux-x86-64.so.2', 'libc.so.6', 'libm.so.6', 'libgcc_s.so.1'])

const SECRET_NAMES = new Set(['credentials.json', '.credentials.json', 'oauth.json', '.claude.json', 'internal.token'])

export function wrapKernelWrapperScript() {
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

function destAlreadyCurrent(src, dest) {
  try {
    const a = fs.statSync(src)
    const b = fs.statSync(dest)
    return a.size === b.size && b.mtimeMs + 1 >= a.mtimeMs
  } catch {
    return false
  }
}

function replaceFile(src, dest) {
  if (!src || src === dest || sameFile(src, dest)) return
  if (destAlreadyCurrent(src, dest)) return
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

function installKernelPayload(src, dest) {
  const binSrc = isFile(path.join(src, WRAP_KERNEL_BIN))
    ? path.join(src, WRAP_KERNEL_BIN)
    : isFile(path.join(src, WRAP_KERNEL_WRAPPER))
      ? path.join(src, WRAP_KERNEL_WRAPPER)
      : kernelBinPath()
  if (binSrc && isFile(binSrc)) {
    copyFile(binSrc, path.join(dest, WRAP_KERNEL_BIN))
  }
  const glibcSrc = path.join(src, WRAP_GLIBC_DIR)
  if (isDir(glibcSrc)) copyDir(glibcSrc, path.join(dest, WRAP_GLIBC_DIR))
  writeWrapper(dest)
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
  for (const name of WRAP_CLI_FILES) {
    copyFile(path.join(src, name), path.join(dest, name))
  }
  installKernelPayload(src, dest)
  chownTree(dest, uid, gid)
  return {
    ok: true,
    dest,
    src,
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
  return { ...inspect, meta }
}

export function makeWrapSample(projectRoot, { glibcFromDir = '' } = {}) {
  const dest = wrapCliTemplateDir(projectRoot)
  if (!dest) {
    return { ok: false, code: 'wrap_cli_template_missing', error: 'wrap CLI template dir unset' }
  }
  fs.mkdirSync(dest, { recursive: true })
  const kernelDest = path.join(dest, WRAP_KERNEL_BIN)
  const kernelSrc = isFile(kernelDest)
    ? kernelDest
    : isFile(path.join(dest, WRAP_KERNEL_WRAPPER))
      ? path.join(dest, WRAP_KERNEL_WRAPPER)
      : kernelBinPath()
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
      error: `${check.error}。单独制作需要 share/wrap-cli 已有 cli-node；kernel 可从主机 kin-kernel 补。不要从正在跑 wrap 的槽原地覆盖。`,
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

export function syncWrapSample(projectRoot, vms, { uidOf } = {}) {
  const sample = describeWrapSample(projectRoot)
  if (!sample.ok) return { ok: false, ...sample, items: [] }
  const items = []
  for (const vm of vms || []) {
    const uid = typeof uidOf === 'function' ? uidOf(vm) : null
    const gid = uid?.gid
    const out = materializeWrapCli(projectRoot, vm, {
      uid: uid?.uid ?? uid,
      gid: gid ?? null,
    })
    items.push({ id: vm.id, ...out })
  }
  const failed = items.filter((item) => !item.ok)
  return {
    ok: failed.length === 0,
    src: sample.dir,
    meta: sample.meta,
    total: items.length,
    ok_count: items.length - failed.length,
    failed_count: failed.length,
    items,
  }
}
