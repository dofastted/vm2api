import type { Vm } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'
import { pct } from '@/lib/format'
import { isCodexVm } from '@/lib/vm-kind'

function credTextOf(vm: Vm): { text: string; key: string; tone: string } {
  const cred = vm.cred_status
  if (typeof cred === 'string') return { text: cred, key: '', tone: '' }
  return {
    text: String(cred?.text || ''),
    key: String(cred?.key || ''),
    tone: String(cred?.tone || ''),
  }
}

export function windowLimited(status: unknown, utilPct: number): boolean {
  const s = String(status || '').toLowerCase()
  return s === 'rejected' || s === 'rate_limited' || utilPct >= 100
}

function windowWarn(status: unknown, utilPct: number): boolean {
  const s = String(status || '').toLowerCase()
  return s === 'allowed_warning' || s === 'warning' || utilPct >= 85
}

export function fablePlanDenied(
  fb: Record<string, unknown> | undefined
): boolean {
  if (!fb) return false
  if (fb.plan_denied) return true
  const st = Number(fb.status || 0)
  const err = String(fb.error || fb.type || '')
  if (st === 401 || /oauth|authentication/i.test(err)) return false
  return st === 403 || /permission/i.test(err)
}

function probeOlderThanRefresh(vm: Vm): boolean {
  const probeAt = Date.parse(
    String(vm.last_probe?.at || vm.fable?.probed_at || '')
  )
  const refreshedAt = Date.parse(String(vm.refreshed_at || ''))
  return (
    Number.isFinite(probeAt) &&
    Number.isFinite(refreshedAt) &&
    probeAt < refreshedAt
  )
}

/**
 * 控制台 test-chat / 舰队健康探测 走的不是调度 hop。
 * 一次失败不能当成授权吊销或凭证作废。
 */
const TEST_PROBE_SOURCES =
  /^(test-chat|kin-console-test|kin-console-loadtest|health-probe|kin-health-probe)$/i

const USAGE_PROBE_SOURCES = new Set([
  'vm-oauth-usage',
  'official-cc-usage',
  'messages-headers',
])

const GRANT_DEATH =
  /credential_refresh_failed|oauth_revoked|oauth_invalid_grant|invalid_grant/i

function isTestChatProbe(vm: Vm): boolean {
  return TEST_PROBE_SOURCES.test(String(vm.last_probe?.source || ''))
}

function probeSourceOf(vm: Vm | undefined): string {
  return String(vm?.last_probe?.source || vm?.probe_source || '')
}

/** 官方 /usage 探测成功。 leftover refresh_error 不能盖掉这次结果。 */
function isUsageProbeOk(vm: Vm | undefined): boolean {
  if (!vm?.last_probe || vm.last_probe.ok !== true) return false
  const src = probeSourceOf(vm)
  return !src || USAGE_PROBE_SOURCES.has(src)
}

/** 传输层失败（SOCKS / 缺代理），不是 grant 死亡。PANEL_API：探测失败 = warn。 */
function isTransportProbe(vm: Vm | undefined): boolean {
  if (!vm?.last_probe) return false
  if (vm.last_probe.transport === true) return true
  const blob = [
    vm.last_probe.error,
    vm.worker_credential?.last_error,
    vm.worker_credential?.last_error_class,
  ]
    .filter(Boolean)
    .join(' ')
  return /transport|SOCKS|slot proxy is required|worker_unavailable|ENOENT/i.test(
    blob
  )
}

function probeOverridesGrant(vm: Vm | undefined): boolean {
  if (!vm) return false
  return isTestChatProbe(vm) || isUsageProbeOk(vm) || isTransportProbe(vm)
}

/**
 * 健康探测 / test-chat / 成功的 /usage / 传输失败 把 availability 标成 bad
 * 时，不能当成授权吊销。回落到票面 + last_probe.ok。
 */
function probeTaintedAvailability(vm: Vm | undefined): boolean {
  if (!vm || vm.availability?.key !== 'bad') return false
  if (probeOverridesGrant(vm)) return true
  const reason = String(vm.availability?.reason || '')
  return isTestChatProbe(vm) && GRANT_DEATH.test(reason)
}

