/**
 * In-slot command argv. Docker keeps the historical `docker exec` flag
 * order; KVM moves -u/-e/-w/-i/-t/-d onto kin-guest-exec so the runner
 * SSHes into the guest instead of execing PID1's namespace.
 */
import { isKvmRuntime } from './runtime-kind.mjs'

export const KVM_GUEST_EXEC = '/usr/local/bin/kin-guest-exec'

export function slotExecContainer(vm) {
  const configured = String(vm?.runtime?.container || '').trim()
  if (configured) return configured
  const id = String(vm?.id || vm?.vmId || '').trim()
  return id ? `kin-${id.replace(/^vm-/, '')}` : ''
}

function envPairs(env) {
  if (!env) return []
  if (Array.isArray(env)) return env.map((item) => String(item))
  return Object.entries(env).map(([key, value]) => `${key}=${value ?? ''}`)
}

function dockerFlags({ user, env, workdir, interactive, tty, detach }) {
  const flags = []
  if (interactive) flags.push('-i')
  if (tty) flags.push('-t')
  if (detach) flags.push('-d')
  if (user != null && user !== '') flags.push('-u', String(user))
  for (const pair of envPairs(env)) flags.push('-e', pair)
  if (workdir) flags.push('-w', String(workdir))
  return flags
}

function guestExecFlags({ user, env, workdir, interactive, tty, detach }) {
  const flags = []
  if (user != null && user !== '') flags.push('-u', String(user))
  for (const pair of envPairs(env)) flags.push('-e', pair)
  if (workdir) flags.push('-w', String(workdir))
  if (interactive) flags.push('-i')
  if (tty) flags.push('-t')
  if (detach) flags.push('-d')
  return flags
}

/** docker CLI args after `docker` (starts with `exec`). */
export function slotExecArgv(vm, argv, opts = {}) {
  const cmd = Array.isArray(argv) ? argv : []
  const container = slotExecContainer(vm)
  if (isKvmRuntime(vm)) {
    const docker = dockerFlags({
      interactive: opts.interactive,
      tty: opts.tty,
      detach: opts.detach,
    })
    return ['exec', ...docker, container, KVM_GUEST_EXEC, ...guestExecFlags(opts), '--', ...cmd]
  }
  return ['exec', ...dockerFlags(opts), container, ...cmd]
}

/** Engine API `{ Cmd, User }`. KVM User is empty: the shim takes -u. */
export function slotExecCmd(vm, argv, opts = {}) {
  const cmd = Array.isArray(argv) ? argv : []
  if (isKvmRuntime(vm)) {
    return { Cmd: [KVM_GUEST_EXEC, ...guestExecFlags(opts), '--', ...cmd], User: '' }
  }
  return { Cmd: [...cmd], User: opts.user != null && opts.user !== '' ? String(opts.user) : '' }
}
