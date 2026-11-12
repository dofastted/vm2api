/** Native telemetry status, read from the same authenticated VM kernel as inference. */
import { rustKernelHealth, toPublicKernelHealth } from '../transport/rust-kernel-client.mjs'
import { slotExec } from './slot-runtime.mjs'
import { slotHost } from './slot-host.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { runSlotProcess } from '../transport/slot-oauth.mjs'
import { slotExecArgv, slotExecContainer } from './slot-exec.mjs'
import { inspectContainerOrNull } from '../cluster/docker-remote.mjs'

export const RETIRE_LEGACY_TELEMETRY = `
set -eu
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

export async function retireLegacyTelemetry({ vm, run = runSlotProcess, inspect = inspectContainerOrNull } = {}) {
  if (!vm?.id) return { ok: false, code: 'invalid_vm' }
  const host = slotHost(vm)
  if (host.native) return { ok: false, code: 'telemetry_unsupported' }
  let runtime
  try {
    runtime = await inspect(host.dockerApi(), slotExecContainer(vm))
  } catch {
    return { ok: false, code: 'telemetry_runtime_unavailable' }
  }
  if (!runtime?.State?.Running) return { ok: true, running: false, state: 'stopped' }
  const result = await run(slotExecArgv(vm, ['sh', '-c', RETIRE_LEGACY_TELEMETRY]), {
    timeoutMs: 5000,
    env: host.dockerEnv(),
  })
  return result.code === 0 && !result.timed_out
    ? { ok: true, running: true }
    : { ok: false, code: 'legacy_telemetry_stop_failed', error: 'Legacy telemetry process did not stop' }
}

export async function readSlotProcessStatus({ projectRoot, vm, health = rustKernelHealth, timeoutMs = 2500 } = {}) {
  const unknown = { telemetry: null, process_topology: null }
  if (!projectRoot || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(String(vm?.id || ''))) return unknown
  if (isCodexVm(vm) || slotHost(vm).native) {
    return {
      ...unknown,
      telemetry: { enabled: false, state: 'unsupported', pending_events: 0, last_upload_at: null, last_error: null },
    }
  }
  try {
    const observed = await health(slotExec(projectRoot, vm), { timeoutMs })
    return { ...unknown, telemetry: toPublicKernelHealth(observed, 'rust').telemetry ?? null }
  } catch {
    // A stopped/unreachable VM is unknown, not disabled or uploading.
    return unknown
  }
}
