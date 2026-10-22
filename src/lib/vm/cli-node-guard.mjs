/**
 * One kernel cli-node per slot: the process the kernel spawned. The current
 * kernel sets CLAUDE_CODE_NATIVE_SLOTS. A slot that has not been synced yet
 * still sets CLAUDE_CODE_KIN_NATIVE_SLOTS; that process is the kernel CLI
 * until sync, not a leak. When both are present, keep the unprefixed one.
 * Beside it may run: any `claude` (interactive or `-p`) in a live panel shell,
 * and host-run init bootstrap / setup-token / official auth-login CLIs
 * (KIN_OFFICIAL_CC=1 / KIN_SETUP_TOKEN=1 / KIN_AUTH_LOGIN=1) that have their
 * own lifecycle. Anything else is a leak
 * from a closed terminal (cli-node ignores SIGHUP) and is killed. A process
 * whose environ cannot be read is left alone.
 */
import { execDetached, dockerJson, inspectExec } from '../cluster/docker-remote.mjs'
import { backgroundTasksFor } from '../core/shared-background-tasks.mjs'
import { SharedVmOperations } from './shared-vm-operations.mjs'
import { physicalContainerName } from './vm-physical-target.mjs'
import { slotContainerName } from '../transport/rust-kernel-supervisor.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { slotExecCmd } from './slot-exec.mjs'
import { slotHost } from './slot-host.mjs'

export const CLI_NODE_GUARD_INTERVAL_MS = 15_000

// Same set the kernel watchdog skips: no container to exec into, so every tick
// would only log `No such container` / `is not running`.
const HARD_DOWN = new Set(['stopped', 'dead', 'error', 'disabled'])

export function isCliNodeGuardTarget(vm) {
  if (!vm?.id || isCodexVm(vm)) return false
  return !HARD_DOWN.has(String(vm.status || '').toLowerCase())
}

// $0 is "guard"; "$@" are live KIN_PANEL_SHELL tokens. KIN_GUARD_PROC is a test seam.
export const GUARD_SCRIPT = `
preserve_panels=0
if [ "\${1:-}" = --preserve-panel ]; then preserve_panels=1; shift; fi
proc=\${KIN_GUARD_PROC:-/proc}
keep=
prefer=
for d in "$proc"/[0-9]*; do
  pid=\${d##*/}
  cmd=$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null || true)
  case "$cmd" in *cli-node*) ;; *) continue ;; esac
  env=$(tr '\\0' '\\n' < "$d/environ" 2>/dev/null) || continue
  if printf '%s\\n' "$env" | grep -q '^CLAUDE_CODE_NATIVE_SLOTS='; then
    if [ -z "$prefer" ] || [ "$pid" -lt "$prefer" ]; then prefer=$pid; fi
  elif printf '%s\\n' "$env" | grep -q '^CLAUDE_CODE_KIN_NATIVE_SLOTS='; then
    if [ -z "$keep" ] || [ "$pid" -lt "$keep" ]; then keep=$pid; fi
  fi
done
keep=\${prefer:-$keep}
for d in "$proc"/[0-9]*; do
  pid=\${d##*/}
  [ "$pid" = "$keep" ] && continue
  cmd=$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null || true)
  case "$cmd" in *cli-node*) ;; *) continue ;; esac
  env=$(tr '\\0' '\\n' < "$d/environ" 2>/dev/null) || continue
  [ -n "$env" ] || continue
  if printf '%s\\n' "$env" | grep -q -e '^CLAUDE_CODE_NATIVE_SLOTS=' -e '^CLAUDE_CODE_KIN_NATIVE_SLOTS='; then
    kill -KILL "$pid" 2>/dev/null || true
    continue
  fi
  printf '%s\\n' "$env" | grep -qx -e 'KIN_OFFICIAL_CC=1' -e 'KIN_SETUP_TOKEN=1' -e 'KIN_AUTH_LOGIN=1' && continue
  panel=$(printf '%s\\n' "$env" | sed -n 's/^KIN_PANEL_SHELL=//p' | head -n 1)
  if [ -n "$panel" ]; then
    [ "$preserve_panels" = 1 ] && continue
    for token in "$@"; do
      [ "$token" = "$panel" ] && continue 2
    done
  fi
  kill -KILL "$pid" 2>/dev/null || true
done
exit 0
`

