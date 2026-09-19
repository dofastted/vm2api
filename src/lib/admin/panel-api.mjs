/**
 * Simplified Panel API — UI-friendly shapes for shadcn console.
 *
 * Envelope:
 *   { ok: true, data: T, meta?: object }
 *   { ok: false, error: { type, code, message, ... } }
 */

import os from 'node:os'
import path from 'node:path'
import {
  listVms,
  getVm,
  summarizeVm,
  getActiveVmId,
  vmHasClaudeCredential,
  persistAccountTier,
  isCodexVm,
} from '../vm/vm-registry.mjs'
import { resolveInferenceEngine, resolveSlotPersonaPreset } from '../vm/slot-engine.mjs'
import { probeAccount } from '../oauth/usage-probe.mjs'
import { queryOpenaiQuota, resetOpenaiQuota } from '../oauth/openai-quota.mjs'
import { canOfficialUsage, credentialModeOfVm } from '../oauth/credential-mode.mjs'
import { getUsageCache } from '../oauth/usage-cache.mjs'
import { makeError, ErrorType, ErrorCode } from '../core/errors.mjs'
import { filterVmsForPanel } from './resource-owner.mjs'
import { computeWeeklySplit, publicWeeklySplit, weeklySplitConfig } from '../pool/weekly-split.mjs'
import { accountTierKey, isNearLimit, normalizeTiers, resolveTierPolicy } from '../pool/quota-tiers.mjs'
import { inferClaudeTier } from '../pool/claude-tier.mjs'
import { listQuotaFromHeaders } from '../pool/quota-window.mjs'
import { resolveCredentialScheduleLevel } from '../pool/credential-weight.mjs'
import { evaluateAccount, credStatusFromAvailability } from '../pool/availability.mjs'
import { isLeftoverGrantRevokeRuntime, viewRuntimeWithoutLeftoverRevoke } from '../pool/schedule-eligibility.mjs'
import {
  isFableUnavailablePro,
  isOfficialUsageRateLimited,
  PASSIVE_HEADER_SOURCE,
  probeFromPassiveHeaders,
  shouldHopOfficialUsage,
  shouldProbeFable,
} from '../oauth/crs-usage-probe.mjs'
import { proxyHasVm } from '../vm/proxy-pool.mjs'
import { collectLivePanelCredentials } from './panel-live-credentials.mjs'
import { officialCcHome, readOfficialCcStatus, normalizeOfficialCcConfig } from '../oauth/official-cc-bootstrap.mjs'
import { normalizeHealthProbeConfig } from './health-probe.mjs'
import { normalizeUsageProbeConfig } from '../oauth/usage-probe-monitor.mjs'
import { publicNotifyConfig, summarizePoolAvailability } from './notify.mjs'
import { cacheHitStats } from './cache-metrics.mjs'
import { shanghaiDayStartIso } from './pricing.mjs'
import {
  OVERLAY_PRESETS,
  PERSONA_PRESETS,
  parsePersonaHides,
  validatePersonaTemplate,
} from '../identity/persona-template.mjs'
import { PERSONA_STANDING_MAX } from '../identity/crs-persona.mjs'
import { MESSAGES_BREAKPOINT_MODES } from '../protocol/cache-ttl.mjs'

export function ok(data, meta) {
  const out = { ok: true, data }
  if (meta) out.meta = meta
  return out
}

/** Clear runtime cooldown, leftover /usage 429 flag, and sticky pins for a slot. */
export function clearVmCooldown({ cfg, accountQuota, stickyRouter = null, poolScheduler = null, id } = {}) {
  const vm = getVm(cfg?.paths?.project, id)
  if (!vm) {
    return fail(
      makeError({
        type: ErrorType.NOT_FOUND,
        code: ErrorCode.VM_NOT_FOUND,
        message: `VM '${id}' not found`,
        status: 404,
      }),
    )
  }
  const acc = findAccount(accountQuota, vm)
  const keys = [...new Set([vm.account_uuid, vm.claude?.account_uuid, acc?.account_id, vm.id].filter(Boolean))]
  const repo = accountQuota?.runtimeRepo
  let runtimeCleared = 0
  let usageFlagCleared = 0
  for (const key of keys) {
    try {
      if (repo?.clearAccountCooldown?.(key, { vmId: vm.id })) runtimeCleared += 1
    } catch {}
    try {
      const row = accountQuota?.repo?.get?.(key)
      if (row?.unified && (row.unified.usage_rate_limited_until || row.unified.last_probe?.rate_limited)) {
        delete row.unified.usage_rate_limited_until
        if (row.unified.last_probe?.rate_limited) {
          row.unified.last_probe = { ...row.unified.last_probe, rate_limited: false }
        }
        accountQuota.repo.save(row)
        usageFlagCleared += 1
      }
    } catch {}
    try {
      stickyRouter?.unbindByAccount?.({ accountId: key, vmId: vm.id })
    } catch {}
  }
  try {
    poolScheduler?.notifyCapacity?.()
  } catch {}
  return ok({
    id: vm.id,
    cleared: true,
    cooldown_until: null,
    cooldown_reason: null,
    runtime_cleared: runtimeCleared,
    usage_flag_cleared: usageFlagCleared,
  })
}

/**
 * Persona / overlay template validation for PUT /api/panel/routing.
 * Returns a list of human-readable problems; empty means the patch is accepted.
 * Bad templates must 400 rather than silently degrade at request time.
 */
export function validatePersonaRoutingPatch(body = {}) {
  const compat = body?.compatibility
  if (!compat || typeof compat !== 'object') return []
  const problems = []
  if (compat.persona_preset != null && String(compat.persona_preset).trim() !== '') {
    const raw = String(compat.persona_preset).trim()
    if (!PERSONA_PRESETS.includes(raw)) {
      problems.push(`persona_preset 必须是 ${PERSONA_PRESETS.join(' / ')}，收到 ${raw}`)
    }
  }
  if (compat.overlay_preset != null && String(compat.overlay_preset).trim() !== '') {
    const raw = String(compat.overlay_preset).trim()
    if (!OVERLAY_PRESETS.includes(raw)) {
      problems.push(`overlay_preset 必须是 ${OVERLAY_PRESETS.join(' / ')}，收到 ${raw}`)
    }
  }
  if (compat.persona_hides != null && compat.persona_hides !== '') {
    if (typeof compat.persona_hides !== 'boolean' && parsePersonaHides(compat.persona_hides) == null) {
      problems.push('persona_hides 必须是布尔')
    }
  }
  if (compat.persona_standing != null && String(compat.persona_standing).length > PERSONA_STANDING_MAX) {
    problems.push(`persona_standing 超过 ${PERSONA_STANDING_MAX} 字符`)
  }
  if (compat.cache_breakpoints != null) {
    const bp = compat.cache_breakpoints
    if (typeof bp !== 'object' || Array.isArray(bp)) {
      problems.push('cache_breakpoints 必须是对象')
    } else {
      for (const flag of ['enabled', 'preserve_client', 'system_tail', 'tools_tail']) {
        if (bp[flag] != null && typeof bp[flag] !== 'boolean') {
          problems.push(`cache_breakpoints.${flag} 必须是布尔`)
        }
      }
      if (bp.messages != null && !MESSAGES_BREAKPOINT_MODES.includes(String(bp.messages).trim())) {
        problems.push(`cache_breakpoints.messages 必须是 ${MESSAGES_BREAKPOINT_MODES.join(' / ')}，收到 ${bp.messages}`)
      }
    }
  }
  for (const [field, overlay] of [
    ['persona_templates', false],
    ['overlay_templates', true],
  ]) {
    const templates = compat[field]
    if (templates == null) continue
    if (typeof templates !== 'object' || Array.isArray(templates)) {
      problems.push(`${field} 必须是对象`)
      continue
    }
    const presets = overlay ? OVERLAY_PRESETS : PERSONA_PRESETS
    for (const [key, blocks] of Object.entries(templates)) {
      if (!presets.includes(key)) {
        problems.push(`${field}.${key} 不是已知方案（${presets.join(' / ')}）`)
        continue
      }
      for (const problem of validatePersonaTemplate(blocks, { overlay })) {
        problems.push(`${field}.${key}：${problem}`)
      }
    }
  }
  return problems
}

