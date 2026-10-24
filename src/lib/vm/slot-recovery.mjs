/**
 * Operator-facing slot recovery. `diagnoseSlotServices` reads every service a
 * slot hop depends on without touching any of them; `recoverSlot` power-cycles
 * the slot through the same boot path as POST /start; `reviveDownSlots` and
 * `createSlotBridgeHealer` are the automatic halves (control-plane boot, and
 * the kernel watchdog's per-tick bridge pass).
 *
 * Container restarts stay owned by the kernel watchdog's bounded budget: an
 * operator power cycle holds the watchdog off the VM and then resets its budget.
 */
import { isDeepStrictEqual } from 'node:util'
import { clusterManager, vmNodeId } from '../cluster/placement.mjs'
import { containerLogs, inspectContainerOrNull } from '../cluster/docker-remote.mjs'
import { slotEgressNames } from '../cluster/remote-slot.mjs'
import { kernelFaults, rustKernelHealth, toPublicKernelHealth } from '../transport/rust-kernel-client.mjs'
import { codexKernelHealth } from '../transport/codex-kernel-client.mjs'
import { codexKernelTracked } from '../transport/codex-kernel-supervisor.mjs'
import {
  egressListening,
  ensureProxyEgress,
  hasBoundExit,
  inspectEgressProcess,
  isLocalEgressProxy,
  localEgressStatus,
} from './egress.mjs'
import { proxyBlockedReason } from './proxy-policy.mjs'
import { fillVmTimezoneFromExit } from './proxy-timezone.mjs'
import { resolveInferenceEngine } from './slot-engine.mjs'
import { slotExecContainer } from './slot-exec.mjs'
import { slotHost } from './slot-host.mjs'
import { slotExec, startSlotReady, stopSlot } from './slot-runtime.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { slotDockerCpus } from './machine-spec.mjs'
import { bindVmProxy, getVm, patchVmRecord, vmHasSchedulableCredential } from './vm-registry.mjs'
import {
  applyClearUnschedulable,
  applyUnschedulable,
  deriveScheduleFields,
  migrateScheduleRecord,
} from '../pool/schedule-state.mjs'
import { isCredentialRefreshFailed } from '../pool/availability.mjs'

const HEALTH_TIMEOUT_MS = 1500
const BRIDGE_HEAL_MIN_MS = 60_000
const BOOT_SETTLE_MS = 3000

// Socket errors that prove no process accepts connections (missing file / stale socket).
const CODEX_NOT_LISTENING = new Set(['ENOENT', 'ECONNREFUSED'])

function cluster() {
  try {
    return clusterManager()
  } catch {
    return null
  }
}

function check(id, label, status, code, message, detail) {
  const out = { id, label, status, code: code || null, message }
  if (detail && Object.keys(detail).length) out.detail = detail
  return out
}

function slotEngine(vm, routing) {
  return isCodexVm(vm) ? 'codex' : resolveInferenceEngine(vm, routing || {})
}

const LOG_TAIL_LINES = 5

const SECRET_KEY = '(?:[a-z_]*token|api[_-]?key|secret|password|passwd|authorization|cookie|session[_-]?key)'
const SECRET_VALUE = new RegExp(`(["']?${SECRET_KEY}["']?\\s*[:=]\\s*["']?)[^"'\\s,;&}]+`, 'gi')

/** Best-effort masking for admin-only raw text; tenants never receive raw text at all. */
export function redactSecrets(text) {
  return String(text)
    .replace(/([a-z][\w+.-]*:\/\/)[^/@\s]+@/gi, '$1***@')
    .replace(/(bearer\s+)[\w.~+/=-]+/gi, '$1***')
    .replace(SECRET_VALUE, '$1***')
    .replace(/\bsk-[\w-]{6,}/gi, 'sk-***')
}

/** Last non-empty log lines without Docker's timestamp prefix. */
function logTail(logs) {
  return logs.lines
    .map((chunk) => chunk.text)
    .join('')
    .split('\n')
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s/, '').trimEnd())
    .filter(Boolean)
    .slice(-LOG_TAIL_LINES)
}

/**
 * Container state from the Engine API (local socket or the node bridge). A
 * crash loop reports Running=true with Restarting=true: that is not running.
 * A down container carries its last log lines, which usually name the cause.
 */
