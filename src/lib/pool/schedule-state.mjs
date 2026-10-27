/**
 * One schedule state per slot, shared by the pool picker, the panel and the logs.
 *
 *   on             调度开
 *   off            调度关: operator only (`schedule_off`)
 *   unschedulable  不可调度: a deterministic failure (`unschedulable`); only an
 *                  operator action brings it back
 *   restricted     受限: clears by itself (quota, cooldown, circuit, hold, seats)
 *
 * vm.json keeps three owned fields. `schedulable` / `schedule_disabled_reason` /
 * `schedule_manual` are derived on every write so older readers keep working.
 */

export const SCHEDULE_STATES = Object.freeze(['on', 'off', 'unschedulable', 'restricted'])

/** Deterministic failures. Text is the panel label after 「不可调度 ·」. */
const UNSCHEDULABLE_REASONS = Object.freeze({
  no_credential: '无凭证',
  oauth_revoked: '凭证吊销',
  oauth_invalid_grant: '凭证失效',
  oauth_no_refresh: '无刷新令牌',
  oauth_cleared: '凭证已清空',
  oauth_expired: '凭证过期',
  credential_refresh_failed: '刷新失败',
  credential_blocked: '凭证不可用',
  organization_disabled: '组织禁用',
  proxy_required: '未绑代理',
  proxy_desynced: '代理失配',
  runtime_start_failed: '启动失败',
  circuit_escalated: '熔断升级',
  legacy_unknown: '待确认',
})

/** System holds: written and cleared by the system itself (受限 · slot). */
export const HOLD_MAINTENANCE = 'maintenance'
export const HOLD_PROXY = 'proxy_cooldown'
const HOLD_REASONS = Object.freeze({
  [HOLD_MAINTENANCE]: '维护中',
  [HOLD_PROXY]: '代理异常',
})

/**
 * 受限 · slot, most specific first. `match` is a prefix / exact test on the
 * reason code the pool, the error policy or evaluateAccount emits.
 */
const RESTRICTED_SLOT = [
  { match: /^quota_5h/, text: '5h 限制' },
  { match: /^quota_7d/, text: '7d 限制' },
  { match: /^(account_quota_exhausted|rate_limited|rate_limited_unknown|rpm_limited)$/, text: '限流中' },
  { match: /^[a-z]+_rate_limited$/, text: '限流中' },
  { match: /^(weekly_split_|fable_split|regular_split|fable_quota)/, text: '周额度切分' },
  {
    match: /^(auth_cooldown|authentication_failed_after_refresh|permission_denied|oauth_refresh_required)$/,
    text: '鉴权冷却',
  },
  { match: /^circuit_(open|probe)$/, text: '熔断中' },
  { match: /^(overloaded|provider_overloaded)$/, text: '过载冷却' },
  {
    match:
      /^(proxy_cooldown|proxy_transport_failure|proxy_or_edge_forbidden|egress_down|proxy_probe_failed|worker_proxy_missing)$/,
    text: '代理异常',
  },
  { match: /^(node_offline|node_capability_unavailable)$/, text: '节点离线' },
  { match: /^kernel_faulted$/, text: '内核故障' },
  { match: /^worker_unhealthy$/, text: '槽服务异常' },
  { match: /^maintenance$/, text: '维护中' },
  { match: /^rest_period$/, text: '休息时段' },
  { match: /^(cooldown|account_cooldown|restricted)$/, text: '冷却中' },
]

/** 受限 · new sessions only. Seated work keeps running on the slot. */
const RESTRICTED_NEW_SESSION = [
  { match: /^gate_(5h|7d)_draining$/, text: '临近闸线', soft: true },
  { match: /^seats_full$/, text: '席位满', soft: false },
  { match: /^sessions_full$/, text: '对话窗口满', soft: false },
]

/**
 * Codes that never change the slot state: the gateway's own risk gates (they
 * run before a slot is picked), upstream request-level refusals, single
 * request waits, and local transport errors.
 */
