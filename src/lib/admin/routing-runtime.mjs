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
  persistVmQuotaOverride,
  persistVmSessionSlots,
  persistVmMaxSessions,
  markUnschedulable,
} from '../vm/vm-registry.mjs'
import {
  normalizeInferenceConfig,
  normalizeSessionSlots,
  resolveInferenceEngine,
  resolveKernelDataplane,
} from '../vm/slot-engine.mjs'
import { slotExec } from '../vm/slot-runtime.mjs'
import { maxRequestBytes, streamIdleTimeoutMs } from '../core/config.mjs'

import { accountTierKey, mergeTierMaps, normalizeTiers } from '../pool/quota-tiers.mjs'
import { mergeBatchGroupConfig } from '../pool/batch-group.mjs'
import { vmQuotaOverrideOf } from '../pool/vm-quota-override.mjs'
import { PoolScheduler, normalizePoolRouting, validateQuotaRoutingPatch } from '../pool/pool-scheduler.mjs'
import { FailoverRunner } from '../pool/failover-runner.mjs'
import { unitCircuit } from '../pool/unit-circuit.mjs'
import { RateLimitService } from '../pool/rate-limit-service.mjs'
import { AccountRuntimeRepo } from '../db/repos/account-runtime-repo.mjs'
import { RequestAttemptsRepo } from '../db/repos/request-attempts-repo.mjs'
import { normalizeOfficialCcConfig } from '../oauth/official-cc-bootstrap.mjs'
import { normalizeHealthProbeConfig } from './health-probe.mjs'
import { normalizeUsageProbeConfig } from '../oauth/usage-probe-monitor.mjs'
import { normalizeWarmupConfig } from '../pool/account-warmup.mjs'
import { mergeNotifyConfig, validateNotifyRoutingPatch } from './notify.mjs'
import { normalizeRedaction } from '../redaction/policy.mjs'
import { ensureRedaction } from '../redaction/runtime.mjs'
import { normalizeLoggingConfig, validateLoggingRoutingPatch } from './request-log.mjs'
import { markVmRefreshError } from '../oauth/oauth-credentials.mjs'
import { shouldMarkMissingRefresh } from '../pool/schedule-eligibility.mjs'
import {
  normalizeCodexRouting,
  normalizeInferenceWebsocket,
  validateInferenceWebsocketPatch,
} from '../protocol/codex-route.mjs'
import { mergeGeminiRouting, normalizeGeminiRouting, validateGeminiRoutingPatch } from '../gemini/routing-config.mjs'
import { callGeminiHost } from '../gemini/routes.mjs'
import {
  validateOpenAIQuotaPatch,
  mergeOpenAIQuotaPolicy,
  normalizeOpenAIQuotaPolicy,
} from '../pool/openai-quota-policy.mjs'
import { gatewayPolicyReady, rustKernelHealth } from '../transport/rust-kernel-client.mjs'
import {
  requestKernelReloadWhenIdle,
  syncClaudeKernelConfigs,
  syncCragSessionPolicy,
} from '../transport/rust-kernel-supervisor.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { syncCodexQuotaSchedule } from '../vm/vm-registry.mjs'
import { wakeOpenAIWaiter } from '../pool/openai-account-runtime.mjs'
import { normalizeVmConfig } from '../vm/machine-spec.mjs'
import { normalizeCragZombieGuardConfig } from '../vm/crag-zombie-guard.mjs'
import { applyNativeTelemetry } from '../vm/fleet-update.mjs'
import {
  telemetryDefaultEnabled,
  telemetryDisableNonessentialTraffic,
  telemetryUploadInterval,
} from '../vm/native-telemetry.mjs'

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
  const getWarmup = () => ctx.warmupMonitor
  const getCragZombieGuard = () => ctx.cragZombieGuard
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

  function applyVmSessionSlots(id, n, { override = true, publish = true } = {}) {
    const project = ctx.cfg.paths.project
    const vm = persistVmSessionSlots(project, id, normalizeSessionSlots(n), { override })
    if (publish && vm && syncCragSessionPolicy(project, vm, getRouting())) reloadCragSessionPolicy(vm)
    return vm
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
      applyVmSessionSlots(vm.id, value, { override: false, publish: false })
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

  function applyRoutingTierConcurrency(tiers, { preserveExisting = false } = {}) {
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
      // Boot keeps persisted slot settings; explicit routing saves update inherited
      // values. Account DB synchronization and live tier admission still run below.
      if (preserveExisting && Object.prototype.hasOwnProperty.call(storedVm?.policy || {}, 'maxConcurrency')) {
        continue
      }
      const key = vmTierKey(vm)
      const next = Number(policies[key]?.max_concurrency ?? 2)
      const cur = Number(storedVm?.policy?.maxConcurrency)
      // An explicit save also releases a legacy unflagged pin when its value
      // already matches the tier; a materialized inherited value needs no write.
      if (cur === next && storedVm?.policy?.concurrencyOverride === false) continue
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
    const prev = normalizeHealthProbeConfig(previous && typeof previous === 'object' ? previous : {})
    const next = body.health_probe && typeof body.health_probe === 'object' ? body.health_probe : {}
    const routingConfig = getRouting()

    const hasNextAnthropic = next.anthropic && typeof next.anthropic === 'object'
    const hasNextOpenai = next.openai && typeof next.openai === 'object'
    const hasNextGoogle = next.google && typeof next.google === 'object'
    const hasNextReal = next.real && typeof next.real === 'object'
    const hasNextGemini = next.gemini && typeof next.gemini === 'object'

    const nextAnthropic = { ...prev.anthropic, ...(hasNextAnthropic ? next.anthropic : {}) }
    const nextOpenai = { ...prev.openai, ...(hasNextOpenai ? next.openai : {}) }
    const nextGoogle = { ...prev.google, ...(hasNextGoogle ? next.google : {}) }

    if (!hasNextAnthropic) {
      if (Object.prototype.hasOwnProperty.call(next, 'interval_sec')) nextAnthropic.interval_sec = next.interval_sec
      if (Object.prototype.hasOwnProperty.call(next, 'cache_ttl_sec')) nextAnthropic.cache_ttl_sec = next.cache_ttl_sec
      else if (Object.prototype.hasOwnProperty.call(next, 'max_stale_sec'))
        nextAnthropic.cache_ttl_sec = next.max_stale_sec
      if (Object.prototype.hasOwnProperty.call(next, 'probe_all_slots'))
        nextAnthropic.probe_all_slots = next.probe_all_slots
      if (hasNextReal) {
        if (Object.prototype.hasOwnProperty.call(next.real, 'model')) {
          nextAnthropic.models = next.real.model ? [next.real.model] : []
        }
        for (const k of ['prompt', 'max_tokens', 'timeout_ms', 'outbound_mode', 'vm_ids']) {
          if (Object.prototype.hasOwnProperty.call(next.real, k)) nextAnthropic[k] = next.real[k]
        }
      }
      if (!hasNextOpenai && !hasNextGoogle && Object.prototype.hasOwnProperty.call(next, 'enabled')) {
        nextAnthropic.enabled = next.enabled
      }
    }

    if (!hasNextOpenai && hasNextReal) {
      if (Object.prototype.hasOwnProperty.call(next.real, 'openai_model')) {
        nextOpenai.models = next.real.openai_model ? [next.real.openai_model] : []
        if (!hasNextAnthropic && !hasNextGoogle && nextAnthropic.enabled) {
          nextOpenai.enabled = nextOpenai.models.length > 0
        }
      }
      for (const k of ['prompt', 'max_tokens', 'timeout_ms', 'vm_ids']) {
        if (Object.prototype.hasOwnProperty.call(next.real, k)) nextOpenai[k] = next.real[k]
      }
    }

    if (!hasNextGoogle && hasNextGemini) {
      for (const k of ['enabled', 'interval_sec', 'cache_ttl_sec', 'all_models', 'prompt', 'timeout_ms']) {
        if (Object.prototype.hasOwnProperty.call(next.gemini, k)) nextGoogle[k] = next.gemini[k]
      }
      if (Object.prototype.hasOwnProperty.call(next.gemini, 'models')) {
        nextGoogle.models = next.gemini.models
      } else if (Object.prototype.hasOwnProperty.call(next.gemini, 'model')) {
        nextGoogle.models = next.gemini.model ? [next.gemini.model] : []
      }
    }

    routingConfig.health_probe = normalizeHealthProbeConfig({
      ...prev,
      ...next,
      anthropic: nextAnthropic,
      openai: nextOpenai,
      google: nextGoogle,
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

  function applyWarmupRoutingBody(body, previous = null) {
    if (!body || typeof body !== 'object' || body.warmup == null) return
    const routingConfig = getRouting()
    routingConfig.warmup = normalizeWarmupConfig({
      ...(previous && typeof previous === 'object' ? previous : {}),
      ...(body.warmup && typeof body.warmup === 'object' ? body.warmup : {}),
    })
    getWarmup()?.setConfig(routingConfig.warmup)
  }

  function applyCragZombieGuardRoutingBody(body, previous = null) {
    if (!body || typeof body !== 'object' || body.crag_zombie_guard == null) return
    const routingConfig = getRouting()
    routingConfig.crag_zombie_guard = normalizeCragZombieGuardConfig({
      ...(previous && typeof previous === 'object' ? previous : {}),
      ...(body.crag_zombie_guard && typeof body.crag_zombie_guard === 'object' ? body.crag_zombie_guard : {}),
    })
    getCragZombieGuard()?.setConfig(routingConfig.crag_zombie_guard)
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
      Object.prototype.hasOwnProperty.call(compatibility, 'persona_preset') ||
      Object.prototype.hasOwnProperty.call(compatibility, 'crag_persona_preset') ||
      Object.prototype.hasOwnProperty.call(compatibility, 'cch_enabled') ||
      Object.prototype.hasOwnProperty.call(compatibility, 'cc_entrypoint')
    )
  }

  function inferenceTouchesKernel(inference) {
    if (!inference || typeof inference !== 'object') return false
    return ['session_idle_ttl_seconds', 'session_slots', 'prewarm_enabled'].some((key) => Object.hasOwn(inference, key))
  }

  function reloadCragSessionPolicy(vm) {
    if (vm.status !== 'running' || resolveInferenceEngine(vm, getRouting()) !== 'rust') return
    requestKernelReloadWhenIdle(slotExec(ctx.cfg.paths.project, vm), { requireLiveKernel: true })
  }

  function syncKernelPanelConfig(routingConfig) {
    return syncClaudeKernelConfigs(ctx.cfg.paths.project, routingConfig, reloadCragSessionPolicy)
  }

  // Legacy watchdogs read idle limits at startup. Native policy-capable
  // workers get the new limit on each request instead.
  async function reloadClaudeKernelsWhenIdle(routingConfig, { idleOnly }) {
    const project = ctx.cfg.paths.project
    const pending = []
    for (const { id } of listVms(project)) {
      const vm = getVm(project, id)
      if (!vm || isCodexVm(vm) || vm.status !== 'running') continue
      if (resolveInferenceEngine(vm, routingConfig) !== 'rust') continue
      const exec = slotExec(project, vm)
      pending.push(
        (async () => {
          if (idleOnly) {
            const health = await rustKernelHealth(exec, { timeoutMs: 800 }).catch(() => null)
            if (gatewayPolicyReady(health)) return false
          }
          return requestKernelReloadWhenIdle(exec).ok
        })(),
      )
    }
    return (await Promise.all(pending)).filter(Boolean).length
  }

  // Native slots hot-read kernel.json; publication must be acknowledged per VM.
  async function syncTelemetryUploadInterval(
    routingConfig,
    { defaultEnabled = false, prevDefaultEnabled = false, disableNonessentialChanged = false } = {},
  ) {
    const project = ctx.cfg.paths.project
    const applied = { updated: 0, queued: 0, skipped: 0, failed: [] }
    const optIn = defaultEnabled === true && prevDefaultEnabled !== true
    let optedIn = 0
    for (const { id } of listVms(project)) {
      const vm = getVm(project, id)
      if (!vm || isCodexVm(vm)) continue
      if (optIn && vm.seed_policy?.telemetry_disabled !== false) {
        const vmPath = path.join(project, 'vms', `${id}.json`)
        const fresh = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        fresh.seed_policy = { ...(fresh.seed_policy || {}), telemetry_disabled: false }
        fresh.updated_at = new Date().toISOString()
        atomicWriteJson(vmPath, fresh, { mode: 0o600 })
        optedIn += 1
      }
      if (resolveKernelDataplane(vm, routingConfig) === 'crag' && !optIn && !disableNonessentialChanged) {
        applied.skipped += 1
        continue
      }
      try {
        const current = getVm(project, id) || vm
        const result = await applyNativeTelemetry({
          projectRoot: project,
          vm: current,
          routing: routingConfig,
          lifecycle: { watchdog: ctx.kernelWatchdog, poolScheduler: ctx.poolScheduler },
        })
        if (result.supported === false) {
          applied.skipped += 1
          continue
        }
        if (!result.ok || !result.published) {
          applied.failed.push(vm.id)
          continue
        }
        applied.updated += 1
      } catch {
        applied.failed.push(vm.id)
      }
    }
    if (optIn) applied.opted_in = optedIn
    return applied
  }

  async function persistRoutingPatch(body = {}) {
    validateNotifyRoutingPatch(body)
    const hasCodexQuota = body?.codex && Object.prototype.hasOwnProperty.call(body.codex, 'quota')
    if (hasCodexQuota) validateOpenAIQuotaPatch(body.codex.quota)
    validateInferenceWebsocketPatch(body)
    validateGeminiRoutingPatch(body)
    validateQuotaRoutingPatch(body, getRouting()?.quota)
    validateLoggingRoutingPatch(body, getRouting()?.logging)
    let nextRedaction = null
    if (body.redaction !== undefined) {
      nextRedaction = normalizeRedaction(body.redaction, { strict: true })
      const effectiveRouting = {
        ...getRouting(),
        ...(body.failover ? { failover: { ...(getRouting()?.failover || {}), ...body.failover } } : {}),
        redaction: nextRedaction,
      }
      await ensureRedaction(effectiveRouting, { projectRoot: ctx.cfg.paths.project })
    }
    let routingConfig = getRouting()
    const prevOfficialCc = routingConfig.official_cc
    const prevHealthProbe = routingConfig.health_probe
    const prevUsageProbe = routingConfig.usage_probe
    const prevWarmup = routingConfig.warmup
    const prevCragZombieGuard = routingConfig.crag_zombie_guard
    const prevNotify = routingConfig.notify
    const prevTiers = routingConfig.tiers
    const prevIdleMs = streamIdleTimeoutMs(routingConfig)
    const prevRequestBytes = maxRequestBytes(routingConfig)
    const prevUploadInterval = telemetryUploadInterval(routingConfig)
    const prevDefaultEnabled = telemetryDefaultEnabled(routingConfig)
    const prevDisableNonessential = telemetryDisableNonessentialTraffic(routingConfig)
    setRouting(routingConfig)
    if (body.sticky) routingConfig.sticky = { ...(routingConfig.sticky || {}), ...body.sticky }
    if (body.quota) routingConfig.quota = { ...(routingConfig.quota || {}), ...body.quota }
    if (body.concurrency) routingConfig.concurrency = { ...(routingConfig.concurrency || {}), ...body.concurrency }
    if (body.pool) {
      routingConfig.pool = normalizePoolRouting({ ...(routingConfig.pool || {}), ...body.pool })
    }
    if (body.batch_group && typeof body.batch_group === 'object' && !Array.isArray(body.batch_group)) {
      routingConfig.batch_group = mergeBatchGroupConfig({
        ...(routingConfig.batch_group || {}),
        ...body.batch_group,
      })
    }
    if (body.failover) routingConfig.failover = { ...(routingConfig.failover || {}), ...body.failover }
    if (body.inference) {
      routingConfig.inference = normalizeInferenceConfig({
        ...(routingConfig.inference || {}),
        ...body.inference,
      })
    }
    const nextSessionSlots = normalizeSessionSlots(routingConfig.inference?.session_slots)
    if (body.compatibility) {
      routingConfig.compatibility = { ...(routingConfig.compatibility || {}), ...body.compatibility }
      delete routingConfig.compatibility.persona_rules
      delete routingConfig.compatibility.persona_leak_append
      // Unified SSOT: saving persona_preset retires stale crag_persona_preset drift.
      if (
        Object.prototype.hasOwnProperty.call(body.compatibility, 'persona_preset') &&
        !Object.prototype.hasOwnProperty.call(body.compatibility, 'crag_persona_preset')
      ) {
        delete routingConfig.compatibility.crag_persona_preset
      } else if (
        !Object.prototype.hasOwnProperty.call(body.compatibility, 'persona_preset') &&
        Object.prototype.hasOwnProperty.call(body.compatibility, 'crag_persona_preset') &&
        String(body.compatibility.crag_persona_preset || '').trim() !== ''
      ) {
        routingConfig.compatibility.persona_preset = body.compatibility.crag_persona_preset
        delete routingConfig.compatibility.crag_persona_preset
      }
      if (
        Object.prototype.hasOwnProperty.call(body.compatibility, 'cch_enabled') ||
        routingConfig.compatibility.cch_enabled == null
      ) {
        routingConfig.compatibility.cch_enabled = routingConfig.compatibility.cch_enabled !== false
      }
    }
    if (body.websocket) {
      routingConfig.websocket = normalizeInferenceWebsocket({
        ...(routingConfig.websocket || {}),
        ...body.websocket,
      })
    }
    if (body.codex) {
      const nextCodex = { ...(routingConfig.codex || {}), ...body.codex }
      if (hasCodexQuota) {
        nextCodex.quota = mergeOpenAIQuotaPolicy(routingConfig.codex?.quota, body.codex.quota)
      }
      routingConfig.codex = normalizeCodexRouting(nextCodex)
    }
    if (body.gemini) {
      routingConfig.gemini = mergeGeminiRouting(routingConfig.gemini, body.gemini)
    }
    if (body.vm) {
      const prev = routingConfig.vm && typeof routingConfig.vm === 'object' ? routingConfig.vm : {}
      const next = { ...prev, ...body.vm }
      if (body.vm.smbios && typeof body.vm.smbios === 'object') {
        next.smbios = { ...(prev.smbios || {}), ...body.vm.smbios }
      }
      routingConfig.vm = normalizeVmConfig(next)
    }
    if (body.telemetry && typeof body.telemetry === 'object' && !Array.isArray(body.telemetry)) {
      const nextTelemetry = { ...(routingConfig.telemetry || {}) }
      if (Object.hasOwn(body.telemetry, 'upload_interval_seconds')) {
        nextTelemetry.upload_interval_seconds = telemetryUploadInterval({ telemetry: body.telemetry })
      }
      if (Object.hasOwn(body.telemetry, 'default_enabled')) {
        nextTelemetry.default_enabled = body.telemetry.default_enabled === true
      }
      if (Object.hasOwn(body.telemetry, 'disable_nonessential_traffic')) {
        nextTelemetry.disable_nonessential_traffic = body.telemetry.disable_nonessential_traffic === true
      }
      routingConfig.telemetry = nextTelemetry
    }
    applyOfficialCcRoutingBody(body, prevOfficialCc)
    applyHealthProbeRoutingBody(body, prevHealthProbe)
    applyUsageProbeRoutingBody(body, prevUsageProbe)
    applyWarmupRoutingBody(body, prevWarmup)
    applyCragZombieGuardRoutingBody(body, prevCragZombieGuard)
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
    if (nextRedaction) routingConfig.redaction = nextRedaction
    fs.mkdirSync(path.dirname(ctx.routingConfigPath), { recursive: true })
    atomicWriteJson(ctx.routingConfigPath, routingConfig, { mode: 0o600 })
    ctx.stickyRouter.reloadConfig(routingConfig)
    ctx.accountQuota.reloadConfig(routingConfig)
    getPool()?.reloadConfig?.(poolSchedulerConfig())
    const sessionSlotsApplied =
      body.inference && Object.hasOwn(body.inference, 'session_slots')
        ? applyRoutingSessionSlots(nextSessionSlots)
        : { updated: 0, skipped: 0 }
    const idleChanged = streamIdleTimeoutMs(routingConfig) !== prevIdleMs
    const requestBytesChanged = maxRequestBytes(routingConfig) !== prevRequestBytes
    // Body limit is applied once, when axum builds DefaultBodyLimit.
    const kernelPersona =
      compatibilityTouchesKernel(body.compatibility) ||
      inferenceTouchesKernel(body.inference) ||
      idleChanged ||
      requestBytesChanged
        ? syncKernelPanelConfig(routingConfig)
        : null
    const reloadNeeded =
      idleChanged || requestBytesChanged
        ? reloadClaudeKernelsWhenIdle(routingConfig, { idleOnly: !requestBytesChanged })
        : 0
    const defaultEnabled = telemetryDefaultEnabled(routingConfig)
    const disableNonessential = telemetryDisableNonessentialTraffic(routingConfig)
    const disableNonessentialChanged = disableNonessential !== prevDisableNonessential
    const telemetrySync =
      telemetryUploadInterval(routingConfig) !== prevUploadInterval ||
      defaultEnabled !== prevDefaultEnabled ||
      disableNonessentialChanged
        ? await syncTelemetryUploadInterval(routingConfig, {
            defaultEnabled,
            prevDefaultEnabled,
            disableNonessentialChanged,
          })
        : null
    // Pool and failover settings hot-reload into the live scheduler and runner.
    // Rebuilding them would drop the seat book and queues while their requests
    // still run (the panel sends `failover` with every routing save).
    if (body.pool) configureUnitCircuit(routingConfig)
    if (body.failover) ctx.failoverRunner?.reloadConfig?.(routingConfig.failover || {})
    const kernelReload = await reloadNeeded
    let geminiSync = null
    if (body.gemini) {
      const hostCaller = ctx.callGeminiHost || callGeminiHost
      try {
        const res = await hostCaller('apply-policy', { policy: routingConfig.gemini })
        geminiSync = {
          ok: true,
          shards_updated: Number(res?.shards_updated || 0),
          shards_total: Number(res?.shards_total || 0),
        }
      } catch (error) {
        geminiSync = {
          ok: false,
          code: error?.code || 'gemini_host_unavailable',
        }
      }
    }
    try {
      return {
        concurrency: applyRoutingTierConcurrency(routingConfig.tiers),
        rpm: applyRoutingTierRpm(routingConfig.tiers),
        session_slots: sessionSlotsApplied,
        openai_quota: hasCodexQuota
          ? applyRoutingOpenAIQuota(routingConfig.codex.quota)
          : { concurrency: 0, rpm: 0, sessions: 0, skipped: 0 },
        kernel_persona: kernelPersona,
        kernel_reload: kernelReload,
        telemetry_sync: telemetrySync,
        gemini_sync: geminiSync,
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
        telemetry_sync: telemetrySync,
        gemini_sync: geminiSync,
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
      doc.websocket = normalizeInferenceWebsocket(doc.websocket)
      doc.codex = normalizeCodexRouting(doc.codex)
      doc.gemini = normalizeGeminiRouting(doc.gemini)
      doc.pool = normalizePoolRouting(doc.pool)
      doc.vm = normalizeVmConfig(doc.vm)
      if (!hasOpenAIQuota) migrateLegacyOpenAIPolicies(doc)
      if (doc.batch_group != null) doc.batch_group = mergeBatchGroupConfig(doc.batch_group)
      if (doc.redaction != null) doc.redaction = normalizeRedaction(doc.redaction)
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
    getPool()?.stopMaintenance()
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
      getRouting,
      config: poolSchedulerConfig(),
    })
    setPool(poolScheduler)
    poolScheduler.startMaintenance()
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
      onFablePlanDenied: ({ selected, policy }) => {
        const accountId = selected?.accountId
        if (accountId && selected?.model) {
          try {
            if (policy?.reason === 'fable_credits_required') {
              ctx.accountQuota.markFableCreditsRequired(accountId, selected.model)
            } else {
              ctx.accountQuota.markModelUnsupported(accountId, selected.model)
            }
          } catch {}
        }
      },
      onFableSuccess: ({ selected, model }) => {
        const accountId = selected?.accountId
        if (accountId) {
          try {
            // Model access is not subscription evidence (Pro may also have it).
            ctx.accountQuota.clearModelUnsupported(accountId, model)
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
          markUnschedulable(ctx.cfg.paths.project, selected.vmId, 'oauth_no_refresh')
        }
      },
      // Org refusal: 不可调度 even over the operator's "on"; only an operator action reopens it.
      onSchedulePause: ({ selected, policy }) => {
        if (!selected?.vmId) return
        markUnschedulable(ctx.cfg.paths.project, selected.vmId, policy?.reason || 'organization_disabled', {
          ...policy?.detail,
          account_id: selected.accountId || null,
          at: new Date().toISOString(),
        })
      },
    })
    setFailover(failoverRunner)
  }

  return {
    persistRoutingPatch,
    applyOfficialCcRoutingBody,
    applyHealthProbeRoutingBody,
    applyUsageProbeRoutingBody,
    applyWarmupRoutingBody,
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
