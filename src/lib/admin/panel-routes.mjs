/**
 * /admin and /api/panel routes. Login / logout / me and { ok, data }
 * envelopes are unchanged; slot start/reload go through startSlotReady.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  verifyPanelLogin,
  createPanelSession,
  extractPanelToken,
  panelSessionCookie,
  panelCookieSecure,
  clearPanelSessionCookie,
  revokePanelSession,
  revokePanelSessionsForUser,
} from '../core/security.mjs'
import { loadDistillRules, saveDistillRules, validateDistillPatch } from '../core/distill-detect.mjs'
import { applyRefusalGuardPatch, refusalGuardPolicy } from '../core/refusal-guard.mjs'
import {
  applyJevPatch,
  listPolicyModels as listDecisionModels,
  publicJevConfig,
  readJevConfig,
} from '../protocol/jev-intercept.mjs'
import { RefusalGuardsRepo } from '../db/repos/refusal-guards-repo.mjs'
import { RefusalDeviceBlocksRepo } from '../db/repos/refusal-device-blocks-repo.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { parseCodexImportPayload, upsertCodexAccount, readCodexAccounts } from '../vm/codex-slot.mjs'
import { generateAuthUrl, exchangeAuthCode, normalizeOauthFlavor } from '../oauth/oauth-auth-url.mjs'
import { sessionKeyToOAuth, panelImportErrorPayload } from '../oauth/cookie-auth.mjs'
import { enrichOauthIdentity } from '../oauth/oauth-identity.mjs'
import { generateCodexAuthUrl, exchangeCodexAuthCode } from '../oauth/codex-oauth.mjs'
import {
  completeClaudeSetupToken,
  readSetupTokenSession,
  looksLikeOfficialSetupToken,
  SETUP_TOKEN_FLAVOR,
} from '../oauth/claude-setup-token.mjs'
import {
  canOfficialCc,
  isApiKeyMode,
  isAnySetupTokenMode,
  isOfficialSetupTokenMode,
  isSetupTokenMode,
  looksLikeConsoleApiKey,
  credentialModeOfVm,
  liveOauthToSetupToken,
} from '../oauth/credential-mode.mjs'
import { persistSlotAuthScheme, readWorkerCredentialFile } from '../oauth/oauth-credentials.mjs'
import {
  isSub2apiAccountExport,
  sub2apiAccountToOauth,
  oauthToSub2apiExport,
  parseCredentialEdit,
} from '../oauth/sub2api-account.mjs'
import { officialCcHome, readOfficialCcStatus, scheduleOfficialCcBootstrap } from '../oauth/official-cc-bootstrap.mjs'
import { invalidateLiveCredentialCache } from './panel-live-credentials.mjs'
import { listOfficialModels, seedModelCatalog, getCatalogIds } from '../protocol/models.mjs'
import {
  getModelPolicy,
  saveModelPolicy,
  resetModelPolicy,
  listPolicyModels,
  syncWorkerModelsIntoPolicy,
} from '../protocol/model-policy.mjs'
import {
  getGptModelPolicy,
  listGptPolicyModels,
  saveGptModelPolicy,
  resetGptModelPolicy,
} from '../protocol/gpt-model-policy.mjs'
import { refreshCodexAccessToken } from '../protocol/codex-models.mjs'
import {
  defaultSeedPolicy,
  isTelemetryEnabled,
  seedTelemetryContract,
  standardSeedPolicy,
} from '../protocol/seed-policy.mjs'

import { runVmTestChat, resolveTestModels, syncCodexCatalog } from './vm-test-chat.mjs'
import { publicKeyView } from './api-keys.mjs'
import { assertVmScope, normalizeKeyScope } from './key-scope.mjs'
import {
  assertVmPoolExists,
  createVmPool,
  deleteVmPool,
  updateVmPool,
  vmPoolHttpStatus,
  vmPoolsFor,
} from './vm-pools.mjs'
import { publicEndpointView, fetchUpstreamModels, API_ENDPOINT_PRESETS } from './api-endpoints.mjs'
import { publicUserView } from './panel-users.mjs'
import { authorizePanelRoute, mePayload, panelIdentity } from './panel-acl.mjs'
import {
  denyIfUserCannotDeleteVm,
  denyIfUserMissesKey,
  denyIfUserMissesProxy,
  denyIfUserMissesVm,
} from './panel-tenant.mjs'
import {
  VM_ORIGIN,
  canBindProxyToVm,
  assignOriginForOwner,
  clampVmCreateQuota,
  countUserCreatedVms,
  filterVmsForPanel,
  normalizeOwnerId,
} from './resource-owner.mjs'
import { servePoolSeatStream } from './pool-seat-stream.mjs'
import { logsToCsv, logsToJsonl } from './request-log.mjs'
import {
  listVms,
  getVm,
  summarizeVm,
  getActiveVmId,
  setActiveVm,
  setVmSchedulable,
  bindVmProxy,
  vmHasClaudeCredential,
  persistAllowedModels,
  persistSlotEnginePolicy,
  persistVmScheduleLevel,
  persistVmOwner,
  persistVmTimezone,
} from '../vm/vm-registry.mjs'
import { syncVmTimezoneFromProxy } from '../vm/proxy-timezone.mjs'
import { validTimezone } from '../core/timezone.mjs'
import { stampVmKind, isCodexVm } from '../vm/vm-kind.mjs'
import { parseAllowedModelsPatch } from '../pool/slot-model-gate.mjs'
import { parseScheduleLevelInput } from '../pool/credential-weight.mjs'
import { parseVmQuotaOverride } from '../pool/vm-quota-override.mjs'
import { validateOpenAIQuotaPatch, normalizeOpenAIQuotaPolicy } from '../pool/openai-quota-policy.mjs'
import {
  normalizeInferenceConfig,
  normalizeSessionSlots,
  parseKernelDataplanePatch,
  parseSlotEnginePolicyPatch,
  parseSlotPolicyTargets,
  resolveInferenceEngine,
  resolveKernelDataplane,
  SESSION_SLOT_MAX,
  SESSION_SLOT_MIN,
  validateInferenceRoutingPatch,
} from '../vm/slot-engine.mjs'
import { makeError, ErrorType, ErrorCode } from '../core/errors.mjs'
import * as panel from './panel-api.mjs'
import { GATEWAY_CAPABILITIES } from '../vm/execution-context.mjs'
import { withVmLock, atomicWriteJson, isValidVmId } from '../vm/vm-file.mjs'
import { snapshotDatabaseMetrics } from '../db/database-metrics.mjs'
import { getUsageCache } from '../oauth/usage-cache.mjs'
import { getDb, getDbPath } from '../db/database.mjs'
import { readLocalVersion, loadChangelog, buildUpdateStatus, startHostUpgrade } from './release.mjs'
import { downloadReleaseKernel, kernelReleaseHttpStatus } from './release-kernel.mjs'
import { removeVmFromDb } from '../vm/vm-db-sync.mjs'
import { normalizeCredentialMode } from '../oauth/credential-mode.mjs'
import { reloadActiveVm } from '../core/config.mjs'
import {
  OS_CATALOG,
  kernelForIndex,
  normalizeTimezone,
  nextNumericIndex,
  padVm,
  STANDARD_LOCALE,
  syncWorkerTelemetry,
} from '../vm/vm-runtime.mjs'
import {
  startSlotReady,
  reloadSlotReady,
  stopSlot,
  destroySlot,
  switchSlotInferenceEngine,
  switchInheritedInferenceEngines,
  slotExec,
} from '../vm/slot-runtime.mjs'
import { recreateVmFiles, seedFreshCliHome } from '../vm/vm-recreate.mjs'
import { commitVmPackage, exportVmPackage, parseVmPackage } from '../vm/vm-package.mjs'
import { preflightNode } from '../cluster/placement.mjs'
import { probeLocalKvm } from '../vm/kvm-host.mjs'
import { normalizeVmConfig, resolveMachineSpec, validateVmConfigPatch } from '../vm/machine-spec.mjs'
import { RUNTIME_KVM } from '../vm/runtime-kind.mjs'
import { hostProxyUrlForVm, slotHost } from '../vm/slot-host.mjs'
import { syncIpv6ProxyEgress } from '../vm/proxy-policy-runtime.mjs'
import { writeSlotSeedFiles } from '../vm/slot-seed.mjs'
import {
  egressEnabled,
  ensureProxyEgress,
  stopProxyEgress,
  hasBoundExit,
  isLocalEgressProxy,
  dnsUpstreamChain,
} from '../vm/egress.mjs'
import { collectSlotIdentity } from '../vm/guest-identity.mjs'
import { applyOfficialFingerprintToVm, reconcileOfficialFingerprints } from '../identity/official-fingerprint.mjs'
import { personaPreviewVars } from '../identity/crs-persona.mjs'
import {
  applyGeneratedFingerprint,
  generateWorkstationFingerprint,
  SLOT_LOCALES,
  takenFingerprintKeys,
  writeGuestMachineIdFile,
} from '../identity/workstation-fingerprint.mjs'
import { runFleetUpdate, fleetStatus } from '../vm/fleet-update.mjs'
import {
  captureWrapSample,
  describeWrapSample,
  makeWrapSample,
  materializeSlotDataplane,
  materializeWrapCli,
  replaceCragKernelBinary,
  replaceKernelBinary,
  replaceCliNodeBinary,
  replaceCcNodeBinary,
  syncWrapSample,
  wrapCliHomeDir,
} from '../vm/wrap-cli-runtime.mjs'
import { readRawBody as defaultReadRawBody } from '../http/respond.mjs'
import { restartRustKernel, writeKernelConfig } from '../transport/rust-kernel-supervisor.mjs'

import { countTokensViaWorker } from '../transport/go-worker-client.mjs'
import { apiKeyBetaHeader, setupTokenBetaHeader } from '../protocol/claude-code-betas.mjs'
import { rustKernelHealth, toPublicKernelHealth } from '../transport/rust-kernel-client.mjs'
import { codexKernelHealth } from '../transport/codex-kernel-client.mjs'
import { setManualScheduleWins } from '../pool/schedule-policy.mjs'
import { normalizeHealthProbeConfig } from './health-probe.mjs'
import { normalizeUsageProbeConfig } from '../oauth/usage-probe-monitor.mjs'
import { mergeNotifyConfig, publicNotifyConfig, publicRoutingNotify, sendNotifyTest } from './notify.mjs'
import { UsageLogsView } from '../db/repos/usage-logs-view.mjs'
import {
  StatisticsRepo,
  USER_ROLE_DIMENSIONS,
  normalizeDimension,
  normalizeRange,
} from '../db/repos/statistics-repo.mjs'

/** Tenants always see their own rows; other roles may narrow by `user_id`. */
function logsOwner(req, u) {
  return panelIdentity(req).role === 'user' ? req.panelUserId : u.searchParams.get('user_id') || null
}

/** Scrolling-log query string → `UsageLogsView` filters. Empty strings are dropped. */
function usageLogFilters(req, u) {
  const get = (k) => {
    const v = u.searchParams.get(k)
    return v == null || v === '' ? null : v
  }
  const isUser = panelIdentity(req).role === 'user'
  return {
    limit: get('limit'),
    cursor_created_at: get('cursor_created_at'),
    cursor_id: get('cursor_id'),
    user_id: isUser ? null : get('user_id'),
    key_id: get('key_id'),
    vm_id: get('vm_id'),
    account_id: get('account_id'),
    session_id: get('session_id'),
    model: get('model'),
    endpoint: get('endpoint'),
    protocol: get('protocol'),
    status_code: get('status_code'),
    exclude_status_200: get('exclude_status_200') === '1',
    model_mismatch: get('model_mismatch') === '1',
    min_attempt_count: get('min_attempt_count'),
    error_class: get('error_class'),
    exclude_error_class: get('exclude_error_class'),
    include_muted: get('include_muted') === '1',
    debug_only: get('log_mode') === 'debug',
    start_time: get('start_time'),
    end_time: get('end_time'),
    q: get('q'),
    owner_user_id: isUser ? req.panelUserId : null,
  }
}

/**
 * Validated statistics params. `user` may only group by key/model: user and
 * vm groupings would reveal other tenants or the pool layout.
 */
function statsParams(req, u, dimensionKey) {
  const isUser = panelIdentity(req).role === 'user'
  const rawRange = u.searchParams.get('range')
  const rawDim = u.searchParams.get(dimensionKey)
  const range = rawRange ? normalizeRange(rawRange) : 'today'
  if (!range) return { error: `invalid range: ${rawRange}` }
  const dimension = rawDim ? normalizeDimension(rawDim) : 'model'
  if (!dimension) return { error: `invalid ${dimensionKey}: ${rawDim}` }
  if (isUser && !USER_ROLE_DIMENSIONS.includes(dimension)) return { error: `${dimensionKey} not allowed: ${dimension}` }
  return { range, dimension, tz: u.searchParams.get('tz') || 'UTC', owner_user_id: logsOwner(req, u) }
}

async function commitImportedCodexVm({
  cfg,
  vmPath,
  existing,
  account,
  catalogClientVersion = 'auto',
  routingConfig = {},
}) {
  const wasCodex = isCodexVm(existing)
  const previousPolicy = existing.policy && typeof existing.policy === 'object' ? existing.policy : {}
  const saved = upsertCodexAccount(cfg.paths.project, existing.id, account)
  existing.platform = 'openai'
  existing.family = 'codex'
  existing.codex_kernel = true
  existing.codex = {
    ...(existing.codex && typeof existing.codex === 'object' ? existing.codex : {}),
    has_access: !!saved.access_token,
    has_refresh: !!saved.refresh_token,
    chatgpt_account_id: saved.chatgpt_account_id || null,
    email: saved.email || null,
    expires_at: saved.expires_at || null,
  }
  const global = normalizeOpenAIQuotaPolicy(routingConfig.codex?.quota || {})
  const preservePin = (value, override) =>
    previousPolicy[override] === true &&
    typeof previousPolicy[value] === 'number' &&
    Number.isInteger(previousPolicy[value]) &&
    previousPolicy[value] >= 0
  existing.policy = {
    ...previousPolicy,
    maxConcurrency:
      wasCodex && preservePin('maxConcurrency', 'concurrencyOverride')
        ? previousPolicy.maxConcurrency
        : global.max_concurrency,
    concurrencyOverride: wasCodex && preservePin('maxConcurrency', 'concurrencyOverride'),
    maxRpm: wasCodex && preservePin('maxRpm', 'rpmOverride') ? previousPolicy.maxRpm : global.max_rpm,
    rpmOverride: wasCodex && preservePin('maxRpm', 'rpmOverride'),
    maxSessions:
      wasCodex && preservePin('maxSessions', 'sessionsOverride') ? previousPolicy.maxSessions : global.max_sessions,
    sessionsOverride: wasCodex && preservePin('maxSessions', 'sessionsOverride'),
  }
  stampVmKind(existing)
  atomicWriteJson(vmPath, existing, { mode: 0o600 })
  let catalog = null
  try {
    catalog = await syncCodexCatalog({
      projectRoot: cfg.paths.project,
      vmId: existing.id,
      rotate: true,
      catalogClientVersion,
    })
  } catch {
    catalog = null
  }
  return {
    vm: summarizeVm(existing, cfg.paths.project, routingConfig),
    platform: 'openai',
    catalog: catalog && catalog.ok ? { synced: catalog.synced, ids: catalog.ids } : catalog,
  }
}

async function syncInstalledKernels({ project, routingConfig, body = {} }) {
  const all = listVms(project)
  const wanted = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null
  // Cluster-node slots run image-baked binaries; they upgrade by rebuilding the slot image.
  const vms = (wanted ? all.filter((vm) => wanted.has(vm.id)) : all).filter((vm) => !slotHost(vm).bakedKernel)
  const report = syncWrapSample(project, vms, { routing: routingConfig })
  if (body.restart !== false) {
    for (const item of report.items || []) {
      if (!item.ok) continue
      const vm = getVm(project, item.id)
      if (!vm || vm.status !== 'running') {
        item.kernel = { ok: true, skipped: true, reason: 'vm_stopped' }
        continue
      }
      if (resolveInferenceEngine(vm, routingConfig) !== 'rust') continue
      writeKernelConfig(project, vm, { routing: routingConfig, timezone: vm.timezone })
      const exec = slotExec(project, vm)
      item.kernel = await restartRustKernel(exec).catch((e) => ({
        ok: false,
        error: String(e?.message || e).slice(0, 200),
      }))
      if (!item.kernel?.ok) {
        item.ok = false
        item.code = 'kernel_restart_failed'
        item.error = item.kernel?.error || item.kernel?.reason || 'kernel restart failed'
      }
    }
  }
  const failed = (report.items || []).filter((item) => !item.ok)
  report.ok = failed.length === 0
  report.ok_count = report.items.length - failed.length
  report.failed_count = failed.length
  return report
}

/** Auth-link hint for the slot's proxy: `name · host:port`, or bare host:port when unnamed. */
function slotProxyHint(px = {}, label = null) {
  if (!px.host) return null
  const endpoint = `${px.host}${px.port ? ':' + px.port : ''}`
  return label ? `${label} · ${endpoint}` : endpoint
}

