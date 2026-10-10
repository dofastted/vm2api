/** Read-only status for the slot detail page. Never return worker identities or credentials. */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { slotContainerName } from '../transport/rust-kernel-supervisor.mjs'
import { slotHost } from './slot-host.mjs'
import { runtimeKind } from './runtime-kind.mjs'
import { slotExecArgv } from './slot-exec.mjs'

const exec = promisify(execFile)
const PROBE = String.raw`
set -eu
main=$(tr '\000' '\n' < /proc/1/cmdline | sed -n '1p')
rust=0; go=0; telemetry=0
case "$main" in
  kin-kernel|*/kin-kernel|kin-kernel.bin|*/kin-kernel.bin) rust=1 ;;
  kin-worker|*/kin-worker) go=1 ;;
  */ld-linux-*.so.*|*/qemu-*)
    # The shipped kernel uses a bundled glibc loader as PID1's executable; on
    # an ARM64 host binfmt QEMU is PID1's executable and the program is argv[1].
    if tr '\000' '\n' < /proc/1/cmdline | grep -Eq '(^|/)kin-kernel(\.bin)?$'; then rust=1; fi
    if tr '\000' '\n' < /proc/1/cmdline | grep -Eq '(^|/)kin-worker$'; then go=1; fi
    ;;
esac
for file in /proc/[0-9]*/comm; do
  name=$(cat "$file" 2>/dev/null) || continue
  [ "$name" = kin-worker ] || continue
  mode=$(tr '\000' '\n' < "$(dirname "$file")/cmdline" 2>/dev/null | sed -n '2p') || continue
  [ "$mode" != telemetry ] || telemetry=1
done
printf 'rust_pid1=%s\ngo_worker_pid1=%s\ngo_telemetry=%s\n' "$rust" "$go" "$telemetry"
`

function isSafeSlotId(id) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(String(id || ''))
}

export async function readSlotProcessStatus({ projectRoot, vm, run = exec, timeoutMs = 2500 } = {}) {
  const unknown = { telemetry: { enabled: null, running: null }, process_topology: null }
  if (!projectRoot || !isSafeSlotId(vm?.id)) return unknown
  let enabled = null
  try {
    const config = JSON.parse(await readFile(path.join(projectRoot, 'vms', vm.id, 'run', 'worker.json'), 'utf8'))
    if (typeof config.telemetry?.enabled === 'boolean') enabled = config.telemetry.enabled
  } catch {
    // Missing or unreadable config is unknown, never equivalent to disabled.
  }
  const kind = runtimeKind(vm)
  if (kind !== 'docker' && kind !== 'kvm') return { ...unknown, telemetry: { enabled, running: null } }
  try {
    const env = slotHost(vm).dockerEnv()
    const target = { ...vm, runtime: { ...(vm.runtime || {}), container: slotContainerName({ vm }), type: kind } }
    const { stdout } = await run('docker', slotExecArgv(target, ['sh', '-c', PROBE]), {
      timeout: timeoutMs,
      maxBuffer: 4096,
      encoding: 'utf8',
      ...(env ? { env } : {}),
    })
    const match = String(stdout)
      .trim()
      .match(/^rust_pid1=([01])\ngo_worker_pid1=([01])\ngo_telemetry=([01])$/)
    if (!match) return { ...unknown, telemetry: { enabled, running: null } }
    const topology = { rust_pid1: match[1] === '1', go_worker_pid1: match[2] === '1', go_telemetry: match[3] === '1' }
    return { telemetry: { enabled, running: topology.go_telemetry }, process_topology: topology }
  } catch {
    // A stopped container, denied Docker access, or timeout must not break the detail page.
    return { ...unknown, telemetry: { enabled, running: null } }
  }
}

/**
 * The sidecar is a `docker exec -d` child with no supervisor: a container restart,
 * a host reboot or its own exit on a 4xx leaves the slot without telemetry for good.
 * Relaunch it only when the config enables it and the container was observed without one.
 * Background check: `docker exec` takes 3-5s on a loaded host, far over the detail page's budget.
 */
export async function ensureTelemetrySidecar({ projectRoot, vm, run = exec, timeoutMs = 15_000 } = {}) {
  const status = await readSlotProcessStatus({ projectRoot, vm, run, timeoutMs })
  if (status.telemetry.enabled !== true || status.telemetry.running !== false) {
    return { ok: true, action: 'unchanged' }
  }
  try {
    const env = slotHost(vm).dockerEnv()
    const kind = runtimeKind(vm)
    const target = { ...vm, runtime: { ...(vm.runtime || {}), container: slotContainerName({ vm }), type: kind } }
    await run(
      'docker',
      slotExecArgv(target, ['/usr/local/bin/kin-worker', 'telemetry', '--config', '/run/kin/worker.json'], {
        detach: true,
      }),
      { timeout: timeoutMs, maxBuffer: 4096, encoding: 'utf8', ...(env ? { env } : {}) },
    )
    return { ok: true, action: 'started' }
  } catch (error) {
    return { ok: false, action: 'start_failed', error: String(error?.message || error) }
  }
}