export async function inspectSlotContainer(vm) {
  const host = slotHost(vm)
  if (typeof host.inspect === 'function') return host.inspect(vm)
  const connect = host.dockerApi()
  const name = slotExecContainer(vm)
  const info = await inspectContainerOrNull(connect, name)
  if (!info) return { exists: false, running: false }
  const state = info.State || {}
  const restarting = state.Restarting === true
  const running = state.Running === true && !restarting
  // Logs are context for the operator; failing to read them must not hide the state itself.
  const log_tail = running ? [] : await containerLogs(connect, name, { tail: 50 }).then(logTail, () => [])
  return {
    exists: true,
    running,
    restarting,
    restart_count: Number.isFinite(info.RestartCount) ? info.RestartCount : null,
    status: state.Status || null,
    exit_code: Number.isFinite(state.ExitCode) ? state.ExitCode : null,
    oom_killed: state.OOMKilled === true,
    error: state.Error || null,
    finished_at: state.FinishedAt || null,
    log_tail,
  }
}

const DEFAULT_PROBES = Object.freeze({
  container: inspectSlotContainer,
  rustHealth: (exec) => rustKernelHealth(exec, { timeoutMs: HEALTH_TIMEOUT_MS }),
  codexHealth: (exec) => codexKernelHealth(exec, { timeoutMs: HEALTH_TIMEOUT_MS }),
  localEgress: (proxy) => localEgressStatus(proxy),
  socksEgress: (projectRoot, proxyId) => egressListening(projectRoot, proxyId),
  remoteEgress: async (vm) => {
    const info = await inspectContainerOrNull(slotHost(vm).dockerApi(), slotEgressNames(vm.id).egress)
    return { exists: !!info, running: info?.State?.Running === true, status: info?.State?.Status || null }
  },
  codexTracked: (vmId) => codexKernelTracked(vmId),
  cluster,
})

function recordCheck(vm) {
  const status = String(vm.status || '').toLowerCase()
  if (status === 'running') return check('record', '槽位状态', 'ok', null, '记录为运行中')
  if (status === 'stopped') return check('record', '槽位状态', 'error', 'vm_stopped', '槽位已关机，恢复服务会把它开机')
  return check('record', '槽位状态', 'error', 'vm_not_running', `记录状态为 ${status || '未知'}，不是运行中`)
}

function credentialCheck(vm, projectRoot) {
  if (vmHasSchedulableCredential(vm, projectRoot)) return check('credential', '凭证', 'ok', null, '已导入可用凭证')
  const refreshFailed = isCredentialRefreshFailed({ vm, now: Date.now() })
  return check(
    'credential',
    '凭证',
    'error',
    refreshFailed ? 'credential_refresh_failed' : 'no_credential',
    refreshFailed ? '凭证已失效且刷新失败；请重新登录 / 导入凭证' : '未导入可用凭证；请登录 / 导入凭证',
  )
}

function linkCheck(status, internal) {
  const link = status?.link
  if (!link) return check('node_link', '节点 SSH 链路', 'error', 'node_not_found', '槽位所在节点不存在')
  if (link.state === 'ready') return check('node_link', '节点 SSH 链路', 'ok', null, '已连接')
  const why = internal && link.error?.message ? `：${redactSecrets(link.error.message)}` : ''
  return check('node_link', '节点 SSH 链路', 'error', 'node_link_down', `节点未连接（${link.state}）${why}`, {
    state: link.state,
    error_code: link.error?.code || null,
  })
}

function relayCheck(status, internal) {
  const dead = []
  if (!status?.bridge?.alive) dead.push('docker 桥')
  if (!status?.relays) dead.push('内核中继（未建立）')
  else {
    if (!status.relays.kernel.alive) dead.push('kernel.sock 中继')
    if (!status.relays.worker.alive) dead.push('worker.sock 中继')
  }
  if (!dead.length) return check('relay', '集群桥服务', 'ok', null, 'docker 桥与槽位中继都在监听')
  const error = internal ? status?.bridge?.error || status?.relays?.kernel?.error || null : null
  const detail = error ? { error: redactSecrets(error) } : null
  return check('relay', '集群桥服务', 'error', 'relay_down', `未在监听：${dead.join('、')}`, detail)
}

