/**
 * Host-side Codex kernel lifecycle. Dedicated Codex VMs listen on
 * vms/<id>/run/codex-kernel.sock; Claude workers are never reused.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { boundProxyUrl, isLocalEgressProxy, localEgressProxyUrl } from '../vm/egress.mjs'
import { vmNodeId } from '../cluster/placement.mjs'
import { assertProxyAllowed } from '../vm/proxy-policy.mjs'
import { maxRequestBytes } from '../core/config.mjs'
import { openAIRuntimeSignals } from '../pool/openai-account-runtime.mjs'
import { codexKernelHealth, codexKernelPaths } from './codex-kernel-client.mjs'
import { computedUpstreamTransport, normalizeCodexRouting } from '../protocol/codex-route.mjs'

const starts = new Map()
const stops = new Map()

// The kernel exits only through config.proxy_url; inherited proxy variables would give it a second, unseen exit.
function kernelEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(https?|all|no)_proxy$/i.test(key)))
}

function existingBin(candidate) {
  const bin = String(candidate || '').trim()
  if (!bin) return ''
  try {
    fs.accessSync(bin, fs.constants.X_OK)
    return bin
  } catch {
    return ''
  }
}

export function codexKernelBinPath() {
  const env = existingBin(process.env.KIN_CODEX_KERNEL_BIN)
  if (env) return env
  const kernel = String(process.env.KIN_KERNEL_BIN || process.env.KIN_API_KERNEL_BIN || '').trim()
  if (kernel) {
    const sibling = existingBin(path.join(path.dirname(kernel), 'kin-codex-kernel'))
    if (sibling) return sibling
  }
  return existingBin(path.resolve('bin/kin-codex-kernel'))
}

/** Per-hop policy keeps settings live without interrupting another request's kernel. */
export function codexKernelRequestOptions(routing = {}) {
  const codex = normalizeCodexRouting(routing.codex)
  return {
    upstream_transport: computedUpstreamTransport(routing),
    user_agent: codex.user_agent,
    client_features: codex.client_features.enabled === true,
    analytics: codex.analytics.enabled === true,
  }
}

export function writeCodexKernelConfig(projectRoot, vm, { token, proxyUrl, proxyRequired, routing } = {}) {
  if (!projectRoot || !vm?.id) return null
  assertProxyAllowed(vm.proxy)
  if (proxyUrl) assertProxyAllowed({ url: proxyUrl })
  const runDir = path.join(projectRoot, 'vms', vm.id, 'run')
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const socketPath = path.join(runDir, 'codex-kernel.sock')
  const configPath = path.join(runDir, 'codex-kernel.json')
  const tokenPath = path.join(runDir, 'internal.token')
  const credentialPath = path.join(projectRoot, 'vms', vm.id, 'codex-credentials.json')
  let secret = String(token || '').trim()
  if (!secret) {
    try {
      secret = fs.readFileSync(tokenPath, 'utf8').trim()
    } catch {}
  }
  if (!secret) secret = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(tokenPath, secret + '\n', { mode: 0o600 })
  const local = isLocalEgressProxy(vm?.proxy)
  // Only a slot on this host treats local egress as the deployment proxy.
  // A node slot is handed that node's forwarder; replacing it would exit from here.
  const hostLocal = local && !vmNodeId(vm)
  const proxy = hostLocal ? localEgressProxyUrl() : String(proxyUrl || boundProxyUrl(vm?.proxy) || '').trim()
  // A configured deployment proxy is this slot's exit: fail closed instead of going direct.
  const required = hostLocal ? !!proxy : proxyRequired == null ? !!proxy : !!proxyRequired
  const installationPath = path.join(runDir, 'codex-installation-id')
  let deviceId = ''
  try {
    deviceId = fs.readFileSync(installationPath, 'utf8').trim()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  // Official installation identity is a random UUID, never a VM or hardware fingerprint.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
    deviceId = crypto.randomUUID()
    fs.writeFileSync(installationPath, `${deviceId}\n`, { mode: 0o600 })
  }
  const config = {
    vm_id: vm.id,
    device_id: deviceId,
    socket_path: socketPath,
    credential_path: credentialPath,
    proxy_url: proxy,
    proxy_required: required,
    internal_token: secret,
    max_request_bytes: maxRequestBytes(routing),
    ...codexKernelRequestOptions(routing),
    test_endpoints: process.env.KIN_CODEX_TEST_ENDPOINTS === '1',
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  return { runDir, socketPath, configPath, credentialPath, tokenPath, installationId: deviceId }
}

export function shouldRecycleCodexKernel({ wanted, stamped, inFlight } = {}) {
  return wanted > 0 && stamped > 0 && wanted !== stamped && inFlight <= 1
}

function limitStampPath(configPath) {
  return configPath ? path.join(path.dirname(configPath), 'codex-kernel.limit') : ''
}

function readLimitStamp(configPath) {
  try {
    return Number(fs.readFileSync(limitStampPath(configPath), 'utf8')) || 0
  } catch {
    return 0
  }
}

function writeLimitStamp(configPath, bytes) {
  if (!configPath || !(bytes > 0)) return
  fs.writeFileSync(limitStampPath(configPath), `${bytes}\n`, { mode: 0o600 })
}

function configRequestBytes(configPath) {
  try {
    return Number(JSON.parse(fs.readFileSync(configPath, 'utf8')).max_request_bytes) || 0
  } catch {
    return 0
  }
}

function childHasExited(child) {
  return !child || child.exitCode != null || child.signalCode != null
}

function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(true)
  if (!(timeoutMs > 0)) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(exited)
    }
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs)
    child.once('exit', () => finish(true))
  })
}

