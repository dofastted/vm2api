/**
 * Single account evaluation for panel + scheduler.
 * Capsule text and canAccept both read this result.
 */

import {
  effectiveRateWindow,
  headerHardBlocked,
  headerWindowOrEmpty,
  parseResetMs,
  WINDOW_5H_MS,
  WINDOW_7D_MS,
} from './quota-window.mjs'
import { DEFAULT_TIER_POLICIES } from './quota-tiers.mjs'
import { isOfficialUsageRateLimited } from '../oauth/crs-usage-probe.mjs'
import { expiresAtToMs } from '../oauth/oauth-credentials.mjs'
import {
  isAuthCooldownReason,
  isGrantRevoked,
  isLiveDiskGrant,
  probeOlderThanRefresh,
} from './schedule-eligibility.mjs'

export const USAGE_PROBE_SOURCES = new Set(['vm-oauth-usage', 'official-cc-usage', 'messages-headers'])
export const INVALID_CREDENTIAL_TEXT = '无效凭证'
export const AUTH_COOLDOWN_TEXT = '鉴权冷却'
export const REVOKE_TEXT = 'revoke'
/** Dead grant only. Do not match stale-access 401 (`authentication_failed_after_refresh`) or `/usage` 429. */
export const CREDENTIAL_REFRESH_FAIL =
  /oauth_invalid_grant|invalid_grant|refresh_token_missing|refresh token not found|oauth_revoked|oauth_no_refresh|oauth_cleared|credential_refresh_failed/i

function liveAccessTtlMs(vm = {}, workerCredential = {}, expiresAt = null) {
  return (
    expiresAtToMs(expiresAt) ||
    expiresAtToMs(workerCredential?.expires_at) ||
    expiresAtToMs(vm?.claude?.expires_at) ||
    expiresAtToMs(vm?.expires_at)
  )
}

function currentRefreshError(vm = {}, refreshError = null) {
  return refreshError || vm?.claude?.refresh_error || vm?.refresh_error || null
}

/** True when the slot already has a live access ticket after a later refresh. */
export function isLiveRefreshedAccess({ vm = {}, expiresAt = null, workerCredential = null, now = Date.now() } = {}) {
  const expMs = liveAccessTtlMs(vm, workerCredential || {}, expiresAt)
  if (!expMs || expMs <= now) return false
  if (workerCredential?.needs_refresh === true) return false
  return !!(workerCredential?.has_access || vm?.claude?.has_access || vm?.has_token)
}

export function isCredentialRefreshFailed({
  vm = {},
  scheduleDisabledReason = null,
  workerLastError = null,
  refreshError = null,
  probe = null,
  expiresAt = null,
  refreshedAt = null,
  workerCredential = null,
  now = Date.now(),
} = {}) {
  if (isOfficialUsageRateLimited(probe)) return false
  const recordedError = currentRefreshError(vm, refreshError)
  const accessLive = isLiveRefreshedAccess({ vm, expiresAt, workerCredential, now }) && !recordedError
  const staleProbe = probeOlderThanRefresh(
    {
      last_probe: probe,
      refreshed_at: refreshedAt || vm?.claude?.refreshed_at || vm?.refreshed_at || null,
    },
    { last_probe: probe },
  )
  const bits = [scheduleDisabledReason, vm.schedule_disabled_reason, recordedError]
  // Leftover worker last_error must not keep a freshly rotated ticket out of the pool.
  if (!accessLive) bits.push(workerLastError)
  if (!staleProbe && !(accessLive && isUsageRefreshSuccess(probe))) {
    bits.push(probe?.error, probe?.message)
  }
  return CREDENTIAL_REFRESH_FAIL.test(bits.filter(Boolean).join(' '))
}

export function isUsageRefreshSuccess(probe = {}, probeSource = null) {
  if (probe?.ok !== true) return false
  const src = String(probe.source || probeSource || '')
  return USAGE_PROBE_SOURCES.has(src)
}

function utilRatio(u) {
  if (u == null) return 0
  const n = Number(u)
  if (!Number.isFinite(n)) return 0
  return n > 1.5 ? n / 100 : n
}