async function egressCheck(vm, projectRoot, probes) {
  const label = '出口代理 / 出口桥'
  const proxy = vm.proxy
  if (!hasBoundExit(proxy)) return check('egress', label, 'error', 'proxy_required', '未绑定出口代理')
  const blocked = proxyBlockedReason(proxy)
  if (blocked) return check('egress', label, 'error', 'proxy_blocked', `出口被策略禁用：${blocked}`)
  const local = isLocalEgressProxy(proxy)
  if (vmNodeId(vm)) {
    if (local) return check('egress', label, 'ok', null, '节点本地出口')
    const eg = await probes.remoteEgress(vm)
    if (eg.running) return check('egress', label, 'ok', null, `节点出口容器运行中（${proxy.id}）`)
    return check(
      'egress',
      label,
      'error',
      'egress_down',
      `节点出口容器${eg.exists ? `未运行（${eg.status}）` : '不存在'}`,
    )
  }
  if (local) {
    const st = probes.localEgress(proxy)
    if (st?.ok) return check('egress', label, 'ok', null, '本机直连出口网络存在')
    return check('egress', label, 'error', 'egress_network_missing', '本机出口网络 kin-eg-px-local 不存在')
  }
  if (isCodexVm(vm)) return check('egress', label, 'ok', null, `Codex 内核直接走代理 ${proxy.id}`)
  const st = probes.socksEgress(projectRoot, proxy.id)
  if (st?.ok) return check('egress', label, 'ok', null, `出口桥 kin-egress 运行中（${proxy.id}）`)
  const why = st?.reason === 'not_listening' ? '进程在但未监听' : '进程不在'
  return check('egress', label, 'error', 'egress_down', `本机出口桥 kin-egress ${why}（${proxy.id}）`, {
    reason: st?.reason || null,
  })
}

/** Tenants get state, exit code, restarts and OOM; Docker's error text and the log tail are admin-only. */
async function containerCheck(vm, probes, internal) {
  const label = '槽位容器'
  const st = await probes.container(vm)
  if (st.running) return check('container', label, 'ok', null, '运行中')
  if (!st.exists) return check('container', label, 'error', 'container_missing', '容器不存在')
  const bits = [`状态 ${st.status || 'unknown'}`]
  if (st.exit_code != null) bits.push(`退出码 ${st.exit_code}`)
  if (st.restarting && st.restart_count != null) bits.push(`已重启 ${st.restart_count} 次`)
  if (st.oom_killed) bits.push('内存不足被杀')
  const logTailLines = internal ? (st.log_tail || []).map(redactSecrets) : []
  if (internal && st.error) bits.push(redactSecrets(st.error))
  const lastLog = logTailLines.at(-1)
  const why = lastLog ? `；最后日志：${lastLog}` : internal ? '' : '；详细日志请联系管理员查看'
  const code = st.restarting ? 'container_crash_loop' : 'container_stopped'
  const lead = st.restarting ? '容器反复崩溃重启' : '容器未运行'
  const detail = {
    status: st.status,
    exit_code: st.exit_code,
    restart_count: st.restart_count,
    oom_killed: st.oom_killed,
    finished_at: st.finished_at,
  }
  if (internal) detail.log_tail = logTailLines
  return check('container', label, 'error', code, `${lead}：${bits.join('，')}${why}`, detail)
}

