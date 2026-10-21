/**
 * Per-account Claude usage quota tracker backed by PostgreSQL.
 *
 * Scheduling and list Extra come from Messages response headers.
 * Official GET /api/oauth/usage is a manual calibration hop that writes
 * Extra (÷100) after a cache hit/miss.
 *
 * Persistent state → `accounts` + `account_allocations` tables.
 * Transient state (inflight counters, RPM buckets) stays in memory.
 */

import { resolveStoreDb } from '../db/database.mjs'
import { addInteger } from '../db/integers.mjs'
import { accountChanges, AccountsRepo } from '../db/repos/accounts-repo.mjs'
import { WriteQueue } from './write-queue.mjs'
import { computeWeeklySplit, weeklySplitConfig } from './weekly-split.mjs'
import {
  applyEffectiveWindows,
  extraHeadersFromLimitError,
  extraIsLiveOpen,
  headerHardBlocked,
  headerWindow,
  headerWindowOrEmpty,
  leftoverClearHeaderWindows,
  listQuotaFromHeaders,
  officialWindow,
  parseResetMs,
  wipeElapsedHeaderWindows,
} from './quota-window.mjs'
import { accountTierKey, isNearLimit, normalizeTiers, resolveTierPolicy } from './quota-tiers.mjs'
import { resolvePolicyModelId } from '../protocol/model-policy.mjs'
import { SessionLimitRegistry } from './session-limit.mjs'
import { applyVmQuotaConfig, applyVmQuotaPolicy } from './vm-quota-override.mjs'
import {
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

export { extraHeadersFromLimitError }
export { estimateRequestRisk }

export class AccountQuota {
  constructor({ dataDir, db, config, accounts }) {
    this.db = resolveStoreDb({ db, dataDir })
    this.persistence = new AccountsRepo(this.db)
    this.writes = this.db.schedulingWriteQueue ||= new WriteQueue(this.db)
    this.rows = new Map()
    this.revisions = new Map()
    this.allocations = new Map()
    this.seedAccounts = accounts || []
    this.repo = this._workingSet()
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
    this.reservationBand = new Map() // accountId → boolean[] (in-band at acquire)
    this.sessions = config?.sessions instanceof SessionLimitRegistry ? config.sessions : new SessionLimitRegistry()
    // vm_id → normalized `vm.policy.quota`; vm.json is the source of truth, this is the hot-path copy.
    this.vmQuota = new Map()
  }

  /** Load persisted counters and allocations; restore reload omits startup seed accounts. */
  async init({ seed = true } = {}) {
    for (const queue of this.db.pendingWriteQueues || []) await queue.flush()
    for (const row of await this.persistence.list()) {
      this.rows.set(row.account_id, row)
      this.allocations.set(row.account_id, await this.persistence.recentAllocations(row.account_id, 50))
    }
    if (seed) for (const account of this.seedAccounts) this.ensure(account)
    await this.flush()
    return this
  }

  async reload() {
    await this.flush()
    this.rows.clear()
    this.allocations.clear()
    return await this.init({ seed: false })
  }

  flush() {
    return this.writes.flush()
  }

  _workingSet() {
    const publish = (account, write) => {
      const next = structuredClone(account)
      const revision = (this.revisions.get(next.account_id) || 0) + 1
      this.revisions.set(next.account_id, revision)
      this.rows.set(next.account_id, next)
      this.writes.enqueue(async () => {
        const stored = await write()
        // A completed write may carry remote changes, but must not erase a newer local mutation.
        if (stored && this.revisions.get(next.account_id) === revision) this.rows.set(next.account_id, stored)
        return stored
      })
      return structuredClone(next)
    }
    const save = (account, { observation, conditional = true, paths, probeBase } = {}) => {
      const changes = accountChanges(this.rows.get(account.account_id) || {}, account, { paths })
      const ticket = changes.observations.length ? (observation ?? this.beginObservation()) : null
      // The ordered queue awaits the ticket; attach its rejection handler immediately.
      if (ticket?.catch) ticket.catch(() => {})
      return publish(account, () =>
        this.persistence.applyChanges(account.account_id, changes, {
          observation: ticket,
          conditional,
          probeBase,
        }),
      )
    }
    return {
      get: (id) => structuredClone(this.rows.get(id) || null),
      list: () => [...this.rows.values()].map((row) => structuredClone(row)),
      insert: (row) => publish(row, () => this.persistence.insert(row)),
      save: (row) => save(row),
      observe: (row, options) => save(row, { ...options, conditional: false }),
      patch: (id, fields) =>
        publish({ ...this.rows.get(id), ...fields, account_id: id }, () =>
          this.persistence.applyChanges(id, { fields }),
        ),
      remove: (id) => {
        this.revisions.set(id, (this.revisions.get(id) || 0) + 1)
        const removed = this.rows.delete(id)
        this.allocations.delete(id)
        this.writes.enqueue(() => this.persistence.remove(id))
        return removed
      },
      addAllocation: (id, input, { max = 50 } = {}) => {
        const allocation = { ...input, at: input.at || new Date().toISOString() }
        this.allocations.set(id, [...(this.allocations.get(id) || []), structuredClone(allocation)].slice(-max))
        this.writes.enqueue(() => this.persistence.addAllocation(id, allocation, { max }))
      },
      recentAllocations: (id, limit = 5) => structuredClone((this.allocations.get(id) || []).slice(-limit)),
      allocationCount: (id) => (this.allocations.get(id) || []).length,
    }
  }

  /** Reserve before remote I/O when the producer can identify when an observation starts. */
  beginObservation() {
    return this.persistence.beginObservation()
  }

  /** Re-bind to a fresh DB connection (after backup restore). */
  async rebind(db) {
    await this.flush()
    this.db = db
    this.persistence = new AccountsRepo(db)
    return await this.reload()
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
      acc = this.repo.patch(id, {
        ...(account.vm_id ? { vm_id: account.vm_id } : {}),
        ...(account.type ? { type: account.type } : {}),
      })
    }
    return acc
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

    const countRequest = extra.countRequest !== false
    const exhausted = extra.exhausted === true || isUnifiedRejected(h)
    const writeExtra = countRequest || exhausted
    const u5 = num(h['anthropic-ratelimit-unified-5h-utilization'])
    const u7 = num(h['anthropic-ratelimit-unified-7d-utilization'])
    const paths = []
    for (const key of ['5h', '7d']) {
      if (!writeExtra) continue
      const prefix = `anthropic-ratelimit-unified-${key}-`
      if (h[`${prefix}utilization`] != null) {
        paths.push(['unified', 'headers', key, 'utilization'], ['unified', 'headers', key, 'status'])
      }
      if (h[`${prefix}status`]) paths.push(['unified', 'headers', key, 'status'])
      if (h[`${prefix}reset`]) paths.push(['unified', 'headers', key, 'reset'])
    }
    let sampled = false
    if (exhausted) {
      dropElapsedReset(acc, '5h', h['anthropic-ratelimit-unified-5h-reset'])
      dropElapsedReset(acc, '7d', h['anthropic-ratelimit-unified-7d-reset'])
    }
    if (
      writeExtra &&
      (u5 != null || h['anthropic-ratelimit-unified-5h-status'] || h['anthropic-ratelimit-unified-5h-reset'])
    ) {
      writeHeaderWindow(acc, '5h', {
        utilization: u5,
        reset: h['anthropic-ratelimit-unified-5h-reset'],
        status: h['anthropic-ratelimit-unified-5h-status'] || (u5 != null ? statusFromUtil(u5) : null),
      })
      sampled = true
    }
    if (
      writeExtra &&
      (u7 != null || h['anthropic-ratelimit-unified-7d-status'] || h['anthropic-ratelimit-unified-7d-reset'])
    ) {
      writeHeaderWindow(acc, '7d', {
        utilization: u7,
        reset: h['anthropic-ratelimit-unified-7d-reset'],
        status: h['anthropic-ratelimit-unified-7d-status'] || (u7 != null ? statusFromUtil(u7) : null),
      })
      sampled = true
    }
    const uOi = num(h['anthropic-ratelimit-unified-7d_oi-utilization'])
    if (writeExtra && (uOi != null || h['anthropic-ratelimit-unified-7d_oi-status'])) {
      acc.unified['7d_oi'] = {
        utilization: uOi ?? acc.unified['7d_oi']?.utilization ?? null,
        reset: h['anthropic-ratelimit-unified-7d_oi-reset'] || acc.unified['7d_oi']?.reset || null,
        status: h['anthropic-ratelimit-unified-7d_oi-status'] || statusFromUtil(uOi ?? 0),
      }
      sampled = true
    }
    if (
      writeExtra &&
      /seven_day_overage_included|7d_oi/i.test(String(h['anthropic-ratelimit-unified-representative-claim'] || ''))
    ) {
      acc.unified['7d_oi'] = {
        ...(acc.unified['7d_oi'] || {}),
        claim: h['anthropic-ratelimit-unified-representative-claim'],
      }
    }
    if (writeExtra && h['anthropic-ratelimit-unified-representative-claim']) {
      acc.unified.representative_claim = h['anthropic-ratelimit-unified-representative-claim']
    }
    if (writeExtra && h['anthropic-ratelimit-unified-overage-status']) {
      acc.unified.overage_status = h['anthropic-ratelimit-unified-overage-status']
    }
    acc.unified.updated_at = new Date().toISOString()
    if (sampled) acc.unified.headers.sampled_at = new Date().toISOString()

    const usage = normalizeUsage(disjointOpenaiUsage(usageBody || {}) || {})
    if (
      countRequest &&
      (usage.input_tokens != null ||
        usage.output_tokens != null ||
        usage.cache_read_tokens != null ||
        usage.cache_creation_tokens != null)
    ) {
      acc.tokens_in = addInteger(acc.tokens_in, usage.input_tokens || 0)
      acc.tokens_out = addInteger(acc.tokens_out, usage.output_tokens || 0)
      acc.cache_read_tokens = addInteger(acc.cache_read_tokens, usage.cache_read_tokens || 0)
      acc.cache_creation_tokens = addInteger(acc.cache_creation_tokens, usage.cache_creation_tokens || 0)
    }
    if (countRequest) acc.requests = addInteger(acc.requests, 1)

    if (exhausted) applyHeaderExhausted(acc, h)

    if (countRequest) {
      const view = headerWindowOrEmpty(acc.unified, '5h')
      const view7 = headerWindowOrEmpty(acc.unified, '7d')
      this.repo.addAllocation(accountId, {
        at: new Date().toISOString(),
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

    const saved = this.repo.observe(acc, { observation: extra.observation, paths })
    this._writeSessionWindow(saved)
    if (sampled) {
      const observed5 = headerWindowOrEmpty(saved.unified, '5h')
      const observed7 = headerWindowOrEmpty(saved.unified, '7d')
      this._observeUtil(accountId, {
        u5: observed5.utilization,
        u7: observed7.utilization,
        source: 'headers',
      })
    }
    return saved
  }

  recordLastProbe(accountId, probe = {}, { observation } = {}) {
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
    return this.repo.observe(acc, {
      observation,
      paths: [['unified', 'last_probe']],
      ...(isTestProbeSource(probe) ? { probeBase: prev } : {}),
    })
  }

  /**
   * CRS oauth/usage snapshot from the VM UID probe.
   * Fable weekly limit is stored separately and does not unschedulable the account.
   */
  ingestOAuthUsage(accountId, probe = {}, { observation } = {}) {
    const acc = this.ensure({ account_id: accountId })
    const nowIso = probe.probed_at || new Date().toISOString()
    if (isOfficialUsageRateLimited(probe)) {
      const retryMs = Number(probe.retry_after_ms)
      const backoff =
        Number.isFinite(retryMs) && retryMs > 0 ? Math.min(Math.max(retryMs, 60_000), 30 * 60_000) : 15 * 60_000
      acc.unified = acc.unified || {}
      acc.unified.usage_rate_limited_until = new Date(Date.now() + backoff).toISOString()
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
      return this.repo.observe(acc, { observation, probeBase: prev.at ? prev : null })
    }
    if (acc.unified) delete acc.unified.usage_rate_limited_until
    const official = probe.interpretations?.official || {}
    const w5 = official.five_hour || probe.five_hour || {}
    const w7 = official.seven_day || probe.seven_day || {}
    const paths = [['unified', 'last_probe']]
    for (const [key, window] of [
      ['5h', w5],
      ['7d', w7],
    ]) {
      if (applyOfficialWindow(window)) paths.push(['unified', key], ['unified', 'official', key])
    }
    writeOfficialWindow(acc, '5h', w5)
    writeOfficialWindow(acc, '7d', w7)
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
    if (oiNorm != null || oi?.status || oi?.resets_at || oi?.reset || oiRejected) {
      acc.unified['7d_oi'] = {
        utilization: oiNorm ?? (oiRejected ? 1 : (acc.unified['7d_oi']?.utilization ?? null)),
        reset: oi?.resets_at || oi?.reset || probe.fable?.reset_at || acc.unified['7d_oi']?.reset || null,
        status: oiRejected
          ? 'rejected'
          : oi?.status || (oiNorm != null ? statusFromUtil(oiNorm) : acc.unified['7d_oi']?.status || null),
      }
    }
    const usageOk = probe.ok === true || (probe.usage_status > 0 && probe.usage_status < 400)
    const completeOfficialUsage = usageOk && probe.limits_present === true
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
    if (completeOfficialUsage && (probe.usage_has_fable === true || hasFableUsage)) acc.unified.usage_has_fable = true
    else if (completeOfficialUsage && probe.usage_has_fable === false) {
      acc.unified.usage_has_fable = false
      delete acc.unified['7d_oi']
      if (acc.unified.headers) delete acc.unified.headers['7d_oi']
      delete acc.unified.fable
    }
    if (completeOfficialUsage) {
      if (probe.usage_has_fable === true || hasFableUsage) acc.unified.account_tier = 'max'
      else if (probe.usage_has_fable === false) acc.unified.account_tier = 'pro'
      if (acc.unified.account_tier === 'pro' || acc.unified.account_tier === 'max')
        acc.unified.account_tier_source = 'usage'
      paths.push(['unified', 'account_tier'], ['unified', 'account_tier_source'])
      if (probe.usage_has_fable != null) paths.push(['unified', 'usage_has_fable'])
    }
    if (probe.fable && !fableTransport) {
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
        probed_at: probe.probed_at || new Date().toISOString(),
      }
      // Only a complete official /usage classifies the plan; Fable hop only fills metadata.
      if (completeOfficialUsage && hasFableUsage) {
        acc.unified.account_tier = 'max'
        acc.unified.account_tier_source = 'usage'
      }
    } else if (usageOk) {
      const leftover = leftoverFable
      if (completeOfficialUsage && hasFableUsage) {
        acc.unified.account_tier = 'max'
        acc.unified.account_tier_source = 'usage'
        if (leftover.plan_denied || leftover.ok === false) {
          acc.unified.fable = {
            ...leftover,
            plan_denied: false,
            ok: true,
            error: null,
            probed_at: probe.probed_at || leftover.probed_at || new Date().toISOString(),
          }
        }
      }
    }
    acc.unified.source = 'vm-oauth-usage'
    acc.unified.updated_at = new Date().toISOString()
    acc.last_probe = {
      at: probe.probed_at || new Date().toISOString(),
      ok: !!probe.ok,
      source: probe.source || 'vm-oauth-usage',
      error:
        usageErrorText({ error: probe.error || probe.usage_error || (usageOk ? null : probe.fable?.error) }) || null,
      transport: fableTransport,
    }
    acc.unified.last_probe = acc.last_probe
    if (usageOk) {
      syncActiveToPassive(acc, nowIso)
      healOfficialOverwriteExtra(acc, accountId, this.repo)
      clearHeaderExhaustIfOfficialOpen(acc)
    }
    const saved = this.repo.observe(acc, { observation, paths })
    this._writeSessionWindow(saved)
    if (usageOk) {
      const observed5 = headerWindowOrEmpty(saved.unified, '5h')
      const observed7 = headerWindowOrEmpty(saved.unified, '7d')
      this._observeUtil(accountId, {
        u5: observed5.utilization,
        u7: observed7.utilization,
        source: 'official',
      })
    }
    if (usageOk && this.headerUnderSafety(saved)) {
      this.clearQuotaExhaustedCooldown(accountId)
    }
    return saved
  }

  /**
   * Official Claude Code stream-json `rate_limit_event`.
   * Live CLI includes `unifiedWindows.*.utilization`; keep status + reset too.
   */
  ingestCliRateLimit(accountId, rateLimitInfo, usageBody = null, { countRequest = null, observation } = {}) {
    const acc = this.ensure({ account_id: accountId })
    const infos = Array.isArray(rateLimitInfo) ? rateLimitInfo : rateLimitInfo ? [rateLimitInfo] : []
    const paths = []
    for (const info of infos) {
      if (!info || typeof info !== 'object') continue
      const typ = String(info.rateLimitType || info.rate_limit_type || '')
      const window = typ === 'seven_day' || typ === '7d' ? '7d' : typ === 'five_hour' || typ === '5h' ? '5h' : null
      const windows = info.unifiedWindows || info.unified_windows || {}
      if (window) {
        const slot = window === '7d' ? windows.seven_day || windows['7d'] : windows.five_hour || windows['5h']
        const utilization = officialUtilToExtra(slot?.utilization)
        if (utilization != null) paths.push(['unified', 'headers', window, 'utilization'])
        if (info.status || utilization != null) paths.push(['unified', 'headers', window, 'status'])
        if (info.resetsAt != null || info.resets_at != null) paths.push(['unified', 'headers', window, 'reset'])
        writeHeaderWindow(acc, window, {
          status: info.status || (utilization != null ? statusFromUtil(utilization) : null),
          reset: info.resetsAt != null || info.resets_at != null ? epochToIso(info.resetsAt ?? info.resets_at) : null,
          utilization,
        })
        acc.unified.headers[window].rate_limit_type = typ || null
        if (['rejected', 'rate_limited'].includes(String(info.status || '').toLowerCase())) {
          acc.unified.headers.exhausted_at = new Date().toISOString()
        }
      }
      if (info.overageStatus || info.overage_status) {
        acc.unified.overage_status = info.overageStatus || info.overage_status
      }
      acc.last_cli_rate_limit = { ...info, at: new Date().toISOString() }
    }
    acc.unified.updated_at = new Date().toISOString()
    acc.unified.source = 'claude_cli_rate_limit_event'

    const shouldCount = countRequest == null ? usageBody?.input_tokens != null : !!countRequest
    if (usageBody?.input_tokens != null) {
      acc.tokens_in = addInteger(acc.tokens_in, usageBody.input_tokens || 0)
      acc.tokens_out = addInteger(acc.tokens_out, usageBody.output_tokens || 0)
    }
    if (shouldCount) acc.requests = addInteger(acc.requests, 1)

    this.repo.addAllocation(accountId, {
      at: new Date().toISOString(),
      source: 'claude_cli',
      util_5h: officialWindow(acc.unified, '5h').utilization,
      util_7d: officialWindow(acc.unified, '7d').utilization,
      status_5h: headerWindow(acc.unified, '5h').status || officialWindow(acc.unified, '5h').status,
      status_7d: headerWindow(acc.unified, '7d').status || officialWindow(acc.unified, '7d').status,
      claim: acc.unified.representative_claim,
      tokens_in: usageBody?.input_tokens ?? null,
      tokens_out: usageBody?.output_tokens ?? null,
    })

    return this.repo.observe(acc, { observation, paths })
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

  canAccept(accountId, { tier = null, requestRisk = null, quotaRequest = null } = {}) {
    const acc = this.ensure({ account_id: accountId })
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

    if (quotaConfig.block_on_5h && headerHardBlocked(acc.unified, '5h')) {
      const h5 = headerWindow(acc.unified, '5h')
      acc.last_blocked = { at: new Date().toISOString(), window: '5h', status: h5.status, source: 'headers' }
      this.repo.save(acc)
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
    if (quotaConfig.block_on_7d && headerHardBlocked(acc.unified, '7d')) {
      const h7 = headerWindow(acc.unified, '7d')
      acc.last_blocked = { at: new Date().toISOString(), window: '7d', status: h7.status, source: 'headers' }
      this.repo.save(acc)
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

    const w5 = headerWindowOrEmpty(acc.unified, '5h')
    const w7 = headerWindowOrEmpty(acc.unified, '7d')
    const u5 = asUtilRatio(w5.utilization)
    const u7 = asUtilRatio(w7.utilization)
    const z5 = quotaConfig.block_on_5h ? gateZone(u5, ratio, gate) : GATE_OPEN
    const z7 = quotaConfig.block_on_7d ? gateZone(u7, weeklyRatio, gate) : GATE_OPEN

    if (z5 === GATE_GATED) {
      acc.last_blocked = { at: new Date().toISOString(), window: '5h', utilization: u5, status: w5.status }
      this.repo.save(acc)
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
      this.repo.save(acc)
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
              '临近额度闸线，本请求预估未命中缓存过大。Near the quota safety line, this large uncached request is not eligible on this account.',
          },
        }
      }
    }

    return { ok: true, warn_5h: u5 >= warnRatio, warn_7d: u7 >= Math.min(warnRatio, weeklyRatio) }
  }
  tryAcquire(accountId, opts = {}) {
    if (!opts.skipGate) {
      const gate = this.canAccept(accountId, opts)
      if (!gate.ok) return gate
    }
    const acc = this.ensure({ account_id: accountId })
    const inflight = this.inflight.get(accountId) || 0
    const limit = this.limitFor(acc, this.policyFor(acc, { tier: opts.tier }))
    if (inflight >= limit) {
      return { ok: false, reason: 'concurrency_limit', detail: { inflight, max: limit, source: 'quota-reservation' } }
    }
    const inBand = this._drainingNow(accountId, { tier: opts.tier })
    const stack = this.reservationBand.get(accountId) || []
    stack.push(inBand)
    this.reservationBand.set(accountId, stack)
    this.inflight.set(accountId, inflight + 1)
    this._rpmTouch(accountId)
    return { ok: true }
  }

  /** sub2api 7d_oi: Fable-only window. Does not unschedulable the account. */
  fableWindowLimited(accountId, now = Date.now()) {
    const oi = this.repo.get(accountId)?.unified?.['7d_oi']
    if (!oi) return false
    const status = String(oi.status || '').toLowerCase()
    if (status !== 'rejected' && status !== 'rate_limited') return false
    const resetMs = parseResetMs(oi.reset)
    if (Number.isFinite(resetMs) && resetMs <= now) return false
    return true
  }

  fableWindowResetAt(accountId) {
    const reset = this.repo.get(accountId)?.unified?.['7d_oi']?.reset
    if (!reset) return null
    const ms = parseResetMs(reset)
    return Number.isFinite(ms) ? ms : null
  }

  /** Experimental 50/50 weekly split. Off unless quota.weekly_split.enabled (or the VM override). */
  weeklySplitOf(accountId) {
    const acc = this.repo.get(accountId)
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

  weeklySplitResetAt(accountId, kind = 'regular') {
    const acc = this.repo.get(accountId)
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

  release(accountId) {
    const n = Math.max(0, (this.inflight.get(accountId) || 1) - 1)
    this.inflight.set(accountId, n)
    const stack = this.reservationBand.get(accountId)
    if (stack?.length) stack.pop()
    if (stack && !stack.length) this.reservationBand.delete(accountId)
    return n
  }

  /**
   * A hop that actually ran on an in-band account: Extra may still show the
   * previous percent, so the next large request treats the reading as stale
   * until headers/official usage move.
   */
  noteBandSettled(accountId) {
    if (!accountId) return 0
    const stack = this.reservationBand.get(accountId)
    const reservedInBand = Array.isArray(stack) ? stack.some(Boolean) : false
    if (!reservedInBand && !this._drainingNow(accountId)) return this.staleSettled.get(accountId) || 0
    const next = (this.staleSettled.get(accountId) || 0) + 1
    this.staleSettled.set(accountId, next)
    return next
  }

  /**
   * The stricter 5h/7d gate zone for this account (see quota-gate.mjs), with
   * the block switches applied. Used by the seat planner to place new devices.
   */
  gateZoneOf(accountId, { tier = null } = {}) {
    const acc = this.repo.get(accountId) || this.ensure({ account_id: accountId })
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
      const healed = healOfficialOverwriteExtra(acc, accountId, this.repo)
      if (!healed) {
        if (backoffExpired) this.repo.save(acc)
        if (this.headerUnderSafety(acc)) this.clearQuotaExhaustedCooldown(accountId)
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
      healOfficialOverwriteExtra(acc, accountId, this.repo)
    }
    acc.unified.updated_at = new Date().toISOString()
    const saved = this.repo.save(acc)
    this._writeSessionWindow(saved)
    if (this.headerUnderSafety(saved)) this.clearQuotaExhaustedCooldown(accountId)
    return saved
  }

  officialUnderSafety(acc) {
    return this.headerUnderSafety(acc)
  }

  headerUnderSafety(acc) {
    if (!acc?.unified) return false
    if (headerHardBlocked(acc.unified, '5h') || headerHardBlocked(acc.unified, '7d')) return false
    const policy = this.policyFor(acc)
    const ratio = Number(policy.limit_5h ?? policy.safety_ratio ?? 0.85)
    const weeklyRatio = Number(policy.limit_7d ?? policy.weekly_safety_ratio ?? 0.8)
    const w5 = headerWindowOrEmpty(acc.unified, '5h')
    const w7 = headerWindowOrEmpty(acc.unified, '7d')
    const u5 = officialUtilToExtra(w5.utilization) || 0
    const u7 = officialUtilToExtra(w7.utilization) || 0
    if (u5 >= 1 || u5 >= ratio) return false
    if (u7 >= 1 || u7 >= weeklyRatio) return false
    return true
  }

  clearQuotaExhaustedCooldown(accountId) {
    if (!accountId || !this.runtimeRepo) return false
    let state = null
    try {
      state = this.runtimeRepo.get?.(accountId)
    } catch {
      return false
    }
    if (!state) return false
    // Live 429 / overload columns belong to RateLimitService; passive Extra never lifts them.
    if (Number(state.rate_limit_reset_at) > Date.now() || Number(state.overload_until) > Date.now()) return false
    const reason = String(state.cooldown_reason || '')
    const quotaCool = !reason || /quota|account_quota_exhausted|rate_limited/i.test(reason)
    if (!quotaCool) return false
    if (!state.cooldown_until && !reason) return false
    try {
      this.runtimeRepo.upsert?.({
        ...state,
        status: 'ready',
        cooldown_until: null,
        cooldown_reason: null,
        rate_limit_reset_at: null,
      })
    } catch {
      return false
    }
    try {
      this.onQuotaCooldownCleared?.(accountId)
    } catch {}
    return true
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

  snapshot() {
    const def = this.tiers?.default || {}
    return {
      safety_ratio: def.limit_5h ?? def.safety_ratio ?? this.config.safety_ratio,
      weekly_safety_ratio: def.limit_7d ?? def.weekly_safety_ratio ?? this.config.weekly_safety_ratio,
      tiers: this.tiers,
      accounts: this.repo.list().map((a) => {
        const lastUsedAt = this._lastUsedAt(a.account_id)
        const official = applyEffectiveWindows(a.unified, { lastUsedAt, source: a.unified?.source })
        const listed = listQuotaFromHeaders(a.unified)
        return {
          account_id: a.account_id,
          vm_id: a.vm_id,
          email: a.email,
          inflight: this.inflight.get(a.account_id) || 0,
          max_concurrency: a.max_concurrency,
          rpm: this._rpmCount(a.account_id).n,
          max_rpm: a.max_rpm ?? 0,
          rpm_reset_at: this._rpmCount(a.account_id).resetAt,
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
      return this.repo.patch(accountUuid, { vm_id: vmId, ...(email ? { email } : {}) })
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
    const revoke = /access token has been revoked|token has been revoked|oauth_revoked/i
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

  setAccountTier(accountId, tier, { source = null, observation } = {}) {
    const key = String(tier || '').toLowerCase()
    if (!accountId || (key !== 'pro' && key !== 'max')) return null
    const acc = this.repo.get(accountId)
    if (!acc) return null
    if (acc.unified?.account_tier_source === 'profile' && source !== 'profile' && source !== 'usage') return acc
    if (
      observation == null &&
      acc.unified?.account_tier === key &&
      (acc.unified?.account_tier_source || null) === source
    )
      return acc
    acc.unified = acc.unified || {}
    acc.unified.account_tier = key
    acc.unified.account_tier_source = source
    acc.unified.updated_at = new Date().toISOString()
    return observation == null
      ? this.repo.save(acc)
      : this.repo.observe(acc, {
          observation,
          paths: [
            ['unified', 'account_tier'],
            ['unified', 'account_tier_source'],
          ],
        })
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

  clearModelUnsupported(accountId, model) {
    const key = resolvePolicyModelId(model) || String(model || '').trim()
    if (!accountId || !key) return null
    const acc = this.repo.get(accountId)
    if (!acc?.unified?.model_denied_until?.[key]) return acc
    const denied = { ...acc.unified.model_denied_until }
    delete denied[key]
    acc.unified.model_denied_until = denied
    acc.unified.updated_at = new Date().toISOString()
    return this.repo.save(acc)
  }

  setMaxConcurrency(accountId, n, { override = false } = {}) {
    const acc = this.ensure({ account_id: accountId })
    if (!acc) return null
    return this.repo.patch(accountId, {
      max_concurrency: Math.max(0, Math.min(256, Number(n) || 0)),
      concurrency_override: override ? 1 : 0,
    })
  }

  setMaxConcurrencyForVm(vmId, n) {
    const v = Math.max(0, Math.min(256, Number(n) || 0))
    const out = []
    for (const a of this.repo.list()) {
      if (a.vm_id === vmId || a.account_id === vmId) {
        out.push(this.repo.patch(a.account_id, { max_concurrency: v }))
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
      out.push(this.repo.patch(a.account_id, { max_concurrency: v }))
    }
    return out
  }

  setMaxRpm(accountId, n, { override = false } = {}) {
    const acc = this.ensure({ account_id: accountId })
    if (!acc) return null
    return this.repo.patch(accountId, {
      max_rpm: Math.max(0, Math.min(1e6, Number(n) || 0)),
      rpm_override: override ? 1 : 0,
    })
  }

  setMaxRpmForVm(vmId, n, { override = false } = {}) {
    const v = Math.max(0, Math.min(1e6, Number(n) || 0))
    const out = []
    for (const a of this.repo.list()) {
      if (a.vm_id === vmId || a.account_id === vmId) {
        out.push(this.repo.patch(a.account_id, { max_rpm: v, ...(override ? { rpm_override: 1 } : {}) }))
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
      out.push(this.repo.patch(a.account_id, { max_rpm: v }))
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
      out.push(this.repo.patch(a.account_id, { max_concurrency: v, concurrency_override: 0 }))
    }
    return out
  }

  nearLimit(acc) {
    return isNearLimit(acc, this.policyFor(acc))
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

function writeHeaderWindow(acc, key, incoming = {}) {
  acc.unified.headers = acc.unified.headers || {}
  const cur = acc.unified.headers[key] || {}
  const next = {
    utilization: incoming.utilization != null ? incoming.utilization : (cur.utilization ?? null),
    reset: incoming.reset || incoming.resets_at || cur.reset || null,
    status: incoming.status || cur.status || null,
  }
  if (incoming.rate_limit_type || cur.rate_limit_type) {
    next.rate_limit_type = incoming.rate_limit_type || cur.rate_limit_type
  }
  acc.unified.headers[key] = next
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

/** Official /usage writes Extra only when Extra is empty, elapsed, or leftover rejected. */
function syncActiveToPassive(acc, sampledAt) {
  acc.unified.headers = acc.unified.headers || {}
  const now = Date.now()
  for (const key of ['5h', '7d']) {
    const src = acc.unified.official?.[key] || acc.unified[key]
    const extra = acc.unified.headers[key]
    const officialReset = src?.reset || src?.resets_at || null
    if (!shouldCopyOfficialToExtra(src, extra, now)) {
      if (officialReset && extra && !extra.reset) writeHeaderWindow(acc, key, { reset: officialReset })
      continue
    }
    writeHeaderWindow(acc, key, {
      utilization: officialUtilToExtra(src.utilization),
      reset: officialReset || extra?.reset || null,
      status: src.status || null,
    })
  }
  const oi = acc.unified['7d_oi']
  if (oi && (oi.utilization != null || oi.status || oi.reset)) {
    acc.unified.headers['7d_oi'] = {
      utilization: officialUtilToExtra(oi.utilization) ?? acc.unified.headers['7d_oi']?.utilization ?? null,
      reset: oi.reset || acc.unified.headers['7d_oi']?.reset || null,
      status: oi.status || acc.unified.headers['7d_oi']?.status || null,
    }
  }
  acc.unified.headers.sampled_at = sampledAt || new Date().toISOString()
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
function healOfficialOverwriteExtra(acc, accountId, repo) {
  if (!acc?.unified?.headers) return false
  const extra = acc.unified.headers['5h']
  const official = officialWindow(acc.unified, '5h')
  if (!officialLooksLimited(extra) || !officialLooksLimited(official)) return false
  if (extraIsLiveOpen(extra)) return false
  const sampled = acc.unified.headers.sampled_at
  const probeAt = acc.last_probe?.at || acc.unified.last_probe?.at
  if (sampled && probeAt) {
    const sampledMs = Date.parse(sampled)
    const probeMs = Date.parse(probeAt)
    if (Number.isFinite(sampledMs) && Number.isFinite(probeMs) && Math.abs(sampledMs - probeMs) > 5000) return false
  }
  const last = lastHeaderAllocation(repo, accountId)
  const prev = Number(last?.util_5h)
  if (!Number.isFinite(prev) || prev >= 0.95) return false
  writeHeaderWindow(acc, '5h', {
    utilization: prev,
    status: last.status_5h || 'allowed',
    reset: extra.reset || last.reset_5h || official.reset || null,
  })
  acc.unified.headers.exhausted_at = null
  return true
}

function applyHeaderExhausted(acc, h = {}) {
  const s5 = String(h['anthropic-ratelimit-unified-5h-status'] || '').toLowerCase()
  const s7 = String(h['anthropic-ratelimit-unified-7d-status'] || '').toLowerCase()
  const hit5 = s5 === 'rejected' || s5 === 'rate_limited'
  const hit7 = s7 === 'rejected' || s7 === 'rate_limited'
  if (hit7) {
    writeHeaderWindow(acc, '7d', {
      utilization: num(h['anthropic-ratelimit-unified-7d-utilization']),
      reset: h['anthropic-ratelimit-unified-7d-reset'],
      status: 'rejected',
    })
  }
  if (hit5 || !hit7) {
    writeHeaderWindow(acc, '5h', {
      utilization: num(h['anthropic-ratelimit-unified-5h-utilization']),
      reset: h['anthropic-ratelimit-unified-5h-reset'],
      status: 'rejected',
    })
  }
  acc.unified.headers.exhausted_at = new Date().toISOString()
}

/** A reject without a fresh reset must not inherit last window's elapsed reset (wiped to 0 at once). */
function dropElapsedReset(acc, key, incomingReset) {
  if (incomingReset) return
  const cur = acc.unified.headers?.[key]
  if (!cur?.reset) return
  const ms = parseResetMs(cur.reset)
  if (Number.isFinite(ms) && ms <= Date.now()) acc.unified.headers[key] = { ...cur, reset: null }
}

function writeOfficialWindow(acc, key, incoming = {}) {
  const next = applyOfficialWindow(incoming)
  if (!next) return
  acc.unified.official = acc.unified.official || {}
  acc.unified.official[key] = next
  acc.unified.official.updated_at = new Date().toISOString()
  acc.unified[key] = { ...next }
}

function officialOpen(window = {}) {
  return !officialLooksLimited(window)
}

function clearHeaderExhaustIfOfficialOpen(acc) {
  const headers = acc.unified.headers
  if (!headers) return
  const o5 = acc.unified.official?.['5h'] || acc.unified['5h']
  const o7 = acc.unified.official?.['7d'] || acc.unified['7d']
  if (
    officialOpen(o5) &&
    headers['5h'] &&
    ['rejected', 'rate_limited'].includes(String(headers['5h'].status || '').toLowerCase())
  ) {
    headers['5h'] = { ...headers['5h'], status: 'allowed' }
  }
  if (
    officialOpen(o7) &&
    headers['7d'] &&
    ['rejected', 'rate_limited'].includes(String(headers['7d'].status || '').toLowerCase())
  ) {
    headers['7d'] = { ...headers['7d'], status: 'allowed' }
  }
  if (officialOpen(o5) && officialOpen(o7)) headers.exhausted_at = null
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
