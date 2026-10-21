/**
 * vm2api — Node control plane.
 * Inference data plane: one long-lived Go slot worker per VM
 * (slot SOCKS5 + OAuth owner + SSE terminal validation).
 * The gateway converts protocols, schedules the account pool with bounded
 * failover, and never talks to Anthropic on the inference path. After a live
 * OAuth import it may spawn official Claude Code once (slot SOCKS5) to seed
 * ~/.claude.json and complete a plan turn.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, reloadActiveVm, routingConfigFile } from './lib/core/config.mjs'
import {
  extractApiKey,
  timingSafeEqualStr,
  createRateLimiter,
  verifyPanelSession,
  extractPanelToken,
  attachPanelAuth,
  getPanelAdmin,
} from './lib/core/security.mjs'
import { loadModelPolicy, refreshModelPolicy } from './lib/protocol/model-policy.mjs'
import { gatewayModelCatalog } from './lib/protocol/models.mjs'
import {
  createCredentialRefreshMonitor,
  normalizeCredentialRefreshConfig,
} from './lib/oauth/credential-refresh-monitor.mjs'
import { createKernelWatchdog, normalizeKernelWatchdogConfig } from './lib/transport/kernel-watchdog.mjs'
import { ensureSlotSubscriptionType } from './lib/oauth/oauth-credentials.mjs'
import { createCliNodeGuard } from './lib/vm/cli-node-guard.mjs'
import { ensureTelemetrySidecar } from './lib/vm/slot-process-status.mjs'

import { createSlotBridgeHealer, powerOnSlot, reviveDownSlots } from './lib/vm/slot-recovery.mjs'
import { createUsageProbeMonitor, normalizeUsageProbeConfig } from './lib/oauth/usage-probe-monitor.mjs'
import { createCatalogMonitor } from './lib/admin/catalog-monitor.mjs'
import { pausePriceCatalog, resumePriceCatalog, invalidatePriceCatalog } from './lib/admin/price-catalog.mjs'
import { normalizeOfficialCcConfig } from './lib/oauth/official-cc-bootstrap.mjs'
import { invalidateLiveCredentialCache } from './lib/admin/panel-live-credentials.mjs'
import { normalizeHealthProbeConfig, createHealthProbeMonitor, HEALTH_REAL_HEADER } from './lib/admin/health-probe.mjs'
import { normalizeNotifyConfig, createNotifyMonitor, dispatchNotify } from './lib/admin/notify.mjs'
import { runVmTestChat } from './lib/admin/vm-test-chat.mjs'
import { VmTestScheduleRunner } from './lib/admin/vm-test-schedule.mjs'
import { StickyRouter } from './lib/pool/sticky-router.mjs'
import { setManualScheduleWins } from './lib/pool/schedule-policy.mjs'
import { AccountQuota } from './lib/pool/account-quota.mjs'
import { normalizeTiers } from './lib/pool/quota-tiers.mjs'
import { ApiKeyStore } from './lib/admin/api-keys.mjs'
import { keyScopeFromRequest } from './lib/admin/key-scope.mjs'
import { GroupsRepo } from './lib/db/repos/groups-repo.mjs'
import { RuntimeSettings as SettingsRepo, loadSettingsState } from './lib/db/settings-state.mjs'
import { ApiEndpointStore } from './lib/admin/api-endpoints.mjs'
import { ApiScheduler } from './lib/pool/api-scheduler.mjs'
import { resolveInferenceBackend } from './lib/pool/api-protocol.mjs'
import { bootApiKernel, apiKernelPaths, apiKernelSnapshot } from './lib/transport/api-kernel-client.mjs'
import { PanelUserStore } from './lib/admin/panel-users.mjs'
import { RequestLogStore } from './lib/admin/request-log.mjs'
import {
  bindVmProxy,
  listVms,
  getVm,
  getActiveVmId,
  setVmSchedulable,
  isCodexVm,
  syncCodexQuotaSchedule,
} from './lib/vm/vm-registry.mjs'
import { makeError, ErrorType, ErrorCode } from './lib/core/errors.mjs'
import * as panel from './lib/admin/panel-api.mjs'
import { ProxyPool } from './lib/vm/proxy-pool.mjs'
import { ensureProxyEgress, proxyEgressReady } from './lib/vm/egress.mjs'
import { syncIpv6ProxyEgress } from './lib/vm/proxy-policy-runtime.mjs'
import { GATEWAY_CAPABILITIES } from './lib/vm/execution-context.mjs'
import { isTelemetryPath, telemetryInterceptResponse } from './lib/identity/telemetry-rewrite.mjs'
import { openDatabase, closeDatabase } from './lib/db/database.mjs'
import { runLegacyImport } from './lib/db/legacy-import.mjs'
import { initVmDbSync, stopVmWatch, flushVmDbSync, pauseVmDbSync, resumeVmDbSync } from './lib/vm/vm-db-sync.mjs'
import { flushPendingWrites } from './lib/db/pending-writes.mjs'
import { loadGptModelPolicy, refreshGptModelPolicy } from './lib/protocol/gpt-model-policy.mjs'
import { BackupService } from './lib/admin/backup-service.mjs'
import { ClusterNodesRepo } from './lib/db/repos/cluster-nodes-repo.mjs'
import { ClusterManager } from './lib/cluster/cluster-manager.mjs'
import { createClusterRoutes } from './lib/cluster/cluster-routes.mjs'
import { bindPlacement, nodeImageBuildRunning } from './lib/cluster/placement.mjs'
import { ClusterError } from './lib/cluster/ssh-link.mjs'
import { nodeEgressProxyUrl, startNodeEgressSocks } from './lib/cluster/node-egress-socks.mjs'
import { createSlotShell } from './lib/vm/slot-shell.mjs'
import { vmLockBusy } from './lib/vm/vm-file.mjs'
import { refreshSlotGuestBinDir } from './lib/vm/vm-runtime.mjs'

import {
  classifyCredentialRefresh,
  markVmRefreshError,
  mirrorWorkerCredentialsToVm,
} from './lib/oauth/oauth-credentials.mjs'
import { normalizeCredentialMode } from './lib/oauth/credential-mode.mjs'
import { ensureWorkerCredential } from './lib/transport/go-worker-client.mjs'
import { stopAllRustKernels } from './lib/transport/rust-kernel-supervisor.mjs'
import { createRespond, parseRequestUrl } from './lib/http/respond.mjs'
import { corsHeadersForRequest } from './lib/http/cors.mjs'
import { isConsoleEntry, tryServeWebDist } from './lib/http/web-dist.mjs'
import { createRoutingRuntime } from './lib/admin/routing-runtime.mjs'
import { createImportCommit } from './lib/oauth/import-commit.mjs'
import { createHandleProtocol } from './lib/protocol/handle-protocol.mjs'
import { createResponsesWsHandler } from './lib/protocol/responses-ws.mjs'
import { handleUserCountTokens, handleUserUsage } from './lib/protocol/user-count-tokens.mjs'
import { createPanelHandler } from './lib/admin/panel-routes.mjs'
import { isKubernetesMode, shutdownTimeoutMs } from './lib/core/control-plane-mode.mjs'
import { ControlPlaneLifecycle, withTimeout } from './lib/core/control-plane-lifecycle.mjs'
import { ControlPlaneLock } from './lib/db/control-plane-lock.mjs'

const FEATURES = [
  'passthrough',
  'stream',
  'verified-stream',
  'protocol-convert',
  'go-slot-worker',
  'account-pool-failover',
  'tools',
  'client-workspace',
  'api-direct-kernel',
  'count_tokens',
  'account_usage',
]
const LIMITATIONS = {
  client_tools: 'kept in native Messages and executed by the caller',
  images: 'all native Messages image blocks are forwarded by the Go slot worker',
  multi_turn_native: 'full Messages history is preserved for every account attempt',
  claude_session: 'sticky commits only after a terminally verified response',
  kernel: 'one Docker container and one long-lived Go worker per slot; not a KVM guest',
  workspace: 'client only; VM/Claude-CLI inference has been removed',
  forward: 'Rust kernel uses slot egress (SOCKS5 or local) with no Go hop',
  oauth: 'the Go slot worker Refresher.Ensure is the sole refresh manager and uses the same slot SOCKS5',
  realtime_stream:
    'account failover stops after the first downstream business event; verified mode buffers to message_stop',
}

const cfg = loadConfig()
if (!getPanelAdmin().password) {
  throw new Error('VM2API_ADMIN_PASSWORD must be set; insecure default panel credentials are disabled')
}
const kubernetesMode = isKubernetesMode()
const shutdownGraceMs = shutdownTimeoutMs()

const allowRate = createRateLimiter({
  capacity: cfg.limits.rate_capacity,
  refillPerSec: cfg.limits.rate_refill,
})

// --- Persistent PostgreSQL store ---
const activeRequests = new Set()
let _shuttingDown = false
const dataDir = cfg.paths.data || path.join(cfg.paths.root, 'data')
const db = await openDatabase({ dataDir })
let controlPlaneLock = null
let startupAborting = false
const lifecycle = new ControlPlaneLifecycle({
  probe: () => db.prepare('SELECT 1').get(),
  lockHealthy: () => !kubernetesMode || controlPlaneLock?.healthy === true,
  isMaintaining: () => backupService.isMaintaining,
})
async function failStartup(error) {
  if (startupAborting) return
  startupAborting = true
  lifecycle.beginDrain()
  console.error(`[startup] failed: ${error?.code || error?.name || 'startup_failed'}`)
  const deadline = setTimeout(() => process.exit(1), 5000)
  try {
    await controlPlaneLock?.stop()
  } catch {}
  try {
    await closeDatabase()
  } catch {}
  clearTimeout(deadline)
  process.exit(1)
}
if (kubernetesMode) {
  process.once('uncaughtException', failStartup)
  process.once('unhandledRejection', failStartup)
  controlPlaneLock = new ControlPlaneLock(db, {
    onLost(error) {
      lifecycle.beginDrain()
      console.error('[control-plane] exclusive lock lost')
      if (!lifecycle.initialized) {
        void failStartup(error)
        return
      }
      void shutdown('control_plane_lock_lost', { failed: true })
    },
  })
  try {
    await controlPlaneLock.start()
  } catch (error) {
    await controlPlaneLock.stop()
    await closeDatabase()
    throw Object.assign(new Error(`Control plane startup failed: ${error.code || 'lock_unavailable'}`), {
      code: error.code || 'lock_unavailable',
    })
  }
}
fs.mkdirSync(cfg.paths.captures, { recursive: true })
const legacyImport = await runLegacyImport({ dataDir, projectRoot: cfg.paths.project })
if (legacyImport?.imported) {
  console.log('[db] legacy JSON import done:', JSON.stringify(legacyImport.counts || {}))
}
await loadSettingsState()
await loadModelPolicy()
await loadGptModelPolicy()
// VM/credential mirror: write-through hook + startup reconcile + fs.watch
const vmSync = await initVmDbSync(cfg.paths.project)
if (vmSync.upserted || vmSync.rebuilt) {
  console.log(`[db] vm mirror reconciled: upserted=${vmSync.upserted} rebuilt=${vmSync.rebuilt}`)
}
if (vmSync.proxy_cli_repaired) {
  console.log(`[vm] repaired proxy_cli_enabled on ${vmSync.proxy_cli_repaired} slot(s)`)
}
if (vmSync.reclaimed_vm_ids.length) {
  console.log(`[vm] reclaimed ${vmSync.reclaimed_vm_ids.length} slot(s) assigned to deleted users`)
}

// --- P3 sticky + quota ---

const routingConfigPath = routingConfigFile(cfg.paths.project)
let healthMonitor = null
let credentialRefreshMonitor = null
let kernelWatchdog = null
let cliNodeGuard = null
let usageProbeMonitor = null
let catalogMonitor = null
let notifyMonitor = null

let routingConfig = {}

let stickyRouter
let accountQuota
let requestLog
let proxyPool
let runtimeRepo
let attemptsRepo
let poolScheduler
let failoverRunner
let groupsRepo

const routingRt = createRoutingRuntime({
  get routingConfig() {
    return routingConfig
  },
  set routingConfig(v) {
    routingConfig = v
  },
  getRoutingConfig: () => routingConfig,
  setRoutingConfig: (v) => {
    routingConfig = v
  },
  cfg,
  routingConfigPath,
  get requestLog() {
    return requestLog
  },
  get stickyRouter() {
    return stickyRouter
  },
  get accountQuota() {
    return accountQuota
  },
  get poolScheduler() {
    return poolScheduler
  },
  setPoolScheduler: (v) => {
    poolScheduler = v
  },
  get healthMonitor() {
    return healthMonitor
  },
  setHealthMonitor: (v) => {
    healthMonitor = v
  },
  get credentialRefreshMonitor() {
    return credentialRefreshMonitor
  },
  get kernelWatchdog() {
    return kernelWatchdog
  },
  get usageProbeMonitor() {
    return usageProbeMonitor
  },

  get notifyMonitor() {
    return notifyMonitor
  },
  get failoverRunner() {
    return failoverRunner
  },
  setFailoverRunner: (v) => {
    failoverRunner = v
  },
  get runtimeRepo() {
    return runtimeRepo
  },
  setRuntimeRepo: (v) => {
    runtimeRepo = v
  },
  get attemptsRepo() {
    return attemptsRepo
  },
  setAttemptsRepo: (v) => {
    attemptsRepo = v
  },
  get proxyPool() {
    return proxyPool
  },
  // Lazy: the monitor is built after the runtime. An unknown 429 asks for one
  // /usage hop through the same single-flight, bounded queue as the timer.
  probeUsageOne: (vmId) => usageProbeMonitor?.probeNow?.(vmId, 'rate_limited_unknown'),
})

const {
  persistRoutingPatch,
  loadRoutingConfig,
  syncTierDefaultsIntoRouting,
  initPoolRuntime,
  poolSchedulerConfig,
  applyRoutingTierConcurrency,
  applyVmConcurrency,
  applyVmRpm,
  applyVmSessionSlots,
  applyVmMaxSessions,
  inheritVmScheduling,
  applyVmQuotaOverride,
  migrateLegacyOpenAIPolicies,
} = routingRt

routingConfig = loadRoutingConfig()
migrateLegacyOpenAIPolicies(routingConfig)
setManualScheduleWins(routingConfig.pool?.manual_schedule_wins)
if (routingConfig.official_cc) {
  routingConfig.official_cc = normalizeOfficialCcConfig(routingConfig.official_cc)
}
routingConfig.health_probe = normalizeHealthProbeConfig(routingConfig.health_probe)
routingConfig.usage_probe = normalizeUsageProbeConfig(routingConfig.usage_probe)
routingConfig.notify = normalizeNotifyConfig(routingConfig.notify)
routingConfig.tiers = normalizeTiers(routingConfig.tiers, routingConfig.quota, routingConfig.concurrency)
syncTierDefaultsIntoRouting()
stickyRouter = await new StickyRouter({ dataDir, config: routingConfig }).init()
accountQuota = new AccountQuota({
  dataDir,
  config: routingConfig,
  accounts: listVms(cfg.paths.project).map((v) => ({
    account_id: v.account_uuid || v.id,
    vm_id: v.id,
    email: v.email,
    type: normalizeCredentialMode(v.credential_mode),
    max_concurrency: v.policy?.maxConcurrency ?? routingConfig?.concurrency?.default_max_per_account ?? 2,
    max_rpm: v.policy?.maxRpm ?? routingConfig?.concurrency?.default_max_rpm ?? 0,
  })),
})
await accountQuota.init()
accountQuota.loadVmQuotaOverrides(listVms(cfg.paths.project))

const apiKeyStore = new ApiKeyStore({ dataDir: cfg.paths.data })
groupsRepo = new GroupsRepo()
const apiEndpointStore = new ApiEndpointStore({ dataDir: cfg.paths.data })
const apiScheduler = new ApiScheduler()
apiScheduler.reload(await apiEndpointStore.listRaw())
const panelUsers = new PanelUserStore({ dataDir: cfg.paths.data, projectRoot: cfg.paths.project })
try {
  await panelUsers.bootstrapFromEnv(getPanelAdmin())
} catch (e) {
  console.warn('[panel-users] bootstrap failed', e?.message || e)
}
attachPanelAuth({
  authenticate: async (username, password) => await panelUsers.authenticate(username, password),
  lookupRole: async (username) => (await panelUsers.getByUsername(username))?.role || null,
})
requestLog = new RequestLogStore({
  dataDir: cfg.paths.data,
  mode: process.env.KIN_REQUEST_LOG_MODE || routingConfig?.logging?.mode || 'normal',
})
if (routingConfig?.logging) {
  await requestLog.setConfig({
    // Env wins at boot so e2e / ops can force off|debug. Panel PUT still hot-updates.
    mode: process.env.KIN_REQUEST_LOG_MODE || routingConfig.logging.mode,
    retainDays: routingConfig.logging.retain_days,
    debugRetainDays: routingConfig.logging.debug_retain_days,
    maxMb: routingConfig.logging.max_mb,
    mutedErrorClasses: routingConfig.logging.muted_error_classes,
  })
}
try {
  await requestLog.cleanup()
} catch {}
requestLog.startCleanupScheduler()

// Set once the cluster manager exists; node local rows probe through it.
let localEgressCluster = null
proxyPool = new ProxyPool({
  dataDir,
  // null = control plane; undefined = no such slot.
  vmNodeOf: (vmId) => {
    const vm = getVm(cfg.paths.project, vmId)
    return vm ? vm.node_id || null : undefined
  },
  localExitUrl: (nodeId) => nodeEgressProxyUrl(nodeId),
  localExitHealth: (nodeId) => {
    // Boot order: the first probe may run before the cluster is up. Unknown, not down.
    if (!localEgressCluster) return { ok: true, latency_ms: null }
    const node = localEgressCluster.get(nodeId)
    const state = node.link?.state || 'idle'
    if (state === 'ready') return { ok: true, latency_ms: node.health?.latency_ms ?? null }
    // Still dialling (boot, reconnect): no verdict; the link-state hook re-probes once it settles.
    if (state === 'idle' || state === 'connecting') return { pending: true, error: `node_link_${state}` }
    return { ok: false, error: `node_link_${state}` }
  },
  onDisableVm: (vmId, reason, proxyId) => {
    setVmSchedulable(cfg.paths.project, vmId, false, `${reason}|proxy=${proxyId}`)
  },
  onDisconnectVm: (vmId, reason, proxyId) => {
    setVmSchedulable(cfg.paths.project, vmId, false, `${reason}|proxy=${proxyId}`)
  },
  onEnableVm: (vmId, _reason, proxyId) => {
    const vm = getVm(cfg.paths.project, vmId)
    const why = String(vm?.schedule_disabled_reason || '')
    if (!why.includes(`proxy=${proxyId}`) && !/egress_down|proxy_probe_failed/.test(why)) return
    setVmSchedulable(cfg.paths.project, vmId, true)
  },
  egressCheck: (proxy) => proxyEgressReady(proxy, cfg.paths.project),
  repairEgress: async (proxy) => await ensureProxyEgress(cfg.paths.project, proxy),
})
await proxyPool.init()
// An upgrade replaces bin/ files; slots mounting data/run/slot-guest-bin must see the new ones.
try {
  refreshSlotGuestBinDir(cfg.paths.project)
} catch (err) {
  console.warn('[bootstrap] slot-guest-bin refresh failed:', err?.message || err)
}
proxyPool.startScheduler()

// 首次安装的出口池是空的，槽没有可绑出口就起不来。本机出口永远成立，先补上。
try {
  if (!proxyPool.snapshot().proxies?.length) {
    const seeded = await proxyPool.ensureLocal()
    if (seeded.created) {
      void (await ensureProxyEgress(cfg.paths.project, proxyPool.getProxyByIdWithAuth(seeded.proxy.id)))
      console.log('[bootstrap] seeded local egress px-local')
    }
  }
} catch (e) {
  console.warn('[bootstrap] local egress seed failed', e?.message || e)
}

await initPoolRuntime()
try {
  applyRoutingTierConcurrency(routingConfig.tiers)
} catch (e) {
  console.warn('[quota] apply tier concurrency failed', e?.message || e)
}

function accountForUsageProbe(vm) {
  const keys = [vm?.claude?.account_uuid, vm?.account_uuid, vm?.id].filter(Boolean)
  for (const key of keys) {
    try {
      const acc = accountQuota.repo.get(key)
      if (acc) return acc
    } catch {}
  }
  try {
    return accountQuota.repo.list().find((a) => a.vm_id === vm.id) || null
  } catch {
    return null
  }
}

const USAGE_ACTIVE_WINDOW_MS = 5 * 3600_000

/** Serving traffic within one 5h window, or still holding pinned conversations (#163). */
function usageProbeActive(vm, account) {
  if (isCodexVm(vm)) return false
  const id = account?.account_id || vm?.claude?.account_uuid || vm?.account_uuid || vm?.id
  const lastUsed = Number(poolScheduler?.lastUsed?.get?.(id) || runtimeRepo?.get?.(id)?.last_used_at || 0)
  if (lastUsed && Date.now() - lastUsed < USAGE_ACTIVE_WINDOW_MS) return true
  return (stickyRouter?.boundKeys?.({ accountId: id, vmId: vm?.id }) || []).length > 0
}

