/**
 * Live routing.json holder: persist patches, apply concurrency/tier/probe
 * bodies, and rebuild the account pool. Server keeps the mutable lets;
 * this factory closes over getters/setters so boot and restore share one object.
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from '../vm/vm-file.mjs'
import {
  listVms,
  getVm,
  persistAccountTier,
  persistVmQuotaOverride,
  persistVmSessionSlots,
  persistVmMaxSessions,
  setVmSchedulable,
} from '../vm/vm-registry.mjs'
import { normalizeInferenceConfig, normalizeSessionSlots, resolveInferenceEngine } from '../vm/slot-engine.mjs'
import { slotExec } from '../vm/slot-runtime.mjs'
import { streamIdleTimeoutMs } from '../core/config.mjs'

import { accountTierKey, mergeTierMaps, normalizeTiers } from '../pool/quota-tiers.mjs'
import { vmQuotaOverrideOf } from '../pool/vm-quota-override.mjs'
import { setManualScheduleWins } from '../pool/schedule-policy.mjs'
import { PoolScheduler, normalizePoolRouting } from '../pool/pool-scheduler.mjs'
import { FailoverRunner } from '../pool/failover-runner.mjs'
import { unitCircuit } from '../pool/unit-circuit.mjs'
import { RateLimitService } from '../pool/rate-limit-service.mjs'
import { AccountRuntimeRepo } from '../db/repos/account-runtime-repo.mjs'
import { RequestAttemptsRepo } from '../db/repos/request-attempts-repo.mjs'
import { normalizeOfficialCcConfig } from '../oauth/official-cc-bootstrap.mjs'
import { normalizeHealthProbeConfig } from './health-probe.mjs'
import { normalizeUsageProbeConfig } from '../oauth/usage-probe-monitor.mjs'
import { mergeNotifyConfig } from './notify.mjs'
import { normalizeLoggingConfig } from './request-log.mjs'
import { markVmRefreshError } from '../oauth/oauth-credentials.mjs'
import { shouldMarkMissingRefresh } from '../pool/schedule-eligibility.mjs'
import { normalizeCodexRouting } from '../protocol/codex-route.mjs'
import {
  validateOpenAIQuotaPatch,
  mergeOpenAIQuotaPolicy,
  normalizeOpenAIQuotaPolicy,
} from '../pool/openai-quota-policy.mjs'
import { rustKernelHealth } from '../transport/rust-kernel-client.mjs'
import { requestKernelReloadWhenIdle, syncClaudeKernelConfigs } from '../transport/rust-kernel-supervisor.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { syncCodexQuotaSchedule } from '../vm/vm-registry.mjs'
import { wakeOpenAIWaiter } from '../pool/openai-account-runtime.mjs'
import { normalizeVmConfig } from '../vm/machine-spec.mjs'

export function createRoutingRuntime(ctx) {
  const getRouting = () => (typeof ctx.getRoutingConfig === 'function' ? ctx.getRoutingConfig() : ctx.routingConfig)
  const setRouting = (next) => {
    if (typeof ctx.setRoutingConfig === 'function') ctx.setRoutingConfig(next)
    else ctx.routingConfig = next
  }
  const getPool = () => (typeof ctx.getPoolScheduler === 'function' ? ctx.getPoolScheduler() : ctx.poolScheduler)
  const setPool = (next) => {
    if (typeof ctx.setPoolScheduler === 'function') ctx.setPoolScheduler(next)
    else ctx.poolScheduler = next
  }
  const getHealth = () => (typeof ctx.getHealthMonitor === 'function' ? ctx.getHealthMonitor() : ctx.healthMonitor)
  const getUsage = () => ctx.usageProbeMonitor
  const getNotify = () => ctx.notifyMonitor
  const setRuntimeRepo = (next) => {
    if (typeof ctx.setRuntimeRepo === 'function') ctx.setRuntimeRepo(next)
    else ctx.runtimeRepo = next
  }
  const setAttemptsRepo = (next) => {
    if (typeof ctx.setAttemptsRepo === 'function') ctx.setAttemptsRepo(next)
    else ctx.attemptsRepo = next
  }
  const setFailover = (next) => {
    if (typeof ctx.setFailoverRunner === 'function') ctx.setFailoverRunner(next)
    else ctx.failoverRunner = next
  }

  function applyVmConcurrency(id, n, { override = true } = {}) {
    const vmPath = path.join(ctx.cfg.paths.project, 'vms', `${id}.json`)
    if (!fs.existsSync(vmPath)) return null
    const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    const value = Math.max(0, Math.min(256, Number(n) || 0))
    vm.policy = { ...(vm.policy || {}), maxConcurrency: value, concurrencyOverride: override }
    vm.updated_at = new Date().toISOString()
    atomicWriteJson(vmPath, vm, { mode: 0o600 })
    if (!isCodexVm(vm)) ctx.accountQuota.setMaxConcurrency(vm.claude?.account_uuid || vm.id, value, { override })
    return vm
  }

  function applyVmRpm(id, n, { override = true } = {}) {
    const vmPath = path.join(ctx.cfg.paths.project, 'vms', `${id}.json`)
    if (!fs.existsSync(vmPath)) return null
    const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    const value = Math.max(0, Math.min(1e6, Number(n) || 0))
    vm.policy = { ...(vm.policy || {}), maxRpm: value, rpmOverride: override }
    vm.updated_at = new Date().toISOString()
    atomicWriteJson(vmPath, vm, { mode: 0o600 })
    if (!isCodexVm(vm) && vm.claude) ctx.accountQuota.setMaxRpm(vm.claude.account_uuid || vm.id, value, { override })
    return vm
  }

  function applyVmSessionSlots(id, n, { override = true } = {}) {
    return persistVmSessionSlots(ctx.cfg.paths.project, id, normalizeSessionSlots(n), { override })
  }

  function applyVmMaxSessions(id, n, { override = true } = {}) {
    return persistVmMaxSessions(ctx.cfg.paths.project, id, n, { override })
  }

  /** `override` is already parsed (`parseVmQuotaOverride`); null = follow global quota. */
  function applyVmQuotaOverride(id, override) {
    const vm = persistVmQuotaOverride(ctx.cfg.paths.project, id, override)
    if (!vm) return null
    ctx.accountQuota.setVmQuotaOverride(vm.id, vmQuotaOverrideOf(vm))
    return vm
  }

  function applyRoutingSessionSlots(n) {
    const value = normalizeSessionSlots(n)
    const applied = { updated: 0, skipped: 0 }
    for (const vm of listVms(ctx.cfg.paths.project)) {
      if (vm.codex_kernel || vm.platform === 'openai' || vm.family === 'codex') continue
      if (vm.session_slots_override === true) {
        applied.skipped += 1
        continue
      }
      if (Number(vm.session_slots) === value) continue
      applyVmSessionSlots(vm.id, value, { override: false })
      applied.updated += 1
    }
    return applied
  }

  function applyRoutingConcurrency(n) {
    const v = Math.max(0, Math.min(256, Number(n) || 0))
    const skip = []
    for (const vm of listVms(ctx.cfg.paths.project)) {
      if (isCodexVm(vm)) {
        skip.push(vm.id)
        if (vm.account_uuid) skip.push(vm.account_uuid)
        continue
      }
      // listVms returns flattened summaries; override flags live in the raw record.
      const storedVm = getVm(ctx.cfg.paths.project, vm.id)
      if (storedVm?.policy?.concurrencyOverride) {
        skip.push(vm.id)
        if (vm.account_uuid) skip.push(vm.account_uuid)
        continue
      }
      applyVmConcurrency(vm.id, v, { override: false })
    }
    ctx.accountQuota.applyDefaultConcurrency(v, { skipIds: skip })
    return v
  }

  function vmTierKey(vm) {
    const stored = String(vm.account_tier || vm.claude?.account_tier || '').toLowerCase()
    if (stored === 'pro' || stored === 'max') return stored
    const acc = ctx.accountQuota.repo.get(vm.claude?.account_uuid || vm.account_uuid || vm.id)
    const accountTier = accountTierKey(acc)
    if (accountTier !== 'default') return accountTier
    return vm.claude?.has_access || vm.has_token ? 'pro' : accountTier
  }

  function applyRoutingTierConcurrency(tiers) {
    const routingConfig = getRouting()
    const policies = normalizeTiers(tiers, routingConfig.quota, routingConfig.concurrency)
    const skip = []
    const applied = { default: 0, pro: 0, max: 0, skipped: 0 }
    for (const vm of listVms(ctx.cfg.paths.project)) {
      if (isCodexVm(vm)) {
        skip.push(vm.id)
        if (vm.account_uuid) skip.push(vm.account_uuid)
        continue
      }
      // listVms returns flattened summaries; override flags live in the raw record.
      const storedVm = getVm(ctx.cfg.paths.project, vm.id)
      if (storedVm?.policy?.concurrencyOverride) {
        skip.push(vm.id)
        if (vm.account_uuid) skip.push(vm.account_uuid)
        if (vm.claude?.account_uuid) skip.push(vm.claude.account_uuid)
        applied.skipped += 1
        continue
      }
      const key = vmTierKey(vm)
      const next = Number(policies[key]?.max_concurrency ?? 2)
      const cur = Number(storedVm?.policy?.maxConcurrency)
      if (cur === next) continue
      applyVmConcurrency(vm.id, next, { override: false })
      applied[key] += 1
    }
    ctx.accountQuota.applyTierConcurrency(policies, { skipIds: skip })
    return applied
  }

  /**
   * Drop a VM's manual concurrency / RPM / seat-cap pin and take the value the
   * next routing save would push to it, so the slot follows its tier again.
   */
  function inheritVmScheduling(
    id,
    { concurrency = false, rpm = false, sessionSlots = false, maxSessions = false } = {},
  ) {
    const listed = listVms(ctx.cfg.paths.project).find((vm) => vm.id === id)
    if (!listed) return null
    const routingConfig = getRouting()
    let vm = listed
    if (concurrency || rpm) {
      if (listed.codex_kernel || listed.platform === 'openai' || listed.family === 'codex') {
        const policy = normalizeOpenAIQuotaPolicy(routingConfig.codex?.quota)
        const current = getVm(ctx.cfg.paths.project, id)
        if (current) {
          if (concurrency) applyVmConcurrency(id, policy.max_concurrency, { override: false })
          if (rpm) applyVmRpm(id, policy.max_rpm, { override: false })
          vm = getVm(ctx.cfg.paths.project, id) || vm
        }
      } else {
        const policy = normalizeTiers(routingConfig.tiers, routingConfig.quota, routingConfig.concurrency)[
          vmTierKey(listed)
        ]
        if (concurrency) vm = applyVmConcurrency(id, Number(policy?.max_concurrency ?? 2), { override: false }) || vm
        if (rpm) vm = applyVmRpm(id, Number(policy?.max_rpm ?? 0), { override: false }) || vm
      }
    }
    if (listed.codex_kernel && maxSessions) {
      vm =
        applyVmMaxSessions(id, normalizeOpenAIQuotaPolicy(routingConfig.codex?.quota).max_sessions, {
          override: false,
        }) || vm
    }
    if (sessionSlots) {
      vm = applyVmSessionSlots(id, routingConfig.inference?.session_slots, { override: false }) || vm
    }
    return vm
  }

  function applyRoutingTierRpm(tiers) {
    const routingConfig = getRouting()
    const policies = normalizeTiers(tiers, routingConfig.quota, routingConfig.concurrency)
    const skip = []
    const applied = { default: 0, pro: 0, max: 0, skipped: 0 }
    for (const vm of listVms(ctx.cfg.paths.project)) {
      if (isCodexVm(vm)) {
        skip.push(vm.id)
        if (vm.account_uuid) skip.push(vm.account_uuid)
        continue
      }
      // listVms returns flattened summaries; override flags live in the raw record.
      const storedVm = getVm(ctx.cfg.paths.project, vm.id)
      if (storedVm?.policy?.rpmOverride) {
        skip.push(vm.id)
        if (vm.account_uuid) skip.push(vm.account_uuid)
        if (vm.claude?.account_uuid) skip.push(vm.claude.account_uuid)
        applied.skipped += 1
        continue
      }
      const key = vmTierKey(vm)
      const next = Number(policies[key]?.max_rpm ?? 0)
      const cur = Number(storedVm?.policy?.maxRpm)
      if (cur === next) continue
      applyVmRpm(vm.id, next, { override: false })
      applied[key] += 1
    }
    ctx.accountQuota.applyTierRpm(policies, { skipIds: skip })
    return applied
  }

  function applyRoutingOpenAIQuota(policy = null) {
    const next = normalizeOpenAIQuotaPolicy(policy || getRouting().codex?.quota)
    const applied = { concurrency: 0, rpm: 0, sessions: 0, skipped: 0 }
    for (const listed of listVms(ctx.cfg.paths.project, getRouting())) {
      if (!listed.codex_kernel && listed.platform !== 'openai' && listed.family !== 'codex') continue
      const stored = getVm(ctx.cfg.paths.project, listed.id)
      if (!stored) continue
      const current = stored.policy || {}
      const patch = {}
      if (current.concurrencyOverride !== true && Number(current.maxConcurrency) !== next.max_concurrency) {
        patch.maxConcurrency = next.max_concurrency
        patch.concurrencyOverride = false
        applied.concurrency += 1
      }
      if (current.rpmOverride !== true && Number(current.maxRpm) !== next.max_rpm) {
        patch.maxRpm = next.max_rpm
        patch.rpmOverride = false
        applied.rpm += 1
      }
      if (current.sessionsOverride !== true && Number(current.maxSessions) !== next.max_sessions) {
        patch.maxSessions = next.max_sessions
        patch.sessionsOverride = false
        applied.sessions += 1
      }
      if (Object.keys(patch).length) {
        atomicWriteJson(
          path.join(ctx.cfg.paths.project, 'vms', `${listed.id}.json`),
          {
            ...stored,
            policy: { ...current, ...patch },
          },
          { mode: 0o600 },
        )
      }
      // Re-evaluate only the local soft quota restriction.  This preserves
      // operator disable, credential failures, upstream hard blocks, leases,
      // and the session registry owned by the existing runtime.
      syncCodexQuotaSchedule(ctx.cfg.paths.project, getVm(ctx.cfg.paths.project, listed.id) || stored, {
        policy: next,
      })
    }
    for (let i = 0; i < Math.max(1, applied.concurrency + applied.rpm + applied.sessions); i += 1) {
      wakeOpenAIWaiter()
    }
    return applied
  }

  function syncTierDefaultsIntoRouting() {
    const routingConfig = getRouting()
    const def = routingConfig.tiers?.default || {}
    routingConfig.concurrency = {
      ...(routingConfig.concurrency || {}),
      default_max_per_account: Number(def.max_concurrency ?? 2),
      default_key_concurrency: Number(def.max_concurrency ?? routingConfig.concurrency?.default_key_concurrency ?? 2),
      default_max_rpm: Number(def.max_rpm ?? 0),
    }
    routingConfig.quota = {
      ...(routingConfig.quota || {}),
      safety_ratio: Number(def.limit_5h ?? def.safety_ratio ?? 0.85),
      weekly_safety_ratio: Number(def.limit_7d ?? def.weekly_safety_ratio ?? 0.8),
      warn_ratio: Number(def.warn_ratio ?? 0.75),
    }
  }

  function applyOfficialCcRoutingBody(body, previous = null) {
    if (!body || typeof body !== 'object' || body.official_cc == null) return
    const routingConfig = getRouting()
    routingConfig.official_cc = normalizeOfficialCcConfig({
      ...(previous || {}),
      ...body.official_cc,
    })
  }

  function applyHealthProbeRoutingBody(body, previous = null) {
    if (!body || typeof body !== 'object' || body.health_probe == null) return
    const prev = previous && typeof previous === 'object' ? previous : {}
    const next = body.health_probe && typeof body.health_probe === 'object' ? body.health_probe : {}
    const routingConfig = getRouting()
    routingConfig.health_probe = normalizeHealthProbeConfig({
      ...prev,
      ...next,
      real: { ...(prev.real || {}), ...(next.real || {}) },
      match: { ...(prev.match || {}), ...(next.match || {}) },
    })
    getHealth()?.setConfig(routingConfig.health_probe)
  }

  function applyUsageProbeRoutingBody(body, previous = null) {
    if (!body || typeof body !== 'object' || body.usage_probe == null) return
    const routingConfig = getRouting()
    routingConfig.usage_probe = normalizeUsageProbeConfig({
      ...(previous && typeof previous === 'object' ? previous : {}),
      ...(body.usage_probe && typeof body.usage_probe === 'object' ? body.usage_probe : {}),
    })
    getUsage()?.setConfig(routingConfig.usage_probe)
  }

  function applyNotifyRoutingBody(body, previous = null) {
    if (!body || typeof body !== 'object' || body.notify == null) return
    const routingConfig = getRouting()
    routingConfig.notify = mergeNotifyConfig(previous, body.notify)
    getNotify()?.setConfig(routingConfig.notify)
  }

  function compatibilityTouchesKernel(compatibility) {
    if (!compatibility || typeof compatibility !== 'object') return false
    return (
      Object.prototype.hasOwnProperty.call(compatibility, 'cache_ttl') ||
      Object.prototype.hasOwnProperty.call(compatibility, 'persona_preset')
    )
  }

  function syncKernelPanelConfig(routingConfig) {
    return syncClaudeKernelConfigs(ctx.cfg.paths.project, routingConfig)
  }

  // kernel.json hot-reloads, but the job watchdog reads its idle limit from env at start.
  function reloadClaudeKernelsWhenIdle(routingConfig) {
    const project = ctx.cfg.paths.project
    let queued = 0
    for (const { id } of listVms(project)) {
      const vm = getVm(project, id)
      if (!vm || isCodexVm(vm) || vm.status !== 'running') continue
      if (resolveInferenceEngine(vm, routingConfig) !== 'rust') continue
      if (requestKernelReloadWhenIdle(slotExec(project, vm)).ok) queued += 1
    }
    return queued
  }

  function persistRoutingPatch(body = {}) {
    const hasCodexQuota = body?.codex && Object.prototype.hasOwnProperty.call(body.codex, 'quota')
    if (hasCodexQuota) validateOpenAIQuotaPatch(body.codex.quota)
    let routingConfig = getRouting()
    const prevOfficialCc = routingConfig.official_cc
    const prevHealthProbe = routingConfig.health_probe
    const prevUsageProbe = routingConfig.usage_probe
    const prevNotify = routingConfig.notify
    const prevTiers = routingConfig.tiers
    const prevIdleMs = streamIdleTimeoutMs(routingConfig)
    setRouting(routingConfig)
    if (body.sticky) routingConfig.sticky = { ...(routingConfig.sticky || {}), ...body.sticky }
    if (body.quota) routingConfig.quota = { ...(routingConfig.quota || {}), ...body.quota }
    if (body.concurrency) routingConfig.concurrency = { ...(routingConfig.concurrency || {}), ...body.concurrency }
    if (body.pool) {
      routingConfig.pool = normalizePoolRouting({ ...(routingConfig.pool || {}), ...body.pool })
      setManualScheduleWins(routingConfig.pool.manual_schedule_wins)
    }
    if (body.failover) routingConfig.failover = { ...(routingConfig.failover || {}), ...body.failover }
    if (body.inference) {
      routingConfig.inference = normalizeInferenceConfig({
        ...(routingConfig.inference || {}),
        ...body.inference,
      })
    }
    const nextSessionSlots = normalizeSessionSlots(routingConfig.inference?.session_slots)
    if (body.compatibility)
      routingConfig.compatibility = { ...(routingConfig.compatibility || {}), ...body.compatibility }
    if (body.codex) {
      const nextCodex = { ...(routingConfig.codex || {}), ...body.codex }
      if (hasCodexQuota) {
        nextCodex.quota = mergeOpenAIQuotaPolicy(routingConfig.codex?.quota, body.codex.quota)
      }
      routingConfig.codex = normalizeCodexRouting(nextCodex)
    }
    if (body.vm) {
      const prev = routingConfig.vm && typeof routingConfig.vm === 'object' ? routingConfig.vm : {}
      const next = { ...prev, ...body.vm }
      if (body.vm.smbios && typeof body.vm.smbios === 'object') {
        next.smbios = { ...(prev.smbios || {}), ...body.vm.smbios }
      }
      routingConfig.vm = normalizeVmConfig(next)
    }
    applyOfficialCcRoutingBody(body, prevOfficialCc)
    applyHealthProbeRoutingBody(body, prevHealthProbe)
    applyUsageProbeRoutingBody(body, prevUsageProbe)
    applyNotifyRoutingBody(body, prevNotify)
    routingConfig.tiers = normalizeTiers(
      body.tiers ? mergeTierMaps(prevTiers, body.tiers) : prevTiers,
      routingConfig.quota,
      routingConfig.concurrency,
    )
    syncTierDefaultsIntoRouting()
    if (body.logging) {
      routingConfig.logging = normalizeLoggingConfig({ ...(routingConfig.logging || {}), ...body.logging })
      ctx.requestLog.setConfig({
        mode: routingConfig.logging.mode,
        retainDays: routingConfig.logging.retain_days,
        debugRetainDays: routingConfig.logging.debug_retain_days,
        maxMb: routingConfig.logging.max_mb,
        mutedErrorClasses: routingConfig.logging.muted_error_classes,
      })
    }
    fs.mkdirSync(path.dirname(ctx.routingConfigPath), { recursive: true })
    fs.writeFileSync(ctx.routingConfigPath, JSON.stringify(routingConfig, null, 2))
    ctx.stickyRouter.reloadConfig(routingConfig)
    ctx.accountQuota.reloadConfig(routingConfig)
    getPool()?.reloadConfig?.(poolSchedulerConfig())
    const idleChanged = streamIdleTimeoutMs(routingConfig) !== prevIdleMs
    const kernelPersona =
      compatibilityTouchesKernel(body.compatibility) || idleChanged ? syncKernelPanelConfig(routingConfig) : null
    const kernelReload = idleChanged ? reloadClaudeKernelsWhenIdle(routingConfig) : 0
    // Pool and failover settings hot-reload into the live scheduler and runner.
    // Rebuilding them would drop the seat book and queues while their requests
    // still run (the panel sends `failover` with every routing save).
    if (body.pool) configureUnitCircuit(routingConfig)
    if (body.failover) ctx.failoverRunner?.reloadConfig?.(routingConfig.failover || {})
    try {
      return {
        concurrency: applyRoutingTierConcurrency(routingConfig.tiers),
        rpm: applyRoutingTierRpm(routingConfig.tiers),
        session_slots:
          body.inference && Object.prototype.hasOwnProperty.call(body.inference, 'session_slots')
            ? applyRoutingSessionSlots(nextSessionSlots)
            : { updated: 0, skipped: 0 },
        openai_quota: hasCodexQuota
          ? applyRoutingOpenAIQuota(routingConfig.codex.quota)
          : { concurrency: 0, rpm: 0, sessions: 0, skipped: 0 },
        kernel_persona: kernelPersona,
        kernel_reload: kernelReload,
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'routing_tier_apply_failed',
          error: String(err?.message || err),
        }),
      )
      return {
        concurrency: { skipped: 0 },
        rpm: { skipped: 0 },
        kernel_persona: kernelPersona,
        kernel_reload: kernelReload,
      }
    }
  }

  function loadRoutingConfig() {
    let raw
    try {
      raw = fs.readFileSync(ctx.routingConfigPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT')
        throw new Error(`Routing config '${ctx.routingConfigPath}' not found`, { cause: error })
      throw new Error(`Routing config '${ctx.routingConfigPath}' unreadable: ${error?.message || error}`, {
        cause: error,
      })
    }
    try {
      const doc = JSON.parse(raw)
      const hasOpenAIQuota = Object.prototype.hasOwnProperty.call(doc.codex || {}, 'quota')
      doc.codex = normalizeCodexRouting(doc.codex)
      doc.pool = normalizePoolRouting(doc.pool)
      doc.vm = normalizeVmConfig(doc.vm)
      if (!hasOpenAIQuota) migrateLegacyOpenAIPolicies(doc)
      return doc
    } catch (error) {
      throw new Error(`Routing config '${ctx.routingConfigPath}' has invalid JSON: ${error?.message || error}`, {
        cause: error,
      })
    }
  }

  function migrateLegacyOpenAIPolicies(doc) {
    const quota = normalizeOpenAIQuotaPolicy(doc.codex?.quota)
    for (const summary of listVms(ctx.cfg.paths.project)) {
      if (!isCodexVm(summary)) continue
      const stored = getVm(ctx.cfg.paths.project, summary.id)
      if (!stored) continue
      const policy = stored.policy || {}
      const nextPolicy = { ...policy }
      let vmChanged = false
      const preserve = (field, override, fallback) => {
        if (policy[override] === true) return
        const raw = policy[field]
        const present = Object.prototype.hasOwnProperty.call(policy, field) && raw !== null && raw !== ''
        const value = field === 'maxConcurrency' && raw === 0 ? 2 : raw
        if (!present || typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
          if (nextPolicy[field] !== fallback || nextPolicy[override] !== false) {
            nextPolicy[field] = fallback
            nextPolicy[override] = false
            vmChanged = true
          }
          return
        }
        if (value !== fallback) {
          if (nextPolicy[field] !== value || nextPolicy[override] !== true) vmChanged = true
          nextPolicy[field] = value
          nextPolicy[override] = true
          return
        }
        if (nextPolicy[field] !== fallback || nextPolicy[override] !== false) vmChanged = true
        nextPolicy[field] = fallback
        nextPolicy[override] = false
      }
      preserve('maxConcurrency', 'concurrencyOverride', quota.max_concurrency)
      preserve('maxRpm', 'rpmOverride', quota.max_rpm)
      preserve('maxSessions', 'sessionsOverride', quota.max_sessions)
      if (vmChanged) {
        atomicWriteJson(
          path.join(ctx.cfg.paths.project, 'vms', `${summary.id}.json`),
          {
            ...stored,
            policy: nextPolicy,
          },
          { mode: 0o600 },
        )
      }
    }
    const canonical = normalizeCodexRouting(doc.codex)
    doc.codex = canonical
    atomicWriteJson(ctx.routingConfigPath, doc, { mode: 0o600 })
  }

  function poolSchedulerConfig() {
    const routingConfig = getRouting()
    return {
      ...(routingConfig.pool || {}),
      fable_max_per_account: Number(routingConfig.concurrency?.fable_max_per_account ?? 4),
      default_session_slots: normalizeSessionSlots(routingConfig.inference?.session_slots),
      default_max_per_account: Number(routingConfig.concurrency?.default_max_per_account ?? 2),
    }
  }

  function storedAccountTier({ accountId = null, vmId = null, vm = null } = {}) {
    let tier = vm?.claude?.account_tier || null
    if (!tier && vmId) {
      try {
        tier = getVm(ctx.cfg.paths.project, vmId)?.claude?.account_tier || null
      } catch {}
    }
    if (!tier && accountId) {
      try {
        tier = ctx.accountQuota.repo.get(accountId)?.unified?.account_tier || null
      } catch {}
    }
    return String(tier || '').toLowerCase()
  }

  function configureUnitCircuit(routingConfig) {
    unitCircuit.configure({
      failureThreshold: routingConfig.pool?.circuit_failure_threshold,
      openMs: routingConfig.pool?.circuit_open_ms,
    })
  }

  function initPoolRuntime() {
    const routingConfig = getRouting()
    const runtimeRepo = new AccountRuntimeRepo()
    const attemptsRepo = new RequestAttemptsRepo()
    setRuntimeRepo(runtimeRepo)
    setAttemptsRepo(attemptsRepo)
    ctx.accountQuota.attachRuntimeRepo(runtimeRepo)
    try {
      attemptsRepo.cleanup(routingConfig?.logging?.retain_days || 7)
    } catch {}
    const poolScheduler = new PoolScheduler({
      projectRoot: ctx.cfg.paths.project,
      stickyRouter: ctx.stickyRouter,
      accountQuota: ctx.accountQuota,
      runtimeRepo,
      workerHealth: rustKernelHealth,
      config: poolSchedulerConfig(),
    })
    setPool(poolScheduler)
    configureUnitCircuit(routingConfig)
    ctx.accountQuota.onQuotaCooldownCleared = () => {
      try {
        poolScheduler.notifyCapacity()
      } catch {}
    }
    const rateLimitService = new RateLimitService({
      runtimeRepo,
      accountQuota: ctx.accountQuota,
      config: routingConfig.rate_limit || {},
      onUsageProbe: ({ vmId }) => {
        if (!vmId || typeof ctx.probeUsageOne !== 'function') return
        Promise.resolve(ctx.probeUsageOne(vmId)).catch(() => {})
      },
    })
    poolScheduler.rateLimitService = rateLimitService
    const failoverRunner = new FailoverRunner({
      scheduler: poolScheduler,
      stickyRouter: ctx.stickyRouter,
      attemptsRepo,
      rateLimitService,
      config: routingConfig.failover || {},
      onProxyFailure: (vmId, reason) => {
        ctx.proxyPool.reportRuntimeFailure(vmId, reason)
      },
      onFablePlanDenied: ({ selected }) => {
        const accountId = selected?.accountId
        if (accountId && selected?.model) {
          try {
            ctx.accountQuota.markModelUnsupported(accountId, selected.model)
          } catch {}
        }
      },
      onFableSuccess: ({ selected, model }) => {
        const accountId = selected?.accountId
        if (accountId) {
          try {
            ctx.accountQuota.setAccountTier(accountId, 'max')
            ctx.accountQuota.clearModelUnsupported(accountId, model)
          } catch {}
        }
        if (selected?.vmId) {
          try {
            persistAccountTier(ctx.cfg.paths.project, selected.vmId, 'max')
          } catch {}
        }
      },
      onCredentialFailure: ({ selected, policy }) => {
        if (!selected?.vmId) return
        const vmPath = path.join(ctx.cfg.paths.project, 'vms', `${selected.vmId}.json`)
        if (policy?.reason === 'oauth_revoked' || policy?.reason === 'oauth_invalid_grant') {
          try {
            markVmRefreshError(vmPath, {
              error: {
                code: policy.reason === 'oauth_revoked' ? 'oauth_revoked' : 'invalid_grant',
                message:
                  policy.reason === 'oauth_revoked'
                    ? 'OAuth access token has been revoked'
                    : 'OAuth credential was rejected',
              },
            })
          } catch {}
          return
        }
        if (policy?.reason === 'oauth_no_refresh' && shouldMarkMissingRefresh(selected.vm)) {
          setVmSchedulable(ctx.cfg.paths.project, selected.vmId, false, 'oauth_no_refresh')
        }
      },
    })
    setFailover(failoverRunner)
  }

  return {
    persistRoutingPatch,
    applyOfficialCcRoutingBody,
    applyHealthProbeRoutingBody,
    applyUsageProbeRoutingBody,
    applyNotifyRoutingBody,
    applyRoutingConcurrency,
    applyRoutingTierConcurrency,
    applyRoutingTierRpm,
    applyRoutingOpenAIQuota,
    syncTierDefaultsIntoRouting,
    loadRoutingConfig,
    poolSchedulerConfig,
    initPoolRuntime,
    applyVmConcurrency,
    applyVmRpm,
    applyVmMaxSessions,
    migrateLegacyOpenAIPolicies,
    applyVmSessionSlots,
    inheritVmScheduling,
    applyVmQuotaOverride,
    storedAccountTier,
    vmTierKey,
  }
}