async function kernelCheck(vm, projectRoot, engine, hasCredential, probes, internal) {
  const label = '推理内核'
  const exec = slotExec(projectRoot, vm)
  if (engine === 'codex') {
    const health = await probes.codexHealth(exec)
    const pub = toPublicKernelHealth(health, 'codex')
    if (pub.reachable) return check('kernel', label, 'ok', null, 'Codex 内核在线')
    // Idle needs evidence: nothing listens on the socket and this Node holds no live child.
    // Codex kernels start per request, and a Node restart leaves none behind.
    const nothingListening = Number(health?.status) === 0 && CODEX_NOT_LISTENING.has(health?.code)
    if (nothingListening && !probes.codexTracked(vm.id)) {
      return check('kernel', label, 'warn', 'codex_kernel_idle', 'Codex 内核当前未运行，下一次请求会自动拉起')
    }
    // A timeout, an HTTP error, or a tracked child that does not answer is a fault, not idle.
    const cause = health?.code === 'worker_timeout' ? '无应答（超时）' : `探测失败（${pub.error_code || 'unknown'}）`
    return check('kernel', label, 'error', 'codex_kernel_down', `Codex 内核${cause}`, {
      error_code: health?.code || pub.error_code,
      status: Number(health?.status) || null,
    })
  }
  if (engine !== 'rust') return check('kernel', label, 'skip', null, `推理引擎 ${engine}，不检查内核`)
  const pub = toPublicKernelHealth(await probes.rustHealth(exec), 'rust')
  const detail = {
    ready_slots: pub.ready_slots,
    closed_slots: pub.closed_slots,
    cli_restarts: pub.cli_restarts,
    cli_pid: pub.cli_pid,
  }
  if (!pub.process_up) {
    if (!hasCredential) return check('kernel', label, 'skip', null, '未导入凭证，内核按设计不启动')
    return check('kernel', label, 'error', 'kernel_down', '内核进程未响应（kernel.sock 无应答）', {
      error_code: pub.error_code,
    })
  }
  if (!pub.healthy) {
    return check(
      'kernel',
      label,
      'error',
      'kernel_unhealthy',
      internal
        ? `内核已放弃自恢复：${redactSecrets(pub.unhealthy_reason || '原因未上报')}`
        : '内核已放弃自恢复（CLI 多次重启仍失败）',
      detail,
    )
  }
  if (pub.recovering)
    return check('kernel', label, 'warn', 'kernel_recovering', '内核正在重启 CLI，稍后自动恢复', detail)
  if (pub.ready_slots === 0) {
    if (pub.cli_pid > 0) return check('kernel', label, 'warn', 'kernel_busy', '所有会话槽都在忙', detail)
    return check('kernel', label, 'error', 'kernel_no_cli', '内核在线但 CLI 未运行，没有可用会话槽', detail)
  }
  const slots = pub.ready_slots == null ? '' : `，可用会话槽 ${pub.ready_slots}`
  return check('kernel', label, 'ok', null, `内核在线${slots}`, detail)
}

function watchdogCheck(vm, engine, watchdog, internal) {
  const label = '自动恢复'
  if (engine !== 'rust') return check('watchdog', label, 'skip', null, '仅 rust 内核槽有自动恢复')
  const fault = kernelFaults.get(vm.id)
  if (fault) {
    const why = internal ? `：${redactSecrets(fault)}` : ''
    return check('watchdog', label, 'error', 'kernel_faulted', `自动重启已用尽，已停止调度${why}`)
  }
  const n = watchdog?.restartsInWindow?.(vm.id) || 0
  if (n) return check('watchdog', label, 'warn', 'watchdog_restarting', `近一小时已自动重启容器 ${n} 次`)
  return check('watchdog', label, 'ok', null, '无故障记录')
}

function scheduleCheck(vm) {
  if (vm.schedulable !== false) return check('schedule', '调度', 'ok', null, '参与调度')
  const why = vm.schedule_disabled_reason ? `（${vm.schedule_disabled_reason}）` : ''
  return check('schedule', '调度', 'warn', 'schedule_off', `未参与号池调度${why}；模型测试仍会直连该槽`)
}

async function guarded(id, label, internal, fn) {
  try {
    return await fn()
  } catch (error) {
    const code = error?.code || 'check_failed'
    const message = internal ? `检查失败：${redactSecrets(error?.message || error)}` : `检查失败（${code}）`
    return check(id, label, 'error', code, message)
  }
}

/**
 * Read-only: never starts, restarts or writes anything. `internal` (admin)
 * adds raw Docker/SSH/kernel text and the container log tail, secret-masked;
 * without it every message is built from codes and numbers only.
 */
export async function diagnoseSlotServices(
  vm,
  { projectRoot, routing = {}, watchdog = null, probes = {}, internal = false } = {},
) {
  const p = { ...DEFAULT_PROBES, ...probes }
  const engine = slotEngine(vm, routing)
  const nodeId = vmNodeId(vm)
  const hasCredential = vmHasSchedulableCredential(vm, projectRoot)
  const checks = [recordCheck(vm), credentialCheck(vm, projectRoot)]
  if (nodeId) {
    const status = p.cluster()?.slotBridgeStatus(nodeId, vm.id) || null
    checks.push(linkCheck(status, internal), relayCheck(status, internal))
  }
  checks.push(
    await guarded('egress', '出口代理 / 出口桥', internal, () => egressCheck(vm, projectRoot, p)),
    await guarded('container', '槽位容器', internal, () => containerCheck(vm, p, internal)),
    await guarded('kernel', '推理内核', internal, () =>
      kernelCheck(vm, projectRoot, engine, hasCredential, p, internal),
    ),
    watchdogCheck(vm, engine, watchdog, internal),
    scheduleCheck(vm),
  )
  const failed = checks.find((c) => c.status === 'error') || null
  return {
    vm_id: vm.id,
    checked_at: new Date().toISOString(),
    ok: !failed,
    engine,
    placement: nodeId ? 'node' : 'local',
    first_failure: failed?.id || null,
    checks,
  }
}