function grantRevoked(vm: Vm): boolean {
  if (probeOlderThanRefresh(vm)) return false
  const skipProbe = probeOverridesGrant(vm)
  const bits = [
    skipProbe ? null : vm.last_probe?.error,
    skipProbe ? null : vm.fable?.error,
    vm.schedule_disabled_reason,
    skipProbe ? null : vm.worker_credential?.last_error,
    vm.cooldown_reason,
    isUsageProbeOk(vm) || isTransportProbe(vm) ? null : vm.refresh_error,
    skipProbe && GRANT_DEATH.test(String(vm.availability?.reason || ''))
      ? null
      : vm.availability?.reason,
  ]
  return /access token has been revoked|token has been revoked|oauth_revoked/i.test(
    bits.filter(Boolean).join(' ')
  )
}

/**
 * 授权被吊销 —— 独立于其它一切状态的终态。
 *
 * 必须先于 `availability.key` 的任何分支判断：后端会把一个已吊销的槽同时标成
 * `off`（运维关了调度）或 `quota`，照 key 判就会显示成「调度关」，把真正的
 * 死因盖掉。吊销不是「暂时不可调度」，是这张票再也打不通了，只能换票。
 * 对齐 index.html:2989 / 3007 的判定位置。
 */
export function vmRevoked(vm: Vm | undefined): boolean {
  if (!vm) return false
  return (
    grantRevoked(vm) ||
    (vm.availability?.reason === 'oauth_revoked' && !probeOverridesGrant(vm))
  )
}

/**
 * 票已经废了：摘调度原因或 refresh_error 是 grant death。
 * leftover /usage 成功只能救「还在池里」的槽；已经 oauth_invalid_grant 摘池的
 * 不能被 9 天前的探测绿点画成「调度关」或「可用」。
 */
function parkedGrantDeath(vm: Vm | undefined): boolean {
  if (!vm?.has_token) return false
  const blob = `${vm.schedule_disabled_reason || ''} ${vm.refresh_error || ''}`
  if (!GRANT_DEATH.test(blob)) return false
  if (
    isTransportProbe(vm) &&
    !GRANT_DEATH.test(String(vm.schedule_disabled_reason || ''))
  ) {
    return false
  }
  if (vm.schedulable !== false && (isUsageProbeOk(vm) || isTestChatProbe(vm))) {
    return false
  }
  return true
}

function invalidCredTone(vm: Vm | undefined): StatusTone {
  const revoked = vmRevoked(vm)
  return {
    cls: 'bad',
    key: revoked ? 'revoke' : 'bad',
    text: revoked ? '已吊销' : '无效凭证',
    label: revoked ? '已吊销' : '无效凭证',
  }
}

function ticketExpiredDead(vm: Vm): boolean {
  return credExpiry(vm).cls === 'bad' && !vm.has_refresh
}

function transportFailTone(): StatusTone {
  return { cls: 'caution', key: 'caution', text: '探测失败', label: '探测失败' }
}

export function credExpiry(vm: Vm): StatusTone & { ms: number | null } {
  if (!vm.has_token)
    return { cls: 'none', key: 'none', text: '无凭证', ms: null }
  const worker = vm.worker_credential || {}
  const raw = worker.expires_at || vm.expires_at
  const ms = typeof raw === 'number' ? raw : Date.parse(String(raw || ''))
  if (!Number.isFinite(ms))
    return { cls: 'ok', key: 'ok', text: '有效', ms: null }
  const left = ms - Date.now()
  if (left <= 0) return { cls: 'bad', key: 'bad', text: '已过期', ms }
  if (left < 60 * 60 * 1000)
    return { cls: 'caution', key: 'caution', text: '即将过期', ms }
  return { cls: 'ok', key: 'ok', text: '有效', ms }
}

/**
 * Claude 单元熔断的展示态。closed 返回 null。
 * open 到期但还没人来探测时，后端 view 已折算成 half_open。
 */
export function vmCircuit(
  vm: Vm | undefined,
  now = Date.now()
): {
  state: 'open' | 'half_open'
  failures: number
  threshold: number
  until: number | null
  left: number
} | null {
  const c = vm?.circuit
  if (!c || c.state === 'closed') return null
  const until = c.state === 'open' ? Number(c.open_until || 0) || null : null
  if (c.state === 'open' && until && until <= now) {
    return {
      state: 'half_open',
      failures: c.failures,
      threshold: c.threshold,
      until: null,
      left: 0,
    }
  }
  return {
    state: c.state,
    failures: c.failures,
    threshold: c.threshold,
    until,
    left: until ? until - now : 0,
  }
}