function attachSlotRuntime(vm) {
  const acc = accountForUsageProbe(vm)
  const keys = [acc?.account_id, vm?.claude?.account_uuid, vm?.account_uuid, vm?.id].filter(Boolean)
  for (const key of keys) {
    try {
      const rt = accountQuota.runtimeRepo?.get?.(key)
      if (rt) {
        return {
          ...vm,
          cooldown_until: rt.cooldown_until || 0,
          cooldown_reason: rt.cooldown_reason || null,
        }
      }
    } catch {}
  }
  return vm
}

healthMonitor = createHealthProbeMonitor({
  config: routingConfig.health_probe,
  listTargets: () => listVms(cfg.paths.project).map(attachSlotRuntime),
  runChat: async (vm, real) =>
    await runVmTestChat({
      projectRoot: cfg.paths.project,
      vmId: vm.id,
      model: real.model,
      prompt: real.prompt,
      max_tokens: real.max_tokens,
      timeoutMs: real.timeout_ms,
      personaMode: 'overwrite',
      baseUrl: `http://127.0.0.1:${cfg.port}`,
      apiKey: cfg.api_key,
      unofficial: false,
      extraHeaders: { [HEALTH_REAL_HEADER]: '1' },
    }),
})
const vmTestSchedule = new VmTestScheduleRunner({
  projectRoot: cfg.paths.project,
  settings: () => new SettingsRepo(),
  list: () => listVms(cfg.paths.project),
  runTest: async (vmId, params) =>
    await runVmTestChat({
      projectRoot: cfg.paths.project,
      vmId,
      ...params,
      baseUrl: `http://127.0.0.1:${cfg.port}`,
      apiKey: cfg.api_key,
      accountQuota,
    }),
})
credentialRefreshMonitor = createCredentialRefreshMonitor({
  config: normalizeCredentialRefreshConfig(routingConfig.credential_refresh),
  listTargets: () =>
    listVms(cfg.paths.project).map((vm) => {
      let lastProbe = vm.last_probe || null
      try {
        const acc = accountQuota?.repo?.get?.(vm.account_uuid || vm.id)
        lastProbe = acc?.unified?.last_probe || acc?.last_probe || lastProbe
      } catch {}
      return { ...vm, last_probe: lastProbe }
    }),
  refreshOne: async (vm) =>
    await refreshWorkerCredentialForVm({
      vmId: vm.id,
      vmPath: path.join(cfg.paths.project, 'vms', `${vm.id}.json`),
      homeDir: path.join(cfg.paths.project, 'vms', vm.id, 'cli-home'),
      vm: getVm(cfg.paths.project, vm.id) || vm,
      force: false,
    }),
})
async function bootSlot(id) {
  return await powerOnSlot({ projectRoot: cfg.paths.project, id, proxyPool, routing: routingConfig })
}
kernelWatchdog = createKernelWatchdog({
  config: routingConfig.kernel_watchdog,
  listTargets: () => listVms(cfg.paths.project),
  getRouting: () => routingConfig,
  homeDirFor: (vm) => path.join(cfg.paths.project, 'vms', vm.id, 'cli-home'),
  ensureTelemetry: async (vm) => await ensureTelemetrySidecar({ projectRoot: cfg.paths.project, vm }),
  revive: async (vm) => await bootSlot(vm.id),
  healBridges: createSlotBridgeHealer({ projectRoot: cfg.paths.project }),
  onFault: async (vm, reason) => {
    const title = `槽内核故障 ${vm.id}`
    await dispatchNotify(routingConfig.notify, {
      title,
      text: `【KIN】${title}\n\n${reason}\n已停止调度该槽；内核恢复健康后自动恢复调度。`,
      subject: `KIN · ${title}`,
    }).catch((error) => console.warn('[kernel-watchdog] notify failed', error?.message || error))
  },
})