function probeOf(account = {}, quota = {}, extras = {}) {
  const row = account || {}
  const q = quota || {}
  const extra = extras || {}
  return extra.lastProbe || extra.last_probe || q.last_probe || row.last_probe || row.unified?.last_probe || null
}

function sourceOf(probe, account = {}, quota = {}, extras = {}) {
  return (
    probe?.source || extras.probeSource || extras.probe_source || quota.probe_source || account.unified?.source || null
  )
}

function quotaWindows(quota = {}, account = {}) {
  const u = account.unified || {}
  const w5 = headerWindowOrEmpty(u, '5h')
  const w7 = headerWindowOrEmpty(u, '7d')
  if (
    quota &&
    (quota.utilization_5h != null || quota.status_5h || quota.status_7d || quota.reset_5h || quota.reset_7d)
  ) {
    return {
      ...quota,
      utilization_5h: quota.utilization_5h ?? w5.utilization,
      utilization_7d: quota.utilization_7d ?? w7.utilization,
      status_5h: quota.status_5h || w5.status,
      status_7d: quota.status_7d || w7.status,
      reset_5h: quota.reset_5h || w5.reset || null,
      reset_7d: quota.reset_7d || w7.reset || null,
      last_used_at: quota.last_used_at || account.last_used_at || null,
    }
  }
  return {
    utilization_5h: w5.utilization,
    utilization_7d: w7.utilization,
    status_5h: w5.status,
    status_7d: w7.status,
    weekly_split: quota.weekly_split || account.weekly_split || u.weekly_split,
    reset_5h: w5.reset,
    reset_7d: w7.reset,
    last_used_at: account.last_used_at || quota.last_used_at || null,
  }
}

function policyOf(input = {}) {
  const p = input.policy || {}
  const fallback = DEFAULT_TIER_POLICIES.default
  return {
    limit_5h: Number(p.limit_5h ?? p.safety_ratio ?? fallback.limit_5h),
    limit_7d: Number(p.limit_7d ?? p.weekly_safety_ratio ?? fallback.limit_7d),
    max_sessions: Number(p.max_sessions ?? 0),
    session_idle_min: Number(p.session_idle_min ?? 5),
  }
}

function finish(base, { key, text, accept, usable, reason = null, window = null, sessions = null, until = null } = {}) {
  return {
    ...base,
    key,
    text,
    accept,
    usable,
    reason,
    window,
    sessions,
    until,
  }
}

function resetUntilMs(reset, now = Date.now()) {
  const ms = parseResetMs(reset)
  return Number.isFinite(ms) && ms > now ? ms : null
}

function quotaUntilMs(quota = {}, window = '5h', now = Date.now()) {
  if (window === '7d') return resetUntilMs(quota.reset_7d, now)
  return resetUntilMs(quota.reset_5h, now)
}

/**
 * One judgment for panel capsules and /v1 admission.
 *
 * usable  = 账号还在（票活着且未人工出池）。额度闸上门仍为 true，通知不报池空。
 * accept  = 能否接 /v1。闸上门为 false。
 */
