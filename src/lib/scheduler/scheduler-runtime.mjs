/**
 * Unified Node.js control-plane runtime facade for the Rust `kin-scheduler`
 * sidecar (PR-6 / M3 — single scheduling authority, zero Node fallback).
 *
 * Responsibilities:
 * - Owns the singleton `SchedulerClient` lifecycle (start, bootstrap, standby/leader
 *   role transitions on SIGUSR1/SIGUSR2, 30s lease heartbeats, graceful shutdown).
 * - Compiles the authoritative `ConfigSnapshot` from SQLite/PG (`scheduler_pools`,
 *   `scheduler_pool_members`, trusted JEV downgrade pools, global prompt policy),
 *   VM inventory (`claude_vm` / `codex_vm`), Gemini environments (`gemini_env`),
 *   API endpoints (`api_endpoint`), plus synthesized virtual default pools for
 *   seamless `legacy_scope` / master-key migration.
 * - Pushes high-frequency `/internal/v1/nodes/telemetry` batches (2s health, quota,
 *   active_hours, host_memory_pressure, proxy_ready, crag_license_ok, blue/green
 *   handover `external_in_flight`) without bumping `config_version`.
 * - Runs the Leader-only 1s `/internal/v1/persistence/drain` loop and final
 *   synchronous shutdown drain into `SchedulerPoolsRepo` (`KIN_STANDBY=1` strictly
 *   forbids drain until promoted via `promoteToLeader()`).
 * - Exposes ergonomic scheduling and admin methods (`acquireNode`, `switchNode`,
 *   `commitLease`, `releaseLease`, `explainDispatch`, `unrestNode`, `querySticky`,
 *   `deleteSticky`, `subscribeEvents`, `syncConfigNow`, `pushTelemetryNow`).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { keyAllowsModel, parseKeyAllowedModels } from '../admin/key-models.mjs'
import {
  keyAllowsEndpoint,
  keyAllowsGeminiEnv,
  keyAllowsVm,
  keyTierPolicyFromRecord,
  normalizeGroupType,
} from '../admin/key-scope.mjs'
import {
  PLATFORM_SCOPE,
  endpointOwnerId,
  normalizeOwnerId,
  ownerScopeFromApiKey,
  vmOwnerId,
} from '../admin/resource-owner.mjs'
import { HOST_PRESSURE_CRITICAL, hostMemoryLevelForVm } from '../cluster/host-memory-pressure.mjs'
import { getDb, isDbOpen, withTransaction } from '../db/database.mjs'
import {
  SchedulerPoolsRepo,
  defaultSystemPromptModeForProvider,
  normalizeProviderScope,
} from '../db/repos/scheduler-pools-repo.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { resolveUpstreamModel, stripAntigravityPrefix } from '../gemini/model-catalog.mjs'
import { OFFICIAL_303_PRESET, normalizePersonaPreset } from '../identity/persona-template.mjs'
import { activeHoursOf, evaluateActiveHours } from '../pool/active-hours.mjs'
import { endpointMatchesModel, stripPrefix } from '../pool/api-scheduler.mjs'
import { isLeftoverQuotaScheduleOff } from '../pool/availability.mjs'
import { isCodexSlotParked } from '../pool/codex-slot-pool.mjs'
import { normalizeOpenAIQuotaPolicy } from '../pool/openai-quota-policy.mjs'
import { resolveCredentialScheduleLevel } from '../pool/credential-weight.mjs'
import { modelMatchesAllowlist } from '../pool/slot-model-gate.mjs'
import { isConcurrencyPinned } from '../pool/tier-limits.mjs'
import { normalizeCragPersonaPreset } from '../protocol/crag-print-prompt.mjs'
import { resolveGlobalZeroInject } from '../protocol/pool-prompt-policy.mjs'
import { peekRustHealth } from '../transport/kernel-router.mjs'
import {
  DEFAULT_DRAIN_INTERVAL_MS,
  SchedulerApiError,
  SchedulerUnavailableError,
  createSchedulerClient,
} from '../transport/scheduler-client.mjs'
import { isCragDebian13Kernel, isCustomKvmMode, isCustomOsSlot } from '../vm/custom-os-runtime.mjs'
import { proxyBlockedReason } from '../vm/proxy-policy.mjs'
import { isKvmRuntime } from '../vm/runtime-kind.mjs'
import { effectiveSlotCount, isHeadlessBridgeSlot } from '../vm/slot-capacity.mjs'
import { activeCragManifestForSlot, resolveKernelDataplane } from '../vm/slot-engine.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { listVms } from '../vm/vm-registry.mjs'

export { SchedulerApiError, SchedulerUnavailableError }

export const PLATFORM_OWNER_SENTINEL = '__platform__'

export const VIRTUAL_POOL_IDS = Object.freeze({
  claude: '__virtual_claude__',
  codex: '__virtual_codex__',
  gemini: '__virtual_gemini__',
  api: '__virtual_api__',
  all: '__virtual_all__',
})

export const DEFAULT_TELEMETRY_INTERVAL_MS = 2_000
const PERMANENT_PENALTY_THRESHOLD_MS = 8e15

const VIRTUAL_POOL_SET = new Set(Object.values(VIRTUAL_POOL_IDS))

export function scopeSchedulerRequestId(rawRequestId, scope = {}) {
  const raw = String(rawRequestId || '').trim() || crypto.randomUUID()
  const apiScope = scope.api_key_scope || {}
  const sortedUnique = (arr) =>
    Array.isArray(arr) ? [...new Set(arr.map((v) => String(v || '').trim()).filter(Boolean))].sort() : []
  const canonicalScope = JSON.stringify({
    api_key_id: String(apiScope.api_key_id || ''),
    pool_binding_mode: String(apiScope.pool_binding_mode || ''),
    owner_id: apiScope.owner_id ?? null,
    strict_tenant_only: Boolean(apiScope.strict_tenant_only),
    origin_pool_id: String(scope.origin_pool_id || ''),
    jev_downgrade_pool_id: scope.jev_downgrade_pool_id ?? null,
    default_pool_id: apiScope.default_pool_id ?? null,
    allowed_pool_ids: sortedUnique(apiScope.allowed_pool_ids),
    allowed_models: sortedUnique(apiScope.allowed_models),
    allowed_node_keys: sortedUnique(apiScope.allowed_node_keys),
    model: String(scope.model || ''),
    model_family: String(scope.model_family || ''),
    protocol: String(scope.protocol || ''),
    pin_node_key: scope.pin_node_key ?? null,
    is_admin_diagnostic: Boolean(scope.is_admin_diagnostic),
  })
  const scopeHash = crypto.createHash('sha256').update(canonicalScope).digest('hex').slice(0, 24)
  const prefix = `sr_${scopeHash}_`
  // Idempotent when the same scoped request_id is forwarded into switchNode under the exact same scope.
  if (raw.startsWith(prefix) && raw.length === prefix.length + 24) {
    return raw
  }
  const idHash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)
  return `${prefix}${idHash}`
}

export function isVirtualPoolId(poolId) {
  return VIRTUAL_POOL_SET.has(String(poolId || ''))
}

export function formatNodeKey(nodeType, nodeId) {
  const t = String(nodeType || '').trim()
  const id = String(nodeId || '').trim()
  if (!t || !id) return ''
  return `${t}:${id}`
}

export function parseNodeKey(nodeKey) {
  const raw = String(nodeKey || '').trim()
  const idx = raw.indexOf(':')
  if (idx <= 0 || idx === raw.length - 1) return null
  return {
    node_type: raw.slice(0, idx).trim(),
    node_id: raw.slice(idx + 1).trim(),
  }
}

export function inferModelFamily(model, protocol = '') {
  const m = String(model || '')
    .trim()
    .toLowerCase()
    .replace(/^models\//, '')
  if (m) {
    if (m.startsWith('ag-')) return 'gemini'
    if (m.startsWith('claude')) return 'claude'
    if (m.startsWith('gemini') || m.startsWith('imagen') || m.startsWith('veo') || m.startsWith('gemma')) {
      return 'gemini'
    }
    if (m.startsWith('gpt-') || m.startsWith('chatgpt-') || m.startsWith('codex') || /^o[134](?:-|$)/.test(m)) {
      return 'openai'
    }
  }
  const p = String(protocol || '')
    .trim()
    .toLowerCase()
  if (p.startsWith('anthropic') || p.startsWith('claude') || p === 'messages') return 'claude'
  if (
    p.startsWith('openai') ||
    p.startsWith('codex') ||
    p === 'responses' ||
    p === 'chat' ||
    p === 'images' ||
    p === 'search'
  ) {
    return 'openai'
  }
  if (p.startsWith('google') || p.startsWith('gemini')) return 'gemini'
  return 'other'
}

export function resolveVirtualPoolId({ modelFamily = null, nodeTypes = null, provider = null } = {}) {
  const types = Array.isArray(nodeTypes) ? nodeTypes.filter(Boolean) : []
  if (types.length === 1) {
    if (types[0] === 'claude_vm') return VIRTUAL_POOL_IDS.claude
    if (types[0] === 'codex_vm') return VIRTUAL_POOL_IDS.codex
    if (types[0] === 'gemini_env') return VIRTUAL_POOL_IDS.gemini
    if (types[0] === 'api_endpoint') return VIRTUAL_POOL_IDS.api
  }
  const prov = String(provider || '')
    .trim()
    .toLowerCase()
  if (prov === 'anthropic' || prov === 'claude') return VIRTUAL_POOL_IDS.claude
  if (prov === 'openai' || prov === 'codex') return VIRTUAL_POOL_IDS.codex
  if (prov === 'google' || prov === 'gemini') return VIRTUAL_POOL_IDS.gemini
  if (prov === 'api' || prov === 'api_custom') return VIRTUAL_POOL_IDS.api

  if (modelFamily === 'claude') return VIRTUAL_POOL_IDS.claude
  if (modelFamily === 'openai') return VIRTUAL_POOL_IDS.codex
  if (modelFamily === 'gemini') return VIRTUAL_POOL_IDS.gemini
  return VIRTUAL_POOL_IDS.all
}

export function classifyErrorClass({
  status = 0,
  errorCode = '',
  reason = '',
  upstreamType = '',
  isTimeout = false,
  isTransport = false,
} = {}) {
  const st = Number(status) || 0
  const sig = `${errorCode || ''} ${reason || ''} ${upstreamType || ''}`.toLowerCase()
  if (isTimeout || st === 504 || st === 408 || /timeout|timed_out/.test(sig)) return 'timeout'
  if (
    isTransport ||
    /econnrefused|econnreset|epipe|enotfound|etimedout|socket|transport|network|fetch failed/.test(sig)
  ) {
    return 'transport'
  }
  if (
    /permanent_ban|account_banned|organization_disabled|oauth_revoked|invalid_grant|token_revoked|account_ineligible|verification_required|location_unsupported/.test(
      sig,
    )
  ) {
    return 'permanent_ban'
  }
  if (/jev_block|jev_intercept|intercept_block/.test(sig)) return 'jev_blocked'
  if (/refusal/.test(sig)) return 'refusal'
  if (/context_length|context_too_long|prompt_too_long|too_many_tokens/.test(sig)) return 'context_too_long'
  if (st === 529 || /overload/.test(sig)) return 'overloaded529'
  if (/quota_exhausted|account_quota_exhausted|insufficient_quota|usage_limit/.test(sig)) return 'quota_exhausted'
  if (st === 429 || /rate_limit/.test(sig)) return 'rate_limit429'
  if (st === 401 || st === 403 || /auth_error|authentication|unauthorized|permission_denied|oauth_required/.test(sig)) {
    return 'auth_error'
  }
  if (st >= 500 && st <= 599) return 'server5xx'
  if (st >= 400 && st <= 499) return 'client4xx'
  return 'unknown'
}

export function formatSchedulerError(err) {
  if (err instanceof SchedulerUnavailableError) {
    return {
      ...err.toHttpError(),
      code: 'scheduler_unavailable',
      explain: null,
    }
  }
  if (err instanceof SchedulerApiError) {
    const status = Number(err.status) || 503
    const retryAfterSec = err.retryAfterSec != null ? Number(err.retryAfterSec) : null
    const headers = retryAfterSec != null ? { 'retry-after': String(retryAfterSec) } : {}
    let errorType = 'api_error'
    if (status === 429) errorType = 'rate_limit_error'
    else if (status === 403) errorType = 'permission_error'
    else if (status === 400 || status === 422) errorType = 'invalid_request_error'
    else if (status === 503) errorType = 'overloaded_error'
    // Security: NEVER copy `err.explain` (which carries internal `node_key`, `order`,
    // `excluded`, `affinity`, and `prompt_policy.text`) into public client `body.error`.
    // Keep `explain` ONLY on the top-level internal object for server audit logs and
    // admin-authenticated panel routes.
    return {
      status,
      retryAfterSec,
      headers,
      code: err.code || 'scheduler_error',
      explain: err.explain ?? null,
      body: {
        type: 'error',
        error: {
          type: errorType,
          code: err.code || 'scheduler_error',
          message: err.message || 'scheduler request rejected',
        },
      },
    }
  }
  const unavailable = new SchedulerUnavailableError(err?.message || 'scheduler unavailable', {
    reason: 'unexpected_error',
    cause: err,
  })
  return {
    ...unavailable.toHttpError(),
    code: 'scheduler_unavailable',
    explain: null,
  }
}

function clampInt(val, min, max, fallback) {
  if (val == null || val === '') return fallback
  const n = Number(val)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function optionalPositiveInt(val) {
  if (val == null || val === '') return null
  const n = Number(val)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

function normalizeQuotaRatioToPct(val) {
  if (val == null || val === '') return null
  const n = Number(val)
  if (!Number.isFinite(n) || n < 0) return null
  // Anthropic / VM unified utilization is stored as 0..1 ratio (e.g. 0.85 = 85%).
  const pct = n <= 1.5 ? n * 100 : n
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10))
}

function normalizeQuotaPercentField(val) {
  if (val == null || val === '') return null
  const n = Number(val)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10))
}

function extractQuotaPctsForVm(vm, acct) {
  const unified = acct?.unified || vm?.unified || null
  let u5 = normalizeQuotaRatioToPct(unified?.['5h']?.utilization)
  let u7 = normalizeQuotaRatioToPct(unified?.['7d']?.utilization)
  if (u5 == null) u5 = normalizeQuotaRatioToPct(vm?.utilization_5h)
  if (u7 == null) u7 = normalizeQuotaRatioToPct(vm?.utilization_7d)

  if (u5 == null || u7 == null) {
    const codexSnap = vm?.codex_usage?.snapshot || vm?.codex?.extra || vm?.codex_extra || null
    if (codexSnap && typeof codexSnap === 'object') {
      if (u5 == null) {
        u5 = normalizeQuotaPercentField(codexSnap.codex_5h_used_percent ?? codexSnap.primary_used_percent)
      }
      if (u7 == null) {
        u7 = normalizeQuotaPercentField(codexSnap.codex_7d_used_percent ?? codexSnap.secondary_used_percent)
      }
    }
  }
  return { u5, u7 }
}

function parseTempUnschedulableUntilMs(vm) {
  const raw = vm?.temp_unschedulable_until ?? vm?.claude?.temp_unschedulable_until
  if (raw == null || raw === '') return null
  const asNum = Number(raw)
  if (Number.isFinite(asNum) && asNum > 0) return Math.floor(asNum)
  const parsed = Date.parse(String(raw))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function tempUnschedulableState(vm, now = Date.now()) {
  const untilMs = parseTempUnschedulableUntilMs(vm)
  const reasonRaw = vm?.temp_unschedulable_reason ?? vm?.claude?.temp_unschedulable_reason ?? null
  const reason = reasonRaw != null && String(reasonRaw).trim() ? String(reasonRaw).trim() : null
  const active = untilMs != null && untilMs > now
  return { active, untilMs: active ? untilMs : null, reason }
}

/** Telemetry wire values: cleared slots send `0` / `null` so Rust will not fall back to stale snapshot until. */
function tempUnschedulableTelemetryFields(vm, now = Date.now()) {
  const state = tempUnschedulableState(vm, now)
  return {
    temp_unschedulable_until_ms: state.active ? state.untilMs : 0,
    temp_unschedulable_reason: state.active ? state.reason : null,
  }
}