export function fail(errorResult) {
  // errorResult from makeError: { status, body: { error } }
  return {
    status: errorResult.status || 400,
    body: { ok: false, error: errorResult.body?.error || errorResult },
  }
}

export function summarizeProxyPool(proxyPool) {
  if (!proxyPool || typeof proxyPool.snapshot !== 'function') {
    return {
      total: 0,
      free: 0,
      bound: 0,
      ok: 0,
      dead: 0,
      probing: false,
      disconnect_on_error: false,
    }
  }
  const snap = proxyPool.snapshot()
  return {
    total: snap.totals?.total || 0,
    free: snap.totals?.free || 0,
    bound: snap.totals?.bound || 0,
    ok: snap.totals?.ok || 0,
    dead: snap.totals?.dead || 0,
    probing: !!snap.totals?.probing,
    disconnect_on_error: !!snap.config?.disconnect_on_error,
  }
}

function snapshotPool(proxyPool) {
  if (!proxyPool || typeof proxyPool.snapshot !== 'function') return null
  try {
    return proxyPool.snapshot()
  } catch {
    return null
  }
}

export async function buildDashboard({
  cfg,
  accountQuota,
  stickyRouter,
  routingConfig,
  stats,
  requestLog = null,
  poolScheduler = null,
  proxyPool = null,
}) {
  try {
    accountQuota?.runtimeRepo?.clearExpired?.(Date.now())
  } catch {}
  const active = getActiveVmId(cfg.paths.project)
  const pool = poolScheduler?.snapshot?.() || {}
  const poolSnap = snapshotPool(proxyPool)
  const listed = listVms(cfg.paths.project)
  const liveById = await collectLivePanelCredentials(cfg.paths.project, listed)
  const vms = listed.map((v) => enrichVm(v, accountQuota, active, { routingConfig, pool, poolSnap, liveById }))
  const snap = accountQuota.snapshot()
  const accounts = snap.accounts || []
  const peak5 = Math.max(0, ...accounts.map((a) => Number(a.unified?.['5h']?.utilization || 0)), 0)
  const peak7 = Math.max(0, ...accounts.map((a) => Number(a.unified?.['7d']?.utilization || 0)), 0)
  const near = accounts.filter(
    (a) =>
      accountQuota?.nearLimit?.(a) ??
      isNearLimit(
        a,
        resolveTierPolicy(
          {
            tiers: snap.tiers || routingConfig?.tiers,
            quota: routingConfig?.quota,
            concurrency: routingConfig?.concurrency,
          },
          accountTierKey(a),
        ),
      ),
  ).length
  const proxy_pool = summarizeProxyPool(proxyPool)

  const billing = stampVmBilling(
    vms,
    (() => {
      try {
        return attachBillingMeta(requestLog?.billingStats?.(), accounts)
      } catch {
        return null
      }
    })(),
  )

  return ok({
    health: {
      status: 'ok',
      service: 'vm2api',
      rewrite: cfg.rewrite?.enabled ? 'on' : 'off',
      base_url: cfg.base_url,
    },
    host: hostStats(),
    summary: {
      vm_count: vms.length,
      account_count: accounts.length,
      active_vm: active,
      safety_ratio: snap.safety_ratio,
      peak_5h: peak5,
      peak_7d: peak7,
      near_limit: near,
      requests: accounts.reduce((s, a) => s + (a.requests || 0), 0),
      tokens_in: accounts.reduce((s, a) => s + (a.tokens_in || 0), 0),
      tokens_out: accounts.reduce((s, a) => s + (a.tokens_out || 0), 0),
      cache_read_tokens: accounts.reduce((s, a) => s + (a.cache_read_tokens || 0), 0),
      cache_creation_tokens: accounts.reduce((s, a) => s + (a.cache_creation_tokens || 0), 0),
      ...cacheHitStats({
        input_tokens: accounts.reduce((s, a) => s + (a.tokens_in || 0), 0),
        cache_read_tokens: accounts.reduce((s, a) => s + (a.cache_read_tokens || 0), 0),
        cache_creation_tokens: accounts.reduce((s, a) => s + (a.cache_creation_tokens || 0), 0),
      }),
      fable_max_per_account: Number(
        routingConfig?.concurrency?.fable_max_per_account ?? pool.fable_max_per_account ?? 4,
      ),
      fable_inflight: vms.reduce((n, v) => n + (Number(v.fable_inflight) || 0), 0),
      today_cost: billing?.today?.total_cost || 0,
      total_cost: billing?.total?.total_cost || 0,
    },
    proxy_pool,
    vms,
    routing: {
      sticky_enabled: !!routingConfig?.sticky?.enabled,
      sticky_sessions: stickyRouter.stats()?.active_sessions ?? 0,
      safety_ratio: routingConfig?.quota?.safety_ratio ?? 0.85,
      weekly_safety_ratio: routingConfig?.quota?.weekly_safety_ratio ?? 0.8,
      tiers: normalizeTiers(routingConfig?.tiers, routingConfig?.quota, routingConfig?.concurrency),
      fable_max_per_account: Number(
        routingConfig?.concurrency?.fable_max_per_account ?? pool.fable_max_per_account ?? 4,
      ),
    },
    gateway_stats: stats,
    // historic totals straight from the request_logs table (survives restarts)
    db_totals: (() => {
      try {
        return requestLog?.totals() || null
      } catch {
        return null
      }
    })(),
    billing,
    // last-hour ops cards (SLA / QPS / TTFT) — console can refetch other windows via /request-logs/stats
    ops: (() => {
      try {
        return requestLog?.windowStats?.({ since: new Date(Date.now() - 3600_000).toISOString() }) || null
      } catch {
        return null
      }
    })(),
  })
}

export async function buildVmList({
  cfg,
  accountQuota,
  routingConfig = {},
  poolScheduler = null,
  proxyPool = null,
  ownerUserId = null,
  role = 'admin',
} = {}) {
  try {
    accountQuota?.runtimeRepo?.clearExpired?.(Date.now())
  } catch {}
  const active = getActiveVmId(cfg.paths.project)
  const pool = poolScheduler?.snapshot?.() || {}
  const poolSnap = snapshotPool(proxyPool)
  const listed = filterVmsForPanel(listVms(cfg.paths.project), { role, userId: ownerUserId })
  const liveById = await collectLivePanelCredentials(cfg.paths.project, listed)
  const vms = listed.map((v) => enrichVm(v, accountQuota, active, { routingConfig, pool, poolSnap, liveById }))
  return ok({ items: vms, active_vm: active, total: vms.length, proxy_pool: summarizeProxyPool(proxyPool) })
}