export function vmCircuitTitle(vm: Vm | undefined, now = Date.now()): string {
  const c = vmCircuit(vm, now)
  if (!c) return '熔断关闭'
  if (c.state === 'half_open')
    return '熔断半开 · 下一个请求作为探测，成功即恢复'
  const sec = Math.max(1, Math.ceil(c.left / 1000))
  return `熔断中 · 连续 ${c.failures}/${c.threshold} 次 5xx · ${sec}s 后放行探测`
}

function circuitTone(vm: Vm | undefined): StatusTone | null {
  const c = vmCircuit(vm)
  if (!c) return null
  return c.state === 'open'
    ? { key: 'circuit', text: '熔断中', cls: 'bad' }
    : { key: 'circuit', text: '熔断探测', cls: 'caution' }
}

export function vmCooldown(
  vm: Vm
): { until: number; reason: string; left: number } | null {
  const until = Number(vm.cooldown_until || 0)
  if (!until || until <= Date.now()) return null
  return {
    until,
    reason: String(vm.cooldown_reason || ''),
    left: until - Date.now(),
  }
}

export function vmCooldownTitle(vm: Vm): string {
  const cool = vmCooldown(vm)
  if (!cool) return '无冷却'
  const sec = Math.max(1, Math.ceil(cool.left / 1000))
  const wait = sec < 60 ? `${sec}s` : `${Math.ceil(sec / 60)}m`
  return `冷却中 ${wait}${cool.reason ? ` · ${cool.reason}` : ''}`
}

export function accountStatus(vm: Vm | undefined): StatusTone {
  if (parkedGrantDeath(vm) || vmRevoked(vm)) return invalidCredTone(vm)
  const restricted = restrictionTone(vm)
  if (restricted) return { ...restricted, label: restricted.text }

  if (vm?.availability?.key && !probeTaintedAvailability(vm)) {
    const a = vm.availability
    // 7 个 key 的完整映射，对齐 index.html 的 accountStatus。
    const fallback: Record<typeof a.key, string> = {
      none: '无凭证',
      ok: '可用',
      off: '调度关',
      cool: '冷却中',
      quota: '额度限制',
      sessions: '会话已满',
      bad: '无效凭证',
    }
    // 与 poolStatus 同口径：off 只表达调度意图，凭证死活先于它判。
    if (a.key === 'off') {
      if (!vm.has_token)
        return { cls: 'none', key: 'none', text: '无凭证', label: '无凭证' }
      if (ticketExpiredDead(vm))
        return { cls: 'bad', key: 'bad', text: '已过期', label: '已过期' }
    }
    const cls =
      a.key === 'ok'
        ? 'ok'
        : a.key === 'quota' || a.key === 'sessions'
          ? 'warn'
          : a.key === 'cool'
            ? 'caution'
            : a.key === 'off'
              ? 'off'
              : a.key === 'none'
                ? 'none'
                : 'bad'
    const text = a.text || fallback[a.key]
    return { cls, key: a.key, text, label: text }
  }
  if (!vm?.has_token) return { cls: 'none', key: 'none', text: '无凭证' }
  if (vmCooldown(vm)) return { cls: 'caution', key: 'caution', text: '冷却中' }
  const fb = vm.fable || {}
  const exp = credExpiry(vm)
  if (
    fb.banned &&
    !fablePlanDenied(fb) &&
    exp.cls !== 'ok' &&
    exp.cls !== 'caution'
  ) {
    return { cls: 'bad', key: 'bad', text: '被吊销' }
  }
  if (ticketExpiredDead(vm)) return { cls: 'bad', key: 'bad', text: '已过期' }
  const u5 = pct(vm.utilization_5h)
  const u7 = pct(vm.utilization_7d)
  if (windowLimited(vm.status_5h, u5))
    return { cls: 'warn', key: 'warn', text: '5h 限制' }
  if (windowLimited(vm.status_7d, u7))
    return { cls: 'warn', key: 'warn', text: '7d 限制' }
  const split = vm.weekly_split
  if (split?.enabled && split.mode === 'fable_only') {
    return { cls: 'warn', key: 'warn', text: '普通限制' }
  }
  const cred = credTextOf(vm)
  const staleRevoke = probeOlderThanRefresh(vm)
  const fableOnly = /Fable/.test(cred.text)
  // leftover 无效凭证 / 探测失败 不能盖掉活票或传输层失败。
  if (!fableOnly && !staleRevoke && !probeOverridesGrant(vm)) {
    if (cred.key === 'bad' || cred.tone === 'bad') {
      return { cls: 'bad', key: 'bad', text: cred.text || '无效凭证' }
    }
    if (/不可用/.test(cred.text))
      return { cls: 'bad', key: 'bad', text: cred.text }
    if (
      /冷却|限制/.test(cred.text) &&
      (windowLimited(vm.status_5h, u5) || windowLimited(vm.status_7d, u7))
    ) {
      return { cls: 'warn', key: 'warn', text: cred.text }
    }
  }
  if (isTransportProbe(vm) && !isUsageProbeOk(vm)) return transportFailTone()
  if (windowWarn(vm.status_5h, u5) || vm.near_limit) {
    return { cls: 'caution', key: 'caution', text: '5h 警告' }
  }
  if (windowWarn(vm.status_7d, u7))
    return { cls: 'caution', key: 'caution', text: '7d 警告' }
  if (!fableOnly) {
    if (
      /警告|探测失败/.test(cred.text) ||
      (cred.key === 'warn' && !/限制|冷却/.test(cred.text))
    ) {
      return { cls: 'caution', key: 'caution', text: cred.text || '警告' }
    }
    if (/限制|冷却/.test(cred.text) || cred.key === 'warn') {
      const soft =
        u5 < 100 &&
        !windowLimited(vm.status_5h, u5) &&
        u7 < 100 &&
        !windowLimited(vm.status_7d, u7)
      if (soft && /5h|7d/.test(cred.text)) {
        return {
          cls: 'caution',
          key: 'caution',
          text: cred.text.replace('限制', '警告'),
        }
      }
      return { cls: 'warn', key: 'warn', text: cred.text }
    }
  }
  return { cls: 'ok', key: 'ok', text: '可用' }
}