usageProbeMonitor = createUsageProbeMonitor({
  config: routingConfig.usage_probe,
  listTargets: () => listVms(cfg.paths.project),
  accountForVm: accountForUsageProbe,
  isActive: usageProbeActive,
  reconcile: (vm, account) => {
    const id = account?.account_id || vm?.claude?.account_uuid || vm?.account_uuid || vm?.id
    if (isCodexVm(vm)) {
      try {
        syncCodexQuotaSchedule(cfg.paths.project, getVm(cfg.paths.project, vm.id) || vm, {
          policy: routingConfig.codex?.quota,
        })
      } catch {}
      return
    }
    try {
      accountQuota.persistEffectiveWindows(id)
    } catch {}
    try {
      poolScheduler.syncQuotaSchedule(vm, account)
    } catch {}
  },
  probeOne: async (vm) => await panel.buildProbeOne({ cfg, accountQuota, id: vm.id, routingConfig }),
})
catalogMonitor = createCatalogMonitor({
  projectRoot: cfg.paths.project,
  codexCatalogVersion: () => routingConfig.codex?.catalog_client_version || 'auto',
  log: (event) => console.log(JSON.stringify(event)),
})
notifyMonitor = createNotifyMonitor({
  config: routingConfig.notify,
  baseUrl: cfg.base_url,
  snapshot: async () =>
    await panel.snapshotAccountPool({
      cfg,
      accountQuota,
      routingConfig,
      poolScheduler,
      proxyPool,
      requestLog,
    }),
})