/**
 * The POST /start boot: bind (or allocate) the exit, adopt its timezone, start
 * the container and its inference runtime, then record the running intent.
 * `by` is the action behind the boot: 'start' (operator /start) reopens 关机 and
 * a failed boot; 'recover_ok' (operator 恢复服务) reopens any 不可调度; null
 * (watchdog revive) only records whether a ticket is on disk.
 */
export async function powerOnSlot({
  projectRoot,
  id,
  proxyPool,
  routing = {},
  fillTimezone = null,
  ops = {},
  by = null,
}) {
  let vm = getVm(projectRoot, id)
  if (!vm) return { ok: false, status: 404, code: 'vm_not_found', error: 'vm not found' }
  try {
    if (!isKvmRuntime(vm)) slotDockerCpus(vm)
  } catch (error) {
    return { ok: false, status: 400, code: error.code, error: error.message }
  }
  const bound = proxyPool.ensureBoundToVm(id, vm.proxy?.id || null)
  if (!bound) {
    return { ok: false, status: 409, code: 'proxy_required', error: 'No SOCKS5 is bound or free for this VM' }
  }
  bindVmProxy(projectRoot, id, bound)
  await (fillTimezone || ((vmId) => fillVmTimezoneFromExit(projectRoot, proxyPool, vmId)))(id)
  vm = getVm(projectRoot, id) || vm
  const runtimeBeforeBoot = structuredClone(vm.runtime || {})
  const boot = await (ops.startSlotReady || startSlotReady)(vm, projectRoot, { routing })
  if (!boot.ok) {
    return {
      ok: false,
      status: 500,
      code: boot.code || 'runtime_start_failed',
      error: boot.error || 'runtime start failed',
      boot,
    }
  }
  const hasCred = vmHasSchedulableCredential(vm, projectRoot)
  const runtime = boot.runtime || boot.docker?.runtime
  vm =
    patchVmRecord(projectRoot, id, (record) => {
      migrateScheduleRecord(record)
      if (by === 'start' && record.schedule_off_reason === 'stopped') {
        delete record.schedule_off
        delete record.schedule_off_reason
      }
      if (!hasCred) applyUnschedulable(record, 'no_credential')
      else if (by === 'recover_ok') applyClearUnschedulable(record, { by })
      else if (by === 'start' && record.unschedulable?.reason === 'runtime_start_failed') {
        applyClearUnschedulable(record, { by: 'operator' })
      } else applyClearUnschedulable(record, { by: 'credential_present' })
      deriveScheduleFields(record)
      const next = { status: 'running' }
      if (runtime) {
        const currentRuntime = record.runtime || {}
        next.runtime = { ...runtime }
        // Readiness can yield after the boot snapshot; retain newer runtime writes.
        for (const key of new Set([...Object.keys(runtimeBeforeBoot), ...Object.keys(currentRuntime)])) {
          if (isDeepStrictEqual(currentRuntime[key], runtimeBeforeBoot[key])) continue
          if (Object.hasOwn(currentRuntime, key)) next.runtime[key] = currentRuntime[key]
          else delete next.runtime[key]
        }
      }
      return next
    }) || vm
  return { ok: true, vm, bound, boot }
}

const STOP_MESSAGES = { absent: '容器不存在，跳过关机', 'already-stopped': '容器已是停止状态', stopped: '已关机' }
const STEP_LABELS = {
  node_link: '连接节点',
  relay: '重建集群桥',
  stop: '关机',
  start: '开机',
  watchdog_reset: '重置自动恢复',
}

function startStepResult(started) {
  if (!started.ok) return { ok: false, code: started.code, message: started.error }
  const kernel = started.boot?.rust || started.boot?.kernel
  if (started.boot?.rust_ok === false || kernel?.ok === false) {
    return {
      ok: false,
      code: kernel?.code || kernel?.reason || 'kernel_start_failed',
      message: `容器已开机，但内核未就绪：${kernel?.error || kernel?.reason || '未知原因'}`,
    }
  }
  if (kernel?.skipped && kernel.reason === 'no_credential')
    return { ok: true, message: '已开机（未导入凭证，内核未启动）' }
  return { ok: true, message: '已开机，内核就绪' }
}