/**
 * 凭证有效性：**只**回答「这张票还能不能打通 Anthropic」，不掺调度意图。
 *
 * 与 `accountStatus` 的区别只在 `off` 一档。后端把「运维手动关调度」也编进
 * `availability.key='off'`，于是卡片上一个被主动关掉的健康号会显示成「调度关」
 * —— 但调度开关就在同一行右侧，这个格子重复了它，还盖掉了真正该看的凭证状态。
 * 这里把 `off` 拆掉：调度开关自己说调度，这个格子只说凭证。
 *
 * 关调度时后端不再提供额度/冷却明细，所以只能落到「凭证有效 / 已过期 /
 * 即将过期」几档（由过期时间判定），不猜额度。吊销更早一步就被
 * `accountStatus` 的 revoke 分支截走了，不会走到这里。
 */
export function credentialStatus(vm: Vm | undefined): StatusTone {
  const base = accountStatus(vm)
  if (base.key !== 'off') return base
  if (!vm?.has_token) return { cls: 'none', key: 'none', text: '无凭证' }
  const exp = credExpiry(vm)
  if (exp.cls === 'bad') return { cls: 'bad', key: 'bad', text: '已过期' }
  if (exp.cls === 'caution')
    return { cls: 'caution', key: 'caution', text: '即将过期' }
  return { cls: 'ok', key: 'ok', text: '凭证有效' }
}

function leftoverQuotaOff(vm: Vm | undefined): boolean {
  if (!vm || vm.schedulable !== false || vm.schedule_manual === true)
    return false
  return /^(quota_5h|quota_7d)/.test(String(vm.schedule_disabled_reason || ''))
}

/** 额度 / 429 / 冷却写成受限，不是操作员关。含未迁完的 leftover quota-off。 */
export function isRestrictedSchedule(vm: Vm | undefined): boolean {
  if (!vm) return false
  return vm.schedule_state === 'restricted' || leftoverQuotaOff(vm)
}