/** A start response does not prove that the cleanup command has exited. */
export async function runCliNodeGuardCommand(connect, container, cmd, { user, timeoutMs = 15000, pollMs = 100 } = {}) {
  let created
  try {
    created = await dockerJson(
      connect,
      {
        method: 'POST',
        path: `/containers/${encodeURIComponent(container)}/exec`,
        body: { Cmd: cmd, AttachStdout: false, AttachStderr: false, ...(user ? { User: user } : {}) },
      },
      [201],
    )
  } catch (error) {
    // The daemon explicitly refused creation; no exec ID was allocated or started.
    if (error.code === 'docker_api_error' && [404, 409].includes(error.status)) {
      error.vmOperationNotStarted = true
      error.taskNotStarted = true
    }
    throw error
  }
  const execId = created.Id
  await dockerJson(
    connect,
    { method: 'POST', path: `/exec/${encodeURIComponent(execId)}/start`, body: { Detach: true } },
    [200],
  )
  const deadline = Date.now() + timeoutMs
  do {
    const state = await inspectExec(connect, execId)
    if (state.Running === false && Number.isInteger(state.ExitCode)) {
      return { ended: true, ok: state.ExitCode === 0, execId, exitCode: state.ExitCode }
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  } while (true)
  return { ended: false, ok: false, execId }
}

export function createCliNodeGuard({
  listTargets,
  liveTokens = () => [],
  exec = null,
  sharedTasks,
  operations = null,
  intervalMs = CLI_NODE_GUARD_INTERVAL_MS,
  logger = console,
} = {}) {
  let timer = null
  let inTick = false
  const tasks = backgroundTasksFor(sharedTasks)
  const mutations = operations || (tasks ? new SharedVmOperations(tasks.db) : null)
  const execute = exec || (tasks ? runCliNodeGuardCommand : execDetached)

  async function tick() {
    if (inTick) return
    inTick = true
    try {
      const tokens = liveTokens().filter(Boolean)
      const vms = (listTargets?.() || []).filter(isCliNodeGuardTarget)
      for (const vm of vms) {
        try {
          const host = slotHost(vm)
          // The guard script walks /proc inside a Linux slot; a macOS node has neither.
          if (host.native) continue
          const connect = host.dockerApi()
          const container = slotContainerName({ vm })
          const { Cmd, User } = slotExecCmd(
            vm,
            ['/bin/sh', '-c', GUARD_SCRIPT, 'guard', ...(tasks ? ['--preserve-panel'] : []), ...tokens],
            {
              detach: true,
              user: isKvmRuntime(vm) ? '0' : undefined,
            },
          )
          if (!tasks) await execute(connect, container, Cmd, { user: User })
          else
            await tasks.run({ taskKey: `cli_node_guard:${physicalContainerName(vm.id)}`, intervalMs }, async () => {
              let result
              try {
                result = await mutations.run(
                  vm.id,
                  async () => {
                    const outcome = await execute(connect, container, Cmd, { user: User })
                    return { ...outcome, vmOperationUncertain: outcome?.ended !== true }
                  },
                  { kind: 'cli_node_guard' },
                )
              } catch (error) {
                if (['vm_execution_active', 'vm_operation_active'].includes(error.code)) error.taskNotStarted = true
                throw error
              }
              return { terminal: result.ended === true, value: result }
            })
        } catch (err) {
          logger.warn?.(`[cli-node-guard] ${vm.id} ${err?.message || err}`)
        }
      }
    } finally {
      inTick = false
    }
  }

  return {
    tick,
    start({ immediate = true } = {}) {
      if (timer) return
      if (immediate) void tick()
      timer = setInterval(() => void tick(), intervalMs)
      timer.unref?.()
    },
    async flush() {
      while (inTick) await new Promise((resolve) => setTimeout(resolve, 10))
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