export function evaluateAccount({
  vm = {},
  account = {},
  hasToken = null,
  hasRefresh = null,
  schedulable = null,
  scheduleDisabledReason = null,
  lastProbe = null,
  probeSource = null,
  workerLastError = null,
  refreshError = null,
  expiresAt = null,
  refreshedAt = null,
  workerCredential = null,
  quota = {},
  policy = null,
  sessionKey = null,
  sessionLimit = null,
  cooldownUntil = null,
  cooldownReason = null,
  now = Date.now(),
} = {}) {
  account = account || {}
  quota = quota || {}
  vm = vm || {}
  const claude = vm.claude || {}
  const token = hasToken ?? !!(vm.has_token || claude.has_access)
  const refresh = hasRefresh ?? !!(vm.has_refresh || claude.has_refresh)
  const disabledReason = scheduleDisabledReason ?? vm.schedule_disabled_reason ?? null
  const leftoverQuotaOff = isLeftoverQuotaScheduleOff(vm, disabledReason)
  const inPool = leftoverQuotaOff || (schedulable ?? vm.schedulable) !== false
  const extras = { lastProbe, last_probe: lastProbe, probeSource, probe_source: probeSource }
  const probe = probeOf(account, quota, extras)
  const source = sourceOf(probe, account, quota, extras)
  const probedAt = probe?.at || probe?.probed_at || null
  const base = { source, probed_at: probedAt, in_pool: inPool }
  const pol = policyOf({ policy })

  if (!token && !refresh) {
    return finish(base, {
      key: 'none',
      text: '无凭证',
      accept: false,
      usable: false,
      reason: 'no_credential',
    })
  }

  const diskRefreshError = currentRefreshError(vm, refreshError)
  const revokeExtras = {
    vm,
    has_token: token,
    has_refresh: refresh,
    last_probe: probe,
    lastProbe: probe,
    refreshed_at: refreshedAt,
    schedule_disabled_reason: disabledReason,
    cooldown_reason: cooldownReason || account.cooldown_reason || claude.temp_unschedulable_reason || null,
    refresh_error: diskRefreshError,
    runtime: { cooldown_reason: cooldownReason || account.cooldown_reason || claude.temp_unschedulable_reason || null },
    worker_credential: { last_error: workerLastError, ...(workerCredential || {}) },
  }
  if (isGrantRevoked(revokeExtras, { last_probe: probe })) {
    return finish(base, {
      key: 'bad',
      text: REVOKE_TEXT,
      accept: false,
      usable: false,
      reason: 'oauth_revoked',
    })
  }

  const credRefreshFailed = isCredentialRefreshFailed({
    vm,
    scheduleDisabledReason: disabledReason,
    workerLastError,
    refreshError,
    probe,
    expiresAt,
    refreshedAt,
    workerCredential,
    now,
  })
  if (credRefreshFailed) {
    return finish(base, {
      key: 'bad',
      text: INVALID_CREDENTIAL_TEXT,
      accept: false,
      usable: false,
      reason: 'credential_refresh_failed',
    })
  }

  if (!inPool) {
    return finish(
      { ...base, in_pool: false },
      {
        key: 'off',
        text: '调度关',
        accept: false,
        usable: false,
        reason: disabledReason || 'disabled',
      },
    )
  }

  if (headerHardBlocked(account.unified || {}, '5h', now) || headerHardBlocked(quota, '5h', now)) {
    return finish(base, {
      key: 'quota',
      text: '5h 限制',
      accept: false,
      usable: true,
      reason: 'quota_5h_header',
      window: '5h',
      until: quotaUntilMs({ ...quota, reset_5h: quota.reset_5h || account.unified?.headers?.['5h']?.reset }, '5h', now),
    })
  }
  if (headerHardBlocked(account.unified || {}, '7d', now) || headerHardBlocked(quota, '7d', now)) {
    return finish(base, {
      key: 'quota',
      text: '7d 限制',
      accept: false,
      usable: true,
      reason: 'quota_7d_header',
      window: '7d',
      until: quotaUntilMs({ ...quota, reset_7d: quota.reset_7d || account.unified?.headers?.['7d']?.reset }, '7d', now),
    })
  }

  const q = quotaWindows(quota, account)
  const lastUsedAt = account.last_used_at || quota.last_used_at || q.last_used_at || null
  const w5 = effectiveRateWindow(
    {
      utilization: q.utilization_5h,
      status: q.status_5h,
      reset: q.reset_5h,
    },
    { lastUsedAt, source: 'headers', durationMs: WINDOW_5H_MS, now },
  )
  const w7 = effectiveRateWindow(
    {
      utilization: q.utilization_7d,
      status: q.status_7d,
      reset: q.reset_7d,
    },
    { lastUsedAt, source: 'headers', durationMs: WINDOW_7D_MS, now },
  )
  const u5 = utilRatio(w5.utilization)
  const u7 = utilRatio(w7.utilization)

  if (u5 >= 1) {
    return finish(base, {
      key: 'quota',
      text: '5h 限制',
      accept: false,
      usable: true,
      reason: 'quota_5h_header',
      window: '5h',
      until: resetUntilMs(w5.reset, now),
    })
  }
  if (u7 >= 1) {
    return finish(base, {
      key: 'quota',
      text: '7d 限制',
      accept: false,
      usable: true,
      reason: 'quota_7d_header',
      window: '7d',
      until: resetUntilMs(w7.reset, now),
    })
  }

  if (u5 >= pol.limit_5h) {
    return finish(base, {
      key: 'quota',
      text: '5h 限制',
      accept: false,
      usable: true,
      reason: 'quota_5h_safety',
      window: '5h',
      until: resetUntilMs(w5.reset, now),
    })
  }
  if (u7 >= pol.limit_7d) {
    return finish(base, {
      key: 'quota',
      text: '7d 限制',
      accept: false,
      usable: true,
      reason: 'quota_7d_safety',
      window: '7d',
      until: resetUntilMs(w7.reset, now),
    })
  }

  const split = q.weekly_split
  if (split?.enabled && split.mode === 'fable_only') {
    return finish(base, {
      key: 'quota',
      text: '普通限制',
      accept: true,
      usable: true,
      reason: 'weekly_split_regular',
    })
  }

  const accountId = account.account_id || account.accountId || vm.id || null
  const maxSessions = Number(pol.max_sessions ?? account.max_sessions ?? 0)
  const idleMin = Number(pol.session_idle_min ?? account.session_idle_min ?? 5)
  let sessions = null
  if (sessionLimit && typeof sessionLimit.snapshot === 'function') {
    sessions = sessionLimit.snapshot(accountId, { max: maxSessions, idleMin, now })
  }
  if (maxSessions > 0 && sessionLimit) {
    const gate =
      typeof sessionLimit.canAccept === 'function'
        ? sessionLimit.canAccept(accountId, sessionKey, { max: maxSessions, idleMin, now })
        : { ok: !(sessions && sessions.active >= maxSessions) }
    const atCap = sessions && sessions.active >= maxSessions && !sessionKey
    if (!gate.ok || atCap) {
      return finish(base, {
        key: 'sessions',
        text: '会话已满',
        accept: false,
        usable: true,
        reason: 'session_limit',
        sessions: gate.detail || sessions,
      })
    }
  }

  const tempUntil = Number(claude.temp_unschedulable_until || vm.temp_unschedulable_until || 0)
  const coolUntil = Math.max(
    Number(cooldownUntil || account.cooldown_until || vm.cooldown_until || 0),
    tempUntil > now ? tempUntil : 0,
  )
  if (coolUntil > now) {
    const reason =
      cooldownReason ||
      account.cooldown_reason ||
      claude.temp_unschedulable_reason ||
      vm.temp_unschedulable_reason ||
      null
    const leftoverRevokeCool =
      /oauth_revoked|token has been revoked/i.test(String(reason || '')) &&
      isLiveDiskGrant(vm, {
        refresh_error: diskRefreshError,
        schedule_disabled_reason: disabledReason,
        has_token: token,
        has_refresh: refresh,
      })
    if (!leftoverRevokeCool) {
      if (/oauth_revoked|token has been revoked/i.test(String(reason || ''))) {
        return finish(base, {
          key: 'bad',
          text: REVOKE_TEXT,
          accept: false,
          usable: false,
          reason: 'oauth_revoked',
        })
      }
      const authCool = isAuthCooldownReason(reason)
      return finish(base, {
        key: 'cool',
        text: authCool ? AUTH_COOLDOWN_TEXT : '冷却中',
        accept: false,
        usable: true,
        reason: authCool ? 'auth_cooldown' : 'cooldown',
        until: coolUntil,
      })
    }
  }

  return finish(base, {
    key: 'ok',
    text: '可用',
    accept: true,
    usable: true,
    reason: null,
    sessions,
  })
}