const STATELESS = [
  /^(distill_blocked|policy_blocked|refusal_guard|hard_regex.*|jev.*|decision_model.*)$/,
  /^(content_filter_refusal|content_policy_refusal|usage_policy_refusal|invalid_request|entitlement_required|http_\d+)$/,
  /_repairable$/,
  /^(concurrency_limit|concurrency_disabled|rpm_limit|slot_busy|quota_band_inflight|refresh_pending|vm_concurrency_limit)$/,
  /^(model_cooldown|fable_cooldown|fable_concurrency|fable_timeout|fable_plan_denied|fable_rate_limited|fable_requires_max|model_not_allowed|platform_mismatch|codex_vm)$/,
  /^(quota_guard_request_too_large|no_eligible_accounts|pool_overload_cooldown|pool_rate_limited|vm_unschedulable)$/,
  /^(wrap_connection_error|worker_transport_failure|worker_timeout|upstream_network_error|stream_interrupted|empty_response|incomplete_assistant|downstream_committed_or_incomplete|provider_timeout|client_cancelled|oauth_unconfirmed)$/,
  // Seat placement labels (why this VM was picked), not a slot condition.
  /^(sticky|node_owned_manifest|quota_state_changed)$/,
]

/**
 * @returns {{ state: string, scope: 'slot'|'new_session'|null, soft: boolean, text: string } | null}
 *   null = unknown code (tests treat that as a missing table row).
 */
export function stateOfReason(reason) {
  const code = String(reason || '').trim()
  if (!code) return null
  if (Object.hasOwn(UNSCHEDULABLE_REASONS, code)) {
    return { state: 'unschedulable', scope: 'slot', soft: false, text: UNSCHEDULABLE_REASONS[code] }
  }
  if (Object.hasOwn(HOLD_REASONS, code)) {
    return { state: 'restricted', scope: 'slot', soft: false, text: HOLD_REASONS[code] }
  }
  for (const row of RESTRICTED_SLOT) {
    if (row.match.test(code)) return { state: 'restricted', scope: 'slot', soft: false, text: row.text }
  }
  for (const row of RESTRICTED_NEW_SESSION) {
    if (row.match.test(code)) return { state: 'restricted', scope: 'new_session', soft: row.soft, text: row.text }
  }
  if (STATELESS.some((pattern) => pattern.test(code))) return { state: 'on', scope: null, soft: false, text: '' }
  return null
}

export function isUnschedulableReason(reason) {
  return stateOfReason(reason)?.state === 'unschedulable'
}

/**
 * Operator actions allowed to clear 不可调度. Background refresh / probe are not.
 * `credential_present` is the one system exception: a slot parked only for
 * having no ticket reopens once a ticket is on disk (a fact, not a verdict).
 */
/** Parks that only say "no ticket on disk"; `credential_present` may lift them. */
const NO_TICKET_REASONS = new Set(['no_credential', 'oauth_cleared'])

export const CLEAR_BY = Object.freeze([
  'operator',
  'credential_import',
  'proxy_rebind',
  'recover_ok',
  'credential_present',
])

// ---------------------------------------------------------------------------
// Record mutators (pure: callers own the file write)

function stamp(vm, now) {
  vm.schedule_updated_at = new Date(now).toISOString()
  vm.updated_at = vm.schedule_updated_at
}

/**
 * Re-derive the legacy trio from the owned fields. `paused` is only the UI
 * mark of a running slot out of the pool: it always clears once the slot is
 * schedulable again, and is set only when the caller does not preserve status.
 */
export function deriveScheduleFields(vm, { preserveStatus = true } = {}) {
  const off = vm.schedule_off === true
  const bad = vm.unschedulable?.reason || null
  const hold = vm.schedule_hold?.reason || null
  const schedulable = !off && !bad && !hold
  vm.schedulable = schedulable
  vm.schedule_manual = off
  vm.schedule_disabled_reason = off ? vm.schedule_off_reason || 'disabled' : bad || hold || null
  const status = String(vm.status || '').toLowerCase()
  if (schedulable && status === 'paused') vm.status = 'running'
  if (!preserveStatus && !schedulable && status === 'running') vm.status = 'paused'
  return vm
}

/** 调度关 / 调度开 by the operator. Turning on also clears 不可调度 (decision 6). */
export function applyScheduleOff(vm, off, { reason = null, now = Date.now(), preserveStatus = true } = {}) {
  if (off) {
    vm.schedule_off = true
    if (reason && reason !== 'disabled') vm.schedule_off_reason = String(reason).slice(0, 64)
    else delete vm.schedule_off_reason
  } else {
    delete vm.schedule_off
    delete vm.schedule_off_reason
    delete vm.unschedulable
  }
  stamp(vm, now)
  return deriveScheduleFields(vm, { preserveStatus })
}

export function applyUnschedulable(vm, reason, detail = null, { now = Date.now() } = {}) {
  const code = String(reason || '')
  if (!isUnschedulableReason(code)) throw new Error(`not an unschedulable reason: ${code}`)
  vm.unschedulable = { reason: code, detail: detail || null, at: new Date(now).toISOString() }
  stamp(vm, now)
  return deriveScheduleFields(vm)
}