export function scheduleStateLabel(vm: Vm | undefined): '开' | '受限' | '关' {
  if (!vm) return '关'
  if (isRestrictedSchedule(vm)) return '受限'
  if (vm.schedule_state === 'off' || vm.schedulable === false) return '关'
  return '开'
}

export function restrictionUntilOf(vm: Vm | undefined): number | null {
  if (!vm) return null
  const until = Number(vm.restriction_until || 0)
  if (until > 0) return until
  const cool = Number(vm.cooldown_until || 0)
  return cool > 0 ? cool : null
}

/** 详情冷却格与限制态共用同一套文案，不另起一套冷却系统。 */
export function restrictionCopy(vm: Vm | undefined): string {
  if (!vm) return '无限制'
  const restricted = restrictionTone(vm)
  if (restricted) return restricted.text
  if (vmCooldown(vm)) return restrictionLabel(vm, '冷却中')
  return '无限制'
}

function restrictionLabel(vm: Vm, fallback: string): string {
  const raw = String(vm.availability?.text || '').trim()
  if (raw && raw !== '调度关' && vm.availability?.key !== 'off') return raw
  const reason = String(
    vm.restriction_reason ||
      vm.availability?.reason ||
      vm.schedule_disabled_reason ||
      ''
  )
  if (/quota_5h/.test(reason)) return '5h 限制'
  if (/quota_7d/.test(reason)) return '7d 限制'
  return fallback
}

function restrictionTone(vm: Vm | undefined): StatusTone | null {
  if (!vm) return null
  if (vm.schedule_state === 'restricted' || leftoverQuotaOff(vm)) {
    const reason = String(
      vm.restriction_reason || vm.availability?.reason || ''
    )
    if (
      vm.availability?.key === 'cool' ||
      /cool|rate_limited|account_quota/i.test(reason)
    ) {
      return {
        key: 'cool',
        text: restrictionLabel(vm, '冷却中'),
        cls: 'caution',
      }
    }
    return {
      key: 'quota',
      text: restrictionLabel(vm, '额度限制'),
      cls: 'warn',
    }
  }
  return null
}