/** Extra 5h/7d reject reasons that write restriction, not 调度关. */
export function isQuotaWindowReason(reason) {
  return /^(quota_5h|quota_7d)/.test(String(reason || ''))
}

/** Account-scope quota / 429 parks stored on temp_unschedulable_* + runtime cooldown. */
export function isAccountRestrictionReason(reason) {
  return isQuotaWindowReason(reason) || /^(account_quota_exhausted|rate_limited)$/i.test(String(reason || ''))
}

/** Old Extra auto-off that is not an operator lock. */
export function isLeftoverQuotaScheduleOff(vm = {}, scheduleDisabledReason = null) {
  if (vm?.schedule_manual === true) return false
  if (vm?.schedulable !== false) return false
  return isQuotaWindowReason(scheduleDisabledReason ?? vm.schedule_disabled_reason)
}

/**
 * Operator switch stays a boolean. Quota / cooldown / leftover Extra-off
 * collapse to restricted so the panel never paints them as 调度关.
 */
export function resolveScheduleState({
  schedulable,
  scheduleManual,
  scheduleDisabledReason,
  availability = {},
  restrictionUntil = null,
  restrictionReason = null,
  now = Date.now(),
} = {}) {
  const leftover = isLeftoverQuotaScheduleOff(
    {
      schedulable,
      schedule_manual: scheduleManual,
      schedule_disabled_reason: scheduleDisabledReason,
    },
    scheduleDisabledReason,
  )
  if (schedulable === false && !leftover) {
    return { schedule_state: 'off', restriction_reason: null, restriction_until: null }
  }
  const until = Number(restrictionUntil) || Number(availability.until) || 0
  const liveRestriction = until > now
  const restricted = liveRestriction || availability.key === 'quota' || availability.key === 'cool'
  if (restricted) {
    return {
      schedule_state: 'restricted',
      restriction_reason:
        restrictionReason || availability.reason || (leftover ? scheduleDisabledReason : null) || null,
      restriction_until: liveRestriction ? until : availability.until || null,
    }
  }
  return { schedule_state: 'on', restriction_reason: null, restriction_until: null }
}