export function applyClearUnschedulable(vm, { by, now = Date.now() } = {}) {
  if (!CLEAR_BY.includes(by)) throw new Error(`clearUnschedulable not allowed by: ${by}`)
  if (!vm.unschedulable) return vm
  if (by === 'credential_present' && !NO_TICKET_REASONS.has(vm.unschedulable.reason)) return vm
  delete vm.unschedulable
  stamp(vm, now)
  return deriveScheduleFields(vm)
}

export function applyHold(vm, reason, detail = null, { now = Date.now() } = {}) {
  if (!Object.hasOwn(HOLD_REASONS, reason)) throw new Error(`not a hold reason: ${reason}`)
  vm.schedule_hold = { reason, detail: detail || null, at: new Date(now).toISOString() }
  stamp(vm, now)
  return deriveScheduleFields(vm)
}

/** Clears only a hold whose reason (and, when given, detail tag) matches. */
export function applyClearHold(vm, reason, { tag = null, now = Date.now() } = {}) {
  const hold = vm.schedule_hold
  if (!hold || hold.reason !== reason) return vm
  if (tag != null && hold.detail?.tag !== tag) return vm
  delete vm.schedule_hold
  stamp(vm, now)
  return deriveScheduleFields(vm)
}

// ---------------------------------------------------------------------------
// Migration of records written before the four-state model

const LEGACY_HOLD = /^(kernel_update|[a-z_]*_worker_reload)$/
const LEGACY_PROXY_HOLD = /(egress_down|proxy_probe_failed|\|proxy=)/
const LEGACY_DROP = /^(quota_5h|quota_7d|account_quota_exhausted|rate_limited|quota_refresh_failed)/
const LEGACY_START_FAILED = /runtime start failed|start|boot|container|docker|kernel/i

/**
 * One-shot, idempotent. Keeps the legacy fields (rollback reads them) and only
 * adds the owned ones. Returns whether anything changed.
 */
export function migrateScheduleRecord(vm) {
  if (!vm || typeof vm !== 'object') return false
  if (vm.schedule_off === true || vm.unschedulable || vm.schedule_hold) return false
  if (vm.schedulable !== false) return false
  const reason = String(vm.schedule_disabled_reason || '').trim()
  if (vm.schedule_manual === true || reason === 'disabled' || reason === 'stopped' || !reason) {
    vm.schedule_off = true
    if (reason && reason !== 'disabled') vm.schedule_off_reason = reason.slice(0, 64)
  } else if (isUnschedulableReason(reason)) {
    vm.unschedulable = { reason, detail: vm.schedule_disabled_detail || null, at: vm.schedule_updated_at || null }
  } else if (reason === 'slot SOCKS5 proxy is required') {
    vm.unschedulable = { reason: 'proxy_required', detail: { message: reason }, at: vm.schedule_updated_at || null }
  } else if (LEGACY_HOLD.test(reason)) {
    vm.schedule_hold = { reason: HOLD_MAINTENANCE, detail: { tag: reason }, at: vm.schedule_updated_at || null }
  } else if (LEGACY_PROXY_HOLD.test(reason)) {
    const proxyId = /\|proxy=([^|\s]+)/.exec(reason)?.[1] || null
    vm.schedule_hold = {
      reason: HOLD_PROXY,
      detail: { tag: proxyId, message: reason },
      at: vm.schedule_updated_at || null,
    }
  } else if (LEGACY_DROP.test(reason)) {
    // Quota parks live on temp_unschedulable_* and are re-derived live.
  } else if (LEGACY_START_FAILED.test(reason)) {
    vm.unschedulable = {
      reason: 'runtime_start_failed',
      detail: { message: reason.slice(0, 240) },
      at: vm.schedule_updated_at || null,
    }
  } else {
    vm.unschedulable = {
      reason: 'legacy_unknown',
      detail: { raw: reason.slice(0, 240) },
      at: vm.schedule_updated_at || null,
    }
  }
  deriveScheduleFields(vm)
  return true
}

/** Owned schedule fields of a record (migrated copy), for writers that rebuild a record. */
export function pickScheduleFields(vm = {}) {
  const copy = {
    schedulable: vm.schedulable,
    schedule_manual: vm.schedule_manual,
    schedule_disabled_reason: vm.schedule_disabled_reason,
    schedule_disabled_detail: vm.schedule_disabled_detail,
    schedule_updated_at: vm.schedule_updated_at,
  }
  for (const key of ['schedule_off', 'schedule_off_reason', 'unschedulable', 'schedule_hold']) {
    if (vm[key] != null) copy[key] = structuredClone(vm[key])
  }
  migrateScheduleRecord(copy)
  const out = {}
  for (const key of ['schedule_off', 'schedule_off_reason', 'unschedulable', 'schedule_hold']) {
    if (copy[key] != null) out[key] = copy[key]
  }
  return out
}

