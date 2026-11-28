/**
 * Per-account Claude usage quota tracker (SQLite-backed).
 *
 * Scheduling and list Extra come from Messages response headers.
 * Official GET /api/oauth/usage is a manual calibration hop that writes
 * Extra (÷100) after a cache hit/miss.
 *
 * Persistent state → `accounts` + `account_allocations` tables.
 * Transient state (inflight counters, RPM buckets) stays in memory.
 */

import { resolveStoreDb } from '../db/database.mjs'
import { AccountsRepo } from '../db/repos/accounts-repo.mjs'
import { computeWeeklySplit, weeklySplitConfig } from './weekly-split.mjs'
import {
  applyEffectiveWindows,
  effectiveRateWindow,
  extraHeadersFromLimitError,
  extraIsLiveOpen,
  headerHardBlocked,
  headerWindow,
  headerWindowOrEmpty,
  isOfficialWindowLimited,
  leftoverClearHeaderWindows,
  listQuotaFromHeaders,
  officialWindow,
  parseResetMs,
  wipeElapsedHeaderWindows,
  wipeElapsedWindow,
} from './quota-window.mjs'
import { HISTORY_WINDOW_MS, rollWindowHistory } from './window-history.mjs'
import { accountTierKey, isNearLimit, normalizeTiers, resolveTierPolicy } from './quota-tiers.mjs'
import { resolvePolicyModelId } from '../protocol/model-policy.mjs'
import { isFableCreditsRequiredMessage, isOrganizationDisabledUsageResult } from './upstream-error-policy.mjs'
import { SessionLimitRegistry } from './session-limit.mjs'
import { applyVmQuotaConfig, applyVmQuotaPolicy } from './vm-quota-override.mjs'
import {
  FABLE_PROBE_MODEL,
  isFablePlanDenied,
  isInventedFableWindow,
  isOfficialUsageRateLimited,
  usageErrorText,
} from '../oauth/crs-usage-probe.mjs'
import { normalizeUsage } from '../admin/pricing.mjs'
import { disjointOpenaiUsage } from '../protocol/openai-usage.mjs'
import { isTestProbeSource } from './schedule-eligibility.mjs'
import {
  estimateRequestRisk,
  guardLargeColdEnabled,
  largeColdThresholdOf,
  resolveRequestRisk,
} from './quota-request-risk.mjs'
import {
  GATE_DRAINING,
  GATE_GATED,
  GATE_OPEN,
  gatePolicyFields,
  gateZone,
  quotaGateOf,
  worstGateZone,
} from './quota-gate.mjs'

/** How long a 'usage credits required' Fable answer keeps Fable off the seat. */
export const FABLE_CREDITS_DENY_MS = 6 * 60 * 60_000
/** Minimum post-inference settle age before an unconfirmed active query crosses the low-reading guard. */
export const ACTIVE_CALIBRATION_SETTLE_MS = 5 * 60_000

const RESET_WINDOW_MAP = {
  five_hour: '5h',
  '5h': '5h',
  seven_day: '7d',
  '7d': '7d',
  seven_day_overage_included: '7d_oi',
  '7d_oi': '7d_oi',
}
const MAX_APPLIED_RESET_OPS = 32

function fableModelKey(model) {
  return resolvePolicyModelId(model) || String(model || '').trim()
}

function setFableCreditsRequired(unified, key, now, durationMs) {
  const until = now + durationMs
  unified.model_denied_until = { ...(unified.model_denied_until || {}), [key]: until }
  unified.fable_credits_required = {
    model: key,
    at: new Date(now).toISOString(),
    until: new Date(until).toISOString(),
  }
}

function clearFableCreditsRequired(unified, key) {
  if (unified.model_denied_until?.[key]) {
    const denied = { ...unified.model_denied_until }
    delete denied[key]
    unified.model_denied_until = denied
  }
  if (unified.fable_credits_required?.model === key) delete unified.fable_credits_required
}

export { extraHeadersFromLimitError }
export { estimateRequestRisk }