// --- Local backup service (auto schedule default ON; no S3 by design) ---
const backupService = new BackupService({
  dataDir,
  projectRoot: cfg.paths.project,
  configDir: path.dirname(routingConfigPath),
})
backupService.onRestored(async (db) => {
  await loadSettingsState(db)
  await loadModelPolicy({ force: true })
  await loadGptModelPolicy({ force: true })
  // A restore swaps the database pool and routing files. Rebuild every
  // holder before reporting success; otherwise requests keep stale snapshots
  // or silently write through statements owned by the closed connection.
  for (const store of [apiKeyStore, apiEndpointStore, panelUsers, accountQuota, stickyRouter, proxyPool, requestLog]) {
    await store.rebind(db)
  }
  groupsRepo = new GroupsRepo(db)
  apiScheduler.reload(await apiEndpointStore.listRaw())

  routingConfig = loadRoutingConfig()
  migrateLegacyOpenAIPolicies(routingConfig)
  setManualScheduleWins(routingConfig.pool?.manual_schedule_wins)
  if (routingConfig.official_cc) {
    routingConfig.official_cc = normalizeOfficialCcConfig(routingConfig.official_cc)
  }
  routingConfig.health_probe = normalizeHealthProbeConfig(routingConfig.health_probe)
  routingConfig.usage_probe = normalizeUsageProbeConfig(routingConfig.usage_probe)
  routingConfig.notify = normalizeNotifyConfig(routingConfig.notify)
  routingConfig.tiers = normalizeTiers(routingConfig.tiers, routingConfig.quota, routingConfig.concurrency)
  syncTierDefaultsIntoRouting()

  stickyRouter.reloadConfig(routingConfig)
  accountQuota.reloadConfig(routingConfig)
  accountQuota.loadVmQuotaOverrides(listVms(cfg.paths.project))
  await requestLog.setConfig({
    mode: process.env.KIN_REQUEST_LOG_MODE || routingConfig.logging?.mode,
    retainDays: routingConfig.logging?.retain_days,
    debugRetainDays: routingConfig.logging?.debug_retain_days,
    maxMb: routingConfig.logging?.max_mb,
    mutedErrorClasses: routingConfig.logging?.muted_error_classes,
  })
  healthMonitor?.setConfig(routingConfig.health_probe)
  credentialRefreshMonitor?.setConfig(normalizeCredentialRefreshConfig(routingConfig.credential_refresh))
  kernelWatchdog?.setConfig(normalizeKernelWatchdogConfig(routingConfig.kernel_watchdog))
  usageProbeMonitor?.setConfig(routingConfig.usage_probe)
  notifyMonitor?.setConfig(routingConfig.notify)

  await initPoolRuntime()
  await clusterManager.rebind(db)
  reloadActiveVm(cfg)
  await vmTestSchedule.reload()
})
backupService.onMaintenance(async (enabled) => {
  if (enabled) {
    vmTestSchedule.stop()
    proxyPool.stopScheduler()
    requestLog.stopCleanupScheduler()
    for (const monitor of maintenanceMonitors()) await monitor?.stop?.()
    while ([...activeRequests].some((request) => !/\/(?:backups)(?:\/|$)/.test(String(request.url || '')))) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    for (const monitor of maintenanceMonitors()) await monitor?.flush?.()
    await vmTestSchedule.flush()
    await pausePriceCatalog()
    await flushRuntimeWrites()
    await pauseVmDbSync()
  } else {
    if (_shuttingDown) return
    resumeVmDbSync()
    resumePriceCatalog()
    for (const monitor of maintenanceMonitors()) await monitor?.start?.({ immediate: false })
    proxyPool.startScheduler()
    requestLog.startCleanupScheduler()
    await vmTestSchedule.start()
  }
})
await backupService.startScheduler()

