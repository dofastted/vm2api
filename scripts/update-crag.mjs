#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { pullKernelRelease } from '../src/lib/admin/kernel-catalog.mjs'
import { listVmRecordFiles } from '../src/lib/vm/vm-file.mjs'
import { isCodexVm } from '../src/lib/vm/vm-kind.mjs'
import { resolveKernelDataplane, resolveCragKernelVersion } from '../src/lib/vm/slot-engine.mjs'
import { cragV2PackageRoot, stageCragV2Tree, verifyCragV2Tree } from '../src/lib/vm/wrap-cli-runtime.mjs'
import { rustKernelHealth } from '../src/lib/transport/rust-kernel-client.mjs'
import { slotExec } from '../src/lib/vm/slot-runtime.mjs'
import {
  cragSlotHealthy,
  matchingCragTree,
  runningCragCoreHashes,
  waitForCragCore,
} from '../src/lib/vm/crag-core-check.mjs'

// Kept as a named export for callers and tests; the implementation now ships
// with the control plane under src/lib so the panel can reuse it.
export const runningCragHashes = runningCragCoreHashes

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
  {
    tag = '',
    api,
    pull = pullKernelRelease,
    health = rustKernelHealth,
    coreHashes = runningCragCoreHashes,
    coreWait = {},
  } = {},
) {
  const base = path.join(root, 'share/crag/kernels/v2')
  fs.mkdirSync(base, { recursive: true })
  const lock = path.join(base, '.update-lock')
  fs.mkdirSync(lock, { mode: 0o700 })
  try {
    const routing = JSON.parse(fs.readFileSync(path.join(root, 'src/config/routing.json'), 'utf8'))
    const inventory = cragUpdateInventory(root, routing)
    const pulled = await pull(root, { kernel: 'crag', tag, latest: true })
    if (!pulled.ok) throw new Error(pulled.code || 'crag_pull_failed')
    const src = cragV2PackageRoot(root)
    const verified = verifyCragV2Tree(src)
    if (!verified.ok) throw new Error(verified.code)
    const manifest = fs.readFileSync(path.join(src, 'manifest.json'))
    const expectedCore = verified.manifest.payload.plaintext_sha256
    const matchingTree = (dir) => matchingCragTree(dir, manifest)
    const matchingCore = (hashes) => hashes.length === 1 && hashes[0] === expectedCore

    const targets = []
    for (const { vm, action, installed } of inventory) {
      if (action !== 'sync') continue
      if (
        !vm.node_id &&
        matchingTree(installed) &&
        (vm.status === 'stopped' || (vm.status === 'running' && matchingCore(await coreHashes(vm))))
      )
        continue
      targets.push({ id: vm.id, kernel: 'crag' })
    }

    const results = new Map()
    if (targets.length) {
      const { payload_tag, tag: releaseTag } = pulled.release || {}
      if (!payload_tag && !releaseTag) throw new Error('crag_release_pin_missing')
      const pin = payload_tag ? { payload_tag } : { expected_tag: releaseTag }
      const receipt = await api('/api/panel/kernels/crag-update', {
        targets: targets.map((target) => ({ ...target, ...pin })),
        background: true,
      })
      if (!receipt?.job_id) throw new Error('crag_install_unconfirmed')
      const endpoint = `/api/panel/kernels/install?${new URLSearchParams({ job_id: receipt.job_id })}`
      const deadline = Date.now() + 15 * 60_000
      let report
      while (Date.now() < deadline) {
        const job = await api(endpoint)
        if (job.state === 'completed') {
          report = job.report
          break
        }
        if (job.state !== 'running') break
        await delay(1000)
      }
      if (!Array.isArray(report?.items) || report.items.length !== targets.length)
        throw new Error('crag_install_unconfirmed')
      for (const item of report.items) results.set(item.id, item)
      const failed = targets.flatMap(({ id }) => {
        const item = results.get(id)
        if (item?.ok !== true) return [`${id}:${item?.code || 'crag_install_unconfirmed'}`]
        if (payload_tag && item.payload_tag !== payload_tag) return [`${id}:crag_payload_changed`]
        return []
      })
      if (failed.length || report.ok !== true) throw new Error(`crag_install_failed:${failed.join(',')}`)
    }

    const items = []
    for (const { vm, action, installed } of inventory) {
      const result = results.get(vm.id)
      const status = result?.status ?? vm.status
      const item = { id: vm.id, action, status, node_id: vm.node_id || null, ok: true }
      if (action === 'cache' && !matchingTree(installed)) refreshCachedPackage(src, installed)
      if (action !== 'skip' && !vm.node_id && !matchingTree(installed))
        throw new Error(`crag_installed_hash_mismatch:${vm.id}`)
      if (action === 'sync' && vm.node_id) {
        item.verified_by = 'panel_install'
      } else if (action === 'sync' && status === 'running') {
        const current = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`), 'utf8'))
        if (current.node_id) throw new Error(`crag_inventory_changed:${vm.id}`)
        const core = await waitForCragCore(current, expectedCore, { coreHashes, sleep: delay, ...coreWait })
        if (!core.ok) throw new Error(`${core.code}:${vm.id}`)
        if (!(await cragSlotHealthy(slotExec(root, current), { health })))
          throw new Error(`crag_slot_not_healthy:${vm.id}`)
        // Cores spawn lazily. With the installed tree already hash-verified,
        // a slot that has none up yet is pending, not inconsistent.
        if (core.state === 'verified') item.running_core_sha256 = core.sha
        else item.core_pending = true
      }
      items.push(item)
    }
    return {
      ok: true,
      release: pulled.release,
      manifest_sha256: crypto.createHash('sha256').update(manifest).digest('hex'),
      items,
    }
  } finally {
    fs.rmdirSync(lock)
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
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const result = await response.json()
    if (!response.ok || result.ok !== true || !result.data)
      throw new Error(`panel_api_failed:${endpoint}:${response.status}:${result.error?.code || 'unknown'}`)
    return result.data
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(process.argv[2] || process.env.KIN_PROJECT_ROOT || '/opt/vm2api')
  try {
    console.log(JSON.stringify(await updateCrag(root, { tag: process.argv[3] || '', api: localPanelApi(root) })))
  } catch (error) {
    console.error(`CRAG update failed: ${error.message}; check slot state before submitting another update`)
    process.exitCode = 1
  }
}