const recovering = new Set()

/**
 * Operator power cycle: stop → boot, with the watchdog held off the VM. The
 * record keeps its running intent across the stop, so a failed boot is still
 * picked up by automatic recovery. Afterwards the watchdog budget is reset and
 * the slot re-diagnosed.
 */
export async function recoverSlot({
  projectRoot,
  id,
  proxyPool,
  routing = {},
  fillTimezone = null,
  watchdog = null,
  internal = false,
  ops = {},
  now = () => Date.now(),
}) {
  const vm = getVm(projectRoot, id)
  if (!vm) return { ok: false, status: 404, code: 'vm_not_found', error: 'vm not found' }
  if (recovering.has(id))
    return { ok: false, status: 409, code: 'recover_in_progress', error: '该槽位正在恢复中，请稍候' }
  // Validate before holding the watchdog, repairing relays or stopping a live slot.
  try {
    if (!isKvmRuntime(vm)) slotDockerCpus(vm)
  } catch (error) {
    return { ok: false, status: 400, code: error.code, error: error.message }
  }
  const manager = (ops.cluster || cluster)()
  const stop = ops.stopSlot || stopSlot
  const powerOn = ops.powerOn || ((args) => powerOnSlot(args))
  const diagnose =
    ops.diagnose || ((current) => diagnoseSlotServices(current, { projectRoot, routing, watchdog, internal }))
  // Held through the settle wait and final check too, so the watchdog cannot bounce the slot under it.
  recovering.add(id)
  const drained = watchdog?.hold?.(id)
  const started = now()
  const steps = []
  const step = async (stepId, fn) => {
    const t0 = now()
    let r
    try {
      r = await fn()
    } catch (error) {
      r = { ok: false, code: error?.code, message: String(error?.message || error) }
    }
    const code = r.ok ? null : r.code || `${stepId}_failed`
    // Failed steps carry raw stderr / SSH text: admins get it masked, tenants only the code.
    let message = r.message || ''
    if (!r.ok)
      message = internal ? redactSecrets(message) : `${STEP_LABELS[stepId]}失败（${code}），详情请联系管理员查看`
    steps.push({ id: stepId, label: STEP_LABELS[stepId], ok: r.ok === true, code, message, ms: now() - t0 })
    return r.ok === true
  }
  try {
    // A watchdog restart already past its hold check finishes before this cycle touches the slot.
    await drained
    const nodeId = vmNodeId(vm)
    let proceed = true
    if (nodeId) {
      proceed = await step('node_link', async () => {
        if (!manager) return { ok: false, code: 'cluster_unavailable', message: '集群未初始化' }
        await manager.ensureLinkReady(nodeId)
        return { ok: true, message: '节点 SSH 已连接' }
      })
      if (proceed) {
        proceed = await step('relay', async () => {
          const healed = await manager.healSlotBridges(nodeId, id, { force: true })
          return {
            ok: true,
            message: `已重建：${healed.map((h) => (h === 'bridge' ? 'docker 桥' : '槽位中继')).join('、')}`,
          }
        })
      }
    }
    if (proceed) {
      proceed = await step('stop', async () => {
        const halted = await stop(vm)
        if (!halted?.ok) return { ok: false, code: 'stop_failed', message: halted?.error || '关机失败' }
        return { ok: true, message: STOP_MESSAGES[halted.action] || '已关机' }
      })
    }
    if (proceed) {
      await step('start', async () =>
        startStepResult(await powerOn({ projectRoot, id, proxyPool, routing, fillTimezone, by: 'recover_ok' })),
      )
    }
    // Only an attempted boot earns a fresh budget; a cycle that never reached start fixed nothing.
    if (watchdog?.reset && proceed) {
      await step('watchdog_reset', async () => {
        const { faulted } = watchdog.reset(id)
        return { ok: true, message: faulted ? '已清除内核故障标记与重启计数' : '重启计数已清零' }
      })
    }
    // A crash-looping entrypoint is "running" for its first moments: let it fail before judging it.
    const booted = steps.some((s) => s.id === 'start' && s.ok)
    const settleMs = ops.settleMs ?? BOOT_SETTLE_MS
    if (booted && settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs))
    const diagnosis = await diagnose(getVm(projectRoot, id) || vm)
    return {
      ok: true,
      report: {
        vm_id: id,
        ok: steps.every((s) => s.ok) && diagnosis.ok,
        duration_ms: now() - started,
        steps,
        diagnosis,
      },
    }
  } finally {
    watchdog?.release?.(id)
    recovering.delete(id)
  }
}