const stats = {
  requests: 0,
  passthrough: 0,
  convert: 0,
  rewrite: 0,
  stream: 0,
  errors: 0,
  by_route: {},
}

function credentialRefreshClass(result) {
  return classifyCredentialRefresh(result)
}

function publicCredentialRefreshResult(vmId, result, { force = false } = {}) {
  const refreshClass = credentialRefreshClass(result)
  const credential = result?.credential || {}
  const out = {
    ok: !!result?.ok,
    vm_id: vmId,
    refresh_owner: 'go-slot-worker',
    proxy_required: true,
    force: !!force,
    refreshed: !!result?.refreshed,
    shared: !!result?.shared,
    refresh_class: refreshClass,
    credential: {
      has_access: !!credential.has_access,
      has_refresh: !!credential.has_refresh,
      needs_refresh: !!credential.needs_refresh,
      expires_at: credential.expires_at ?? null,
      ttl_seconds: credential.ttl_seconds ?? null,
      generation: credential.generation ?? null,
    },
  }
  if (!result?.ok) {
    out.error = {
      code: result?.error?.code || 'credential_refresh_failed',
      message:
        refreshClass === 'fatal'
          ? 'OAuth credential was rejected'
          : refreshClass === 'retryable'
            ? 'OAuth credential refresh is temporarily unavailable'
            : 'OAuth credential refresh failed',
    }
  }
  return out
}

async function refreshWorkerCredentialForVm({ vmId, vmPath, homeDir, vm, force = false }) {
  // Host RefreshIfNeeded is the credential writer. Slot workers only read AT.
  const result = await ensureWorkerCredential({ vmId, vm, homeDir }, { force: !!force })

  const published = publicCredentialRefreshResult(vmId, result, { force })
  if (result.ok) {
    try {
      mirrorWorkerCredentialsToVm(vmPath, homeDir, { acceptLiveGrant: true })
    } catch {}
    try {
      invalidateLiveCredentialCache()
    } catch {}
    try {
      const accountId = vm?.claude?.account_uuid || vmId
      accountQuota.clearGrantRevokeLeftover(accountId)
      poolScheduler?.clearAuthCooldownFor?.(vmId, accountId)
      poolScheduler?.clearGrantRevokeCooldownFor?.(vmId, accountId)
    } catch {}
  } else if (published.refresh_class !== 'retryable') {
    try {
      markVmRefreshError(vmPath, result)
    } catch {}
    try {
      invalidateLiveCredentialCache()
    } catch {}
  }
  return published
}

const {
  json: sendJson,
  writeSSEHeaders,
  readBody,
  readRawBody,
} = createRespond(cfg, {
  tcpNodelay: () => routingConfig?.inference?.tcp_nodelay !== false,
})

function json(res, ...args) {
  if (res._panelResponseState) {
    res._panelResponseState.response = [res, ...args]
    return
  }
  return sendJson(res, ...args)
}

function rejectAuth(req, res, error) {
  req.authError = {
    code: error?.body?.error?.code || ErrorCode.INVALID_API_KEY,
    message: error?.body?.error?.message || 'Invalid credentials',
    status: error?.status || 401,
  }
  json(res, error.status, error.body)
  return false
}

async function requireAuth(req, res) {
  req.presentedApiKey = extractApiKey(req)
  const token = extractPanelToken(req) || req.presentedApiKey
  if (!token) {
    return rejectAuth(
      req,
      res,
      makeError({
        type: ErrorType.AUTH,
        code: ErrorCode.MISSING_API_KEY,
        message: 'Missing credentials. Login at /api/panel/login or provide Authorization Bearer token.',
        status: 401,
      }),
    )
  }
  if (kubernetesMode) {
    const snapshot = await new SettingsRepo().refresh()
    refreshModelPolicy(snapshot.model_policy)
    refreshGptModelPolicy(snapshot.gpt_model_policy)
    invalidatePriceCatalog()
    await accountQuota.refresh?.()
    await proxyPool.refresh?.()
    await runtimeRepo?.refresh?.()
    await stickyRouter?.refresh?.()
  }
  // Panel session
  const session = await verifyPanelSession(token)
  if (session) {
    if (!(await allowRate('panel:' + session.user))) {
      return rejectAuth(
        req,
        res,
        makeError({
          type: ErrorType.RATE_LIMIT,
          code: ErrorCode.GATEWAY_RATE_LIMIT,
          message: 'Gateway rate limit exceeded. Retry later.',
          status: 429,
        }),
      )
    }
    req.panelUser = session.user
    req.panelRole = session.role || (await panelUsers.getByUsername(session.user))?.role || 'user'
    const rec = await panelUsers.getByUsername(session.user)
    req.panelUserId = rec?.id || null
    req.panelVmCreateQuota = rec?.vm_create_quota ?? 0
    return true
  }
  // Master env API key — unlimited admin
  if (timingSafeEqualStr(token, cfg.api_key)) {
    if (!(await allowRate(token))) {
      return rejectAuth(
        req,
        res,
        makeError({
          type: ErrorType.RATE_LIMIT,
          code: ErrorCode.GATEWAY_RATE_LIMIT,
          message: 'Gateway rate limit exceeded. Retry later.',
          status: 429,
        }),
      )
    }
    req.apiKeyKind = 'master'
    req.panelRole = 'admin'
    req.panelUser = 'master'
    return true
  }

  // Managed multi-keys (sub2api-style)
  const managed = await apiKeyStore.authenticate(token)
  if (!managed.ok) {
    return rejectAuth(
      req,
      res,
      makeError({
        type: ErrorType.AUTH,
        code: ErrorCode.INVALID_API_KEY,
        message: 'Invalid credentials',
        status: 401,
      }),
    )
  }
  const gate = await apiKeyStore.canAccept(managed.record)
  if (!gate.ok) {
    const type =
      gate.status === 429
        ? gate.code.includes('quota')
          ? ErrorType.QUOTA
          : ErrorType.RATE_LIMIT
        : ErrorType.PERMISSION
    return rejectAuth(
      req,
      res,
      makeError({
        type,
        code: gate.code,
        message: gate.message,
        status: gate.status,
        details: gate.detail || undefined,
      }),
    )
  }
  if (!(await allowRate(token))) {
    return rejectAuth(
      req,
      res,
      makeError({
        type: ErrorType.RATE_LIMIT,
        code: ErrorCode.GATEWAY_RATE_LIMIT,
        message: 'Gateway rate limit exceeded. Retry later.',
        status: 429,
      }),
    )
  }
  req.apiKeyKind = 'managed'
  req.apiKeyRecord = managed.record
  return true
}

function fetchWorkerModels(opts) {
  return gatewayModelCatalog(opts)
}

const importCommit = createImportCommit({
  cfg,
  routingConfigPath,
  getRoutingConfig: () => routingConfig,
  get routingConfig() {
    return routingConfig
  },
  get accountQuota() {
    return accountQuota
  },
  get poolScheduler() {
    return poolScheduler
  },
  get proxyPool() {
    return proxyPool
  },
  applyVmConcurrency,
})

const { commitImportedOauth, requireSlotProxy, officialCcStatsHandler } = importCommit