function buildAccountLookup(accountQuota) {
  const byId = new Map()
  const byVmId = new Map()
  if (!accountQuota) return { byId, byVmId }
  let accounts = null
  try {
    const snap = accountQuota.snapshot?.()
    if (Array.isArray(snap?.accounts)) accounts = snap.accounts
    else if (snap?.accounts && typeof snap.accounts === 'object') accounts = Object.values(snap.accounts)
  } catch {}
  if (!accounts) {
    try {
      accounts = accountQuota.repo?.list?.() || []
    } catch {
      accounts = []
    }
  }
  for (const acc of accounts || []) {
    if (!acc) continue
    const id = String(acc.account_id || acc.id || '').trim()
    if (id) byId.set(id, acc)
    const vmId = String(acc.vm_id || '').trim()
    if (vmId && !byVmId.has(vmId)) byVmId.set(vmId, acc)
  }
  return { byId, byVmId }
}

function findAccountForVm(vm, lookup) {
  if (!vm || !lookup) return null
  const keys = [vm?.claude?.account_uuid, vm?.account_uuid, vm?.id].filter(Boolean)
  for (const k of keys) {
    const hit = lookup.byId.get(String(k))
    if (hit) return hit
  }
  return lookup.byVmId.get(String(vm.id)) || null
}

function normalizeGlobalOfficialPreset(rawValue) {
  const raw = String(rawValue ?? '')
    .trim()
    .toLowerCase()
  if (!raw) return null
  if (raw === OFFICIAL_303_PRESET || raw === 'official-303' || raw === '303') return 'official_full'
  const normalized = normalizePersonaPreset(raw)
  if (normalized === 'official') return 'official'
  return 'official_full'
}

export function resolveGlobalPromptPolicy(routingConfig = {}) {
  const compat = routingConfig?.compatibility || {}
  const rawPersonaPreset = String(compat.persona_preset ?? '')
    .trim()
    .toLowerCase()
  const rawCragPreset = String(compat.crag_persona_preset ?? '')
    .trim()
    .toLowerCase()
  const inject = String(compat.persona_inject || '')
    .trim()
    .toLowerCase()

  if (resolveGlobalZeroInject(routingConfig)) {
    return {
      mode: 'zero_inject',
      preset: 'official_full',
      text: '',
      client_system_policy: 'prepend_pool',
    }
  }
  if (
    inject === 'none' ||
    inject === 'off' ||
    inject === 'passthrough' ||
    rawPersonaPreset === 'none' ||
    rawPersonaPreset === 'off' ||
    rawPersonaPreset === 'passthrough'
  ) {
    return {
      mode: 'passthrough',
      preset: 'official_full',
      text: '',
      client_system_policy: 'prepend_pool',
    }
  }
  const preset =
    normalizeGlobalOfficialPreset(rawPersonaPreset) ??
    normalizeGlobalOfficialPreset(inject) ??
    (rawCragPreset ? normalizeGlobalOfficialPreset(rawCragPreset) : null) ??
    'official_full'
  return {
    mode: 'official',
    preset,
    text: '',
    client_system_policy: 'prepend_pool',
  }
}

function normalizeEndpointProvider(ep) {
  const proto = String(ep?.protocol || ep?.kind || '')
    .trim()
    .toLowerCase()
  if (proto === 'anthropic' || proto === 'claude') return 'anthropic'
  if (proto === 'openai' || proto === 'codex') return 'openai'
  if (proto === 'google' || proto === 'gemini') return 'google'
  return 'api_custom'
}

function normalizeEndpointProtocol(ep) {
  const proto = String(ep?.protocol || ep?.kind || '')
    .trim()
    .toLowerCase()
  if (proto === 'claude') return 'anthropic'
  if (proto === 'gemini') return 'google'
  if (proto === 'anthropic' || proto === 'openai' || proto === 'google') return proto
  return proto || 'anthropic'
}

function endpointHasReadyKey(ep, now = Date.now()) {
  const entries = Array.isArray(ep?.api_key_entries) ? ep.api_key_entries : null
  if (!entries) return true
  if (entries.length === 0) return Boolean(ep?.api_key)
  return entries.some((k) => {
    if (!k || k.disabled) return false
    if (ep.disable_cooling) return true
    if (!k.cooldown_until) return true
    const until = Date.parse(k.cooldown_until)
    return !Number.isFinite(until) || until <= now
  })
}

