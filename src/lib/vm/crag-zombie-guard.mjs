/**
 * CRAG zombie guard: an opt-in maintenance pass for CRAG v2 slots.
 *
 * The closed-source `crag-v2 --gateway-worker` does not always reap the
 * `claude` children it spawns. Exited children pile up as `[claude] <defunct>`
 * (state Z) under the gateway for hours, and a slot that collects enough of
 * them ends up 内核故障. A slot power cycle clears them.
 *
 * Every `interval_sec` this reads each running CRAG slot's process table
 * through the normal slot exec path (kin-guest-exec on KVM), counts zombies
 * whose parent is the gateway worker, and looks at the watchdog's kernel
 * fault. A slot over `zombie_threshold` (or faulted) is power-cycled only when
 *   - the scheduler has no request in flight on it,
 *   - the native kernel reports no active request / continuation / queue,
 *   - nothing else holds or parks it, and
 *   - the guard did not already cycle it within `cooldown_sec`.
 * The cycle itself is the operator 恢复服务 path (`recover`): maintenance hold,
 * drain, stop, start, diagnosis, watchdog reset. Afterwards the guard checks
 * the egress binding is unchanged and the zombies are gone; any failed check
 * parks the slot as `maintenance_failed` (不可调度 until an operator acts) and
 * notifies. At most one slot is cycled per tick.
 */
import { execCapture } from '../cluster/docker-remote.mjs'
import { slotContainerName } from '../transport/rust-kernel-supervisor.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { resolveCragKernelVersion, resolveKernelDataplane } from './slot-engine.mjs'
import { slotExecCmd } from './slot-exec.mjs'
import { slotHost } from './slot-host.mjs'
import { isCodexVm } from './vm-kind.mjs'

export const DEFAULT_CRAG_ZOMBIE_GUARD = Object.freeze({
  enabled: false,
  interval_sec: 600,
  zombie_threshold: 4,
  cooldown_sec: 3600,
  restart_on_kernel_fault: true,
  scan_timeout_ms: 8000,
})

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function normalizeCragZombieGuardConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const d = DEFAULT_CRAG_ZOMBIE_GUARD
  return {
    enabled: src.enabled === true,
    interval_sec: clampInt(src.interval_sec, 60, 86_400, d.interval_sec),
    zombie_threshold: clampInt(src.zombie_threshold, 1, 10_000, d.zombie_threshold),
    cooldown_sec: clampInt(src.cooldown_sec, 600, 7 * 86_400, d.cooldown_sec),
    restart_on_kernel_fault: src.restart_on_kernel_fault !== false,
    scan_timeout_ms: clampInt(src.scan_timeout_ms, 2000, 30_000, d.scan_timeout_ms),
  }
}

export const ZOMBIE_SCAN_MARKER = 'kin-zombie-scan'

// Reads only /proc; never signals anything. KIN_GUARD_PROC is a test seam.
// /proc/<pid>/stat is "pid (comm) state ppid ..."; comm may hold spaces or
// parens, so fields are taken after the last ") ".
export const ZOMBIE_SCAN_SCRIPT = `
proc=\${KIN_GUARD_PROC:-/proc}
# Built at runtime: this script's own argv (sh -c, kin-guest-exec) carries the
# script text, and a literal flag here would count the scanner as a gateway.
flag=--gateway
flag="$flag-worker"
gw=' '
gwn=0
for d in "$proc"/[0-9]*; do
  [ "\${d##*/}" = "$$" ] && continue
  cmd=$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
  case " $cmd " in *" $flag "*) gw="$gw\${d##*/} "; gwn=$((gwn + 1)) ;; esac
done
z=0
zt=0
comms=
for d in "$proc"/[0-9]*; do
  stat=$(cat "$d/stat" 2>/dev/null) || continue
  rest=\${stat##*") "}
  state=\${rest%% *}
  [ "$state" = Z ] || continue
  zt=$((zt + 1))
  rest=\${rest#* }
  ppid=\${rest%% *}
  case "$gw" in *" $ppid "*) ;; *) continue ;; esac
  z=$((z + 1))
  if [ "$z" -le 8 ]; then
    comm=\${stat#*(}
    comm=\${comm%")"*}
    comm=$(printf '%s' "$comm" | tr -c 'A-Za-z0-9._-' '_')
    comms="\${comms:+$comms,}$comm"
  fi
done
printf '${ZOMBIE_SCAN_MARKER} gateway=%s zombies=%s total=%s comms=%s\\n' "$gwn" "$z" "$zt" "$comms"
`