const protocolHandlers = createHandleProtocol({
  json,
  writeSSEHeaders,
  readBody,
  requireAuth,
  cfg,
  requestLog,
  stickyRouter,
  accountQuota,
  apiKeyStore,
  apiScheduler,
  apiEndpointStore,
  stats,
  routingConfigPath,
  getRoutingConfig: () => routingConfig,
  get routingConfig() {
    return routingConfig
  },
  getHealthMonitor: () => healthMonitor,
  get healthMonitor() {
    return healthMonitor
  },
  getFailoverRunner: () => failoverRunner,
  get failoverRunner() {
    return failoverRunner
  },
  getPoolScheduler: () => poolScheduler,
  get poolScheduler() {
    return poolScheduler
  },
  get groupsRepo() {
    return groupsRepo
  },
})

async function dispatchProtocol(name, req, res, ...args) {
  if (lifecycle.draining || (kubernetesMode && controlPlaneLock?.healthy !== true)) {
    return json(res, 503, {
      error: { type: 'overloaded_error', code: 'control_plane_draining', message: 'Control plane is draining' },
    })
  }
  if (backupService.isMaintaining) {
    return json(res, 503, {
      error: { type: 'overloaded_error', code: 'maintenance_in_progress', message: 'Database maintenance in progress' },
    })
  }
  activeRequests.add(req)
  try {
    return await protocolHandlers[name](req, res, ...args)
  } finally {
    activeRequests.delete(req)
  }
}

const handleProtocol = async (...args) => await dispatchProtocol('handleProtocol', ...args)
const handleSearch = async (...args) => await dispatchProtocol('handleSearch', ...args)

const responsesWs = createResponsesWsHandler({
  handleProtocol,
  requireAuth,
  json,
  getRouting: () => routingConfig,
  maxBodyBytes: cfg.limits.max_body_bytes,
})

/**
 * One local egress row per VPS: rows for current nodes, and slots still on
 * another machine's row (the shared px-local before per-node rows) move onto
 * their own node's row, with the slot's recorded proxy rewritten to match.
 */
async function syncNodeLocalEgress() {
  try {
    await proxyPool.syncLocalNodes(clusterManager.list().map((node) => node.id))
    for (const move of await proxyPool.adoptNodeLocalBindings()) {
      bindVmProxy(cfg.paths.project, move.vm_id, proxyPool.getProxyByIdWithAuth(move.to))
      console.log(`[local-egress] ${move.vm_id}: ${move.from} -> ${move.to}`)
    }
  } catch (e) {
    console.warn('[local-egress] node sync failed', e?.message || e)
  }
}

const clusterManager = new ClusterManager({
  repo: new ClusterNodesRepo(),
  dataDir,
  gateBin: process.env.KIN_CLUSTER_GATE_BIN || path.join(cfg.paths.project, 'bin', 'kin-slot-gate'),
  listen: { host: cfg.host, port: cfg.port },
  vmsOnNode: (nodeId) => listVms(cfg.paths.project).filter((vm) => vm.node_id === nodeId),
  assertNodeEditable: (nodeId) => {
    const busy = listVms(cfg.paths.project).some(
      (vm) =>
        vm.node_id === nodeId &&
        (Number(poolScheduler?.vmInflight?.get(vm.id) || 0) > 0 ||
          vmLockBusy(path.join(cfg.paths.project, 'vms', `${vm.id}.json`))),
    )
    if (busy || nodeImageBuildRunning(nodeId)) {
      throw new ClusterError(409, 'node_in_use', '节点仍有进行中的请求、虚拟机操作或镜像构建，请完成后重试')
    }
  },
  onNodesChanged: () => {
    if (!backupService.isMaintaining) syncNodeLocalEgress()
  },
  // A node's local row follows its link: re-probe as soon as the link settles.
  onLinkState: (nodeId, state) => {
    if (!backupService.isMaintaining && (state === 'ready' || state === 'error' || state === 'backoff')) {
      proxyPool.probeLocalNode(nodeId).catch(() => {})
    }
  },
})
localEgressCluster = clusterManager
bindPlacement({ manager: clusterManager, projectRoot: cfg.paths.project })
await startNodeEgressSocks({ clientFor: (nodeId) => clusterManager.client(nodeId) })
await clusterManager.start()
clusterManager.restoreSlotRelays()
await syncNodeLocalEgress()
if (proxyPool.snapshot().config.ipv6_enabled !== true) {
  const exits = await syncIpv6ProxyEgress(cfg.paths.project, proxyPool)
  for (const exit of exits.filter((item) => !item.ok)) {
    console.warn('[ipv6-policy] exit not blocked', exit.vm_id || exit.proxy_id, exit.error)
  }
}
const clusterRoutes = createClusterRoutes({ manager: clusterManager, json, readBody, ok: panel.ok })
const slotShell = createSlotShell({ projectRoot: cfg.paths.project, importOauth: commitImportedOauth })
for (const vm of listVms(cfg.paths.project)) {
  if (isCodexVm(vm)) continue
  try {
    ensureSlotSubscriptionType(path.join(cfg.paths.project, 'vms', vm.id, 'cli-home'), vm.account_tier)
  } catch (error) {
    console.warn('[credential-subscription]', vm.id, error?.message || error)
  }
}
cliNodeGuard = createCliNodeGuard({
  listTargets: () => listVms(cfg.paths.project),
  liveTokens: () => slotShell.liveShellTokens?.() || [],
})

const handlePanel = createPanelHandler({
  onPersistenceFailure: async () => {
    backupService.isMaintaining = true
    vmTestSchedule.stop()
    proxyPool.stopScheduler()
    requestLog.stopCleanupScheduler()
    stopVmWatch()
    for (const monitor of maintenanceMonitors()) await monitor?.stop?.()
  },
  json,
  writeSSEHeaders,
  readBody,
  readRawBody,
  requireAuth,
  cfg,
  routingConfigPath,
  get routingConfig() {
    return routingConfig
  },
  set routingConfig(v) {
    routingConfig = v
  },
  stickyRouter,
  accountQuota,
  get poolScheduler() {
    return poolScheduler
  },
  get healthMonitor() {
    return healthMonitor
  },
  get usageProbeMonitor() {
    return usageProbeMonitor
  },
  get notifyMonitor() {
    return notifyMonitor
  },
  get kernelWatchdog() {
    return kernelWatchdog
  },
  get runtimeRepo() {
    return runtimeRepo
  },
  get groupsRepo() {
    return groupsRepo
  },
  getAttemptsRepo: () => attemptsRepo,
  get attemptsRepo() {
    return attemptsRepo
  },
  get proxyPool() {
    return proxyPool
  },
  apiKeyStore,
  apiEndpointStore,
  apiScheduler,
  panelUsers,
  requestLog,
  vmTestSchedule,
  backupService,
  stats,
  persistRoutingPatch,
  applyVmConcurrency,
  applyVmRpm,
  applyVmSessionSlots,
  applyVmMaxSessions,
  inheritVmScheduling,
  applyVmQuotaOverride,
  initPoolRuntime,
  poolSchedulerConfig,
  commitImportedOauth,
  requireSlotProxy,
  officialCcStatsHandler,
  refreshWorkerCredentialForVm,
  fetchWorkerModels,
  clusterRoutes,
  clusterManager,
  slotShell,
})