export async function buildVmDetail({
  cfg,
  accountQuota,
  id,
  routingConfig = {},
  poolScheduler = null,
  requestLog = null,
  proxyPool = null,
  kernelHealth = null,
}) {
  const vm = getVm(cfg.paths.project, id)
  if (!vm) {
    return fail(
      makeError({
        type: ErrorType.NOT_FOUND,
        code: ErrorCode.VM_NOT_FOUND,
        message: `VM '${id}' not found`,
        status: 404,
      }),
    )
  }
  const active = getActiveVmId(cfg.paths.project)
  const pool = poolScheduler?.snapshot?.() || {}
  const poolSnap = snapshotPool(proxyPool)
  const listed = [summarizeVm(vm)]
  const liveById = await collectLivePanelCredentials(cfg.paths.project, listed, { cacheMs: 0 })
  const summary = enrichVm(listed[0], accountQuota, active, { routingConfig, pool, poolSnap, liveById })
  const acc = findAccount(accountQuota, summary)
  const billing = (() => {
    try {
      return requestLog?.billingStats?.() || null
    } catch {
      return null
    }
  })()
  const cost = lookupBilling(indexBillingAccounts(billing), acc || summary)
  applyCostFields(summary, cost)
  const detail = buildAccountBilling(cost, billing, {
    vmId: summary.id,
    accountId: acc?.account_id || summary.account_uuid,
    requestLog,
  })
  const gpt = isCodexVm(vm)
  const inferenceEngine = gpt ? null : summary.resolved_inference_engine || 'go'
  let goHealth = null
  let rustHealth = null
  let codexHealth = null
  if (typeof kernelHealth === 'function') {
    try {
      const health = await kernelHealth({ id, vm })
      if (gpt) {
        codexHealth = health?.codex || null
      } else if (health?.go || health?.rust) {
        goHealth = health.go || null
        rustHealth = health.rust || null
      } else if (inferenceEngine === 'rust') {
        rustHealth = health || null
      }
    } catch {
      const failed = { reachable: false, status: null, error_code: 'health_check_failed' }
      if (gpt) {
        codexHealth = failed
      } else {
        goHealth = failed
        rustHealth = failed
      }
    }
  }
  const activeEngine = gpt
    ? null
    : inferenceEngine === 'rust' && rustHealth?.reachable
      ? 'rust'
      : goHealth?.reachable
        ? 'go'
        : null
  return ok({
    vm: summary,
    proxy: summary.proxy || null,
    proxy_pool: summarizeProxyPool(proxyPool),
    billing: detail,
    account: acc
      ? {
          account_id: acc.account_id,
          ...quotaFromAccount(acc, accountQuota?.config),
          inflight: acc.inflight,
          max_concurrency: acc.max_concurrency,
          rpm: acc.rpm || 0,
          max_rpm: acc.max_rpm ?? 0,
          requests: acc.requests,
          tokens_in: acc.tokens_in,
          tokens_out: acc.tokens_out,
          cache_read_tokens: acc.cache_read_tokens || 0,
          cache_creation_tokens: acc.cache_creation_tokens || 0,
          today_cost: cost?.today_cost || 0,
          total_cost: cost?.total_cost || 0,
          window_5h_cost: cost?.window_5h_cost || 0,
          window_7d_cost: cost?.window_7d_cost || 0,
          last_blocked: acc.last_blocked,
          recent: (acc.recent_allocations || []).slice(-10),
          runtime_window: runtimeWindow(accountQuota, acc.account_id),
        }
      : null,
    official_cc: gpt ? null : readOfficialCcStatus(officialCcHome(cfg.paths.project, id)),
    kernel: gpt
      ? {
          credential_owner: 'codex',
          configured_engine: null,
          resolved_engine: null,
          active_engine: null,
          go_health: null,
          rust_health: null,
          codex_health: codexHealth,
        }
      : {
          credential_owner: 'go',
          configured_engine: summary.inference_engine || null,
          resolved_engine: inferenceEngine,
          active_engine: activeEngine,
          go_health: goHealth,
          rust_health: rustHealth,
        },
  })
}

/** Structured session-window / rate-limit state from account_runtime_states. */
function runtimeWindow(accountQuota, accountId) {
  try {
    const state = accountQuota?.runtimeRepo?.get?.(accountId)
    if (!state) return null
    return {
      rate_limited_at: state.rate_limited_at,
      rate_limit_reset_at: state.rate_limit_reset_at,
      overload_until: state.overload_until,
      session_window_start: state.session_window_start,
      session_window_end: state.session_window_end,
      session_window_status: state.session_window_status,
    }
  } catch {
    return null
  }
}

function gptQuotaFail(result) {
  const status = result.status || 400
  return fail(
    makeError({
      type:
        status === 404
          ? ErrorType.NOT_FOUND
          : status >= 500 || status === 429
            ? ErrorType.UPSTREAM
            : ErrorType.INVALID_REQUEST,
      code: result.error || 'openai_quota_failed',
      message: result.message || 'GPT 额度查询失败',
      status,
    }),
  )
}

export async function buildOpenaiQuotaRefresh({ cfg, id, rotate = true } = {}) {
  const result = await queryOpenaiQuota({ projectRoot: cfg.paths.project, vmId: id, rotate })
  if (!result.ok) return gptQuotaFail(result)
  return ok({
    vm_id: id,
    source: 'openai-wham-usage',
    ...result,
  })
}

export async function buildOpenaiQuotaReset({ cfg, id, rotate = true } = {}) {
  const result = await resetOpenaiQuota({ projectRoot: cfg.paths.project, vmId: id, rotate })
  if (!result.ok) return gptQuotaFail(result)
  return ok({
    vm_id: id,
    source: 'openai-wham-reset',
    ...result,
  })
}

export async function buildProbeOne({ cfg, accountQuota, id, force = false, usageCache = null, hop = true } = {}) {
  const vm = getVm(cfg.paths.project, id)
  if (!vm) {
    return fail(
      makeError({
        type: ErrorType.NOT_FOUND,
        code: ErrorCode.VM_NOT_FOUND,
        message: `VM '${id}' not found`,
        status: 404,
      }),
    )
  }
  if (isCodexVm(vm)) {
    const result = await queryOpenaiQuota({ projectRoot: cfg.paths.project, vmId: id, rotate: true })
    if (!result.ok) return gptQuotaFail(result)
    return ok({
      vm_id: id,
      account_uuid: null,
      source: 'openai-wham-usage',
      via: 'socks5',
      five_hour: {
        utilization: result.quota?.utilization_5h ?? null,
        resets_at: result.quota?.reset_5h || null,
        status: result.quota?.status_5h || null,
      },
      seven_day: {
        utilization: result.quota?.utilization_7d ?? null,
        resets_at: result.quota?.reset_7d || null,
        status: result.quota?.status_7d || null,
      },
      quota: result.quota,
      reset_credits: result.reset_credits || null,
      windows: result.windows || [],
      probed_at: result.fetched_at || new Date().toISOString(),
      ok: true,
    })
  }
  if (!vmHasClaudeCredential(vm)) {
    return fail(
      makeError({
        type: ErrorType.INVALID_REQUEST,
        code: 'no_oauth_token',
        message: 'VM has no OAuth access token',
        status: 400,
      }),
    )
  }
  if (!canOfficialUsage(credentialModeOfVm(vm))) {
    hop = false
  }
  const exec = {
    vmId: vm.id,
    homeDir: path.join(cfg.paths.project, 'vms', vm.id, 'cli-home'),
    oauth: vm.claude,
    vm,
  }
  const accountId = vm.claude?.account_uuid || vm.id
  accountQuota.ensure({
    account_id: accountId,
    vm_id: vm.id,
    email: vm.claude?.email,
    max_concurrency: vm.policy?.maxConcurrency,
    max_rpm: vm.policy?.maxRpm ?? 0,
  })
  const acc = accountQuota.repo.get(accountId)
  const q = quotaFromAccount(acc)
  const storedTier = vm.claude?.account_tier || acc?.unified?.account_tier || q.account_tier || null
  const includeFable = shouldProbeFable({
    fable: q.fable || acc?.unified?.fable || {},
    quota: { ...acc?.unified, ...q },
    storedTier,
  })
  const cache = usageCache || getUsageCache()
  const skipHop = !shouldHopOfficialUsage(acc?.unified, { hop })
  let result = skipHop
    ? {
        ok: true,
        source: PASSIVE_HEADER_SOURCE,
        via: 'passive-headers',
        probed_at: new Date().toISOString(),
        ...(probeFromPassiveHeaders(acc?.unified || {}) || {}),
      }
    : await cache.load(accountId, () => probeAccount({ exec, vm, includeFable }), { force: !!force })
  const usageListsFable = result.usage_has_fable === true || !!result.seven_day_oi
  if (
    !includeFable &&
    !usageListsFable &&
    (String(storedTier || '').toLowerCase() === 'pro' || isFableUnavailablePro(q.fable || {}, q))
  ) {
    result = {
      ...result,
      fable: {
        ...(result.fable || {}),
        model: 'claude-fable-5',
        ok: false,
        banned: false,
        limited: false,
        plan_denied: true,
        status: result.fable?.status || 403,
        error: 'plan_denied',
        utilization: null,
        reset_at: null,
      },
    }
  }
  if (!skipHop) accountQuota.ingestOAuthUsage(accountId, result)
  const after = accountQuota.repo.get(accountId)
  const qAfter = quotaFromAccount(after)
  const rateLimited = isOfficialUsageRateLimited(result)
  const passive = rateLimited ? probeFromPassiveHeaders(after?.unified || acc?.unified || {}) : null
  const cachedWindow =
    qAfter.utilization_5h != null ||
    qAfter.status_5h ||
    qAfter.utilization_7d != null ||
    !!(passive?.five_hour || passive?.seven_day)
  const tier = inferClaudeTier(
    {
      has_token: true,
      account_tier: after?.unified?.account_tier || storedTier,
      fable: qAfter.fable,
      utilization_7d_oi: qAfter.utilization_7d_oi,
      reset_7d_oi: qAfter.reset_7d_oi,
      status_7d_oi: qAfter.status_7d_oi,
      usage_has_fable: qAfter.usage_has_fable ?? result.usage_has_fable,
    },
    qAfter,
  ).key
  if (tier === 'pro' || tier === 'max') {
    accountQuota.setAccountTier(accountId, tier)
    persistAccountTier(cfg.paths.project, id, tier)
  }
  const availability = evaluateAccount({
    vm,
    account: after || {},
    hasToken: true,
    hasRefresh: !!(vm.has_refresh || vm.claude?.has_refresh),
    schedulable: vm.schedulable !== false,
    lastProbe: qAfter.last_probe,
    probeSource: qAfter.probe_source,
    quota: qAfter,
    policy: resolveTierPolicy(
      {
        tiers: accountQuota?.tiers,
        quota: accountQuota?.config,
        concurrency: accountQuota?.concurrency,
      },
      tier,
    ),
  })
  return ok({
    vm_id: id,
    account_uuid: vm.claude?.account_uuid || null,
    source: passive?.source || result.source,
    via: passive?.via || result.via || null,
    five_hour:
      result.five_hour ||
      passive?.five_hour ||
      (rateLimited && qAfter.utilization_5h != null
        ? {
            utilization: qAfter.utilization_5h,
            resets_at: qAfter.reset_5h || null,
            status: qAfter.status_5h || null,
          }
        : null),
    seven_day:
      result.seven_day ||
      passive?.seven_day ||
      (rateLimited && qAfter.utilization_7d != null
        ? {
            utilization: qAfter.utilization_7d,
            resets_at: qAfter.reset_7d || null,
            status: qAfter.status_7d || null,
          }
        : null),
    seven_day_sonnet: result.seven_day_sonnet || null,
    seven_day_oi: result.seven_day_oi || null,
    extra_usage: result.extra_usage || null,
    interpretations: result.interpretations || null,
    quota: {
      utilization_5h: qAfter.utilization_5h,
      utilization_7d: qAfter.utilization_7d,
      status_5h: qAfter.status_5h,
      status_7d: qAfter.status_7d,
      reset_5h: qAfter.reset_5h,
      reset_7d: qAfter.reset_7d,
    },
    availability,
    cred_status: credStatusFromAvailability(availability),
    fable: after?.unified?.fable || result.fable || q.fable || null,
    fable_probed: includeFable && !skipHop,
    account_tier: tier,
    probed_at: result.probed_at,
    ok: !!(result.ok || passive || (rateLimited && cachedWindow)),
    rate_limited: rateLimited,
    error:
      result.ok || passive || (rateLimited && cachedWindow)
        ? null
        : rateLimited
          ? '官方 /usage 限流，请稍后再试'
          : result.error || result.usage_error || null,
  })
}