/** null unless the scan line is complete; a partial read is not a count. */
export function parseZombieScan(stdout) {
  const line = String(stdout || '')
    .split('\n')
    .find((row) => row.startsWith(`${ZOMBIE_SCAN_MARKER} `))
  if (!line) return null
  const field = (name) => /^\d+$/.exec(new RegExp(`(?:^| )${name}=(\\S*)`).exec(line)?.[1] || '')?.[0]
  const gateway = field('gateway')
  const zombies = field('zombies')
  const total = field('total')
  if (gateway == null || zombies == null || total == null) return null
  const comms = /(?:^| )comms=(\S*)/.exec(line)?.[1] || ''
  return {
    gateway: Number(gateway),
    zombies: Number(zombies),
    total: Number(total),
    comms: comms ? comms.split(',') : [],
  }
}

const HARD_DOWN = new Set(['stopped', 'dead', 'error', 'disabled', 'paused'])

export function isCragZombieGuardTarget(vm, routing = {}) {
  if (!vm?.id || isCodexVm(vm)) return false
  if (String(vm.status || '').toLowerCase() !== 'running' || HARD_DOWN.has(String(vm.status).toLowerCase()))
    return false
  if (vm.migration_pending || ['running', 'needs_attention'].includes(vm.slot_migration?.status)) return false
  return resolveKernelDataplane(vm, routing) === 'crag' && resolveCragKernelVersion(vm, routing) === 'v2'
}

export function isCragZombieGuardSchedulable(vm, { ignoreMaintenanceHold = false } = {}) {
  if (!vm) return false
  if (vm.schedule_off === true || vm.unschedulable) return false
  if (vm.schedule_hold && !(ignoreMaintenanceHold && vm.schedule_hold.reason === 'maintenance')) return false
  return true
}

/** Default scan: the same in-slot exec the panel shell and cli-node guard use. */
export async function scanSlotZombies(vm, { hostFor = slotHost, capture = execCapture, timeoutMs = 8000 } = {}) {
  const host = hostFor(vm)
  if (host.native) return null
  const { Cmd, User } = slotExecCmd(vm, ['/bin/sh', '-c', ZOMBIE_SCAN_SCRIPT, 'scan'], {
    user: isKvmRuntime(vm) ? '0' : undefined,
  })
  const result = await capture(host.dockerApi(), slotContainerName({ vm }), Cmd, {
    user: User,
    timeoutMs,
    maxOutputBytes: 4096,
  })
  if (result?.exitCode !== 0) return null
  return parseZombieScan(result.stdout)
}

/** true = busy, false = proven idle, null = could not read the counters. */
export function nativeKernelBusy(report) {
  if (!report || report.ok === false || (report.status != null && report.status !== 200)) return null
  if (report.recovering === true) return true
  const keys = ['active_requests', 'continuations', 'queued', 'active', 'waiting', 'cleaning'].filter(
    (key) => report[key] !== undefined,
  )
  if (!keys.includes('active_requests')) return null
  if (keys.some((key) => !Number.isSafeInteger(report[key]) || report[key] < 0)) return null
  if (keys.some((key) => report[key] > 0)) return true
  if (report.idle !== undefined) {
    if (!Number.isSafeInteger(report.idle) || report.idle < 0) return null
    // CRAG v2 retains up to IDLE_MOST warm processes in state.runs and reports
    // their PIDs in `pids`. Only PIDs above `idle` indicate non-idle transitions.
    if (Array.isArray(report.pids) && report.pids.length > report.idle) return true
    return false
  }
  if (Array.isArray(report.pids) && report.pids.length > 0) return true
  return false
}

function egressFingerprint(vm) {
  const proxy = vm?.proxy || null
  if (!proxy) return null
  return JSON.stringify([proxy.id ?? null, proxy.host ?? null, proxy.port ?? null, proxy.url ?? null])
}