export function poolStatus(vm: Vm | undefined): StatusTone {
  // 吊销 / 废票先判：它可能同时带着 off / quota 的 availability.key，照 key
  // 判会显示成「调度关」，把真正的死因盖掉。
  if (parkedGrantDeath(vm) || vmRevoked(vm)) return invalidCredTone(vm)
  // 调度关优先于熔断：操作员关掉的槽不显示熔断。
  if (vm?.schedule_state !== 'off') {
    const circuit = circuitTone(vm)
    if (circuit) return circuit
  }
  const restricted = restrictionTone(vm)
  if (restricted) return restricted
  if (vm?.schedule_state === 'off') {
    if (!vm.has_token) return { key: 'none', text: '无凭证', cls: 'none' }
    if (ticketExpiredDead(vm)) return { key: 'bad', text: '已过期', cls: 'bad' }
    return { key: 'off', text: '调度关', cls: 'off' }
  }

  if (vm?.availability?.key && !probeTaintedAvailability(vm)) {
    const a = vm.availability
    if (a.key === 'none')
      return { key: 'none', text: a.text || '无凭证', cls: 'none' }
    if (a.key === 'bad')
      return { key: 'bad', text: a.text || '无效凭证', cls: 'bad' }
    // 后端把「运维关调度」也编成 off，于是一台票已经废了的槽会显示成「调度关」，
    // 混在关闭调用里等着被人当好号重新打开。off 只该表达调度意图，凭证死活
    // 先于它判：没票 → 未使用，过期 → 无效凭证，其余才是真正的「调度关」。
    if (a.key === 'off') {
      if (!vm.has_token) return { key: 'none', text: '无凭证', cls: 'none' }
      if (ticketExpiredDead(vm))
        return { key: 'bad', text: '已过期', cls: 'bad' }
      return { key: 'off', text: a.text || '调度关', cls: 'off' }
    }
    if (a.key === 'quota' || a.key === 'sessions') {
      return { key: 'quota', text: a.text || '额度限制', cls: 'warn' }
    }
    if (a.key === 'cool' || vmCooldown(vm))
      return { key: 'cool', text: a.text || '冷却中', cls: 'caution' }
    if (!a.usable) return { key: 'bad', text: a.text || '无效凭证', cls: 'bad' }
    return { key: 'pool', text: a.text || '可用', cls: 'ok' }
  }
  if (!vm?.has_token) return { key: 'none', text: '无凭证', cls: 'none' }
  const fb = vm.fable || {}
  const exp = credExpiry(vm)
  if (
    fb.banned &&
    !fablePlanDenied(fb) &&
    exp.cls !== 'ok' &&
    exp.cls !== 'caution'
  ) {
    return { key: 'bad', text: '被吊销', cls: 'bad' }
  }
  // 过期无 refresh 才是死票。有 refresh 时 leftover 过期 access 仍可刷。
  if (ticketExpiredDead(vm)) return { key: 'bad', text: '已过期', cls: 'bad' }
  if (vm.schedulable === false)
    return { key: 'off', text: '调度关', cls: 'off' }
  if (vmCooldown(vm)) return { key: 'cool', text: '冷却中', cls: 'caution' }
  const u5 = pct(vm.utilization_5h)
  const u7 = pct(vm.utilization_7d)
  if (windowLimited(vm.status_5h, u5))
    return { key: 'quota', text: '5h 限制', cls: 'warn' }
  if (windowLimited(vm.status_7d, u7))
    return { key: 'quota', text: '7d 限制', cls: 'warn' }
  const split = vm.weekly_split
  if (split?.enabled && split.mode === 'fable_only') {
    return { key: 'quota', text: '普通限制', cls: 'warn' }
  }
  if (windowWarn(vm.status_5h, u5) || vm.near_limit) {
    return { key: 'quota', text: '5h 警告', cls: 'caution' }
  }
  if (windowWarn(vm.status_7d, u7))
    return { key: 'quota', text: '7d 警告', cls: 'caution' }
  if (isTransportProbe(vm) && !isUsageProbeOk(vm)) return transportFailTone()
  return { key: 'pool', text: '在池', cls: 'ok' }
}

/**
 * 可用账号口径（运营确认）：**凭证有效 = 可用**。
 * revoke / 过期 / 无效凭证不算；调度关但凭证有效的槽照算——关调度是
 * 运维意图，不是凭证死活。直接复用 `credentialStatus`：它对 off 槽
 * 会先查过期（如 vm-01 票已过期 → bad），对其余槽走 accountStatus
 * 完整判定链（revoke 先于一切）。号池额度卡与本口径共用同一谓词。
 */
export function accountUsable(vm: Vm | undefined): boolean {
  return Boolean(vm?.has_token) && credentialStatus(vm).cls !== 'bad'
}

export function vmRunning(vm: Vm | undefined): boolean {
  if (!vm) return false
  const s = String(vm.status || '').toLowerCase()
  if (s === 'stopped' || s === 'dead' || s === 'disabled') return false
  if (!vm.has_token) return false
  return Boolean(vm.active || s === 'running' || s === 'ok' || !s)
}

export function claudeTier(vm: Vm | undefined): StatusTone {
  if (isCodexVm(vm)) {
    if (!vm?.has_token)
      return { key: 'none', label: '—', cls: 'none', text: '—' }
    return { key: 'codex', label: 'GPT', cls: 'codex', text: 'GPT' }
  }
  if (!vm?.has_token) return { key: 'none', label: '—', cls: 'none', text: '—' }
  if (vm.usage_has_fable === false)
    return { key: 'pro', label: 'Pro', cls: 'pro', text: 'Pro' }
  const raw = String(vm.account_tier || '').toLowerCase()
  const oi = vm.utilization_7d_oi
  const oiN =
    oi == null ? null : Number(oi) > 1.5 ? Number(oi) / 100 : Number(oi)
  const realFable =
    vm.usage_has_fable === true ||
    (oiN != null && Boolean(vm.reset_7d_oi || oiN < 1))
  // Usage 里有 Fable 就是 Max。落盘 pro / hop 403 不能盖掉。
  // 没有套餐证据时不要画成 Pro，否则 Max 探测未完成的槽会一直显示 Pro。
  if (realFable || raw === 'max')
    return { key: 'max', label: 'Max', cls: 'max', text: 'Max' }
  if (raw === 'pro')
    return { key: 'pro', label: 'Pro', cls: 'pro', text: 'Pro' }
  return { key: 'pro', label: 'Pro', cls: 'pro', text: 'Pro' }
}