export async function buildProbeAll({ cfg, accountQuota, hop = false } = {}) {
  const vms = listVms(cfg.paths.project)
  const items = []
  for (const s of vms) {
    const one = await buildProbeOne({ cfg, accountQuota, id: s.id, hop })
    if (one.ok === false || one.status) {
      items.push({ vm_id: s.id, ok: false, error: one.body?.error || one })
    } else {
      items.push(one.data)
    }
  }
  return ok({ items, total: items.length })
}

export function buildUsage({ accountQuota, cfg, requestLog = null }) {
  const snap = accountQuota.snapshot()
  const billing = (() => {
    try {
      return requestLog?.billingStats?.() || null
    } catch {
      return null
    }
  })()
  const costByKey = indexBillingAccounts(billing)
  const accounts = (snap.accounts || []).map((a) => {
    const cost = lookupBilling(costByKey, a)
    const vm = a.vm_id ? getVm(cfg?.paths?.project, a.vm_id) : null
    return {
      account_id: a.account_id,
      vm_id: a.vm_id,
      email: a.email,
      credential_mode: vm && vmHasClaudeCredential(vm) ? credentialModeOfVm(vm) : null,
      ...quotaFromAccount(a, accountQuota?.config),
      inflight: a.inflight,
      max_concurrency: a.max_concurrency,
      rpm: a.rpm || 0,
      max_rpm: a.max_rpm ?? 0,
      requests: a.requests,
      tokens_in: a.tokens_in,
      tokens_out: a.tokens_out,
      cache_read_tokens: a.cache_read_tokens || 0,
      cache_creation_tokens: a.cache_creation_tokens || 0,
      today_cost: cost?.today_cost || 0,
      total_cost: cost?.total_cost || 0,
      window_5h_cost: cost?.window_5h_cost || 0,
      window_5h_requests: cost?.window_5h_requests || 0,
      window_5h_tokens: cost?.window_5h_tokens || 0,
      window_7d_cost: cost?.window_7d_cost || 0,
      window_7d_requests: cost?.window_7d_requests || 0,
      window_7d_success: cost?.window_7d_success || 0,
      window_7d_errors: cost?.window_7d_errors || 0,
      window_7d_tokens: cost?.window_7d_tokens || 0,
      input_cost: cost?.input_cost || 0,
      output_cost: cost?.output_cost || 0,
      cache_cost: (cost?.cache_read_cost || 0) + (cost?.cache_creation_cost || 0),
      today: cost?.today || null,
      window_5h: cost?.window_5h || null,
      window_7d: cost?.window_7d || null,
      near_limit:
        accountQuota?.nearLimit?.(a) ??
        isNearLimit(
          a,
          resolveTierPolicy(
            {
              tiers: snap.tiers,
              quota: { safety_ratio: snap.safety_ratio, weekly_safety_ratio: snap.weekly_safety_ratio },
            },
            accountTierKey(a),
          ),
        ),
    }
  })
  return ok({
    safety_ratio: snap.safety_ratio,
    billing: attachBillingMeta(billing, snap.accounts || []),
    accounts,
    totals: {
      requests: accounts.reduce((s, a) => s + (a.requests || 0), 0),
      tokens_in: accounts.reduce((s, a) => s + (a.tokens_in || 0), 0),
      tokens_out: accounts.reduce((s, a) => s + (a.tokens_out || 0), 0),
      cache_read_tokens: accounts.reduce((s, a) => s + (a.cache_read_tokens || 0), 0),
      cache_creation_tokens: accounts.reduce((s, a) => s + (a.cache_creation_tokens || 0), 0),
      ...cacheHitStats({
        input_tokens: accounts.reduce((s, a) => s + (a.tokens_in || 0), 0),
        cache_read_tokens: accounts.reduce((s, a) => s + (a.cache_read_tokens || 0), 0),
        cache_creation_tokens: accounts.reduce((s, a) => s + (a.cache_creation_tokens || 0), 0),
      }),
      today_cost: billing?.today?.total_cost || 0,
      total_cost: billing?.total?.total_cost || 0,
      peak_5h: Math.max(0, ...accounts.map((a) => a.utilization_5h), 0),
      peak_7d: Math.max(0, ...accounts.map((a) => a.utilization_7d), 0),
      near_limit: accounts.filter((a) => a.near_limit).length,
    },
  })
}

