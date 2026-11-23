/** Native telemetry status, read from the same authenticated VM kernel as inference. */
import {
  rustKernelHealth,
  supportsCragTelemetryApply,
  toPublicKernelHealth,
  verifyCragTelemetryPolicy,
} from '../transport/rust-kernel-client.mjs'
import { cragV2KernelActive } from '../protocol/crag-print-prompt.mjs'
import { isTelemetryEnabled } from '../protocol/seed-policy.mjs'
import { slotExec } from './slot-runtime.mjs'
import { resolveKernelDataplane } from './slot-engine.mjs'
import { slotHost } from './slot-host.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { hasClusterFingerprintBinds } from '../cluster/remote-slot.mjs'
import { runSlotProcess } from '../transport/slot-oauth.mjs'
import { slotExecArgv, slotExecContainer } from './slot-exec.mjs'
import { inspectContainerOrNull } from '../cluster/docker-remote.mjs'

/**
 * Printed before anything can fail. The docker CLI exits 1 for its own transport
 * errors (bridge socket gone, connection reset) — indistinguishable from the
 * script's `exit 1` — but it only relays stdout once the exec really ran.
 */
export const RETIRE_RAN_MARKER = 'kin-retire:ran'

export const RETIRE_LEGACY_TELEMETRY = `
set -eu
printf '${RETIRE_RAN_MARKER}\\n'
legacy_pids() { ps -eo pid,args | awk '$2 ~ /(^|\\/)kin-worker$/ && $3 == "telemetry" {print $1}'; }
pids=$(legacy_pids)
for pid in $pids; do
  case "$pid" in ''|*[!0-9]*) exit 1;; esac
  command=$(tr '\\000' ' ' < /proc/$pid/cmdline 2>/dev/null || true)
  case "$command" in *kin-worker\\ telemetry\\ --config\\ *) kill -TERM "$pid";; *) exit 1;; esac
done
attempt=0
while [ -n "$(legacy_pids)" ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 20 ] || exit 1
  sleep 0.1
done
printf '{"ok":true}\\n'
`

/** A failed retire is the script's own verdict only when it exited numerically after printing the marker. */
export function retireScriptVerdict(result) {
  return typeof result?.code === 'number' && String(result?.stdout || '').includes(RETIRE_RAN_MARKER)
}

export async function retireLegacyTelemetry({ vm, run = runSlotProcess, inspect = inspectContainerOrNull } = {}) {
  if (!vm?.id) return { ok: false, code: 'invalid_vm' }
  const host = slotHost(vm)
  if (host.native) return { ok: false, code: 'telemetry_unsupported' }
  let runtime
  try {
    const docker = inspect === inspectContainerOrNull ? host.dockerApi() : null
    runtime = await inspect(docker, slotExecContainer(vm))
  } catch {
    return { ok: false, code: 'telemetry_runtime_unavailable' }
  }
  if (!runtime?.State?.Running) return { ok: true, running: false, state: 'stopped' }
  const needsRecreate = Boolean(vm.node_id) && !isKvmRuntime(vm) && !hasClusterFingerprintBinds(runtime)
  const recreateMeta = needsRecreate ? { needsRecreate: true } : {}
  const env = run === runSlotProcess ? host.dockerEnv() : undefined
  const attempt = () =>
    run(slotExecArgv(vm, ['sh', '-c', RETIRE_LEGACY_TELEMETRY]), {
      timeoutMs: 5000,
      env,
    })
  const result = await attempt()
  if (result.code === 0 && !result.timed_out) return { ok: true, running: true, ...recreateMeta }
  // Only a numeric exit after the marker means the script really ran and the
  // sender survived; anything else (docker CLI transport error, null code,
  // timeout) is the slot exec never completing — node-link flap, not a dead
  // sender. Retry once, then report unverified instead of failing the
  // publication on transport jitter.
  if (retireScriptVerdict(result)) {
    return { ok: false, code: 'legacy_telemetry_stop_failed', error: 'Legacy telemetry process did not stop' }
  }
  const retry = await attempt()
  if (retry.code === 0 && !retry.timed_out) return { ok: true, running: true, ...recreateMeta }
  if (retireScriptVerdict(retry)) {
    return { ok: false, code: 'legacy_telemetry_stop_failed', error: 'Legacy telemetry process did not stop' }
  }
  console.warn(`[slot-process] ${vm.id} legacy telemetry retire unverified (slot exec unavailable)`)
  return {
    ok: true,
    running: true,
    unverified: true,
    ...recreateMeta,
    code: 'legacy_telemetry_unverified',
    error: 'Legacy telemetry retire unverified (slot exec unavailable)',
  }
}

export async function readSlotProcessStatus({
  projectRoot,
  vm,
  routing = {},
  health = rustKernelHealth,
  timeoutMs = 2500,
} = {}) {
  const unknown = { telemetry: null, process_topology: null }
  if (!projectRoot || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(String(vm?.id || ''))) return unknown
  if (isCodexVm(vm) || slotHost(vm).native) {
    return {
      ...unknown,
      telemetry: { enabled: false, state: 'unsupported', pending_events: 0, last_upload_at: null, last_error: null },
    }
  }
  let crag = resolveKernelDataplane(vm, routing) === 'crag'
  const unconfirmed = '未能核验 CRAG 启动策略'
  const cragStatus = ({ enabled = null, error = null, reason = null, upstream_message = null } = {}) => ({
    ...unknown,
    telemetry: {
      state: 'launch_policy',
      enabled,
      error,
      upload_confirmed: false,
      ...(reason ? { reason } : {}),
      ...(upstream_message ? { upstream_message } : {}),
    },
  })
  try {
    const exec = slotExec(projectRoot, vm)
    const observed = await health(exec, { timeoutMs })
    const liveCrag = cragV2KernelActive({ health: observed })
    crag ||= liveCrag
    if (!crag) return { ...unknown, telemetry: toPublicKernelHealth(observed, 'rust').telemetry ?? null }
    if (observed?.ok !== true) return cragStatus({ error: unconfirmed })
    if (!liveCrag) return cragStatus({ error: '运行中的内核不是 CRAG' })
    if (!supportsCragTelemetryApply(observed)) return cragStatus({ error: '运行中的 CRAG 不支持遥测核验' })
    const verified = await verifyCragTelemetryPolicy(exec, isTelemetryEnabled(vm.seed_policy), timeoutMs)
    return cragStatus(verified)
  } catch {
    return crag ? cragStatus({ error: unconfirmed }) : unknown
  }
}
