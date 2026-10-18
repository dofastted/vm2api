/**
 * Multi-VM registry — load all vms/*.json (except active.json)
 * Writes go through atomicWriteJson so the DB credential mirror
 * (lib/vm-db-sync.mjs) sees every change.
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson, invalidateReadCache, listVmRecordFiles, readJsonCached } from './vm-file.mjs'
import {
  hasAccessPresence,
  hasCredentialPresence,
  hasRefreshPresence,
  clearVmQuotaRestriction,
  markVmRestriction,
  expiresAtToMs,
} from '../oauth/oauth-credentials.mjs'
import { isManualScheduleLocked } from '../pool/schedule-policy.mjs'
import { isCredentialRefreshFailed, isLeftoverQuotaScheduleOff } from '../pool/availability.mjs'
import { manualScheduleLevelOf, parseScheduleLevelInput } from '../pool/credential-weight.mjs'
import { vmQuotaOverrideOf } from '../pool/vm-quota-override.mjs'
import { activeHoursOf, parseActiveHoursInput } from '../pool/active-hours.mjs'
import { normalizeOwnerId, vmOriginOf, vmOwnerId, VM_ORIGIN } from '../admin/resource-owner.mjs'
import { isCodexVm, normalizeVmKind } from './vm-kind.mjs'
import { canClaudeResetCredits } from '../oauth/credential-mode.mjs'
import { validTimezone } from '../core/timezone.mjs'
import {
  extraFromCodexHeaders,
  extraToCodexSnapshot,
  buildCodexUsageView,
  codexCreditsFromHeaders,
  codexQuotaPark,
  hasSpendableCodexCredits,
} from '../protocol/codex-usage.mjs'

import { summarizeCodexSlot } from './codex-slot.mjs'
import { evaluateCodexQuotaSchedule } from '../pool/codex-slot-pool.mjs'
import { effectiveOpenAIPolicy, normalizeOpenAIQuotaPolicy } from '../pool/openai-quota-policy.mjs'
import { runtimeKind } from './runtime-kind.mjs'
import { hasBoundExit } from './egress.mjs'
import { ensureSlotSmbios } from './machine-spec.mjs'

export { isCodexVm, normalizeVmKind } from './vm-kind.mjs'

export function listVms(projectRoot, routing = null) {
  const dir = path.join(projectRoot, 'vms')
  if (!fs.existsSync(dir)) return []
  const files = listVmRecordFiles(dir)
  return files
    .map((f) => {
      try {
        const raw = readJsonCached(path.join(dir, f))
        if (!raw?.id) return null
        return summarizeVm(raw, projectRoot, routing)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

export function getVm(projectRoot, id) {
  return readJsonCached(path.join(projectRoot, 'vms', `${id}.json`))
}

export function summarizeVm(vm, projectRoot = null, routing = null) {
  const kind = normalizeVmKind(vm)
  const codex = kind.kind === 'codex' ? summarizeCodexSlot(projectRoot, vm) : null
  const quota = codex?.usage?.quota || {}
  const globalOpenAI = normalizeOpenAIQuotaPolicy(routing?.codex?.quota)
  const openAIPolicy = kind.kind === 'codex' ? effectiveOpenAIPolicy(vm, globalOpenAI) : null
  const quotaGate = kind.kind === 'codex' ? evaluateCodexQuotaSchedule(vm, Date.now(), globalOpenAI) : null
  return {
    id: vm.id,
    name: vm.name,
    status: vm.status || 'unknown',
    kernel: vm.kernel || null,
    runtime_type: runtimeKind(vm),
    machine: vm.machine || null,
    inference_engine: vm.inference_engine || null,
    persona_preset: vm.persona_preset || null,
    seed_policy: vm.seed_policy || null,
    region: vm.region || vm.zone || null,
    node_id: vm.node_id || null,
    note: vm.note || null,
    platform: kind.platform,
    family: kind.family,
    codex_kernel: kind.kind === 'codex',
    email: kind.kind === 'codex' ? codex?.email || null : vm.claude?.email || null,
    account_uuid: kind.kind === 'codex' ? null : vm.claude?.account_uuid || null,
    org_uuid: kind.kind === 'codex' ? vm.codex?.chatgpt_account_id || null : vm.claude?.org_uuid || null,
    has_token: kind.kind === 'codex' ? !!codex?.has_token : hasAccessPresence(vm.claude),
    expires_at: kind.kind === 'codex' ? codex?.expires_at || null : vm.claude?.expires_at || null,
    refreshed_at:
      kind.kind === 'codex' ? vm.codex?.usage?.snapshot?.updated_at || null : vm.claude?.refreshed_at || null,
    oauth_source: kind.kind === 'codex' ? 'codex-credentials' : vm.claude?.source || null,
    credential_mode: kind.kind === 'codex' ? 'oauth' : vm.claude?.mode || 'oauth',
    can_claude_reset: canClaudeResetCredits(vm, {
      hasToken: kind.kind === 'codex' ? !!codex?.has_token : hasAccessPresence(vm.claude),
    }),
    auth_scheme: kind.kind === 'codex' ? null : vm.claude?.auth_scheme || null,
    has_refresh: kind.kind === 'codex' ? !!codex?.has_refresh : hasRefreshPresence(vm.claude),
    refresh_error: kind.kind === 'codex' ? null : vm.claude?.refresh_error || null,
    account_tier:
      kind.kind === 'codex' ? 'codex' : vm.claude?.account_tier || (hasAccessPresence(vm.claude) ? 'pro' : null),
    has_session_key: false,
    max_concurrency: kind.kind === 'codex' ? openAIPolicy.max_concurrency : (vm.policy?.maxConcurrency ?? 2),
    max_concurrency_override:
      kind.kind === 'codex' ? openAIPolicy.concurrency_override : vm.policy?.concurrencyOverride === true,
    max_rpm: kind.kind === 'codex' ? openAIPolicy.max_rpm : (vm.policy?.maxRpm ?? 0),
    max_rpm_override: kind.kind === 'codex' ? openAIPolicy.rpm_override : vm.policy?.rpmOverride === true,
    max_sessions: kind.kind === 'codex' ? openAIPolicy.max_sessions : null,
    max_sessions_override: kind.kind === 'codex' ? openAIPolicy.sessions_override : false,
    session_slots: kind.kind === 'codex' ? null : (vm.policy?.sessionSlots ?? null),
    session_slots_override: kind.kind === 'codex' ? false : vm.policy?.sessionSlotsOverride === true,
    scheduling_inherited:
      kind.kind === 'codex'
        ? {
            max_concurrency: globalOpenAI.max_concurrency,
            max_rpm: globalOpenAI.max_rpm,
            max_sessions: globalOpenAI.max_sessions,
            session_slots: null,
          }
        : null,
    quota_override: kind.kind === 'codex' ? null : vmQuotaOverrideOf(vm),
    allowed_models:
      Array.isArray(vm.policy?.allowed_models) && vm.policy.allowed_models.length
        ? vm.policy.allowed_models.map((id) => String(id || '').trim()).filter(Boolean)
        : null,
    weight: vm.policy?.weight ?? 1,
    schedule_level_manual: manualScheduleLevelOf(vm),
    active_hours: activeHoursOf(vm),
    timezone: vm.timezone || null,
    timezone_source: vm.timezone_source || 'auto',
    locale: vm.locale || null,
    proxy: vm.proxy ? { ...vm.proxy, password: vm.proxy.password ? '***' : (vm.proxy.password ?? null) } : null,
    claude_code_version: vm.claude_code_version || null,
    stats: vm.stats || {},
    fingerprint: vm.fingerprint || null,
    schedulable: vm.schedulable !== false,
    schedule_manual: vm.schedule_manual === true,
    schedule_disabled_reason: vm.schedule_disabled_reason || null,
    temp_unschedulable_until: vm.claude?.temp_unschedulable_until || vm.temp_unschedulable_until || null,
    temp_unschedulable_reason: vm.claude?.temp_unschedulable_reason || vm.temp_unschedulable_reason || null,
    owner_user_id: normalizeOwnerId(vm.owner_user_id),
    origin: vmOriginOf(vm),
    proxy_id: vm.proxy?.id || null,
    proxy_cli_enabled: !!vm.proxy_cli_enabled,
    created_at: vm.created_at || null,
    runtime: vm.runtime || null,
    ip: vm.runtime?.ip || null,
    pid: vm.runtime?.pid || null,
    container: vm.runtime?.container || null,
    utilization_5h: quota.utilization_5h ?? null,
    utilization_7d: quota.utilization_7d ?? null,
    reset_5h: quota.reset_5h ?? null,
    reset_7d: quota.reset_7d ?? null,
    status_5h: quota.status_5h ?? null,
    status_7d: quota.status_7d ?? null,
    codex_usage: codex?.usage || null,
    quota_policy:
      kind.kind === 'codex'
        ? {
            ...globalOpenAI,
            ...openAIPolicy,
            reason: quotaGate?.reason || null,
            restricted_until: quotaGate?.until || null,
          }
        : null,
    reset_credits: codex?.reset_credits || null,
    codex_credits: codex?.credits || null,
    plan_type: codex?.plan_type || null,
    claude_reset_credits: kind.kind === 'codex' ? null : vm.claude_reset_credits || null,
  }
}

export function getActiveVmId(projectRoot) {
  try {
    const a = readJsonCached(path.join(projectRoot, 'vms', 'active.json'))
    return a?.active_vm ?? null
  } catch {
    return null
  }
}

export function persistAccountTier(projectRoot, vmId, tier, { source = null } = {}) {
  const key = String(tier || '').toLowerCase()
  if (key !== 'pro' && key !== 'max') return null
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  if (!fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.claude = vm.claude || {}
  if (vm.claude.account_tier_source === 'profile' && source !== 'profile' && source !== 'usage') return vm
  if (vm.claude.account_tier === key && (vm.claude.account_tier_source || null) === source) return vm
  vm.claude.account_tier = key
  vm.claude.account_tier_source = source
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  return vm
}

/**
 * Merge live `x-codex-*` headers (and optional park-until) into vm.codex.
 * Cluster 5H/7D meters read this via summarizeCodexSlot -> usage.quota.
 */
