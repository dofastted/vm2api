#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { pullKernelRelease } from '../src/lib/admin/kernel-catalog.mjs'
import { listVmRecordFiles } from '../src/lib/vm/vm-file.mjs'
import { isCodexVm } from '../src/lib/vm/vm-kind.mjs'
import { resolveKernelDataplane, resolveCragKernelVersion } from '../src/lib/vm/slot-engine.mjs'
import { cragV2PackageRoot, stageCragV2Tree, verifyCragV2Tree } from '../src/lib/vm/wrap-cli-runtime.mjs'
import { rustKernelHealth } from '../src/lib/transport/rust-kernel-client.mjs'
import { slotExec } from '../src/lib/vm/slot-runtime.mjs'
import { slotExecArgv } from '../src/lib/vm/slot-exec.mjs'
import { isKvmRuntime } from '../src/lib/vm/runtime-kind.mjs'

const execute = promisify(execFile)

export async function runningCragHashes(vm, { execute: run = execute } = {}) {
  const command =
    'for p in /proc/[0-9]*/exe; do case "$(readlink "$p" 2>/dev/null)" in *memfd:crag-v2-core*) sha256sum "$p" || exit 1;; esac; done'
  // Guest root can inspect memfds across guest users. A capability-dropped Docker
  // root cannot inspect kincli's processes, so keep that container's default user.
  const argv = slotExecArgv(vm, ['sh', '-c', command], isKvmRuntime(vm) ? { user: '0' } : {})
  const { stdout } = await run('docker', argv, {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  })
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      if (!/^[a-f0-9]{64}\s+\/proc\/\d+\/exe$/.test(line)) throw new Error('crag_process_hash_invalid')
      return line.slice(0, 64)
    })
}

function records(root) {
  return listVmRecordFiles(path.join(root, 'vms'))
    .sort()
    .map((name) => {
      const vm = JSON.parse(fs.readFileSync(path.join(root, 'vms', name), 'utf8'))
      if (`${vm.id}.json` !== name) throw new Error('vm_record_invalid')
      return vm
    })
}

export function cragUpdateInventory(root, routing) {
  return records(root).map((vm) => {
    const active =
      !isCodexVm(vm) && resolveKernelDataplane(vm, routing) === 'crag' && resolveCragKernelVersion(vm, routing) === 'v2'
    const installed = path.join(root, 'vms', vm.id, 'cli-home/.kin/crag-v2')
    const cached = !isCodexVm(vm) && !vm.node_id && fs.existsSync(installed)
    return { vm, installed, action: active ? 'sync' : cached ? 'cache' : 'skip' }
  })
}

// Existing non-CRAG slots can retain a dormant package. Refresh only that
// directory, never their kernel wrapper, configuration, identity or selection.
function refreshCachedPackage(src, dest) {
  const parent = fs.lstatSync(path.dirname(dest))
  if (!parent.isDirectory() || fs.lstatSync(dest).isSymbolicLink()) throw new Error('crag_cache_path_invalid')
  const staged = stageCragV2Tree(src, dest)
  if (!staged.ok) throw new Error(staged.code)
  try {
    const own = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) own(file)
        else fs.chownSync(file, parent.uid, parent.gid)
      }
      fs.chownSync(dir, parent.uid, parent.gid)
    }
    own(dest)
  } catch (error) {
    staged.rollback()
    throw error
  }
  staged.commit()
}