export function createPanelHandler(ctx) {
  const json = (...args) => ctx.json(...args)
  const hostUnsupported = (res, vm, cap) => {
    if (slotHost(vm).supports(cap)) return false
    json(res, 409, {
      ok: false,
      error: { code: 'remote_unsupported', message: '集群节点上的虚拟机暂不支持此操作' },
    })
    return true
  }
  const readBody = (...args) => ctx.readBody(...args)
  const readRawBody = (...args) => (ctx.readRawBody || defaultReadRawBody)(...args)
  const requireAuth = (...args) => ctx.requireAuth(...args)
  const cfg = ctx.cfg
  const routingConfigPath = ctx.routingConfigPath
  const stickyRouter = ctx.stickyRouter
  const accountQuota = ctx.accountQuota
  const proxyPool = ctx.proxyPool
  const apiKeyStore = ctx.apiKeyStore
  const apiEndpointStore = ctx.apiEndpointStore
  const apiScheduler = ctx.apiScheduler
  const panelUsers = ctx.panelUsers
  const requestLog = ctx.requestLog
  const backupService = ctx.backupService
  const stats = ctx.stats
  const persistRoutingPatch = (...args) => ctx.persistRoutingPatch(...args)
  const applyVmConcurrency = (...args) => ctx.applyVmConcurrency(...args)
  const applyVmRpm = (...args) => ctx.applyVmRpm(...args)
  const applyVmSessionSlots = (...args) => ctx.applyVmSessionSlots(...args)
  const inheritVmScheduling = (...args) => ctx.inheritVmScheduling(...args)
  const applyVmQuotaOverride = (...args) => ctx.applyVmQuotaOverride(...args)
  const initPoolRuntime = (...args) => ctx.initPoolRuntime(...args)
  const poolSchedulerConfig = (...args) => ctx.poolSchedulerConfig(...args)
  const commitImportedOauth = (...args) => ctx.commitImportedOauth(...args)
  const requireSlotProxy = (...args) => ctx.requireSlotProxy(...args)
  const officialCcStatsHandler = (...args) => ctx.officialCcStatsHandler(...args)
  const refreshWorkerCredentialForVm = (...args) => ctx.refreshWorkerCredentialForVm(...args)
  const fetchWorkerModels = (...args) => ctx.fetchWorkerModels(...args)

  function proxyNodeScope(body, res) {
    if (!body || !Object.hasOwn(body, 'node_id')) return {}
    if (body.node_id === null) return { nodeId: null }
    if (typeof body.node_id === 'string' && body.node_id.trim()) return { nodeId: body.node_id.trim() }
    json(res, 400, {
      ok: false,
      error: { code: 'invalid_node_id', message: 'node_id must be a node id or null for the control plane' },
    })
    return null
  }

  async function readProxyBody(req, res) {
    try {
      const body = await readBody(req, 8192)
      if (body && typeof body === 'object' && !Array.isArray(body)) return body
    } catch {}
    // A malformed scoped request must not silently become an unscoped action.
    json(res, 400, { ok: false, error: { code: 'invalid_json', message: 'Expected a JSON object' } })
    return null
  }

  function rejectScopedLocalManagement(id, body, res) {
    if (!body || !Object.hasOwn(body, 'node_id')) return false
    const proxy = proxyPool.state?.proxies?.find((item) => item.id === id)
    if (!isLocalEgressProxy(proxy)) return false
    json(res, 400, {
      ok: false,
      error: {
        code: 'local_scope_operation_unsupported',
        message: 'local 的编辑、启停和删除作用于所有节点，请使用全部 local 管理操作',
      },
    })
    return true
  }

  function restoreSchedulableIfReady(vmId) {
    const vm = getVm(cfg.paths.project, vmId)
    if (!vmHasClaudeCredential(vm)) {
      setVmSchedulable(cfg.paths.project, vmId, false, 'no_credential')
      return
    }
    setVmSchedulable(cfg.paths.project, vmId, true)
  }

  // A slot without a zone takes its exit's; a set zone (manual or already synced) stays.
  async function fillTimezoneFromExit(id) {
    const vm = getVm(cfg.paths.project, id)
    if (!vm?.proxy?.id || validTimezone(vm.timezone)) return null
    return syncVmTimezoneFromProxy(cfg.paths.project, proxyPool, id, { force: true })
  }

  async function bringUpImportedVm(id) {
    let vm = getVm(cfg.paths.project, id)
    let startError = null
    if (!vm) return { start_error: 'vm not found', official_cc_bootstrap: null, probe: null }
    if (!hasBoundExit(vm.proxy)) {
      startError = 'no_exit'
    } else {
      const boot = await startSlotReady(vm, cfg.paths.project, { routing: ctx.routingConfig })
      vm = getVm(cfg.paths.project, id) || vm
      if (!boot?.ok) {
        startError = boot?.error || boot?.reason || 'runtime start failed'
        vm.status = 'error'
        vm.schedulable = false
        vm.schedule_disabled_reason = String(startError).slice(0, 240)
        vm.updated_at = new Date().toISOString()
        atomicWriteJson(path.join(cfg.paths.project, 'vms', `${id}.json`), vm, { mode: 0o600 })
      } else {
        vm.status = 'running'
        vm.updated_at = new Date().toISOString()
        atomicWriteJson(path.join(cfg.paths.project, 'vms', `${id}.json`), vm, { mode: 0o600 })
      }
    }
    vm = getVm(cfg.paths.project, id) || vm
    let bootstrap
    if (startError) bootstrap = { scheduled: false, reason: startError === 'no_exit' ? 'no_exit' : 'start_failed' }
    else if (isCodexVm(vm)) bootstrap = { scheduled: false, reason: 'gpt_slot' }
    else if (!vmHasClaudeCredential(vm)) bootstrap = { scheduled: false, reason: 'no_credential' }
    else if (!canOfficialCc(credentialModeOfVm(vm))) {
      bootstrap = { scheduled: false, reason: 'credential_mode_unsupported' }
    } else {
      bootstrap = scheduleOfficialCcBootstrap({
        vmId: id,
        projectRoot: cfg.paths.project,
        vm,
        force: true,
        manual: true,
        collectIdentity: collectSlotIdentity,
        onStats: officialCcStatsHandler(id, vm.claude?.account_uuid),
        routingFile: routingConfigPath,
        config: ctx.routingConfig?.official_cc,
        credentialMode: credentialModeOfVm(vm),
      })
    }
    const probed = await panel.buildProbeOne({ cfg, accountQuota, id, routingConfig: ctx.routingConfig })
    const probe = probed?.status
      ? { ok: false, error: probed.body?.error?.message || probed.body?.error?.code || 'probe_failed' }
      : { ok: probed?.data?.ok !== false, source: probed?.data?.source || null }
    return { start_error: startError, official_cc_bootstrap: bootstrap, probe }
  }

  function normalizePanelApiKeyInput(body = {}) {
    const normalized = { ...body }
    const hasRequestQuota = Object.prototype.hasOwnProperty.call(body, 'quota_requests')
    const hasLegacyQuota = Object.prototype.hasOwnProperty.call(body, 'quota')
    const hasUsdQuota = Object.prototype.hasOwnProperty.call(body, 'quota_usd')
    delete normalized.quota
    delete normalized.quota_usd
    if (hasRequestQuota || hasLegacyQuota) {
      normalized.quota_requests = hasRequestQuota ? body.quota_requests : body.quota
    }
    if (hasUsdQuota) normalized.quota = body.quota_usd
    return normalized
  }

  function rulesFile() {
    return path.join(cfg.paths.root, 'config', 'intercept-rules.json')
  }

  function reloadRules() {
    try {
      const data = JSON.parse(fs.readFileSync(rulesFile(), 'utf8'))
      cfg.intercept.rules = Array.isArray(data) ? data : data.rules || []
    } catch {
      cfg.intercept.rules = []
    }
    return cfg.intercept.rules
  }

  function distillFile() {
    return path.join(cfg.paths.root, 'config', 'distill-rules.json')
  }

  function reloadDistill() {
    cfg.distill = loadDistillRules(distillFile())
    return cfg.distill
  }

  function refusalGuardSnapshot() {
    const settings = new SettingsRepo()
    const repo = new RefusalGuardsRepo()
    const devices = new RefusalDeviceBlocksRepo()
    const read = (key, fallback) => settings.get(key, fallback)
    return {
      ...refusalGuardPolicy(read),
      count: repo.count(),
      items: repo.list(),
      device_count: devices.count(),
      devices: devices.list(),
    }
  }

  function jevInterceptSnapshot() {
    try {
      const settings = new SettingsRepo()
      return publicJevConfig(readJevConfig((key, fallback) => settings.get(key, fallback)))
    } catch {
      return publicJevConfig(null)
    }
  }

  function activateVmSlot(id) {
    setActiveVm(cfg.paths.project, id)
    reloadActiveVm(cfg)
    const vm = getVm(cfg.paths.project, id)
    accountQuota.ensure({
      account_id: vm?.account_uuid || vm?.claude?.account_uuid || id,
      vm_id: id,
      email: vm?.email || vm?.codex?.email || vm?.claude?.email || null,
      type: normalizeCredentialMode(vm?.claude?.mode),
      max_concurrency: vm?.policy?.maxConcurrency || 2,
      max_rpm: vm?.policy?.maxRpm ?? 0,
    })
    return {
      ok: true,
      active_vm: id,
      runtime: GATEWAY_CAPABILITIES.runtime,
      kernel: GATEWAY_CAPABILITIES.kernel,
    }
  }

  function workerExecForVm(id) {
    const vm = getVm(cfg.paths.project, id)
    if (!vm) return null
    return {
      vmId: id,
      accountId: vm.claude?.account_uuid || id,
      vm,
      homeDir: path.join(cfg.paths.project, 'vms', id, 'cli-home'),
      vmPath: path.join(cfg.paths.project, 'vms', `${id}.json`),
    }
  }

  async function panelKernelHealth({ id }) {
    const exec = workerExecForVm(id)
    const vm = exec?.vm || getVm(cfg.paths.project, id)
    if (!exec || !vm) {
      const missing = { reachable: false, status: null, error_code: 'vm_not_found' }
      return { go: missing, rust: missing }
    }
    if (isCodexVm(vm)) {
      const health = await codexKernelHealth(exec, { timeoutMs: 600 })
      return {
        codex: {
          ...toPublicKernelHealth(health, 'codex'),
          proxy_ok: health?.proxy_ok ?? null,
          accounts: health?.accounts ?? null,
          vm_id: health?.vm_id || id,
        },
      }
    }
    const rust = await rustKernelHealth(exec, { timeoutMs: 600 })
    return {
      rust: toPublicKernelHealth(rust, 'rust'),
    }
  }

  function vmWithSlotPolicyPatch(vm, patch) {
    const desired = structuredClone(vm)
    if (Object.prototype.hasOwnProperty.call(patch, 'inference_engine')) {
      if (patch.inference_engine) desired.inference_engine = patch.inference_engine
      else delete desired.inference_engine
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'persona_preset')) {
      if (patch.persona_preset) desired.persona_preset = patch.persona_preset
      else delete desired.persona_preset
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'dataplane')) {
      if (patch.dataplane) desired.dataplane = patch.dataplane
      else delete desired.dataplane
    }
    return desired
  }

  async function applySlotPolicyWithRuntime(id, patch) {
    const current = getVm(cfg.paths.project, id)
    if (!current) return { ok: false, id, code: 'vm_not_found', error: 'vm not found' }
    const desired = vmWithSlotPolicyPatch(current, patch)
    const previousEngine = resolveInferenceEngine(current, ctx.routingConfig)
    const targetEngine = resolveInferenceEngine(desired, ctx.routingConfig)
    const previousDataplane = resolveKernelDataplane(current, ctx.routingConfig)
    const targetDataplane = resolveKernelDataplane(desired, ctx.routingConfig)
    let switched = null
    if (Object.prototype.hasOwnProperty.call(patch, 'inference_engine') && previousEngine !== targetEngine) {
      switched = await switchSlotInferenceEngine(desired, cfg.paths.project, targetEngine)
      if (!switched.ok) {
        return { ok: false, id, code: switched.code || 'engine_switch_failed', error: switched.error, switch: switched }
      }
    }
    try {
      const saved = persistSlotEnginePolicy(cfg.paths.project, id, patch)
      if (!saved) return { ok: false, id, code: 'vm_not_found', error: 'vm not found' }
      if (
        !isCodexVm(saved) &&
        (Object.prototype.hasOwnProperty.call(patch, 'persona_preset') || previousDataplane !== targetDataplane)
      ) {
        if (previousDataplane !== targetDataplane) {
          const laid = materializeSlotDataplane(cfg.paths.project, saved, targetDataplane || 'wrap')
          if (!laid.ok) {
            persistSlotEnginePolicy(cfg.paths.project, id, { dataplane: current.dataplane || '' })
            return { ok: false, id, code: laid.code || 'dataplane_materialize_failed', error: laid.error }
          }
        }
        writeKernelConfig(cfg.paths.project, saved, { routing: ctx.routingConfig })
        if (previousDataplane !== targetDataplane && saved.status === 'running') {
          const exec = slotExec(cfg.paths.project, saved)
          const restarted = await restartRustKernel(exec).catch((e) => ({
            ok: false,
            error: String(e?.message || e).slice(0, 200),
          }))
          if (!restarted?.ok) {
            return {
              ok: false,
              id,
              code: 'kernel_restart_failed',
              error: restarted?.error || 'kernel restart failed',
            }
          }
        }
      }
      return {
        ok: true,
        id,
        vm: saved,
        configured_engine: saved.inference_engine || null,
        resolved_engine: resolveInferenceEngine(saved, ctx.routingConfig),
        dataplane: saved.dataplane || null,
        resolved_dataplane: resolveKernelDataplane(saved, ctx.routingConfig),
        active_engine: switched?.active_engine || targetEngine,
        runtime: switched?.runtime || null,
      }
    } catch (error) {
      let rollback = null
      if (switched) rollback = await switchSlotInferenceEngine(current, cfg.paths.project, previousEngine)
      return {
        ok: false,
        id,
        code: rollback && !rollback.ok ? 'engine_switch_rollback_failed' : 'engine_persist_failed',
        error: String(error?.message || error),
        rollback,
      }
    }
  }

  function projectSlotKernelConfig(vm) {
    if (!vm?.id || isCodexVm(vm)) return null
    const full = getVm(cfg.paths.project, vm.id) || vm
    return writeKernelConfig(cfg.paths.project, full, {
      routing: ctx.routingConfig,
      timezone: full.timezone,
    })
  }

  function restoreRoutingRuntime(previous) {
    ctx.routingConfig = previous
    setManualScheduleWins(ctx.routingConfig.pool?.manual_schedule_wins)
    ctx.healthMonitor?.setConfig(ctx.routingConfig.health_probe)
    ctx.usageProbeMonitor?.setConfig(ctx.routingConfig.usage_probe)
    ctx.notifyMonitor?.setConfig(ctx.routingConfig.notify)
    if (ctx.routingConfig.logging) {
      requestLog.setConfig({
        mode: ctx.routingConfig.logging.mode,
        retainDays: ctx.routingConfig.logging.retain_days,
        debugRetainDays: ctx.routingConfig.logging.debug_retain_days,
        maxMb: ctx.routingConfig.logging.max_mb,
        mutedErrorClasses: ctx.routingConfig.logging.muted_error_classes,
      })
    }
    stickyRouter.reloadConfig(ctx.routingConfig)
    accountQuota.reloadConfig(ctx.routingConfig)
    ctx.poolScheduler?.reloadConfig?.(poolSchedulerConfig())
  }

  async function prepareInheritedInferenceEngine(body) {
    if (!body?.inference) return { ok: true, changed: false, items: [] }
    const previous = normalizeInferenceConfig(ctx.routingConfig.inference || {}).engine
    const target = normalizeInferenceConfig({ ...(ctx.routingConfig.inference || {}), ...body.inference }).engine
    if (previous === target) return { ok: true, changed: false, items: [] }
    const previousRoutingConfig = structuredClone(ctx.routingConfig)
    return switchInheritedInferenceEngines({
      projectRoot: cfg.paths.project,
      previousEngine: previous,
      targetEngine: target,
      commit: () => {
        try {
          return persistRoutingPatch(body)
        } catch (error) {
          restoreRoutingRuntime(previousRoutingConfig)
          if (body.pool || body.failover) initPoolRuntime()
          throw error
        }
      },
    })
  }

  async function oauthStatusWithWorker(id = null) {
    const vmId = id || getActiveVmId(cfg.paths.project)
    const exec = workerExecForVm(vmId)
    if (!exec) return { ok: false, vm_id: vmId, error: 'vm_not_found' }
    const health = await rustKernelHealth(exec)
    return {
      ok: !!health.ok,
      vm_id: vmId,
      refresh_owner: 'go-slot-worker',
      proxy_required: true,
      worker: health,
      credential: health.credential || null,
    }
  }

  return async function handlePanel(req, res, url) {
    const p = url.pathname
    if (!p.startsWith('/admin') && !p.startsWith('/api/panel')) return false

    if (p.startsWith('/admin')) {
      if (!requireAuth(req, res)) return true
      if (panelIdentity(req).role !== 'admin') {
        json(
          res,
          403,
          makeError({
            type: ErrorType.PERMISSION,
            code: 'forbidden',
            message: 'Admin routes require an administrator',
            status: 403,
          }).body,
        )
        return true
      }
    }
    if (p === '/admin/models/refresh') return false

    if (p === '/admin/routing' && req.method === 'GET') {
      if (!requireAuth(req, res)) return
      return json(res, 200, {
        routing: publicRoutingNotify(ctx.routingConfig),
        sticky: stickyRouter.stats(),
        pool: ctx.poolScheduler.snapshot(),
        account_runtime: ctx.runtimeRepo.list(),
      })
    }
    if (p === '/admin/routing' && (req.method === 'PUT' || req.method === 'POST')) {
      if (!requireAuth(req, res)) return
      const body = await readBody(req, cfg.limits.max_body_bytes)
      let applied
      try {
        applied = persistRoutingPatch(body)
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) {
          return json(res, 400, {
            ok: false,
            error: { type: 'invalid_request_error', code: 'invalid_openai_quota', message: error.message },
          })
        }
        throw error
      }
      return json(res, 200, {
        ok: true,
        routing: publicRoutingNotify(ctx.routingConfig),
        applied_concurrency: applied.concurrency,
        applied_rpm: applied.rpm,
      })
    }
    if (p === '/admin/quota' && req.method === 'GET') {
      if (!requireAuth(req, res)) return
      return json(res, 200, accountQuota.snapshot())
    }

    // ---- Multi-VM + usage management ----
    if (req.method === 'GET' && p === '/admin/vms') {
      if (!requireAuth(req, res)) return
      const active = getActiveVmId(cfg.paths.project)
      const vms = listVms(cfg.paths.project, ctx.routingConfig).map((v) => ({ ...v, active: v.id === active }))
      return json(res, 200, { vms, active_vm: active, total: vms.length })
    }
    if (req.method === 'GET' && p.startsWith('/admin/vms/') && !p.includes('/probe') && !p.endsWith('/activate')) {
      if (!requireAuth(req, res)) return
      const id = p.split('/')[3]
      const vm = getVm(cfg.paths.project, id)
      if (!vm) return json(res, 404, { error: { message: 'vm not found' } })
      return json(res, 200, {
        vm: summarizeVm(vm, cfg.paths.project, ctx.routingConfig),
        active: getActiveVmId(cfg.paths.project) === id,
      })
    }
    if (req.method === 'POST' && /^\/admin\/vms\/[^/]+\/activate$/.test(p)) {
      if (!requireAuth(req, res)) return
      const id = p.split('/')[3]
      if (!getVm(cfg.paths.project, id)) return json(res, 404, { error: { message: 'vm not found' } })
      return json(res, 200, activateVmSlot(id))
    }
    if (req.method === 'POST' && /^\/admin\/vms\/[^/]+\/probe$/.test(p)) {
      if (!requireAuth(req, res)) return
      const id = p.split('/')[3]
      const hop = (await readBody(req, 4096).catch(() => ({})))?.hop !== false
      const result = await panel.buildProbeOne({ cfg, accountQuota, id, hop, routingConfig: ctx.routingConfig })
      if (result.status) return json(res, result.status, result.body)
      return json(res, 200, { vm_id: id, account_uuid: result.data?.account_uuid, probe: result.data })
    }
    if (req.method === 'POST' && p === '/admin/vms/probe-all') {
      if (!requireAuth(req, res)) return
      const hop = (await readBody(req, 4096).catch(() => ({})))?.hop === true
      const result = await panel.buildProbeAll({ cfg, accountQuota, hop, routingConfig: ctx.routingConfig })
      return json(res, 200, result)
    }
    if (req.method === 'GET' && p === '/admin/usage/summary') {
      if (!requireAuth(req, res)) return
      const snap = accountQuota.snapshot()
      const vms = listVms(cfg.paths.project, ctx.routingConfig)
      const accounts = snap.accounts || []
      const max5 = Math.max(0, ...accounts.map((a) => Number(a.unified?.['5h']?.utilization || 0)))
      const max7 = Math.max(0, ...accounts.map((a) => Number(a.unified?.['7d']?.utilization || 0)))
      const sumTokensIn = accounts.reduce((s, a) => s + (a.tokens_in || 0), 0)
      const sumTokensOut = accounts.reduce((s, a) => s + (a.tokens_out || 0), 0)
      const sumReq = accounts.reduce((s, a) => s + (a.requests || 0), 0)
      const nearLimit = accounts.filter(
        (a) =>
          Number(a.unified?.['5h']?.utilization || 0) >= snap.safety_ratio ||
          Number(a.unified?.['7d']?.utilization || 0) >= snap.safety_ratio,
      )
      return json(res, 200, {
        safety_ratio: snap.safety_ratio,
        vm_count: vms.length,
        account_count: accounts.length,
        totals: {
          requests: sumReq,
          tokens_in: sumTokensIn,
          tokens_out: sumTokensOut,
          peak_5h_utilization: max5,
          peak_7d_utilization: max7,
          near_limit_count: nearLimit.length,
        },
        accounts,
        vms,
      })
    }

    // ========== Panel login (public) ==========
    if (req.method === 'POST' && p === '/api/panel/login') {
      const body = await readBody(req, 4096)
      const username = body.username || body.user || body.u || ''
      const password = body.password || body.pass || body.p || ''
      const authed = verifyPanelLogin(username, password)
      if (!authed) {
        return json(res, 401, { ok: false, error: { message: '用户名或密码错误', type: 'auth' } })
      }
      if (authed.source === 'env') {
        try {
          panelUsers.bootstrapFromEnv({ username: authed.username, password })
        } catch {}
      }
      const token = createPanelSession(authed.username, { role: authed.role })
      const secure = panelCookieSecure(req)
      res.setHeader('Set-Cookie', panelSessionCookie(token, { secure }))
      const me = { user: authed.username, role: authed.role }
      return json(res, 200, {
        ok: true,
        token,
        user: me.user,
        role: me.role,
        views: mePayload({ panelUser: me.user, panelRole: me.role }).views,
        capabilities: mePayload({ panelUser: me.user, panelRole: me.role }).capabilities,
        expires_in: 7 * 24 * 3600,
      })
    }
    if (req.method === 'POST' && p === '/api/panel/logout') {
      const tok = extractPanelToken(req)
      if (tok) revokePanelSession(tok)
      const secure = panelCookieSecure(req)
      res.setHeader('Set-Cookie', clearPanelSessionCookie({ secure }))
      return json(res, 200, { ok: true })
    }

    if (p.startsWith('/api/panel')) {
      if (!requireAuth(req, res)) return
      // Managed client keys may only call protocol endpoints — never panel/admin.
      // Only panel session or master KIN_API_KEY may administer.
      const isPanelOperator = !!req.panelUser || req.apiKeyKind === 'master'
      if (!isPanelOperator) {
        return json(
          res,
          403,
          makeError({
            type: ErrorType.PERMISSION,
            code: 'forbidden',
            message: 'Panel requires admin login or master API key',
            status: 403,
          }).body,
        )
      }
      if (req.method === 'GET' && p === '/api/panel/me') {
        const me = mePayload(req)
        const version = readLocalVersion(cfg?.paths?.project)
        const payload = { ...me, version }
        return json(res, 200, { ok: true, ...payload, data: payload })
      }
      const gate = authorizePanelRoute(req.method, p, panelIdentity(req).role)
      if (!gate.ok) {
        return json(
          res,
          403,
          makeError({
            type: ErrorType.PERMISSION,
            code: gate.code || 'forbidden',
            message: gate.message || '当前权限无法执行此操作',
            status: 403,
          }).body,
        )
      }
      if (
        denyIfUserMissesVm(req, res, {
          projectRoot: cfg.paths.project,
          json,
          path: p,
        }) ||
        denyIfUserMissesProxy(req, res, { proxyPool, json, path: p })
      ) {
        return true
      }
      if (p.startsWith('/api/panel/cluster/')) return ctx.clusterRoutes.handle(req, res, url)
      if (req.method === 'GET' && p === '/api/panel/database/metrics') {
        const snapshot = snapshotDatabaseMetrics({
          db: getDb(),
          dbPath: getDbPath(),
          usageCache: getUsageCache(),
        })
        return json(res, 200, panel.ok(snapshot))
      }
      if (req.method === 'GET' && p === '/api/panel/version') {
        const status = await buildUpdateStatus({ projectRoot: cfg?.paths?.project })
        return json(res, 200, panel.ok(status))
      }
      if (req.method === 'GET' && p === '/api/panel/changelog') {
        const current = readLocalVersion(cfg?.paths?.project)
        const entries = loadChangelog(cfg?.paths?.project)
        return json(res, 200, panel.ok({ current, current_tag: `v${current}`, entries }))
      }
      if (req.method === 'POST' && p === '/api/panel/update') {
        const body = await readBody(req, 8192).catch(() => ({}))
        const result = await startHostUpgrade({
          projectRoot: cfg?.paths?.project,
          confirm: body?.confirm === true,
          version: body?.version,
        })
        if (result.error) {
          return json(res, result.status, {
            ok: false,
            error: result.error,
            data: result.data || null,
          })
        }
        return json(res, result.status, panel.ok(result.data))
      }
      if (req.method === 'GET' && p === '/api/panel/users') {
        return json(res, 200, panel.ok({ items: panelUsers.list() }))
      }
      if (req.method === 'POST' && p === '/api/panel/users') {
        const body = await readBody(req, 8192).catch(() => ({}))
        try {
          const rec = panelUsers.create({
            username: body.username || body.user,
            password: body.password || body.pass,
            role: body.role || 'user',
            enabled: body.enabled !== false,
            vm_create_quota: body.vm_create_quota,
          })
          return json(res, 201, panel.ok({ item: publicUserView(rec) }))
        } catch (e) {
          const status = e.code === 'username_exists' ? 409 : 400
          return json(res, status, {
            ok: false,
            error: { message: String(e.message || e), code: e.code || 'create_failed' },
          })
        }
      }
      if (req.method === 'PATCH' && /^\/api\/panel\/users\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const body = await readBody(req, 8192).catch(() => ({}))
        try {
          const rec = panelUsers.update(id, body || {}, { actorId: req.panelUserId })
          if (!rec) return json(res, 404, { ok: false, error: { message: 'user not found' } })
          if (body?.password) {
            revokePanelSessionsForUser(rec.username, { exceptToken: extractPanelToken(req) })
          }
          return json(res, 200, panel.ok({ item: publicUserView(rec) }))
        } catch (e) {
          const status = e.code === 'last_admin' || e.code === 'self_disable' ? 409 : 400
          return json(res, status, {
            ok: false,
            error: { message: String(e.message || e), code: e.code || 'update_failed' },
          })
        }
      }
      if (req.method === 'DELETE' && /^\/api\/panel\/users\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const existing = panelUsers.getById(id)
        try {
          const ok = panelUsers.remove(id, { actorId: req.panelUserId })
          if (!ok) return json(res, 404, { ok: false, error: { message: 'user not found' } })
          if (existing?.username) revokePanelSessionsForUser(existing.username)
          return json(res, 200, { ok: true, deleted: id })
        } catch (e) {
          const status = e.code === 'last_admin' || e.code === 'self_delete' ? 409 : 400
          return json(res, status, {
            ok: false,
            error: { message: String(e.message || e), code: e.code || 'delete_failed' },
          })
        }
      }
      if (req.method === 'GET' && p === '/api/panel/vm-pools') {
        return json(res, 200, panel.ok({ pools: vmPoolsFor(apiKeyStore.db).list() }))
      }
      if (req.method === 'POST' && p === '/api/panel/vm-pools') {
        const body = await readBody(req, 64 * 1024).catch(() => ({}))
        try {
          const pool = createVmPool(vmPoolsFor(apiKeyStore.db), body || {}, listVms(cfg.paths.project))
          return json(res, 201, panel.ok({ pool }))
        } catch (e) {
          return json(res, vmPoolHttpStatus(e.code), {
            ok: false,
            error: { message: String(e.message || e), code: e.code || 'create_failed' },
          })
        }
      }
      if (req.method === 'PATCH' && /^\/api\/panel\/vm-pools\/[^/]+$/.test(p)) {
        const id = decodeURIComponent(p.split('/').pop())
        const body = await readBody(req, 64 * 1024).catch(() => ({}))
        try {
          const pool = updateVmPool(vmPoolsFor(apiKeyStore.db), id, body || {}, listVms(cfg.paths.project))
          if (!pool) return json(res, 404, { ok: false, error: { message: '账号池不存在', code: 'vm_pool_not_found' } })
          return json(res, 200, panel.ok({ pool }))
        } catch (e) {
          return json(res, vmPoolHttpStatus(e.code), {
            ok: false,
            error: { message: String(e.message || e), code: e.code || 'update_failed' },
          })
        }
      }
      if (req.method === 'DELETE' && /^\/api\/panel\/vm-pools\/[^/]+$/.test(p)) {
        const id = decodeURIComponent(p.split('/').pop())
        const result = deleteVmPool(vmPoolsFor(apiKeyStore.db), id)
        if (!result.ok) {
          return json(res, vmPoolHttpStatus(result.error), {
            ok: false,
            error: {
              message: result.error === 'vm_pool_in_use' ? '仍有密钥绑定该账号池' : '账号池不存在',
              code: result.error,
              keys: result.keys,
            },
          })
        }
        return json(res, 200, { ok: true, deleted: id })
      }
      if (req.method === 'GET' && p === '/api/panel/api-keys') {
        const snap = apiKeyStore.snapshot()
        if (panelIdentity(req).role === 'user') {
          const mine = (snap.keys || []).filter(
            (k) => normalizeOwnerId(k.user_id) === normalizeOwnerId(req.panelUserId),
          )
          return json(res, 200, {
            ok: true,
            total: mine.length,
            active: mine.filter((k) => k.status === 'active').length,
            keys: mine,
          })
        }
        return json(res, 200, { ok: true, ...snap })
      }
      if (req.method === 'GET' && /^\/api\/panel\/api-keys\/[^/]+\/stats$/.test(p)) {
        const id = p.split('/')[4]
        if (denyIfUserMissesKey(req, res, { apiKeyStore, json, keyId: id })) return true
        const rec = apiKeyStore.getById(id)
        if (!rec) return json(res, 404, { ok: false, error: { message: 'api key not found' } })
        const usage_stats = requestLog?.keyUsageStats?.({ apiKeyId: id, days: 30 }) || null
        return json(res, 200, { ok: true, item: publicKeyView(rec, { reveal: false }), usage_stats })
      }
      if (req.method === 'POST' && p === '/api/panel/api-keys') {
        const body = await readBody(req, 8192).catch(() => ({}))
        const input = normalizePanelApiKeyInput(body)
        try {
          const scopeInput = { group_type: body?.group_type, allowed_vms: body?.allowed_vms }
          if (Object.prototype.hasOwnProperty.call(body || {}, 'vm_pool_id')) scopeInput.vm_pool_id = body.vm_pool_id
          const scope = normalizeKeyScope(scopeInput)
          const pools = vmPoolsFor(apiKeyStore.db)
          if (scope.vm_pool_id) assertVmPoolExists(pools, scope.vm_pool_id)
          else assertVmScope(listVms(cfg.paths.project), scope)
          const defaultConc = Number(
            ctx.routingConfig?.concurrency?.default_key_concurrency ??
              ctx.routingConfig?.concurrency?.default_max_per_account ??
              20,
          )
          const rec = apiKeyStore.create({
            name: body?.name,
            key: body?.key || body?.custom_key || undefined,
            category: body?.category,
            user_id:
              panelIdentity(req).role === 'user' ? req.panelUserId || null : body?.user_id || req.panelUserId || null,
            group_id: body?.group_id,
            group_type: scope.group_type,
            allowed_vms: scope.allowed_vms,
            vm_pool_id: scope.vm_pool_id,
            max_concurrency: body?.max_concurrency ?? defaultConc,
            default_concurrency: defaultConc,
            quota_requests: input.quota_requests,
            quota: input.quota,
            rate_limit_5h: body?.rate_limit_5h,
            rate_limit_1d: body?.rate_limit_1d,
            rate_limit_7d: body?.rate_limit_7d,
            rpm: body?.rpm ?? body?.rate_limit_rpm,
            expires_at:
              body?.expires_at ||
              (body?.expires_in_days
                ? new Date(Date.now() + Number(body.expires_in_days) * 86400_000).toISOString()
                : null),
          })
          return json(res, 201, {
            ok: true,
            item: publicKeyView(rec, { reveal: true }),
            note: 'plaintext stays recoverable via POST /api/panel/api-keys/:id/reveal',
          })
        } catch (e) {
          const status = vmPoolHttpStatus(e.code)
          return json(res, status, {
            ok: false,
            error: { message: String(e.message || e), code: e.code || 'create_failed' },
          })
        }
      }
      if (req.method === 'PATCH' && /^\/api\/panel\/api-keys\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        if (denyIfUserMissesKey(req, res, { apiKeyStore, json, keyId: id })) return true
        const body = await readBody(req, 8192).catch(() => ({}))
        try {
          const input = normalizePanelApiKeyInput(body || {})
          const scopeInput = { group_type: body?.group_type, allowed_vms: body?.allowed_vms }
          if (Object.prototype.hasOwnProperty.call(body || {}, 'vm_pool_id')) scopeInput.vm_pool_id = body.vm_pool_id
          const scope = normalizeKeyScope(scopeInput, { partial: true, current: apiKeyStore.getById(id) })
          if (scope) {
            const pools = vmPoolsFor(apiKeyStore.db)
            if (scope.vm_pool_id) assertVmPoolExists(pools, scope.vm_pool_id)
            else assertVmScope(listVms(cfg.paths.project), scope)
            input.group_type = scope.group_type
            input.allowed_vms = scope.allowed_vms
            input.vm_pool_id = scope.vm_pool_id
          }
          const rec = apiKeyStore.update(id, input)
          if (!rec) {
            return json(res, 404, { ok: false, error: { message: 'api key not found' } })
          }
          return json(res, 200, { ok: true, item: publicKeyView(rec, { reveal: false }) })
        } catch (e) {
          return json(res, vmPoolHttpStatus(e.code), {
            ok: false,
            error: { message: String(e.message || e), code: e.code },
          })
        }
      }
      if (req.method === 'POST' && /^\/api\/panel\/api-keys\/[^/]+\/reveal$/.test(p)) {
        const id = p.split('/')[4]
        if (denyIfUserMissesKey(req, res, { apiKeyStore, json, keyId: id })) return true
        const out = apiKeyStore.reveal(id)
        if (!out) return json(res, 404, { ok: false, error: { message: 'api key not found' } })
        if (!out.ok) {
          return json(res, 409, {
            ok: false,
            error: { message: '该密钥只留了哈希，无法还原明文；请换新', code: out.code },
          })
        }
        return json(res, 200, { ok: true, id: out.id, name: out.name, key: out.key })
      }
      if (req.method === 'POST' && /^\/api\/panel\/api-keys\/[^/]+\/rotate$/.test(p)) {
        const id = p.split('/')[4]
        if (denyIfUserMissesKey(req, res, { apiKeyStore, json, keyId: id })) return true
        try {
          const rec = apiKeyStore.rotate(id)
          if (!rec) return json(res, 404, { ok: false, error: { message: 'api key not found' } })
          return json(res, 200, { ok: true, item: publicKeyView(rec, { reveal: true }) })
        } catch (e) {
          return json(res, 400, {
            ok: false,
            error: { message: String(e.message || e), code: e.code || 'rotate_failed' },
          })
        }
      }
      if (req.method === 'POST' && /^\/api\/panel\/api-keys\/[^/]+\/reset-quota$/.test(p)) {
        const id = p.split('/')[4]
        if (denyIfUserMissesKey(req, res, { apiKeyStore, json, keyId: id })) return true
        const rec = apiKeyStore.update(id, { reset_quota: true })
        if (!rec) return json(res, 404, { ok: false, error: { message: 'api key not found' } })
        return json(res, 200, { ok: true, item: publicKeyView(rec, { reveal: false }) })
      }
      if (req.method === 'DELETE' && /^\/api\/panel\/api-keys\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        if (denyIfUserMissesKey(req, res, { apiKeyStore, json, keyId: id })) return true
        const ok = apiKeyStore.remove(id)
        if (!ok) return json(res, 404, { ok: false, error: { message: 'api key not found' } })
        return json(res, 200, { ok: true, deleted: id })
      }

      if (req.method === 'GET' && p === '/api/panel/api-endpoints') {
        return json(res, 200, {
          ok: true,
          items: apiEndpointStore.list({ reveal: false }),
          presets: API_ENDPOINT_PRESETS,
        })
      }
      if (req.method === 'POST' && p === '/api/panel/api-endpoints/fetch-models') {
        const body = await readBody(req, 8192).catch(() => ({}))
        try {
          const result = await fetchUpstreamModels({
            cfg,
            kind: body?.kind,
            protocol: body?.protocol,
            base_url: body?.base_url,
            api_key: body?.api_key,
            proxy_url: body?.proxy_url,
            headers: body?.headers,
            auth_scheme: body?.auth_scheme || body?.authScheme,
          })
          return json(res, 200, { ok: true, ...result })
        } catch (e) {
          return json(res, e.status && e.status < 600 ? e.status : 400, {
            ok: false,
            error: { message: String(e.message || e), code: e.code || 'fetch_models_failed' },
          })
        }
      }
      if (req.method === 'POST' && p === '/api/panel/api-endpoints') {
        const body = await readBody(req, 1 << 20).catch(() => ({}))
        try {
          const rec = apiEndpointStore.create(body || {})
          apiScheduler.reload(apiEndpointStore.listRaw())
          return json(res, 201, { ok: true, item: publicEndpointView(rec, { reveal: true }) })
        } catch (e) {
          return json(res, 400, {
            ok: false,
            error: { message: String(e.message || e), code: e.code || 'create_failed' },
          })
        }
      }
      if (req.method === 'PATCH' && /^\/api\/panel\/api-endpoints\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const body = await readBody(req, 1 << 20).catch(() => ({}))
        try {
          const rec = apiEndpointStore.update(id, body || {})
          if (!rec) return json(res, 404, { ok: false, error: { message: 'endpoint not found' } })
          apiScheduler.reload(apiEndpointStore.listRaw())
          return json(res, 200, { ok: true, item: publicEndpointView(rec) })
        } catch (e) {
          return json(res, 400, { ok: false, error: { message: String(e.message || e), code: e.code } })
        }
      }
      if (req.method === 'DELETE' && /^\/api\/panel\/api-endpoints\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const ok = apiEndpointStore.remove(id)
        if (!ok) return json(res, 404, { ok: false, error: { message: 'endpoint not found' } })
        apiScheduler.reload(apiEndpointStore.listRaw())
        return json(res, 200, { ok: true, deleted: id })
      }
      if (req.method === 'POST' && /^\/api\/panel\/api-endpoints\/[^/]+\/fetch-models$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readBody(req, 8192).catch(() => ({}))
        const ep = apiEndpointStore.getRaw(id)
        if (!ep) return json(res, 404, { ok: false, error: { message: 'endpoint not found' } })
        const key = (ep.api_key_entries || []).find((k) => !k.disabled && (body?.key_id ? k.id === body.key_id : true))
        if (!key)
          return json(res, 400, { ok: false, error: { message: '需要上游 key 才能获取模型', code: 'key_required' } })
        try {
          const result = await fetchUpstreamModels({
            cfg,
            kind: ep.kind,
            protocol: ep.protocol,
            base_url: ep.base_url,
            api_key: key.api_key,
            proxy_url: key.proxy_url,
            headers: ep.headers,
          })
          const apply = body?.apply !== false
          const rec = apply ? apiEndpointStore.mergeFetchedModels(id, result.models) : ep
          if (apply) apiScheduler.reload(apiEndpointStore.listRaw())
          return json(res, 200, {
            ok: true,
            fetched: result.models.length,
            item: publicEndpointView(rec),
            models: result.models,
          })
        } catch (e) {
          return json(res, e.status && e.status < 600 ? e.status : 400, {
            ok: false,
            error: { message: String(e.message || e), code: e.code || 'fetch_models_failed' },
          })
        }
      }
      if (req.method === 'POST' && /^\/api\/panel\/api-endpoints\/[^/]+\/keys$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readBody(req, 8192).catch(() => ({}))
        try {
          const key = apiEndpointStore.addKey(id, body || {})
          apiScheduler.reload(apiEndpointStore.listRaw())
          const view = publicEndpointView(apiEndpointStore.getRaw(id), { reveal: true })
          return json(res, 201, { ok: true, item: view?.api_key_entries?.find((k) => k.id === key.id) || key })
        } catch (e) {
          const status = e.code === 'endpoint_not_found' ? 404 : 400
          return json(res, status, { ok: false, error: { message: String(e.message || e), code: e.code } })
        }
      }
      if (req.method === 'DELETE' && /^\/api\/panel\/api-endpoints\/[^/]+\/keys\/[^/]+$/.test(p)) {
        const kid = p.split('/').pop()
        const ok = apiEndpointStore.removeKey(kid)
        if (!ok) return json(res, 404, { ok: false, error: { message: 'key not found' } })
        apiScheduler.reload(apiEndpointStore.listRaw())
        return json(res, 200, { ok: true, deleted: kid })
      }
      if (req.method === 'PATCH' && /^\/api\/panel\/api-endpoints\/[^/]+\/keys\/[^/]+$/.test(p)) {
        const kid = p.split('/').pop()
        const body = await readBody(req, 8192).catch(() => ({}))
        const rec = apiEndpointStore.updateKey(kid, body || {})
        if (!rec) return json(res, 404, { ok: false, error: { message: 'key not found' } })
        apiScheduler.reload(apiEndpointStore.listRaw())
        const ep = apiEndpointStore.getRaw(rec.endpoint_id)
        const item = publicEndpointView(ep)?.api_key_entries?.find((k) => k.id === kid)
        return json(res, 200, { ok: true, item })
      }

      // ---- Request logs (normal summary + debug full; DB-backed filters/pagination) ----
      if (req.method === 'GET' && p === '/api/panel/request-logs') {
        const u = new URL(req.url, 'http://x')
        const mode = (u.searchParams.get('mode') || 'normal').toLowerCase()
        const limit = Number(u.searchParams.get('limit') || 50)
        if (mode === 'debug') {
          return json(res, 200, {
            ok: true,
            mode: 'debug',
            config: requestLog.snapshot(),
            items: requestLog.listDebug({
              limit,
              error_class: u.searchParams.get('error_class') || null,
              exclude_error_class: u.searchParams.get('exclude_error_class') || null,
              include_muted: u.searchParams.get('include_muted') === '1',
              owner_user_id:
                panelIdentity(req).role === 'user' ? req.panelUserId : u.searchParams.get('user_id') || null,
            }),
          })
        }
        const filters = {
          limit,
          offset: Number(u.searchParams.get('offset') || 0),
          api_key_id: u.searchParams.get('api_key_id') || null,
          vm_id: u.searchParams.get('vm_id') || null,
          account_id: u.searchParams.get('account_id') || null,
          model: u.searchParams.get('model') || null,
          protocol: u.searchParams.get('protocol') || null,
          status: u.searchParams.get('status') || null,
          error_class: u.searchParams.get('error_class') || null,
          exclude_error_class: u.searchParams.get('exclude_error_class') || null,
          include_muted: u.searchParams.get('include_muted') === '1',
          since: u.searchParams.get('since') || null,
          until: u.searchParams.get('until') || null,
          q: u.searchParams.get('q') || null,
          owner_user_id: panelIdentity(req).role === 'user' ? req.panelUserId : u.searchParams.get('user_id') || null,
        }
        const { items, total } = requestLog.queryNormal(filters)
        return json(res, 200, {
          ok: true,
          mode: 'normal',
          config: requestLog.snapshot(),
          items,
          total,
          limit: filters.limit,
          offset: filters.offset,
        })
      }
      if (req.method === 'GET' && p === '/api/panel/request-logs/export') {
        const u = new URL(req.url, 'http://x')
        const format = (u.searchParams.get('format') || 'jsonl').toLowerCase() === 'csv' ? 'csv' : 'jsonl'
        const filters = {
          limit: Math.min(5000, Number(u.searchParams.get('limit') || 2000)),
          maxLimit: 5000,
          api_key_id: u.searchParams.get('api_key_id') || null,
          vm_id: u.searchParams.get('vm_id') || null,
          account_id: u.searchParams.get('account_id') || null,
          model: u.searchParams.get('model') || null,
          protocol: u.searchParams.get('protocol') || null,
          status: u.searchParams.get('status') || null,
          error_class: u.searchParams.get('error_class') || null,
          exclude_error_class: u.searchParams.get('exclude_error_class') || null,
          include_muted: u.searchParams.get('include_muted') === '1',
          since: u.searchParams.get('since') || null,
          until: u.searchParams.get('until') || null,
          q: u.searchParams.get('q') || null,
          owner_user_id: panelIdentity(req).role === 'user' ? req.panelUserId : u.searchParams.get('user_id') || null,
        }
        const { items, total } = requestLog.exportRows(filters)
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')
        const body = format === 'csv' ? logsToCsv(items) : logsToJsonl(items)
        const filename = `vm2api-logs-${stamp}.${format}`
        res.writeHead(200, {
          'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
          'x-kin-export-count': String(items.length),
          'x-kin-export-total': String(total),
          'x-kin-export-truncated': items.length < total ? '1' : '0',
        })
        res.end(body)
        return
      }
      // ---- Aggregated usage stats from request_logs (charts) ----
      if (req.method === 'GET' && p === '/api/panel/request-logs/stats') {
        const u = new URL(req.url, 'http://x')
        const bucket = (u.searchParams.get('bucket') || 'day').toLowerCase() === 'hour' ? 'hour' : 'day'
        const since = u.searchParams.get('since') || new Date(Date.now() - 7 * 86400_000).toISOString()
        const until = u.searchParams.get('until') || null
        const owner_user_id =
          panelIdentity(req).role === 'user' ? req.panelUserId : u.searchParams.get('user_id') || null
        return json(res, 200, {
          ok: true,
          bucket,
          since,
          until,
          totals: requestLog.totals(),
          buckets: requestLog.aggregate({ since, until, bucket, owner_user_id }),
          window: requestLog.windowStats({ since, until, owner_user_id }),
          muted_error_classes: requestLog.snapshot().muted_error_classes,
          config: requestLog.snapshot(),
        })
      }
      if (req.method === 'GET' && /^\/api\/panel\/request-logs\/[^/]+\/attempts$/.test(p)) {
        const requestId = p.split('/')[4]
        const owner_user_id = panelIdentity(req).role === 'user' ? req.panelUserId : null
        if (owner_user_id && !requestLog.getDebug(requestId, { owner_user_id })) {
          return json(res, 404, { ok: false, error: { message: 'debug log not found' } })
        }
        return json(
          res,
          200,
          panel.ok({
            request_id: requestId,
            attempts:
              (typeof ctx.getAttemptsRepo === 'function' ? ctx.getAttemptsRepo() : ctx.attemptsRepo)?.list?.(
                requestId,
              ) || [],
          }),
        )
      }
      if (req.method === 'GET' && /^\/api\/panel\/request-logs\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const owner_user_id = panelIdentity(req).role === 'user' ? req.panelUserId : null
        const rec = requestLog.getDebug(id, { owner_user_id })
        if (!rec) return json(res, 404, { ok: false, error: { message: 'debug log not found' } })
        return json(res, 200, { ok: true, item: rec })
      }

      // ---- Scrolling usage logs (keyset cursor, camelCase rows) ----
      // Lives beside /request-logs (offset + snake_case, still used by error
      // collection and export); this surface never COUNTs the table.
      const usageLogsView = () => new UsageLogsView(getDb(), { mutedErrorClasses: requestLog?.mutedErrorClasses })
      const tenantId = () => (panelIdentity(req).role === 'user' ? req.panelUserId : null)
      if (req.method === 'GET' && p === '/api/panel/usage-logs') {
        const u = new URL(req.url, 'http://x')
        return json(res, 200, panel.ok(usageLogsView().listBatch(usageLogFilters(req, u))))
      }
      if (req.method === 'GET' && p === '/api/panel/usage-logs/summary') {
        const u = new URL(req.url, 'http://x')
        return json(res, 200, panel.ok(usageLogsView().summary(usageLogFilters(req, u))))
      }
      if (req.method === 'GET' && p === '/api/panel/usage-logs/filter-options') {
        return json(res, 200, panel.ok(usageLogsView().filterOptions({ owner_user_id: tenantId() })))
      }
      if (req.method === 'GET' && p === '/api/panel/usage-logs/session-suggestions') {
        const u = new URL(req.url, 'http://x')
        const q = u.searchParams.get('q') || ''
        const limit = u.searchParams.get('limit')
        return json(res, 200, panel.ok(usageLogsView().sessionSuggestions({ q, limit, owner_user_id: tenantId() })))
      }
      if (req.method === 'GET' && p === '/api/panel/usage-logs/active-sessions') {
        const u = new URL(req.url, 'http://x')
        const minutes = u.searchParams.get('minutes')
        const limit = u.searchParams.get('limit')
        return json(res, 200, panel.ok(usageLogsView().activeSessions({ minutes, limit, owner_user_id: tenantId() })))
      }
      if (req.method === 'GET' && p === '/api/panel/usage-logs/overview') {
        const u = new URL(req.url, 'http://x')
        const tz = u.searchParams.get('tz') || 'UTC'
        return json(res, 200, panel.ok(usageLogsView().overview({ tz, owner_user_id: tenantId() })))
      }

      // ---- Statistics page ----
      if (req.method === 'GET' && p === '/api/panel/statistics') {
        const u = new URL(req.url, 'http://x')
        const q = statsParams(req, u, 'dimension')
        if (q.error) return json(res, 400, { ok: false, error: { message: q.error } })
        const { range, dimension, tz, owner_user_id } = q
        return json(res, 200, panel.ok(new StatisticsRepo(getDb()).statistics({ range, dimension, tz, owner_user_id })))
      }
      if (req.method === 'GET' && p === '/api/panel/statistics/leaderboard') {
        const u = new URL(req.url, 'http://x')
        const q = statsParams(req, u, 'scope')
        if (q.error) return json(res, 400, { ok: false, error: { message: q.error } })
        const { range, dimension: scope, tz, owner_user_id } = q
        const limit = u.searchParams.get('limit')
        return json(
          res,
          200,
          panel.ok(new StatisticsRepo(getDb()).leaderboard({ range, scope, limit, tz, owner_user_id })),
        )
      }

      if (req.method === 'GET' && p === '/api/panel/billing') {
        const u = new URL(req.url, 'http://x')
        const ident = panelIdentity(req)
        const ownerUserId = ident.role === 'user' ? req.panelUserId : u.searchParams.get('user_id') || null
        const groupBy = u.searchParams.get('group_by') === 'key' ? 'key' : 'vm'
        const since = u.searchParams.get('from') || u.searchParams.get('since') || null
        const until = u.searchParams.get('until') || null
        return json(res, 200, panel.ok(requestLog.ownerBilling({ ownerUserId, since, until, groupBy })))
      }

      // ---- Backups (local auto/manual, download, restore) ----
      if (req.method === 'GET' && p === '/api/panel/backups') {
        return json(res, 200, {
          ok: true,
          items: backupService.list(),
          config: backupService.getSchedule(),
          next_auto_at: backupService.nextAutoAt(),
          restoring: backupService.isRestoring,
        })
      }
      if (req.method === 'POST' && p === '/api/panel/backups') {
        try {
          const rec = backupService.createBackup({ kind: 'manual' })
          return json(res, 201, { ok: true, item: rec })
        } catch (e) {
          const status = e.code === 'backup_in_progress' ? 409 : 500
          return json(res, status, {
            ok: false,
            error: { message: String(e.message || e), code: e.code || 'backup_failed' },
          })
        }
      }
      if (req.method === 'GET' && p === '/api/panel/backups/config') {
        return json(res, 200, {
          ok: true,
          config: backupService.getSchedule(),
          next_auto_at: backupService.nextAutoAt(),
        })
      }
      if (req.method === 'PUT' && p === '/api/panel/backups/config') {
        const body = await readBody(req, 8192).catch(() => ({}))
        try {
          const config = backupService.updateSchedule(body || {})
          return json(res, 200, { ok: true, config, next_auto_at: backupService.nextAutoAt() })
        } catch (e) {
          return json(res, 400, { ok: false, error: { message: String(e.message || e), code: e.code } })
        }
      }
      if (req.method === 'GET' && /^\/api\/panel\/backups\/[^/]+\/download$/.test(p)) {
        const id = p.split('/')[4]
        const rec = backupService.get(id)
        if (!rec || !rec.file_path || !fs.existsSync(rec.file_path)) {
          return json(res, 404, { ok: false, error: { message: 'backup file not found' } })
        }
        res.writeHead(200, {
          'content-type': 'application/gzip',
          'content-length': fs.statSync(rec.file_path).size,
          'content-disposition': `attachment; filename="${rec.file_name}"`,
          'x-kin-backup-sha256': rec.sha256 || '',
        })
        fs.createReadStream(rec.file_path).pipe(res)
        return
      }
      if (req.method === 'POST' && /^\/api\/panel\/backups\/[^/]+\/restore$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readBody(req, 4096).catch(() => ({}))
        if (body?.confirm !== true) {
          return json(res, 400, {
            ok: false,
            error: { message: 'restore requires {"confirm": true}', code: 'confirm_required' },
          })
        }
        try {
          const out = backupService.restoreBackup(id)
          return json(res, 200, { ok: true, ...out })
        } catch (e) {
          const map = {
            backup_not_found: 404,
            backup_file_missing: 404,
            restore_in_progress: 409,
            backup_corrupt: 422,
            backup_not_ok: 422,
          }
          return json(res, map[e.code] || 500, {
            ok: false,
            error: { message: String(e.message || e), code: e.code || 'restore_failed' },
          })
        }
      }
      if (req.method === 'DELETE' && /^\/api\/panel\/backups\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        if (!backupService.remove(id)) return json(res, 404, { ok: false, error: { message: 'backup not found' } })
        return json(res, 200, { ok: true, deleted: id })
      }

      // GET /api/panel/dashboard
      if (req.method === 'GET' && p === '/api/panel/dashboard') {
        return json(
          res,
          200,
          await panel.buildDashboard({
            cfg,
            accountQuota,
            stickyRouter,
            routingConfig: ctx.routingConfig,
            stats,
            requestLog,
            poolScheduler: ctx.poolScheduler,
            proxyPool,
          }),
        )
      }
      if (req.method === 'GET' && p === '/api/panel/vms') {
        const ident = panelIdentity(req)
        return json(
          res,
          200,
          await panel.buildVmList({
            cfg,
            accountQuota,
            routingConfig: ctx.routingConfig,
            poolScheduler: ctx.poolScheduler,
            proxyPool,
            requestLog,
            role: ident.role,
            ownerUserId: ident.role === 'user' ? req.panelUserId : null,
          }),
        )
      }
      // GET /api/panel/pool/stream — live seat / queue snapshots (SSE over fetch).
      if (req.method === 'GET' && p === '/api/panel/pool/stream') {
        const ident = panelIdentity(req)
        const ownerUserId = ident.role === 'user' ? req.panelUserId : null
        return servePoolSeatStream({
          req,
          res,
          getScheduler: () => ctx.poolScheduler,
          writeSSEHeaders: ctx.writeSSEHeaders,
          visibleVmIds:
            ident.role === 'user'
              ? () =>
                  new Set(
                    filterVmsForPanel(listVms(cfg.paths.project, ctx.routingConfig), {
                      role: ident.role,
                      userId: ownerUserId,
                    }).map((vm) => vm.id),
                  )
              : null,
        })
      }
      // GET /api/panel/vms/fleet-status — must be before /vms/:id
      if (req.method === 'GET' && p === '/api/panel/vms/fleet-status') {
        return json(res, 200, panel.ok({ items: fleetStatus(cfg.paths.project) }))
      }
      // GET /api/panel/vms/create-options — same ACL as POST /vms/create; tenants cannot read cluster/local
      if (req.method === 'GET' && p === '/api/panel/vms/create-options') {
        const probe = typeof ctx.probeLocalKvm === 'function' ? ctx.probeLocalKvm : probeLocalKvm
        const kvm = await probe({ routing: ctx.routingConfig })
        return json(
          res,
          200,
          panel.ok({
            vm: normalizeVmConfig(ctx.routingConfig?.vm),
            kvm,
          }),
        )
      }
      // POST /api/panel/vms/fleet-update
      if (req.method === 'POST' && p === '/api/panel/vms/reconcile-fingerprints') {
        return json(res, 200, panel.ok(reconcileOfficialFingerprints(cfg.paths.project)))
      }
      if (req.method === 'POST' && p === '/api/panel/vms/fleet-update') {
        const body = await readBody(req, 32 * 1024).catch(() => ({}))
        const report = await runFleetUpdate(cfg.paths.project, {
          action: body.action || 'roll',
          ids: Array.isArray(body.ids) ? body.ids : null,
          concurrency: body.concurrency,
          routing: ctx.routingConfig,
        })
        return json(res, 200, panel.ok(report))
      }
      if (req.method === 'GET' && p === '/api/panel/wrap-cli') {
        const sample = describeWrapSample(cfg.paths.project)
        return json(
          res,
          200,
          panel.ok({
            ...sample,
            dataplane: resolveKernelDataplane({}, ctx.routingConfig) || 'wrap',
          }),
        )
      }
      if (req.method === 'POST' && p === '/api/panel/dataplane') {
        const body = await readBody(req, 8 * 1024).catch(() => ({}))
        const parsed = parseKernelDataplanePatch(body.dataplane)
        if (!parsed.ok || !parsed.value) {
          return json(res, 400, {
            ok: false,
            error: { code: 'invalid_dataplane', message: parsed.error || 'dataplane must be wrap, cc, or crag' },
          })
        }
        const targets = parseSlotPolicyTargets({
          ids: body.ids,
          all: body.all === true || !Array.isArray(body.ids),
        })
        if (!targets.ok) {
          return json(res, 400, { ok: false, error: { message: targets.error } })
        }
        const previous = structuredClone(ctx.routingConfig)
        try {
          if (targets.all) {
            persistRoutingPatch({
              inference: {
                ...(ctx.routingConfig.inference || {}),
                dataplane: parsed.value,
              },
            })
          } else {
            for (const id of targets.ids) {
              persistSlotEnginePolicy(cfg.paths.project, id, { dataplane: parsed.value })
            }
          }
        } catch (error) {
          ctx.routingConfig = previous
          return json(res, 503, {
            ok: false,
            error: { code: 'dataplane_persist_failed', message: String(error?.message || error) },
          })
        }
        const report = await syncInstalledKernels({
          project: cfg.paths.project,
          routingConfig: ctx.routingConfig,
          body: {
            ids: targets.all ? undefined : targets.ids,
            restart: body.restart !== false,
          },
        })
        return json(
          res,
          report.ok ? 200 : 503,
          panel.ok({
            dataplane: parsed.value,
            ...report,
          }),
        )
      }
      if (req.method === 'POST' && p === '/api/panel/wrap-cli/crag-kernel') {
        const raw = await readRawBody(req, 32 * 1024 * 1024)
        const written = replaceCragKernelBinary(cfg.paths.project, raw)
        if (!written.ok) {
          return json(res, 400, { ok: false, error: { code: written.code, message: written.error } })
        }
        return json(res, 200, panel.ok(written))
      }
      if (req.method === 'POST' && p === '/api/panel/wrap-cli/make') {
        const body = await readBody(req, 8 * 1024).catch(() => ({}))
        const glibcVm = String(body.glibc_vm || body.glibcVm || '').trim()
        let glibcFromDir = ''
        if (glibcVm) {
          const candidate = path.join(wrapCliHomeDir(cfg.paths.project, glibcVm), 'glibc239')
          if (fs.existsSync(candidate)) glibcFromDir = candidate
        }
        const made = makeWrapSample(cfg.paths.project, { glibcFromDir })
        if (!made.ok) {
          return json(res, 400, { ok: false, error: { code: made.code, message: made.error } })
        }
        return json(res, 200, panel.ok(made))
      }
      if (req.method === 'POST' && p === '/api/panel/wrap-cli/kernel/release') {
        const body = await readBody(req, 8 * 1024).catch(() => ({}))
        const downloaded = await downloadReleaseKernel({
          tag: body.tag,
          fetchImpl: ctx.fetchImpl,
        })
        if (!downloaded.ok) {
          return json(res, kernelReleaseHttpStatus(downloaded.code), {
            ok: false,
            error: { code: downloaded.code, message: downloaded.error },
          })
        }
        const replaced = replaceKernelBinary(cfg.paths.project, downloaded.bytes, {
          source: 'github',
          release_tag: downloaded.tag,
        })
        if (!replaced.ok) {
          return json(res, 400, { ok: false, error: { code: replaced.code, message: replaced.error } })
        }
        const cliNode = replaceCliNodeBinary(cfg.paths.project, downloaded.cliNode?.bytes)
        if (!cliNode.ok) {
          return json(res, 400, { ok: false, error: { code: cliNode.code, message: cliNode.error } })
        }
        const ccNode = replaceCcNodeBinary(cfg.paths.project, downloaded.ccNode?.bytes)
        if (!ccNode.ok) {
          return json(res, 400, { ok: false, error: { code: ccNode.code, message: ccNode.error } })
        }
        const cragWritten = replaceCragKernelBinary(cfg.paths.project, downloaded.crag?.bytes)
        if (!cragWritten.ok) {
          return json(res, 400, { ok: false, error: { code: cragWritten.code, message: cragWritten.error } })
        }
        const report = await syncInstalledKernels({
          project: cfg.paths.project,
          routingConfig: ctx.routingConfig,
          body,
        })
        const release = {
          tag: downloaded.tag,
          version: downloaded.version,
          asset: downloaded.asset,
          size: downloaded.size,
          cli_node: downloaded.cliNode?.asset,
          cli_node_size: cliNode.size,
          cc_node: downloaded.ccNode?.asset,
          cc_node_size: ccNode.size,
          crag: downloaded.crag?.asset || null,
          crag_size: cragWritten.size || 0,
          crag_skipped: false,
        }
        if (!report.ok) {
          return json(res, 400, {
            ok: false,
            error: {
              code: 'kernel_sync_failed',
              message: `已写入 ${downloaded.tag}，槽同步 ${report.ok_count}/${report.total} 失败`,
            },
            data: { release, kernel: replaced, sync: report },
          })
        }
        return json(res, 200, panel.ok({ release, kernel: replaced, sync: report }))
      }

      if (req.method === 'POST' && p === '/api/panel/wrap-cli/kernel') {
        let buf
        try {
          buf = await readRawBody(req, cfg.limits?.max_body_bytes || 32 * 1024 * 1024)
        } catch (error) {
          const status = error?.status || 400
          const body = error?.body || { error: { message: String(error?.message || error) } }
          return json(res, status, { ok: false, ...body })
        }
        if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || [])
        if (!buf.length) {
          return json(res, 400, { ok: false, error: { code: 'kernel_empty', message: 'kernel binary required' } })
        }
        const replaced = replaceKernelBinary(cfg.paths.project, buf)
        if (!replaced.ok) {
          return json(res, 400, { ok: false, error: { code: replaced.code, message: replaced.error } })
        }
        return json(res, 200, panel.ok(replaced))
      }

      if (req.method === 'POST' && p === '/api/panel/wrap-cli/sync') {
        const body = await readBody(req, 32 * 1024).catch(() => ({}))
        const report = await syncInstalledKernels({
          project: cfg.paths.project,
          routingConfig: ctx.routingConfig,
          body,
        })
        return json(res, report.ok ? 200 : 400, panel.ok(report))
      }
      if (req.method === 'POST' && p === '/api/panel/vms/slot-policy') {
        const body = await readBody(req, 32 * 1024).catch(() => ({}))
        const parsed = parseSlotEnginePolicyPatch(body)
        if (!parsed.ok) return json(res, 400, { ok: false, error: { message: parsed.error } })
        const targets = parseSlotPolicyTargets(body)
        if (!targets.ok) return json(res, 400, { ok: false, error: { message: targets.error } })
        const ids = targets.all ? listVms(cfg.paths.project).map((vm) => vm.id) : targets.ids
        const results = []
        for (const id of ids) results.push(await applySlotPolicyWithRuntime(id, parsed.patch))
        const failed = results.filter((item) => !item.ok)
        const report = {
          updated: results.length - failed.length,
          missing: failed.filter((item) => item.code === 'vm_not_found').map((item) => item.id),
          failed: failed.map(({ id, code, error }) => ({ id, code, error })),
          items: results
            .filter((item) => item.ok)
            .map((item) => summarizeVm(item.vm, cfg.paths.project, ctx.routingConfig)),
        }
        return json(res, 200, panel.ok(report))
      }
      // POST /api/panel/vms/:id/reload
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/reload$/.test(p)) {
        const id = p.split('/')[4]
        const vm = getVm(cfg.paths.project, id)
        if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        const reloaded = await reloadSlotReady(vm, cfg.paths.project, { routing: ctx.routingConfig })
        if (!reloaded.ok) {
          return json(res, 500, {
            ok: false,
            error: { message: reloaded.error || 'reload failed', code: reloaded.code },
          })
        }
        return json(res, 200, panel.ok({ id, reload: reloaded }))
      }
      // POST /api/panel/vms/:id/shell-ticket — single-use ticket for the slot terminal WebSocket
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/shell-ticket$/.test(p)) {
        const issued = ctx.slotShell.issueTicket(p.split('/')[4])
        if (!issued.ok) return json(res, issued.status, { ok: false, error: issued.error })
        return json(res, 200, panel.ok({ ticket: issued.ticket, expires_in: issued.expires_in }))
      }
      // POST /api/panel/vms/:id/collect-identity
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/collect-identity$/.test(p)) {
        const id = p.split('/')[4]
        const vm = getVm(cfg.paths.project, id)
        if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        const collected = await collectSlotIdentity(cfg.paths.project, vm)
        if (!collected.ok) {
          return json(res, 502, {
            ok: false,
            error: { message: collected.error || 'collect failed', code: collected.code },
          })
        }
        return json(res, 200, panel.ok(collected))
      }
      if (req.method === 'PATCH' && /^\/api\/panel\/vms\/[^/]+\/owner$/.test(p)) {
        if (panelIdentity(req).role !== 'admin') {
          return json(res, 403, { ok: false, error: { code: 'forbidden', message: '当前权限无法执行此操作' } })
        }
        const id = p.split('/')[4]
        const vm = getVm(cfg.paths.project, id)
        if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        const body = await readBody(req, 8192).catch(() => ({}))
        const nextOwner =
          body.user_id === null || body.user_id === '' ? null : normalizeOwnerId(body.user_id || body.owner_user_id)
        if (nextOwner && !panelUsers.getById(nextOwner)) {
          return json(res, 404, { ok: false, error: { message: 'user not found' } })
        }
        const currentOrigin = vm.origin || VM_ORIGIN.platform
        if (!nextOwner && currentOrigin === VM_ORIGIN.userCreated) {
          return json(res, 400, {
            ok: false,
            error: { code: 'cannot_unassign_user_created', message: '自建 VM 不能收回进平台池，请删除' },
          })
        }
        const origin = assignOriginForOwner(nextOwner, { previousOrigin: currentOrigin, actorRole: 'admin' })
        const saved = persistVmOwner(cfg.paths.project, id, { ownerUserId: nextOwner, origin })
        return json(res, 200, panel.ok({ vm: summarizeVm(saved, cfg.paths.project, ctx.routingConfig) }))
      }

      // GET /api/panel/vms/:id
      if (req.method === 'GET' && /^\/api\/panel\/vms\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const result = await panel.buildVmDetail({
          cfg,
          accountQuota,
          id,
          routingConfig: ctx.routingConfig,
          poolScheduler: ctx.poolScheduler,
          requestLog,
          proxyPool,
          kernelHealth: panelKernelHealth,
        })
        if (result.status) return json(res, result.status, result.body)
        return json(res, 200, result)
      }
      // PATCH /api/panel/vms/:id — hot concurrency / allowed models (no VM restart)
      if (req.method === 'PATCH' && /^\/api\/panel\/vms\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const body = await readBody(req, 8192).catch(() => ({}))
        const currentVm = getVm(cfg.paths.project, id)
        if (!currentVm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        const strictInteger = (value, min, max, label, { nullable = false } = {}) => {
          if (nullable && value === null) return null
          if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
            throw new TypeError(`${label} must be an integer`)
          }
          if (value < min || value > max) throw new RangeError(`${label} must be between ${min} and ${max}`)
          return value
        }
        const hasConcurrency =
          Object.prototype.hasOwnProperty.call(body || {}, 'max_concurrency') ||
          Object.prototype.hasOwnProperty.call(body || {}, 'maxConcurrency')
        const hasRpm =
          Object.prototype.hasOwnProperty.call(body || {}, 'max_rpm') ||
          Object.prototype.hasOwnProperty.call(body || {}, 'maxRpm')
        const next = Object.prototype.hasOwnProperty.call(body || {}, 'max_concurrency')
          ? body.max_concurrency
          : body.maxConcurrency
        const nextRpm = Object.prototype.hasOwnProperty.call(body || {}, 'max_rpm') ? body.max_rpm : body.maxRpm
        const hasMaxSessions = body && Object.prototype.hasOwnProperty.call(body, 'max_sessions')
        // Explicit null = drop the slot's pin and follow its tier / global default again.
        const inheritConc = body?.max_concurrency === null
        const inheritRpm = body?.max_rpm === null
        const hasSessionSlots = body && Object.prototype.hasOwnProperty.call(body, 'session_slots')
        const hasQuotaOverride = body && Object.prototype.hasOwnProperty.call(body, 'quota_override')
        const hasModels = body && Object.prototype.hasOwnProperty.call(body, 'allowed_models')
        const hasAuthScheme = body && (body.auth_scheme != null || body.authScheme != null)
        const hasScheduleLevel = body && Object.prototype.hasOwnProperty.call(body, 'schedule_level')
        const hasTimezone = body && Object.prototype.hasOwnProperty.call(body, 'timezone')
        // `timezone_follow_proxy: true` re-attaches the slot to its exit node's
        // zone, undoing an earlier hand-pinned value.
        const followProxyTz = body?.timezone_follow_proxy === true || body?.timezoneFollowProxy === true
        const hasSlotPolicy =
          body &&
          (Object.prototype.hasOwnProperty.call(body, 'inference_engine') ||
            Object.prototype.hasOwnProperty.call(body, 'persona_preset'))
        if (
          !hasConcurrency &&
          !hasRpm &&
          !inheritConc &&
          !inheritRpm &&
          !hasSessionSlots &&
          !hasMaxSessions &&
          !hasQuotaOverride &&
          !hasModels &&
          !hasAuthScheme &&
          !hasSlotPolicy &&
          !hasScheduleLevel &&
          !hasTimezone &&
          !followProxyTz
        ) {
          return json(res, 400, {
            ok: false,
            error: {
              message:
                'max_concurrency, max_rpm, max_sessions, session_slots, quota_override, allowed_models, auth_scheme, inference_engine, persona_preset, schedule_level, timezone or timezone_follow_proxy required',
            },
          })
        }
        try {
          if (hasConcurrency && next !== null) strictInteger(next, 1, 256, 'max_concurrency')
          if (hasRpm && nextRpm !== null) strictInteger(nextRpm, 0, 1_000_000, 'max_rpm')
          if (hasSessionSlots && body.session_slots !== null)
            strictInteger(body.session_slots, SESSION_SLOT_MIN, SESSION_SLOT_MAX, 'session_slots')
          if (hasMaxSessions && body.max_sessions !== null) strictInteger(body.max_sessions, 0, 256, 'max_sessions')
        } catch (error) {
          return json(res, 400, {
            ok: false,
            error: { code: 'invalid_scheduling_value', message: error.message },
          })
        }
        const parsedScheduleLevel = hasScheduleLevel ? parseScheduleLevelInput(body.schedule_level) : null
        if (parsedScheduleLevel && !parsedScheduleLevel.ok) {
          return json(res, 400, { ok: false, error: { message: parsedScheduleLevel.error } })
        }
        const parsedQuotaOverride = hasQuotaOverride ? parseVmQuotaOverride(body.quota_override) : null
        if (parsedQuotaOverride && !parsedQuotaOverride.ok) {
          return json(res, 400, { ok: false, error: { message: parsedQuotaOverride.error } })
        }
        if (parsedQuotaOverride) {
          if (isCodexVm(currentVm)) {
            return json(res, 400, {
              ok: false,
              error: { code: 'gpt_quota_override_forbidden', message: 'GPT slots do not use Claude quota tiers' },
            })
          }
        }
        if (hasSessionSlots && isCodexVm(currentVm)) {
          return json(res, 400, {
            ok: false,
            error: { code: 'gpt_session_slots_forbidden', message: 'GPT slots do not use native session slots' },
          })
        }
        if (hasMaxSessions && !isCodexVm(currentVm)) {
          return json(res, 400, {
            ok: false,
            error: { code: 'claude_max_sessions_forbidden', message: 'Claude 槽不使用 OpenAI 会话容量上限' },
          })
        }
        if (hasAuthScheme && hostUnsupported(res, currentVm, 'auth_scheme')) return
        if (
          hasSlotPolicy &&
          Object.prototype.hasOwnProperty.call(body, 'inference_engine') &&
          (isCodexVm(currentVm) || hostUnsupported(res, currentVm, 'engine_switch'))
        ) {
          if (isCodexVm(currentVm)) {
            return json(res, 400, {
              ok: false,
              error: { code: 'gpt_engine_forbidden', message: 'GPT slots do not use go or rust inference engines' },
            })
          }
          return
        }
        if (hasModels) {
          const parsed = parseAllowedModelsPatch(body.allowed_models, { vm: currentVm })
          if (!parsed.ok) return json(res, 400, { ok: false, error: { message: parsed.error } })
        }
        if (hasSlotPolicy) {
          const parsed = parseSlotEnginePolicyPatch(body)
          if (!parsed.ok) return json(res, 400, { ok: false, error: { message: parsed.error } })
        }
        let timezoneSync = null
        if (hasTimezone) {
          // Any IANA zone is allowed — the US presets are UI defaults, not a
          // whitelist. Reject only what Intl (and therefore the container TZ)
          // cannot resolve, so a typo never reaches `docker run -e TZ=`.
          const zone = validTimezone(body.timezone)
          if (!zone) {
            return json(res, 400, {
              ok: false,
              error: {
                type: 'invalid_request_error',
                code: 'invalid_timezone',
                message: '时区必须是有效的 IANA 名称，如 Asia/Tokyo',
                param: 'timezone',
              },
            })
          }
          timezoneSync = { timezone: zone, source: 'manual' }
        } else if (followProxyTz) {
          const synced = await syncVmTimezoneFromProxy(cfg.paths.project, proxyPool, id, {
            force: true,
            persist: false,
          })
          if (!synced.ok) {
            return json(res, 400, {
              ok: false,
              error: {
                type: 'invalid_request_error',
                code: synced.reason || 'proxy_timezone_unknown',
                message: '未能从代理节点取到时区，请先检测代理地理位置',
              },
            })
          }
          timezoneSync = { applied: false, timezone: synced.timezone, source: 'proxy_geo' }
        }
        if (hasConcurrency && next !== null) {
          const vm = applyVmConcurrency(id, next, { override: true })
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        if (hasRpm && nextRpm !== null) {
          const vm = applyVmRpm(id, nextRpm, { override: true })
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        if ((hasConcurrency && next === null) || (hasRpm && nextRpm === null)) {
          const vm = inheritVmScheduling(id, {
            concurrency: hasConcurrency && next === null,
            rpm: hasRpm && nextRpm === null,
          })
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        if (hasSessionSlots) {
          if (body.session_slots === null) {
            inheritVmScheduling(id, { sessionSlots: true })
          } else {
            const vm = applyVmSessionSlots(id, normalizeSessionSlots(body.session_slots), { override: true })
            if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
          }
        }
        if (hasMaxSessions) {
          if (body.max_sessions === null) {
            const vm = inheritVmScheduling(id, { maxSessions: true })
            if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
          } else {
            const vm = ctx.applyVmMaxSessions(id, body.max_sessions, { override: true })
            if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
          }
        }
        if (parsedQuotaOverride) {
          const vm = applyVmQuotaOverride(id, parsedQuotaOverride.value)
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        if (hasModels) {
          const parsed = parseAllowedModelsPatch(body.allowed_models, { vm: currentVm })
          const vm = persistAllowedModels(cfg.paths.project, id, parsed.value)
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        if (hasAuthScheme) {
          const vm = persistSlotAuthScheme(cfg.paths.project, id, body.auth_scheme || body.authScheme)
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        let slotPolicyResult = null
        if (hasSlotPolicy) {
          const parsed = parseSlotEnginePolicyPatch(body)
          slotPolicyResult = await applySlotPolicyWithRuntime(id, parsed.patch)
          if (!slotPolicyResult.ok) {
            const status =
              slotPolicyResult.code === 'vm_not_found'
                ? 404
                : slotPolicyResult.code === 'gpt_engine_forbidden'
                  ? 400
                  : 503
            return json(res, status, {
              ok: false,
              error: {
                code: slotPolicyResult.code,
                message: slotPolicyResult.error || 'inference engine switch failed',
              },
            })
          }
        }
        if (parsedScheduleLevel) {
          const vm = persistVmScheduleLevel(cfg.paths.project, id, parsedScheduleLevel.value)
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        if (hasTimezone) {
          const vm = persistVmTimezone(cfg.paths.project, id, timezoneSync.timezone, { source: 'manual' })
          if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
          const kernel = projectSlotKernelConfig(vm)
          timezoneSync.applied = true
          timezoneSync.kernel_hot = kernel?.changed === true
        } else if (followProxyTz) {
          const synced = await syncVmTimezoneFromProxy(cfg.paths.project, proxyPool, id, { force: true })
          timezoneSync = { applied: synced.applied, timezone: synced.timezone, source: 'proxy_geo' }
          if (synced.applied) {
            const kernel = projectSlotKernelConfig({ id })
            timezoneSync.kernel_hot = kernel?.changed === true
          }
        }
        const detail = await panel.buildVmDetail({
          cfg,
          accountQuota,
          id,
          routingConfig: ctx.routingConfig,
          poolScheduler: ctx.poolScheduler,
          requestLog,
          proxyPool,
          kernelHealth: panelKernelHealth,
        })
        if (slotPolicyResult && detail?.data) {
          detail.data.engine_switch = {
            configured_engine: slotPolicyResult.configured_engine,
            resolved_engine: slotPolicyResult.resolved_engine,
            active_engine: slotPolicyResult.active_engine,
            runtime: slotPolicyResult.runtime,
          }
        }
        if (timezoneSync && detail?.data) detail.data.timezone_sync = timezoneSync
        return json(res, 200, detail)
      }
      // POST /api/panel/vms/:id/probe
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/probe$/.test(p)) {
        const id = p.split('/')[4]
        const result = await panel.buildProbeOne({
          cfg,
          accountQuota,
          id,
          hop: true,
          force: true,
          routingConfig: ctx.routingConfig,
        })
        if (result.status) return json(res, result.status, result.body)
        return json(res, 200, result)
      }
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/openai-quota\/refresh$/.test(p)) {
        const id = p.split('/')[4]
        const result = await panel.buildOpenaiQuotaRefresh({ cfg, id, routingConfig: ctx.routingConfig })
        if (result.status) return json(res, result.status, result.body)
        return json(res, 200, result)
      }
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/openai-quota\/reset$/.test(p)) {
        const id = p.split('/')[4]
        const result = await panel.buildOpenaiQuotaReset({ cfg, id, routingConfig: ctx.routingConfig })
        if (result.status) return json(res, result.status, result.body)
        return json(res, 200, result)
      }
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/claude-reset\/query$/.test(p)) {
        const id = p.split('/')[4]
        const result = await panel.buildClaudeResetQuery({ cfg, id })
        if (result.status) return json(res, result.status, result.body)
        return json(res, 200, result)
      }
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/claude-reset\/redeem$/.test(p)) {
        const id = p.split('/')[4]
        const result = await panel.buildClaudeResetRedeem({
          cfg,
          id,
          idempotencyKey: req.headers['idempotency-key'],
        })
        if (result.status) return json(res, result.status, result.body)
        return json(res, 200, result)
      }

      // POST /api/panel/vms/:id/test-chat — sub2api-style model connectivity test
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/test-chat$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readBody(req, 64 * 1024).catch(() => ({}))
        const result = await runVmTestChat({
          projectRoot: cfg.paths.project,
          vmId: id,
          model: body.model || body.model_id || '',
          prompt: body.prompt || body.message || '',
          max_tokens: body.max_tokens,
          reasoning_effort: body.reasoning_effort || body.effort,
          timeoutMs: body.timeout_ms || body.timeoutMs,
          baseUrl: `http://127.0.0.1:${cfg.port}`,
          apiKey: cfg.api_key,
          accountQuota,
        })
        return json(res, 200, panel.ok(result))
      }
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/count-tokens$/.test(p)) {
        const id = p.split('/')[4]
        const vm = getVm(cfg.paths.project, id)
        if (!vm) return json(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'vm not found' } })
        const mode = credentialModeOfVm(vm)
        if (!isAnySetupTokenMode(mode) && !isApiKeyMode(mode)) {
          return json(res, 400, {
            ok: false,
            error: {
              code: 'count_tokens_unsupported',
              message: 'count_tokens 只支持 Setup Token / Console API Key，完整 OAuth 走 Claude Code Messages usage',
            },
          })
        }
        const exec = workerExecForVm(id)
        if (!exec) return json(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'vm not found' } })
        const reqBody = await readBody(req, 256 * 1024).catch(() => ({}))
        const model = String(reqBody.model || reqBody.model_id || '').trim()
        const messages = Array.isArray(reqBody.messages) ? reqBody.messages : null
        if (!model || !messages?.length) {
          return json(res, 400, {
            ok: false,
            error: { code: 'invalid_request', message: 'model 与 messages 必填' },
          })
        }
        const anthropicBody = { model, messages }
        if (reqBody.system != null) anthropicBody.system = reqBody.system
        if (Array.isArray(reqBody.tools)) anthropicBody.tools = reqBody.tools
        const hop = await countTokensViaWorker(exec, {
          body: anthropicBody,
          headers: {
            'user-agent': 'kin-inference/1.0',
            'anthropic-version': '2023-06-01',
            'anthropic-beta': isApiKeyMode(mode) ? apiKeyBetaHeader('') : setupTokenBetaHeader(model),
          },
          timeoutMs: Math.min(Math.max(Number(reqBody.timeout_ms || reqBody.timeoutMs) || 45000, 5000), 120000),
        })
        if (!hop.ok) {
          const err = hop.body?.error || {}
          return json(res, hop.status || 502, {
            ok: false,
            error: {
              code: err.code || 'count_tokens_failed',
              message: err.message || 'count_tokens 失败',
              type: err.type || undefined,
            },
          })
        }
        return json(
          res,
          200,
          panel.ok({
            vm_id: id,
            model,
            credential_mode: mode,
            input_tokens: Number(hop.body?.input_tokens) || 0,
            usage: hop.body || null,
            via: hop.via,
          }),
        )
      }
      // GET /api/panel/test-models — models available for test dropdown
      if (req.method === 'GET' && p === '/api/panel/test-models') {
        const platform = url.searchParams.get('platform') || url.searchParams.get('kind') || ''
        const vmId = url.searchParams.get('vm_id') || url.searchParams.get('vm') || ''
        const refresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true'
        const payload = await resolveTestModels({
          projectRoot: cfg.paths.project,
          vmId,
          platform,
          refresh,
        })
        return json(res, 200, panel.ok(payload))
      }

      // POST /api/panel/vms/:id/schedulable — sub2api-style schedule toggle
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/schedulable$/.test(p)) {
        const id = p.split('/')[4]
        if (!getVm(cfg.paths.project, id)) {
          const e = makeError({
            type: ErrorType.NOT_FOUND,
            code: ErrorCode.VM_NOT_FOUND,
            message: 'vm not found',
            status: 404,
          })
          return json(res, e.status, { ok: false, error: e.body.error })
        }
        const body = await readBody(req, 8192).catch(() => ({}))
        if (typeof body?.schedulable !== 'boolean') {
          return json(res, 400, { ok: false, error: { message: 'schedulable required' } })
        }
        const currentVm = getVm(cfg.paths.project, id)
        const credentialFailure =
          /oauth_revoked|oauth_invalid_grant|invalid_grant|refresh_token_missing|token has been revoked/i.test(
            `${currentVm?.claude?.refresh_error || ''} ${currentVm?.schedule_disabled_reason || ''}`,
          )
        if (body.schedulable && credentialFailure) {
          return json(res, 409, {
            ok: false,
            error: { code: 'credential_unavailable', message: '凭证已失效或吊销，请重新导入凭证后再开启调度' },
          })
        }
        const reason = body.schedulable ? null : body.reason || 'disabled'
        const summary = setVmSchedulable(cfg.paths.project, id, body.schedulable, reason, {
          preserveStatus: true,
          source: 'manual',
        })
        return json(
          res,
          200,
          panel.ok({
            id,
            schedulable: summary?.schedulable !== false,
            schedule_manual: summary?.schedule_manual === true,
            schedule_disabled_reason: summary?.schedule_disabled_reason || null,
            status: summary?.status || null,
          }),
        )
      }
      // POST /api/panel/vms/:id/cooldown/clear — drop 401/quota leftover so the slot re-enters
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/cooldown\/clear$/.test(p)) {
        const id = p.split('/')[4]
        const result = panel.clearVmCooldown({
          cfg,
          accountQuota,
          stickyRouter,
          poolScheduler: ctx.poolScheduler,
          id,
        })
        if (result.status) return json(res, result.status, result.body)
        return json(res, 200, result)
      }
      // POST /api/panel/vms/:id/circuit/reset — close a tripped Claude unit circuit
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/circuit\/reset$/.test(p)) {
        const id = decodeURIComponent(p.split('/')[4])
        const result = panel.resetVmCircuit({ cfg, poolScheduler: ctx.poolScheduler, id })
        if (result.status) return json(res, result.status, result.body)
        return json(res, 200, result)
      }
      // POST /api/panel/vms/:id/activate
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/activate$/.test(p)) {
        const id = p.split('/')[4]
        if (!getVm(cfg.paths.project, id)) {
          const e = makeError({
            type: ErrorType.NOT_FOUND,
            code: ErrorCode.VM_NOT_FOUND,
            message: 'vm not found',
            status: 404,
          })
          return json(res, e.status, { ok: false, error: e.body.error })
        }
        return json(res, 200, panel.ok(activateVmSlot(id)))
      }

      // POST /api/panel/vms/:id/update-claude-code — Claude CLI runtime was removed
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/update-claude-code$/.test(p)) {
        return json(res, 410, {
          ok: false,
          error: {
            code: 'claude_cli_removed',
            message: 'Claude CLI runtime was replaced by the Go slot worker; build and roll out the worker instead',
          },
        })
      }

      // DELETE /api/panel/vms/:id — remove VM record, cli-home, unbind proxy
      if (req.method === 'DELETE' && /^\/api\/panel\/vms\/[^/]+$/.test(p)) {
        const id = p.split('/')[4]
        if (!isValidVmId(id)) {
          return json(res, 400, { ok: false, error: { message: 'invalid vm id' } })
        }
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        const active = getActiveVmId(cfg.paths.project)
        if (active === id) {
          return json(res, 409, { ok: false, error: { message: 'cannot delete active VM, switch active first' } })
        }
        const vm = getVm(cfg.paths.project, id)
        if (denyIfUserCannotDeleteVm(req, res, vm, json)) return true
        try {
          if (vm) {
            const gone = await destroySlot(vm)
            // A node slot that could not be removed keeps running there with the account's credential.
            if (!gone.ok && slotHost(vm).kind === 'node') {
              return json(res, 409, {
                ok: false,
                error: { code: gone.code || 'remote_destroy_failed', message: gone.error || 'remote destroy failed' },
              })
            }
          }
        } catch {}
        // detach this VM only — do not unbind other slots sharing the SOCKS5
        try {
          proxyPool.unbindVm(id)
        } catch {}
        // remove cli-home
        try {
          fs.rmSync(path.join(cfg.paths.project, 'vms', id), { recursive: true, force: true })
        } catch {}
        fs.unlinkSync(vmPath)
        // drop the DB credential mirror row too
        try {
          removeVmFromDb(id)
        } catch {}
        // optional chat side files
        try {
          const chat = path.join(cfg.paths.project, 'vms', `${id}-chat.json`)
          if (fs.existsSync(chat)) fs.unlinkSync(chat)
        } catch {}
        return json(res, 200, panel.ok({ deleted: id }))
      }
      // POST /api/panel/vms/:id/reset — destroy container + home, recreate same slot
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/reset$/.test(p)) {
        const id = p.split('/')[4]
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        await readBody(req, 32 * 1024).catch(() => ({}))
        return await withVmLock(vmPath, async () => {
          if (!fs.existsSync(vmPath)) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
          const prev = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
          const gone = await destroySlot(prev)
          if (!gone.ok) {
            return json(res, 500, { ok: false, error: { message: gone.error || 'destroy failed', code: gone.code } })
          }
          const { vm } = recreateVmFiles(cfg.paths.project, prev)
          try {
            invalidateLiveCredentialCache()
          } catch {}
          if (!hasBoundExit(vm.proxy)) {
            try {
              const allocated = proxyPool.allocateForVm(id)
              if (allocated) {
                bindVmProxy(cfg.paths.project, id, proxyPool.getProxyForVm(id))
                const bound = getVm(cfg.paths.project, id)
                if (bound?.proxy) vm.proxy = bound.proxy
              }
            } catch {}
          }
          if (!hasBoundExit(vm.proxy)) {
            vm.status = 'stopped'
            vm.schedulable = false
            vm.schedule_disabled_reason = 'slot SOCKS5 proxy is required'
            atomicWriteJson(vmPath, vm, { mode: 0o600 })
            return json(res, 409, {
              ok: false,
              error: { code: 'proxy_required', message: 'No healthy SOCKS5 is available for this VM' },
              vm: summarizeVm(vm, cfg.paths.project, ctx.routingConfig),
              destroyed: gone.action,
            })
          }
          const boot = await startSlotReady(vm, cfg.paths.project, { recreate: true, routing: ctx.routingConfig })
          if (!boot.ok) {
            vm.status = 'stopped'
            vm.schedulable = false
            vm.schedule_disabled_reason = boot.error || 'runtime start failed'
            vm.updated_at = new Date().toISOString()
            atomicWriteJson(vmPath, vm, { mode: 0o600 })
            if (gone.action !== 'absent') {
              return json(res, 500, {
                ok: false,
                error: { message: boot.error || 'runtime start failed', code: boot.code },
                vm: summarizeVm(vm, cfg.paths.project, ctx.routingConfig),
                destroyed: gone.action,
              })
            }
            return json(
              res,
              200,
              panel.ok({
                vm: summarizeVm(vm, cfg.paths.project, ctx.routingConfig),
                destroyed: gone.action,
                recreated: true,
                runtime: panel.publicSlotBoot(boot),
              }),
            )
          }
          vm.status = 'running'
          vm.schedulable = false
          vm.schedule_disabled_reason = 'no_credential'
          vm.updated_at = new Date().toISOString()
          atomicWriteJson(vmPath, vm, { mode: 0o600 })
          return json(
            res,
            200,
            panel.ok({
              vm: summarizeVm(getVm(cfg.paths.project, id) || vm),
              destroyed: gone.action,
              recreated: true,
              boot: panel.publicSlotBoot(boot),
            }),
          )
        })
      }

      // POST /api/panel/vms/:id/reset-fingerprint
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/reset-fingerprint$/.test(p)) {
        const id = p.split('/')[4]
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) {
          return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        let vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        const generated = generateWorkstationFingerprint(
          { id: vm.id, kernel: vm.kernel },
          { taken: takenFingerprintKeys(listVms(cfg.paths.project), { exceptId: id }) },
        )
        vm.timezone = generated.timezone
        vm.locale = generated.locale
        vm.fingerprint = applyGeneratedFingerprint({}, generated)
        vm.updated_at = generated.reset_at
        atomicWriteJson(vmPath, vm, { mode: 0o600 })
        writeGuestMachineIdFile(cfg.paths.project, id, generated.guest_machine_id)
        applyOfficialFingerprintToVm(vmPath, path.join(cfg.paths.project, 'vms', id, 'cli-home'))
        try {
          vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        } catch {}
        return json(res, 200, panel.ok({ id, fingerprint: vm.fingerprint }))
      }
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/reconcile-fingerprint$/.test(p)) {
        const id = p.split('/')[4]
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) {
          return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        }
        const result = applyOfficialFingerprintToVm(vmPath, officialCcHome(cfg.paths.project, id))
        const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        return json(
          res,
          200,
          panel.ok({
            vm_id: id,
            ...result,
            identity_source: vm.fingerprint?.identity_source || null,
            has_official_user: !!vm.fingerprint?.official_user_id,
            has_official_machine: !!vm.fingerprint?.official_machine_id,
          }),
        )
      }

      // GET /api/panel/vms/:id/seed-settings
      if (req.method === 'GET' && /^\/api\/panel\/vms\/[^/]+\/seed-settings$/.test(p)) {
        const id = p.split('/')[4]
        const vm = getVm(cfg.paths.project, id)
        if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        const homeDir = path.join(cfg.paths.project, 'vms', id, 'cli-home')
        let settings_json = null
        let kin_seed = null
        try {
          settings_json = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8'))
        } catch {}
        try {
          kin_seed = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude', 'kin-seed.json'), 'utf8'))
        } catch {}
        return json(
          res,
          200,
          panel.ok({
            vm_id: id,
            seed_policy: defaultSeedPolicy(vm.seed_policy || {}),
            ...seedTelemetryContract(defaultSeedPolicy(vm.seed_policy || {})),
            settings_json,
            kin_seed,
            cli_home: homeDir,
          }),
        )
      }
      // PUT /api/panel/vms/:id/seed-settings
      if (req.method === 'PUT' && /^\/api\/panel\/vms\/[^/]+\/seed-settings$/.test(p)) {
        const id = p.split('/')[4]
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        const body = await readBody(req, 256 * 1024)
        const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        const telemetryWasOff = !isTelemetryEnabled(vm.seed_policy || {})
        const merged = { ...(vm.seed_policy || {}), ...(body.seed_policy || {}) }
        for (const k of ['telemetry_disabled', 'reject_client_settings', 'reject_client_metadata_identity']) {
          if (body[k] !== undefined) merged[k] = !!body[k]
        }
        if (body.theme !== undefined) merged.theme = body.theme
        if (body.extra_env !== undefined) merged.extra_env = body.extra_env
        if (body.settings_json_override !== undefined) merged.settings_json_override = body.settings_json_override
        const next = defaultSeedPolicy(merged)
        if (body.settings_json_override !== undefined) next.settings_json_override = body.settings_json_override
        if (body.extra_env !== undefined) next.extra_env = body.extra_env || {}
        vm.seed_policy = next
        vm.updated_at = new Date().toISOString()
        atomicWriteJson(vmPath, vm, { mode: 0o600 })
        const written = writeSlotSeedFiles(cfg.paths.project, vm, next)
        if (next.telemetry_disabled === false && telemetryWasOff) {
          try {
            await reloadSlotReady(vm, cfg.paths.project, { routing: ctx.routingConfig })
          } catch {}
        }
        return json(
          res,
          200,
          panel.ok({
            vm_id: id,
            seed_policy: next,
            ...seedTelemetryContract(next),
            settings_json: written.settings || null,
            kin_seed: written.kin_seed || null,
          }),
        )
      }

      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/wrap-cli\/promote$/.test(p)) {
        const id = p.split('/')[4]
        const vm = getVm(cfg.paths.project, id)
        if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        if (hostUnsupported(res, vm, 'wrap_cli')) return
        const captured = captureWrapSample(cfg.paths.project, vm)
        if (!captured.ok) return json(res, 400, { ok: false, error: { code: captured.code, message: captured.error } })
        return json(res, 200, panel.ok(captured))
      }
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/wrap-cli\/repair$/.test(p)) {
        const id = p.split('/')[4]
        const vm = getVm(cfg.paths.project, id)
        if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        if (hostUnsupported(res, vm, 'wrap_cli')) return
        const wrap = materializeWrapCli(cfg.paths.project, vm)
        if (!wrap.ok) return json(res, 400, { ok: false, error: { code: wrap.code, message: wrap.error } })
        writeKernelConfig(cfg.paths.project, vm, { routing: ctx.routingConfig })

        let kernel = { ok: false, skipped: true, reason: 'engine_not_rust' }
        if (resolveInferenceEngine(vm, ctx.routingConfig) === 'rust') {
          kernel = await restartRustKernel(slotExec(cfg.paths.project, vm))
        }

        return json(res, 200, panel.ok({ wrap, kernel }))
      }

      if (req.method === 'GET' && /^\/api\/panel\/vms\/[^/]+\/official-cc-bootstrap$/.test(p)) {
        const id = p.split('/')[4]
        const vm = getVm(cfg.paths.project, id)
        if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        return json(
          res,
          200,
          panel.ok({
            vm_id: id,
            status: readOfficialCcStatus(officialCcHome(cfg.paths.project, id)),
          }),
        )
      }
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/official-cc-bootstrap$/.test(p)) {
        const id = p.split('/')[4]
        const vm = getVm(cfg.paths.project, id)
        if (!vm) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        if (hostUnsupported(res, vm, 'official_cc')) return
        if (!canOfficialCc(vm.claude?.mode)) {
          return json(res, 400, {
            ok: false,
            error: { code: 'credential_mode_unsupported', message: '官方初装只支持完整 OAuth' },
          })
        }
        const body = await readBody(req, 8 * 1024)
        const scheduled = scheduleOfficialCcBootstrap({
          vmId: id,
          projectRoot: cfg.paths.project,
          force: body.force !== false,
          collectIdentity: collectSlotIdentity,
          onStats: officialCcStatsHandler(id, vm.claude?.account_uuid),
          routingFile: routingConfigPath,
          config: ctx.routingConfig.official_cc,
          credentialMode: vm.claude?.mode,
          vm,
          manual: true,
        })
        return json(
          res,
          200,
          panel.ok({
            vm_id: id,
            ...scheduled,
            status: readOfficialCcStatus(officialCcHome(cfg.paths.project, id)),
          }),
        )
      }

      if (req.method === 'GET' && /^\/api\/panel\/vms\/[^/]+\/package$/.test(p)) {
        const id = p.split('/')[4]
        const result = exportVmPackage(cfg.paths.project, id, proxyPool)
        if (!result.ok) return json(res, result.status || 404, { ok: false, error: result.error })
        return json(res, 200, panel.ok(result.package))
      }
      if (req.method === 'PUT' && /^\/api\/panel\/vms\/[^/]+\/package$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readBody(req, 256 * 1024).catch(() => null)
        const result = await commitVmPackage({
          projectRoot: cfg.paths.project,
          parsed: parseVmPackage(body),
          mode: 'update',
          targetId: id,
          owner: { role: panelIdentity(req).role, userId: req.panelUserId },
          proxyPool,
        })
        if (!result.ok) return json(res, result.status, { ok: false, error: result.error })
        await fillTimezoneFromExit(id)
        let worker = null
        // The package may swap credentials or exit; a running worker keeps the old ones until reloaded.
        if (ctx.packageImportBringUp !== false && result.vm.status === 'running' && process.env.KIN_CRS_MOCK !== '1') {
          setVmSchedulable(cfg.paths.project, id, false, 'package_update_worker_reload')
          worker = await reloadSlotReady(getVm(cfg.paths.project, id), cfg.paths.project, {
            routing: ctx.routingConfig,
          })
          if (worker.ok) restoreSchedulableIfReady(id)
        }
        const saved = getVm(cfg.paths.project, id) || result.vm
        return json(
          res,
          200,
          panel.ok({
            vm: summarizeVm(saved, cfg.paths.project, ctx.routingConfig),
            worker_reload: worker ? { ok: !!worker.ok, error: worker.ok ? null : worker.error || null } : null,
          }),
        )
      }
      if (req.method === 'POST' && p === '/api/panel/vms/package') {
        const body = await readBody(req, 256 * 1024).catch(() => null)
        const parsed = parseVmPackage(body)
        const ident = panelIdentity(req)
        if (parsed.ok && ident.role === 'user') {
          const ownerId = normalizeOwnerId(req.panelUserId)
          const quota = clampVmCreateQuota(panelUsers.getById(ownerId)?.vm_create_quota, 0)
          const used = countUserCreatedVms(listVms(cfg.paths.project), ownerId)
          if (!ownerId || quota <= 0 || used >= quota) {
            return json(res, 403, {
              ok: false,
              error: { code: 'vm_create_quota_exceeded', message: '自建虚拟机数量已达上限' },
            })
          }
        }
        const historic = (accountQuota?.snapshot?.().accounts || []).flatMap((a) => [
          { id: a.vm_id },
          { id: a.account_id },
        ])
        const result = await commitVmPackage({
          projectRoot: cfg.paths.project,
          parsed,
          mode: 'create',
          owner: { role: ident.role, userId: req.panelUserId },
          proxyPool,
          occupied: historic,
        })
        if (!result.ok) return json(res, result.status, { ok: false, error: result.error })
        await fillTimezoneFromExit(result.vm.id)
        const brought =
          ctx.packageImportBringUp === false
            ? { start_error: null, official_cc_bootstrap: null, probe: null }
            : await bringUpImportedVm(result.vm.id)
        const saved = getVm(cfg.paths.project, result.vm.id) || result.vm
        return json(
          res,
          result.status,
          panel.ok({
            vm: summarizeVm(saved, cfg.paths.project, ctx.routingConfig),
            renamed_from: result.renamed_from,
            start_error: brought.start_error,
            official_cc_bootstrap: brought.official_cc_bootstrap,
            probe: brought.probe,
          }),
        )
      }

      // POST /api/panel/vms/create — configurable seed VM + pure Claude Code home
      if (req.method === 'POST' && p === '/api/panel/vms/create') {
        const body = await readBody(req, 32 * 1024)
        const existing = listVms(cfg.paths.project)
        // Usage, billing and account rows stay keyed by a deleted VM's id; handing that
        // id to a new slot makes it show the old account and spend. Auto-numbering skips them.
        const historic = (accountQuota?.snapshot?.().accounts || []).flatMap((a) => [
          { id: a.vm_id },
          { id: a.account_id },
        ])
        const idx = nextNumericIndex([...existing, ...historic])
        const rawId = body.id || 'vm-' + padVm(idx)
        const id = String(rawId).replace(/[^a-zA-Z0-9_-]/g, '')
        if (!isValidVmId(id)) return json(res, 400, { ok: false, error: { message: 'invalid id' } })
        const vmsDir = path.join(cfg.paths.project, 'vms')
        fs.mkdirSync(vmsDir, { recursive: true })
        const vmPath = path.join(vmsDir, id + '.json')
        if (fs.existsSync(vmPath)) {
          return json(res, 409, { ok: false, error: { message: 'vm id exists' } })
        }
        const ident = panelIdentity(req)
        if (ident.role === 'user') {
          const ownerId = normalizeOwnerId(req.panelUserId)
          const quota = clampVmCreateQuota(panelUsers.getById(ownerId)?.vm_create_quota, 0)
          const used = countUserCreatedVms(existing, ownerId)
          if (!ownerId || quota <= 0 || used >= quota) {
            return json(res, 403, {
              ok: false,
              error: { code: 'vm_create_quota_exceeded', message: '自建虚拟机数量已达上限' },
            })
          }
        }
        const startNow = body.start !== false && body.status !== 'stopped'
        const wantKernel = body.kernel && OS_CATALOG[body.kernel] ? body.kernel : kernelForIndex(idx)
        const nodeId = body.node_id ? String(body.node_id) : null
        const vmDefaults = normalizeVmConfig(ctx.routingConfig?.vm)
        const requestedRuntime = body.runtime_type
        let runtime
        if (requestedRuntime == null || requestedRuntime === '') {
          runtime = vmDefaults.default_runtime
        } else {
          const kind = String(requestedRuntime).trim().toLowerCase()
          if (kind !== 'docker' && kind !== 'kvm') {
            return json(res, 400, {
              ok: false,
              error: {
                type: 'invalid_request_error',
                code: 'invalid_runtime_type',
                message: 'runtime_type 必须是 docker 或 kvm',
              },
            })
          }
          runtime = kind
        }
        let machine
        try {
          machine = resolveMachineSpec({ config: vmDefaults, overrides: body.machine, runtime })
        } catch (error) {
          if (error?.status === 400 || error?.code === 'invalid_machine') {
            return json(res, 400, {
              ok: false,
              error: { type: 'invalid_request_error', code: 'invalid_machine', message: error.message },
            })
          }
          throw error
        }
        if (nodeId) {
          if (ident.role !== 'admin') {
            return json(res, 403, {
              ok: false,
              error: { code: 'placement_forbidden', message: '只有管理员可以把虚拟机放到集群节点' },
            })
          }
          const kindProbe = { node_id: nodeId }
          stampVmKind(kindProbe, body)
          if (isCodexVm(kindProbe) && !slotHost(kindProbe).supports('codex')) {
            return json(res, 400, {
              ok: false,
              error: { code: 'remote_unsupported', message: '集群节点上的虚拟机暂不支持此操作' },
            })
          }
          let preflight
          try {
            preflight = await (ctx.preflightNode || preflightNode)(nodeId, { kernel: wantKernel, runtime })
          } catch (e) {
            return json(res, e?.status || 500, {
              ok: false,
              error: { code: e?.code || 'placement_failed', message: String(e?.message || e) },
            })
          }
          if (!preflight.ok) {
            return json(res, 409, {
              ok: false,
              error: {
                code: 'placement_preflight_failed',
                message: '目标节点预检未通过',
                checks: preflight.checks,
              },
            })
          }
        }
        // An explicit exit (e.g. local egress for a node: that VPS's own route) replaces auto-allocation.
        const pickedProxyId = typeof body.proxy_id === 'string' ? body.proxy_id.trim() : ''
        if (pickedProxyId) {
          const row = proxyPool.snapshot({ nodeId }).proxies.find((proxy) => proxy.id === pickedProxyId)
          const owner = ident.role === 'user' ? normalizeOwnerId(req.panelUserId) : null
          if (!row || !canBindProxyToVm(row, { owner_user_id: owner }, { role: ident.role })) {
            return json(res, 404, {
              ok: false,
              error: { code: 'proxy_not_found', message: '所选出口不存在或不能绑到此槽位' },
            })
          }
          const used = Array.isArray(row.bound_vm_ids) ? row.bound_vm_ids.length : 0
          if (!row.enabled || row.status === 'dead' || row.blocked_reason || used >= (row.bind_limit || 5)) {
            return json(res, 409, {
              ok: false,
              error: { code: 'proxy_unavailable', message: '所选出口已失效或已绑满' },
            })
          }
        }
        if (runtime === RUNTIME_KVM && !nodeId) {
          const probe = typeof ctx.probeLocalKvm === 'function' ? ctx.probeLocalKvm : probeLocalKvm
          const kvm = await probe({ routing: ctx.routingConfig })
          if (!kvm?.ok) {
            return json(res, 409, {
              ok: false,
              error: { code: 'kvm_unavailable', message: kvm?.error || '本机 KVM 不可用' },
            })
          }
        }
        const requestedTimezone = validTimezone(body.timezone)
        const requestedLocale = body.locale == null || body.locale === '' ? STANDARD_LOCALE : String(body.locale)
        if (!SLOT_LOCALES.includes(requestedLocale)) {
          return json(res, 400, {
            ok: false,
            error: { code: 'invalid_locale', message: `语言必须是 ${SLOT_LOCALES.join('、')}` },
          })
        }
        const generated = generateWorkstationFingerprint(
          { id, kernel: wantKernel, timezone: requestedTimezone, locale: requestedLocale },
          { taken: takenFingerprintKeys(existing) },
        )
        const vm = {
          id,
          name: body.name || padVm(idx),
          status: startNow ? 'running' : body.status || 'stopped',
          kernel: wantKernel,
          timezone: requestedTimezone || null,
          // Only an explicit zone is a pin. An empty zone stays unset so the
          // next SOCKS5 bind can write the exit node's detected timezone.
          timezone_source: requestedTimezone ? 'manual' : 'auto',
          locale: generated.locale || STANDARD_LOCALE,
          region: body.region || body.zone || null,
          note: body.note || `${(OS_CATALOG[wantKernel] || {}).pretty || wantKernel} · Go slot worker`,
          proxy: null,
          policy: {
            maxConcurrency: 0,
            concurrencyOverride: false,
            maxRpm: 0,
            rpmOverride: false,
            maxSessions: 0,
            sessionsOverride: false,
            weight: Math.max(1, Math.min(100, Number(body.weight ?? 1))),
            inflight: 0,
          },
          claude: {},
          fingerprint: applyGeneratedFingerprint({}, generated),
          stats: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          schedulable: false,
          schedule_disabled_reason: 'no_credential',
          proxy_cli_enabled: body.proxy_cli_enabled === true,
          proxy_required: false,
          seed_policy: standardSeedPolicy(),
          runtime: { type: runtime },
          machine,
        }
        if (ident.role === 'user') {
          vm.owner_user_id = normalizeOwnerId(req.panelUserId)
          vm.origin = VM_ORIGIN.userCreated
        } else {
          vm.owner_user_id = null
          vm.origin = VM_ORIGIN.platform
        }
        if (nodeId) vm.node_id = nodeId
        stampVmKind(vm, body)
        const openaiPolicy = normalizeOpenAIQuotaPolicy(ctx.routingConfig?.codex?.quota)
        const explicitConcurrency =
          Object.prototype.hasOwnProperty.call(body, 'max_concurrency') ||
          Object.prototype.hasOwnProperty.call(body, 'maxConcurrency')
        const explicitRpm =
          Object.prototype.hasOwnProperty.call(body, 'max_rpm') || Object.prototype.hasOwnProperty.call(body, 'maxRpm')
        const explicitSessions = Object.prototype.hasOwnProperty.call(body, 'max_sessions')
        const readField = (snake, camel) =>
          Object.prototype.hasOwnProperty.call(body, snake) ? body[snake] : body[camel]
        const hasField = (snake, camel) =>
          Object.prototype.hasOwnProperty.call(body, snake) || Object.prototype.hasOwnProperty.call(body, camel)
        const rawConcurrency = readField('max_concurrency', 'maxConcurrency')
        const rawRpm = readField('max_rpm', 'maxRpm')
        const rawSessions = body.max_sessions
        const validInteger = (value, min, max) =>
          typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= min && value <= max
        const invalidCreate = (value, min, max) => value !== null && !validInteger(value, min, max)
        if (isCodexVm(vm)) {
          if (
            (explicitConcurrency && invalidCreate(rawConcurrency, 1, 256)) ||
            (explicitRpm && invalidCreate(rawRpm, 0, 1e6)) ||
            (explicitSessions && invalidCreate(rawSessions, 0, 256))
          ) {
            return json(res, 400, {
              ok: false,
              error: {
                code: 'invalid_create_schedule',
                message: 'OpenAI scheduling values must be finite integers in range',
              },
            })
          }
          vm.policy.maxConcurrency =
            explicitConcurrency && rawConcurrency !== null ? rawConcurrency : openaiPolicy.max_concurrency
          vm.policy.concurrencyOverride = explicitConcurrency && rawConcurrency !== null
          vm.policy.maxRpm = explicitRpm && rawRpm !== null ? rawRpm : openaiPolicy.max_rpm
          vm.policy.rpmOverride = explicitRpm && rawRpm !== null
          vm.policy.maxSessions = explicitSessions && rawSessions !== null ? rawSessions : openaiPolicy.max_sessions
          vm.policy.sessionsOverride = explicitSessions && rawSessions !== null
        } else {
          if (
            (explicitConcurrency && invalidCreate(rawConcurrency, 0, 256)) ||
            (explicitRpm && invalidCreate(rawRpm, 0, 1e6)) ||
            explicitSessions
          ) {
            return json(res, 400, {
              ok: false,
              error: {
                code: 'invalid_create_schedule',
                message: 'Claude scheduling values are invalid or unsupported',
              },
            })
          }
          vm.policy.maxConcurrency = explicitConcurrency
            ? rawConcurrency
            : Number(ctx.routingConfig?.concurrency?.default_max_per_account ?? 2)
          vm.policy.concurrencyOverride = explicitConcurrency
          vm.policy.maxRpm = explicitRpm ? rawRpm : Number(ctx.routingConfig?.concurrency?.default_max_rpm ?? 0)
          vm.policy.rpmOverride = explicitRpm
        }
        atomicWriteJson(vmPath, vm, { mode: 0o600 })
        writeGuestMachineIdFile(cfg.paths.project, id, generated.guest_machine_id)
        try {
          seedFreshCliHome(cfg.paths.project, vm)
        } catch (e) {}
        let allocated = null
        let proxyError = null
        const wantProxy = body.auto_allocate_proxy === true || startNow || !!pickedProxyId
        // px-local 没有 SOCKS URL，但它是合法出口；不要把它当成"未绑定"。
        const hasExit = (v) => !!(v?.proxy?.url || isLocalEgressProxy(v?.proxy))
        if (wantProxy && !hasExit(vm)) {
          if (pickedProxyId) {
            const bound = proxyPool.bind(pickedProxyId, id)
            if (bound.ok) allocated = bound.proxy
            else proxyError = bound.error || 'proxy_bind_failed'
          } else {
            try {
              allocated = proxyPool.allocateForVm(id, {
                ownerUserId: vm.owner_user_id || null,
                role: ident.role,
              })
            } catch (e) {}
          }
          if (allocated) {
            bindVmProxy(cfg.paths.project, id, proxyPool.getProxyForVm(id))
            vm.proxy = getVm(cfg.paths.project, id)?.proxy || vm.proxy
          }
        }
        // vm is written again below; carry the exit's zone so that write keeps it.
        const zoned = await fillTimezoneFromExit(id)
        if (zoned?.applied) {
          vm.timezone = zoned.timezone
          vm.timezone_source = 'proxy_geo'
          if (vm.fingerprint && typeof vm.fingerprint === 'object') vm.fingerprint.timezone = zoned.timezone
        }
        if (body.activate === true) {
          try {
            activateVmSlot(id)
          } catch (e) {}
        }
        let startError = null
        if (startNow && hasExit(vm)) {
          let boot
          try {
            boot = await startSlotReady(vm, cfg.paths.project, { routing: ctx.routingConfig })
          } catch (e) {
            boot = { ok: false, error: String(e?.message || e) }
          }
          if (!boot.ok) {
            // Slot JSON is already on disk. 500 here makes the console treat
            // create as a no-op, so the new row never refetches into the list.
            vm.status = 'error'
            vm.schedulable = false
            vm.schedule_disabled_reason = boot.error || 'runtime start failed'
            vm.updated_at = new Date().toISOString()
            atomicWriteJson(vmPath, vm, { mode: 0o600 })
            startError = boot.error || 'runtime start failed'
          } else {
            vm.status = 'running'
            vm.updated_at = new Date().toISOString()
            atomicWriteJson(vmPath, vm, { mode: 0o600 })
          }
        } else if (startNow) {
          vm.status = 'stopped'
          vm.updated_at = new Date().toISOString()
          atomicWriteJson(vmPath, vm, { mode: 0o600 })
        }
        const saved = getVm(cfg.paths.project, id) || vm
        return json(
          res,
          200,
          panel.ok({
            vm: panel.publicVmBootView(summarizeVm(saved, cfg.paths.project, ctx.routingConfig)),
            allocated_proxy: panel.publicAllocatedProxy(proxyPool, allocated, { nodeId, role: ident.role }),
            ...(startError ? { start_error: startError } : {}),
            ...(proxyError ? { proxy_error: proxyError } : {}),
          }),
        )
      }
      // POST /api/panel/vms/:id/start
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/start$/.test(p)) {
        const id = p.split('/')[4]
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        let vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        const bound = proxyPool.ensureBoundToVm(id, vm.proxy?.id || null)
        if (!bound) {
          return json(res, 409, {
            ok: false,
            error: { code: 'proxy_required', message: 'No SOCKS5 is bound or free for this VM' },
          })
        }
        bindVmProxy(cfg.paths.project, id, bound)
        await fillTimezoneFromExit(id)
        vm = getVm(cfg.paths.project, id) || vm
        const boot = await startSlotReady(vm, cfg.paths.project, { routing: ctx.routingConfig })
        if (!boot.ok) return json(res, 500, { ok: false, error: { message: boot.error || 'runtime start failed' } })
        vm.status = 'running'
        if (vmHasClaudeCredential(vm)) {
          vm.schedulable = true
          vm.schedule_disabled_reason = null
        } else {
          vm.schedulable = false
          vm.schedule_disabled_reason = 'no_credential'
        }
        vm.updated_at = new Date().toISOString()
        atomicWriteJson(vmPath, vm, { mode: 0o600 })
        return json(
          res,
          200,
          panel.ok({
            vm: panel.publicVmBootView(summarizeVm(vm, cfg.paths.project, ctx.routingConfig)),
            allocated_proxy: panel.publicAllocatedProxy(proxyPool, bound, {
              nodeId: vm.node_id || null,
              role: panelIdentity(req).role,
            }),
            runtime: panel.publicRuntimeView(vm.runtime) || GATEWAY_CAPABILITIES.runtime,
            kernel: GATEWAY_CAPABILITIES.kernel,
            boot: panel.publicSlotBoot(boot),
          }),
        )
      }
      // POST /api/panel/vms/:id/stop
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/stop$/.test(p)) {
        const id = p.split('/')[4]
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) return json(res, 404, { ok: false, error: { message: 'vm not found' } })
        const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        const halt = await stopSlot(vm)
        if (!halt.ok) return json(res, 500, { ok: false, error: { message: halt.error || 'runtime stop failed' } })
        vm.status = 'stopped'
        vm.schedulable = false
        vm.schedule_disabled_reason = 'stopped'
        vm.updated_at = new Date().toISOString()
        atomicWriteJson(vmPath, vm, { mode: 0o600 })
        return json(
          res,
          200,
          panel.ok({
            vm: summarizeVm(vm, cfg.paths.project, ctx.routingConfig),
            runtime: panel.publicRuntimeView(vm.runtime) || GATEWAY_CAPABILITIES.runtime,
            kernel: GATEWAY_CAPABILITIES.kernel,
            halt: panel.publicSlotBoot(halt),
          }),
        )
      }

      // POST /api/panel/vms/import
      // workflow: create VM → allocate proxy → import sessionKey (via SOCKS) → start
      if (req.method === 'POST' && p === '/api/panel/vms/import') {
        const body = await readBody(req, 1024 * 1024)
        const sessionKey = body.sessionKey || body.session_key || body.sid || ''
        const accessToken = body.access_token || body.token || ''
        const apiKeyRaw = body.api_key || body.apiKey || ''
        const requestedType = body.type || body.credential_mode || body.scope || ''
        const vmId = body.vm_id || body.id || null
        const exportDoc = body.sub2api || body.account || body
        try {
          if (!vmId) {
            return json(res, 400, { ok: false, error: { message: 'vm_id required (先创建虚拟机)' } })
          }
          const vmPath = path.join(cfg.paths.project, 'vms', `${vmId}.json`)
          if (!fs.existsSync(vmPath)) {
            return json(res, 404, { ok: false, error: { message: 'vm not found, 请先创建种子虚拟机' } })
          }
          const existing = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
          existing.id = existing.id || vmId
          if (isCodexVm(existing)) {
            const parsed = parseCodexImportPayload(body)
            if (!parsed.ok) {
              return json(res, 400, {
                ok: false,
                error: { code: parsed.error || 'invalid_codex_credential', message: parsed.message },
              })
            }
            const account = { ...parsed.account }
            if (!account.access_token && account.refresh_token) {
              const slotProxy = requireSlotProxy(existing, body)
              if (!slotProxy.ok) {
                return json(res, slotProxy.status, {
                  ok: false,
                  error: { code: 'proxy_required', message: slotProxy.message },
                })
              }
              const tok = await refreshCodexAccessToken({
                refreshToken: account.refresh_token,
                proxyUrl: slotProxy.proxyUrl,
              })
              if (!tok.ok) {
                return json(res, 502, {
                  ok: false,
                  error: {
                    code: tok.error || 'refresh_failed',
                    message: 'Refresh Token 换票失败，请检查 RT 或改用 OAuth / 账号文件。',
                  },
                })
              }
              account.access_token = tok.access_token
              account.refresh_token = tok.refresh_token || account.refresh_token
              account.id_token = tok.id_token || account.id_token
              account.expires_at = tok.expires_at || account.expires_at
            }
            const committed = await commitImportedCodexVm({
              cfg,
              vmPath,
              existing,
              account,
              catalogClientVersion: ctx.routingConfig.codex?.catalog_client_version,
              routingConfig: ctx.routingConfig,
            })
            return json(res, 200, panel.ok(committed))
          }

          const slotProxy = requireSlotProxy(existing, body)
          const wantsApiKey =
            looksLikeConsoleApiKey(apiKeyRaw || sessionKey || accessToken) ||
            String(requestedType).toLowerCase() === 'apikey' ||
            String(requestedType).toLowerCase() === 'console'
          if ((sessionKey || wantsApiKey) && !slotProxy.ok) {
            return json(res, slotProxy.status, { ok: false, error: { message: slotProxy.message } })
          }
          const proxyUrl = slotProxy.proxyUrl
          let oauth = null
          if (wantsApiKey) {
            const apiKey = String(apiKeyRaw || sessionKey || accessToken).trim()
            if (!looksLikeConsoleApiKey(apiKey)) {
              return json(res, 400, { ok: false, error: { message: '需要 sk-ant-api03-… Console API Key' } })
            }
            oauth = {
              type: 'apikey',
              mode: 'apikey',
              api_key: apiKey,
              access_token: apiKey,
              base_url: body.base_url || body.baseUrl || 'https://api.anthropic.com',
              source: 'console-api-key',
              auth_scheme: body.auth_scheme || body.authScheme,
            }
          } else if (sessionKey) {
            const inference =
              String(requestedType).toLowerCase() === 'inference' ||
              String(requestedType).toLowerCase() === 'setup-token' ||
              String(requestedType).toLowerCase() === 'setup_token' ||
              String(body.scope || '').toLowerCase() === 'inference'
            oauth = await sessionKeyToOAuth(String(sessionKey).trim(), {
              proxyUrl,
              scope: inference ? 'inference' : 'full',
            })
            if (inference) {
              oauth.type = 'setup-token'
              oauth.mode = 'setup-token'
            }
          } else if (isSub2apiAccountExport(exportDoc)) {
            oauth = sub2apiAccountToOauth(exportDoc, existing)
          } else if (accessToken) {
            const inference =
              String(requestedType).toLowerCase() === 'inference' ||
              String(requestedType).toLowerCase() === 'setup-token' ||
              String(requestedType).toLowerCase() === 'setup_token' ||
              String(body.scope || '').toLowerCase() === 'inference'
            oauth = {
              access_token: String(accessToken).trim(),
              refresh_token: body.refresh_token || null,
              expires_at: body.expires_at || null,
              email: body.email || null,
              account_uuid: body.account_uuid || null,
              org_uuid: body.org_uuid || null,
              scope: body.scope || (inference ? 'user:inference' : null),
              source: body.source || (inference ? 'claude-setup-token' : 'access-token'),
            }
            if (looksLikeOfficialSetupToken(accessToken) || (inference && !String(body.refresh_token || '').trim())) {
              oauth.type = 'official-setup-token'
              oauth.mode = 'official-setup-token'
              oauth.refresh_token = ''
              oauth.scope = 'user:inference'
              oauth.source = body.source || 'claude-setup-token'
              if (!oauth.expires_at) oauth.expires_at = Date.now() + 365 * 24 * 60 * 60 * 1000
            } else if (inference) {
              oauth.type = 'setup-token'
              oauth.mode = 'setup-token'
            }
          } else {
            return json(res, 400, { ok: false, error: { message: 'sessionKey or access_token required' } })
          }
          if (body.auth_scheme || body.authScheme) oauth.auth_scheme = body.auth_scheme || body.authScheme
          if (oauth.access_token && !wantsApiKey) {
            oauth = await enrichOauthIdentity(oauth, { proxyUrl })
          }
          const committed = await commitImportedOauth({
            vmId,
            vmPath,
            existing,
            oauth,
            source: oauth.source || 'sessionKey-cookie-auth',
            name: body.name,
          })
          if (!committed.ok) {
            return json(res, committed.status || 502, { ok: false, error: committed.error })
          }
          return json(
            res,
            200,
            panel.ok({
              vm: summarizeVm(existing, cfg.paths.project, ctx.routingConfig),
              proxy_used: !!proxyUrl,
              oauth_email: existing.claude.email,
              has_refresh: existing.claude.has_refresh,
              official_cc_bootstrap: committed.official_cc_bootstrap || null,
            }),
          )
        } catch (e) {
          const fail = panelImportErrorPayload(e)
          return json(res, fail.status, { ok: false, error: fail.error })
        }
      }

      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/oauth\/generate-auth-url$/.test(p)) {
        const id = p.split('/')[4]
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) {
          return json(res, 404, { ok: false, error: { message: 'vm not found, 请先创建种子虚拟机' } })
        }
        const existing = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        existing.id = existing.id || id
        const body = await readBody(req, 8 * 1024)
        const slotProxy = requireSlotProxy(existing, body)
        if (!slotProxy.ok) {
          return json(res, slotProxy.status, {
            ok: false,
            error: { code: 'proxy_required', message: slotProxy.message },
          })
        }
        try {
          if (isCodexVm(existing)) {
            const generated = generateCodexAuthUrl({
              vmId: id,
              proxyUrl: slotProxy.proxyUrl,
              installationId: existing.device_id || existing.codex?.installation_id,
            })
            const px = existing.proxy || {}
            return json(
              res,
              200,
              panel.ok({
                ...generated,
                proxy_hint: slotProxyHint(px, proxyPool?.labelOf(px.id)),
              }),
            )
          }
          const flavor = body.flavor || body.type || 'cai'
          const generated = generateAuthUrl({
            vmId: id,
            proxyUrl: slotProxy.proxyUrl,
            flavor,
          })
          const px = existing.proxy || {}
          return json(
            res,
            200,
            panel.ok({
              ...generated,
              proxy_hint: slotProxyHint(px, proxyPool?.labelOf(px.id)),
            }),
          )
        } catch (e) {
          return json(res, 400, {
            ok: false,
            error: { code: e.code || 'generate_auth_url_failed', message: String(e.message || e).slice(0, 240) },
          })
        }
      }

      if (req.method === 'GET' && /^\/api\/panel\/vms\/[^/]+\/oauth\/setup-token-session$/.test(p)) {
        const id = p.split('/')[4]
        const session = readSetupTokenSession(cfg.paths.project, id)
        if (!session?.auth_url || session.expired || !session.alive) {
          return json(res, 200, panel.ok({ active: false, vm_id: id }))
        }
        return json(
          res,
          200,
          panel.ok({
            active: true,
            session_id: session.session_id,
            auth_url: session.auth_url,
            expires_at: session.expires_at,
            vm_id: id,
            flavor: SETUP_TOKEN_FLAVOR,
            source: session.source,
            status: session.status,
            error: session.error || null,
            retryable: true,
          }),
        )
      }

      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/oauth\/exchange-code$/.test(p)) {
        const id = p.split('/')[4]
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) {
          return json(res, 404, { ok: false, error: { message: 'vm not found, 请先创建种子虚拟机' } })
        }
        const existing = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        existing.id = existing.id || id
        const body = await readBody(req, 16 * 1024)
        const slotProxy = requireSlotProxy(existing, body)
        if (!slotProxy.ok) {
          return json(res, slotProxy.status, {
            ok: false,
            error: { code: 'proxy_required', message: slotProxy.message },
          })
        }
        try {
          if (isCodexVm(existing)) {
            const oauth = await exchangeCodexAuthCode({
              sessionId: body.session_id || body.sessionId,
              code: body.code || body.auth_code || body.callback || body.callback_url,
              proxyUrl: slotProxy.proxyUrl,
              vmId: id,
            })
            const committed = await commitImportedCodexVm({
              cfg,
              vmPath,
              existing,
              catalogClientVersion: ctx.routingConfig.codex?.catalog_client_version,
              routingConfig: ctx.routingConfig,
              account: {
                access_token: oauth.access_token,
                refresh_token: oauth.refresh_token,
                id_token: oauth.id_token,
                expires_at: oauth.expires_at,
              },
            })
            return json(res, 200, panel.ok({ ...committed, source: oauth.source, flavor: 'codex' }))
          }
          const code = body.code || body.auth_code || ''
          const flavor = body.flavor || body.type || ''
          let oauth = looksLikeOfficialSetupToken(code)
            ? await completeClaudeSetupToken({
                projectRoot: cfg.paths.project,
                vmId: id,
                sessionId: body.session_id || body.sessionId,
                code,
              })
            : await exchangeAuthCode({
                sessionId: body.session_id || body.sessionId,
                code,
                proxyUrl: slotProxy.proxyUrl,
                vmId: id,
              })
          if (looksLikeOfficialSetupToken(code) || oauth.flavor === SETUP_TOKEN_FLAVOR) {
            oauth.type = 'official-setup-token'
            oauth.mode = 'official-setup-token'
          } else if (
            normalizeOauthFlavor(flavor) === 'setup_token' ||
            oauth.flavor === 'setup_token' ||
            oauth.flavor === 'setup-token'
          ) {
            oauth.type = 'setup-token'
            oauth.mode = 'setup-token'
          }
          if (body.auth_scheme || body.authScheme) oauth.auth_scheme = body.auth_scheme || body.authScheme
          if (oauth.access_token) {
            oauth = await enrichOauthIdentity(oauth, { proxyUrl: slotProxy.proxyUrl })
          }
          const committed = await commitImportedOauth({
            vmId: id,
            vmPath,
            existing,
            oauth,
            source: oauth.source || 'oauth-auth-url',
            name: body.name,
          })
          if (!committed.ok) {
            return json(res, committed.status || 502, { ok: false, error: committed.error })
          }
          return json(
            res,
            200,
            panel.ok({
              vm: summarizeVm(existing, cfg.paths.project, ctx.routingConfig),
              proxy_used: !!slotProxy.proxyUrl,
              oauth_email: existing.claude?.email,
              has_refresh: existing.claude?.has_refresh,
              official_cc_bootstrap: committed.official_cc_bootstrap || null,
              source: oauth.source || 'oauth-auth-url',
              flavor: oauth.flavor || null,
            }),
          )
        } catch (e) {
          const status =
            e.code === 'session_expired' || e.code === 'session_vm_mismatch' || e.code === 'code_required' ? 400 : 502
          return json(res, status, {
            ok: false,
            error: { code: e.code || 'exchange_code_failed', message: String(e.message || e).slice(0, 240) },
          })
        }
      }

      if (req.method === 'GET' && /^\/api\/panel\/vms\/[^/]+\/oauth\/credential$/.test(p)) {
        const id = p.split('/')[4]
        const vm = getVm(cfg.paths.project, id)
        if (!vm) return json(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'VM not found' } })
        const homeDir = path.join(cfg.paths.project, 'vms', id, 'cli-home')
        const cred = readWorkerCredentialFile(homeDir)
        return json(
          res,
          200,
          panel.ok({
            vm_id: id,
            has_token: !!(cred?.access_token || cred?.refresh_token || cred?.api_key),
            source: cred ? 'slot-credentials.json' : null,
            export: oauthToSub2apiExport(
              {
                ...vm,
                email: vm.email || vm.claude?.email,
                account_uuid: vm.account_uuid || vm.claude?.account_uuid,
                org_uuid: vm.org_uuid || vm.claude?.org_uuid,
                max_concurrency: vm.max_concurrency ?? vm.policy?.maxConcurrency,
              },
              cred || {},
            ),
          }),
        )
      }
      if (req.method === 'PUT' && /^\/api\/panel\/vms\/[^/]+\/oauth\/credential$/.test(p)) {
        const id = p.split('/')[4]
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) {
          return json(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'VM not found' } })
        }
        const existing = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        existing.id = existing.id || id
        const body = await readBody(req, 256 * 1024)
        const oauth = parseCredentialEdit(body)
        if (!oauth?.access_token && !oauth?.refresh_token && !oauth?.api_key) {
          return json(res, 400, {
            ok: false,
            error: { code: 'credential_required', message: 'sub2api JSON 需要 access_token、refresh_token 或 api_key' },
          })
        }
        const committed = await commitImportedOauth({
          vmId: id,
          vmPath,
          existing,
          oauth,
          source: oauth.source || 'sub2api-account-export',
          skipOfficialCc: true,
        })
        if (!committed.ok) {
          return json(res, committed.status || 502, { ok: false, error: committed.error })
        }
        try {
          invalidateLiveCredentialCache()
        } catch {}
        return json(
          res,
          200,
          panel.ok({
            vm: summarizeVm(existing, cfg.paths.project, ctx.routingConfig),
            oauth_email: existing.claude?.email || null,
            has_refresh: existing.claude?.has_refresh,
            official_cc_bootstrap: committed.official_cc_bootstrap || null,
          }),
        )
      }
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/oauth\/to-setup-token$/.test(p)) {
        const id = p.split('/')[4]
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) {
          return json(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'VM not found' } })
        }
        const existing = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        existing.id = existing.id || id
        if (isCodexVm(existing)) {
          return json(res, 409, {
            ok: false,
            error: {
              code: 'credential_kind_mismatch',
              message: 'Codex 槽不能转为 Claude Setup Token',
            },
          })
        }
        const homeDir = path.join(cfg.paths.project, 'vms', id, 'cli-home')
        const cred = readWorkerCredentialFile(homeDir)
        if (isApiKeyMode(existing.claude?.mode) || isApiKeyMode(cred?.type || cred?.mode)) {
          return json(res, 400, {
            ok: false,
            error: { code: 'credential_kind_mismatch', message: 'Console API Key 不能转为 Setup Token' },
          })
        }
        if (isOfficialSetupTokenMode(existing.claude?.mode) || isOfficialSetupTokenMode(cred?.type || cred?.mode)) {
          return json(res, 400, {
            ok: false,
            error: {
              code: 'credential_kind_mismatch',
              message: '官方 Setup Token 只有 inference，不能转为完整 Setup Token',
            },
          })
        }
        if (isSetupTokenMode(existing.claude?.mode) || isSetupTokenMode(cred?.type || cred?.mode)) {
          return json(
            res,
            200,
            panel.ok({
              vm: summarizeVm(existing, cfg.paths.project, ctx.routingConfig),
              oauth_email: existing.claude?.email || null,
              has_refresh: existing.claude?.has_refresh,
              official_cc_bootstrap: { scheduled: false, reason: 'already_setup_token' },
            }),
          )
        }
        let oauth
        try {
          oauth = liveOauthToSetupToken(cred || {})
        } catch (e) {
          return json(res, 400, {
            ok: false,
            error: { code: e.code || 'credential_required', message: String(e.message || e).slice(0, 240) },
          })
        }
        const committed = await commitImportedOauth({
          vmId: id,
          vmPath,
          existing,
          oauth,
          source: 'oauth-to-setup-token',
          skipOfficialCc: true,
        })
        if (!committed.ok) {
          return json(res, committed.status || 502, { ok: false, error: committed.error })
        }
        try {
          invalidateLiveCredentialCache()
        } catch {}
        return json(
          res,
          200,
          panel.ok({
            vm: summarizeVm(existing, cfg.paths.project, ctx.routingConfig),
            oauth_email: existing.claude?.email || null,
            has_refresh: existing.claude?.has_refresh,
            official_cc_bootstrap: committed.official_cc_bootstrap || null,
          }),
        )
      }

      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/oauth\/refresh$/.test(p)) {
        const id = p.split('/')[4]
        const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
        if (!fs.existsSync(vmPath)) {
          return json(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'VM not found' } })
        }
        const vm = getVm(cfg.paths.project, id)
        if (isCodexVm(vm)) {
          const first = readCodexAccounts(cfg.paths.project, id)[0] || {}
          const refreshToken = String(first.refresh_token || '').trim()
          if (!refreshToken) {
            return json(res, 400, {
              ok: false,
              error: { code: 'credential_mode_unsupported', message: 'GPT 槽没有 refresh_token，请重新导入 OAuth' },
            })
          }
          const tok = await refreshCodexAccessToken({
            refreshToken,
            proxyUrl: hostProxyUrlForVm(vm),
          })
          if (!tok.ok) {
            return json(res, 502, {
              ok: false,
              error: { code: tok.error || 'refresh_failed', message: 'GPT OAuth 刷新失败，请重新导入' },
            })
          }
          upsertCodexAccount(cfg.paths.project, id, {
            access_token: tok.access_token,
            refresh_token: tok.refresh_token,
            id_token: tok.id_token || first.id_token,
            expires_at: tok.expires_at || first.expires_at,
          })
          return json(res, 200, panel.ok({ ok: true, refreshed: true, platform: 'openai' }))
        }
        if (isApiKeyMode(vm?.claude?.mode)) {
          return json(res, 400, {
            ok: false,
            error: { code: 'credential_mode_unsupported', message: 'Console API Key 不能刷新' },
          })
        }
        if (
          isOfficialSetupTokenMode(vm?.claude?.mode) ||
          (isSetupTokenMode(vm?.claude?.mode) && !vm?.claude?.has_refresh)
        ) {
          return json(res, 400, {
            ok: false,
            error: { code: 'credential_mode_unsupported', message: '官方 Setup Token（无 refresh）不能刷新' },
          })
        }
        const data = await refreshWorkerCredentialForVm({
          vmId: id,
          vmPath,
          homeDir: path.join(cfg.paths.project, 'vms', id, 'cli-home'),
          vm,
          force: true,
        })
        if (!data.ok) return json(res, 502, { ok: false, error: data.error, data })
        return json(res, 200, panel.ok(data))
      }
      if (req.method === 'GET' && p === '/api/panel/oauth') {
        return json(res, 200, panel.ok(await oauthStatusWithWorker()))
      }

      // POST /api/panel/probe
      if (req.method === 'POST' && p === '/api/panel/probe') {
        const body = await readBody(req, 4096).catch(() => ({}))
        const hop = body?.hop ?? true
        const force = body?.force ?? true
        const result = await panel.buildProbeAll({ cfg, accountQuota, hop, force })
        return json(res, 200, result)
      }
      if (req.method === 'GET' && p === '/api/panel/health-probe') {
        return json(
          res,
          200,
          panel.ok({
            config: ctx.healthMonitor?.getConfig?.() || ctx.routingConfig.health_probe,
            snapshot: ctx.healthMonitor?.getSnapshot?.() || null,
            snapshots: ctx.healthMonitor?.getSnapshots?.() || null,
          }),
        )
      }
      if (req.method === 'POST' && p === '/api/panel/health-probe') {
        const snapshot = await ctx.healthMonitor.runRealProbe()
        return json(
          res,
          200,
          panel.ok({
            config: ctx.healthMonitor.getConfig(),
            snapshot,
            snapshots: ctx.healthMonitor.getSnapshots?.() || null,
          }),
        )
      }
      if (req.method === 'GET' && p === '/api/panel/usage-probe') {
        return json(
          res,
          200,
          panel.ok({
            config: ctx.usageProbeMonitor?.getConfig?.() || ctx.routingConfig.usage_probe,
            snapshot: ctx.usageProbeMonitor?.getSnapshot?.() || null,
          }),
        )
      }
      if (req.method === 'POST' && p === '/api/panel/usage-probe') {
        const snapshot = await ctx.usageProbeMonitor.runOnce()
        return json(
          res,
          200,
          panel.ok({
            config: ctx.usageProbeMonitor.getConfig(),
            snapshot,
          }),
        )
      }
      // GET /api/panel/usage
      if (req.method === 'GET' && p === '/api/panel/usage') {
        return json(res, 200, panel.buildUsage({ accountQuota, cfg, requestLog }))
      }
      // GET /api/panel/models
      if (req.method === 'GET' && p === '/api/panel/models') {
        return json(res, 200, panel.ok(await fetchWorkerModels()))
      }

      if (req.method === 'GET' && p === '/api/panel/model-policy') {
        const platform = String(url.searchParams.get('platform') || '').toLowerCase()
        if (platform === 'openai' || platform === 'gpt' || platform === 'codex') {
          const pol = getGptModelPolicy()
          const models = listGptPolicyModels()
          return json(res, 200, panel.ok({ policy: pol, models, effective: models, platform: 'openai' }))
        }
        const pol = getModelPolicy()
        return json(
          res,
          200,
          panel.ok({
            policy: pol,
            models: listPolicyModels(),
            effective: listOfficialModels(),
            platform: 'anthropic',
          }),
        )
      }
      if (req.method === 'PUT' && p === '/api/panel/model-policy') {
        const body = await readBody(req, 2 * 1024 * 1024)
        const platform = String(body.platform || url.searchParams.get('platform') || '').toLowerCase()
        if (platform === 'openai' || platform === 'gpt' || platform === 'codex') {
          const saved = saveGptModelPolicy(body.policy || body)
          const models = listGptPolicyModels()
          return json(res, 200, panel.ok({ policy: saved, models, effective: models, platform: 'openai' }))
        }
        const saved = saveModelPolicy(body.policy || body)
        seedModelCatalog()
        return json(
          res,
          200,
          panel.ok({
            policy: saved,
            models: listPolicyModels(),
            effective: listOfficialModels(),
            platform: 'anthropic',
          }),
        )
      }
      // POST /api/panel/model-policy/reset
      if (req.method === 'POST' && p === '/api/panel/model-policy/reset') {
        const body = await readBody(req, 8192).catch(() => ({}))
        const platform = String(body.platform || url.searchParams.get('platform') || '').toLowerCase()
        if (platform === 'openai' || platform === 'gpt' || platform === 'codex') {
          const saved = resetGptModelPolicy()
          const models = listGptPolicyModels()
          return json(res, 200, panel.ok({ policy: saved, models, effective: models, platform: 'openai' }))
        }
        const saved = resetModelPolicy()
        seedModelCatalog()
        return json(
          res,
          200,
          panel.ok({
            policy: saved,
            models: listPolicyModels(),
            effective: listOfficialModels(),
            platform: 'anthropic',
          }),
        )
      }
      // POST /api/panel/model-policy/sync-worker
      if (req.method === 'POST' && p === '/api/panel/model-policy/sync-worker') {
        let workerIds = []
        try {
          workerIds = getCatalogIds()
        } catch {}
        if (!workerIds.length) {
          try {
            const raw = JSON.parse(fs.readFileSync('/opt/kin-gateway/data/cli-models.json', 'utf8'))
            if (Array.isArray(raw?.ids)) workerIds = raw.ids
          } catch {}
        }
        const saved = syncWorkerModelsIntoPolicy(workerIds)
        seedModelCatalog()
        return json(
          res,
          200,
          panel.ok({
            policy: saved,
            models: listPolicyModels(),
            effective: listOfficialModels(),
            synced: workerIds.length,
          }),
        )
      }
      // POST /api/panel/model-policy/sync-codex — ChatGPT GPT catalog via a Codex OAuth slot
      if (req.method === 'POST' && p === '/api/panel/model-policy/sync-codex') {
        const body = await readBody(req, 8192).catch(() => ({}))
        const result = await syncCodexCatalog({
          projectRoot: cfg.paths.project,
          vmId: body?.vm_id || body?.vmId || url.searchParams.get('vm_id') || '',
          rotate: true,
          catalogClientVersion:
            body?.catalog_client_version ||
            body?.catalogClientVersion ||
            ctx.routingConfig.codex?.catalog_client_version ||
            'auto',
        })
        if (!result.ok) {
          const status =
            result.error === 'no_codex_slot' ||
            result.error === 'proxy_required' ||
            result.error === 'invalid_request' ||
            result.error === 'invalid_catalog_version'
              ? 400
              : 502
          return json(res, status, {
            ok: false,
            error: { code: result.error, message: result.message || result.error },
            data: {
              vm_id: result.vm_id || null,
              catalog_version: result.catalog_version || null,
              synced: 0,
            },
          })
        }
        return json(
          res,
          200,
          panel.ok({
            policy: getGptModelPolicy(),
            models: listGptPolicyModels(),
            effective: listGptPolicyModels(),
            platform: 'openai',
            synced: result.synced,
            source: result.source,
            vm_id: result.vm_id,
            catalog_version: result.catalog_version,
            ids: result.ids,
          }),
        )
      }

      // GET /api/panel/routing
      if (req.method === 'GET' && p === '/api/panel/routing') {
        return json(res, 200, panel.buildRouting({ routingConfig: ctx.routingConfig, stickyRouter }))
      }
      // GET /api/panel/persona/preview-vars?timezone= — real template constants for the system prompt preview
      if (req.method === 'GET' && p === '/api/panel/persona/preview-vars') {
        const timezone = validTimezone(url.searchParams.get('timezone')) || 'UTC'
        return json(res, 200, panel.ok({ vars: personaPreviewVars({ timezone }) }))
      }
      // PUT /api/panel/routing
      if (req.method === 'PUT' && p === '/api/panel/routing') {
        const body = await readBody(req, cfg.limits.max_body_bytes)
        const previousRoutingConfig = structuredClone(ctx.routingConfig)
        try {
          if (body?.codex && Object.prototype.hasOwnProperty.call(body.codex, 'quota')) {
            validateOpenAIQuotaPatch(body.codex.quota)
          }
        } catch (error) {
          if (error instanceof TypeError || error instanceof RangeError) {
            return json(res, 400, {
              ok: false,
              error: { type: 'invalid_request_error', code: 'invalid_openai_quota', message: error.message },
            })
          }
          throw error
        }
        if (body && Object.prototype.hasOwnProperty.call(body, 'vm')) {
          const checked = validateVmConfigPatch(body.vm)
          if (!checked.ok) {
            return json(res, 400, {
              ok: false,
              error: { type: 'invalid_request_error', code: 'invalid_vm_config', message: checked.error },
            })
          }
        }
        const personaProblems = [...panel.validatePersonaRoutingPatch(body), ...validateInferenceRoutingPatch(body)]
        if (personaProblems.length) {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'invalid_persona_template',
              message: personaProblems.join('；'),
              problems: personaProblems,
            },
          })
        }
        const engineRuntime = await prepareInheritedInferenceEngine(body)
        if (!engineRuntime.ok) {
          return json(res, 503, {
            ok: false,
            error: {
              code: engineRuntime.code,
              message: engineRuntime.error,
              failed_vm: engineRuntime.failed_vm,
            },
          })
        }
        const { applied: appliedDuringSwitch, ...publicEngineRuntime } = engineRuntime
        let applied
        try {
          applied = appliedDuringSwitch ?? persistRoutingPatch(body)
        } catch (error) {
          restoreRoutingRuntime(previousRoutingConfig)
          return json(res, 503, {
            ok: false,
            error: { code: 'routing_persist_failed', message: String(error?.message || error) },
          })
        }
        return json(
          res,
          200,
          panel.ok({
            ...publicRoutingNotify(ctx.routingConfig),
            applied_concurrency: applied.concurrency,
            applied_rpm: applied.rpm,
            applied_session_slots: applied.session_slots,
            kernel_persona: applied.kernel_persona || null,
            inference_runtime: publicEngineRuntime,
          }),
        )
      }
      if (req.method === 'GET' && p === '/api/panel/distill') {
        return json(res, 200, panel.ok(reloadDistill()))
      }
      if (req.method === 'PUT' && p === '/api/panel/distill') {
        const body = await readBody(req, 256 * 1024)
        const problems = validateDistillPatch(body)
        if (problems.length) {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'invalid_distill_rules',
              message: problems.join('；'),
              problems,
            },
          })
        }
        cfg.distill = saveDistillRules(distillFile(), body)
        return json(res, 200, panel.ok(cfg.distill))
      }
      if (req.method === 'GET' && p === '/api/panel/refusal-guards') {
        return json(res, 200, panel.ok(refusalGuardSnapshot()))
      }
      if (req.method === 'PUT' && p === '/api/panel/refusal-guards') {
        const body = await readBody(req, 8 * 1024).catch(() => ({}))
        const patched = applyRefusalGuardPatch(new SettingsRepo(), body || {})
        if (!patched.ok) {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'invalid_refusal_guard',
              message: patched.problems.join('；'),
            },
          })
        }
        return json(res, 200, panel.ok(refusalGuardSnapshot()))
      }
      if (req.method === 'DELETE' && /^\/api\/panel\/refusal-guards\/[0-9a-f]{64}$/i.test(p)) {
        const fp = p.split('/').pop()
        const removed = new RefusalGuardsRepo().remove(fp)
        if (!removed) {
          return json(res, 404, {
            ok: false,
            error: { type: 'not_found_error', code: 'refusal_guard_not_found', message: '指纹不存在' },
          })
        }
        return json(res, 200, panel.ok(refusalGuardSnapshot()))
      }
      if (req.method === 'DELETE' && p === '/api/panel/refusal-guards') {
        const body = await readBody(req, 8 * 1024).catch(() => ({}))
        if (body?.confirm !== true) {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'confirm_required',
              message: '清空拒答缓存须 confirm: true',
            },
          })
        }
        new RefusalGuardsRepo().clear()
        return json(res, 200, panel.ok(refusalGuardSnapshot()))
      }
      if (req.method === 'DELETE' && p === '/api/panel/refusal-device-blocks') {
        const body = await readBody(req, 8 * 1024).catch(() => ({}))
        const repo = new RefusalDeviceBlocksRepo()
        const deviceId = String(body?.device_id || '').trim()
        if (deviceId) {
          if (!repo.remove(deviceId)) {
            return json(res, 404, {
              ok: false,
              error: { type: 'not_found_error', code: 'refusal_device_not_found', message: 'device 不存在' },
            })
          }
          return json(res, 200, panel.ok(refusalGuardSnapshot()))
        }
        if (body?.confirm !== true) {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'confirm_required',
              message: '清空 device 封禁须 confirm: true，或传 device_id',
            },
          })
        }
        repo.clear()
        return json(res, 200, panel.ok(refusalGuardSnapshot()))
      }
      if (req.method === 'GET' && p === '/api/panel/protocol-entry') {
        return json(res, 200, panel.ok(requestLog.protocolEntryStats()))
      }
      if (req.method === 'GET' && p === '/api/panel/jev-intercept') {
        return json(res, 200, panel.ok(jevInterceptSnapshot()))
      }
      if (req.method === 'PUT' && p === '/api/panel/jev-intercept') {
        const body = await readBody(req, 64 * 1024).catch(() => ({}))
        const patched = applyJevPatch(new SettingsRepo(), body || {})
        if (!patched.ok) {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'invalid_jev_intercept',
              message: patched.problems.join('；'),
            },
          })
        }
        return json(res, 200, panel.ok(patched.config))
      }
      if (req.method === 'POST' && p === '/api/panel/jev-intercept/models') {
        const body = await readBody(req, 8192).catch(() => ({}))
        const current = jevInterceptSnapshot()
        const baseUrl = String(body?.base_url || current.base_url || '').trim()
        const typedKey = String(body?.api_key || '').trim()
        const stored = readJevConfig((key, fallback) => new SettingsRepo().get(key, fallback))
        const apiKey = typedKey || stored.api_keys[0] || ''
        try {
          const listed = await listDecisionModels(baseUrl, apiKey, Number(body?.timeout_ms) || current.timeout_ms)
          return json(res, 200, panel.ok({ models: listed.models, url: listed.url }))
        } catch (error) {
          return json(res, 502, {
            ok: false,
            error: {
              type: 'api_error',
              code: error?.code || 'fetch_models_failed',
              message: error?.message || '获取模型失败',
            },
          })
        }
      }
      if (req.method === 'GET' && p === '/api/panel/notify') {
        return json(
          res,
          200,
          panel.ok(
            ctx.notifyMonitor?.getStatus?.() || {
              config: publicNotifyConfig(ctx.routingConfig.notify),
              snapshot: null,
            },
          ),
        )
      }
      if (req.method === 'POST' && p === '/api/panel/notify/check') {
        const body = await readBody(req, 64 * 1024).catch(() => ({}))
        const digest = body?.digest === true
        const result = await ctx.notifyMonitor.runOnce({ send: true, force: false, digest })
        return json(
          res,
          200,
          panel.ok({
            ...(ctx.notifyMonitor.getStatus() || {}),
            events: result?.events || [],
            dispatched: result?.dispatched || [],
          }),
        )
      }
      if (req.method === 'POST' && p === '/api/panel/notify/test') {
        const body = await readBody(req, 64 * 1024)
        const channel = String(body.channel || '').toLowerCase()
        if (channel !== 'email' && channel !== 'telegram') {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'missing_field',
              message: 'channel must be email or telegram',
              param: 'channel',
            },
          })
        }
        const trial = mergeNotifyConfig(ctx.routingConfig.notify, {
          email: body.email,
          telegram: body.telegram,
        })
        try {
          const result = await sendNotifyTest(trial, channel, {
            baseUrl: cfg.base_url,
            snapshot:
              ctx.notifyMonitor?.getSnapshot?.() ||
              (await panel.snapshotAccountPool({
                cfg,
                accountQuota,
                routingConfig: ctx.routingConfig,
                poolScheduler: ctx.poolScheduler,
                proxyPool,
                requestLog,
              })),
          })
          return json(res, 200, panel.ok(result))
        } catch (e) {
          return json(res, 400, {
            ok: false,
            error: {
              type: 'invalid_request_error',
              code: 'notify_test_failed',
              message: String(e?.message || e).slice(0, 180),
            },
          })
        }
      }
      // ---- Proxy Pool ----
      if (req.method === 'GET' && p === '/api/panel/proxies') {
        const ident = panelIdentity(req)
        const snap = ident.role === 'user' ? proxyPool.snapshot({ ownerUserId: req.panelUserId }) : proxyPool.snapshot()
        if (ident.role !== 'admin') {
          delete snap.config.dns_primary
          // Node labels may contain SSH addresses, which belong to the admin-only cluster view.
          for (const exit of snap.local_exits || []) exit.node_name = exit.node_id || null
        }
        return json(res, 200, panel.ok(snap))
      }
      if (req.method === 'POST' && p === '/api/panel/proxies/local') {
        const result = proxyPool.ensureLocal()
        if (result.created) ensureProxyEgress(cfg.paths.project, proxyPool.getProxyByIdWithAuth(result.proxy.id))
        return json(res, 200, panel.ok(result))
      }
      if (req.method === 'POST' && p === '/api/panel/proxies/import') {
        const body = await readBody(req, 2 * 1024 * 1024)
        const text = body.text || body.lines || (Array.isArray(body) ? body.join('\n') : '')
        const ident = panelIdentity(req)
        const result = proxyPool.importLines(text, {
          fields: body.proxies || body.entries || null,
          host: body.host,
          port: body.port,
          username: body.username ?? body.user,
          password: body.password ?? body.pass,
          ownerUserId: ident.role === 'user' ? req.panelUserId : null,
        })
        const bindVmId = String(body.bind_vm_id || body.vm_id || '').trim()
        let bound = null
        let worker = null
        let timezone = null
        if (bindVmId && result.items?.[0]?.id) {
          const bind = proxyPool.bind(result.items[0].id, bindVmId)
          if (bind.ok) {
            bindVmProxy(cfg.paths.project, bindVmId, proxyPool.getProxyForVm(bindVmId))
            bound = bind.proxy
            // Before the reload: the worker reads vm.timezone when it starts.
            timezone = await syncVmTimezoneFromProxy(cfg.paths.project, proxyPool, bindVmId, {
              proxyId: result.items[0].id,
            })
            const vm = getVm(cfg.paths.project, bindVmId)
            if (vm?.status === 'running' && process.env.KIN_CRS_MOCK !== '1') {
              setVmSchedulable(cfg.paths.project, bindVmId, false, 'proxy_rebind_worker_reload')
              worker = await reloadSlotReady(getVm(cfg.paths.project, bindVmId), cfg.paths.project, {
                routing: ctx.routingConfig,
              })
              if (worker.ok) restoreSchedulableIfReady(bindVmId)
            }
          }
        }
        return json(res, 200, panel.ok({ ...result, bound, worker, timezone }))
      }
      if (req.method === 'POST' && p === '/api/panel/proxies/geo') {
        const body = await readBody(req, 8192).catch(() => ({}))
        const result = await proxyPool.detectGeoAll({
          onlyEnabled: body?.only_enabled !== false,
          force: body?.force === true,
        })
        return json(res, 200, panel.ok(result))
      }
      if (req.method === 'POST' && p === '/api/panel/proxies/probe') {
        const result = await proxyPool.probeAll({ onlyEnabled: true })
        return json(res, 200, panel.ok(result))
      }
      if (req.method === 'GET' && p === '/api/panel/proxies/config') {
        const config = proxyPool.snapshot().config
        if (panelIdentity(req).role !== 'admin') delete config.dns_primary
        return json(res, 200, panel.ok(config))
      }
      if (req.method === 'PUT' && p === '/api/panel/proxies/config') {
        const body = await readBody(req, 64 * 1024)
        const previousConfig = proxyPool.snapshot().config
        const result = proxyPool.updateConfig(body)
        if (!result.ok)
          return json(res, 400, {
            ok: false,
            error: { type: 'invalid_request_error', code: result.error, message: result.error, details: result },
          })
        // DNS changes must reach running egress helpers; slots stay intact.
        const egress = []
        if (
          ((body.dns_primary != null && body.dns_primary !== previousConfig.dns_primary) ||
            (body.dns_disable_svcb_https != null &&
              body.dns_disable_svcb_https !== previousConfig.dns_disable_svcb_https)) &&
          egressEnabled() &&
          process.env.KIN_CRS_MOCK !== '1'
        ) {
          const dnsUpstream = dnsUpstreamChain(result.config.dns_primary)
          const dnsEmptyTypes = result.config.dns_disable_svcb_https ? [64, 65] : []
          for (const proxy of proxyPool.snapshot().proxies) {
            if (isLocalEgressProxy(proxy) || !proxy.bound_vm_ids?.length) continue
            const r = ensureProxyEgress(cfg.paths.project, proxyPool.getProxyByIdWithAuth(proxy.id), {
              dnsUpstream,
              dnsEmptyTypes,
            })
            egress.push({ proxy_id: proxy.id, ok: r.ok, error: r.ok ? null : r.error })
          }
        }
        if (body.ipv6_enabled != null && process.env.KIN_CRS_MOCK !== '1') {
          egress.push(...(await syncIpv6ProxyEgress(cfg.paths.project, proxyPool)))
        }
        return json(res, 200, panel.ok({ ...result.config, egress }))
      }
      // Must stay BELOW /proxies/config: `[^/]+` matches "config" too, and this
      // route shares its method, so ordering alone decides the winner. The
      // negative lookahead makes that dependency explicit rather than positional.
      if (req.method === 'PUT' && /^\/api\/panel\/proxies\/(?!config$)[^/]+$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readBody(req, 64 * 1024)
        if (rejectScopedLocalManagement(id, body, res)) return
        // Forward only the keys the caller actually sent — update() reads
        // presence, not value, to tell "leave alone" from "clear".
        const patch = {}
        for (const key of ['host', 'port', 'username', 'password', 'label', 'domain_forward']) {
          if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key]
        }
        const result = proxyPool.update(id, patch)
        if (!result.ok) {
          const status = result.error === 'proxy_not_found' ? 404 : 400
          const type = status === 404 ? 'not_found_error' : 'invalid_request_error'
          return json(res, status, { ok: false, error: { type, code: result.error, message: result.error } })
        }
        // Hostname mode is inside kin-egress. Restart that helper only; the
        // slot workers keep the same bridge and do not need a reload.
        let egress = null
        if (
          result.domain_forward_changed &&
          egressEnabled() &&
          process.env.KIN_CRS_MOCK !== '1' &&
          (result.proxy.bound_vm_ids || []).length
        ) {
          const restarted = ensureProxyEgress(cfg.paths.project, proxyPool.getProxyByIdWithAuth(id))
          egress = { ok: !!restarted.ok, error: restarted.ok ? null : restarted.error || 'egress_restart_failed' }
        }
        // A label is display-only; reloading every bound worker for it would
        // pull live slots out of scheduling for nothing.
        if (!result.connection_changed) return json(res, 200, panel.ok({ proxy: result.proxy, workers: [], egress }))
        // The pool store is only one of three places the credentials live
        // (pool -> vms/<id>.json -> worker.json). Without this the edit looks
        // like it worked while every bound slot keeps dialing the old proxy.
        const workers = []
        for (const vmId of result.proxy.bound_vm_ids || []) {
          bindVmProxy(cfg.paths.project, vmId, proxyPool.getProxyByIdWithAuth(id))
          const vm = getVm(cfg.paths.project, vmId)
          if (vm?.status === 'running' && process.env.KIN_CRS_MOCK !== '1') {
            setVmSchedulable(cfg.paths.project, vmId, false, 'proxy_edit_worker_reload')
            const reloaded = await reloadSlotReady(getVm(cfg.paths.project, vmId), cfg.paths.project, {
              routing: ctx.routingConfig,
            })
            if (reloaded.ok) restoreSchedulableIfReady(vmId)
            // A slot that fails to reload does not fail the request: the store
            // is already updated, so report per-slot and let ops retry.
            workers.push({ vm_id: vmId, ok: !!reloaded.ok, error: reloaded.ok ? null : reloaded.error || null })
          } else {
            workers.push({ vm_id: vmId, ok: true, error: null })
          }
        }
        return json(res, 200, panel.ok({ proxy: result.proxy, workers, egress }))
      }
      // The one endpoint allowed to return proxy credentials. Mirrors
      // POST /api/panel/api-keys/:id/reveal: POST so it never lands in browser
      // history or a cache, no body, no confirmation step.
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/reveal$/.test(p)) {
        const id = p.split('/')[4]
        // Deliberately not getProxyForVm(): that one filters out disabled and
        // dead rows, which are the ones an operator most needs to read back.
        const full = proxyPool.getProxyByIdWithAuth(id)
        if (!full)
          return json(res, 404, {
            ok: false,
            error: { type: 'not_found_error', code: 'proxy_not_found', message: 'proxy not found' },
          })
        // URI only — no split username/password fields, so there is nothing for
        // a caller to render into the DOM piecemeal.
        return json(res, 200, { ok: true, id: full.id, uri: full.url })
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/probe$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readProxyBody(req, res)
        if (!body) return
        const scope = proxyNodeScope(body, res)
        if (!scope) return
        const result = await proxyPool.probeById(id, scope)
        if (result.probe?.scope === 'policy') {
          return json(res, 409, {
            ok: false,
            error: {
              code: result.probe.error,
              message: 'IPv6 已关闭，请在设置 → SOCKS5 开启 IPv6 代理出口',
            },
          })
        }
        if (!result.ok)
          return json(res, 404, {
            ok: false,
            error: { type: 'not_found_error', code: result.error, message: result.error },
          })
        return json(res, 200, panel.ok(result))
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/geo$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readProxyBody(req, res)
        if (!body) return
        const scope = proxyNodeScope(body, res)
        if (!scope) return
        const result = await proxyPool.detectGeo(id, { ...scope, force: body?.force !== false })
        if (result.error === 'ipv6_disabled') {
          return json(res, 409, {
            ok: false,
            error: {
              code: result.error,
              message: 'IPv6 已关闭，请在设置 → SOCKS5 开启 IPv6 代理出口',
            },
          })
        }
        if (!result.ok && result.error === 'proxy_not_found') {
          return json(res, 404, {
            ok: false,
            error: { type: 'not_found_error', code: result.error, message: result.error },
          })
        }
        if (!result.ok) {
          return json(res, 502, {
            ok: false,
            error: {
              type: 'upstream_error',
              code: 'geo_lookup_failed',
              message: String(result.error || 'geo lookup failed').slice(0, 200),
              details: { proxy: result.proxy || null },
            },
          })
        }
        // A slot already bound to this proxy adopts the freshly learned zone.
        const timezones = []
        for (const vmId of result.proxy?.bound_vm_ids || []) {
          const synced = await syncVmTimezoneFromProxy(cfg.paths.project, proxyPool, vmId, {
            proxyId: id,
            detect: false,
          })
          timezones.push({ vm_id: vmId, applied: synced.applied, timezone: synced.timezone, reason: synced.reason })
        }
        return json(res, 200, panel.ok({ ...result, timezones }))
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/enable$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readProxyBody(req, res)
        if (!body) return
        if (rejectScopedLocalManagement(id, body, res)) return
        const result = proxyPool.setEnabled(id, true)
        if (!result.ok)
          return json(res, 404, {
            ok: false,
            error: { type: 'not_found_error', code: result.error, message: result.error },
          })
        // re-enable bound VM scheduling if any
        for (const vmId of result.proxy?.bound_vm_ids ||
          (result.proxy?.bound_vm_id ? [result.proxy.bound_vm_id] : [])) {
          const bound = getVm(cfg.paths.project, vmId)
          const reason = String(bound?.schedule_disabled_reason || '')
          if (vmHasClaudeCredential(bound) && reason !== 'disabled' && reason !== 'stopped') {
            setVmSchedulable(cfg.paths.project, vmId, true, null)
          }
        }
        return json(res, 200, panel.ok(result.proxy))
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/disable$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readProxyBody(req, res)
        if (!body) return
        if (rejectScopedLocalManagement(id, body, res)) return
        const result = proxyPool.setEnabled(id, false)
        if (!result.ok)
          return json(res, 404, {
            ok: false,
            error: { type: 'not_found_error', code: result.error, message: result.error },
          })
        return json(res, 200, panel.ok(result.proxy))
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/bind$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readBody(req, 64 * 1024)
        const vmId = body.vm_id
        if (!vmId)
          return json(res, 400, {
            ok: false,
            error: { type: 'invalid_request_error', code: 'missing_field', message: 'vm_id required', param: 'vm_id' },
          })
        const scope = proxyNodeScope(body, res)
        if (!scope) return
        const targetVm = getVm(cfg.paths.project, vmId)
        const targetProxy = proxyPool.state?.proxies?.find((item) => item.id === id)
        const ident = panelIdentity(req)
        if (
          !targetVm ||
          !targetProxy ||
          (ident.role === 'user' && normalizeOwnerId(targetVm.owner_user_id) !== normalizeOwnerId(req.panelUserId)) ||
          !canBindProxyToVm(targetProxy, targetVm, { role: ident.role })
        ) {
          return json(res, 404, { ok: false, error: { code: 'proxy_not_found', message: '出口或槽位不存在' } })
        }
        const result = proxyPool.bind(id, vmId, scope)
        if (!result.ok) {
          const message =
            result.error === 'proxy_bind_limit' ? `此出口最多绑定 ${result.max || 5} 台虚拟机` : result.error
          return json(res, 400, {
            ok: false,
            error: { type: 'invalid_request_error', code: result.error, message, details: result },
          })
        }
        bindVmProxy(cfg.paths.project, vmId, proxyPool.getProxyForVm(vmId))
        if (egressEnabled()) {
          ensureProxyEgress(cfg.paths.project, proxyPool.getProxyForVm(vmId) || proxyPool.getProxyByIdWithAuth(id))
        }
        let worker = null
        // Runs before the reload so the worker starts with the exit node's zone.
        const timezone = await syncVmTimezoneFromProxy(cfg.paths.project, proxyPool, vmId, { proxyId: id })
        const vm = getVm(cfg.paths.project, vmId)
        if (vm?.status === 'running' && process.env.KIN_CRS_MOCK !== '1') {
          setVmSchedulable(cfg.paths.project, vmId, false, 'proxy_rebind_worker_reload')
          worker = await reloadSlotReady(getVm(cfg.paths.project, vmId), cfg.paths.project, {
            routing: ctx.routingConfig,
          })
          if (worker.ok) restoreSchedulableIfReady(vmId)
        }
        return json(res, 200, panel.ok({ proxy: result.proxy, worker, timezone }))
      }
      if (req.method === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/unbind$/.test(p)) {
        const id = p.split('/')[4]
        const body = await readBody(req, 64 * 1024)
        const vmId = String(body.vm_id || '').trim()
        const scope = proxyNodeScope(body, res)
        if (!scope) return
        const snap = proxyPool.snapshot(scope).proxies.find((proxy) => proxy.id === id)
        const targets = vmId
          ? [vmId]
          : snap?.bound_vm_ids?.length
            ? snap.bound_vm_ids
            : snap?.bound_vm_id
              ? [snap.bound_vm_id]
              : []
        const result = proxyPool.unbind(id, vmId || null, scope)
        if (!result.ok)
          return json(res, result.error === 'proxy_not_found' ? 404 : 400, {
            ok: false,
            error: { type: 'not_found_error', code: result.error, message: result.error },
          })
        for (const unboundId of result.unbound_vm_ids || targets) {
          bindVmProxy(cfg.paths.project, unboundId, null)
          setVmSchedulable(cfg.paths.project, unboundId, false, 'proxy_required')
        }
        const remaining = proxyPool.snapshot().proxies.find((proxy) => proxy.id === id)
        if (egressEnabled() && !(remaining?.bound_vm_ids || []).length) {
          stopProxyEgress(cfg.paths.project, id)
        }
        return json(res, 200, panel.ok(result.proxy))
      }
      if (req.method === 'DELETE' && /^\/api\/panel\/proxies\/[^/]+$/.test(p)) {
        const id = p.split('/').pop()
        const body = await readProxyBody(req, res)
        if (!body) return
        if (rejectScopedLocalManagement(id, body, res)) return
        const snap = proxyPool.snapshot().proxies.find((proxy) => proxy.id === id)
        const targets = snap?.bound_vm_ids?.length ? snap.bound_vm_ids : snap?.bound_vm_id ? [snap.bound_vm_id] : []
        const result = proxyPool.remove(id)
        if (!result.ok)
          return json(res, 404, {
            ok: false,
            error: { type: 'not_found_error', code: result.error, message: result.error },
          })
        for (const unboundId of targets) {
          bindVmProxy(cfg.paths.project, unboundId, null)
          setVmSchedulable(cfg.paths.project, unboundId, false, 'proxy_required')
        }
        if (egressEnabled()) stopProxyEgress(cfg.paths.project, id)
        return json(res, 200, panel.ok(result.removed))
      }
      // Auto-allocate proxy for a VM
      if (req.method === 'POST' && /^\/api\/panel\/vms\/[^/]+\/allocate-proxy$/.test(p)) {
        const vmId = p.split('/')[4]
        const allocated = proxyPool.allocateForVm(vmId)
        if (!allocated)
          return json(res, 409, {
            ok: false,
            error: { type: 'api_error', code: 'no_free_proxy', message: 'No free SOCKS5 in pool' },
          })
        bindVmProxy(cfg.paths.project, vmId, proxyPool.getProxyForVm(vmId))
        if (egressEnabled()) ensureProxyEgress(cfg.paths.project, proxyPool.getProxyForVm(vmId))
        let worker = null
        const timezone = await syncVmTimezoneFromProxy(cfg.paths.project, proxyPool, vmId, {
          proxyId: allocated?.id || null,
        })
        const vm = getVm(cfg.paths.project, vmId)
        if (vm?.status === 'running' && process.env.KIN_CRS_MOCK !== '1') {
          setVmSchedulable(cfg.paths.project, vmId, false, 'proxy_rebind_worker_reload')
          worker = await reloadSlotReady(getVm(cfg.paths.project, vmId), cfg.paths.project, {
            routing: ctx.routingConfig,
          })
          if (worker.ok) restoreSchedulableIfReady(vmId)
        }
        return json(res, 200, panel.ok({ proxy: allocated, worker, timezone }))
      }

      return json(res, 404, {
        ok: false,
        error: { type: 'not_found_error', code: 'not_found', message: 'panel route not found' },
      })
    }

    // ---- intercept rules admin ----
    if (p === '/admin/intercept/rules') {
      if (!requireAuth(req, res)) return
      if (req.method === 'GET') {
        return json(res, 200, { rules: reloadRules() })
      }
      if (req.method === 'PUT') {
        const body = await readBody(req, 256 * 1024)
        const rules = Array.isArray(body) ? body : body.rules
        if (!Array.isArray(rules)) {
          return json(res, 400, { error: { message: 'rules must be array' } })
        }
        fs.writeFileSync(rulesFile(), JSON.stringify(rules, null, 2))
        cfg.intercept.rules = rules
        return json(res, 200, { ok: true, count: rules.length, rules })
      }
      if (req.method === 'DELETE') {
        fs.writeFileSync(rulesFile(), '[]')
        cfg.intercept.rules = []
        return json(res, 200, { ok: true, count: 0, rules: [] })
      }
    }

    if (req.method === 'GET' && p === '/admin/vm/oauth') {
      if (!requireAuth(req, res)) return
      return json(res, 200, await oauthStatusWithWorker())
    }
    if (req.method === 'POST' && p === '/admin/vm/oauth/refresh') {
      if (!requireAuth(req, res)) return
      const body = await readBody(req, 4096).catch(() => ({}))
      const id = String(body.vm_id || getActiveVmId(cfg.paths.project) || '').trim()
      const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
      if (!id || !fs.existsSync(vmPath)) {
        return json(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'VM not found' } })
      }
      const data = await refreshWorkerCredentialForVm({
        vmId: id,
        vmPath,
        homeDir: path.join(cfg.paths.project, 'vms', id, 'cli-home'),
        vm: getVm(cfg.paths.project, id),
        force: true,
      })
      return json(res, data.ok ? 200 : 502, data)
    }

    // Claude CLI inference/update was removed; workers are built and deployed separately.
    if (req.method === 'GET' && p === '/admin/vm/claude-code/version') {
      if (!requireAuth(req, res)) return
      return json(res, 410, {
        error: { code: 'claude_cli_removed', message: 'Claude CLI runtime was replaced by the Go slot worker' },
      })
    }
    if (req.method === 'POST' && p === '/admin/vm/claude-code/update') {
      if (!requireAuth(req, res)) return
      return json(res, 410, {
        error: { code: 'claude_cli_removed', message: 'Build and roll out the Go slot worker instead' },
      })
    }

    return false
  }
}
