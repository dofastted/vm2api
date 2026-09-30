/**
 * Host-side Codex kernel lifecycle. Dedicated Codex VMs listen on
 * vms/<id>/run/codex-kernel.sock; Claude workers are never reused.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { boundProxyUrl, isLocalEgressProxy } from '../vm/egress.mjs'
import { assertProxyAllowed } from '../vm/proxy-policy.mjs'
import { codexKernelHealth, codexKernelPaths } from './codex-kernel-client.mjs'

const starts = new Map()

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

export function writeCodexKernelConfig(projectRoot, vm, { token, proxyUrl, proxyRequired } = {}) {
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
  const proxy = local ? '' : String(proxyUrl || boundProxyUrl(vm?.proxy) || '').trim()
  const required = local ? false : proxyRequired == null ? !!proxy : !!proxyRequired
  const deviceId = String(vm.device_id || vm.fingerprint?.device_id || vm.id).trim() || vm.id
  const config = {
    vm_id: vm.id,
    device_id: deviceId,
    socket_path: socketPath,
    credential_path: credentialPath,
    proxy_url: proxy,
    proxy_required: required,
    internal_token: secret,
    // Keep Codex slots aligned with the 32 MiB body budget in the bundled
    // kernel. Newer kernels can read this value; older binaries use the
    // patched 32 MiB default directly.
    max_request_bytes: 32 * 1024 * 1024,
    test_endpoints: process.env.KIN_CODEX_TEST_ENDPOINTS === '1',
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  return { runDir, socketPath, configPath, credentialPath, tokenPath }
}

export async function ensureCodexKernel(exec, { timeoutMs = 8000 } = {}) {
  const bin = codexKernelBinPath()
  if (!bin) return { ok: false, reason: 'bin_missing' }
  const paths = codexKernelPaths(exec)
  if (!paths.configPath) return { ok: false, reason: 'config_missing' }
  const live = await waitForHealth(exec, Math.min(800, Math.max(200, Number(timeoutMs) || 800)))
  if (live.ok) return { ok: true, reused: true, health: live.health }
  const current = starts.get(exec.vmId)
  if (current && !current.killed) return waitForHealth(exec, timeoutMs)
  try {
    if (paths.socketPath) fs.unlinkSync(paths.socketPath)
  } catch {}
  const child = spawn(bin, [paths.configPath], {
    stdio: 'ignore',
    detached: true,
  })
  child.unref()
  starts.set(exec.vmId, child)
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

export function stopAllCodexKernels() {
  for (const vmId of [...starts.keys()]) stopCodexKernel(vmId)
}