export function buildRouting({ routingConfig, stickyRouter }) {
  const tiers = normalizeTiers(routingConfig?.tiers, routingConfig?.quota, routingConfig?.concurrency)
  return ok({
    sticky: routingConfig?.sticky || {},
    quota: routingConfig?.quota || {},
    concurrency: routingConfig?.concurrency || {},
    tiers,
    logging: routingConfig?.logging || {},
    pool: routingConfig?.pool || {},
    failover: routingConfig?.failover || {},
    compatibility: routingConfig?.compatibility || {},
    inference: routingConfig?.inference || {},
    official_cc: normalizeOfficialCcConfig(routingConfig?.official_cc),
    health_probe: normalizeHealthProbeConfig(routingConfig?.health_probe),
    usage_probe: normalizeUsageProbeConfig(routingConfig?.usage_probe),
    notify: publicNotifyConfig(routingConfig?.notify),
    sessions: stickyRouter.stats(),
  })
}

export async function snapshotAccountPool({
  cfg,
  accountQuota,
  routingConfig,
  poolScheduler = null,
  proxyPool = null,
  requestLog = null,
}) {
  try {
    accountQuota?.runtimeRepo?.clearExpired?.(Date.now())
  } catch {}
  const active = getActiveVmId(cfg.paths.project)
  const pool = poolScheduler?.snapshot?.() || {}
  const poolSnap = snapshotPool(proxyPool)
  const listed = listVms(cfg.paths.project)
  let liveById = null
  try {
    liveById = await collectLivePanelCredentials(cfg.paths.project, listed)
  } catch {
    liveById = null
  }
  const vms = listed.map((v) => enrichVm(v, accountQuota, active, { routingConfig, pool, poolSnap, liveById }))
  const accounts = (() => {
    try {
      return accountQuota?.snapshot?.().accounts || []
    } catch {
      return []
    }
  })()
  const billing = stampVmBilling(
    vms,
    (() => {
      try {
        return attachBillingMeta(requestLog?.billingStats?.(), accounts)
      } catch {
        return null
      }
    })(),
  )
  let today = null
  try {
    today = requestLog?.windowStats?.({ since: shanghaiDayStartIso() }) || null
  } catch {
    today = null
  }
  return summarizePoolAvailability(vms, Date.now(), { billing, today })
}

function hostStats() {
  const cpus = os.cpus() || []
  const n = cpus.length || 1
  const [load1, load5, load15] = os.loadavg()
  const total = os.totalmem()
  const free = os.freemem()
  const used = Math.max(0, total - free)
  const mem = process.memoryUsage()
  return {
    cpu_count: n,
    load1,
    load5,
    load15,
    cpu_pct: Math.round(Math.min(100, (load1 / n) * 1000) / 10),
    mem_total: total,
    mem_free: free,
    mem_used: used,
    mem_pct: total ? Math.round((used / total) * 1000) / 10 : 0,
    rss: mem.rss,
    heap_used: mem.heapUsed,
    heap_total: mem.heapTotal,
    uptime: os.uptime(),
    proc_uptime: process.uptime(),
  }
}

function quotaFromAccount(acc, quotaConfig) {
  const u = acc?.unified || {}
  const listed = listQuotaFromHeaders(u)
  const sonnet = u.seven_day_sonnet || {}
  const oi =
    listed.utilization_7d_oi != null || listed.status_7d_oi || listed.reset_7d_oi
      ? { utilization: listed.utilization_7d_oi, status: listed.status_7d_oi, reset: listed.reset_7d_oi }
      : u['7d_oi'] || {}
  const fable = u.fable || null
  const extra = u.extra_usage || null
  const q = {
    utilization_5h: listed.utilization_5h,
    utilization_7d: listed.utilization_7d,
    utilization_7d_sonnet: sonnet.utilization != null ? Number(sonnet.utilization) : null,
    utilization_7d_oi:
      oi.utilization != null ? Number(oi.utilization) : fable?.utilization != null ? Number(fable.utilization) : null,
    reset_5h: listed.reset_5h || u.official?.['5h']?.reset || u['5h']?.reset || null,
    reset_7d: listed.reset_7d || u.official?.['7d']?.reset || u['7d']?.reset || null,
    reset_7d_sonnet: sonnet.reset || null,
    reset_7d_oi: oi.reset || listed.reset_7d_oi || null,
    status_5h: listed.status_5h || null,
    status_7d: listed.status_7d || null,
    status_7d_sonnet: sonnet.status || null,
    status_7d_oi: oi.status || listed.status_7d_oi || null,
    extra_usage: extra,
    fable: fable,
    last_probe: acc?.last_probe || u.last_probe || null,
    probe_source: u.source || acc?.last_probe?.source || null,
    account_tier: u.account_tier || null,
    usage_has_fable: u.usage_has_fable === true,
  }
  const cfg = weeklySplitConfig(quotaConfig || {})
  const split = publicWeeklySplit(
    computeWeeklySplit({
      enabled: cfg.enabled,
      fable_share: cfg.fable_share,
      utilization_7d: q.utilization_7d,
      utilization_7d_oi: q.utilization_7d_oi,
      status_7d_oi: q.status_7d_oi,
    }),
  )
  if (split) q.weekly_split = split
  return q
}

function fablePoolFields(acc, runtime, pool = {}, routingConfig = {}, vm = {}) {
  const keys = [acc?.account_id, vm.account_uuid, vm.id].filter(Boolean)
  let family = {}
  for (const key of keys) {
    if (pool.inflight_family?.[key]) {
      family = pool.inflight_family[key]
      break
    }
  }
  const fableMax = Number(routingConfig?.concurrency?.fable_max_per_account ?? pool.fable_max_per_account ?? 4)
  const states = runtime?.model_states || {}
  const fableState = states.fable || states['claude-fable-5'] || null
  const until = Number(fableState?.cooldown_until) || 0
  return {
    fable_inflight: Number(family.fable || 0) || 0,
    fable_max: Number.isFinite(fableMax) && fableMax > 0 ? fableMax : 4,
    fable_cooldown_until: until > Date.now() ? until : null,
    fable_cooldown_reason: until > Date.now() ? fableState?.reason || null : null,
  }
}

export { inferClaudeTier } from '../pool/claude-tier.mjs'

export function normalizePanelExpiresAt(expiresAt, workerExpiresAt = null) {
  const best = Math.max(expiresAtToMs(expiresAt), expiresAtToMs(workerExpiresAt))
  return best || null
}

function expiresAtToMs(expiresAt) {
  if (expiresAt == null || expiresAt === '') return 0
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
    return expiresAt < 10_000_000_000 ? expiresAt * 1000 : expiresAt
  }
  const str = String(expiresAt).trim()
  if (!str) return 0
  if (/^\d+(\.\d+)?$/.test(str)) {
    const n = Number(str)
    if (!Number.isFinite(n) || n <= 0) return 0
    return n < 10_000_000_000 ? n * 1000 : n
  }
  const parsed = Date.parse(str)
  return Number.isFinite(parsed) ? parsed : 0
}

export function credStatusFromQuota(hasToken, q = {}, expiresAt = null, extras = {}) {
  return credStatusFromAvailability(
    evaluateAccount({
      vm: extras.vm || {},
      hasToken,
      hasRefresh: extras.has_refresh,
      schedulable: extras.schedulable,
      scheduleDisabledReason: extras.schedule_disabled_reason,
      lastProbe: extras.last_probe || q.last_probe,
      probeSource: q.probe_source,
      workerLastError: extras.worker_credential?.last_error || extras.runtime?.worker_status?.last_error,
      refreshError: extras.refresh_error || extras.worker_credential?.refresh_error,
      expiresAt,
      refreshedAt: extras.refreshed_at || extras.oauth_refreshed_at || null,
      workerCredential: extras.worker_credential || extras.runtime?.worker_status?.credential || null,
      quota: q,
      policy: extras.policy,
      sessionLimit: extras.sessionLimit,
      cooldownUntil: extras.cooldown_until,
      cooldownReason: extras.cooldown_reason,
    }),
  )
}

function poolProxyForVm(v, poolSnap) {
  const list = poolSnap?.proxies || []
  if (!list.length) return null
  const id = v.proxy_id || v.proxy?.id
  return list.find((p) => (id && p.id === id) || proxyHasVm(p, v.id)) || null
}