export function vmBuckets(vms: Vm[]) {
  const b = { ok: 0, caution: 0, warn: 0, bad: 0, off: 0, none: 0 }
  for (const vm of vms) {
    // 按 `cls` 归桶，不按 `key`：availability 存在时 key 是后端词汇
    // （quota / sessions / cool），没有同名桶，`key in b` 会静默漏掉这些槽位。
    // `cls` 两条路径下都已归一到这六个色调之一。
    const cls = accountStatus(vm).cls
    const bucket = cls in b ? (cls as keyof typeof b) : 'none'
    b[bucket] += 1
  }
  return b
}

export type FleetGroup =
  'pool' | 'restricted' | 'off' | 'none' | 'bad' | 'revoke'

/** Coarse fleet grouping for the VM list. 受限 is the triad, not 5h/7d warning. */
export function fleetGroup(vm: Vm): FleetGroup {
  const status = poolStatus(vm)
  const k = status.key
  if (k === 'revoke') return 'revoke'
  if (k === 'bad') return 'bad'
  if (k === 'none') return 'none'
  if (k === 'off') return 'off'
  if (isRestrictedSchedule(vm) || k === 'cool') return 'restricted'
  if (k === 'quota' && !/警告/.test(String(status.text || '')))
    return 'restricted'
  return 'pool'
}

export function fleetCounts(vms: Vm[]): Record<FleetGroup | 'all', number> {
  const c: Record<FleetGroup | 'all', number> = {
    all: vms.length,
    pool: 0,
    restricted: 0,
    off: 0,
    none: 0,
    bad: 0,
    revoke: 0,
  }
  for (const vm of vms) c[fleetGroup(vm)] += 1
  return c
}

/**
 * 这台槽的凭证是不是已经废了（吊销 / 过期 / 后端判定无效）。
 *
 * 「无效凭证」在筛选上拆成 bad + revoke 两档，但在**排序**上是一类：
 * 都得沉到列表底部，不该混在还能用的槽位中间。
 */
export function vmCredDead(vm: Vm): boolean {
  const g = fleetGroup(vm)
  return g === 'bad' || g === 'revoke'
}

/**
 * 这台槽「失效」发生的时间点，越大越近。用于把最近坏掉的排在无效组最前面
 * —— 运维要先看刚出事的那台，而不是按 vm-01/vm-02 的命名顺序翻。
 *
 * 取所有已知失效时间戳的最大值：探测失败时间与刷票时间各自独立更新，
 * 谁更新谁代表这台槽最后一次「有动静」。都没有则回 0，排到本组最后。
 */
export function vmFailedAt(vm: Vm): number {
  const stamps: unknown[] = [
    vm.last_probe?.at,
    vm.refreshed_at,
    vm.worker_credential?.expires_at,
    vm.expires_at,
  ]
  let max = 0
  for (const raw of stamps) {
    if (raw == null) continue
    const ms = typeof raw === 'number' ? raw : Date.parse(String(raw))
    if (Number.isFinite(ms) && ms > max) max = ms
  }
  return max
}

export function healthScore(vms: Vm[]): number {
  if (!vms.length) return 0
  const b = vmBuckets(vms)
  return Math.round(
    (b.ok * 100 + b.caution * 84 + b.warn * 68 + b.bad * 28 + b.off * 12) /
      vms.length
  )
}

export function normalizeVmFilter(f: string): string {
  if (f === 'ok') return 'pool'
  if (f === 'caution' || f === 'cool' || f === 'warn' || f === 'quota') {
    return 'restricted'
  }
  return f || 'all'
}

export function proxyHostLabel(
  proxy: { host?: string; port?: number | string; id?: string } | undefined
): string {
  if (!proxy) return '—'
  if (proxy.host)
    return `${proxy.host}${proxy.port != null ? `:${proxy.port}` : ''}`
  return proxy.id || '—'
}