const sockets = new Set()
const server = http.createServer(async (req, res) => {
  const handlerFinished = lifecycle.trackHttp(req, res)
  activeRequests.add(req)
  try {
    res.req = req
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeadersForRequest(req))
      return res.end()
    }

    const url = parseRequestUrl(req)
    if (!url) {
      return json(res, 400, { error: { message: 'Invalid URL', type: 'invalid_request' } })
    }
    const p = url.pathname

    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/readyz') {
      const ready = await lifecycle.isReady()
      if (req.method === 'HEAD') {
        res.writeHead(ready ? 200 : 503)
        return res.end()
      }
      return json(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' })
    }
    if (
      (lifecycle.draining || (kubernetesMode && (!lifecycle.initialized || controlPlaneLock?.healthy !== true))) &&
      p !== '/healthz' &&
      p !== '/health'
    ) {
      return json(res, 503, {
        error: { type: 'overloaded_error', code: 'control_plane_draining', message: 'Control plane is draining' },
      })
    }

    if (isTelemetryPath(p)) {
      return json(res, 200, telemetryInterceptResponse(p))
    }

    if (
      backupService.isMaintaining &&
      p !== '/healthz' &&
      p !== '/health' &&
      !(req.method === 'POST' && /^\/(?:api\/panel|admin)\/backups\/[^/]+\/restore$/.test(p))
    ) {
      return json(
        res,
        503,
        makeError({
          type: ErrorType.OVERLOADED,
          code: backupService.isRestoring ? 'restore_in_progress' : 'maintenance_in_progress',
          message: 'Database maintenance in progress; retry shortly',
          status: 503,
        }).body,
      )
    }

    if (p.startsWith('/admin') || p.startsWith('/api/panel')) {
      const handled = await handlePanel(req, res, url)
      if (handled !== false) return
    }

    if (req.method === 'GET' && tryServeWebDist(res, cfg.paths.project, p)) return
    if (req.method === 'GET' && isConsoleEntry(p)) {
      return json(res, 404, { error: { message: 'console not found; run pnpm -C web build' } })
    }

    // CLIProxyAPI-style liveness: no auth, no inference.
    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/healthz') {
      if (req.method === 'HEAD') {
        res.writeHead(200)
        return res.end()
      }
      return json(res, 200, { status: 'ok' })
    }

    if (req.method === 'GET' && (p === '/' || p === '/health')) {
      return json(res, 200, {
        status: 'ok',
        service: 'vm2api',
        base_url: cfg.base_url,
        rewrite: cfg.rewrite.enabled ? 'on' : 'off',
        intercept_rules: cfg.intercept.rules.length,
        active_vm: getActiveVmId(cfg.paths.project),
        features: FEATURES,
        capabilities: GATEWAY_CAPABILITIES,
        limitations: LIMITATIONS,
        stats,
        health_probe: healthMonitor?.getSnapshot?.() || null,
        api_kernel: {
          ...apiKernelSnapshot(cfg),
          endpoints: (await apiEndpointStore.listRaw()).filter((ep) => !ep.disabled).length,
        },
      })
    }

    if (req.method === 'GET' && p === '/v1/meta') {
      return json(res, 200, {
        base_url: cfg.base_url,
        rewrite_default: cfg.rewrite.enabled,
        features: FEATURES,
        capabilities: GATEWAY_CAPABILITIES,
        limitations: LIMITATIONS,
        endpoints: {
          chat_completions: '/v1/chat/completions',
          responses: '/v1/responses',
          messages: '/v1/messages',
          count_tokens: '/v1/messages/count_tokens',
          usage: '/v1/usage',
          models: '/v1/models',
          intercept_rules: '/admin/intercept/rules',
        },
        vm: { id: cfg.vm.id, email: cfg.vm.email },
      })
    }

    if (req.method === 'GET' && p === '/v1/models') {
      if (!(await requireAuth(req, res))) return
      if (resolveInferenceBackend(req) === 'api') {
        apiScheduler.reload(await apiEndpointStore.listRaw())
        return json(res, 200, apiScheduler.catalog())
      }
      const result = await fetchWorkerModels({ groupType: (await keyScopeFromRequest(req)).group_type })
      return json(res, 200, result)
    }
    if (req.method === 'POST' && p === '/admin/models/refresh') {
      if (!(await requireAuth(req, res))) return
      const result = await fetchWorkerModels()
      return json(res, 200, result)
    }
    if (req.method === 'GET' && p === '/v1/usage') {
      return await handleUserUsage(req, res, {
        json,
        requireAuth,
        stickyRouter,
        accountQuota,
        getPoolScheduler: () => poolScheduler,
      })
    }
    if (req.method === 'POST' && (p === '/v1/messages/count_tokens' || p === '/messages/count_tokens')) {
      return await handleUserCountTokens(req, res, {
        json,
        readBody,
        requireAuth,
        cfg,
        stickyRouter,
        accountQuota,
        getPoolScheduler: () => poolScheduler,
        getRoutingConfig: () => routingConfig,
      })
    }

    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions')) {
      return await handleProtocol(req, res, 'openai.chat', p)
    }
    if (req.method === 'POST' && (p === '/v1/completions' || p === '/completions')) {
      return await handleProtocol(req, res, 'openai.completions', p)
    }
    if (req.method === 'POST' && (p === '/v1/responses' || p === '/responses')) {
      return await handleProtocol(req, res, 'openai.responses', p)
    }
    if (req.method === 'GET' && (p === '/v1/responses' || p === '/responses')) {
      return json(res, 426, {
        error: {
          type: 'invalid_request_error',
          code: 'websocket_upgrade_required',
          message: 'WebSocket upgrade required',
        },
      })
    }
    if (req.method === 'POST' && (p === '/v1/messages' || p === '/messages')) {
      return await handleProtocol(req, res, 'anthropic.messages', p)
    }
    if (req.method === 'POST' && (p === '/v1/alpha/search' || p === '/alpha/search')) {
      return await handleSearch(req, res, p)
    }

    json(res, 404, { error: { message: `not found: ${p}` } })
  } catch (e) {
    stats.errors++
    const status = e.status || 500
    if (!res.headersSent) {
      json(res, status, { error: { message: e.message || String(e), type: 'server_error' } })
    } else {
      try {
        res.end()
      } catch {}
    }
  } finally {
    activeRequests.delete(req)
    handlerFinished()
  }
})

server.on('connection', (socket) => {
  sockets.add(socket)
  socket.once('close', () => {
    sockets.delete(socket)
  })
})

server.on('upgrade', async (req, socket, head) => {
  if (
    lifecycle.draining ||
    (kubernetesMode && (!lifecycle.initialized || controlPlaneLock?.healthy !== true)) ||
    backupService.isMaintaining
  ) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
    return
  }
  if (await responsesWs.handleUpgrade(req, socket, head)) return
  if (clusterRoutes.handleUpgrade(req, socket, head)) return
  if (!slotShell.handleUpgrade(req, socket, head)) socket.destroy()
})

server.on('clientError', (err, socket) => {
  try {
    console.error(
      JSON.stringify({
        event: 'http_client_error',
        code: err?.code || null,
        message: String(err?.message || err).slice(0, 200),
      }),
    )
  } catch {}
  if (!socket || !socket.writable) {
    try {
      socket?.destroy()
    } catch {}
    return
  }
  socket.end(
    'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"error":{"type":"invalid_request_error","message":"malformed request"}}\n',
  )
})

const publicEndpoint = (suffix) => (cfg.base_url ? `${cfg.base_url}${suffix}` : null)