function proxyConfigured(v, hit) {
  const base = v.proxy || {}
  return !!(base.host || base.url || base.id || v.proxy_id || hit)
}

function canImportCredential(v, hit) {
  if (hit) return !!(hit.enabled && hit.status !== 'dead' && hit.status !== 'fail')
  const base = v.proxy || {}
  return !!(base.url || (base.host && base.port) || v.proxy_id)
}

function mergeVmProxy(v, poolSnap) {
  const hit = poolProxyForVm(v, poolSnap)
  const base = v.proxy || {}
  const configured = proxyConfigured(v, hit)
  if (!configured) {
    return { proxy: null, proxy_configured: false, can_import_credential: false }
  }
  return {
    proxy: {
      id: hit?.id || base.id || v.proxy_id || null,
      host: hit?.host || base.host || null,
      port: hit?.port || base.port || null,
      scheme: base.scheme || 'socks5',
      has_auth: hit?.has_auth ?? !!(base.url && /\/\/[^/@]+@/.test(base.url)),
      status: hit?.status ?? null,
      enabled: hit?.enabled ?? null,
      latency_ms: hit?.latency_ms ?? null,
      last_error: hit?.last_error || null,
      last_probe_at: hit?.last_probe_at || null,
      geo: hit?.geo || null,
      configured: true,
    },
    proxy_configured: true,
    can_import_credential: canImportCredential(v, hit),
  }
}

function enrichVm(v, accountQuota, active, extras = {}) {
  const acc = findAccount(accountQuota, v)
  const runtime = findRuntime(accountQuota, v)
  const liveCred = extras.liveById instanceof Map ? extras.liveById.get(v.id) : extras.liveById?.[v.id]
  const workerCred = liveCred || runtime?.worker_status?.credential || null
  const q = quotaFromAccount(
    {
      ...acc,
      last_used_at: acc?.last_used_at || runtime?.last_used_at || null,
    },
    accountQuota?.config,
  )
  const fablePool = fablePoolFields(acc, runtime, extras.pool || {}, extras.routingConfig || {}, v)
  const scheduleLevel = resolveCredentialScheduleLevel({
    manualLevel: v.schedule_level_manual,
    unified: acc?.unified || {},
  })
  const isCodex = isCodexVm(v)
  const mergedQuota = isCodex && v.codex_usage?.quota ? { ...q, ...v.codex_usage.quota } : q
  const u5 = mergedQuota.utilization_5h
  const u7 = mergedQuota.utilization_7d
  const merged = mergeVmProxy(v, extras.poolSnap || null)
  const expiresAt = normalizePanelExpiresAt(v.expires_at, workerCred?.expires_at)
  const hasToken = isCodex ? !!(v.has_token || v.has_refresh) : !!(v.has_token || workerCred?.has_access)
  const tierKey = isCodex
    ? 'codex'
    : inferClaudeTier(
        {
          has_token: hasToken,
          account_tier: v.account_tier || q.account_tier,
          fable: q.fable,
          utilization_7d_oi: q.utilization_7d_oi,
          reset_7d_oi: q.reset_7d_oi,
          status_7d_oi: q.status_7d_oi,
          usage_has_fable: q.usage_has_fable,
        },
        q,
      ).key
  const policy = resolveTierPolicy(
    {
      tiers: extras.routingConfig?.tiers || accountQuota?.tiers,
      quota: extras.routingConfig?.quota || accountQuota?.config,
      concurrency: extras.routingConfig?.concurrency || accountQuota?.concurrency,
    },
    tierKey,
  )
  const safety = Number(policy.limit_5h ?? policy.safety_ratio ?? 0.85)
  const weeklySafety = Number(policy.limit_7d ?? policy.weekly_safety_ratio ?? 0.8)
  const sessionLimit = extras.sessionLimit || accountQuota?.sessions || null
  const sessions = sessionLimit?.snapshot?.(acc?.account_id || v.account_uuid || v.id, {
    max: Number(v.max_sessions ?? policy.max_sessions ?? 0),
    idleMin: policy.session_idle_min,
  }) || { active: 0, max: Number(v.max_sessions ?? policy.max_sessions ?? 0), idle_min: policy.session_idle_min }
  const availability = evaluateAccount({
    vm: v,
    account: acc || {},
    hasToken,
    hasRefresh: !!(v.has_refresh || workerCred?.has_refresh),
    schedulable: v.schedulable !== false,
    scheduleDisabledReason: v.schedule_disabled_reason || null,
    lastProbe: q.last_probe || null,
    probeSource: q.probe_source,
    workerLastError: workerCred?.last_error || runtime?.worker_status?.last_error || runtime?.worker_status?.error,
    refreshError: runtime?.refresh_error || v.refresh_error || v.claude?.refresh_error,
    expiresAt,
    refreshedAt: v.refreshed_at || v.claude?.refreshed_at || null,
    workerCredential: workerCred,
    quota: mergedQuota,
    policy,
    sessionLimit,
    cooldownUntil: runtime?.cooldown_until || v.claude?.temp_unschedulable_until || v.cooldown_until || null,
    cooldownReason: runtime?.cooldown_reason || v.claude?.temp_unschedulable_reason || v.cooldown_reason || null,
  })
  return {
    id: v.id,
    name: v.name,
    status: v.status,
    active: v.id === active,
    kernel: v.kernel || null,
    inference_engine: v.inference_engine || null,
    persona_preset: v.persona_preset || null,
    resolved_inference_engine: resolveInferenceEngine(v, extras.routingConfig || {}),
    resolved_persona_preset: resolveSlotPersonaPreset(v, extras.routingConfig || {}),
    note: v.note || null,
    region: v.region || null,
    timezone: v.timezone || null,
    timezone_source: v.timezone_source || 'auto',
    locale: v.locale || null,
    platform: isCodex ? 'openai' : v.platform || 'anthropic',
    family: isCodex ? 'codex' : v.family || 'claude',
    codex_kernel: !!isCodex,
    email: v.email,
    account_uuid: v.account_uuid,
    org_uuid: v.org_uuid || null,
    has_token: hasToken,
    expires_at: expiresAt,
    oauth_source: v.oauth_source || null,
    credential_mode: v.credential_mode || v.claude?.mode || 'oauth',
    auth_scheme: v.auth_scheme || v.claude?.auth_scheme || null,
    has_refresh: !!(v.has_refresh || workerCred?.has_refresh),
    has_session_key: !!v.has_session_key,
    proxy: merged.proxy,
    proxy_id: merged.proxy?.id || v.proxy_id || v.proxy?.id || null,
    proxy_configured: merged.proxy_configured,
    can_import_credential: merged.can_import_credential,
    proxy_cli_enabled: !!v.proxy_cli_enabled,
    seed_policy: v.seed_policy || null,
    max_concurrency: v.max_concurrency,
    max_rpm: acc?.max_rpm ?? v.max_rpm ?? 0,
    rpm: acc?.rpm ?? 0,
    allowed_models: Array.isArray(v.allowed_models) ? v.allowed_models : null,
    weight: v.weight ?? 1,
    schedule_level: scheduleLevel.level,
    schedule_level_mode: scheduleLevel.mode,
    claude_code_version: v.claude_code_version,
    utilization_5h: u5,
    utilization_7d: u7,
    utilization_7d_sonnet: isCodex ? null : q.utilization_7d_sonnet,
    utilization_7d_oi: isCodex ? null : q.utilization_7d_oi,
    reset_5h: mergedQuota.reset_5h ?? q.reset_5h,
    reset_7d: mergedQuota.reset_7d ?? q.reset_7d,
    reset_7d_sonnet: isCodex ? null : q.reset_7d_sonnet,
    reset_7d_oi: isCodex ? null : q.reset_7d_oi,
    status_5h: mergedQuota.status_5h ?? q.status_5h,
    status_7d: mergedQuota.status_7d ?? q.status_7d,
    status_7d_sonnet: isCodex ? null : q.status_7d_sonnet,
    status_7d_oi: isCodex ? null : q.status_7d_oi,
    codex_usage: v.codex_usage || null,
    reset_credits: isCodex ? v.reset_credits || v.codex?.reset_credits || null : null,
    ...(q.weekly_split ? { weekly_split: q.weekly_split } : {}),
    fable_inflight: fablePool.fable_inflight,
    fable_max: fablePool.fable_max,
    fable_cooldown_until: fablePool.fable_cooldown_until,
    fable_cooldown_reason: fablePool.fable_cooldown_reason,
    extra_usage: q.extra_usage,
    fable: q.fable,
    last_probe: q.last_probe,
    probe_source: q.probe_source,
    refreshed_at: v.refreshed_at || null,
    refresh_status: liveCred?.credential_state || runtime?.refresh_status || null,
    worker_credential: workerCred
      ? {
          has_access: !!workerCred.has_access,
          has_refresh: !!workerCred.has_refresh,
          needs_refresh: !!workerCred.needs_refresh,
          credential_state: workerCred.credential_state || null,
          expires_at: workerCred.expires_at ?? null,
          ttl_seconds: workerCred.ttl_seconds ?? null,
          generation: workerCred.generation ?? null,
          last_error_class: workerCred.last_error_class || runtime?.worker_status?.last_error_class || null,
          last_error:
            workerCred.last_error || runtime?.worker_status?.last_error || runtime?.worker_status?.error || null,
          source: workerCred.source || (liveCred ? 'live' : 'runtime'),
          observed_at: workerCred.observed_at || null,
        }
      : null,
    account_tier: tierKey,
    usage_has_fable: isCodex ? false : !!q.usage_has_fable,
    cred_status: credStatusFromAvailability(availability),
    refresh_error: v.refresh_error || v.claude?.refresh_error || runtime?.refresh_error || null,
    sessions,
    session_active: sessions.active,
    session_max: sessions.max,
    inflight: acc?.inflight ?? 0,
    requests: acc?.requests ?? v.stats?.requests ?? 0,
    tokens_in: acc?.tokens_in ?? 0,
    tokens_out: acc?.tokens_out ?? 0,
    cache_read_tokens: acc?.cache_read_tokens || 0,
    cache_creation_tokens: acc?.cache_creation_tokens || 0,
    near_limit: (u5 != null && u5 >= safety) || (u7 != null && u7 >= weeklySafety),
    fingerprint: v.fingerprint || null,
    runtime: v.runtime || null,
    ip: v.ip || v.runtime?.ip || null,
    pid: v.pid || v.runtime?.pid || null,
    container: v.container || v.runtime?.container || null,
    schedulable: v.schedulable !== false,
    schedule_manual: v.schedule_manual === true,
    schedule_disabled_reason: v.schedule_disabled_reason || null,
    created_at: v.created_at || null,
  }
}