function nodeLinkReady(nodeId) {
  try {
    return cluster()?.get(nodeId)?.link?.state === 'ready'
  } catch {
    return false
  }
}

/**
 * Control-plane boot: a slot recorded as running whose container is gone or
 * exited is booted once, serially. Node slots whose link is not up yet are
 * left to the watchdog.
 */
export async function reviveDownSlots({
  vms,
  powerOn,
  inspect = inspectSlotContainer,
  linkReady = nodeLinkReady,
  watchdog = null,
  logger = console,
}) {
  const revived = []
  for (const vm of vms) {
    if (vm?.status !== 'running') continue
    const nodeId = vmNodeId(vm)
    if (nodeId && !linkReady(nodeId)) continue
    let state
    try {
      state = await inspect(vm)
    } catch (error) {
      logger.warn(`[slot-revive] ${vm.id} inspect failed: ${error?.message || error}`)
      continue
    }
    if (state.running) continue
    await watchdog?.hold?.(vm.id)
    try {
      const result = await powerOn(vm.id)
      revived.push({ id: vm.id, ok: !!result?.ok, code: result?.code || null })
      if (result?.ok)
        logger.warn(`[slot-revive] ${vm.id} container was ${state.exists ? state.status : 'missing'}; booted`)
      else logger.warn(`[slot-revive] ${vm.id} boot failed: ${result?.code || ''} ${result?.error || ''}`)
    } finally {
      watchdog?.release?.(vm.id)
    }
  }
  return revived
}

/**
 * Per-tick bridge pass for the kernel watchdog: a local SOCKS slot's kin-egress
 * process, a node slot's docker bridge and kernel/worker relays. Each bridge is
 * repaired at most once per `minIntervalMs`.
 */
export function createSlotBridgeHealer({
  projectRoot,
  minIntervalMs = BRIDGE_HEAL_MIN_MS,
  now = () => Date.now(),
  ops = {},
  logger = console,
}) {
  const egressAlive = ops.egressAlive || ((proxyId) => inspectEgressProcess(projectRoot, proxyId).ok)
  const startEgress = ops.ensureProxyEgress || ((proxy) => ensureProxyEgress(projectRoot, proxy))
  const getCluster = ops.cluster || cluster
  const lastAttempt = new Map()
  const due = (key) => {
    const at = now()
    if (at - (lastAttempt.get(key) ?? -Infinity) < minIntervalMs) return false
    lastAttempt.set(key, at)
    return true
  }
  return async function healBridges(vms) {
    const seenProxies = new Set()
    for (const vm of vms) {
      if (vm?.status !== 'running') continue
      const nodeId = vmNodeId(vm)
      if (nodeId) {
        const manager = getCluster()
        const status = manager?.slotBridgeStatus(nodeId, vm.id)
        if (status?.link?.state !== 'ready') continue
        const alive = status.bridge?.alive && status.relays?.kernel?.alive && status.relays?.worker?.alive
        if (alive || !due(`relay:${vm.id}`)) continue
        try {
          const healed = await manager.healSlotBridges(nodeId, vm.id)
          if (healed.length) logger.warn(`[bridge-heal] ${vm.id} rebuilt ${healed.join(', ')}`)
        } catch (error) {
          logger.warn(`[bridge-heal] ${vm.id} relay rebuild failed: ${error?.message || error}`)
        }
        continue
      }
      // Watchdog targets are panel summaries; kin-egress needs the record's credentialed proxy.
      const proxy = (ops.getVm || getVm)(projectRoot, vm.id)?.proxy
      if (isCodexVm(vm) || !hasBoundExit(proxy) || isLocalEgressProxy(proxy) || proxyBlockedReason(proxy)) continue
      if (seenProxies.has(proxy.id)) continue
      seenProxies.add(proxy.id)
      if (egressAlive(proxy.id) || !due(`egress:${proxy.id}`)) continue
      const result = await startEgress(proxy)
      if (result?.ok) logger.warn(`[bridge-heal] kin-egress ${proxy.id} was down; restarted`)
      else logger.warn(`[bridge-heal] kin-egress ${proxy.id} restart failed: ${result?.error || 'unknown'}`)
    }
  }
}