export async function updateCrag(
  root,
  { tag = '', api, pull = pullKernelRelease, health = rustKernelHealth, coreHashes = runningCragHashes } = {},
) {
  const base = path.join(root, 'share/crag/kernels/v2')
  fs.mkdirSync(base, { recursive: true })
  const lock = path.join(base, '.update-lock')
  fs.mkdirSync(lock, { mode: 0o700 })
  const reason = `crag_update_${crypto.randomUUID()}`
  let held = false
  try {
    const routing = JSON.parse(fs.readFileSync(path.join(root, 'src/config/routing.json'), 'utf8'))
    const inventory = cragUpdateInventory(root, routing)
    const targets = inventory.filter((row) => row.action === 'sync')
    // This standalone updater reads local files/processes; node installs use the panel lifecycle.
    if (targets.some(({ vm }) => vm.node_id)) throw new Error('crag_v2_unsupported_placement')
    const pulled = await pull(root, { kernel: 'crag', tag })
    if (!pulled.ok) throw new Error(pulled.code || 'crag_pull_failed')
    const src = cragV2PackageRoot(root)
    const verified = verifyCragV2Tree(src)
    if (!verified.ok) throw new Error(verified.code)
    const manifest = fs.readFileSync(path.join(src, 'manifest.json'))
    const expectedCore = verified.manifest.payload.plaintext_sha256
    const running = targets.filter(({ vm }) => vm.status === 'running')
    const matches = (hashes) => hashes.length === 1 && hashes[0] === expectedCore
    const staleRuntime = []
    for (const { vm } of running) if (!matches(await coreHashes(vm))) staleRuntime.push(vm)
    const ids = targets.map(({ vm }) => vm.id)
    const check = ids.length ? await api('/api/panel/wrap-cli/sync', { ids, restart: false }) : { changed_count: 0 }
    if (check.failed_count || check.ok === false) throw new Error('crag_check_failed')
    const cached = inventory.filter(
      ({ action, installed }) =>
        action === 'cache' &&
        (!verifyCragV2Tree(installed).ok || !fs.readFileSync(path.join(installed, 'manifest.json')).equals(manifest)),
    )
    if (check.changed_count || cached.length || staleRuntime.length) {
      // Own a unique hold; cleanup must not clear another operator's hold.
      held = true
      const drain = await api('/api/panel/vms/schedule/hold', { reason })
      if (drain.drained !== true || drain.inflight !== 0) throw new Error('crag_slots_not_drained')
      for (const { vm } of running) {
        const h = await health(slotExec(root, vm), { timeoutMs: 3000 })
        if (
          h?.healthy !== true ||
          h.runtime_variant !== 'crag-v2' ||
          h.license_valid !== true ||
          h.active_requests !== 0 ||
          h.continuations !== 0 ||
          h.queued !== 0
        )
          throw new Error(`crag_slot_not_idle:${vm.id}`)
      }
      // Fail if an operator changed selections during download/drain.
      const current = cragUpdateInventory(root, routing)
      if (
        JSON.stringify(current.map(({ vm, action }) => [vm.id, action, vm.status])) !==
        JSON.stringify(inventory.map(({ vm, action }) => [vm.id, action, vm.status]))
      )
        throw new Error('crag_inventory_changed')
      if (check.changed_count) {
        const synced = await api('/api/panel/wrap-cli/sync', { ids, restart: true })
        if (synced.failed_count || synced.ok === false) throw new Error('crag_sync_failed')
        for (const { vm } of running) {
          const h = await health(slotExec(root, vm), { timeoutMs: 3000 })
          if (h?.healthy !== true || h.runtime_variant !== 'crag-v2' || h.license_valid !== true)
            throw new Error(`crag_slot_not_healthy:${vm.id}`)
        }
      }
      // File equality does not prove that the live memfd has been replaced.
      for (const vm of staleRuntime) {
        if (!matches(await coreHashes(vm))) await api(`/api/panel/vms/${vm.id}/reload`, {})
      }
      for (const { installed } of cached) refreshCachedPackage(src, installed)
    }
    const runtime = new Map()
    for (const { vm } of running) {
      const hashes = await coreHashes(vm)
      if (!matches(hashes)) throw new Error(`crag_running_core_mismatch:${vm.id}`)
      const h = await health(slotExec(root, vm), { timeoutMs: 3000 })
      if (h?.healthy !== true || h.runtime_variant !== 'crag-v2' || h.license_valid !== true)
        throw new Error(`crag_slot_not_healthy:${vm.id}`)
      runtime.set(vm.id, hashes[0])
    }
    const items = inventory.map(({ vm, action, installed }) => {
      const ok =
        action === 'skip' ||
        (verifyCragV2Tree(installed).ok && fs.readFileSync(path.join(installed, 'manifest.json')).equals(manifest))
      return {
        id: vm.id,
        action,
        ok,
        status: vm.status,
        node_id: vm.node_id || null,
        ...(runtime.has(vm.id) ? { running_core_sha256: runtime.get(vm.id) } : {}),
      }
    })
    if (items.some((item) => !item.ok)) throw new Error('crag_installed_hash_mismatch')
    return {
      ok: true,
      release: pulled.release,
      manifest_sha256: crypto.createHash('sha256').update(manifest).digest('hex'),
      items,
    }
  } finally {
    try {
      if (held) await api('/api/panel/vms/schedule/resume', { reason })
    } finally {
      fs.rmdirSync(lock)
    }
  }
}

export function localPanelApi(root) {
  let text = ''
  try {
    text = fs.readFileSync(path.join(root, '.env'), 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const env = Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => /^[A-Z_][A-Z_0-9]*=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).replace(/^['"]|['"]$/g, '')]),
  )
  const service = {}
  if (!(process.env.VM2API_API_KEY || process.env.KIN_API_KEY || env.VM2API_API_KEY || env.KIN_API_KEY)) {
    // Native systemd installs need not have a project .env. Read only the
    // existing service's key/port, never copy or print its full environment.
    try {
      const pid = execFileSync('systemctl', ['show', 'vm2api.service', '-p', 'MainPID', '--value'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      if (!/^[1-9]\d*$/.test(pid)) throw new Error('control_service_not_running')
      for (const line of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
        const index = line.indexOf('=')
        const name = line.slice(0, index)
        if (['VM2API_API_KEY', 'KIN_API_KEY', 'PORT'].includes(name)) service[name] = line.slice(index + 1)
      }
    } catch (cause) {
      throw new Error('panel_api_key_missing: provide VM2API_API_KEY or KIN_API_KEY', { cause })
    }
  }
  const key =
    process.env.VM2API_API_KEY ||
    process.env.KIN_API_KEY ||
    env.VM2API_API_KEY ||
    env.KIN_API_KEY ||
    service.VM2API_API_KEY ||
    service.KIN_API_KEY
  if (!key) throw new Error('panel_api_key_missing')
  const port = process.env.PORT || env.PORT || service.PORT || '8787'
  if (!/^\d+$/.test(port)) throw new Error('panel_port_invalid')
  return async (endpoint, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const result = await response.json()
    if (!response.ok || result.ok !== true || !result.data)
      throw new Error(`panel_api_failed:${endpoint}:${response.status}`)
    return result.data
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(process.argv[2] || process.env.KIN_PROJECT_ROOT || '/opt/vm2api')
  try {
    console.log(JSON.stringify(await updateCrag(root, { tag: process.argv[3] || '', api: localPanelApi(root) })))
  } catch (error) {
    console.error(`CRAG update failed: ${error.message}; check slot state and schedule holds before resuming traffic`)
    process.exitCode = 1
  }
}