function isLeftoverVmKeyedAccount(account, vm) {
  if (!account || !vm) return false
  const leftoverId = account.account_id === vm.id && account.account_id !== vm.account_uuid
  return leftoverId && !account.email
}

function isSeedAccountRow(account) {
  if (!account) return false
  const unified = account.unified || {}
  const probe = account.last_probe || unified.last_probe
  if (probe && (probe.ok === true || probe.ok === false || probe.at)) return false
  const w5 = unified.official?.['5h'] || unified['5h'] || {}
  const util = Number(w5.utilization || 0)
  const status = String(w5.status || 'active').toLowerCase()
  return util === 0 && (status === 'active' || !w5.status) && !unified.official
}

function findAccount(accountQuota, vm) {
  if (!accountQuota || typeof accountQuota.snapshot !== 'function') return null
  const snap = accountQuota.snapshot()
  const accounts = snap.accounts || []
  if (vm.account_uuid) {
    const byUuid = accounts.find((a) => a.account_id === vm.account_uuid)
    if (byUuid && !isSeedAccountRow(byUuid)) return byUuid
  }
  return (
    accounts.find(
      (a) => (a.vm_id === vm.id || a.account_id === vm.id) && !isLeftoverVmKeyedAccount(a, vm) && !isSeedAccountRow(a),
    ) || (vm.account_uuid ? accounts.find((a) => a.account_id === vm.account_uuid) : null)
  )
}

function findRuntime(accountQuota, vm) {
  try {
    const repo = accountQuota?.runtimeRepo
    if (!repo?.get) return null
    const acc = findAccount(accountQuota, vm)
    const keys = [vm.account_uuid, acc?.account_id, vm.id].filter(Boolean)
    for (const key of keys) {
      const state = repo.get(key)
      if (!state) continue
      const cred = state.worker_status?.credential || {}
      const err = String(state.worker_status?.last_error || state.last_error || '')
      const leftoverKey = key === vm.id && vm.account_uuid && key !== vm.account_uuid
      const leftover =
        leftoverKey &&
        (!cred.has_access ||
          /refresh_token_missing|invalid_grant|worker_unhealthy/.test(err + String(state.status || '')))
      const live = !!(vm.has_refresh || vm.has_token || vm.account_uuid)
      if (leftover && live) continue
      return freshenRuntimeState(state, vm, repo)
    }
  } catch {}
  return null
}

/** Drop stale worker TTL / last_error / leftover revoke when vm.json already has a live ticket. */
function freshenRuntimeState(state, vm, repo = null) {
  if (!state) return state
  if (
    isLeftoverGrantRevokeRuntime(state, vm, {
      has_token: vm.has_token || vm.claude?.has_access,
      has_refresh: vm.has_refresh || vm.claude?.has_refresh,
      refresh_error: vm.refresh_error || vm.claude?.refresh_error,
      schedule_disabled_reason: vm.schedule_disabled_reason,
    })
  ) {
    try {
      repo?.clearGrantRevokeCooldown?.(state.account_id, { vmId: vm.id })
    } catch {}
    state = viewRuntimeWithoutLeftoverRevoke(state, vm, {
      has_token: vm.has_token || vm.claude?.has_access,
      has_refresh: vm.has_refresh || vm.claude?.has_refresh,
      refresh_error: vm.refresh_error || vm.claude?.refresh_error,
      schedule_disabled_reason: vm.schedule_disabled_reason,
    })
  }
  const cred = state.worker_status?.credential
  const lastError = String(state.worker_status?.last_error || state.worker_status?.error || '')
  const leftover = /invalid_grant|refresh token not found|oauth_revoked|credential_refresh_failed/i.test(lastError)
  const wMs = expiresAtToMs(cred?.expires_at)
  const vMs = expiresAtToMs(vm.expires_at)
  const liveMs = Math.max(wMs || 0, vMs || 0)
  const accessLive = liveMs > Date.now() && !!(cred?.has_access || vm.has_token)
  if (accessLive && leftover) {
    return {
      ...state,
      refresh_status: 'fresh',
      worker_status: {
        ...state.worker_status,
        ok: true,
        last_error: null,
        last_error_class: null,
        credential: cred
          ? {
              ...cred,
              expires_at: vMs && vMs > (wMs || 0) ? vm.expires_at : cred.expires_at,
              needs_refresh: false,
              has_access: !!(cred.has_access || vm.has_token),
              has_refresh: !!(cred.has_refresh || vm.has_refresh),
            }
          : cred,
      },
    }
  }
  if (!cred) return state
  if (!vMs || !wMs || vMs <= wMs) return state
  return {
    ...state,
    refresh_status: 'fresh',
    worker_status: {
      ...state.worker_status,
      ok: true,
      last_error: null,
      credential: {
        ...cred,
        expires_at: vm.expires_at,
        needs_refresh: false,
        has_access: !!(cred.has_access || vm.has_token),
        has_refresh: !!(cred.has_refresh || vm.has_refresh),
      },
    },
  }
}

function billingRowScore(row) {
  return (
    Number(row?.today_requests || 0) +
    Number(row?.today?.requests || 0) +
    Number(row?.today_cache_read_tokens || 0) +
    Number(row?.today?.cache_read_tokens || 0) +
    Number(row?.requests || 0)
  )
}

