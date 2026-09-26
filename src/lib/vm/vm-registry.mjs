/**
 * Multi-VM registry — load all vms/*.json (except active.json)
 * Writes go through atomicWriteJson so the DB credential mirror
 * (lib/vm-db-sync.mjs) sees every change.
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson, listVmRecordFiles } from './vm-file.mjs'
import {
  hasAccessPresence,
  hasCredentialPresence,
  hasRefreshPresence,
  clearVmQuotaRestriction,
  markVmRestriction,
} from '../oauth/oauth-credentials.mjs'
import { isManualScheduleLocked } from '../pool/schedule-policy.mjs'
import { isLeftoverQuotaScheduleOff } from '../pool/availability.mjs'
import { manualScheduleLevelOf, parseScheduleLevelInput } from '../pool/credential-weight.mjs'
import { normalizeOwnerId, vmOriginOf } from '../admin/resource-owner.mjs'
import { normalizeVmKind } from './vm-kind.mjs'
import { validTimezone } from '../core/timezone.mjs'
import {
  extraFromCodexHeaders,
  extraToCodexSnapshot,
  buildCodexUsageView,
  codexQuotaPark,
} from '../protocol/codex-usage.mjs'

import { summarizeCodexSlot } from './codex-slot.mjs'
import { evaluateCodexQuotaSchedule } from '../pool/codex-slot-pool.mjs'

export { isCodexVm, normalizeVmKind } from './vm-kind.mjs'

export function listVms(projectRoot) {
  const dir = path.join(projectRoot, 'vms')
  if (!fs.existsSync(dir)) return []
  const files = listVmRecordFiles(dir)
  return files
    .map((f) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        if (!raw?.id) return null
        return summarizeVm(raw, projectRoot)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

export function getVm(projectRoot, id) {
  const file = path.join(projectRoot, 'vms', `${id}.json`)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function summarizeVm(vm, projectRoot = null) {
  const kind = normalizeVmKind(vm)
  const codex = kind.kind === 'codex' ? summarizeCodexSlot(projectRoot, vm) : null
  const quota = codex?.usage?.quota || {}
  return {
    id: vm.id,
    name: vm.name,
    status: vm.status || 'unknown',
    kernel: vm.kernel || null,
    inference_engine: vm.inference_engine || null,
    persona_preset: vm.persona_preset || null,
    seed_policy: vm.seed_policy || null,
    region: vm.region || vm.zone || null,
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
    auth_scheme: kind.kind === 'codex' ? null : vm.claude?.auth_scheme || null,
    has_refresh: kind.kind === 'codex' ? !!codex?.has_refresh : hasRefreshPresence(vm.claude),
    refresh_error: kind.kind === 'codex' ? null : vm.claude?.refresh_error || null,
    account_tier:
      kind.kind === 'codex' ? 'codex' : vm.claude?.account_tier || (hasAccessPresence(vm.claude) ? 'pro' : null),
    has_session_key: false,
    max_concurrency: vm.policy?.maxConcurrency ?? 2,
    max_rpm: vm.policy?.maxRpm ?? 0,
    session_slots: kind.kind === 'codex' ? null : (vm.policy?.sessionSlots ?? null),
    session_slots_override: kind.kind === 'codex' ? false : vm.policy?.sessionSlotsOverride === true,
    allowed_models:
      Array.isArray(vm.policy?.allowed_models) && vm.policy.allowed_models.length
        ? vm.policy.allowed_models.map((id) => String(id || '').trim()).filter(Boolean)
        : null,
    weight: vm.policy?.weight ?? 1,
    schedule_level_manual: manualScheduleLevelOf(vm),
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
    reset_credits: codex?.reset_credits || null,
    plan_type: codex?.plan_type || null,
  }
}

export function getActiveVmId(projectRoot) {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(projectRoot, 'vms', 'active.json'), 'utf8'))
    return a.active_vm
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
export function persistCodexUsage(projectRoot, vmId, { headers, extra, limitedUntil, now = Date.now() } = {}) {
  if (!projectRoot || !vmId) return null
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  if (!fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.codex = { ...(vm.codex || {}) }
  const fromHeaders = extraFromCodexHeaders(headers || {}, now)
  const merged = { ...(vm.codex.extra || {}), ...(fromHeaders || {}), ...(extra || {}) }
  if (limitedUntil) {
    merged.codex_limited_until = new Date(limitedUntil).toISOString()
  } else {
    const parked = codexQuotaPark({ ...merged, codex_limited_until: null }, now)
    if (parked.limited) merged.codex_limited_until = new Date(parked.until).toISOString()
    else delete merged.codex_limited_until
  }
  vm.codex.extra = merged
  vm.codex.usage = buildCodexUsageView(extraToCodexSnapshot(merged))
  vm.updated_at = new Date(now).toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  syncCodexQuotaSchedule(projectRoot, vm, { now })
  return getVm(projectRoot, vmId) || vm
}

/**
 * Extra 5h/7d restriction, same contract as PoolScheduler.syncQuotaSchedule.
 * Never flips the operator switch. Leftover quota-off (not schedule_manual)
 * is restored to on + restriction.
 */
export function syncCodexQuotaSchedule(projectRoot, vm, { now = Date.now() } = {}) {
  if (!projectRoot || !vm?.id) return { action: 'keep', reason: null }
  const ev = evaluateCodexQuotaSchedule(vm, now)
  const file = path.join(projectRoot, 'vms', `${vm.id}.json`)
  const leftover = isLeftoverQuotaScheduleOff(vm)
  if (ev.action === 'restrict' || ev.action === 'restore') {
    const until = Number(ev.until) || now + 5 * 60_000
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

/** Statuses that mean the slot is actually down — not a soft UI pause. */
const HARD_UNAVAILABLE = new Set(['stopped', 'dead', 'error', 'disabled'])

export function vmHasClaudeCredential(vm) {
  return hasCredentialPresence(vm?.claude)
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
  if (proxyInfo) vm.proxy_cli_enabled = true
  atomicWriteJson(file, vm)
  return summarizeVm(vm)
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