export function createCragZombieGuard({
  config: initial = {},
  listTargets,
  getRouting = () => ({}),
  getVm = null,
  scan = scanSlotZombies,
  inflight = () => 0,
  nativeHealth = null,
  isFaulted = () => false,
  lockBusy = () => false,
  recover,
  park = null,
  notify = null,
  postScanRetryDelayMs = 1500,
  now = () => Date.now(),
  logger = console,
} = {}) {
  let config = normalizeCragZombieGuardConfig(initial)
  let timer = null
  let inTick = false
  // vmId -> ms of the guard's last power cycle (success or failure).
  const lastCycleAt = new Map()
  const last = { at: 0, results: [] }

  const log = (msg) => logger.warn?.(`[crag-zombie-guard] ${msg}`)

  function reportFailure(vm, code, detail) {
    log(`${vm.id} maintenance failed (${code}); slot left unschedulable`)
    try {
      park?.(vm.id, { code, ...detail })
    } catch (error) {
      log(`${vm.id} park failed: ${error?.message || error}`)
    }
    if (typeof notify === 'function') {
      Promise.resolve()
        .then(() =>
          notify({
            eventType: 'vm_down',
            title: `CRAG 槽位自动维护失败：${vm.name || vm.id}`,
            text: `槽位 ${vm.name || vm.id}（${vm.id}）僵尸进程自动重启后检查未通过（${code}），已设为不可调度，请在面板「恢复服务」后确认。`,
          }),
        )
        .catch((error) => log(`${vm.id} notify failed: ${error?.message || error}`))
    }
  }

  /** One slot. Returns a result row; `cycled` marks the per-tick budget as used. */
  async function checkVm(vm, routing) {
    const at = now()
    const row = { id: vm.id, action: 'skip' }
    if (!isCragZombieGuardSchedulable(vm)) return { ...row, reason: 'not_schedulable' }
    if (lastCycleAt.has(vm.id) && at - lastCycleAt.get(vm.id) < config.cooldown_sec * 1000)
      return { ...row, reason: 'cooldown' }
    if (lockBusy(vm.id)) return { ...row, reason: 'locked' }
    if ((Number(inflight(vm.id)) || 0) > 0) return { ...row, reason: 'inflight' }
    const faulted = config.restart_on_kernel_fault && Boolean(isFaulted(vm.id))
    let counts = null
    try {
      counts = await scan(vm, { timeoutMs: config.scan_timeout_ms })
    } catch (error) {
      log(`${vm.id} scan failed: ${error?.message || error}`)
    }
    row.zombies = counts?.zombies ?? null
    row.faulted = faulted
    const overThreshold = (counts?.zombies ?? 0) >= config.zombie_threshold
    if (!overThreshold && !faulted) return { ...row, reason: counts ? 'below_threshold' : 'scan_unavailable' }
    // A tool continuation can outlive its HTTP request: the native counters must prove idleness.
    let busy = null
    if (typeof nativeHealth === 'function') {
      try {
        busy = nativeKernelBusy(await nativeHealth(vm))
      } catch {
        busy = null
      }
    }
    if (busy === true) return { ...row, reason: 'native_busy' }
    // A faulted kernel cannot answer; the scheduler already skips it, so in-flight 0 is the proof.
    if (busy === null && !faulted) return { ...row, reason: 'native_unknown' }
    if ((Number(inflight(vm.id)) || 0) > 0) return { ...row, reason: 'inflight' }
    const reason = overThreshold ? `zombies=${counts.zombies}` : 'kernel_fault'
    let egressBefore = egressFingerprint(vm)
    let postChecked = false
    let postOutcome = null
    const verifyBeforeStop = async (fresh) => {
      const current = fresh || (typeof getVm === 'function' ? getVm(vm.id) : null)
      if (current) {
        if (!isCragZombieGuardTarget(current, routing)) return { ok: false, code: 'target_changed' }
        if (!isCragZombieGuardSchedulable(current, { ignoreMaintenanceHold: true }))
          return { ok: false, code: 'slot_state_changed' }
        egressBefore = egressFingerprint(current)
      }
      if (typeof nativeHealth === 'function') {
        let liveBusy = null
        try {
          liveBusy = nativeKernelBusy(await nativeHealth(current || vm))
        } catch {
          liveBusy = null
        }
        if (liveBusy === true) return { ok: false, code: 'native_busy' }
        if (liveBusy === null && !faulted) return { ok: false, code: 'native_unknown' }
      }
      if ((Number(inflight(vm.id)) || 0) > 0) return { ok: false, code: 'inflight' }
      return { ok: true }
    }
    const runPostChecks = async (afterVm = null) => {
      postChecked = true
      const after = afterVm || (typeof getVm === 'function' ? getVm(vm.id) : null) || vm
      if (egressFingerprint(after) !== egressBefore) {
        reportFailure(vm, 'egress_changed', { trigger: reason })
        postOutcome = { ok: false, code: 'egress_changed' }
        return postOutcome
      }
      let recheck = null
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          recheck = await scan(after, { timeoutMs: config.scan_timeout_ms })
        } catch {
          recheck = null
        }
        if (recheck) break
        if (attempt === 0 && postScanRetryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, postScanRetryDelayMs))
        }
      }
      if (!recheck || recheck.gateway < 1 || recheck.zombies >= config.zombie_threshold) {
        reportFailure(vm, 'post_check_failed', {
          trigger: reason,
          gateway: recheck?.gateway ?? null,
          zombies: recheck?.zombies ?? null,
        })
        postOutcome = { ok: false, code: 'post_check_failed' }
        return postOutcome
      }
      log(`${vm.id} power cycle ok; zombies now ${recheck.zombies}`)
      postOutcome = { ok: true, zombies_after: recheck.zombies }
      return postOutcome
    }
    log(`${vm.id} power cycle: ${reason}${counts ? ` (gateway=${counts.gateway} total=${counts.total})` : ''}`)
    lastCycleAt.set(vm.id, at)
    let result
    try {
      result = await recover(vm, { reason, faulted, beforeStop: verifyBeforeStop, verifyAfter: runPostChecks })
    } catch (error) {
      result = { ok: false, code: 'recover_threw', error: String(error?.message || error) }
    }
    // recover() returns an outer ok:false only before stop/start ran (busy, drain timeout,
    // license, admission, beforeStop abort): the hold was rolled back and the slot still serves.
    // A thrown recover() may have stopped the slot, so it goes down the failure path.
    if (result?.ok === false && result.code !== 'recover_threw') {
      lastCycleAt.delete(vm.id)
      log(`${vm.id} cycle refused (${result.code}); will retry later`)
      return { ...row, action: 'refused', reason: result.code }
    }
    const cycled = { ...row, action: 'cycled', cycled: true, reason }
    if (!result?.ok || result.report?.ok !== true) {
      const failed = (result?.report?.steps || []).find((s) => !s.ok)
      const code = failed?.code || result?.report?.diagnosis?.first_failure || result?.code || 'recover_failed'
      reportFailure(vm, 'recover_failed', { step: failed?.id || null, step_code: code, trigger: reason })
      return { ...cycled, ok: false, code: 'recover_failed' }
    }
    const outcome = postChecked ? postOutcome : await runPostChecks()
    return { ...cycled, ...outcome }
  }

  async function tick() {
    if (inTick || !config.enabled) return last
    inTick = true
    const results = []
    try {
      const routing = (typeof getRouting === 'function' ? getRouting() : null) || {}
      const vms = (typeof listTargets === 'function' ? listTargets() || [] : []).filter((vm) =>
        isCragZombieGuardTarget(vm, routing),
      )
      for (const vm of vms) {
        if (!config.enabled) break
        let row
        try {
          row = await checkVm(vm, routing)
        } catch (error) {
          row = { id: vm.id, action: 'error', reason: String(error?.message || error) }
          log(`${vm.id} check failed: ${row.reason}`)
        }
        results.push(row)
        if (row.cycled) break // one destructive action per tick
      }
    } finally {
      inTick = false
      last.at = now()
      last.results = results
    }
    return last
  }

  function schedule() {
    clearInterval(timer)
    timer = setInterval(() => void tick(), config.interval_sec * 1000)
    timer.unref?.()
  }

  return {
    tick,
    getConfig: () => config,
    status: () => ({ config, last_run_at: last.at || null, last_results: last.results }),
    setConfig(next) {
      const before = config.interval_sec
      config = normalizeCragZombieGuardConfig(next || {})
      if (timer && before !== config.interval_sec) schedule()
    },
    start() {
      if (timer) return
      schedule()
    },
    stop() {
      clearInterval(timer)
      timer = null
    },
  }
}