const pub = {
  base_url: cfg.base_url,
  api_key_set: !!cfg.api_key,
  rewrite_default: false,
  vm_id: cfg.vm.id,
  version: '2.1',
  features: FEATURES,
  capabilities: GATEWAY_CAPABILITIES,
  limitations: LIMITATIONS,
  endpoints: {
    health: publicEndpoint('/health'),
    chat: publicEndpoint('/v1/chat/completions'),
    responses: publicEndpoint('/v1/responses'),
    messages: publicEndpoint('/v1/messages'),
    count_tokens: publicEndpoint('/v1/messages/count_tokens'),
    usage: publicEndpoint('/v1/usage'),
    intercept_rules: publicEndpoint('/admin/intercept/rules'),
  },
}
// Never persist the raw API key. Public snapshot only.
fs.writeFileSync(path.join(cfg.paths.root, 'config', 'gateway-v2.public.json'), JSON.stringify(pub, null, 2))

process.on('uncaughtException', (e) => console.error('[uncaught]', e))
process.on('unhandledRejection', (e) => console.error('[unhandled]', e))

// Graceful shutdown: stop schedulers/watchers, drain persistence, close the pool.
async function shutdown(signal, { failed = false } = {}) {
  if (_shuttingDown) return
  _shuttingDown = true
  lifecycle.beginDrain()
  responsesWs.beginDrain()
  clusterRoutes.beginDrain()
  slotShell.beginDrain()
  console.log(`[shutdown] ${signal} — closing`)
  const deadline = Date.now() + shutdownGraceMs
  const forceClose = () => {
    lifecycle.forceClose()
    responsesWs.terminate()
    clusterRoutes.terminate()
    slotShell.terminate()
    server.closeAllConnections?.()
    for (const socket of sockets) socket.destroy()
  }
  const hardStop = setTimeout(() => {
    console.error('[shutdown] cleanup deadline exceeded')
    forceClose()
    process.exit(1)
  }, shutdownGraceMs + 5000)
  try {
    vmTestSchedule.stop()
  } catch {}
  try {
    backupService.stopScheduler()
  } catch {}
  try {
    proxyPool.stopScheduler()
  } catch {}
  try {
    healthMonitor?.stop?.()
  } catch {}
  try {
    credentialRefreshMonitor?.stop?.()
  } catch {}
  try {
    kernelWatchdog?.stop?.()
  } catch {}
  try {
    cliNodeGuard?.stop?.()
  } catch {}
  try {
    usageProbeMonitor?.stop?.()
  } catch {}
  try {
    catalogMonitor?.stop?.()
  } catch {}

  try {
    notifyMonitor?.stop?.()
  } catch {}
  requestLog.stopCleanupScheduler()
  try {
    stopVmWatch()
  } catch {}
  const serverClosed = new Promise((resolve) => server.close(resolve))
  try {
    await withTimeout(
      Promise.all([
        serverClosed,
        lifecycle.waitForIdle(),
        responsesWs.drain(),
        clusterRoutes.drain(),
        slotShell.drain(),
      ]),
      shutdownGraceMs,
    )
  } catch {
    failed = true
    console.error('[shutdown] request drain deadline exceeded')
    forceClose()
  }
  try {
    await withTimeout(
      (async () => {
        // An interrupted connection can still be completing its cancellation or login import.
        await Promise.allSettled([
          lifecycle.waitForIdle(),
          responsesWs.drain(),
          clusterRoutes.drain(),
          slotShell.drain(),
        ])
        await backupService.flush()
        await pausePriceCatalog()
        for (const monitor of maintenanceMonitors()) await monitor?.flush?.()
        await vmTestSchedule.flush()
        await flushRuntimeWrites()
        stopAllRustKernels()
        await clusterManager.stop()
        await controlPlaneLock?.stop()
        await closeDatabase()
      })(),
      Math.max(1, deadline - Date.now()) + 5000,
    )
  } catch (error) {
    failed = true
    console.error(`[shutdown] persistence failed: ${error.code || error.name}`)
    forceClose()
    try {
      await withTimeout(controlPlaneLock?.stop(), 1000)
    } catch {}
  }
  clearTimeout(hardStop)
  process.exit(failed ? 1 : 0)
}
process.on('SIGTERM', async () => await shutdown('SIGTERM'))
process.on('SIGINT', async () => await shutdown('SIGINT'))

function maintenanceMonitors() {
  return [
    healthMonitor,
    credentialRefreshMonitor,
    kernelWatchdog,
    cliNodeGuard,
    usageProbeMonitor,
    catalogMonitor,
    notifyMonitor,
  ]
}

async function flushRuntimeWrites() {
  await poolScheduler?.flush?.()
  await requestLog.flush?.()
  await flushPendingWrites()
  await accountQuota.flush()
  await stickyRouter.flush()
  await proxyPool.flush()
  await runtimeRepo?.flush?.()
  await flushVmDbSync()
}

await bootApiKernel(cfg)

server.listen(cfg.port, cfg.host, async () => {
  try {
    await vmTestSchedule.start()
  } catch (e) {
    console.warn('[vm-test-schedule] start failed', e?.message || e)
  }
  try {
    healthMonitor?.start?.({ immediate: true })
  } catch (e) {
    console.warn('[health-probe] start failed', e?.message || e)
  }
  try {
    credentialRefreshMonitor?.start?.({ immediate: true })
  } catch (e) {
    console.warn('[credential-refresh] start failed', e?.message || e)
  }
  try {
    kernelWatchdog?.start?.({ immediate: true })
  } catch (e) {
    console.warn('[kernel-watchdog] start failed', e?.message || e)
  }
  // Boot fills what Docker's restart policy missed (removed or exited slot containers); off with the watchdog.
  if (process.env.KIN_CRS_MOCK !== '1' && normalizeKernelWatchdogConfig(routingConfig.kernel_watchdog).enabled) {
    reviveDownSlots({ vms: listVms(cfg.paths.project), powerOn: bootSlot, watchdog: kernelWatchdog }).catch((e) =>
      console.warn('[slot-revive] boot pass failed', e?.message || e),
    )
  }
  try {
    cliNodeGuard?.start?.({ immediate: true })
  } catch (e) {
    console.warn('[cli-node-guard] start failed', e?.message || e)
  }
  try {
    usageProbeMonitor?.start?.({ immediate: true })
  } catch (e) {
    console.warn('[usage-probe] start failed', e?.message || e)
  }
  // The KIN_CRS_MOCK harness promises no outbound network; catalogs stay on builtin data there.
  if (process.env.KIN_CRS_MOCK !== '1') {
    try {
      catalogMonitor?.start?.()
    } catch (e) {
      console.warn('[catalog-sync] start failed', e?.message || e)
    }
  }
  try {
    notifyMonitor?.start?.({ immediate: true })
  } catch (e) {
    console.warn('[notify] start failed', e?.message || e)
  }
  const addr = server.address()
  const boundPort = typeof addr === 'object' && addr ? addr.port : cfg.port
  try {
    const catalog = fetchWorkerModels()
    console.log(
      JSON.stringify({
        event: 'go-worker-model-catalog',
        source: catalog.source,
        total: Array.isArray(catalog.data) ? catalog.data.length : 0,
        vm_id: catalog.vm_id || null,
      }),
    )
  } catch (error) {
    console.warn('[worker-models] fetch failed', error.message)
  }
  lifecycle.markReady()
  process.off('uncaughtException', failStartup)
  process.off('unhandledRejection', failStartup)
  console.log(
    JSON.stringify({
      event: 'vm2api-started',
      port: boundPort,
      base_url: cfg.base_url,
      active_vm: getActiveVmId(cfg.paths.project),
      features: pub.features,
      capabilities: GATEWAY_CAPABILITIES,
      rewrite: cfg.rewrite.enabled,
    }),
  )
})