export class AccountQuota {
  constructor({ dataDir, db, config, accounts }) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new AccountsRepo(this.db)
    this.config = config?.quota || {
      safety_ratio: 0.85,
      weekly_safety_ratio: 0.8,
      block_on_5h: true,
      block_on_7d: true,
    }
    this.concurrency = config?.concurrency || { default_max_per_account: 2 }
    this.tiers = normalizeTiers(config?.tiers, this.config, this.concurrency)
    this.inflight = new Map() // accountId → count
    this.rpmBuckets = new Map() // accountId → number[] timestamps ms
    // Settled-in-band hops whose Extra reading has not yet moved.
    this.staleSettled = new Map()
    this.observedUtil = new Map()
    this.reservationBand = new Map() // accountId → Map<reservation, boolean> (in-band at acquire)
    this.sessions = config?.sessions instanceof SessionLimitRegistry ? config.sessions : new SessionLimitRegistry()
    // vm_id → normalized `vm.policy.quota`; vm.json is the source of truth, this is the hot-path copy.
    this.vmQuota = new Map()
    // seed accounts
    for (const a of accounts || []) this.ensure(a)
  }

  /** Kept for API compat + post-restore hook (no in-memory cache to refresh). */
  reload() {}

  /** Re-bind to a fresh DB connection (after backup restore). */
  rebind(db) {
    this.db = db
    this.repo = new AccountsRepo(db)
  }

  /**
   * Optional structured window write-through target (AccountRuntimeRepo).
   * Mirrors the 5h session window + rate-limit resets into queryable columns.
   */
  attachRuntimeRepo(runtimeRepo) {
    this.runtimeRepo = runtimeRepo || null
  }

  _writeSessionWindow(acc) {
    if (!this.runtimeRepo?.updateWindow || !acc) return
    const extra = headerWindow(acc.unified, '5h')
    const w5 = extra.utilization != null || extra.status || extra.reset ? extra : officialWindow(acc.unified, '5h')
    const endIso = w5.reset || null
    const endMs = endIso ? Date.parse(endIso) : NaN
    try {
      this.runtimeRepo.updateWindow(acc.account_id, {
        vmId: acc.vm_id || null,
        sessionWindowEnd: Number.isFinite(endMs)
          ? endMs
          : Number.isFinite(parseResetMs(endIso))
            ? parseResetMs(endIso)
            : null,
        sessionWindowStart: Number.isFinite(endMs) ? endMs - 5 * 3600_000 : null,
        sessionWindowStatus: w5.status || null,
      })
    } catch {}
  }

  /**
   * Archive the window that just rolled over. A live header reading wins over the
   * official probe; once its reset has passed it belongs to the closed window and
   * the official reading of the newer window counts, unless it is a leftover 100%
   * (no gateway traffic since that window started).
   */
  _rollWindowHistory(acc, now = Date.now()) {
    if (!acc?.unified) return
    const read = (key) => {
      const extra = headerWindow(acc.unified, key)
      if (extra.utilization != null && parseResetMs(extra.reset) > now) return extra
      const official = officialWindow(acc.unified, key)
      if (!isOfficialWindowLimited(official, { now })) return official
      const effective = effectiveRateWindow(official, {
        now,
        lastUsedAt: this._lastUsedAt(acc.account_id),
        source: 'vm-oauth-usage',
        durationMs: HISTORY_WINDOW_MS[key],
      })
      return effective.stale ? null : official
    }
    acc.window_history = rollWindowHistory(acc.window_history, { '5h': read('5h'), '7d': read('7d') })
  }

  ensure(account) {
    const id = account.account_id || account.account_uuid || account.id
    if (!id) return
    let acc = this.repo.get(id)
    if (!acc) {
      acc = this.repo.insert({
        account_id: id,
        vm_id: account.vm_id || null,
        email: account.email || null,
        type: account.type || 'oauth',
        max_concurrency: account.max_concurrency ?? this.defaultMax(),
        concurrency_override: account.concurrency_override ? 1 : 0,
        max_rpm: account.max_rpm ?? this.defaultRpm(),
        rpm_override: account.rpm_override ? 1 : 0,
        requests: 0,
        tokens_in: 0,
        tokens_out: 0,
        unified: {
          '5h': { utilization: 0, reset: null, status: 'active' },
          '7d': { utilization: 0, reset: null, status: 'active' },
          representative_claim: null,
          overage_status: null,
          updated_at: null,
          ...(process.env.KIN_CRS_MOCK === '1'
            ? {
                source: 'vm-oauth-usage',
                last_probe: { ok: true, source: 'vm-oauth-usage', at: new Date().toISOString() },
              }
            : {}),
        },
        last_blocked: null,
        last_error: null,
      })
    } else if ((account.vm_id && acc.vm_id !== account.vm_id) || (account.type && acc.type !== account.type)) {
      if (account.vm_id) acc.vm_id = account.vm_id
      if (account.type) acc.type = account.type
      acc = this.repo.save(acc)
    }
    return acc
  }

  resetGenerations(accountId) {
    if (!accountId) return { '5h': 0, '7d': 0, '7d_oi': 0 }
    const acc = this.repo.get(accountId)
    const boundaries = acc?.unified?.reset_boundaries || {}
    return {
      '5h': Number(boundaries['5h']?.generation) || 0,
      '7d': Number(boundaries['7d']?.generation) || 0,
      '7d_oi': Number(boundaries['7d_oi']?.generation) || 0,
    }
  }

  isPreResetResponse(accountId, windowKey, { requestStartedAt = null, resetGenerations = null } = {}) {
    const key = RESET_WINDOW_MAP[windowKey] || windowKey
    if (!accountId || !key) return false
    const acc = this.repo.get(accountId)
    if (!acc?.unified?.reset_boundaries?.[key]) return false
    const check = checkResetWindowWrite(acc, key, {
      resetGenerations,
      startedAtMs: parseTimestampMs(requestStartedAt),
    })
    return !check.allowed
  }

  /**
   * Record a confirmed manual quota reset boundary for the account's cleared windows.
   * Only explicit `outcome === 'reset'` callers should invoke this; invalidation is
   * coordinated in account context without fabricating 0% or touching vm.schedulable.
   */
  recordQuotaReset(
    accountId,
    { cleared = [], at = null, operationId = null, now = Date.now(), replayed = false } = {},
  ) {
    if (!accountId) return { applied: false, replayed: !!replayed, windows: [], account: null }
    const windows = [
      ...new Set((Array.isArray(cleared) ? cleared : []).map((w) => RESET_WINDOW_MAP[w]).filter(Boolean)),
    ]
    if (!windows.length) {
      return { applied: false, replayed: !!replayed, windows: [], account: this.repo.get(accountId) || null }
    }
    const acc = this.ensure({ account_id: accountId })
    acc.unified = acc.unified || {}
    const op = operationId ? String(operationId) : null
    const appliedOps = Array.isArray(acc.unified.applied_reset_ops) ? [...acc.unified.applied_reset_ops] : []
    if (op && appliedOps.includes(op)) {
      return { applied: false, replayed: true, windows: [], account: acc }
    }
    const parsedAt = parseTimestampMs(at)
    if (replayed && parsedAt == null) {
      return { applied: false, replayed: true, windows: [], account: acc }
    }
    const nowMs = parseTimestampMs(now) ?? Date.now()
    const atMs = parsedAt ?? nowMs
    const atIso = new Date(atMs).toISOString()
    const boundaries = { ...(acc.unified.reset_boundaries || {}) }
    const updatedWindows = []
    for (const key of windows) {
      const prev = boundaries[key]
      const prevAtMs = parseTimestampMs(prev?.at_ms ?? prev?.at)
      if (prev && prevAtMs != null && atMs < prevAtMs) continue
      const prevGen = Number(prev?.generation) || 0
      const existingSampleMs =
        key === '7d_oi'
          ? parseTimestampMs(acc.unified.headers?.sampled_at)
          : parseTimestampMs(acc.unified.headers?.[key]?.sampled_at)
      const alreadyObservedAfter = replayed && existingSampleMs != null && existingSampleMs > atMs
      boundaries[key] = {
        generation: prevGen + 1,
        at: atIso,
        at_ms: atMs,
        ...(op ? { operation_id: op } : {}),
        reconciled: alreadyObservedAfter,
      }
      updatedWindows.push(key)
    }
    if (op) {
      appliedOps.push(op)
      acc.unified.applied_reset_ops = appliedOps.slice(-MAX_APPLIED_RESET_OPS)
    }
    if (!updatedWindows.length) {
      const saved = op ? this.repo.save(acc) : acc
      return { applied: false, replayed: !!replayed, windows: [], account: saved }
    }
    acc.unified.reset_boundaries = boundaries
    acc.unified.updated_at = new Date(nowMs).toISOString()
    const saved = this.repo.save(acc)
    return { applied: true, replayed: !!replayed, windows: updatedWindows, account: saved }
  }

  /**
   * Update from Anthropic response headers (unified OAuth stats).
   * headers: Headers | plain object (lower-cased keys preferred)
   */
  ingestHeaders(accountId, headers, usageBody = null, extra = {}) {
    const acc = this.ensure({ account_id: accountId })
    const h = normalizeHeaders(headers)
    acc.unified.headers = acc.unified.headers || {}
    acc.unified.header_stall = 0

    const nowMs = parseTimestampMs(extra.now) ?? Date.now()
    const countRequest = extra.countRequest !== false
    const exhausted = extra.exhausted === true || isUnifiedRejected(h)
    const writeExtra = countRequest || exhausted
    const u5 = num(h['anthropic-ratelimit-unified-5h-utilization'])
    const u7 = num(h['anthropic-ratelimit-unified-7d-utilization'])
    const s5Raw = String(h['anthropic-ratelimit-unified-5h-status'] || '').toLowerCase()
    const s7Raw = String(h['anthropic-ratelimit-unified-7d-status'] || '').toLowerCase()
    const rejected5 = s5Raw === 'rejected' || s5Raw === 'rate_limited'
    const rejected7 = s7Raw === 'rejected' || s7Raw === 'rate_limited'
    const sampledAt = new Date(nowMs).toISOString()
    const timing = {
      resetGenerations: extra.resetGenerations ?? null,
      startedAtMs: parseTimestampMs(extra.requestStartedAt),
    }
    const check5 = checkResetWindowWrite(acc, '5h', timing)
    const check7 = checkResetWindowWrite(acc, '7d', timing)
    const checkOi = checkResetWindowWrite(acc, '7d_oi', timing)
    let sampled = false
    let reconciledAny = false
    let resetReconciledAtMs = null
    if (exhausted) {
      if (check5.allowed) dropElapsedReset(acc, '5h', h['anthropic-ratelimit-unified-5h-reset'], nowMs)
      if (check7.allowed) dropElapsedReset(acc, '7d', h['anthropic-ratelimit-unified-7d-reset'], nowMs)
    }
    if (
      writeExtra &&
      check5.allowed &&
      (u5 != null || h['anthropic-ratelimit-unified-5h-status'] || h['anthropic-ratelimit-unified-5h-reset'])
    ) {
      const reconcile5 = check5.pendingReset && (u5 != null || rejected5)
      writeHeaderWindow(
        acc,
        '5h',
        {
          utilization: u5,
          reset: h['anthropic-ratelimit-unified-5h-reset'],
          status: h['anthropic-ratelimit-unified-5h-status'] || (u5 != null ? statusFromUtil(u5) : null),
          sampled_at: sampledAt,
        },
        { now: nowMs, replace: reconcile5 },
      )
      if (reconcile5) {
        acc.unified.reset_boundaries['5h'] = { ...acc.unified.reset_boundaries['5h'], reconciled: true }
        clearStalePreResetOfficialWindow(acc, '5h')
        reconciledAny = true
        resetReconciledAtMs = maxTimestamp(resetReconciledAtMs, boundaryAtMsOf(acc.unified.reset_boundaries['5h']))
      }
      sampled = true
    }
    if (
      writeExtra &&
      check7.allowed &&
      (u7 != null || h['anthropic-ratelimit-unified-7d-status'] || h['anthropic-ratelimit-unified-7d-reset'])
    ) {
      const reconcile7 = check7.pendingReset && (u7 != null || rejected7)
      writeHeaderWindow(
        acc,
        '7d',
        {
          utilization: u7,
          reset: h['anthropic-ratelimit-unified-7d-reset'],
          status: h['anthropic-ratelimit-unified-7d-status'] || (u7 != null ? statusFromUtil(u7) : null),
          sampled_at: sampledAt,
        },
        { now: nowMs, replace: reconcile7 },
      )
      if (reconcile7) {
        acc.unified.reset_boundaries['7d'] = { ...acc.unified.reset_boundaries['7d'], reconciled: true }
        clearStalePreResetOfficialWindow(acc, '7d')
        reconciledAny = true
        resetReconciledAtMs = maxTimestamp(resetReconciledAtMs, boundaryAtMsOf(acc.unified.reset_boundaries['7d']))
      }
      sampled = true
    }
    const uOi = num(h['anthropic-ratelimit-unified-7d_oi-utilization'])
    if (writeExtra && checkOi.allowed && (uOi != null || h['anthropic-ratelimit-unified-7d_oi-status'])) {
      const reconcileOi = checkOi.pendingReset && uOi != null
      acc.unified['7d_oi'] = {
        utilization: reconcileOi ? uOi : (uOi ?? acc.unified['7d_oi']?.utilization ?? null),
        reset:
          h['anthropic-ratelimit-unified-7d_oi-reset'] || (reconcileOi ? null : acc.unified['7d_oi']?.reset || null),
        status: h['anthropic-ratelimit-unified-7d_oi-status'] || statusFromUtil(uOi ?? 0),
        sampled_at: sampledAt,
      }
      acc.unified.headers['7d_oi'] = { ...acc.unified['7d_oi'] }
      if (reconcileOi) {
        acc.unified.reset_boundaries['7d_oi'] = { ...acc.unified.reset_boundaries['7d_oi'], reconciled: true }
        reconciledAny = true
      }
      sampled = true
    }
    if (
      writeExtra &&
      checkOi.allowed &&
      /seven_day_overage_included|7d_oi/i.test(String(h['anthropic-ratelimit-unified-representative-claim'] || ''))
    ) {
      acc.unified['7d_oi'] = {
        ...(acc.unified['7d_oi'] || {}),
        claim: h['anthropic-ratelimit-unified-representative-claim'],
      }
    }
    const anyWindowAllowed = check5.allowed || check7.allowed || checkOi.allowed
    if (writeExtra && anyWindowAllowed && h['anthropic-ratelimit-unified-representative-claim']) {
      acc.unified.representative_claim = h['anthropic-ratelimit-unified-representative-claim']
    }
    if (writeExtra && anyWindowAllowed && h['anthropic-ratelimit-unified-overage-status']) {
      acc.unified.overage_status = h['anthropic-ratelimit-unified-overage-status']
    }
    acc.unified.updated_at = sampledAt
    if (sampled) acc.unified.headers.sampled_at = sampledAt

    const usage = normalizeUsage(disjointOpenaiUsage(usageBody || {}) || {})
    if (
      countRequest &&
      (usage.input_tokens != null ||
        usage.output_tokens != null ||
        usage.cache_read_tokens != null ||
        usage.cache_creation_tokens != null)
    ) {
      acc.tokens_in += Number(usage.input_tokens) || 0
      acc.tokens_out += Number(usage.output_tokens) || 0
      acc.cache_read_tokens = (acc.cache_read_tokens || 0) + (Number(usage.cache_read_tokens) || 0)
      acc.cache_creation_tokens = (acc.cache_creation_tokens || 0) + (Number(usage.cache_creation_tokens) || 0)
    }
    if (countRequest) acc.requests += 1

    if (exhausted) {
      const exResult = applyHeaderExhausted(acc, h, sampledAt, {
        now: nowMs,
        allowed5: check5.allowed,
        allowed7: check7.allowed,
        replace5: check5.pendingReset,
        replace7: check7.pendingReset,
      })
      if (exResult.wrote5 && check5.pendingReset) {
        acc.unified.reset_boundaries['5h'] = { ...acc.unified.reset_boundaries['5h'], reconciled: true }
        reconciledAny = true
      }
      if (exResult.wrote7 && check7.pendingReset) {
        acc.unified.reset_boundaries['7d'] = { ...acc.unified.reset_boundaries['7d'], reconciled: true }
        reconciledAny = true
      }
    }

    if (reconciledAny && acc.unified.headers?.exhausted_at) {
      const s5 = String(acc.unified.headers['5h']?.status || '').toLowerCase()
      const s7 = String(acc.unified.headers['7d']?.status || '').toLowerCase()
      const stillRejected = s5 === 'rejected' || s5 === 'rate_limited' || s7 === 'rejected' || s7 === 'rate_limited'
      if (!stillRejected) acc.unified.headers.exhausted_at = null
    }

    if (countRequest) {
      const view = headerWindowOrEmpty(acc.unified, '5h', { now: nowMs })
      const view7 = headerWindowOrEmpty(acc.unified, '7d', { now: nowMs })
      this.repo.addAllocation(accountId, {
        at: sampledAt,
        source: 'headers',
        util_5h: view.utilization ?? officialWindow(acc.unified, '5h').utilization,
        util_7d: view7.utilization ?? officialWindow(acc.unified, '7d').utilization,
        status_5h: view.status || null,
        status_7d: view7.status || null,
        claim: acc.unified.representative_claim,
        tokens_in: usageBody?.input_tokens ?? null,
        tokens_out: usageBody?.output_tokens ?? null,
      })
    }

    settleElapsedHeaderWindows(acc, sampledAt, nowMs)
    this._rollWindowHistory(acc, nowMs)
    const saved = this.repo.save(acc)
    this._writeSessionWindow(saved)
    if (reconciledAny && this.headerUnderSafety(saved, nowMs)) {
      this.clearQuotaExhaustedCooldown(accountId, {
        now: nowMs,
        ...(resetReconciledAtMs != null ? { resetReconciledAtMs } : {}),
      })
    }
    if (sampled) {
      const observed5 = headerWindowOrEmpty(saved.unified, '5h', { now: nowMs })
      const observed7 = headerWindowOrEmpty(saved.unified, '7d', { now: nowMs })
      this._observeUtil(accountId, {
        u5: observed5.utilization,
        u7: observed7.utilization,
        source: 'headers',
      })
    }
    return saved
  }

  recordLastProbe(accountId, probe = {}) {
    if (!accountId) return null
    const acc = this.ensure({ account_id: accountId })
    const prev = acc.last_probe || acc.unified?.last_probe || null
    if (isTestProbeSource(probe) && prev?.ok === true && !isTestProbeSource(prev)) {
      return acc
    }
    acc.last_probe = {
      at: probe.at || new Date().toISOString(),
      ok: !!probe.ok,
      source: probe.source || 'test-chat',
      error: probe.error || null,
      transport: !!probe.transport,
      status: probe.status || null,
    }
    acc.unified.last_probe = acc.last_probe
    return this.repo.save(acc)
  }

  /**
   * CRS oauth/usage snapshot from the VM UID probe.
   * Fable weekly limit is stored separately and does not unschedulable the account.
   */
  ingestOAuthUsage(accountId, probe = {}, opts = {}) {
    const acc = this.ensure({ account_id: accountId })
    const nowMs = parseTimestampMs(opts.now ?? probe.now) ?? Date.now()
    const startedAtMs = parseTimestampMs(opts.startedAt ?? probe.started_at ?? probe.request_started_at)
    const rawProbedAtMs = parseTimestampMs(probe.probed_at)
    const probeTiming = {
      resetGenerations: opts.resetGenerations ?? probe.reset_generations ?? null,
      startedAtMs,
      probedAtMs: rawProbedAtMs,
      allowProbedAtFallback: true,
    }
    const check5 = checkResetWindowWrite(acc, '5h', probeTiming)
    const check7 = checkResetWindowWrite(acc, '7d', probeTiming)
    const checkOi = checkResetWindowWrite(acc, '7d_oi', probeTiming)

    const profileTier =
      probe.account_tier_source === 'profile' && ['pro', 'max'].includes(probe.account_tier) ? probe.account_tier : null
    if (profileTier) {
      acc.unified.account_tier = profileTier
      acc.unified.account_tier_source = 'profile'
    }
    const nowIso = probe.probed_at || new Date(nowMs).toISOString()
    const officialUpdatedAtMs = parseTimestampMs(nowIso) ?? nowMs
    // An org refusal is a deterministic slot state, not a transient usage
    // backoff: keep the raw error (the panel and the runtime classifier both
    // read it) instead of painting rate_limited over an org-disabled slot.
    const orgDisabled = isOrganizationDisabledUsageResult({
      ...probe,
      ok: probe.ok,
      usage_scope_missing: probe.usage_scope_missing,
    })
    if (isOfficialUsageRateLimited(probe) && !orgDisabled) {
      const retryMs = Number(probe.retry_after_ms)
      const backoff =
        Number.isFinite(retryMs) && retryMs > 0 ? Math.min(Math.max(retryMs, 60_000), 30 * 60_000) : 15 * 60_000
      acc.unified = acc.unified || {}
      acc.unified.usage_rate_limited_until = new Date(nowMs + backoff).toISOString()
      acc.unified.usage_probe_attempted_at = nowIso
      const prev = acc.last_probe || acc.unified.last_probe || {}
      acc.last_probe = {
        ...prev,
        at: prev.ok === true ? prev.at || prev.probed_at || nowIso : prev.at || nowIso,
        ok: prev.ok === true,
        source: prev.source || probe.source || 'official-cc-usage',
        error: prev.ok === true ? null : prev.error || null,
        rate_limited: true,
        attempted_at: nowIso,
      }
      acc.unified.last_probe = acc.last_probe
      return this.repo.save(acc)
    }
    if (acc.unified) delete acc.unified.usage_rate_limited_until
    const usageOk = probe.ok === true || (probe.usage_status > 0 && probe.usage_status < 400)
    const completeOfficialUsage = usageOk && probe.limits_present === true
    const activeCalibration =
      opts.activeCalibration === true &&
      probe.ok === true &&
      Number(probe.usage_status) === 200 &&
      probe.limits_present === true
    const forceReconcile = activeCalibration && opts.forceReconcile === true
    const official = probe.interpretations?.official || {}
    const w5 = official.five_hour || probe.five_hour || {}
    const w7 = official.seven_day || probe.seven_day || {}
    const freshWindows = { '5h': false, '7d': false, '7d_oi': false }
    if (check5.allowed && writeOfficialWindow(acc, '5h', w5, nowIso)) freshWindows['5h'] = true
    if (check7.allowed && writeOfficialWindow(acc, '7d', w7, nowIso)) freshWindows['7d'] = true
    if (probe.seven_day_sonnet) {
      acc.unified.seven_day_sonnet = {
        utilization: probe.seven_day_sonnet.utilization ?? null,
        reset: probe.seven_day_sonnet.resets_at || null,
        status: probe.seven_day_sonnet.status || null,
      }
    }
    if (probe.extra_usage) acc.unified.overage_status = probe.extra_usage.status || acc.unified.overage_status
    acc.unified.extra_usage = probe.extra_usage || acc.unified.extra_usage || null
    const fableTransport = isFableTransportFailure(probe)
    if (probe.fable) acc.unified.fable_probe_attempted_at = nowIso
    const oi = probe.seven_day_oi || probe.seven_day_overage_included || probe.fable?.seven_day_oi
    const oiUtil =
      oi?.utilization != null
        ? Number(oi.utilization)
        : probe.fable?.utilization != null
          ? Number(probe.fable.utilization)
          : null
    const oiNorm = oiUtil != null && Number.isFinite(oiUtil) ? (oiUtil > 1.5 ? oiUtil / 100 : oiUtil) : null
    const oiRejected =
      ['rejected', 'rate_limited'].includes(String(oi?.status || '').toLowerCase()) || (oiNorm != null && oiNorm >= 1)
    const hasOiObservation = Boolean(oiNorm != null || oi?.status || oi?.resets_at || oi?.reset || oiRejected)
    const incomingOi = hasOiObservation
      ? {
          utilization: oiNorm ?? (oiRejected ? 1 : null),
          reset: oi?.resets_at || oi?.reset || probe.fable?.reset_at || null,
          status: oiRejected ? 'rejected' : oi?.status || (oiNorm != null ? statusFromUtil(oiNorm) : null),
        }
      : null
    if (checkOi.allowed && hasOiObservation) {
      freshWindows['7d_oi'] = true
      if (!activeCalibration) {
        const reconcileOi = checkOi.pendingReset && oiNorm != null
        acc.unified['7d_oi'] = {
          utilization: reconcileOi
            ? oiNorm
            : (oiNorm ?? (oiRejected ? 1 : (acc.unified['7d_oi']?.utilization ?? null))),
          reset:
            oi?.resets_at ||
            oi?.reset ||
            probe.fable?.reset_at ||
            (reconcileOi ? null : acc.unified['7d_oi']?.reset || null),
          status: oiRejected
            ? 'rejected'
            : oi?.status ||
              (oiNorm != null ? statusFromUtil(oiNorm) : reconcileOi ? null : acc.unified['7d_oi']?.status || null),
        }
      }
    }
    const leftoverFable = acc.unified.fable || {}
    const hasFableUsage =
      probe.usage_has_fable === true ||
      (!isInventedFableWindow(probe.fable || leftoverFable, {
        utilization_7d_oi: oiNorm,
        reset_7d_oi: oi?.resets_at || oi?.reset,
        status_7d_oi: oi?.status,
        '7d_oi': oi,
      }) &&
        (oiNorm != null || oi?.resets_at || oi?.reset || oi?.status))
    const inflightCount = this.inflight.get(accountId) || 0
    const latestActivityAtMs = this._latestActivityAtMs(accountId)
    if (completeOfficialUsage && (probe.usage_has_fable === true || hasFableUsage)) acc.unified.usage_has_fable = true
    else if (
      completeOfficialUsage &&
      probe.usage_has_fable === false &&
      checkOi.allowed &&
      (!activeCalibration || inflightCount === 0)
    ) {
      acc.unified.usage_has_fable = false
      delete acc.unified['7d_oi']
      if (acc.unified.headers) delete acc.unified.headers['7d_oi']
      delete acc.unified.fable
    }
    if (completeOfficialUsage) {
      if (probe.usage_has_fable === true || hasFableUsage) acc.unified.account_tier = 'max'
      else if (probe.usage_has_fable === false) acc.unified.account_tier = 'pro'
      if (probe.usage_has_fable != null || hasFableUsage) acc.unified.account_tier_source = 'usage'
    }
    if (probe.fable && !fableTransport && checkOi.allowed) {
      const planDenied = completeOfficialUsage && !hasFableUsage && isFablePlanDenied(probe.fable)
      acc.unified.fable = {
        limited: oiRejected,
        banned: !!probe.fable.banned && !usageOk && (probe.usage_status === 401 || probe.usage_status === 403),
        plan_denied: planDenied,
        ok: completeOfficialUsage && hasFableUsage,
        status: probe.fable.status || 0,
        reset: probe.fable.reset_at || acc.unified['7d_oi']?.reset || null,
        utilization: oiNorm ?? probe.fable.utilization ?? acc.unified['7d_oi']?.utilization ?? null,
        model: probe.fable.model || 'claude-fable-5',
        error: usageOk && Number(probe.fable.status) === 401 ? null : probe.fable.error || null,
        probed_at: probe.probed_at || new Date(nowMs).toISOString(),
      }
      // Only a complete official /usage classifies the plan; Fable hop only fills metadata.
      if (completeOfficialUsage && hasFableUsage) {
        acc.unified.account_tier = 'max'
        acc.unified.account_tier_source = 'usage'
      }
    } else if (usageOk) {
      const leftover = leftoverFable
      if (
        !activeCalibration &&
        checkOi.allowed &&
        checkOi.pendingReset &&
        freshWindows['7d_oi'] &&
        oiNorm != null &&
        acc.unified.fable
      ) {
        acc.unified.fable = {
          ...acc.unified.fable,
          limited: oiRejected,
          utilization: oiNorm,
          reset: oi?.resets_at || oi?.reset || null,
          probed_at: probe.probed_at || acc.unified.fable.probed_at || new Date(nowMs).toISOString(),
        }
      }
      if (completeOfficialUsage && hasFableUsage) {
        acc.unified.account_tier = 'max'
        acc.unified.account_tier_source = 'usage'
        if (leftover.plan_denied || leftover.ok === false) {
          acc.unified.fable = {
            ...(acc.unified.fable || leftover),
            plan_denied: false,
            ok: true,
            error: null,
            probed_at: probe.probed_at || leftover.probed_at || new Date(nowMs).toISOString(),
          }
        }
      }
    }
    // 限额查询's Fable hop sees the same 'usage credits required' 429 that
    // routing does; record it the same way, and lift it when the hop succeeds.
    if (probe.fable && !fableTransport && checkOi.allowed) {
      const fableKey = fableModelKey(FABLE_PROBE_MODEL)
      if (Number(probe.fable.status) === 429 && isFableCreditsRequiredMessage(probe.fable.error)) {
        setFableCreditsRequired(acc.unified, fableKey, Date.parse(nowIso) || nowMs, FABLE_CREDITS_DENY_MS)
      } else if (probe.fable.ok) {
        clearFableCreditsRequired(acc.unified, fableKey)
      }
    }
    if (profileTier) {
      acc.unified.account_tier = profileTier
      acc.unified.account_tier_source = 'profile'
    }
    acc.unified.source = 'vm-oauth-usage'
    acc.unified.updated_at = new Date(nowMs).toISOString()
    acc.last_probe = {
      at: probe.probed_at || new Date(nowMs).toISOString(),
      ok: !!probe.ok,
      source: probe.source || 'vm-oauth-usage',
      error:
        usageErrorText({ error: probe.error || probe.usage_error || (usageOk ? null : probe.fable?.error) }) || null,
      transport: fableTransport,
    }
    acc.unified.last_probe = acc.last_probe
    let syncResult = {
      copied: false,
      reconciledAny: false,
      calibratedAny: false,
      resetReconciledAtMs: null,
      retainedWindows: [],
      blockedWindows: new Set(),
      calibration: {
        reconciled: true,
        force_reconcile: forceReconcile,
        reconciled_windows: [],
        retained_windows: [],
        can_force_reconcile: false,
        settle_remaining_ms: 0,
      },
    }
    if (usageOk) {
      syncResult = syncActiveToPassive(acc, nowIso, {
        now: nowMs,
        freshWindows,
        checks: { '5h': check5, '7d': check7, '7d_oi': checkOi },
        activeCalibration,
        forceReconcile,
        probeStartedAtMs: startedAtMs,
        officialUpdatedAtMs,
        inflightCount,
        latestActivityAtMs,
        incomingWindows: { '5h': w5, '7d': w7, '7d_oi': incomingOi },
        hasFableProbe: Boolean(probe.fable && !fableTransport),
      })
      healOfficialOverwriteExtra(acc, accountId, this.repo, nowMs)
      clearHeaderExhaustIfOfficialOpen(acc, {
        allowed5: check5.allowed && !syncResult.blockedWindows.has('5h') && (freshWindows['5h'] || !activeCalibration),
        allowed7: check7.allowed && !syncResult.blockedWindows.has('7d') && (freshWindows['7d'] || !activeCalibration),
      })
    }
    settleElapsedHeaderWindows(acc, nowIso, nowMs)
    this._rollWindowHistory(acc, nowMs)
    const saved = this.repo.save(acc)
    this._writeSessionWindow(saved)
    if (usageOk) {
      const observed5 = headerWindowOrEmpty(saved.unified, '5h', { now: nowMs })
      const observed7 = headerWindowOrEmpty(saved.unified, '7d', { now: nowMs })
      this._observeUtil(accountId, {
        u5: observed5.utilization,
        u7: observed7.utilization,
        source: 'official',
      })
    }
    if (usageOk && this.headerUnderSafety(saved, nowMs)) {
      const activeCalibratedBeforeMs =
        activeCalibration &&
        syncResult.calibratedAny &&
        syncResult.retainedWindows.length === 0 &&
        Number.isFinite(startedAtMs)
          ? startedAtMs
          : null
      this.clearQuotaExhaustedCooldown(accountId, {
        now: nowMs,
        ...(syncResult.reconciledAny && syncResult.resetReconciledAtMs != null
          ? { resetReconciledAtMs: syncResult.resetReconciledAtMs }
          : {}),
        ...(activeCalibratedBeforeMs != null ? { activeCalibratedBeforeMs } : {}),
      })
    }
    if (typeof opts.onCalibration === 'function') {
      opts.onCalibration(syncResult.calibration)
    }
    return saved
  }

  /**
   * Official Claude Code stream-json `rate_limit_event`.
   * Live CLI includes `unifiedWindows.*.utilization`; keep status + reset too.
   */
  ingestCliRateLimit(
    accountId,
    rateLimitInfo,
    usageBody = null,
    { countRequest = null, requestStartedAt = null, resetGenerations = null, now = Date.now() } = {},
  ) {
    const acc = this.ensure({ account_id: accountId })
    acc.unified.headers = acc.unified.headers || {}
    const nowMs = parseTimestampMs(now) ?? Date.now()
    const infos = Array.isArray(rateLimitInfo) ? rateLimitInfo : rateLimitInfo ? [rateLimitInfo] : []
    const sampledAt = new Date(nowMs).toISOString()
    const timing = {
      resetGenerations,
      startedAtMs: parseTimestampMs(requestStartedAt),
    }
    let reconciledAny = false
    let resetReconciledAtMs = null
    for (const info of infos) {
      if (!info || typeof info !== 'object') continue
      const typ = String(info.rateLimitType || info.rate_limit_type || '')
      const window = typ === 'seven_day' || typ === '7d' ? '7d' : typ === 'five_hour' || typ === '5h' ? '5h' : null
      const windows = info.unifiedWindows || info.unified_windows || {}
      if (window) {
        const check = checkResetWindowWrite(acc, window, timing)
        if (!check.allowed) continue
        const slot = window === '7d' ? windows.seven_day || windows['7d'] : windows.five_hour || windows['5h']
        const utilization = officialUtilToExtra(slot?.utilization)
        const isRej = ['rejected', 'rate_limited'].includes(String(info.status || '').toLowerCase())
        const reconcile = check.pendingReset && (utilization != null || isRej)
        writeHeaderWindow(
          acc,
          window,
          {
            status: info.status || (utilization != null ? statusFromUtil(utilization) : null),
            reset: info.resetsAt != null || info.resets_at != null ? epochToIso(info.resetsAt ?? info.resets_at) : null,
            utilization,
            sampled_at: sampledAt,
          },
          { now: nowMs, replace: reconcile },
        )
        if (reconcile) {
          acc.unified.reset_boundaries[window] = { ...acc.unified.reset_boundaries[window], reconciled: true }
          clearStalePreResetOfficialWindow(acc, window)
          reconciledAny = true
          resetReconciledAtMs = maxTimestamp(resetReconciledAtMs, boundaryAtMsOf(acc.unified.reset_boundaries[window]))
        }
        acc.unified.headers[window].rate_limit_type = typ || null
        if (isRej) {
          acc.unified.headers.exhausted_at = sampledAt
        }
      }
      if (info.overageStatus || info.overage_status) {
        acc.unified.overage_status = info.overageStatus || info.overage_status
      }
      acc.last_cli_rate_limit = { ...info, at: sampledAt }
    }
    acc.unified.updated_at = sampledAt
    acc.unified.source = 'claude_cli_rate_limit_event'

    const shouldCount = countRequest == null ? usageBody?.input_tokens != null : !!countRequest
    if (usageBody?.input_tokens != null) {
      acc.tokens_in += Number(usageBody.input_tokens) || 0
      acc.tokens_out += Number(usageBody.output_tokens) || 0
    }
    if (shouldCount) acc.requests += 1

    this.repo.addAllocation(accountId, {
      at: sampledAt,
      source: 'claude_cli',
      util_5h: officialWindow(acc.unified, '5h').utilization,
      util_7d: officialWindow(acc.unified, '7d').utilization,
      status_5h: headerWindow(acc.unified, '5h').status || officialWindow(acc.unified, '5h').status,
      status_7d: headerWindow(acc.unified, '7d').status || officialWindow(acc.unified, '7d').status,
      claim: acc.unified.representative_claim,
      tokens_in: usageBody?.input_tokens ?? null,
      tokens_out: usageBody?.output_tokens ?? null,
    })

    settleElapsedHeaderWindows(acc, sampledAt, nowMs)
    this._rollWindowHistory(acc, nowMs)
    const saved = this.repo.save(acc)
    if (reconciledAny && this.headerUnderSafety(saved, nowMs)) {
      this.clearQuotaExhaustedCooldown(accountId, {
        now: nowMs,
        ...(resetReconciledAtMs != null ? { resetReconciledAtMs } : {}),
      })
    }
    return saved
  }

  /**
   * Pre-flight check: can this account take another request?
   * @returns {{ ok: true } | { ok: false, reason, detail }}
   */
  policyFor(acc, { tier } = {}) {
    const quotaConfig = this.quotaConfigFor(acc)
    return {
      ...applyVmQuotaPolicy(
        resolveTierPolicy(
          {
            tiers: this.tiers,
            quota: this.config,
            concurrency: this.concurrency,
          },
          acc?.unified?.account_tier || acc?.account_tier || tier,
        ),
        this.vmQuotaOverrideFor(acc),
      ),
      // evaluateAccount reads the gate from the policy, so panel and admission share one band/overshoot.
      ...gatePolicyFields(quotaConfig),
    }
  }

  /** Global `quota` block (block switches, weekly split) with the account's VM override applied. */
  quotaConfigFor(acc) {
    return applyVmQuotaConfig(this.config, this.vmQuotaOverrideFor(acc))
  }

  vmQuotaOverrideFor(acc) {
    return acc?.vm_id ? this.vmQuota.get(acc.vm_id) || null : null
  }

  /** @param {string} vmId @param {object|null} override normalized (`vmQuotaOverrideOf`) */
  setVmQuotaOverride(vmId, override) {
    if (!vmId) return
    if (override) this.vmQuota.set(vmId, override)
    else this.vmQuota.delete(vmId)
  }

  /** Replace every VM override from `listVms` summaries (boot / backup restore). */
  loadVmQuotaOverrides(vms) {
    this.vmQuota.clear()
    for (const vm of vms || []) this.setVmQuotaOverride(vm?.id, vm?.quota_override || null)
  }

  canAccept(
    accountId,
    { tier = null, requestRisk = null, quotaRequest = null, account = undefined, now = Date.now() } = {},
  ) {
    const acc = account === undefined ? this.ensure({ account_id: accountId }) : account
    if (!acc) return { ok: false, reason: 'account_missing' }
    const policy = this.policyFor(acc, { tier })
    const ratio = Number(policy.limit_5h ?? policy.safety_ratio ?? this.config.safety_ratio ?? 0.85)
    const weeklyRatio = Number(
      policy.limit_7d ?? policy.weekly_safety_ratio ?? this.config.weekly_safety_ratio ?? ratio,
    )
    const warnRatio = Number(policy.warn_ratio ?? this.config.warn_ratio ?? 0.75)
    const quotaConfig = this.quotaConfigFor(acc)
    const inflight = this.inflight.get(accountId) || 0
    const gate = quotaGateOf(quotaConfig)
    const band = gate.band

    const limit = this.limitFor(acc, policy)
    if (inflight >= limit) {
      return {
        ok: false,
        reason: 'concurrency_limit',
        detail: { inflight, max: limit, source: 'gateway' },
      }
    }

    if (quotaConfig.block_on_5h && headerHardBlocked(acc.unified, '5h', now)) {
      const h5 = headerWindow(acc.unified, '5h')
      acc.last_blocked = { at: new Date().toISOString(), window: '5h', status: h5.status, source: 'headers' }
      if (account === undefined) this.repo.save(acc)
      return {
        ok: false,
        reason: 'quota_5h_cli',
        detail: {
          status: h5.status,
          reset: h5.reset,
          message: `Rate-limit header blocked 5h (${h5.status})`,
        },
      }
    }
    if (quotaConfig.block_on_7d && headerHardBlocked(acc.unified, '7d', now)) {
      const h7 = headerWindow(acc.unified, '7d')
      acc.last_blocked = { at: new Date().toISOString(), window: '7d', status: h7.status, source: 'headers' }
      if (account === undefined) this.repo.save(acc)
      return {
        ok: false,
        reason: 'quota_7d_cli',
        detail: {
          status: h7.status,
          reset: h7.reset,
          message: `Rate-limit header blocked 7d (${h7.status})`,
        },
      }
    }

    const w5 = headerWindowOrEmpty(acc.unified, '5h', { now })
    const w7 = headerWindowOrEmpty(acc.unified, '7d', { now })
    const u5 = asUtilRatio(w5.utilization)
    const u7 = asUtilRatio(w7.utilization)
    const z5 = quotaConfig.block_on_5h ? gateZone(u5, ratio, gate) : GATE_OPEN
    const z7 = quotaConfig.block_on_7d ? gateZone(u7, weeklyRatio, gate) : GATE_OPEN

    if (z5 === GATE_GATED) {
      acc.last_blocked = { at: new Date().toISOString(), window: '5h', utilization: u5, status: w5.status }
      if (account === undefined) this.repo.save(acc)
      return {
        ok: false,
        reason: 'quota_5h_safety',
        detail: {
          utilization: u5,
          safety_ratio: ratio,
          limit_5h: ratio,
          gate_overshoot: gate.overshoot,
          inflight,
          reset: w5.reset,
          message: `5h usage ${(u5 * 100).toFixed(1)}% ≥ safety ${(ratio * 100).toFixed(0)}% + ${(gate.overshoot * 100).toFixed(0)}% overshoot; request blocked to protect quota`,
        },
      }
    }

    if (z7 === GATE_GATED) {
      acc.last_blocked = { at: new Date().toISOString(), window: '7d', utilization: u7, status: w7.status }
      if (account === undefined) this.repo.save(acc)
      return {
        ok: false,
        reason: 'quota_7d_safety',
        detail: {
          utilization: u7,
          safety_ratio: weeklyRatio,
          weekly_safety_ratio: weeklyRatio,
          limit_7d: weeklyRatio,
          gate_overshoot: gate.overshoot,
          inflight,
          reset: w7.reset,
          message: `7d usage ${(u7 * 100).toFixed(1)}% ≥ weekly ${(weeklyRatio * 100).toFixed(0)}% + ${(gate.overshoot * 100).toFixed(0)}% overshoot; request blocked to protect weekly quota`,
        },
      }
    }

    const in5 = z5 === GATE_DRAINING
    const in7 = z7 === GATE_DRAINING
    // The header reading predates calls already in flight: near the line, one call
    // at a time. This is a wait on this account (the scheduler keeps the seat
    // here), not a reason to leave it.
    if (inflight > 0 && (in5 || in7)) {
      return {
        ok: false,
        reason: 'quota_band_inflight',
        detail: {
          window: in5 ? '5h' : '7d',
          utilization_5h: u5,
          utilization_7d: u7,
          limit_5h: ratio,
          limit_7d: weeklyRatio,
          band,
          gate_overshoot: gate.overshoot,
          inflight,
        },
      }
    }

    const rpmLimit = this.rpmLimitFor(acc, policy)
    if (rpmLimit > 0) {
      const rpm = this._rpmCount(accountId)
      if (rpm.n >= rpmLimit) {
        return {
          ok: false,
          reason: 'rpm_limit',
          detail: { current: rpm.n, max: rpmLimit, reset_at: rpm.resetAt, source: 'gateway' },
        }
      }
    }
    const stale = this.staleSettled.get(accountId) || 0
    if (guardLargeColdEnabled(quotaConfig) && (in5 || in7)) {
      const risk = resolveRequestRisk({ requestRisk, quotaRequest }, accountId, quotaConfig)
      const tooLarge = this._requestTooLargeInBand({ quotaConfig, risk, stale })
      if (tooLarge) {
        return {
          ok: false,
          reason: 'quota_guard_request_too_large',
          detail: {
            utilization_5h: u5,
            utilization_7d: u7,
            limit_5h: ratio,
            limit_7d: weeklyRatio,
            gate_overshoot: gate.overshoot,
            stale_settled: stale,
            inflight,
            estimated_prompt_tokens: risk?.estimatedPromptTokens ?? null,
            uncached_tokens: risk?.uncachedTokens ?? null,
            cold: risk?.cold ?? null,
            cold_reason: risk?.coldReason ?? null,
            reset_5h: w5.reset,
            reset_7d: w7.reset,
            message:
              '临近额度闸线，本请求预估未命中缓存过大。请缩短上下文、等待窗口重置，或改用其他模型。Near the quota safety line, this large uncached request is not eligible on this account; shorten the context, wait for the window to reset, or switch to another model.',
          },
        }
      }
    }

    return { ok: true, warn_5h: u5 >= warnRatio, warn_7d: u7 >= Math.min(warnRatio, weeklyRatio) }
  }
  tryAcquire(accountId, opts = {}) {
    const acc = opts.account === undefined ? this.ensure({ account_id: accountId }) : opts.account
    if (!acc) return { ok: false, reason: 'account_missing' }
    if (!opts.skipGate) {
      const gate = this.canAccept(accountId, { ...opts, account: acc })
      if (!gate.ok) {
        if (acc.last_blocked) this.repo.save(acc)
        return gate
      }
    }
    const inflight = this.inflight.get(accountId) || 0
    const limit = this.limitFor(acc, this.policyFor(acc, { tier: opts.tier }))
    if (inflight >= limit) {
      return { ok: false, reason: 'concurrency_limit', detail: { inflight, max: limit, source: 'quota-reservation' } }
    }
    const inBand = this.gateZoneOf(accountId, { tier: opts.tier, account: acc }) === GATE_DRAINING
    const token = Symbol('quota-reservation')
    const reservations = this.reservationBand.get(accountId) || new Map()
    reservations.set(token, inBand)
    this.reservationBand.set(accountId, reservations)
    this.inflight.set(accountId, inflight + 1)
    this._rpmTouch(accountId)
    return { ok: true, release: () => this.release(accountId, token), token }
  }

  /** The `7d_oi` window limits Fable only; it does not block account scheduling. */
  fableWindowLimited(accountId, now = Date.now(), account = undefined) {
    const oi = (account === undefined ? this.repo.get(accountId) : account)?.unified?.['7d_oi']
    if (!oi) return false
    const status = String(oi.status || '').toLowerCase()
    if (status !== 'rejected' && status !== 'rate_limited') return false
    const resetMs = parseResetMs(oi.reset)
    if (Number.isFinite(resetMs) && resetMs <= now) return false
    return true
  }

  fableWindowResetAt(accountId, account = undefined) {
    const reset = (account === undefined ? this.repo.get(accountId) : account)?.unified?.['7d_oi']?.reset
    if (!reset) return null
    const ms = parseResetMs(reset)
    return Number.isFinite(ms) ? ms : null
  }

  /** Experimental 50/50 weekly split. Off unless quota.weekly_split.enabled (or the VM override). */
  weeklySplitOf(accountId, account = undefined) {
    const acc = account === undefined ? this.repo.get(accountId) : account
    const cfg = weeklySplitConfig(this.quotaConfigFor(acc))
    const u = acc?.unified || {}
    return computeWeeklySplit({
      enabled: cfg.enabled,
      fable_share: cfg.fable_share,
      utilization_7d: headerWindowOrEmpty(u, '7d').utilization ?? officialWindow(u, '7d').utilization,
      utilization_7d_oi: u['7d_oi']?.utilization ?? u.fable?.utilization,
      status_7d_oi: u['7d_oi']?.status,
      reset_7d_oi: u['7d_oi']?.reset,
    })
  }

  weeklySplitResetAt(accountId, kind = 'regular', account = undefined) {
    const acc = account === undefined ? this.repo.get(accountId) : account
    const key = kind === 'fable' ? '7d_oi' : '7d'
    const reset = acc?.unified?.[key]?.reset
    if (!reset) return null
    const ms = parseResetMs(reset)
    return Number.isFinite(ms) ? ms : null
  }

  acquire(accountId) {
    const n = (this.inflight.get(accountId) || 0) + 1
    this.inflight.set(accountId, n)
    return n
  }

  release(accountId, token) {
    const reservations = this.reservationBand.get(accountId)
    if (token !== undefined) {
      if (!reservations?.delete(token)) return this.inflight.get(accountId) || 0
    } else if (reservations?.size) {
      reservations.delete([...reservations.keys()].at(-1))
    }
    if (reservations && !reservations.size) this.reservationBand.delete(accountId)
    const n = Math.max(0, (this.inflight.get(accountId) || 1) - 1)
    this.inflight.set(accountId, n)
    return n
  }

  /**
   * A hop that actually ran on an in-band account: Extra may still show the
   * previous percent, so the next large request treats the reading as stale
   * until headers/official usage move.
   */
  noteBandSettled(accountId, token) {
    if (!accountId) return 0
    const reservations = this.reservationBand.get(accountId)
    const reservedInBand =
      token === undefined ? [...(reservations?.values() || [])].some(Boolean) : reservations?.get(token)
    if (!reservedInBand && !this._drainingNow(accountId)) return this.staleSettled.get(accountId) || 0
    const next = (this.staleSettled.get(accountId) || 0) + 1
    this.staleSettled.set(accountId, next)
    return next
  }

  /**
   * The stricter 5h/7d gate zone for this account (see quota-gate.mjs), with
   * the block switches applied. Used by the seat planner to place new devices.
   */
  gateZoneOf(accountId, { tier = null, account = undefined } = {}) {
    const acc = account === undefined ? this.ensure({ account_id: accountId }) : account
    const policy = this.policyFor(acc, { tier })
    const quotaConfig = this.quotaConfigFor(acc)
    const gate = quotaGateOf(quotaConfig)
    const ratio = Number(policy.limit_5h ?? policy.safety_ratio ?? this.config.safety_ratio ?? 0.85)
    const weeklyRatio = Number(
      policy.limit_7d ?? policy.weekly_safety_ratio ?? this.config.weekly_safety_ratio ?? ratio,
    )
    const u5 = asUtilRatio(headerWindowOrEmpty(acc.unified, '5h').utilization)
    const u7 = asUtilRatio(headerWindowOrEmpty(acc.unified, '7d').utilization)
    const z5 = quotaConfig.block_on_5h ? gateZone(u5, ratio, gate) : GATE_OPEN
    const z7 = quotaConfig.block_on_7d ? gateZone(u7, weeklyRatio, gate) : GATE_OPEN
    return worstGateZone(z5, z7)
  }

  _drainingNow(accountId, { tier = null } = {}) {
    return this.gateZoneOf(accountId, { tier }) === GATE_DRAINING
  }

  /** Called only for a draining account: a large cold (or stale-reading large) call is not taken here. */
  _requestTooLargeInBand({ quotaConfig, risk, stale }) {
    if (!guardLargeColdEnabled(quotaConfig) || !risk) return false
    const threshold = largeColdThresholdOf(quotaConfig)
    const uncached = Number(risk.uncachedTokens) || 0
    const large = risk.largeCold === true || uncached >= threshold
    if (!large) return false
    const coldLarge = risk.largeCold === true || (risk.cold !== false && uncached >= threshold)
    const staleLarge = stale > 0 && large
    return coldLarge || staleLarge
  }

  _observeUtil(accountId, { u5 = null, u7 = null, source = 'headers' } = {}) {
    if (!accountId) return
    const next5 = u5 == null ? null : asUtilRatio(u5)
    const next7 = u7 == null ? null : asUtilRatio(u7)
    const prev = this.observedUtil.get(accountId)
    this.observedUtil.set(accountId, { u5: next5, u7: next7, source })
    if (!prev) return
    const progressed =
      (next5 != null && prev.u5 != null && next5 > prev.u5 + 0.001) ||
      (next7 != null && prev.u7 != null && next7 > prev.u7 + 0.001)
    const reset =
      (next5 != null && prev.u5 != null && next5 + 0.02 < prev.u5) ||
      (next7 != null && prev.u7 != null && next7 + 0.02 < prev.u7)
    if (source === 'official' || progressed || reset) this.staleSettled.set(accountId, 0)
  }

  /**
   * Write effective 5h/7d windows back to SQLite when a reset has elapsed
   * or last_used proves a probe-source 100% is leftover from the previous window.
   */
  persistEffectiveWindows(accountId, { now = Date.now() } = {}) {
    if (!accountId) return null
    const acc = this.repo.get(accountId)
    if (!acc?.unified) return acc || null
    const backoffExpired = expireUsageProbeBackoff(acc, now)
    const lastUsedAt = this._lastUsedAt(accountId)
    const next = applyEffectiveWindows(acc.unified, {
      now,
      lastUsedAt,
      source: acc.unified.source || 'vm-oauth-usage',
    })
    const prev5 = officialWindow(acc.unified, '5h')
    const prev7 = officialWindow(acc.unified, '7d')
    const n5 = next['5h'] || {}
    const n7 = next['7d'] || {}
    const changed =
      (n5.stale &&
        (Number(prev5.utilization) !== Number(n5.utilization) ||
          String(prev5.status || '') !== String(n5.status || ''))) ||
      (n7.stale &&
        (Number(prev7.utilization) !== Number(n7.utilization) ||
          String(prev7.status || '') !== String(n7.status || '')))
    let wiped = wipeElapsedHeaderWindows(acc.unified, { now })
    const leftover = leftoverClearHeaderWindows(
      wiped.changed ? { ...acc.unified, headers: wiped.headers } : acc.unified,
      {
        now,
        lastUsedAt,
      },
    )
    if (leftover.changed) wiped = leftover
    if (!changed && !wiped.changed) {
      const healed = healOfficialOverwriteExtra(acc, accountId, this.repo, now)
      if (!healed) {
        if (backoffExpired) this.repo.save(acc)
        if (this.headerUnderSafety(acc, now)) this.clearQuotaExhaustedCooldown(accountId, { now })
        return acc
      }
    } else {
      acc.unified = next
      if (wiped.changed) {
        if (wiped.headers) acc.unified.headers = wiped.headers
        if (wiped.oi != null) acc.unified['7d_oi'] = wiped.oi
      }
      if (changed) {
        writeOfficialWindow(acc, '5h', n5)
        writeOfficialWindow(acc, '7d', n7)
      }
      healOfficialOverwriteExtra(acc, accountId, this.repo, now)
    }
    acc.unified.updated_at = new Date().toISOString()
    const saved = this.repo.save(acc)
    this._writeSessionWindow(saved)
    if (this.headerUnderSafety(saved, now)) this.clearQuotaExhaustedCooldown(accountId, { now })
    return saved
  }

  officialUnderSafety(acc) {
    return this.headerUnderSafety(acc)
  }

  headerUnderSafety(acc, now = Date.now()) {
    if (!acc?.unified) return false
    if (headerHardBlocked(acc.unified, '5h', now) || headerHardBlocked(acc.unified, '7d', now)) return false
    const policy = this.policyFor(acc)
    const ratio = Number(policy.limit_5h ?? policy.safety_ratio ?? 0.85)
    const weeklyRatio = Number(policy.limit_7d ?? policy.weekly_safety_ratio ?? 0.8)
    const w5 = headerWindowOrEmpty(acc.unified, '5h', { now })
    const w7 = headerWindowOrEmpty(acc.unified, '7d', { now })
    const u5 = officialUtilToExtra(w5.utilization) || 0
    const u7 = officialUtilToExtra(w7.utilization) || 0
    if (u5 >= 1 || u5 >= ratio) return false
    if (u7 >= 1 || u7 >= weeklyRatio) return false
    return true
  }

  clearQuotaExhaustedCooldown(
    accountId,
    { now = Date.now(), resetReconciledAtMs = null, activeCalibratedBeforeMs = null } = {},
  ) {
    if (!accountId || !this.runtimeRepo) return false
    let state = null
    try {
      state = this.runtimeRepo.get?.(accountId)
    } catch {
      return false
    }
    if (!state) return false
    const nowMs = parseTimestampMs(now) ?? Date.now()
    // Live 529 overload belongs to RateLimitService; never clear it here.
    if (Number(state.overload_until) > nowMs) return false
    const rateLimitedFuture = Number(state.rate_limit_reset_at) > nowMs
    const reconciledAt = parseTimestampMs(resetReconciledAtMs)
    const calibratedBefore = parseTimestampMs(activeCalibratedBeforeMs)
    const rateLimitedAt = parseTimestampMs(state.rate_limited_at)
    if (reconciledAt != null && rateLimitedAt != null && rateLimitedAt > reconciledAt) return false
    if (calibratedBefore != null && rateLimitedAt != null && rateLimitedAt >= calibratedBefore) return false
    const canClearPreResetRateLimit =
      rateLimitedFuture && reconciledAt != null && rateLimitedAt != null && rateLimitedAt <= reconciledAt
    const canClearPreCalibrationRateLimit =
      rateLimitedFuture && calibratedBefore != null && (rateLimitedAt == null || rateLimitedAt < calibratedBefore)
    const canLiftRateLimit = canClearPreResetRateLimit || canClearPreCalibrationRateLimit
    // Live 429 columns belong to RateLimitService; passive Extra never lifts them
    // unless a confirmed reset boundary (at >= rate_limited_at) or validated active
    // calibration (started after rate_limited_at) was just reconciled.
    if (rateLimitedFuture && !canLiftRateLimit) return false
    const reason = String(state.cooldown_reason || '')
    const quotaCool = !reason || /quota|account_quota_exhausted|rate_limited/i.test(reason)
    if (!quotaCool) return false
    if (!state.cooldown_until && !reason && !canLiftRateLimit) return false
    try {
      this.runtimeRepo.upsert?.({
        ...state,
        status: 'ready',
        cooldown_until: null,
        cooldown_reason: null,
        rate_limit_reset_at: null,
        ...(canLiftRateLimit && state.session_window_status === 'rejected' ? { session_window_status: 'allowed' } : {}),
      })
    } catch {
      return false
    }
    try {
      this.onQuotaCooldownCleared?.(accountId)
    } catch {}
    return true
  }

  _latestActivityAtMs(accountId) {
    let latest = null
    try {
      const ms = Number(this.runtimeRepo?.get?.(accountId)?.last_used_at)
      if (Number.isFinite(ms) && ms > 0) latest = maxTimestamp(latest, ms)
    } catch {}
    try {
      const row = this.repo.recentAllocations?.(accountId, 1)?.[0]
      const parsed = parseTimestampMs(row?.at)
      if (parsed != null && parsed > 0) latest = maxTimestamp(latest, parsed)
    } catch {}
    return latest
  }

  _lastUsedAt(accountId) {
    try {
      const ms = Number(this.runtimeRepo?.get(accountId)?.last_used_at)
      if (Number.isFinite(ms) && ms > 0) return ms
    } catch {}
    try {
      const row = this.repo.recentAllocations(accountId, 1)?.[0]
      if (!row?.at) return null
      const parsed = Date.parse(row.at)
      return Number.isFinite(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  snapshot({ now = Date.now() } = {}) {
    const def = this.tiers?.default || {}
    return {
      safety_ratio: def.limit_5h ?? def.safety_ratio ?? this.config.safety_ratio,
      weekly_safety_ratio: def.limit_7d ?? def.weekly_safety_ratio ?? this.config.weekly_safety_ratio,
      tiers: this.tiers,
      accounts: this.repo.list().map((a) => {
        const lastUsedAt = this._lastUsedAt(a.account_id)
        const rpm = this._rpmCount(a.account_id, now)
        const official = applyEffectiveWindows(a.unified, { now, lastUsedAt, source: a.unified?.source })
        const listed = listQuotaFromHeaders(a.unified, { now })
        return {
          account_id: a.account_id,
          vm_id: a.vm_id,
          email: a.email,
          inflight: this.inflight.get(a.account_id) || 0,
          max_concurrency: a.max_concurrency,
          rpm: rpm.n,
          max_rpm: a.max_rpm ?? 0,
          rpm_reset_at: rpm.resetAt,
          requests: a.requests,
          tokens_in: a.tokens_in,
          tokens_out: a.tokens_out,
          cache_read_tokens: a.cache_read_tokens || 0,
          cache_creation_tokens: a.cache_creation_tokens || 0,
          last_used_at: lastUsedAt,
          unified: {
            ...official,
            '5h': listed.utilization_5h != null || listed.status_5h ? listed['5h'] : official['5h'],
            '7d': listed.utilization_7d != null || listed.status_7d ? listed['7d'] : official['7d'],
          },
          last_blocked: a.last_blocked,
          window_history: a.window_history || null,
          recent_allocations: this.repo.recentAllocations(a.account_id, 5),
        }
      }),
    }
  }

  reloadConfig(config) {
    if (config?.quota) this.config = config.quota
    if (config?.concurrency) this.concurrency = config.concurrency
    this.tiers = normalizeTiers(config?.tiers, this.config, this.concurrency)
  }

  defaultMax() {
    const n = Number(
      this.concurrency?.default_max_per_account ??
        this.concurrency?.default_key_concurrency ??
        this.tiers?.default?.max_concurrency ??
        2,
    )
    return Number.isFinite(n) && n >= 0 ? n : 2
  }

  /** 0 = reject. Manual pin uses the stored cap; otherwise the live tier. */
  limitFor(acc, policy = null) {
    if (acc?.concurrency_override) {
      const n = Number(acc.max_concurrency)
      if (Number.isFinite(n) && n >= 0) return n
    }
    const fromPolicy = Number((policy || this.policyFor(acc))?.max_concurrency)
    if (Number.isFinite(fromPolicy) && fromPolicy >= 0) return fromPolicy
    const n = Number(acc?.max_concurrency)
    if (Number.isFinite(n) && n >= 0) return n
    return this.defaultMax()
  }

  defaultRpm() {
    const n = Number(this.concurrency?.default_max_rpm ?? this.tiers?.default?.max_rpm ?? 0)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }

  /** 0 = unlimited. Manual pin uses the stored cap; otherwise the live tier. */
  rpmLimitFor(acc, policy = null) {
    if (acc?.rpm_override) {
      const n = Number(acc?.max_rpm)
      return Number.isFinite(n) && n >= 0 ? n : 0
    }
    const fromPolicy = Number((policy || this.policyFor(acc))?.max_rpm)
    if (Number.isFinite(fromPolicy) && fromPolicy >= 0) return fromPolicy
    return this.defaultRpm()
  }

  _rpmCount(accountId, now = Date.now()) {
    const windowMs = 60_000
    let arr = this.rpmBuckets.get(accountId) || []
    arr = arr.filter((t) => now - t < windowMs)
    this.rpmBuckets.set(accountId, arr)
    const oldest = arr.length ? arr[0] : 0
    return { n: arr.length, resetAt: oldest ? oldest + windowMs : null }
  }

  _rpmTouch(accountId, now = Date.now()) {
    const arr = this.rpmBuckets.get(accountId) || []
    arr.push(now)
    this.rpmBuckets.set(accountId, arr)
    return arr.length
  }

  rebindToVm(accountUuid, vmId, { email = null } = {}) {
    if (!accountUuid || !vmId) return null
    const acc = this.ensure({ account_id: accountUuid, vm_id: vmId, email })
    if (!acc) return null
    if (acc.vm_id !== vmId || (email && acc.email !== email)) {
      acc.vm_id = vmId
      if (email) acc.email = email
      return this.repo.save(acc)
    }
    return acc
  }

  /**
   * A successful OAuth refresh proves the grant is live.
   * Drop leftover Fable / last_probe revoke strings so the panel resyncs.
   */
  clearGrantRevokeLeftover(accountId) {
    if (!accountId) return null
    const acc = this.repo.get(accountId)
    if (!acc) return null
    const revoke =
      /access token has been revoked|token has been revoked|token_revoked|invalidated oauth token|oauth_revoked/i
    const u = acc.unified || {}
    const lp = u.last_probe || acc.last_probe || null
    const fb = u.fable || null
    let changed = false
    if (lp && revoke.test(String(lp.error || lp.message || ''))) {
      acc.last_probe = { ...lp, ok: true, error: null }
      u.last_probe = acc.last_probe
      changed = true
    }
    if (fb && (fb.banned || revoke.test(String(fb.error || '')))) {
      u.fable = {
        ...fb,
        banned: false,
        plan_denied: revoke.test(String(fb.error || '')) ? false : !!fb.plan_denied,
        error: revoke.test(String(fb.error || '')) ? null : fb.error || null,
      }
      changed = true
    }
    if (!changed) return acc
    acc.unified = u
    acc.unified.updated_at = new Date().toISOString()
    return this.repo.save(acc)
  }

  setAccountTier(accountId, tier, { source = null } = {}) {
    const key = String(tier || '').toLowerCase()
    if (!accountId || (key !== 'pro' && key !== 'max')) return null
    const acc = this.repo.get(accountId)
    if (!acc) return null
    if (acc.unified?.account_tier_source === 'profile' && source !== 'profile' && source !== 'usage') return acc
    if (acc.unified?.account_tier === key && (acc.unified?.account_tier_source || null) === source) return acc
    acc.unified = acc.unified || {}
    acc.unified.account_tier = key
    acc.unified.account_tier_source = source
    acc.unified.updated_at = new Date().toISOString()
    return this.repo.save(acc)
  }

  markModelUnsupported(accountId, model, durationMs = 60 * 60_000) {
    const key = resolvePolicyModelId(model) || String(model || '').trim()
    if (!accountId || !key) return null
    const acc = this.repo.get(accountId)
    if (!acc) return null
    acc.unified = acc.unified || {}
    acc.unified.model_denied_until = {
      ...(acc.unified.model_denied_until || {}),
      [key]: Date.now() + durationMs,
    }
    acc.unified.updated_at = new Date().toISOString()
    return this.repo.save(acc)
  }

  /**
   * Upstream said this account needs usage credits for Fable. Keep Fable off
   * the seat for a while (other models still route) and leave a marker the
   * panel shows instead of 未探测. The marker sits outside `unified.fable`
   * because a Pro usage probe deletes that object. A later Fable success on
   * the account clears both via clearModelUnsupported.
   */
  markFableCreditsRequired(accountId, model, durationMs = FABLE_CREDITS_DENY_MS) {
    const key = fableModelKey(model)
    if (!accountId || !key) return null
    const acc = this.repo.get(accountId)
    if (!acc) return null
    const now = Date.now()
    acc.unified = acc.unified || {}
    setFableCreditsRequired(acc.unified, key, now, durationMs)
    acc.unified.updated_at = new Date(now).toISOString()
    return this.repo.save(acc)
  }

  clearModelUnsupported(accountId, model) {
    const key = resolvePolicyModelId(model) || String(model || '').trim()
    if (!accountId || !key) return null
    const acc = this.repo.get(accountId)
    if (!acc?.unified?.model_denied_until?.[key]) return acc
    clearFableCreditsRequired(acc.unified, key)
    acc.unified.updated_at = new Date().toISOString()
    return this.repo.save(acc)
  }

  setMaxConcurrency(accountId, n, { override = false } = {}) {
    const acc = this.ensure({ account_id: accountId })
    if (!acc) return null
    acc.max_concurrency = Math.max(0, Math.min(256, Number(n) || 0))
    acc.concurrency_override = override ? 1 : 0
    return this.repo.save(acc)
  }

  setMaxConcurrencyForVm(vmId, n) {
    const v = Math.max(0, Math.min(256, Number(n) || 0))
    const out = []
    for (const a of this.repo.list()) {
      if (a.vm_id === vmId || a.account_id === vmId) {
        a.max_concurrency = v
        out.push(this.repo.save(a))
      }
    }
    if (!out.length) out.push(this.setMaxConcurrency(vmId, v))
    return out
  }

  applyDefaultConcurrency(n, { skipIds } = {}) {
    const v = Math.max(0, Math.min(256, Number(n) || 0))
    const skip = new Set(skipIds || [])
    const out = []
    for (const a of this.repo.list()) {
      if (skip.has(a.account_id) || skip.has(a.vm_id)) continue
      a.max_concurrency = v
      out.push(this.repo.save(a))
    }
    return out
  }

  setMaxRpm(accountId, n, { override = false } = {}) {
    const acc = this.ensure({ account_id: accountId })
    if (!acc) return null
    acc.max_rpm = Math.max(0, Math.min(1e6, Number(n) || 0))
    acc.rpm_override = override ? 1 : 0
    return this.repo.save(acc)
  }

  setMaxRpmForVm(vmId, n, { override = false } = {}) {
    const v = Math.max(0, Math.min(1e6, Number(n) || 0))
    const out = []
    for (const a of this.repo.list()) {
      if (a.vm_id === vmId || a.account_id === vmId) {
        a.max_rpm = v
        a.rpm_override = override ? 1 : 0
        out.push(this.repo.save(a))
      }
    }
    if (!out.length) out.push(this.setMaxRpm(vmId, v, { override }))
    return out
  }

  applyTierRpm(tiers, { skipIds } = {}) {
    const policies = normalizeTiers(tiers, this.config, this.concurrency)
    const skip = new Set(skipIds || [])
    const out = []
    for (const a of this.repo.list()) {
      if (skip.has(a.account_id) || skip.has(a.vm_id) || a.rpm_override) continue
      const key = accountTierKey(a)
      const v = Math.max(0, Math.min(1e6, Number(policies[key]?.max_rpm) || 0))
      if (Number(a.max_rpm) === v) continue
      a.max_rpm = v
      out.push(this.repo.save(a))
    }
    return out
  }

  applyTierConcurrency(tiers, { skipIds } = {}) {
    const policies = normalizeTiers(tiers, this.config, this.concurrency)
    const skip = new Set(skipIds || [])
    const out = []
    for (const a of this.repo.list()) {
      if (skip.has(a.account_id) || skip.has(a.vm_id) || a.concurrency_override) continue
      const key = accountTierKey(a)
      const v = Math.max(0, Math.min(256, Number(policies[key]?.max_concurrency) || 2))
      if (Number(a.max_concurrency) === v) continue
      a.max_concurrency = v
      a.concurrency_override = 0
      out.push(this.repo.save(a))
    }
    return out
  }

  nearLimit(acc, opts) {
    return isNearLimit(acc, this.policyFor(acc), opts)
  }
}

function normalizeHeaders(headers) {
  if (!headers) return {}
  if (typeof headers.forEach === 'function') {
    const o = {}
    headers.forEach((v, k) => {
      o[String(k).toLowerCase()] = v
    })
    return o
  }
  const o = {}
  for (const [k, v] of Object.entries(headers)) o[String(k).toLowerCase()] = v
  return o
}

function num(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Header samples are 0–1; a leftover official reading can still be 0–100. */
function asUtilRatio(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return n > 1.5 ? n / 100 : n
}

function isUnifiedRejected(h = {}) {
  const s5 = String(h['anthropic-ratelimit-unified-5h-status'] || '').toLowerCase()
  const s7 = String(h['anthropic-ratelimit-unified-7d-status'] || '').toLowerCase()
  return s5 === 'rejected' || s5 === 'rate_limited' || s7 === 'rejected' || s7 === 'rate_limited'
}

/**
 * Merge one reading into an Extra window. Each window keeps its own `sampled_at`:
 * a response that names only 7d must not make the 5h number look freshly read.
 * A stored window whose reset already passed has ended, so none of its values
 * carry into the new reading.
 */
function parseTimestampMs(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

function boundaryAtMsOf(boundary) {
  return parseTimestampMs(boundary?.at_ms ?? boundary?.at)
}

function maxTimestamp(current, next) {
  if (next == null) return current
  return current == null ? next : Math.max(current, next)
}

function clearStalePreResetOfficialWindow(acc, key) {
  if (!acc?.unified) return
  const next = acc.unified.headers?.[key]
  if (!next || officialLooksLimited(next)) return
  const replacement = {
    utilization: next.utilization ?? 0,
    reset: next.reset || null,
    status: next.status || 'allowed',
  }
  if (acc.unified.official?.[key] && officialLooksLimited(acc.unified.official[key])) {
    acc.unified.official[key] = { ...replacement }
  }
  if (acc.unified[key] && officialLooksLimited(acc.unified[key])) {
    acc.unified[key] = { ...replacement }
  }
}

function checkResetWindowWrite(
  acc,
  key,
  { resetGenerations = null, startedAtMs = null, probedAtMs = null, allowProbedAtFallback = false } = {},
) {
  const boundary = acc?.unified?.reset_boundaries?.[key] || null
  if (!boundary) {
    return { allowed: true, postReset: false, boundary: null, pendingReset: false, reason: null }
  }
  const boundaryGen = Number(boundary.generation) || 0
  const boundaryAtMs = parseTimestampMs(boundary.at_ms ?? boundary.at)
  const hasGen = resetGenerations != null && typeof resetGenerations === 'object'
  const hasStart = Number.isFinite(startedAtMs)
  const hasProbed = allowProbedAtFallback && Number.isFinite(probedAtMs)
  if (hasGen) {
    const capturedGen = Number(resetGenerations[key] ?? 0)
    if (capturedGen < boundaryGen) {
      return {
        allowed: false,
        postReset: false,
        boundary,
        pendingReset: boundary.reconciled !== true,
        reason: 'pre_reset_generation',
      }
    }
  }
  if (hasStart && boundaryAtMs != null && startedAtMs < boundaryAtMs) {
    return {
      allowed: false,
      postReset: false,
      boundary,
      pendingReset: boundary.reconciled !== true,
      reason: 'pre_reset_started_at',
    }
  }
  if (hasProbed && boundaryAtMs != null && probedAtMs < boundaryAtMs) {
    return {
      allowed: false,
      postReset: false,
      boundary,
      pendingReset: boundary.reconciled !== true,
      reason: 'pre_reset_probed_at',
    }
  }
  if (!hasGen && !hasStart && !hasProbed) {
    return {
      allowed: false,
      postReset: false,
      boundary,
      pendingReset: boundary.reconciled !== true,
      reason: 'missing_reset_timing',
    }
  }
  return {
    allowed: true,
    postReset: true,
    boundary,
    pendingReset: boundary.reconciled !== true,
    reason: null,
  }
}

function writeHeaderWindow(acc, key, incoming = {}, { now = Date.now(), replace = false } = {}) {
  acc.unified.headers = acc.unified.headers || {}
  const stored = replace ? {} : acc.unified.headers[key] || {}
  const cur = replace || parseResetMs(stored.reset) <= now ? {} : stored
  const next = {
    utilization: incoming.utilization != null ? incoming.utilization : (cur.utilization ?? null),
    reset: incoming.reset || incoming.resets_at || cur.reset || null,
    status: incoming.status || cur.status || null,
  }
  if (incoming.rate_limit_type || stored.rate_limit_type) {
    next.rate_limit_type = incoming.rate_limit_type || stored.rate_limit_type
  }
  const sampledAt = incoming.sampled_at || cur.sampled_at
  if (sampledAt) next.sampled_at = sampledAt
  acc.unified.headers[key] = next
}

/**
 * A 5h/7d window this write did not read again, whose reset has passed, is
 * stored as stale now (as `persistEffectiveWindows` would later), instead of
 * keeping the last window's numbers beside fresher ones.
 */
function settleElapsedHeaderWindows(acc, sampledAt, now = Date.now()) {
  const headers = acc?.unified?.headers
  if (!headers) return
  for (const key of ['5h', '7d']) {
    const window = headers[key]
    if (!window || window.stale || (sampledAt && window.sampled_at === sampledAt)) continue
    const wiped = wipeElapsedWindow(window, now)
    if (wiped) headers[key] = wiped
  }
}

function officialUtilToExtra(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return n > 1.5 ? n / 100 : n
}

function officialLooksLimited(window = {}) {
  const raw = window.utilization
  const ratio = officialUtilToExtra(raw)
  const percent = Number(raw) > 1.5
  if (percent && ratio != null && ratio < 1) return false
  const s = String(window.status || '').toLowerCase()
  if (s === 'rejected' || s === 'rate_limited') return true
  return ratio != null && ratio >= 1
}

function officialLooksOpen(window = {}) {
  return !officialLooksLimited(window)
}

function shouldCopyOfficialToExtra(official, extra, now = Date.now()) {
  if (!official || (official.utilization == null && !official.status && !official.reset && !official.resets_at)) {
    return false
  }
  if (extraIsLiveOpen(extra, now)) {
    if (officialLooksLimited(official)) return false
    const ou = officialUtilToExtra(official.utilization)
    const eu = Number(extra.utilization)
    if (Number.isFinite(ou) && Number.isFinite(eu) && ou <= 0.15 && eu >= 0.4) return false
    return true
  }
  const extraResetMs = parseResetMs(extra?.reset)
  const extraElapsed = Number.isFinite(extraResetMs) && extraResetMs <= now
  if (!extra || (extra.utilization == null && !extra.status && !extra.reset)) return true
  if (extraElapsed) return officialLooksOpen(official)
  if (officialLooksLimited(extra) && officialLooksOpen(official)) return true
  return false
}

function existingWindowSampledAtMs(unified, key) {
  const headers = unified?.headers
  if (!headers) return null
  if (key !== '7d_oi') {
    const own = parseTimestampMs(headers[key]?.sampled_at)
    if (own != null) return own
    const otherKey = key === '5h' ? '7d' : '5h'
    const shared = parseTimestampMs(headers.sampled_at)
    const other = parseTimestampMs(headers[otherKey]?.sampled_at)
    if (shared != null && (other == null || other !== shared)) return shared
    return null
  }
  return parseTimestampMs(headers['7d_oi']?.sampled_at ?? unified?.['7d_oi']?.sampled_at ?? headers.sampled_at)
}

function buildRetainedWindow(
  key,
  reason,
  { ou = null, eu = null, at = null, headerSampledAt = null, settleRemainingMs = 0 } = {},
) {
  return {
    window: key,
    reason,
    official_utilization: ou,
    retained_utilization: eu,
    official_updated_at: at,
    header_sampled_at: headerSampledAt,
    settle_remaining_ms: reason === 'settle_window' ? Math.max(1, Math.round(settleRemainingMs)) : 0,
  }
}

/**
 * Official /usage writes Extra only when Extra is empty, elapsed, or leftover rejected,
 * or when an explicit active calibration satisfies all monotonic/idle/settle guards.
 * Only what it copies counts as sampled at the probe time.
 */
function syncActiveToPassive(
  acc,
  sampledAt,
  {
    now = Date.now(),
    freshWindows = null,
    checks = null,
    activeCalibration = false,
    forceReconcile = false,
    probeStartedAtMs = null,
    officialUpdatedAtMs = null,
    inflightCount = 0,
    latestActivityAtMs = null,
    incomingWindows = null,
    hasFableProbe = false,
  } = {},
) {
  acc.unified.headers = acc.unified.headers || {}
  const at = sampledAt || new Date(now).toISOString()
  let copied = false
  let reconciledAny = false
  let calibratedAny = false
  let resetReconciledAtMs = null
  const reconciledWindows = []
  const retainedWindows = []
  const blockedWindows = new Set()

  for (const key of ['5h', '7d']) {
    const check = checks?.[key] || null
    const extra = acc.unified.headers[key]
    const eu = extra?.utilization != null ? officialUtilToExtra(extra.utilization) : null
    if (check && !check.allowed) {
      blockedWindows.add(key)
      if (activeCalibration) {
        const incomingParsed = applyOfficialWindow(incomingWindows?.[key] || {})
        if (incomingParsed?.utilization != null && extra && eu !== incomingParsed.utilization) {
          retainedWindows.push(
            buildRetainedWindow(key, 'reset_boundary', {
              ou: incomingParsed.utilization,
              eu,
              at,
              headerSampledAt: extra?.sampled_at || null,
            }),
          )
        }
      }
      continue
    }
    if (freshWindows && !freshWindows[key]) continue
    const src = acc.unified.official?.[key] || acc.unified[key]
    const ou = officialUtilToExtra(src?.utilization)
    const officialReset = src?.reset || src?.resets_at || null
    const pendingReset = check?.pendingReset === true
    if (pendingReset) {
      const hasFreshValue = (!freshWindows || freshWindows[key] === true) && ou != null
      if (!hasFreshValue || !shouldCopyOfficialToExtra(src, null, now)) continue
      if (activeCalibration) {
        if (inflightCount > 0) {
          blockedWindows.add(key)
          retainedWindows.push(
            buildRetainedWindow(key, 'inflight', { ou, eu, at, headerSampledAt: extra?.sampled_at || null }),
          )
          continue
        }
        if (
          !Number.isFinite(probeStartedAtMs) ||
          (latestActivityAtMs != null && latestActivityAtMs >= probeStartedAtMs)
        ) {
          blockedWindows.add(key)
          retainedWindows.push(
            buildRetainedWindow(key, 'newer_headers', { ou, eu, at, headerSampledAt: extra?.sampled_at || null }),
          )
          continue
        }
      }
      writeHeaderWindow(
        acc,
        key,
        {
          utilization: ou,
          reset: officialReset || null,
          status: src.status || null,
          sampled_at: at,
        },
        { now, replace: true },
      )
      acc.unified.reset_boundaries[key] = { ...acc.unified.reset_boundaries[key], reconciled: true }
      copied = true
      reconciledAny = true
      calibratedAny = true
      reconciledWindows.push(key)
      resetReconciledAtMs = maxTimestamp(resetReconciledAtMs, boundaryAtMsOf(acc.unified.reset_boundaries[key]))
      continue
    }

    if (activeCalibration) {
      if (ou == null) {
        if (officialReset && extra && !extra.reset) writeHeaderWindow(acc, key, { reset: officialReset }, { now })
        continue
      }
      const hasExtra = Boolean(extra && (extra.utilization != null || extra.status || extra.reset))
      const extraResetMs = parseResetMs(extra?.reset)
      const extraElapsed = Number.isFinite(extraResetMs) && extraResetMs <= now
      const existingSampleMs = existingWindowSampledAtMs(acc.unified, key)
      const headerSampledIso =
        extra?.sampled_at || (existingSampleMs != null ? new Date(existingSampleMs).toISOString() : null)

      if (hasExtra && !extraElapsed && extraIsLiveOpen(extra, now) && officialLooksLimited(src)) {
        blockedWindows.add(key)
        if (eu !== ou) {
          retainedWindows.push(
            buildRetainedWindow(key, 'official_leftover_limit', {
              ou,
              eu,
              at,
              headerSampledAt: headerSampledIso,
            }),
          )
        }
        continue
      }
      if (inflightCount > 0) {
        blockedWindows.add(key)
        if (hasExtra && !extraElapsed && eu !== ou) {
          retainedWindows.push(buildRetainedWindow(key, 'inflight', { ou, eu, at, headerSampledAt: headerSampledIso }))
        }
        continue
      }
      if (
        !Number.isFinite(probeStartedAtMs) ||
        (latestActivityAtMs != null && latestActivityAtMs >= probeStartedAtMs)
      ) {
        blockedWindows.add(key)
        if (hasExtra && !extraElapsed && eu !== ou) {
          retainedWindows.push(
            buildRetainedWindow(key, 'newer_headers', { ou, eu, at, headerSampledAt: headerSampledIso }),
          )
        }
        continue
      }
      if (
        hasExtra &&
        !extraElapsed &&
        existingSampleMs != null &&
        (probeStartedAtMs <= existingSampleMs ||
          !Number.isFinite(officialUpdatedAtMs) ||
          officialUpdatedAtMs < existingSampleMs)
      ) {
        blockedWindows.add(key)
        if (eu !== ou) {
          retainedWindows.push(
            buildRetainedWindow(key, 'newer_headers', { ou, eu, at, headerSampledAt: headerSampledIso }),
          )
        }
        continue
      }
      if (hasExtra && !extraElapsed && extraIsLiveOpen(extra, now) && eu != null && ou <= 0.15 && eu >= 0.4) {
        const referenceSampleMs = maxTimestamp(existingSampleMs, latestActivityAtMs)
        if (
          !forceReconcile &&
          referenceSampleMs != null &&
          probeStartedAtMs - referenceSampleMs < ACTIVE_CALIBRATION_SETTLE_MS
        ) {
          blockedWindows.add(key)
          if (officialReset && extra && !extra.reset) writeHeaderWindow(acc, key, { reset: officialReset }, { now })
          retainedWindows.push(
            buildRetainedWindow(key, 'settle_window', {
              ou,
              eu,
              at,
              headerSampledAt: headerSampledIso || new Date(referenceSampleMs).toISOString(),
              settleRemainingMs: ACTIVE_CALIBRATION_SETTLE_MS - (probeStartedAtMs - referenceSampleMs),
            }),
          )
          continue
        }
      }
      writeHeaderWindow(
        acc,
        key,
        {
          utilization: ou,
          reset: officialReset || null,
          status: src.status || null,
          sampled_at: at,
        },
        { now, replace: true },
      )
      copied = true
      calibratedAny = true
      reconciledWindows.push(key)
      continue
    }

    if (!shouldCopyOfficialToExtra(src, extra, now)) {
      if (officialReset && extra && !extra.reset) writeHeaderWindow(acc, key, { reset: officialReset }, { now })
      continue
    }
    writeHeaderWindow(
      acc,
      key,
      {
        utilization: officialUtilToExtra(src.utilization),
        reset: officialReset || extra?.reset || null,
        status: src.status || null,
        sampled_at: at,
      },
      { now },
    )
    copied = true
    reconciledWindows.push(key)
  }

  const oiCheck = checks?.['7d_oi'] || null
  if (activeCalibration) {
    const incomingOi = incomingWindows?.['7d_oi'] || null
    const prevOi = acc.unified.headers?.['7d_oi'] || acc.unified['7d_oi'] || null
    const euOi = prevOi?.utilization != null ? officialUtilToExtra(prevOi.utilization) : null
    if (oiCheck && !oiCheck.allowed) {
      blockedWindows.add('7d_oi')
      const ouBlocked = officialUtilToExtra(incomingOi?.utilization)
      if (ouBlocked != null && prevOi && euOi !== ouBlocked) {
        retainedWindows.push(
          buildRetainedWindow('7d_oi', 'reset_boundary', {
            ou: ouBlocked,
            eu: euOi,
            at,
            headerSampledAt: prevOi?.sampled_at || null,
          }),
        )
      }
    } else if (freshWindows?.['7d_oi'] === true && incomingOi) {
      const ouOi = officialUtilToExtra(incomingOi.utilization)
      if (ouOi != null) {
        const hasPrevOi = Boolean(prevOi && (prevOi.utilization != null || prevOi.status || prevOi.reset))
        const prevOiResetMs = parseResetMs(prevOi?.reset)
        const prevOiElapsed = Number.isFinite(prevOiResetMs) && prevOiResetMs <= now
        const existingOiSampleMs = existingWindowSampledAtMs(acc.unified, '7d_oi')
        const oiHeaderIso =
          prevOi?.sampled_at || (existingOiSampleMs != null ? new Date(existingOiSampleMs).toISOString() : null)
        let oiRetainReason = null
        let oiSettleRem = 0
        if (hasPrevOi && !prevOiElapsed && extraIsLiveOpen(prevOi, now) && officialLooksLimited(incomingOi)) {
          oiRetainReason = 'official_leftover_limit'
        } else if (inflightCount > 0) {
          oiRetainReason = 'inflight'
        } else if (
          !Number.isFinite(probeStartedAtMs) ||
          (latestActivityAtMs != null && latestActivityAtMs >= probeStartedAtMs)
        ) {
          oiRetainReason = 'newer_headers'
        } else if (
          hasPrevOi &&
          !prevOiElapsed &&
          existingOiSampleMs != null &&
          (probeStartedAtMs <= existingOiSampleMs ||
            !Number.isFinite(officialUpdatedAtMs) ||
            officialUpdatedAtMs < existingOiSampleMs)
        ) {
          oiRetainReason = 'newer_headers'
        } else if (
          !oiCheck?.pendingReset &&
          hasPrevOi &&
          !prevOiElapsed &&
          extraIsLiveOpen(prevOi, now) &&
          euOi != null &&
          ouOi <= 0.15 &&
          euOi >= 0.4
        ) {
          const refOiMs = maxTimestamp(existingOiSampleMs, latestActivityAtMs)
          if (!forceReconcile && refOiMs != null && probeStartedAtMs - refOiMs < ACTIVE_CALIBRATION_SETTLE_MS) {
            oiRetainReason = 'settle_window'
            oiSettleRem = ACTIVE_CALIBRATION_SETTLE_MS - (probeStartedAtMs - refOiMs)
          }
        }
        if (oiRetainReason) {
          blockedWindows.add('7d_oi')
          if (hasPrevOi && !prevOiElapsed && euOi !== ouOi) {
            retainedWindows.push(
              buildRetainedWindow('7d_oi', oiRetainReason, {
                ou: ouOi,
                eu: euOi,
                at,
                headerSampledAt: oiHeaderIso,
                settleRemainingMs: oiSettleRem,
              }),
            )
          }
        } else {
          const nextOi = {
            utilization: ouOi,
            reset: incomingOi.reset || null,
            status: incomingOi.status || statusFromUtil(ouOi),
            sampled_at: at,
          }
          acc.unified['7d_oi'] = { ...nextOi }
          acc.unified.headers['7d_oi'] = { ...nextOi }
          if (oiCheck?.pendingReset === true) {
            acc.unified.reset_boundaries['7d_oi'] = { ...acc.unified.reset_boundaries['7d_oi'], reconciled: true }
            reconciledAny = true
            resetReconciledAtMs = maxTimestamp(
              resetReconciledAtMs,
              boundaryAtMsOf(acc.unified.reset_boundaries['7d_oi']),
            )
          }
          if (acc.unified.fable && !hasFableProbe) {
            acc.unified.fable = {
              ...acc.unified.fable,
              limited: officialLooksLimited(nextOi),
              utilization: ouOi,
              reset: nextOi.reset,
              probed_at: at,
            }
          }
          copied = true
          calibratedAny = true
          reconciledWindows.push('7d_oi')
        }
      }
    }
  } else {
    const oi = acc.unified['7d_oi']
    if (
      (!oiCheck || oiCheck.allowed) &&
      (!freshWindows || freshWindows['7d_oi'] === true) &&
      oi &&
      (oi.utilization != null || oi.status || oi.reset)
    ) {
      const pendingOi = oiCheck?.pendingReset === true
      if (pendingOi) {
        const hasFreshOi =
          (!freshWindows || freshWindows['7d_oi'] === true) && officialUtilToExtra(oi.utilization) != null
        if (hasFreshOi) {
          acc.unified.headers['7d_oi'] = {
            utilization: officialUtilToExtra(oi.utilization),
            reset: oi.reset || null,
            status: oi.status || null,
          }
          acc.unified.reset_boundaries['7d_oi'] = { ...acc.unified.reset_boundaries['7d_oi'], reconciled: true }
          copied = true
          reconciledAny = true
          reconciledWindows.push('7d_oi')
        }
      } else {
        acc.unified.headers['7d_oi'] = {
          utilization: officialUtilToExtra(oi.utilization) ?? acc.unified.headers['7d_oi']?.utilization ?? null,
          reset: oi.reset || acc.unified.headers['7d_oi']?.reset || null,
          status: oi.status || acc.unified.headers['7d_oi']?.status || null,
        }
        copied = true
        reconciledWindows.push('7d_oi')
      }
    }
  }

  if (copied) acc.unified.headers.sampled_at = at
  if (activeCalibration && calibratedAny && acc.unified.headers.exhausted_at) {
    const exhaustedAtMs = parseTimestampMs(acc.unified.headers.exhausted_at)
    const s5 = String(acc.unified.headers['5h']?.status || '').toLowerCase()
    const s7 = String(acc.unified.headers['7d']?.status || '').toLowerCase()
    const stillRejected = s5 === 'rejected' || s5 === 'rate_limited' || s7 === 'rejected' || s7 === 'rate_limited'
    if (
      !stillRejected &&
      (exhaustedAtMs == null || (Number.isFinite(probeStartedAtMs) && exhaustedAtMs < probeStartedAtMs))
    ) {
      acc.unified.headers.exhausted_at = null
    }
  }

  const canForceReconcile = retainedWindows.length > 0 && retainedWindows.every((w) => w.reason === 'settle_window')
  const settleRemainingMs = retainedWindows.reduce((max, w) => Math.max(max, Number(w.settle_remaining_ms) || 0), 0)
  return {
    copied,
    reconciledAny,
    calibratedAny,
    resetReconciledAtMs,
    retainedWindows,
    blockedWindows,
    calibration: {
      reconciled: retainedWindows.length === 0,
      force_reconcile: forceReconcile,
      reconciled_windows: reconciledWindows,
      retained_windows: retainedWindows,
      can_force_reconcile: canForceReconcile,
      settle_remaining_ms: settleRemainingMs,
    },
  }
}

function lastHeaderAllocation(repo, accountId) {
  const rows = repo?.recentAllocations?.(accountId, 12) || []
  return rows.find((row) => row?.source === 'headers' && row.util_5h != null) || null
}

/** Drop leftover /usage 429 flags after the backoff window. */
function expireUsageProbeBackoff(acc, now = Date.now()) {
  if (!acc?.unified) return false
  const until = Date.parse(acc.unified.usage_rate_limited_until || '')
  if (Number.isFinite(until) && until > now) return false
  let changed = false
  if (acc.unified.usage_rate_limited_until) {
    delete acc.unified.usage_rate_limited_until
    changed = true
  }
  if (acc.last_probe?.rate_limited) {
    acc.last_probe = { ...acc.last_probe, rate_limited: false }
    changed = true
  }
  if (acc.unified.last_probe?.rate_limited) {
    acc.unified.last_probe = { ...acc.unified.last_probe, rate_limited: false }
    changed = true
  }
  return changed
}

/** Undo leftover official 100% that was copied onto a still-open Extra window. */
function healOfficialOverwriteExtra(acc, accountId, repo, now = Date.now()) {
  if (!acc?.unified?.headers) return false
  const extra = acc.unified.headers['5h']
  const official = officialWindow(acc.unified, '5h')
  if (!officialLooksLimited(extra) || !officialLooksLimited(official)) return false
  if (extraIsLiveOpen(extra, now)) return false
  // Only undo a value this probe copied; rows written before per-window times use the shared one.
  const sampled = extra.sampled_at || acc.unified.headers.sampled_at
  const probeAt = acc.last_probe?.at || acc.unified.last_probe?.at
  if (sampled && probeAt) {
    const sampledMs = Date.parse(sampled)
    const probeMs = Date.parse(probeAt)
    if (Number.isFinite(sampledMs) && Number.isFinite(probeMs) && Math.abs(sampledMs - probeMs) > 5000) return false
  }
  const last = lastHeaderAllocation(repo, accountId)
  const boundaryAtMs = boundaryAtMsOf(acc.unified.reset_boundaries?.['5h'])
  if (boundaryAtMs != null) {
    const lastAtMs = parseTimestampMs(last?.at)
    if (lastAtMs == null || lastAtMs < boundaryAtMs) return false
  }
  const prev = Number(last?.util_5h)
  if (!Number.isFinite(prev) || prev >= 0.95) return false
  writeHeaderWindow(
    acc,
    '5h',
    {
      utilization: prev,
      status: last.status_5h || 'allowed',
      reset: extra.reset || last.reset_5h || official.reset || null,
      sampled_at: last.at,
    },
    { now },
  )
  acc.unified.headers.exhausted_at = null
  return true
}

function applyHeaderExhausted(
  acc,
  h = {},
  sampledAt = new Date().toISOString(),
  { now = Date.now(), allowed5 = true, allowed7 = true, replace5 = false, replace7 = false } = {},
) {
  const s5 = String(h['anthropic-ratelimit-unified-5h-status'] || '').toLowerCase()
  const s7 = String(h['anthropic-ratelimit-unified-7d-status'] || '').toLowerCase()
  // Callers only pass exhausted with evidence: a window status, plan-limit
  // text, or the classifier's account_quota_exhausted. When no window is named,
  // the representative claim picks it; only a claimless proof falls back to 5h.
  const claim = String(h['anthropic-ratelimit-unified-representative-claim'] || '').toLowerCase()
  const claim7 = /^seven_day$|^7d$/.test(claim)
  const hit5 = s5 === 'rejected' || s5 === 'rate_limited'
  const hit7 = s7 === 'rejected' || s7 === 'rate_limited' || (!hit5 && claim7)
  let wrote5 = false
  let wrote7 = false
  if (hit7 && allowed7) {
    writeHeaderWindow(
      acc,
      '7d',
      {
        utilization: num(h['anthropic-ratelimit-unified-7d-utilization']),
        reset: h['anthropic-ratelimit-unified-7d-reset'],
        status: 'rejected',
        sampled_at: sampledAt,
      },
      { now, replace: replace7 },
    )
    wrote7 = true
  }
  if ((hit5 || !hit7) && allowed5) {
    writeHeaderWindow(
      acc,
      '5h',
      {
        utilization: num(h['anthropic-ratelimit-unified-5h-utilization']),
        reset: h['anthropic-ratelimit-unified-5h-reset'],
        status: 'rejected',
        sampled_at: sampledAt,
      },
      { now, replace: replace5 },
    )
    wrote5 = true
  }
  if (wrote5 || wrote7) acc.unified.headers.exhausted_at = new Date(now).toISOString()
  return { wrote5, wrote7 }
}

/** A reject without a fresh reset must not inherit last window's elapsed reset (wiped to 0 at once). */
function dropElapsedReset(acc, key, incomingReset, now = Date.now()) {
  if (incomingReset) return
  const cur = acc.unified.headers?.[key]
  if (!cur?.reset) return
  const ms = parseResetMs(cur.reset)
  if (Number.isFinite(ms) && ms <= now) acc.unified.headers[key] = { ...cur, reset: null }
}

function writeOfficialWindow(acc, key, incoming = {}, updatedAt = new Date().toISOString()) {
  const next = applyOfficialWindow(incoming)
  if (!next) return false
  acc.unified.official = acc.unified.official || {}
  acc.unified.official[key] = next
  acc.unified.official.updated_at = updatedAt
  acc.unified[key] = { ...next }
  return true
}

function officialOpen(window = {}) {
  return !officialLooksLimited(window)
}

function clearHeaderExhaustIfOfficialOpen(acc, { allowed5 = true, allowed7 = true } = {}) {
  const headers = acc.unified.headers
  if (!headers) return
  const o5 = acc.unified.official?.['5h'] || acc.unified['5h']
  const o7 = acc.unified.official?.['7d'] || acc.unified['7d']
  if (
    allowed5 &&
    officialOpen(o5) &&
    headers['5h'] &&
    ['rejected', 'rate_limited'].includes(String(headers['5h'].status || '').toLowerCase())
  ) {
    headers['5h'] = { ...headers['5h'], status: 'allowed' }
  }
  if (
    allowed7 &&
    officialOpen(o7) &&
    headers['7d'] &&
    ['rejected', 'rate_limited'].includes(String(headers['7d'].status || '').toLowerCase())
  ) {
    headers['7d'] = { ...headers['7d'], status: 'allowed' }
  }
  const s5 = String(headers['5h']?.status || '').toLowerCase()
  const s7 = String(headers['7d']?.status || '').toLowerCase()
  const stillRejected = s5 === 'rejected' || s5 === 'rate_limited' || s7 === 'rejected' || s7 === 'rate_limited'
  if (!stillRejected && officialOpen(o5) && officialOpen(o7)) headers.exhausted_at = null
}

function statusFromUtil(u) {
  const ratio = officialUtilToExtra(u) || 0
  if (ratio >= 1) return 'rate_limited'
  if (ratio >= 0.85) return 'warning'
  return 'active'
}

function windowIsFull(status, utilization) {
  const ratio = officialUtilToExtra(utilization)
  const percent = Number(utilization) > 1.5
  if (percent && ratio != null && ratio < 1) return false
  if (ratio != null && ratio >= 1) return true
  const s = String(status || '').toLowerCase()
  return s === 'rejected' || s === 'rate_limited'
}

function statusFromProbeWindow(utilization, incomingStatus) {
  const ratio = officialUtilToExtra(utilization)
  const percent = Number(utilization) > 1.5
  if (ratio != null) {
    if (ratio >= 1) return 'rejected'
    const s = String(incomingStatus || '').toLowerCase()
    if (s === 'allowed' || s === 'allowed_warning' || s === 'active') return incomingStatus
    if (percent && (s === 'rejected' || s === 'rate_limited')) return 'allowed'
    if (s === 'rejected' || s === 'rate_limited') return incomingStatus
    return statusFromUtil(ratio)
  }
  return incomingStatus || null
}

/** Official /usage overwrites the official window. Sticky 100% is cleared by reset rules. */
export function applyOfficialWindow(incoming = {}) {
  if (incoming.utilization == null && !incoming.status && !incoming.resets_at && !incoming.reset) {
    return null
  }
  const raw = incoming.utilization != null ? Number(incoming.utilization) : null
  const utilization = raw != null && Number.isFinite(raw) ? officialUtilToExtra(raw) : null
  return {
    utilization,
    reset: incoming.resets_at || incoming.reset || null,
    status: statusFromProbeWindow(raw, incoming.status) || 'allowed',
    ...(incoming.stale ? { stale: true, stale_reason: incoming.stale_reason || null } : {}),
  }
}

/** @deprecated official /usage is authoritative; kept for older tests. */
export function applyProbeWindow(existing = {}, incoming = {}) {
  return applyOfficialWindow(incoming) || existing || { utilization: 0, reset: null, status: 'active' }
}

function epochToIso(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  const ms = n < 1e12 ? n * 1000 : n
  return new Date(ms).toISOString()
}

export function isFableTransportFailure(probe = {}) {
  const fable = probe.fable || {}
  if (fable.transport) return true
  if (probe.transportError || probe.transport) return true
  const status = Number(fable.status || 0)
  const err = String(fable.error || probe.error || probe.usage_error || '')
  if (status === 0 && /SOCKS|transport|worker_error|upstream_transport|refusing SOCKS|socket/i.test(err)) return true
  return (
    (status === 502 || status === 0) &&
    /SOCKS|greeting|reset by peer|transport|worker_error|upstream_transport|refusing SOCKS/i.test(err)
  )
}