function isLeftoverBillingRow(row) {
  if (!row) return false
  const id = String(row.account_id || '')
  const vm = String(row.vm_id || '')
  return !!(vm && (id === vm || /^vm-\d+$/i.test(id)) && billingRowScore(row) === 0)
}

export function indexBillingAccounts(billing) {
  const map = new Map()
  const set = (key, row) => {
    const prev = map.get(key)
    if (!prev) {
      map.set(key, row)
      return
    }
    if (isLeftoverBillingRow(row) && !isLeftoverBillingRow(prev)) return
    if (isLeftoverBillingRow(prev) && !isLeftoverBillingRow(row)) {
      map.set(key, row)
      return
    }
    if (billingRowScore(row) >= billingRowScore(prev)) map.set(key, row)
  }
  for (const row of billing?.accounts || []) {
    if (row.account_id) set('id:' + row.account_id, row)
    if (row.vm_id) set('vm:' + row.vm_id, row)
  }
  return map
}

export function lookupBilling(index, accOrVm) {
  if (!index || !accOrVm) return null
  const keys = [
    accOrVm.account_id && 'id:' + accOrVm.account_id,
    accOrVm.account_uuid && 'id:' + accOrVm.account_uuid,
    accOrVm.vm_id && 'vm:' + accOrVm.vm_id,
    accOrVm.id && 'vm:' + accOrVm.id,
    accOrVm.id && 'id:' + accOrVm.id,
    accOrVm.account_id && 'vm:' + accOrVm.account_id,
    accOrVm.account_uuid && 'vm:' + accOrVm.account_uuid,
  ].filter(Boolean)
  let leftover = null
  for (const k of keys) {
    if (!index.has(k)) continue
    const row = index.get(k)
    if (isLeftoverBillingRow(row)) {
      leftover = leftover || row
      continue
    }
    return row
  }
  return leftover
}

function attachBillingMeta(billing, accounts = []) {
  if (!billing) return null
  const labeled = (billing.accounts || []).map((row) => {
    const acc = (accounts || []).find((a) => a.account_id === row.account_id || a.vm_id === row.vm_id)
    return {
      ...row,
      email: acc?.email || row.email || null,
    }
  })
  return {
    source: billing.source || 'anthropic-official',
    currency: billing.currency || 'USD',
    today_start: billing.today_start,
    window_5h_start: billing.window_5h_start,
    today: billing.today,
    window_5h: billing.window_5h,
    total: billing.total,
    accounts: labeled,
  }
}

function stampVmBilling(vms, billing) {
  if (!billing) return null
  const index = indexBillingAccounts(billing)
  for (const vm of vms || []) {
    applyCostFields(vm, lookupBilling(index, vm))
  }
  return billing
}

function cacheCostOf(row) {
  return Number(row?.cache_read_cost || 0) + Number(row?.cache_creation_cost || 0)
}

function periodView(row) {
  if (!row || typeof row !== 'object') return null
  return {
    requests: Number(row.requests || 0),
    input_tokens: Number(row.input_tokens || 0),
    output_tokens: Number(row.output_tokens || 0),
    cache_read_tokens: Number(row.cache_read_tokens || 0),
    cache_creation_tokens: Number(row.cache_creation_tokens || 0),
    input_cost: Number(row.input_cost || 0),
    output_cost: Number(row.output_cost || 0),
    cache_read_cost: Number(row.cache_read_cost || 0),
    cache_creation_cost: Number(row.cache_creation_cost || 0),
    cache_cost: cacheCostOf(row),
    total_cost: Number(row.total_cost || 0),
  }
}

function applyCostFields(target, cost) {
  if (!target) return
  const today = cost?.today && typeof cost.today === 'object' ? cost.today : null
  const todayInput = Number(cost?.today_input_tokens ?? (today?.input_tokens || 0))
  const todayRead = Number(cost?.today_cache_read_tokens ?? (today?.cache_read_tokens || 0))
  const todayWrite = Number(cost?.today_cache_creation_tokens ?? (today?.cache_creation_tokens || 0))
  const todayOut = Number(cost?.today_output_tokens ?? (today?.output_tokens || 0))
  target.today_cost = cost?.today_cost ?? today?.total_cost ?? 0
  target.total_cost = cost?.total_cost || 0
  target.today_requests = cost?.today_requests ?? today?.requests ?? 0
  target.today_tokens = todayInput + todayOut
  target.today_input_tokens = todayInput
  target.today_cache_read_tokens = todayRead
  target.today_cache_creation_tokens = todayWrite
  target.cache_hit_rate = cacheHitStats({
    input_tokens: todayInput,
    cache_read_tokens: todayRead,
    cache_creation_tokens: todayWrite,
  }).cache_hit_rate
  target.window_5h_cost = cost?.window_5h_cost || 0
  target.window_5h_requests = cost?.window_5h_requests || 0
  target.window_5h_tokens = cost?.window_5h_tokens || 0
  target.window_7d_cost = cost?.window_7d_cost || 0
  target.window_7d_requests = cost?.window_7d_requests || 0
  target.window_7d_success = cost?.window_7d_success || 0
  target.window_7d_errors = cost?.window_7d_errors || 0
  target.window_7d_tokens = cost?.window_7d_tokens || 0
}

function buildAccountBilling(cost, billing, { vmId, accountId, requestLog } = {}) {
  if (!cost && !vmId && !accountId) return null
  const today = periodView(cost?.today) || {
    requests: Number(cost?.today_requests || 0),
    input_tokens: Number(cost?.today_input_tokens || 0),
    output_tokens: Number(cost?.today_output_tokens || 0),
    cache_read_tokens: Number(cost?.today_cache_read_tokens || 0),
    cache_creation_tokens: Number(cost?.today_cache_creation_tokens || 0),
    input_cost: Number(cost?.today_input_cost || 0),
    output_cost: Number(cost?.today_output_cost || 0),
    cache_cost: Number(cost?.today_cache_cost || 0),
    cache_read_cost: 0,
    cache_creation_cost: 0,
    total_cost: Number(cost?.today_cost || 0),
  }
  const window5h = periodView(cost?.window_5h) || {
    requests: Number(cost?.window_5h_requests || 0),
    input_tokens: Number(cost?.window_5h_input_tokens || 0),
    output_tokens: Number(cost?.window_5h_output_tokens || 0),
    cache_read_tokens: Number(cost?.window_5h_cache_read_tokens || 0),
    cache_creation_tokens: Number(cost?.window_5h_cache_creation_tokens || 0),
    input_cost: Number(cost?.window_5h_input_cost || 0),
    output_cost: Number(cost?.window_5h_output_cost || 0),
    cache_cost: Number(cost?.window_5h_cache_cost || 0),
    cache_read_cost: 0,
    cache_creation_cost: 0,
    total_cost: Number(cost?.window_5h_cost || 0),
  }
  const window7d = periodView(cost?.window_7d) || {
    requests: Number(cost?.window_7d_requests || 0),
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    input_cost: 0,
    output_cost: 0,
    cache_cost: 0,
    cache_read_cost: 0,
    cache_creation_cost: 0,
    total_cost: Number(cost?.window_7d_cost || 0),
  }
  const total = periodView(cost)
  let byModel = []
  try {
    byModel = requestLog?.costByModel?.({ vmId, accountId }) || []
  } catch {
    byModel = []
  }
  if (!cost && !byModel.length) return null
  return {
    source: billing?.source || 'anthropic-official',
    currency: billing?.currency || 'USD',
    today_start: billing?.today_start || null,
    window_5h_start: billing?.window_5h_start || null,
    window_7d_start: billing?.window_7d_start || null,
    today,
    window_5h: window5h,
    window_7d: window7d,
    total,
    by_model: byModel,
    today_cost: today?.total_cost || 0,
    total_cost: total?.total_cost || 0,
    window_5h_cost: window5h?.total_cost || 0,
    window_7d_cost: window7d?.total_cost || 0,
    today_requests: today?.requests || 0,
    requests: total?.requests || 0,
    input_cost: total?.input_cost || 0,
    output_cost: total?.output_cost || 0,
    cache_cost: total?.cache_cost || 0,
  }
}