/** True when 5h/7d is in 限制 and the account must not be scheduled or probed. */
export function isQuotaLimitedAccount(account = {}, { now = Date.now(), policy = null } = {}) {
  const probe = account.last_probe || account.unified?.last_probe || null
  const ev = evaluateAccount({
    hasToken: true,
    hasRefresh: true,
    schedulable: true,
    lastProbe: probe?.ok
      ? probe
      : { ok: true, source: account.unified?.source || probe?.source || 'vm-oauth-usage', at: probe?.at },
    account,
    quota: account.unified || {},
    policy,
    now,
  })
  return ev.key === 'quota'
}

/** Panel + scheduler share this judgment. Green means the picker will select. */
export function evaluateSlotView(input = {}) {
  return evaluateAccount(input)
}

/** @deprecated use evaluateAccount */
export function availabilityFromQuotaRefresh(input = {}) {
  return evaluateAccount(input)
}

export function credStatusFromAvailability(av = {}) {
  const key = av.key || 'none'
  const tone =
    key === 'ok'
      ? 'ok'
      : key === 'quota' || key === 'sessions' || key === 'warn'
        ? 'warn'
        : key === 'cool' || key === 'caution'
          ? 'caution'
          : key === 'off'
            ? 'off'
            : key === 'none'
              ? 'none'
              : 'bad'
  const text =
    av.text ||
    (key === 'ok'
      ? '可用'
      : key === 'none'
        ? '无凭证'
        : key === 'off'
          ? '调度关'
          : key === 'quota'
            ? '5h 限制'
            : key === 'warn'
              ? '5h 警告'
              : key === 'sessions'
                ? '会话已满'
                : key === 'cool'
                  ? av.reason === 'auth_cooldown'
                    ? AUTH_COOLDOWN_TEXT
                    : '冷却中'
                  : av.reason === 'oauth_revoked'
                    ? REVOKE_TEXT
                    : INVALID_CREDENTIAL_TEXT)
  return {
    key,
    text,
    tone,
    reason: av.reason || null,
    usable: !!av.usable,
    accept: av.accept === true,
    in_pool: !!av.in_pool,
  }
}
