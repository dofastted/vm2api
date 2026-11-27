import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { slotHost } from '../vm/slot-host.mjs'
import { isCustomKvmMode } from '../vm/custom-os-runtime.mjs'
import { isKvmRuntime } from '../vm/runtime-kind.mjs'
import { syncCustomKvmSlotFiles } from '../vm/kvm-slot-agent-client.mjs'
import { resolveSlotOAuthProxy } from '../vm/proxy-resolve.mjs'
import { slotExecArgv } from '../vm/slot-exec.mjs'
import { resolveSlotClaude } from '../vm/slot-engine.mjs'
import { slotExec, startSlotReady } from '../vm/slot-runtime.mjs'
import { getVm, patchVmRecord } from '../vm/vm-registry.mjs'
import { hasBoundExit } from '../vm/egress.mjs'
import { proxyBlockedReason } from '../vm/proxy-policy.mjs'
import { postRustKernelTelemetryEvent, rustKernelHealth, rustKernelPaths } from '../transport/rust-kernel-client.mjs'
import { runSlotProcess } from '../transport/slot-oauth.mjs'
import { OAUTH_REQUEST_TIMEOUT_MS } from './oauth-contract.mjs'

const pendingAttempt = Symbol('guestOAuthAttempt')
// `test` stringifies its argument, so undefined/null match the pattern as "undefined"/"null"
// and were returned as the code. Require a string, like every other code guard in the tree.
const safeCode = (value, fallback) =>
  typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

/** OS/CLI readiness is not account readiness and never reopens scheduling. */
export async function prepareSlotOAuth({
  exec,
  projectRoot = exec?.projectRoot,
  routing = {},
  timeoutMs,
  proxyPool,
  startReady = startSlotReady,
  readHealth = rustKernelHealth,
} = {}) {
  if (!projectRoot || !exec?.vmId || (exec.vm?.id && exec.vm.id !== exec.vmId)) {
    throw fail('oauth_vm_required', 'OAuth requires a target VM execution context')
  }
  const vm = getVm(projectRoot, exec.vmId)
  if (!vm?.id) throw fail('oauth_vm_required', 'OAuth target VM is missing')
  const host = slotHost(vm)
  // A native node has no container: the helper runs on the controller, through
  // this VM's exit as it is now. The caller's payload value is never the exit.
  if (host.native) {
    return { exec: { ...exec, vm }, host, controlPlane: true, proxyUrl: resolveSlotOAuthProxy(vm, proxyPool) }
  }
  const blocked = proxyBlockedReason(vm.proxy)
  if (blocked || !hasBoundExit(vm.proxy)) {
    throw fail(blocked || 'proxy_required', 'OAuth requires the target VM bound egress')
  }
  Object.assign(exec, slotExec(projectRoot, vm))
  const health = await readHealth(exec, { timeoutMs: 1000 })
  // Legacy kernels cannot gain telemetry by restarting. Exchange through the
  // same bound exit on the controller before entering the slot startup path.
  if (health?.vm_telemetry !== true || health?.telemetry_ready !== true) {
    return { exec, host, controlPlane: true, proxyUrl: resolveSlotOAuthProxy(vm, proxyPool) }
  }
  const boot = await startReady(vm, projectRoot, { routing, allowMissingCredential: true, timeoutMs })
  if (!boot?.ok || boot.rust_ok === false || !boot.rust?.ok || boot.rust.skipped) {
    // One sanitized code feeds both err.code and the message, so they cannot disagree.
    // The default inside keeps a missing code from being stringified to "undefined" by safeCode.
    const code = safeCode(boot?.rust?.code || boot?.code || 'oauth_runtime_not_ready', 'oauth_runtime_not_ready')
    throw fail(code, `Target VM native CLI is not ready (${code})`)
  }
  const patch = { ...(boot.runtime ? { runtime: boot.runtime } : {}), status: 'running' }
  const stored = patchVmRecord(projectRoot, vm.id, patch)
  Object.assign(vm, stored || patch)
  Object.assign(exec, slotExec(projectRoot, vm))
  const configPath = rustKernelPaths(exec).configPath
  let config
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {
    throw fail('oauth_config_missing', 'Target VM kernel config is unavailable')
  }
  const configDir = path.posix.dirname(String(config.credential_path || ''))
  if (!path.posix.isAbsolute(configDir) || configDir === '/') {
    throw fail('oauth_config_invalid', 'Target VM credential HOME is unavailable')
  }
  return { exec, host, configDir, home: path.posix.dirname(configDir) }
}

/** Keep operation context in memory only, never in credentials or JSON responses. */
export function carryOAuthAttempt(source, target) {
  if (source?.[pendingAttempt]) target[pendingAttempt] = source[pendingAttempt]
  return target
}

/** Terminal success follows the authoritative credential import, not helper stdout. */
export async function finishOAuthImport(oauth, ok) {
  const attempt = oauth?.[pendingAttempt]
  if (!attempt || attempt.finished) return null
  attempt.finished = true
  return attempt.record(ok ? 'success' : 'failure', ok ? undefined : 'credential_import_failed')
}

/**
 * A controller-side exchange has no env of its own: hand the helper the slot's
 * **worker** config (`worker.json`), which is what carries `vm_id`, `proxy_url`
 * and `egress_mode`. `kernel.json` lacks `egress_mode`, and an empty proxy there
 * made the worker refuse every dial ("upstream transport failed").
 */
function workerConfig(exec) {
  try {
    const runDir = rustKernelPaths(exec).runDir
    const configPath = runDir ? path.join(runDir, 'worker.json') : null
    return configPath && fs.existsSync(configPath) ? { worker_config_path: configPath } : {}
  } catch {
    return {}
  }
}