// ---------------------------------------------------------------------------
// Resolution

/** Account availability keys (evaluateAccount) that mean 受限. */
const AVAILABILITY_RESTRICTED = new Set(['quota', 'cool', 'rest'])

/**
 * The single verdict for one slot.
 *
 * @param {object} input
 * @param {object} input.vm            vm.json record (owned + legacy fields)
 * @param {object} [input.availability] evaluateAccount result
 * @param {string|null} [input.restrictionReason]
 * @param {number|null} [input.restrictionUntil]
 * @param {{ state?: string, open_until?: number|null }|null} [input.circuit]
 * @param {{ used?: number, max?: number }|null} [input.seats]     Claude seat book
 * @param {{ active?: number, max?: number }|null} [input.sessions] GPT conversation windows
 */
export function resolveSlotState({
  vm = {},
  availability = {},
  restrictionReason = null,
  restrictionUntil = null,
  circuit = null,
  seats = null,
  sessions = null,
  now = Date.now(),
} = {}) {
  const textOf = (reason) => stateOfReason(reason)?.text || null
  const base = {
    restriction_reason: null,
    restriction_text: null,
    restriction_until: null,
    restriction_scope: null,
    restriction_soft: false,
    unschedulable_reason: vm.unschedulable?.reason || null,
    unschedulable_text: textOf(vm.unschedulable?.reason),
    unschedulable_detail: vm.unschedulable?.detail || null,
  }
  const unschedulable = (reason) => ({
    ...base,
    schedule_state: 'unschedulable',
    unschedulable_reason: reason,
    unschedulable_text: textOf(reason),
  })
  if (vm.schedule_off === true || (vm.schedulable === false && vm.schedule_manual === true && !vm.unschedulable)) {
    return { ...base, schedule_state: 'off' }
  }
  if (vm.unschedulable?.reason) return unschedulable(vm.unschedulable.reason)
  // A record not yet migrated: its legacy reason decides.
  if (vm.schedulable === false && !vm.schedule_hold) {
    const legacy = stateOfReason(vm.schedule_disabled_reason)
    if (legacy?.state === 'unschedulable') return unschedulable(vm.schedule_disabled_reason)
    if (!legacy || legacy.state !== 'restricted') return { ...base, schedule_state: 'off' }
  }
  // Live credential verdicts (no ticket, dead grant) read as 不可调度 too.
  if (availability?.key === 'none' || availability?.key === 'bad') {
    const reason = availability.reason || (availability.key === 'none' ? 'no_credential' : 'credential_refresh_failed')
    return unschedulable(isUnschedulableReason(reason) ? reason : 'credential_refresh_failed')
  }
  const restricted = (reason, until, scope = 'slot', soft = false) => ({
    ...base,
    schedule_state: 'restricted',
    restriction_reason: reason,
    restriction_text: textOf(reason),
    restriction_until: Number(until) > 0 ? Number(until) : null,
    restriction_scope: scope,
    restriction_soft: soft,
  })
  if (vm.schedule_hold?.reason) return restricted(vm.schedule_hold.reason, null)
  const until = Number(restrictionUntil) || Number(availability?.until) || 0
  const live = until > now
  if (!live && availability?.key === 'rest') {
    return restricted(availability.reason || 'rest_period', availability.until)
  }
  if (live || AVAILABILITY_RESTRICTED.has(availability?.key)) {
    return restricted(restrictionReason || availability?.reason || 'cooldown', live ? until : availability?.until)
  }
  if (circuit?.state === 'open') return restricted('circuit_open', circuit.open_until)
  if (availability?.key === 'drain') {
    return restricted(availability.reason || 'gate_5h_draining', null, 'new_session', true)
  }
  const seatMax = Number(seats?.max) || 0
  if (seatMax > 0 && (Number(seats?.used) || 0) >= seatMax) return restricted('seats_full', null, 'new_session')
  const sessionMax = Number(sessions?.max) || 0
  if (sessionMax > 0 && (Number(sessions?.active) || 0) >= sessionMax) {
    return restricted('sessions_full', null, 'new_session')
  }
  return { ...base, schedule_state: 'on' }
}
