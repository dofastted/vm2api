/**
 * One kernel cli-node per slot: the process the kernel spawned. The current
 * kernel sets CLAUDE_CODE_NATIVE_SLOTS. A slot that has not been synced yet
 * still sets CLAUDE_CODE_KIN_NATIVE_SLOTS; that process is the kernel CLI
 * until sync, not a leak. When both are present, keep the unprefixed one.
 * Beside it may run: any `claude` (interactive or `-p`) in a live panel shell,
 * and host-run init bootstrap / setup-token CLIs (KIN_OFFICIAL_CC=1 /
 * KIN_SETUP_TOKEN=1) that have their own lifecycle. Anything else is a leak
 * from a closed terminal (cli-node ignores SIGHUP) and is killed. A process
 * whose environ cannot be read is left alone.
 */
import { execDetached } from '../cluster/docker-remote.mjs'
import { slotContainerName } from '../transport/rust-kernel-supervisor.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { slotExecCmd } from './slot-exec.mjs'
import { slotHost } from './slot-host.mjs'

export const CLI_NODE_GUARD_INTERVAL_MS = 15_000

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
  printf '%s\\n' "$env" | grep -qx -e 'KIN_OFFICIAL_CC=1' -e 'KIN_SETUP_TOKEN=1' && continue
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
} = {}) {
  let timer = null
  let inTick = false

  async function tick() {
    if (inTick) return
    inTick = true
    try {
      const tokens = liveTokens().filter(Boolean)
      const vms = (listTargets?.() || []).filter((vm) => vm?.id && !isCodexVm(vm))
      for (const vm of vms) {
        try {
          const connect = slotHost(vm).dockerApi()
          const container = slotContainerName({ vm })
          const { Cmd, User } = slotExecCmd(vm, ['/bin/sh', '-c', GUARD_SCRIPT, 'guard', ...tokens], {
            detach: true,
            user: isKvmRuntime(vm) ? '0' : undefined,
          })
          await exec(connect, container, Cmd, { user: User })
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
