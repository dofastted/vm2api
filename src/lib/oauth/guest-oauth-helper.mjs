import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { slotHost } from '../vm/slot-host.mjs'
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
const safeCode = (value, fallback) => (/^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback)

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
    throw fail(boot?.rust?.code || boot?.code || 'oauth_runtime_not_ready', 'Target VM native CLI is not ready')
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
  } = {},
) {
  const context = await prepare({ exec, projectRoot, routing, timeoutMs, proxyPool })
  const { host, configDir, home } = context
  exec = context.exec
  // Native nodes and legacy kernels both exchange on the controller, through the
  // exit prepare resolved for this VM. Guest execution is below.
  if (context.controlPlane) return runNative({ ...payload, proxy_url: context.proxyUrl })
  const bin = host.bins.oauthAuth
  if (!bin) throw fail('oauth_auth_bin_missing', 'Target VM OAuth helper is not installed')
  const argv = slotExecArgv(exec.vm, [bin], {
    interactive: true,
    user: host.execUser(exec.vm),
    workdir: home,
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: configDir,
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
      // first-token date, bootstrap) at the per-request ceiling, plus startup.
      timeoutMs: Math.max(timeoutMs * 8, 120_000),
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