export function persistCodexUsage(
  projectRoot,
  vmId,
  { headers, extra, limitedUntil, quotaExceeded = false, now = Date.now(), policy = null } = {},
) {
  if (!projectRoot || !vmId) return null
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  if (!fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.codex = { ...(vm.codex || {}) }
  const fromHeaders = extraFromCodexHeaders(headers || {}, now)
  const cached = { ...(vm.codex.extra || {}) }
  if (quotaExceeded) {
    // The error proves exhaustion, not which window or its percentage. Drop
    // cached below-cap readings (including aliases) instead of inventing 100%.
    // Keep known caps so a headerless error cannot release an existing limit.
    // Fresh response measurements below are authoritative, even below 100%.
    for (const role of ['primary', 'secondary', '5h', '7d']) {
      const key = `codex_${role}_used_percent`
      if (Object.hasOwn(cached, key) && !(Number(cached[key]) >= 100)) cached[key] = null
    }
  }
  const merged = { ...cached, ...(fromHeaders || {}), ...(extra || {}) }
  if (limitedUntil) {
    merged.codex_limited_until = new Date(limitedUntil).toISOString()
    // The refusal outranks any credits reading until a newer one arrives.
    delete vm.codex.credits
  } else {
    const credits = codexCreditsFromHeaders(headers || {}, now)
    if (credits) vm.codex.credits = credits
    const parked = codexQuotaPark({ ...merged, codex_limited_until: null }, now, {
      waiveWindowCaps: hasSpendableCodexCredits(vm, now),
    })
    if (parked.limited) merged.codex_limited_until = new Date(parked.until).toISOString()
    else delete merged.codex_limited_until
  }
  vm.codex.extra = merged
  vm.codex.usage = buildCodexUsageView(extraToCodexSnapshot(merged))
  vm.updated_at = new Date(now).toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  syncCodexQuotaSchedule(projectRoot, vm, { now, policy })
  return getVm(projectRoot, vmId) || vm
}

/**
 * Extra 5h/7d restriction, same contract as PoolScheduler.syncQuotaSchedule.
 * Never flips the operator switch. Leftover quota-off (not schedule_manual)
 * is restored to on + restriction.
 */
export function syncCodexQuotaSchedule(projectRoot, vm, { now = Date.now(), policy = null } = {}) {
  if (!projectRoot || !vm?.id) return { action: 'keep', reason: null }
  const ev = evaluateCodexQuotaSchedule(vm, now, policy)
  const file = path.join(projectRoot, 'vms', `${vm.id}.json`)
  const leftover = isLeftoverQuotaScheduleOff(vm)
  if (ev.action === 'restrict' || ev.action === 'restore') {
    const until = ev.until
    if (until == null && /_local$/.test(ev.reason || '')) clearVmQuotaRestriction(file)
    const next = markVmRestriction(file, { until, reason: ev.reason })
    if (next) {
      vm.claude = next.claude
      vm.temp_unschedulable_until = next.temp_unschedulable_until
      vm.temp_unschedulable_reason = next.temp_unschedulable_reason
    }
    if (leftover) {
      setVmSchedulable(projectRoot, vm.id, true, null, { preserveStatus: true, source: 'force' })
      vm.schedulable = true
      vm.schedule_disabled_reason = null
    }
    return { ...ev, action: leftover ? 'restore' : 'restrict' }
  }
  if (ev.action === 'clear' || ev.action === 'enable') {
    const next = clearVmQuotaRestriction(file)
    if (next) {
      vm.claude = next.claude
      delete vm.temp_unschedulable_until
      delete vm.temp_unschedulable_reason
    }
    if (leftover || ev.action === 'enable') {
      setVmSchedulable(projectRoot, vm.id, true, null, { preserveStatus: true, source: 'force' })
      vm.schedulable = true
      vm.schedule_disabled_reason = null
      return { ...ev, action: 'enable' }
    }
    return { ...ev, action: 'clear' }
  }
  if (leftover) {
    setVmSchedulable(projectRoot, vm.id, true, null, { preserveStatus: true, source: 'force' })
    vm.schedulable = true
    vm.schedule_disabled_reason = null
    return { action: 'enable', reason: null }
  }
  return ev
}

export function persistAllowedModels(projectRoot, vmId, models) {
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  if (!fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  const next = Array.isArray(models) ? [...new Set(models.map((id) => String(id || '').trim()).filter(Boolean))] : []
  vm.policy = { ...(vm.policy || {}) }
  if (!next.length) delete vm.policy.allowed_models
  else vm.policy.allowed_models = next
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  return vm
}

/** Reload can recreate the container (new id, new exit network); the record must follow. Re-reads so other fields are not clobbered. */
export function persistVmRuntime(projectRoot, vmId, runtime) {
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  if (!runtime || !fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.runtime = runtime
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  return vm
}

export function persistVmSessionSlots(projectRoot, vmId, value, { override = true } = {}) {
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  if (!fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy = {
    ...(vm.policy || {}),
    sessionSlots: value,
    sessionSlotsOverride: override,
  }
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  return vm
}

export function persistVmMaxSessions(projectRoot, vmId, value, { override = true } = {}) {
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  if (!fs.existsSync(file)) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 256) {
    throw new TypeError('max_sessions must be an integer between 0 and 256')
  }
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy = {
    ...(vm.policy || {}),
    maxSessions: value,
    sessionsOverride: override,
  }
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  return vm
}

/** `override` is a parsed `quota_override` (null clears it, the slot follows global quota again). */
export function persistVmQuotaOverride(projectRoot, vmId, override) {
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  if (!fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy = { ...(vm.policy || {}) }
  if (override) vm.policy.quota = override
  else delete vm.policy.quota
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  return vm
}

/** `value` is a parsed `active_hours` window (null clears it: the slot runs 24h). */
export function persistVmActiveHours(projectRoot, vmId, value) {
  const parsed = parseActiveHoursInput(value)
  if (!parsed.ok) throw new TypeError(parsed.error)
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  if (!fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy = { ...(vm.policy || {}) }
  if (parsed.value == null) delete vm.policy.active_hours
  else vm.policy.active_hours = parsed.value
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  return vm
}

export function persistVmScheduleLevel(projectRoot, vmId, value) {
  const parsed = parseScheduleLevelInput(value)
  if (!parsed.ok) throw new TypeError(parsed.error)
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  if (!fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy = { ...(vm.policy || {}) }
  if (parsed.value == null) delete vm.policy.priority
  else vm.policy.priority = parsed.value
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  return vm
}

function applySlotEnginePatch(vm, patch = {}) {
  if (Object.prototype.hasOwnProperty.call(patch, 'inference_engine')) {
    if (patch.inference_engine) vm.inference_engine = patch.inference_engine
    else delete vm.inference_engine
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'persona_preset')) {
    if (patch.persona_preset) vm.persona_preset = patch.persona_preset
    else delete vm.persona_preset
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'dataplane')) {
    if (patch.dataplane) vm.dataplane = patch.dataplane
    else delete vm.dataplane
  }
}

export function persistSlotEnginePolicy(projectRoot, vmId, patch = {}) {
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  if (!fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  applySlotEnginePatch(vm, patch)
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  return vm
}

export function persistSlotEnginePolicyMany(projectRoot, ids, patch = {}) {
  const targets =
    Array.isArray(ids) && ids.length
      ? ids.map((id) => String(id || '').trim()).filter(Boolean)
      : listVms(projectRoot).map((vm) => vm.id)
  const items = []
  const missing = []
  for (const id of targets) {
    const vm = persistSlotEnginePolicy(projectRoot, id, patch)
    if (!vm) missing.push(id)
    else items.push(summarizeVm(vm))
  }
  return { updated: items.length, missing, items }
}
export function setActiveVm(projectRoot, id) {
  const file = path.join(projectRoot, 'vms', 'active.json')
  atomicWriteJson(file, { active_vm: id, updated_at: new Date().toISOString() })
}

/** Drop the active pointer. Used when the last slot is deleted. */
export function clearActiveVm(projectRoot) {
  const file = path.join(projectRoot, 'vms', 'active.json')
  try {
    fs.rmSync(file, { force: true })
  } catch {}
  invalidateReadCache(file)
}

/** Statuses that mean the slot is actually down — not a soft UI pause. */
const HARD_UNAVAILABLE = new Set(['stopped', 'dead', 'error', 'disabled'])

export function vmHasClaudeCredential(vm) {
  return hasCredentialPresence(vm?.claude)
}

/**
 * Credential presence for whichever platform the slot actually runs.
 *
 * A GPT/Codex slot keeps its OAuth in `codex-credentials.json`; `vm.claude` only
 * holds a stub (`refresh_error: 'credential_required'`). Probing the Claude bag
 * therefore reports "no credential" for a perfectly healthy GPT seat, so every
 * caller that parks what looks credential-less (slot start, proxy reload, proxy
 * re-enable) silently drops the whole GPT pool as `no_credential`.
 */
export function vmHasSchedulableCredential(vm, projectRoot = null) {
  if (!vm) return false
  if (!isCodexVm(vm)) {
    if (!vmHasClaudeCredential(vm)) return false
    // An expired access token with a recorded refresh failure is not a live
    // credential: the worker cannot rotate it, every hop will answer 401.
    const expMs = expiresAtToMs(vm.claude?.expires_at)
    if (expMs && expMs > Date.now()) return true
    return !isCredentialRefreshFailed({ vm, now: Date.now() })
  }
  const codex = summarizeCodexSlot(projectRoot, vm)
  return !!(codex?.has_token || codex?.has_refresh)
}

/**
 * Soft `paused` is only a UI mark written by setVmSchedulable(false).
 * If schedulable is back on, the account must remain selectable.
 * Empty inventory slots (no Claude token) stay out of the pool.
 */
export function isVmScheduleReady(vm, { allowMissingCredential = false } = {}) {
  if (!vm) return false
  if (vm.schedulable === false && !isLeftoverQuotaScheduleOff(vm)) return false
  if (!allowMissingCredential && !vmHasClaudeCredential(vm)) return false
  const status = String(vm.status || '').toLowerCase()
  if (HARD_UNAVAILABLE.has(status)) return false
  return true
}

export function setVmSchedulable(
  projectRoot,
  id,
  schedulable,
  reason = null,
  { preserveStatus = false, source = 'auto' } = {},
) {
  const file = path.join(projectRoot, 'vms', `${id}.json`)
  if (!fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  const src = source === 'manual' || source === 'force' ? source : 'auto'
  if (src === 'auto' && isManualScheduleLocked(vm)) return summarizeVm(vm)
  if (src === 'manual') vm.schedule_manual = true
  vm.schedulable = !!schedulable
  vm.schedule_updated_at = new Date().toISOString()
  vm.updated_at = vm.schedule_updated_at
  if (schedulable) {
    vm.schedule_disabled_reason = null
    if (!preserveStatus && String(vm.status || '').toLowerCase() === 'paused') vm.status = 'running'
  } else {
    vm.schedule_disabled_reason = reason || 'disabled'
    if (!preserveStatus && String(vm.status || '').toLowerCase() === 'running') vm.status = 'paused'
  }
  atomicWriteJson(file, vm)
  return summarizeVm(vm)
}
export const KERNEL_UPDATE_HOLD = 'kernel_update'

export function holdSchedulableSlots(project, reason = KERNEL_UPDATE_HOLD) {
  const held = []
  for (const vm of listVms(project)) {
    if (vm?.schedulable === false) continue
    const summary = setVmSchedulable(project, vm.id, false, reason, { preserveStatus: true, source: 'force' })
    if (summary) held.push(vm.id)
  }
  return held
}

export function resumeSchedulableSlots(project, ids, reason = KERNEL_UPDATE_HOLD) {
  const restored = []
  for (const id of ids || []) {
    const vm = getVm(project, id)
    if (!vm || vm.schedule_disabled_reason !== reason) continue
    const summary = setVmSchedulable(project, id, true, null, { preserveStatus: true, source: 'force' })
    if (summary?.schedulable !== false) restored.push(id)
  }
  return restored
}

export async function waitForSlotDrain(poolScheduler, ids, { timeoutMs = 120000 } = {}) {
  const wanted = new Set((ids || []).map(String))
  const count = () => {
    let inflight = 0
    for (const [vmId, value] of poolScheduler?.vmInflight || []) {
      if (wanted.has(String(vmId))) inflight += Number(value) || 0
    }
    return inflight
  }
  const deadline = Date.now() + timeoutMs
  let inflight = count()
  while (inflight > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    inflight = count()
  }
  return { ok: inflight === 0, inflight }
}

export function markKernelRestartPending(project, id, reason = 'kernel_restart_failed') {
  return patchVmRecord(project, id, { kernel_restart_pending: reason })
}

export function clearKernelRestartPending(project, id) {
  return patchVmRecord(project, id, (vm) => {
    delete vm.kernel_restart_pending
    return vm
  })
}

export function bindVmProxy(projectRoot, id, proxyInfo) {
  const file = path.join(projectRoot, 'vms', `${id}.json`)
  if (!fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.proxy = proxyInfo
    ? {
        id: proxyInfo.id,
        host: proxyInfo.host,
        port: proxyInfo.port,
        scheme: proxyInfo.scheme || proxyInfo.kind || 'socks5',
        url: proxyInfo.url || null,
        username: proxyInfo.username || null,
        password: proxyInfo.password == null ? null : proxyInfo.password,
      }
    : null
  // Eligibility (`slotHasBoundProxy`) and CLI egress both require this flag.
  // It is not an operator toggle — it follows whether an exit is bound.
  vm.proxy_cli_enabled = hasBoundExit(vm.proxy)
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm)
  return summarizeVm(vm)
}

/**
 * Copy the bound-exit pair onto an in-memory snapshot. Callers that keep a VM
 * object across `bindVmProxy` (or any other writer) must pull both fields —
 * `proxy` without `proxy_cli_enabled` is how a bound slot became ineligible.
 */
export function adoptVmProxyBinding(target, source) {
  if (!target) return target
  target.proxy = source ? (source.proxy ?? null) : null
  target.proxy_cli_enabled = hasBoundExit(target.proxy)
  return target
}

/**
 * Re-read vm.json, apply a patch of owned fields, write. Use this after another
 * writer (bind, timezone, start) so a stale snapshot cannot clobber their fields.
 */
export function patchVmRecord(projectRoot, id, patch) {
  const file = path.join(projectRoot, 'vms', `${id}.json`)
  if (!fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (typeof patch === 'function') {
    const next = patch(vm)
    if (next && typeof next === 'object' && next !== vm) Object.assign(vm, next)
  } else if (patch && typeof patch === 'object') {
    Object.assign(vm, patch)
  }
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  return vm
}

/**
 * Heal slots whose bound exit and `proxy_cli_enabled` drifted (the #332 stale
 * write). False was never an operator switch — panel/API have no such toggle.
 */
export function repairVmProxyCliEnabled(projectRoot) {
  const repaired = []
  const dir = path.join(projectRoot, 'vms')
  if (!fs.existsSync(dir)) return repaired
  for (const name of listVmRecordFiles(dir)) {
    const file = path.join(dir, name)
    let vm
    try {
      vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (!vm?.id) continue
    const enabled = hasBoundExit(vm.proxy)
    if (vm.proxy_cli_enabled === enabled) continue
    vm.proxy_cli_enabled = enabled
    vm.updated_at = new Date().toISOString()
    atomicWriteJson(file, vm, { mode: 0o600 })
    repaired.push(vm.id)
  }
  return repaired
}

/** Attach a rotated SMBIOS identity to slots that were created without one. */
export function repairSlotSmbios(projectRoot) {
  const repaired = []
  const dir = path.join(projectRoot, 'vms')
  if (!fs.existsSync(dir)) return repaired
  for (const name of listVmRecordFiles(dir)) {
    const file = path.join(dir, name)
    let vm
    try {
      vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (!vm?.id || !ensureSlotSmbios(vm)) continue
    vm.updated_at = new Date().toISOString()
    atomicWriteJson(file, vm, { mode: 0o600 })
    repaired.push(vm.id)
  }
  return repaired
}

/**
 * Write the slot's environment timezone (`TZ` inside the container, `# Environment`
 * in the persona). `source` records who decided it: `manual` pins the value so a
 * later proxy bind will not overwrite it, `proxy_geo` marks it as following the
 * bound exit node.
 *
 * The fingerprint carries its own copy of the zone — leaving that stale would
 * make the workstation identity disagree with the container clock.
 */
export function persistVmTimezone(projectRoot, id, timezone, { source = 'manual' } = {}) {
  const zone = validTimezone(timezone)
  if (!zone) return null
  const file = path.join(projectRoot, 'vms', `${id}.json`)
  if (!fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.timezone = zone
  vm.timezone_source = source
  if (vm.fingerprint && typeof vm.fingerprint === 'object') vm.fingerprint.timezone = zone
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm)
  return summarizeVm(vm)
}

export function persistVmOwner(projectRoot, id, { ownerUserId = null, origin = null } = {}) {
  const file = path.join(projectRoot, 'vms', `${id}.json`)
  if (!fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.owner_user_id = normalizeOwnerId(ownerUserId)
  vm.origin = origin || vmOriginOf({ ...vm, owner_user_id: vm.owner_user_id })
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  return vm
}

/** Return administrator-assigned slots to the platform when their tenant is removed. */
export function reclaimAssignedVms(projectRoot, ownerIds, { onError = null } = {}) {
  const reclaimed = []
  if (!ownerIds.size) return reclaimed
  const dir = path.join(projectRoot, 'vms')
  for (const name of listVmRecordFiles(dir)) {
    try {
      const vm = readJsonCached(path.join(dir, name))
      if (!vm?.id || !ownerIds.has(vmOwnerId(vm)) || vmOriginOf(vm) !== VM_ORIGIN.adminAssigned) continue
      // Keep credentials, quota cooldowns and the operator's scheduling switch intact.
      persistVmOwner(projectRoot, vm.id, { ownerUserId: null, origin: VM_ORIGIN.platform })
      reclaimed.push(vm.id)
    } catch (error) {
      if (!onError) throw error
      onError(error, name)
    }
  }
  return reclaimed
}