function endpointServesModelLocal(ep, model) {
  const raw = String(model || '').trim()
  if (!raw) return true
  if (ep?.disabled) return false
  const stripped = stripPrefix(raw, ep?.prefix)
    .replace(/^models\//i, '')
    .trim()
    .toLowerCase()
  if (!stripped) return true
  const models = Array.isArray(ep?.models) ? ep.models : []
  if (models.length > 0) {
    const hit = models.some((m) => {
      const alias = String(m?.alias || '')
        .trim()
        .toLowerCase()
      const name = String(m?.name || '')
        .trim()
        .toLowerCase()
      const upstream = String(m?.upstream_name || '')
        .trim()
        .toLowerCase()
      return (alias && alias === stripped) || (name && name === stripped) || (upstream && upstream === stripped)
    })
    if (hit) return true
  }
  const fam = inferModelFamily(stripped)
  if (ep?.kind === 'claude') {
    if (fam === 'openai' || fam === 'gemini') return false
    return endpointMatchesModel(ep, raw)
  }
  if (ep?.kind === 'openai') {
    if (fam === 'claude' || fam === 'gemini') return false
    return endpointMatchesModel(ep, raw)
  }
  if (endpointMatchesModel(ep, raw)) return true
  return models.length === 0
}

function geminiEnvServesModelLocal(env, model, { allowUnprefixedGemini3p = false } = {}) {
  const rawModels = Array.isArray(env?.models)
    ? env.models.map((x) => (typeof x === 'string' ? x : String(x?.id ?? x?.name ?? ''))).filter(Boolean)
    : []
  if (!rawModels.length) return true
  const cleaned = String(model || '')
    .trim()
    .replace(/^models\//i, '')
  if (!cleaned) return true
  if (resolveUpstreamModel(cleaned, rawModels, { allowUnprefixedNonGemini: allowUnprefixedGemini3p })) {
    return true
  }
  const wantLower = cleaned.toLowerCase()
  const wantStripped = stripAntigravityPrefix(cleaned).toLowerCase()
  const hadAgPrefix = wantLower.startsWith('ag-')
  return rawModels.some((entry) => {
    const eLower = String(entry || '')
      .trim()
      .replace(/^models\//i, '')
      .toLowerCase()
    if (!eLower) return false
    if (eLower === wantLower) return true
    const eStripped = stripAntigravityPrefix(eLower)
    if (hadAgPrefix && eStripped === wantStripped) return true
    if (allowUnprefixedGemini3p && eStripped === wantStripped) return true
    return false
  })
}

function ownerIdForRustScope(ownerScope) {
  if (!ownerScope || ownerScope.type === 'any') {
    return { owner_id: null, strict_tenant_only: false }
  }
  if (ownerScope.type === 'platform') {
    return { owner_id: PLATFORM_OWNER_SENTINEL, strict_tenant_only: true }
  }
  if (ownerScope.type === 'user' && normalizeOwnerId(ownerScope.userId)) {
    return { owner_id: normalizeOwnerId(ownerScope.userId), strict_tenant_only: true }
  }
  // Fail-closed sentinel when scope type === 'none'
  return { owner_id: '__unowned_deny__', strict_tenant_only: true }
}

/**
 * Compile a Rust `ApiKeyScope` DTO from key record, `poolAccess`, `ownerScope`,
 * and optional explicit node/model constraints.
 */
export function buildApiKeyScope({
  apiKeyRecord = null,
  apiKeyKind = null,
  poolAccess = null,
  ownerScope = null,
  allowedNodeKeys = null,
  allowedModels = null,
  originPoolId = null,
  model = null,
  allowPoolFallbackChain = null,
} = {}) {
  const isMaster = apiKeyKind === 'master' || (!apiKeyRecord && !poolAccess)
  const resolvedOwner = ownerScope || (isMaster ? PLATFORM_SCOPE : ownerScopeFromApiKey(apiKeyRecord, { apiKeyKind }))
  const { owner_id, strict_tenant_only } = ownerIdForRustScope(resolvedOwner)

  let pool_binding_mode = 'legacy_scope'
  if (poolAccess && poolAccess.mode === 'strict_pool') {
    pool_binding_mode = 'strict_pool'
  } else if (!isMaster && apiKeyRecord?.pool_binding_mode === 'strict_pool') {
    pool_binding_mode = 'strict_pool'
  }

  const allowedPoolSet = new Set()
  if (Array.isArray(poolAccess?.allowedPoolIds)) {
    for (const id of poolAccess.allowedPoolIds) {
      if (id) allowedPoolSet.add(String(id))
    }
  }
  if (Array.isArray(apiKeyRecord?.allowed_pool_ids)) {
    for (const id of apiKeyRecord.allowed_pool_ids) {
      if (id) allowedPoolSet.add(String(id))
    }
  }
  const explicitDefault =
    poolAccess?.originPool?.id || (isMaster ? null : String(apiKeyRecord?.default_pool_id || '').trim() || null) || null
  const default_pool_id = explicitDefault || (originPoolId ? String(originPoolId) : null)

  if (pool_binding_mode === 'strict_pool') {
    // Strict Fail-Closed: NEVER widen strict_pool keys into unauthorized fallback pools.
    // Stage 4 fallback only enters target pools explicitly present in allowed_pool_ids.
    if (default_pool_id) allowedPoolSet.add(default_pool_id)
  } else {
    if (default_pool_id) allowedPoolSet.add(default_pool_id)
    if (originPoolId) allowedPoolSet.add(String(originPoolId))
    if (Array.isArray(allowPoolFallbackChain)) {
      for (const pid of allowPoolFallbackChain) {
        if (pid) allowedPoolSet.add(String(pid))
      }
    }
  }

  const rawModels = Array.isArray(allowedModels)
    ? allowedModels.map((m) => String(m || '').trim()).filter(Boolean)
    : Array.isArray(poolAccess?.allowedModels)
      ? poolAccess.allowedModels.map((m) => String(m || '').trim()).filter(Boolean)
      : isMaster
        ? []
        : parseKeyAllowedModels(apiKeyRecord?.allowed_models)

  // Rust admission checks exact case-insensitive model strings or "*".
  // If a wildcard pattern in key.allowed_models matched `model`, include `model` so Rust admits it.
  let models = rawModels
  const reqModel = String(model || '').trim()
  if (reqModel && rawModels.length > 0 && keyAllowsModel(rawModels, reqModel)) {
    const exactHit = rawModels.some((m) => m === '*' || m.toLowerCase() === reqModel.toLowerCase())
    if (!exactHit) models = [...rawModels, reqModel]
  }

  const nodeKeys = Array.isArray(allowedNodeKeys)
    ? [...new Set(allowedNodeKeys.map((k) => String(k || '').trim()).filter(Boolean))]
    : []

  return {
    api_key_id: isMaster ? 'master' : String(apiKeyRecord?.id || 'anonymous'),
    pool_binding_mode,
    default_pool_id,
    allowed_pool_ids: [...allowedPoolSet],
    allowed_models: models,
    owner_id,
    strict_tenant_only,
    allowed_node_keys: nodeKeys,
  }
}

function defaultStandbyFromEnv() {
  return (
    process.env.KIN_STANDBY === '1' &&
    !(process.env.KIN_STANDBY_ACTIVE_FILE && fs.existsSync(process.env.KIN_STANDBY_ACTIVE_FILE))
  )
}

function positiveIntOrNull(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null
}

function collectVmHealthCapabilities(vm, projectRoot = '', health = null, routing = null) {
  const homeDir = projectRoot && vm?.id ? path.join(projectRoot, 'vms', String(vm.id), 'cli-home') : ''
  const cachedHealth = health || (homeDir ? peekRustHealth({ vmId: vm.id, vm, homeDir }, 60_000)?.health || null : null)
  const sources = [
    cachedHealth?.capabilities,
    vm?.workerStatus?.capabilities,
    vm?.worker_status?.capabilities,
    vm?.runtime?.capabilities,
    vm?.kernel_installation?.capabilities,
    vm?.capabilities,
  ]
  const caps = new Set()
  for (const list of sources) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const cap = String(entry || '').trim()
      if (cap) caps.add(cap)
    }
  }
  const transport =
    cachedHealth?.transport || vm?.workerStatus?.transport || vm?.worker_status?.transport || vm?.runtime?.transport
  if (transport === 'headless_bridge') {
    caps.add('headless_claude_bridge_v1')
  }
  // Cold-start fallback before first /internal/health: read staged/installed CRAG manifest from disk.
  if (
    caps.size === 0 &&
    projectRoot &&
    vm &&
    !isCodexVm(vm) &&
    (isCustomOsSlot(vm) || resolveKernelDataplane(vm, routing || {}) === 'crag')
  ) {
    try {
      const manifest = activeCragManifestForSlot(projectRoot, vm, homeDir)
      if (Array.isArray(manifest?.capabilities)) {
        for (const entry of manifest.capabilities) {
          const cap = String(entry || '').trim()
          if (cap) caps.add(cap)
        }
      }
    } catch {}
  }
  return [...caps]
}

/**
 * Project a VM's CRAG V4 `/internal/health::capabilities` and Custom Debian 13 OS
 * runtime capability flags into the Rust scheduler `NodeTelemetryUpdate.runtime_capabilities`
 * map (`BTreeMap<String, bool>`), merging any explicit `vm.runtime_capabilities` on top.
 */
export function buildVmRuntimeCapabilities(vm, { projectRoot = '', health = null, routing = null } = {}) {
  const caps = {}
  const healthCaps = collectVmHealthCapabilities(vm, projectRoot, health, routing)
  for (const cap of healthCaps) {
    caps[cap] = true
  }
  if (isCragDebian13Kernel(vm?.kernel)) {
    caps.os_crag_debian13 = true
  }
  if (isCustomOsSlot(vm)) {
    caps.os_custom_store_ro = true
  }
  if (isKvmRuntime(vm) && isCustomKvmMode({ vm })) {
    caps.os_custom_erofs = true
    caps.os_kvm_native_smbios = true
  }
  if (
    vm?.runtime_capabilities &&
    typeof vm.runtime_capabilities === 'object' &&
    !Array.isArray(vm.runtime_capabilities)
  ) {
    for (const [key, val] of Object.entries(vm.runtime_capabilities)) {
      const cleanKey = String(key || '').trim()
      if (cleanKey && typeof val === 'boolean') {
        caps[cleanKey] = val
      }
    }
  }
  return Object.keys(caps).length > 0 ? caps : null
}

function collectFallbackChainPoolIds(startPoolId, poolsById, maxDepth = 4) {
  const out = []
  const seen = new Set()
  let cur = startPoolId
  while (cur && !seen.has(cur) && out.length < maxDepth) {
    seen.add(cur)
    out.push(cur)
    const p = poolsById.get(cur)
    cur = p?.fallback_pool_id || null
  }
  return out
}

export class SchedulerRuntime {
  #cfg
  #client
  #ownsClient
  #getDb
  #getVms
  #getRoutingConfig
  #settings
  #apiKeyStore
  #apiEndpointStore
  #accountQuota
  #poolScheduler
  #geminiScheduler
  #geminiSlotPrefs
  #geminiOwnersRepo
  #cragSubscription
  #geminiCragSubscription
  #proxyPool
  #hostMemoryPressure
  #externalLoadProvider
  #telemetryIntervalMs
  #drainIntervalMs
  #onError

  #configVersion = 0
  #lastSnapshot = null
  #poolsById = new Map()
  #nodesByKey = new Map()
  #inventoryByKey = new Map()
  #telemetryTimer = null
  #syncInFlight = null
  #syncPending = false
  #started = false

  constructor(options = {}) {
    this.#cfg = options.cfg || {}
    this.#getDb =
      typeof options.getDb === 'function' ? options.getDb : () => (isDbOpen() ? getDb() : options.apiKeyStore?.db)
    this.#getVms =
      typeof options.getVms === 'function'
        ? options.getVms
        : () => {
            if (!this.#cfg?.paths?.project) return []
            try {
              return listVms(this.#cfg.paths.project) || []
            } catch {
              return []
            }
          }
    this.#getRoutingConfig =
      typeof options.getRoutingConfig === 'function' ? options.getRoutingConfig : () => options.routingConfig || {}
    this.#settings = options.settings || null
    this.#apiKeyStore = options.apiKeyStore || null
    this.#apiEndpointStore = options.apiEndpointStore || null
    this.#accountQuota = options.accountQuota || null
    this.#poolScheduler = options.poolScheduler || null
    this.#geminiScheduler = options.geminiScheduler || null
    this.#geminiSlotPrefs = options.geminiSlotPrefs || null
    this.#geminiOwnersRepo = options.geminiOwnersRepo || null
    this.#cragSubscription = options.cragSubscription || null
    this.#geminiCragSubscription = options.geminiCragSubscription || null
    this.#proxyPool = options.proxyPool || null
    this.#hostMemoryPressure = options.hostMemoryPressure || null
    this.#externalLoadProvider =
      typeof options.getExternalInFlight === 'function'
        ? options.getExternalInFlight
        : options.foreignLoad
          ? () => options.foreignLoad.snapshot?.()?.vms || {}
          : null

    this.#telemetryIntervalMs =
      options.telemetryIntervalMs != null
        ? Math.max(0, Number(options.telemetryIntervalMs))
        : DEFAULT_TELEMETRY_INTERVAL_MS
    this.#drainIntervalMs =
      options.drainIntervalMs != null ? Math.max(50, Number(options.drainIntervalMs)) : DEFAULT_DRAIN_INTERVAL_MS
    this.#onError = typeof options.onError === 'function' ? options.onError : null

    const isStandby =
      options.isStandby !== undefined
        ? Boolean(options.isStandby)
        : options.role === 'standby' || (options.role === undefined && defaultStandbyFromEnv())

    if (options.client) {
      this.#client = options.client
      this.#ownsClient = false
    } else {
      this.#ownsClient = true
      this.#client = createSchedulerClient({
        cfg: this.#cfg,
        ...(options.clientOptions || {}),
        isStandby,
        drainIntervalMs: this.#drainIntervalMs,
        onBootstrap: (ctx) => this.#buildBootstrapPayload(ctx),
        onDrain: (batch) => this.#persistDrainBatch(batch),
        onError: (err, info) => {
          this.#onError?.(err, info)
        },
      })
    }
  }

  get client() {
    return this.#client
  }

  get isStandby() {
    return this.#client.isStandby
  }

  get role() {
    return this.#client.role
  }

  get configVersion() {
    return this.#configVersion
  }

  get controllerEpoch() {
    return this.#client.controllerEpoch
  }

  get ready() {
    return this.#started && !this.#client.stopped
  }

  get lastSnapshot() {
    return this.#lastSnapshot
  }

  setExternalLoadProvider(fn) {
    this.#externalLoadProvider = typeof fn === 'function' ? fn : null
  }

  #resolveDb() {
    try {
      return this.#getDb?.() || null
    } catch {
      return null
    }
  }

  #resolveGeminiScheduler() {
    return typeof this.#geminiScheduler === 'function' ? this.#geminiScheduler() : this.#geminiScheduler
  }

  #resolvePoolScheduler() {
    return typeof this.#poolScheduler === 'function' ? this.#poolScheduler() : this.#poolScheduler
  }

  #resolveProxyPool() {
    return typeof this.#proxyPool === 'function' ? this.#proxyPool() : this.#proxyPool
  }

  #loadGeminiEnvs() {
    const gSched = this.#resolveGeminiScheduler()
    if (!gSched) return []
    try {
      const list = gSched.listEnvironments?.() || gSched.snapshot?.()?.accounts || []
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  #loadGeminiOwnerMap() {
    try {
      return this.#geminiOwnersRepo?.ownerMap?.() || null
    } catch {
      return null
    }
  }

  #loadApiEndpoints() {
    try {
      const list = this.#apiEndpointStore?.listRaw?.() ?? this.#apiEndpointStore?.list?.() ?? []
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  /**
   * Build the authoritative Rust `ConfigSnapshot` covering:
   * - Global Anthropic prompt policy
   * - All DB `scheduler_pools` & `scheduler_pool_members`
   * - Synthesized virtual default pools for seamless `legacy_scope` / master traffic
   * - All `claude_vm`, `codex_vm`, `gemini_env`, and `api_endpoint` nodes
   * - Trusted JEV downgrade pool IDs
   */
  buildConfigSnapshot({ configVersion = null } = {}) {
    const version = configVersion != null ? Number(configVersion) : Math.max(1, this.#configVersion || 1)
    const routing = this.#getRoutingConfig() || {}
    const poolRouting = routing.pool || {}
    const concRouting = routing.concurrency || {}
    const db = this.#resolveDb()

    let dbPools = []
    if (db) {
      try {
        dbPools = new SchedulerPoolsRepo(db).list()
      } catch {
        dbPools = []
      }
    }

    const vms = this.#getVms() || []
    const acctLookup = buildAccountLookup(this.#accountQuota)
    const geminiEnvs = this.#loadGeminiEnvs()
    const geminiOwnerMap = this.#loadGeminiOwnerMap()
    const geminiPrefs = this.#geminiSlotPrefs?.all?.() || this.#geminiSlotPrefs?.getAll?.() || {}
    const apiEndpoints = this.#loadApiEndpoints()

    const nodes = []
    const nodesByKey = new Map()
    const inventoryByKey = new Map()

    const defaultVmConc = clampInt(concRouting.default_max_per_account, 1, 256, 4)
    const defaultVmRpm = optionalPositiveInt(concRouting.default_max_rpm)
    const defaultPrimarySessions = optionalPositiveInt(poolRouting.max_primary_sessions)
    const defaultSubagents =
      poolRouting.max_subagents_per_session != null && Number.isInteger(Number(poolRouting.max_subagents_per_session))
        ? Math.max(0, Number(poolRouting.max_subagents_per_session))
        : null

    const claudeMembers = []
    const codexMembers = []
    const geminiMembers = []
    const apiMembers = []

    for (let i = 0; i < vms.length; i += 1) {
      const vm = vms[i]
      if (!vm?.id) continue
      const codex = isCodexVm(vm)
      const node_type = codex ? 'codex_vm' : 'claude_vm'
      const node_id = String(vm.id)
      const node_key = formatNodeKey(node_type, node_id)
      const acct = findAccountForVm(vm, acctLookup)
      const unified = acct?.unified || vm?.unified || (vm?.reset_7d ? { '7d': { resets_at: vm.reset_7d } } : {})
      const manualLevel = vm?.policy?.priority ?? vm?.schedule_level_manual
      const schedInfo = resolveCredentialScheduleLevel({
        vm,
        ...(manualLevel !== undefined ? { manualLevel } : {}),
        unified,
      })
      const owner = vmOwnerId(vm) || PLATFORM_OWNER_SENTINEL

      const policyConcPinned =
        isConcurrencyPinned(vm?.policy) ||
        (vm?.policy?.concurrencyOverride !== false && positiveIntOrNull(vm?.policy?.max_concurrency) != null)
      const explicitMaxConc =
        (policyConcPinned ? positiveIntOrNull(vm?.policy?.max_concurrency ?? vm?.policy?.maxConcurrency) : null) ??
        positiveIntOrNull(vm?.max_concurrency) ??
        positiveIntOrNull(acct?.max_concurrency)
      const policySessPinned = vm?.policy?.sessionsOverride !== false && vm?.policy?.sessionSlotsOverride !== false
      const explicitMaxSessions =
        (policySessPinned
          ? positiveIntOrNull(
              vm?.policy?.session_slots ??
                vm?.policy?.sessionSlots ??
                vm?.policy?.max_sessions ??
                vm?.policy?.maxSessions,
            )
          : null) ?? positiveIntOrNull(vm?.session_slots ?? vm?.max_sessions)
      const vmHealthCaps = !codex ? collectVmHealthCapabilities(vm, this.#cfg?.paths?.project || '', null, routing) : []
      const useV4SlotCapacity =
        !codex &&
        (isHeadlessBridgeSlot(vm, { capabilities: vmHealthCaps }) ||
          isCustomOsSlot(vm) ||
          resolveKernelDataplane(vm, routing) === 'crag')
      const fallbackVmConc = useV4SlotCapacity
        ? effectiveSlotCount(vm, routing, vmHealthCaps.length ? { capabilities: vmHealthCaps } : undefined)
        : defaultVmConc
      const maxConc = clampInt(explicitMaxConc, 1, 256, fallbackVmConc)
      const maxSessions = clampInt(explicitMaxSessions, 1, 256, maxConc)
      const maxPrimarySessions =
        optionalPositiveInt(
          vm?.policy?.max_primary_sessions ?? vm?.policy?.maxPrimarySessions ?? vm?.max_primary_sessions,
        ) ?? defaultPrimarySessions
      const rawSubagents =
        vm?.policy?.max_subagents_per_session ?? vm?.policy?.maxSubagentsPerSession ?? vm?.max_subagents_per_session
      const maxSubagents =
        rawSubagents != null && Number.isInteger(Number(rawSubagents))
          ? Math.max(0, Number(rawSubagents))
          : defaultSubagents
      const maxRpm = optionalPositiveInt(
        vm?.policy?.max_rpm ?? vm?.policy?.maxRpm ?? vm?.max_rpm ?? acct?.max_rpm ?? defaultVmRpm,
      )
      const subWeight = clampInt(vm?.policy?.weight ?? vm?.weight, 1, 1000, 10)
      const statusLower = String(vm.status || '').toLowerCase()
      const enabled = statusLower !== 'deleted' && statusLower !== 'disabled'

      const nodeCfg = {
        node_key,
        node_type,
        node_id,
        provider: codex ? 'openai' : 'anthropic',
        protocol: codex ? 'openai' : 'anthropic',
        owner_id: owner,
        plan_tier:
          vm?.claude?.account_tier ||
          vm?.account_tier ||
          vm?.codex?.plan_type ||
          vm?.plan_type ||
          vm?.chatgpt_plan_type ||
          null,
        weight_tier_mode: schedInfo.mode === 'auto' ? 'auto7d_reset' : 'manual',
        weight_tier: clampInt(schedInfo.level, 1, 10, 5),
        auto_weight_tier: schedInfo.mode === 'auto' ? clampInt(schedInfo.level, 1, 7, 1) : null,
        sub_weight: subWeight,
        // Keep empty in Rust static config so wildcard/new model slugs aren't dropped;
        // fine-grained vm.policy.allowed_models / vm.allowed_models is enforced via `allowed_node_keys` intersection.
        supported_models: [],
        capacity: {
          max_concurrency: maxConc,
          max_sessions: maxSessions,
          max_primary_sessions: maxPrimarySessions,
          max_subagents_per_session: maxSubagents,
          max_rpm: maxRpm,
        },
        enabled,
      }
      const tempParkCfg = tempUnschedulableState(vm)
      if (tempParkCfg.untilMs != null) {
        nodeCfg.temp_unschedulable_until_ms = tempParkCfg.untilMs
        if (tempParkCfg.reason) nodeCfg.temp_unschedulable_reason = tempParkCfg.reason
      }
      nodes.push(nodeCfg)
      nodesByKey.set(node_key, nodeCfg)
      inventoryByKey.set(node_key, { kind: 'vm', item: vm, account: acct })

      const memberObj = {
        node_key,
        node_type,
        node_id,
        enabled,
        member_role: 'active',
        weight_tier_override: null,
        sub_weight_override: null,
        member_order: i,
      }
      if (codex) codexMembers.push(memberObj)
      else claudeMembers.push(memberObj)
    }

    for (let i = 0; i < geminiEnvs.length; i += 1) {
      const env = geminiEnvs[i]
      const node_id = String(env?.id ?? env?.env_id ?? env?.name ?? '').trim()
      if (!node_id) continue
      const node_type = 'gemini_env'
      const node_key = formatNodeKey(node_type, node_id)
      const pref = geminiPrefs?.[node_id] || null
      const owner = normalizeOwnerId(env?.owner_user_id ?? geminiOwnerMap?.get?.(node_id)) || PLATFORM_OWNER_SENTINEL
      const maxConc = clampInt(env?.max_concurrency ?? pref?.max_concurrency, 1, 256, 20)
      const maxSessions = clampInt(env?.max_sessions ?? pref?.max_sessions, 1, 256, maxConc)
      const weightTier = clampInt(pref?.schedule_level ?? env?.schedule_level, 1, 10, 5)
      const enabled = env?.enabled !== false

      const nodeCfg = {
        node_key,
        node_type,
        node_id,
        provider: 'google',
        protocol: 'google',
        owner_id: owner,
        plan_tier: env?.plan_tier || env?.tier || null,
        weight_tier_mode: 'manual',
        weight_tier: weightTier,
        auto_weight_tier: null,
        sub_weight: 10,
        supported_models: [],
        capacity: {
          max_concurrency: maxConc,
          max_sessions: maxSessions,
          max_primary_sessions: null,
          max_subagents_per_session: null,
          max_rpm: null,
        },
        enabled,
      }
      nodes.push(nodeCfg)
      nodesByKey.set(node_key, nodeCfg)
      inventoryByKey.set(node_key, { kind: 'gemini', item: env, pref })
      geminiMembers.push({
        node_key,
        node_type,
        node_id,
        enabled,
        member_role: 'active',
        weight_tier_override: null,
        sub_weight_override: null,
        member_order: i,
      })
    }

    for (let i = 0; i < apiEndpoints.length; i += 1) {
      const ep = apiEndpoints[i]
      const node_id = String(ep?.id || '').trim()
      if (!node_id) continue
      const node_type = 'api_endpoint'
      const node_key = formatNodeKey(node_type, node_id)
      const owner = endpointOwnerId(ep) || PLATFORM_OWNER_SENTINEL
      const maxConc = clampInt(ep?.max_concurrency, 1, 1024, 20)
      const weightTier = clampInt(ep?.priority, 1, 10, 5)
      const subWeight = clampInt(ep?.weight, 1, 1000, 10)
      const enabled = !ep?.disabled

      const nodeCfg = {
        node_key,
        node_type,
        node_id,
        provider: normalizeEndpointProvider(ep),
        protocol: normalizeEndpointProtocol(ep),
        owner_id: owner,
        plan_tier: 'payg',
        weight_tier_mode: 'manual',
        weight_tier: weightTier,
        auto_weight_tier: null,
        sub_weight: subWeight,
        supported_models: [],
        capacity: {
          max_concurrency: maxConc,
          max_sessions: maxConc,
          max_primary_sessions: null,
          max_subagents_per_session: null,
          max_rpm: optionalPositiveInt(ep?.max_rpm),
        },
        enabled,
      }
      nodes.push(nodeCfg)
      nodesByKey.set(node_key, nodeCfg)
      inventoryByKey.set(node_key, { kind: 'api', item: ep })
      apiMembers.push({
        node_key,
        node_type,
        node_id,
        enabled,
        member_role: 'active',
        weight_tier_override: null,
        sub_weight_override: null,
        member_order: i,
      })
    }

    const pools = []
    const poolsById = new Map()
    const trustedDowngradeSet = new Set()

    for (const p of dbPools) {
      const mappedMembers = (p.members || []).map((m, idx) => ({
        node_key: formatNodeKey(m.node_type, m.node_id),
        node_type: m.node_type,
        node_id: String(m.node_id),
        enabled: m.enabled !== false,
        member_role: m.member_role === 'standby' ? 'standby' : 'active',
        weight_tier_override: m.weight_tier_override != null ? clampInt(m.weight_tier_override, 1, 10, 5) : null,
        sub_weight_override: m.sub_weight_override != null ? clampInt(m.sub_weight_override, 1, 1000, 10) : null,
        member_order: Number.isFinite(Number(m.member_order)) ? Number(m.member_order) : idx,
      }))
      const providerScope = normalizeProviderScope(p.provider_scope)
      const poolCfg = {
        id: String(p.id),
        slug: String(p.slug || p.id),
        name: String(p.name || p.id),
        enabled: p.enabled !== false,
        exclusive_members: Boolean(p.exclusive_members),
        provider_scope: providerScope,
        plan_tags: Array.isArray(p.plan_tags) ? p.plan_tags.map(String) : [],
        pool_role: p.pool_role || 'standard',
        sort_order: Number(p.sort_order) || 0,
        fallback_pool_id: p.fallback_pool_id || null,
        allow_cross_prompt_fallback: Boolean(p.allow_cross_prompt_fallback),
        intra_tier_strategy: p.intra_tier_strategy || 'least_inflight_swrr',
        session_queue_max: clampInt(p.session_queue_max, 1, 128, 16),
        session_queue_timeout_ms: clampInt(p.session_queue_timeout_ms, 1000, 300_000, 60_000),
        queue_wait_ms: clampInt(p.queue_wait_ms, 0, 60_000, 15_000),
        queue_max: clampInt(p.queue_max, 1, 999, 50),
        machine_sticky_enabled: p.machine_sticky_enabled !== false,
        machine_ttl_seconds: clampInt(p.machine_ttl_seconds, 60, 2_592_000, 604_800),
        session_sticky_enabled: p.session_sticky_enabled !== false,
        session_ttl_seconds: clampInt(p.session_ttl_seconds, 60, 604_800, 86_400),
        session_busy_wait_ms: clampInt(p.session_busy_wait_ms, 0, 30_000, 0),
        session_overflow_policy: p.session_overflow_policy || 'spill_immediately',
        system_prompt_mode: p.system_prompt_mode || defaultSystemPromptModeForProvider(providerScope),
        system_prompt_preset: p.system_prompt_preset || 'official_full',
        system_prompt_text: String(p.system_prompt_text || ''),
        client_system_policy: p.client_system_policy || 'prepend_pool',
        jev_profile: p.jev_profile || 'inherit_global',
        ...(Array.isArray(p.required_runtime_capabilities)
          ? { required_runtime_capabilities: p.required_runtime_capabilities.map(String).filter(Boolean) }
          : {}),
        members: mappedMembers,
      }
      pools.push(poolCfg)
      poolsById.set(poolCfg.id, poolCfg)
      if (poolCfg.enabled && poolCfg.pool_role === 'downgrade') {
        trustedDowngradeSet.add(poolCfg.id)
      }
    }

    let riskAuditPolicy = null
    try {
      const settingsObj = typeof this.#settings === 'function' ? this.#settings() : this.#settings
      if (settingsObj && typeof settingsObj.get === 'function') {
        riskAuditPolicy = settingsObj.get('risk_audit_policy', null)
      } else if (settingsObj && typeof settingsObj === 'object') {
        riskAuditPolicy = settingsObj.risk_audit_policy ?? settingsObj.risk_audit ?? null
      } else if (db) {
        riskAuditPolicy = new SettingsRepo(db).get('risk_audit_policy', null)
      }
    } catch {
      riskAuditPolicy = null
    }
    const configuredDowngradeIds = [
      routing?.jev?.downgrade_pool_id,
      routing?.intercept?.downgrade_pool_id,
      riskAuditPolicy?.downgrade_pool,
      riskAuditPolicy?.downgrade_pool_id,
    ]
    for (const rawId of configuredDowngradeIds) {
      const id = String(rawId || '').trim()
      if (id && poolsById.get(id)?.enabled) {
        trustedDowngradeSet.add(id)
      }
    }

    // Synthesize built-in virtual default pools for seamless legacy_scope & master-key traffic.
    const virtualStrategy = poolRouting.strategy === 'fill' ? 'fill' : 'least_inflight_swrr'
    const virtualQueueWaitMs = clampInt(poolRouting.fallback_wait_timeout_ms, 0, 60_000, 15_000)
    const virtualQueueMax = clampInt(poolRouting.queue_max, 1, 999, 50)
    const makeVirtualPool = (id, name, providerScope, promptMode, members) => ({
      id,
      slug: id,
      name,
      enabled: true,
      exclusive_members: false,
      provider_scope: providerScope,
      plan_tags: [],
      pool_role: 'standard',
      sort_order: 10_000,
      fallback_pool_id: null,
      allow_cross_prompt_fallback: false,
      intra_tier_strategy: virtualStrategy,
      session_queue_max: 16,
      session_queue_timeout_ms: 60_000,
      queue_wait_ms: virtualQueueWaitMs,
      queue_max: virtualQueueMax,
      machine_sticky_enabled: true,
      machine_ttl_seconds: 604_800,
      session_sticky_enabled: true,
      session_ttl_seconds: 86_400,
      // Locked v4 D2 defaults: spill immediately with zero wait
      session_busy_wait_ms: 0,
      session_overflow_policy: 'spill_immediately',
      system_prompt_mode: promptMode,
      system_prompt_preset: 'official_full',
      system_prompt_text: '',
      client_system_policy: 'prepend_pool',
      jev_profile: 'inherit_global',
      members,
    })

    const allMembers = [...claudeMembers, ...codexMembers, ...geminiMembers, ...apiMembers]
    const virtualPools = [
      makeVirtualPool(VIRTUAL_POOL_IDS.claude, 'Virtual Legacy Claude', 'anthropic', 'inherit_global', claudeMembers),
      makeVirtualPool(VIRTUAL_POOL_IDS.codex, 'Virtual Legacy Codex', 'openai', 'passthrough', codexMembers),
      makeVirtualPool(VIRTUAL_POOL_IDS.gemini, 'Virtual Legacy Gemini', 'google', 'passthrough', geminiMembers),
      makeVirtualPool(VIRTUAL_POOL_IDS.api, 'Virtual Legacy API', 'api', 'inherit_global', apiMembers),
      makeVirtualPool(VIRTUAL_POOL_IDS.all, 'Virtual Legacy All', 'mixed', 'inherit_global', allMembers),
    ]
    for (const vp of virtualPools) {
      if (!poolsById.has(vp.id)) {
        pools.push(vp)
        poolsById.set(vp.id, vp)
      }
    }

    const codexQuota = normalizeOpenAIQuotaPolicy(routing.codex?.quota || {})
    const snapshot = {
      config_version: version,
      global_prompt_policy: resolveGlobalPromptPolicy(routing),
      trusted_downgrade_pool_ids: [...trustedDowngradeSet],
      pools,
      nodes,
      codex_quota: {
        limit_5h: codexQuota.limit_5h,
        limit_7d: codexQuota.limit_7d,
      },
    }
    this.#lastSnapshot = snapshot
    this.#poolsById = poolsById
    this.#nodesByKey = nodesByKey
    this.#inventoryByKey = inventoryByKey
    return snapshot
  }

  /**
   * Build high-frequency node telemetry updates pushed to `/internal/v1/nodes/telemetry`
   * (zero `config_version` bump, zero `ArcSwap` rebuild).
   */
  buildTelemetryBatch({ now = Date.now() } = {}) {
    const updates = []
    const vms = this.#getVms() || []
    const acctLookup = buildAccountLookup(this.#accountQuota)
    const externalVms = this.#externalLoadProvider?.() || {}
    const routing = this.#getRoutingConfig() || {}
    const quotaPolicy = normalizeOpenAIQuotaPolicy(routing.codex?.quota || {})

    for (const vm of vms) {
      if (!vm?.id) continue
      const codex = isCodexVm(vm)
      const node_type = codex ? 'codex_vm' : 'claude_vm'
      const node_key = formatNodeKey(node_type, vm.id)
      const acct = findAccountForVm(vm, acctLookup)
      const { u5, u7 } = extractQuotaPctsForVm(vm, acct)

      const statusLower = String(vm.status || '').toLowerCase()
      const hardDown =
        statusLower === 'stopped' || statusLower === 'dead' || statusLower === 'error' || statusLower === 'disabled'
      const schedOff = vm.schedulable === false && !isLeftoverQuotaScheduleOff(vm)
      const blockedProxy = proxyBlockedReason(vm.proxy)
      let unschedReason = null
      let schedulable = true
      if (vm.unschedulable) {
        schedulable = false
        unschedReason =
          typeof vm.unschedulable === 'object'
            ? String(vm.unschedulable.reason || vm.unschedulable.code || 'unschedulable')
            : String(vm.unschedulable)
      } else if (schedOff) {
        schedulable = false
        unschedReason = 'schedulable_false'
      } else if (hardDown && !codex) {
        schedulable = false
        unschedReason = `vm_status_${statusLower}`
      } else if (codex && (statusLower === 'dead' || statusLower === 'error' || statusLower === 'disabled')) {
        schedulable = false
        unschedReason = `vm_status_${statusLower}`
      }

      const tempPark = tempUnschedulableState(vm, now)
      if (schedulable && tempPark.active) {
        schedulable = false
        unschedReason = tempPark.reason || 'temp_unschedulable'
      } else if (schedulable && codex && isCodexSlotParked(vm, now, quotaPolicy)) {
        schedulable = false
        unschedReason = 'codex_slot_parked'
      }

      const activeHoursRes = evaluateActiveHours(activeHoursOf(vm), now, vm.timezone)
      const memLevel = this.#hostMemoryPressure?.levelForVm?.(vm) ?? hostMemoryLevelForVm(vm)
      const hostMemoryPressure = memLevel === HOST_PRESSURE_CRITICAL

      let cragLicenseOk = true
      if (
        !codex &&
        resolveKernelDataplane(vm, routing) === 'crag' &&
        typeof this.#cragSubscription?.isSlotAdmitted === 'function'
      ) {
        try {
          cragLicenseOk = Boolean(this.#cragSubscription.isSlotAdmitted(vm))
        } catch {
          cragLicenseOk = true
        }
      }

      const extCount = Number(externalVms?.[vm.id] ?? externalVms?.[node_key] ?? 0)
      const update = {
        node_key,
        schedulable,
        unschedulable_reason: unschedReason,
        active_hours_ok: Boolean(activeHoursRes.active),
        host_memory_pressure: Boolean(hostMemoryPressure),
        proxy_ready: !blockedProxy,
        crag_license_ok: cragLicenseOk,
        external_in_flight: Number.isFinite(extCount) && extCount > 0 ? Math.floor(extCount) : 0,
      }
      if (u5 != null) update.quota_util_5h_pct = u5
      if (u7 != null) update.quota_util_7d_pct = u7
      Object.assign(update, tempUnschedulableTelemetryFields(vm, now))
      const runtimeCaps = buildVmRuntimeCapabilities(vm, { projectRoot: this.#cfg?.paths?.project || '', routing })
      if (runtimeCaps) {
        update.runtime_capabilities = runtimeCaps
      }
      updates.push(update)
    }

    const geminiEnvs = this.#loadGeminiEnvs()
    for (const env of geminiEnvs) {
      const node_id = String(env?.id ?? env?.env_id ?? env?.name ?? '').trim()
      if (!node_id) continue
      const node_key = formatNodeKey('gemini_env', node_id)
      const enabled = env?.enabled !== false
      const healthy = env?.healthy !== false
      const schedFlag = env?.schedulable !== false
      const schedulable = Boolean(enabled && healthy && schedFlag)
      let unschedReason = null
      if (!enabled) unschedReason = 'disabled'
      else if (!schedFlag) unschedReason = String(env?.unschedulable_reason || 'schedulable_false')
      else if (!healthy) unschedReason = String(env?.error || env?.health_error || 'unhealthy')
      const extCount = Number(externalVms?.[node_key] ?? externalVms?.[node_id] ?? 0)
      updates.push({
        node_key,
        schedulable,
        unschedulable_reason: unschedReason,
        active_hours_ok: true,
        host_memory_pressure: false,
        proxy_ready: env?.proxy_ready !== false,
        crag_license_ok: env?.license_ok !== false,
        external_in_flight: Number.isFinite(extCount) && extCount > 0 ? Math.floor(extCount) : 0,
      })
    }

    const endpoints = this.#loadApiEndpoints()
    for (const ep of endpoints) {
      const node_id = String(ep?.id || '').trim()
      if (!node_id) continue
      const node_key = formatNodeKey('api_endpoint', node_id)
      const disabled = Boolean(ep?.disabled)
      const hasKey = endpointHasReadyKey(ep, now)
      const schedulable = !disabled && hasKey
      const unschedReason = disabled ? 'disabled' : !hasKey ? 'no_ready_api_key' : null
      updates.push({
        node_key,
        schedulable,
        unschedulable_reason: unschedReason,
        active_hours_ok: true,
        host_memory_pressure: false,
        proxy_ready: true,
        crag_license_ok: true,
        external_in_flight: 0,
      })
    }

    return updates
  }

  #buildBootstrapPayload({ controllerEpoch, role }) {
    this.#configVersion = Math.max(1, this.#configVersion + 1)
    const config_snapshot = this.buildConfigSnapshot({ configVersion: this.#configVersion })
    const now = Date.now()
    const db = this.#resolveDb()

    let active_sticky_bindings = []
    let active_penalties = []
    if (db) {
      try {
        const repo = new SchedulerPoolsRepo(db)
        active_sticky_bindings = repo.listLiveStickyBindings(now).map((row) => ({
          scope_kind: row.scope_kind,
          pool_id: row.pool_id,
          model_family: row.model_family,
          identity_id: row.identity_id,
          node_key: formatNodeKey(row.node_type, row.node_id),
          node_type: row.node_type,
          node_id: row.node_id,
          machine_id: row.machine_id ?? null,
          stood_in: Boolean(row.stood_in),
          bound_at_ms: Number(row.bound_at_ms) || now,
          last_seen_ms: Number(row.last_seen_ms) || now,
          expires_at_ms: Number(row.expires_at_ms) || now,
          hits: Number(row.hits) || 0,
          generation: Number(row.generation) || 1,
        }))
        active_penalties = repo.listActiveNodePenalties(now).map((row) => ({
          node_key: formatNodeKey(row.node_type, row.node_id),
          node_type: row.node_type,
          node_id: row.node_id,
          model_scope: row.model_scope || '*',
          reason: row.reason || 'cooldown',
          cooldown_until_ms: Number(row.cooldown_until_ms) || now,
          ladder_step: Number(row.ladder_step) || 0,
          permanent: Number(row.cooldown_until_ms) >= PERMANENT_PENALTY_THRESHOLD_MS,
          updated_at_ms: Date.parse(row.updated_at || '') || now,
        }))
      } catch (err) {
        this.#onError?.(err, { phase: 'bootstrap_load_db' })
      }
    }

    const initial_telemetry = this.buildTelemetryBatch({ now })
    return {
      controller_epoch: controllerEpoch,
      role,
      config_version: config_snapshot.config_version,
      config_snapshot,
      active_sticky_bindings,
      active_penalties,
      initial_telemetry,
    }
  }

  #persistDrainBatch(batch) {
    if (this.isStandby) return
    const db = this.#resolveDb()
    if (!db) return
    const repo = new SchedulerPoolsRepo(db)
    withTransaction(db, () => {
      for (const s of batch?.sticky_upserts || []) {
        repo.upsertStickyBinding({
          scope_kind: s.scope_kind,
          pool_id: s.pool_id,
          model_family: s.model_family,
          identity_id: s.identity_id,
          node_type: s.node_type,
          node_id: s.node_id,
          machine_id: s.machine_id ?? null,
          stood_in: Boolean(s.stood_in),
          bound_at_ms: s.bound_at_ms,
          last_seen_ms: s.last_seen_ms,
          expires_at_ms: s.expires_at_ms,
          hits: s.hits,
          generation: s.generation,
        })
      }
      for (const d of batch?.sticky_deletes || []) {
        repo.deleteStickyBinding({
          scope_kind: d.scope_kind,
          pool_id: d.pool_id,
          model_family: d.model_family,
          identity_id: d.identity_id,
        })
      }
      for (const p of batch?.penalty_upserts || []) {
        repo.upsertNodePenalty({
          node_type: p.node_type,
          node_id: p.node_id,
          model_scope: p.model_scope || '*',
          reason: p.reason || 'cooldown',
          cooldown_until_ms: p.permanent ? PERMANENT_PENALTY_THRESHOLD_MS : Number(p.cooldown_until_ms) || Date.now(),
          ladder_step: Number(p.ladder_step) || 0,
          updated_at: p.updated_at_ms ? new Date(Number(p.updated_at_ms)).toISOString() : new Date().toISOString(),
        })
      }
      for (const d of batch?.penalty_deletes || []) {
        const parsed = parseNodeKey(d.node_key)
        if (!parsed) continue
        repo.deleteNodePenalty({
          node_type: parsed.node_type,
          node_id: parsed.node_id,
          model_scope: d.model_scope || '*',
        })
      }
    })
  }

  #startTelemetryLoop() {
    this.#stopTelemetryLoop()
    if (this.#telemetryIntervalMs <= 0) return
    this.#telemetryTimer = setInterval(() => {
      if (this.#client.stopped) return
      this.pushTelemetryNow().catch((err) => {
        this.#onError?.(err, { phase: 'telemetry_loop' })
      })
    }, this.#telemetryIntervalMs)
    this.#telemetryTimer.unref?.()
  }

  #stopTelemetryLoop() {
    if (!this.#telemetryTimer) return
    clearInterval(this.#telemetryTimer)
    this.#telemetryTimer = null
  }

  async start({ waitMs = 5_000, startLoops = true } = {}) {
    const res = await this.#client.start({ waitMs, startLoops })
    this.#started = true
    if (startLoops) {
      this.#startTelemetryLoop()
    }
    return res
  }

  async promoteToLeader({ rebootstrap = true, startDrain = true } = {}) {
    await this.#client.promoteToLeader({ rebootstrap, startDrain })
    if (this.#started) {
      this.#startTelemetryLoop()
    }
  }

  demoteToStandby() {
    this.#client.demoteToStandby()
  }

  async shutdown({ drain = true, stopProcess = true, timeoutMs = 2_000 } = {}) {
    this.#stopTelemetryLoop()
    this.#started = false
    if (this.#ownsClient) {
      return this.#client.shutdown({ drain: drain && !this.isStandby, stopProcess, timeoutMs })
    }
    if (drain && !this.isStandby) {
      await this.drainPersistenceNow().catch((err) => {
        this.#onError?.(err, { phase: 'shutdown_drain' })
      })
    }
    return { ok: true }
  }

  async syncConfigNow(reason = 'manual') {
    if (this.#client.stopped) return { ok: false, skipped: 'stopped', config_version: this.#configVersion }
    if (this.#syncInFlight) {
      this.#syncPending = true
      return this.#syncInFlight
    }
    const run = async () => {
      let lastRes = { ok: true, applied: false, config_version: this.#configVersion }
      do {
        this.#syncPending = false
        this.#configVersion += 1
        const snapshot = this.buildConfigSnapshot({ configVersion: this.#configVersion })
        lastRes = await this.#client.syncConfig({
          config_version: snapshot.config_version,
          config_snapshot: snapshot,
        })
      } while (this.#syncPending && !this.#client.stopped)
      return lastRes
    }
    let promise
    promise = run()
      .catch((err) => {
        this.#onError?.(err, { phase: 'sync_config', reason })
        throw err
      })
      .finally(() => {
        if (this.#syncInFlight === promise) this.#syncInFlight = null
      })
    this.#syncInFlight = promise
    return promise
  }

  syncConfig(reason = 'manual') {
    return this.syncConfigNow(reason)
  }

  enqueueTelemetry(updates) {
    this.#client.enqueueTelemetry(updates)
  }

  async pushTelemetryNow(updates = null) {
    if (this.#client.stopped) return { ok: false, updated: 0 }
    const batch = Array.isArray(updates) ? updates : this.buildTelemetryBatch()
    if (!batch.length) return { ok: true, updated: 0 }
    return this.#client.pushTelemetry(batch)
  }

  pushTelemetry(updates = null) {
    return this.pushTelemetryNow(updates)
  }

  async drainPersistenceNow() {
    if (this.isStandby) return { skipped: 'standby', batches: 0, remaining: 0 }
    return this.#client.drainAll({ onDrain: (batch) => this.#persistDrainBatch(batch) })
  }

  async health(opts = {}) {
    return this.#client.health(opts)
  }

  /**
   * Compute eligible `allowed_node_keys` intersection across the candidate snapshot
   * so mixed pools, `vm.policy.allowed_models`, `api_endpoint` prefixes/aliases,
   * Gemini 3P rules, and legacy key pins are strictly enforced by Rust Stage 0
   * while preserving Stage 4 fallback-pool visibility.
   */
  #computeAllowedNodeKeys({
    model,
    modelFamily,
    nodeTypes,
    explicitAllowedNodeKeys,
    apiKeyRecord,
    apiKeyKind,
    poolAccess,
  }) {
    const isMaster = apiKeyKind === 'master' || !apiKeyRecord
    const explicitSet = Array.isArray(explicitAllowedNodeKeys)
      ? new Set(explicitAllowedNodeKeys.map((k) => String(k || '').trim()).filter(Boolean))
      : null
    const typeFilter = Array.isArray(nodeTypes) && nodeTypes.length > 0 ? new Set(nodeTypes) : null
    const legacyPolicy = !isMaster && apiKeyRecord ? keyTierPolicyFromRecord(apiKeyRecord) : null
    const allowUnprefixedGemini3p =
      Boolean(poolAccess?.allowUnprefixedGemini3p) ||
      (!isMaster && normalizeGroupType(apiKeyRecord?.group_type) === 'gemini')

    // Fast path: if snapshot has no inventory indexed yet, preserve explicit list as-is.
    if (this.#nodesByKey.size === 0) {
      return explicitSet ? [...explicitSet] : []
    }

    const useLegacyNodePins = Boolean(
      legacyPolicy && (!poolAccess || poolAccess.legacy === true) && apiKeyRecord?.pool_binding_mode !== 'strict_pool',
    )

    const matched = []
    for (const [nodeKey, nodeCfg] of this.#nodesByKey.entries()) {
      if (explicitSet && !explicitSet.has(nodeKey)) continue
      if (typeFilter && !typeFilter.has(nodeCfg.node_type)) continue

      const inv = this.#inventoryByKey.get(nodeKey)

      // Legacy key scope checks (group_type, allowed_vms, allowed_endpoints, allowed_gemini_envs, category)
      if (useLegacyNodePins) {
        if (nodeCfg.node_type === 'claude_vm' || nodeCfg.node_type === 'codex_vm') {
          if (legacyPolicy.category === 'api') continue
          if (inv?.item && !keyAllowsVm(legacyPolicy, inv.item)) continue
        } else if (nodeCfg.node_type === 'api_endpoint') {
          if (legacyPolicy.category === 'oauth') continue
          if (inv?.item && !keyAllowsEndpoint(legacyPolicy, inv.item)) continue
        } else if (nodeCfg.node_type === 'gemini_env') {
          if (legacyPolicy.category === 'api') continue
          if (!keyAllowsGeminiEnv(legacyPolicy, nodeCfg.node_id)) continue
        }
      }

      // Platform / model compatibility checks
      if (model) {
        if (nodeCfg.node_type === 'claude_vm') {
          if (modelFamily === 'openai' || modelFamily === 'gemini') continue
          const allowlist = inv?.item?.policy?.allowed_models ?? inv?.item?.allowed_models
          if (Array.isArray(allowlist) && allowlist.length > 0 && !modelMatchesAllowlist(model, allowlist)) {
            continue
          }
        } else if (nodeCfg.node_type === 'codex_vm') {
          if (modelFamily === 'claude' || modelFamily === 'gemini') continue
          const allowlist = inv?.item?.policy?.allowed_models ?? inv?.item?.allowed_models
          if (Array.isArray(allowlist) && allowlist.length > 0 && !modelMatchesAllowlist(model, allowlist)) {
            continue
          }
        } else if (nodeCfg.node_type === 'gemini_env') {
          if (!allowUnprefixedGemini3p && (modelFamily === 'claude' || modelFamily === 'openai')) continue
          if (inv?.item && !geminiEnvServesModelLocal(inv.item, model, { allowUnprefixedGemini3p })) continue
        } else if (nodeCfg.node_type === 'api_endpoint') {
          if (inv?.item && !endpointServesModelLocal(inv.item, model)) continue
        }
      }

      matched.push(nodeKey)
    }

    // If every node was filtered out, emit a non-matching sentinel so Rust does NOT treat [] as "allow all".
    if (matched.length === 0) {
      return ['__no_eligible_node__']
    }
    // If every node in the snapshot matched and no explicit list was passed, return [] to keep payload compact.
    if (!explicitSet && matched.length === this.#nodesByKey.size) {
      return []
    }
    return matched
  }

  #buildAcquireRequest(params = {}) {
    const model = String(params.model || '').trim()
    const protocol = String(params.protocol || '').trim()
    const modelFamily = params.modelFamily || params.model_family || inferModelFamily(model, protocol)
    const nodeTypes = params.nodeTypes || params.node_types || null
    const poolAccess = params.poolAccess || params.pool_access || null
    const apiKeyRecord = params.apiKeyRecord || params.api_key_record || null
    const apiKeyKind = params.apiKeyKind || params.api_key_kind || null
    const ownerScope = params.ownerScope || params.owner_scope || null

    let originPoolId = String(
      params.originPoolId ?? params.origin_pool_id ?? poolAccess?.originPool?.id ?? poolAccess?.effectivePool?.id ?? '',
    ).trim()

    if (!originPoolId) {
      originPoolId = resolveVirtualPoolId({
        modelFamily,
        nodeTypes,
        provider: params.provider,
      })
    }

    const jevDowngradePoolId = String(params.jevDowngradePoolId ?? params.jev_downgrade_pool_id ?? '').trim() || null

    const fallbackChain = collectFallbackChainPoolIds(originPoolId, this.#poolsById)

    let api_key_scope = params.apiKeyScope || params.api_key_scope || null
    if (!api_key_scope) {
      const explicitKeys = params.allowedNodeKeys || params.allowed_node_keys || null
      const allowedNodeKeys = this.#computeAllowedNodeKeys({
        model,
        modelFamily,
        nodeTypes,
        explicitAllowedNodeKeys: explicitKeys,
        apiKeyRecord,
        apiKeyKind,
        poolAccess,
      })
      api_key_scope = buildApiKeyScope({
        apiKeyRecord,
        apiKeyKind,
        poolAccess,
        ownerScope,
        allowedNodeKeys,
        allowedModels: params.allowedModels || params.allowed_models || null,
        originPoolId,
        model,
        allowPoolFallbackChain: fallbackChain,
      })
    }

    const rawRequestId = String(params.requestId ?? params.request_id ?? '').trim() || crypto.randomUUID()
    const resolvedProtocol =
      protocol ||
      (modelFamily === 'claude'
        ? 'anthropic'
        : modelFamily === 'openai'
          ? 'openai'
          : modelFamily === 'gemini'
            ? 'google'
            : 'http')
    const isAdminDiagnostic = Boolean(params.isAdminDiagnostic ?? params.is_admin_diagnostic ?? false)
    const pinNodeKey = params.pinNodeKey ?? params.pin_node_key ?? null
    const requestId = scopeSchedulerRequestId(rawRequestId, {
      api_key_scope,
      origin_pool_id: originPoolId,
      jev_downgrade_pool_id: jevDowngradePoolId,
      model,
      model_family: modelFamily,
      protocol: resolvedProtocol,
      pin_node_key: pinNodeKey,
      is_admin_diagnostic: isAdminDiagnostic,
    })
    const sessionId = String(params.sessionId ?? params.session_id ?? '').trim() || crypto.randomUUID()
    const attemptNo = Math.max(1, Number(params.attemptNo ?? params.attempt_no ?? 1) || 1)
    const minConfigVersion =
      Number(params.minConfigVersion ?? params.min_config_version ?? this.#configVersion ?? 0) || 0

    const req = {
      request_id: requestId,
      attempt_no: attemptNo,
      controller_epoch: String(params.controllerEpoch ?? params.controller_epoch ?? this.#client.controllerEpoch),
      min_config_version: minConfigVersion,
      origin_pool_id: originPoolId,
      jev_downgrade_pool_id: jevDowngradePoolId,
      api_key_scope,
      model,
      model_family: modelFamily,
      protocol: resolvedProtocol,
      machine_id: params.machineId !== undefined ? params.machineId : (params.machine_id ?? null),
      session_id: sessionId,
      session_id_source: params.sessionIdSource ?? params.session_id_source ?? null,
      parent_session_id: params.parentSessionId ?? params.parent_session_id ?? null,
      is_ephemeral_probe: Boolean(params.isEphemeralProbe ?? params.is_ephemeral_probe ?? false),
      no_queue: Boolean(params.noQueue ?? params.no_queue ?? false),
      is_admin_diagnostic: isAdminDiagnostic,
      pin_node_key: pinNodeKey,
      exclude_nodes: Array.isArray(params.excludeNodes ?? params.exclude_nodes)
        ? [...new Set((params.excludeNodes ?? params.exclude_nodes).map(String).filter(Boolean))]
        : [],
    }
    return req
  }

  #poolTimeoutsFor(poolId, opts = {}) {
    const pool = this.#poolsById.get(String(poolId || ''))
    return {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      sessionQueueTimeoutMs:
        opts.sessionQueueTimeoutMs ?? opts.session_queue_timeout_ms ?? pool?.session_queue_timeout_ms,
      sessionBusyWaitMs: opts.sessionBusyWaitMs ?? opts.session_busy_wait_ms ?? pool?.session_busy_wait_ms,
      queueWaitMs: opts.queueWaitMs ?? opts.queue_wait_ms ?? pool?.queue_wait_ms,
    }
  }

  async acquireNode(params = {}, opts = {}) {
    const req = this.#buildAcquireRequest(params)
    const callOpts = this.#poolTimeoutsFor(req.jev_downgrade_pool_id || req.origin_pool_id, opts)
    const res = await this.#client.acquire(req, callOpts)
    return { ...res, _request: req }
  }

  async switchNode(params = {}, opts = {}) {
    const release_lease_id = String(params.releaseLeaseId ?? params.release_lease_id ?? '').trim()
    const rawFailure = params.failure || {}
    const http_status = Number(rawFailure.http_status ?? rawFailure.httpStatus ?? 0) || 0
    const error_class =
      rawFailure.error_class ||
      rawFailure.errorClass ||
      classifyErrorClass({
        status: http_status,
        errorCode: rawFailure.error_code || rawFailure.errorCode,
        reason: rawFailure.reason,
        upstreamType: rawFailure.upstream_type || rawFailure.upstreamType,
        isTimeout: Boolean(rawFailure.is_timeout || rawFailure.isTimeout),
        isTransport: Boolean(rawFailure.is_transport || rawFailure.isTransport),
      })

    const failure = {
      http_status,
      error_class,
      ...(rawFailure.error_signature != null ? { error_signature: String(rawFailure.error_signature) } : {}),
      ...(rawFailure.error_message != null ? { error_message: String(rawFailure.error_message) } : {}),
      ...(rawFailure.retry_after_sec != null && Number.isFinite(Number(rawFailure.retry_after_sec))
        ? { retry_after_sec: Math.max(0, Math.round(Number(rawFailure.retry_after_sec))) }
        : {}),
      ...(rawFailure.quota_headers ? { quota_headers: rawFailure.quota_headers } : {}),
    }

    const rawNext = params.nextAttempt ?? params.next_attempt ?? {}
    const next_attempt = this.#buildAcquireRequest({
      ...rawNext,
      attemptNo: Math.max(2, Number(rawNext.attemptNo ?? rawNext.attempt_no ?? 2) || 2),
    })

    const callOpts = this.#poolTimeoutsFor(next_attempt.jev_downgrade_pool_id || next_attempt.origin_pool_id, opts)
    const res = await this.#client.switchLease({ release_lease_id, failure, next_attempt }, callOpts)
    return { ...res, _request: next_attempt }
  }

  switchLease(params = {}, opts = {}) {
    return this.switchNode(params, opts)
  }

  async commitLease(leaseId, opts = {}) {
    const id = typeof leaseId === 'string' ? leaseId.trim() : String(leaseId?.lease_id || '').trim()
    if (!id) return { ok: true, committed: false, already_committed: false, lease_found: false }
    return this.#client.commit(id, opts)
  }

  async releaseLease(leaseIdOrPayload, outcomeOrPayload = {}, maybeOpts = {}) {
    let raw
    let opts = maybeOpts || {}
    if (typeof leaseIdOrPayload === 'string') {
      const id = leaseIdOrPayload.trim()
      if (!id) return { ok: true, released: false }
      if (typeof outcomeOrPayload === 'string') {
        raw = { lease_id: id, outcome: outcomeOrPayload }
      } else {
        raw = { lease_id: id, ...(outcomeOrPayload || {}) }
      }
    } else {
      raw = { ...(leaseIdOrPayload || {}) }
      opts = outcomeOrPayload || {}
      if (!raw.lease_id) return { ok: true, released: false }
    }
    const rawOutcome = String(raw.outcome || 'ok')
      .trim()
      .toLowerCase()
    const outcome = rawOutcome === 'error' || rawOutcome === 'aborted' || rawOutcome === 'timeout' ? rawOutcome : 'ok'
    const httpStatus = raw.http_status ?? raw.httpStatus
    const parsedStatus =
      httpStatus != null && Number.isFinite(Number(httpStatus))
        ? Math.max(0, Math.round(Number(httpStatus)))
        : undefined
    let errorClass = raw.error_class ?? raw.errorClass ?? undefined
    if (!errorClass && (outcome === 'error' || outcome === 'timeout')) {
      if (parsedStatus || raw.error_code || raw.errorCode || raw.reason || outcome === 'timeout') {
        errorClass = classifyErrorClass({
          status: parsedStatus || 0,
          errorCode: raw.error_code || raw.errorCode,
          reason: raw.reason,
          upstreamType: raw.upstream_type || raw.upstreamType,
          isTimeout: outcome === 'timeout' || Boolean(raw.is_timeout || raw.isTimeout),
          isTransport: Boolean(raw.is_transport || raw.isTransport),
        })
      }
    }
    const retryAfter = raw.retry_after_sec ?? raw.retryAfterSec
    const ttftMs = raw.ttft_ms ?? raw.ttftMs
    const tokensUsed = raw.tokens_used ?? raw.tokensUsed
    const payload = {
      lease_id: String(raw.lease_id).trim(),
      outcome,
      ...(parsedStatus != null ? { http_status: parsedStatus } : {}),
      ...(errorClass ? { error_class: errorClass } : {}),
      ...(raw.error_signature != null ? { error_signature: String(raw.error_signature) } : {}),
      ...(raw.error_message != null ? { error_message: String(raw.error_message) } : {}),
      ...(retryAfter != null && Number.isFinite(Number(retryAfter))
        ? { retry_after_sec: Math.max(0, Math.round(Number(retryAfter))) }
        : {}),
      ...(ttftMs != null && Number.isFinite(Number(ttftMs))
        ? { ttft_ms: Math.max(0, Math.round(Number(ttftMs))) }
        : {}),
      ...(tokensUsed != null && Number.isFinite(Number(tokensUsed))
        ? { tokens_used: Math.max(0, Math.round(Number(tokensUsed))) }
        : {}),
      ...(raw.quota_headers || raw.quotaHeaders ? { quota_headers: raw.quota_headers || raw.quotaHeaders } : {}),
    }
    return this.#client.release(payload, opts)
  }

  async explainDispatch(params = {}, opts = {}) {
    const req = this.#buildAcquireRequest(params)
    return this.#client.explain(req, opts)
  }

  explain(params = {}, opts = {}) {
    return this.explainDispatch(params, opts)
  }

  async unrestNode(nodeKey, opts = {}) {
    const key = String(nodeKey || '').trim()
    const modelScope = opts.modelScope ?? opts.model_scope ?? null
    const payload = modelScope ? { node_key: key, model_scope: String(modelScope) } : { node_key: key }
    const rustRes = await this.#client.unrestNode(payload, opts)
    let dbCleared = 0
    if (opts.clearDbPenalties !== false && !this.isStandby) {
      const parsed = parseNodeKey(key)
      const db = this.#resolveDb()
      if (parsed && db) {
        try {
          const repo = new SchedulerPoolsRepo(db)
          if (modelScope) {
            if (
              repo.deleteNodePenalty({
                node_type: parsed.node_type,
                node_id: parsed.node_id,
                model_scope: String(modelScope),
              })
            ) {
              dbCleared += 1
            }
          } else {
            const info = db
              .prepare('DELETE FROM scheduler_node_penalties WHERE node_type = ? AND node_id = ?')
              .run(parsed.node_type, parsed.node_id)
            dbCleared = Number(info.changes) || 0
          }
        } catch (err) {
          this.#onError?.(err, { phase: 'unrest_db_clear', nodeKey: key })
        }
      }
    }
    return {
      ...rustRes,
      unrested: Boolean(rustRes?.ok),
      db_cleared: dbCleared,
    }
  }

  async querySticky(filter = {}, opts = {}) {
    const query = {}
    if (filter.pool_id) query.pool_id = String(filter.pool_id)
    if (filter.scope_kind) query.scope_kind = String(filter.scope_kind)
    if (filter.model_family) query.model_family = String(filter.model_family)
    if (filter.machine_id) query.machine_id = String(filter.machine_id)
    if (filter.session_id) query.session_id = String(filter.session_id)
    if (filter.node_key) query.node_key = String(filter.node_key)
    if (filter.limit != null) query.limit = Number(filter.limit)
    const res = await this.#client.querySticky(query, opts)
    let bindings = Array.isArray(res?.bindings) ? res.bindings : []
    if (filter.identity_id) {
      const want = String(filter.identity_id)
      bindings = bindings.filter((b) => String(b.identity_id || '') === want)
    }
    return { ok: true, bindings, total: bindings.length }
  }

  async deleteSticky(filter = {}, opts = {}) {
    const rustFilter = {}
    if (filter.pool_id) rustFilter.pool_id = String(filter.pool_id)
    if (filter.scope_kind) rustFilter.scope_kind = String(filter.scope_kind)
    if (filter.model_family) rustFilter.model_family = String(filter.model_family)
    if (filter.machine_id) rustFilter.machine_id = String(filter.machine_id)
    if (filter.session_id) rustFilter.session_id = String(filter.session_id)
    const nodeKey =
      filter.node_key || (filter.node_type && filter.node_id ? formatNodeKey(filter.node_type, filter.node_id) : null)
    if (nodeKey) rustFilter.node_key = String(nodeKey)

    let rustDeleted = 0
    if (filter.identity_id && !filter.scope_kind) {
      const id = String(filter.identity_id)
      const r1 = await this.#client.deleteSticky({ ...rustFilter, scope_kind: 'machine', machine_id: id }, opts)
      const r2 = await this.#client.deleteSticky({ ...rustFilter, scope_kind: 'session', session_id: id }, opts)
      rustDeleted = (Number(r1?.deleted) || 0) + (Number(r2?.deleted) || 0)
    } else {
      if (filter.identity_id) {
        if (filter.scope_kind === 'machine') rustFilter.machine_id = String(filter.identity_id)
        else if (filter.scope_kind === 'session') rustFilter.session_id = String(filter.identity_id)
      }
      const rustRes = await this.#client.deleteSticky(rustFilter, opts)
      rustDeleted = Number(rustRes?.deleted) || 0
    }

    let dbDeleted = 0
    if (opts.clearDb !== false && !this.isStandby) {
      const db = this.#resolveDb()
      if (db) {
        try {
          const parsedNode = nodeKey ? parseNodeKey(nodeKey) : null
          const repo = new SchedulerPoolsRepo(db)
          dbDeleted = repo.deleteStickyBindings({
            pool_id: filter.pool_id || null,
            scope_kind: filter.scope_kind || null,
            model_family: filter.model_family || null,
            identity_id: filter.identity_id || null,
            machine_id: filter.machine_id || null,
            session_id: filter.session_id || null,
            node_type: filter.node_type || parsedNode?.node_type || null,
            node_id: filter.node_id || parsedNode?.node_id || null,
            allowAll: Boolean(filter.allowAll || filter.all),
          })
        } catch (err) {
          this.#onError?.(err, { phase: 'delete_sticky_db' })
        }
      }
    }

    return {
      ok: true,
      deleted: Math.max(rustDeleted, dbDeleted),
      rust_deleted: rustDeleted,
      db_deleted: dbDeleted,
    }
  }

  subscribeEvents(opts = {}) {
    return this.#client.subscribeEvents(opts)
  }
}

export function createSchedulerRuntime(options = {}) {
  return new SchedulerRuntime(options)
}