/** SIGTERM, then SIGKILL. Unlink the socket only after the process is actually gone. */
export async function finishCodexRecycle(child, socketPath, { termMs = 2000, killMs = 1000 } = {}) {
  if (!childHasExited(child)) {
    try {
      child.kill('SIGTERM')
    } catch {}
  }
  let exited = await waitForChildExit(child, termMs)
  if (!exited && killMs > 0) {
    try {
      child.kill('SIGKILL')
    } catch {}
    exited = await waitForChildExit(child, killMs)
  }
  if (!exited) return { exited: false }
  if (socketPath) {
    try {
      fs.unlinkSync(socketPath)
    } catch {}
  }
  return { exited: true }
}

/** Explicit reload must stop the host process, not just its slot container. */
export function stopCodexKernelAndWait(exec, opts = {}) {
  const vmId = exec?.vmId
  if (stops.has(vmId)) return stops.get(vmId)
  const pending = (async () => {
    const child = starts.get(vmId)
    const paths = codexKernelPaths(exec)
    if (!child) {
      const health = await codexKernelHealth(exec, { timeoutMs: 500 })
      if (health.code === 'ENOENT' || health.code === 'ECONNREFUSED') return { ok: true, stopped: false }
      // A prior Node process may have left a detached kernel. Do not unlink a
      // listening socket or claim success when we cannot verify its owner's exit.
      return { ok: false, reason: 'untracked_kernel' }
    }
    const gone = await finishCodexRecycle(child, paths.socketPath, opts)
    if (!gone.exited) return { ok: false, reason: 'recycle_timeout' }
    if (starts.get(vmId) === child) starts.delete(vmId)
    return { ok: true, stopped: true }
  })()
  const settled = pending.finally(() => {
    if (stops.get(vmId) === settled) stops.delete(vmId)
  })
  stops.set(vmId, settled)
  return settled
}

export async function ensureCodexKernel(exec, { timeoutMs = 8000 } = {}) {
  const stopping = stops.get(exec?.vmId)
  if (stopping) {
    const stopped = await stopping
    if (!stopped.ok) return stopped
  }
  const bin = codexKernelBinPath()
  if (!bin) return { ok: false, reason: 'bin_missing' }
  const paths = codexKernelPaths(exec)
  if (!paths.configPath) return { ok: false, reason: 'config_missing' }
  const wanted = configRequestBytes(paths.configPath)
  const stamped = readLimitStamp(paths.configPath)
  const inFlight = openAIRuntimeSignals(exec.vmId).inFlight
  // Only the request that holds this seat may recycle. A timeout is not an
  // exit: leave the socket and the tracked child in place.
  if (shouldRecycleCodexKernel({ wanted, stamped, inFlight })) {
    const child = stopCodexKernel(exec.vmId)
    if (child) {
      const gone = await finishCodexRecycle(child, paths.socketPath)
      if (!gone.exited) {
        starts.set(exec.vmId, child)
        return { ok: false, reason: 'recycle_timeout' }
      }
    }
  }
  const live = await waitForHealth(exec, Math.min(800, Math.max(200, Number(timeoutMs) || 800)))
  if (live.ok) return { ok: true, reused: true, health: live.health }
  const current = starts.get(exec.vmId)
  if (!childHasExited(current)) return waitForHealth(exec, timeoutMs)
  try {
    if (paths.socketPath) fs.unlinkSync(paths.socketPath)
  } catch {}
  const child = spawn(bin, [paths.configPath], {
    env: kernelEnv(),
    stdio: 'ignore',
    detached: true,
  })
  child.unref()
  starts.set(exec.vmId, child)
  writeLimitStamp(paths.configPath, wanted)
  return waitForHealth(exec, timeoutMs)
}

async function waitForHealth(exec, timeoutMs) {
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 8000)
  let last = { ok: false, reason: 'not_ready' }
  while (Date.now() < deadline) {
    last = await codexKernelHealth(exec, { timeoutMs: 500 }).catch((error) => ({
      ok: false,
      reason: 'health_error',
      error: String(error.message || error),
    }))
    if (last?.ok || Number(last?.status) === 200) return { ok: true, health: last }
    await new Promise((r) => setTimeout(r, 100))
  }
  return { ok: false, reason: 'health_timeout', health: last }
}

export function stopCodexKernel(vmId) {
  const child = starts.get(vmId)
  if (child) {
    try {
      child.kill('SIGTERM')
    } catch {}
    starts.delete(vmId)
  }
  return child || null
}

/** A child this process spawned for the VM that has not exited (it may still be starting or hung). */
export function codexKernelTracked(vmId) {
  return !childHasExited(starts.get(vmId))
}

export function stopAllCodexKernels() {
  for (const vmId of [...starts.keys()]) stopCodexKernel(vmId)
}