export async function runGuestOAuthAuthService(
  payload,
  {
    exec,
    projectRoot = exec?.projectRoot,
    routing,
    timeoutMs = OAUTH_REQUEST_TIMEOUT_MS,
    proxyPool,
    prepare = prepareSlotOAuth,
    runDocker = runSlotProcess,
    postTelemetry = postRustKernelTelemetryEvent,
    runNative,
    syncWorkerConfig = null,
  } = {},
) {
  const context = await prepare({ exec, projectRoot, routing, timeoutMs, proxyPool })
  const { host, configDir, home } = context
  exec = context.exec
  // Native nodes and legacy kernels both exchange on the controller, through the
  // exit prepare resolved for this VM. Guest execution is below.
  if (context.controlPlane) return runNative({ ...payload, proxy_url: context.proxyUrl, ...workerConfig(exec) })
  const bin = host.bins.oauthAuth
  if (!bin) throw fail('oauth_auth_bin_missing', 'Target VM OAuth helper is not installed')
  if (!exec.vm?.node_id && isKvmRuntime(exec.vm) && isCustomKvmMode({ vm: exec.vm })) {
    const runDir = rustKernelPaths(exec).runDir
    const syncOpts = { runDir, targets: ['worker_config'], requiredTargets: ['worker_config'] }
    const syncResult =
      typeof syncWorkerConfig === 'function'
        ? await syncWorkerConfig(projectRoot, exec.vm, syncOpts)
        : await syncCustomKvmSlotFiles(projectRoot, exec.vm, syncOpts)
    const syncedWorker = !Array.isArray(syncResult?.synced) || syncResult.synced.includes('worker_config')
    if (!syncResult?.ok || !syncedWorker) {
      throw fail(
        safeCode(syncResult?.error, 'oauth_worker_config_sync_failed'),
        syncResult?.message || 'Failed to sync worker.json to custom-erofs KVM guest',
      )
    }
  }
  const argv = slotExecArgv(exec.vm, [bin], {
    interactive: true,
    user: host.execUser(exec.vm),
    workdir: home,
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: configDir,
      // The worker config (`worker.json`) carries vm_id/proxy_url/egress_mode and
      // is what `kin-worker oauth session-code` needs; the kernel config does not.
      KIN_WORKER_CONFIG: '/run/kin/worker.json',
      // 'local' retries the browser stage on the local egress when the bound
      // proxy is invalid; anything else reports proxy_invalid to the panel.
      KIN_OAUTH_PROXY_FALLBACK: String(process.env.KIN_OAUTH_PROXY_FALLBACK || ''),
      KERNEL_CONFIG: '/run/kin/kernel.json',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      all_proxy: '',
      no_proxy: '',
    },
  })
  const attempt_id = randomUUID()
  const operation = payload.operation === 'session_key' ? 'session_key' : 'authorization_code'
  const record = async (phase, error_code) => {
    try {
      const result = await postTelemetry(
        exec,
        {
          event_id: randomUUID(),
          kind: 'oauth',
          attempt_id,
          operation,
          phase,
          ...(error_code ? { error_code: safeCode(error_code, 'oauth_auth_failed') } : {}),
        },
        { timeoutMs: 20000 },
      )
      return result?.ok ? null : 'oauth_telemetry_unavailable'
    } catch {
      return 'oauth_telemetry_unavailable'
    }
  }
  await record('start')
  try {
    const selected = resolveSlotClaude(exec.vm, routing, host)
    // The crag v2 entrypoint is version-locked by its own path and payload ships
    // that exact build, so the UA version comes from the entrypoint itself. Asking
    // the CLI for it cost an exec per exchange and refused valid exchanges whenever
    // that exec failed, for a value that was already known.
    const claudeVersion = selected.native ? selected.version : payload.claude_version
    // Linux slots join a kin-eg-* transparent network: the network picks the exit,
    // so the helper gets no proxy at all. This '' is not a resolved exit and must
    // not be replaced by one — a resolved URL may be a controller-local forwarder,
    // unreachable from inside the guest. The env above is cleared for the same reason.
    const result = await runDocker(argv, {
      env: host.dockerEnv(),
      // Token plus the native follow-ups (profile, two evals, roles,
      // first-token date, bootstrap) at the per-request ceiling, plus the two
      // browser-stage hops when the Chrome bridge runs and helper startup.
      timeoutMs: Math.max(timeoutMs * 9, 120_000),
      stdin:
        JSON.stringify({
          ...payload,
          proxy_url: '',
          claude_version: claudeVersion,
        }) + '\n',
    })
    if (result?.timed_out) throw fail('oauth_auth_timeout', 'Target VM OAuth helper timed out')
    if (result?.output_limit)
      throw fail('oauth_auth_output_invalid', 'Target VM OAuth helper exceeded its output limit')
    let output
    try {
      output = JSON.parse(
        String(result?.stdout || '')
          .trim()
          .split(/\r?\n/)
          .at(-1),
      )
    } catch {}
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
      throw fail('oauth_auth_output_invalid', 'Target VM OAuth helper returned invalid output')
    }
    if (output.ok !== true) {
      throw fail(safeCode(output.error?.code, 'oauth_auth_failed'), output.error?.message || 'OAuth helper failed')
    }
    if (result.code !== 0 || !output.credential?.access_token) {
      throw fail('oauth_auth_output_invalid', 'Target VM OAuth helper did not return a credential')
    }
    output.credential[pendingAttempt] = { record, finished: false }
    return output.credential
  } catch (error) {
    await record('failure', error?.code)
    throw error
  }
}
