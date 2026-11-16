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
import { execDetached } from '../cluster/docker-remote.mjs'
import { NODE_CLAUDE_SETUP_PY, slotContainerName } from '../transport/rust-kernel-supervisor.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { slotExecCmd } from './slot-exec.mjs'
import { slotHost } from './slot-host.mjs'

export const CLI_NODE_GUARD_INTERVAL_MS = 15_000
// Node Docker slots also get the Claude onboarding flags re-asserted (see
// NODE_CLAUDE_SETUP_PY): a running kernel is never restarted, so this is the
// path that reaches a slot whose cli-home lost them.
export const NODE_SETUP_INTERVAL_MS = 60_000

// Same set the kernel watchdog skips: no container to exec into, so every tick
// would only log `No such container` / `is not running`.
const HARD_DOWN = new Set(['stopped', 'dead', 'error', 'disabled'])

export function isCliNodeGuardTarget(vm) {
  if (!vm?.id || isCodexVm(vm)) return false
  return !HARD_DOWN.has(String(vm.status || '').toLowerCase())
}

// $0 is "guard"; "$@" are live KIN_PANEL_SHELL tokens. KIN_GUARD_PROC is a test seam.
export const GUARD_SCRIPT = `
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
    for token in "$@"; do
      [ "$token" = "$panel" ] && continue 2
    done
  fi
  kill -KILL "$pid" 2>/dev/null || true
done
exit 0
`

export function createCliNodeGuard({
  listTargets,
  liveTokens = () => [],
  exec = execDetached,
  intervalMs = CLI_NODE_GUARD_INTERVAL_MS,
  logger = console,
  hostFor = slotHost,
} = {}) {
  let timer = null
  let inTick = false
  const setupAt = new Map()

  async function tick() {
    if (inTick) return
    inTick = true
    try {
      const tokens = liveTokens().filter(Boolean)
      const vms = (listTargets?.() || []).filter(isCliNodeGuardTarget)
      for (const vm of vms) {
        try {
          const host = hostFor(vm)
          // The guard script walks /proc inside a Linux slot; a macOS node has neither.
          if (host.native) continue
          const connect = host.dockerApi()
          const container = slotContainerName({ vm })
          const { Cmd, User } = slotExecCmd(vm, ['/bin/sh', '-c', GUARD_SCRIPT, 'guard', ...tokens], {
            detach: true,
            user: isKvmRuntime(vm) ? '0' : undefined,
          })
          await exec(connect, container, Cmd, { user: User })
          if (host.bakedKernel && !isKvmRuntime(vm) && Date.now() - (setupAt.get(vm.id) || 0) >= NODE_SETUP_INTERVAL_MS) {
            const setup = slotExecCmd(vm, ['python3', '-c', NODE_CLAUDE_SETUP_PY], {
              detach: true,
              user: host.execUser(vm),
            })
            await exec(connect, container, setup.Cmd, { user: setup.User })
            setupAt.set(vm.id, Date.now())
          }
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
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
