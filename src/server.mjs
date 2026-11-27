/**
 * vm2api — Node control plane.
 * Inference data plane: one long-lived Go slot worker per VM
 * (slot SOCKS5 + OAuth owner + SSE terminal validation).
 * The gateway converts protocols, schedules the account pool with bounded
 * failover, and never talks to Anthropic on the inference path. After a live
 * OAuth import it may spawn official Claude Code once (slot SOCKS5) to seed
 * ~/.claude.json and complete a plan turn.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  CONTROLLER_DRAINING,
  CONTROLLER_STANDBY,
  handoverRole,
  setHandoverRole,
  setOverlap,
  markExclusive,
  deferredKeys,
  deferUntilExclusive,
} from './lib/core/handover.mjs'
import {
  createForeignLoad,
  exportLiveLoad,
  foreignLoadPath,
  startLoadReader,
  startLoadWriter,
} from './lib/pool/foreign-load.mjs'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { loadConfig, reloadActiveVm, routingConfigFile } from './lib/core/config.mjs'
import { createGeminiCragSubscription } from './lib/gemini/subscription.mjs'
import { createGeminiScheduler } from './lib/gemini/scheduler.mjs'
import { createGeminiSlotPrefs } from './lib/gemini/slot-prefs.mjs'
import {
  createGeminiPublicHandler,
  createGeminiTerminal,
  formatGoogleModelList,
  geminiKeyAllowsPath,
  geminiProxyEgressOptionsFor,
  geminiProxyFor,
  googleModelEntry,
  callGeminiHost,
  isGeminiPublicPath,
  isGeminiSharedPath,
  parseGeminiGeneratePath,
  parseGeminiModelGetPath,
  checkGeminiAccounts,
  warmGeminiEnvironments,
} from './lib/gemini/routes.mjs'
import {
  extractApiKey,
  timingSafeEqualStr,
  createRateLimiter,
  verifyPanelSession,
  extractPanelToken,
  attachPanelAuth,
  getPanelAdmin,
} from './lib/core/security.mjs'
import { loadModelPolicy } from './lib/protocol/model-policy.mjs'
import { loadGeminiModelPolicy } from './lib/protocol/gemini-model-policy.mjs'
import { gatewayModelCatalog } from './lib/protocol/models.mjs'
import { codexUnifiedForUsageProbe } from './lib/protocol/codex-usage.mjs'
import {
  createCredentialRefreshMonitor,
  normalizeCredentialRefreshConfig,
} from './lib/oauth/credential-refresh-monitor.mjs'
import { createKernelWatchdog, normalizeKernelWatchdogConfig } from './lib/transport/kernel-watchdog.mjs'
import { createSlotCapacityReconciler } from './lib/vm/slot-capacity-reconciler.mjs'
import { configureSlotCapacity } from './lib/vm/slot-capacity.mjs'
import { ensureSlotSubscriptionType } from './lib/oauth/oauth-credentials.mjs'
import { ensureRemoteOfficialCredentialLink } from './lib/cluster/remote-slot-files.mjs'
import { createCliNodeGuard } from './lib/vm/cli-node-guard.mjs'

import { createSlotBridgeHealer, powerOnSlot, recoverSlot, reviveDownSlots } from './lib/vm/slot-recovery.mjs'
import {
  createCragZombieGuard,
  isCragZombieGuardSchedulable,
  isCragZombieGuardTarget,
  normalizeCragZombieGuardConfig,
} from './lib/vm/crag-zombie-guard.mjs'
import { kernelFaults, rustKernelHealth } from './lib/transport/rust-kernel-client.mjs'
import { slotExec } from './lib/vm/slot-runtime.mjs'
import { fillVmTimezoneFromExit } from './lib/vm/proxy-timezone.mjs'
import { releaseKernelInstallSafetyHold, resumePendingKernelInstalls } from './lib/vm/kernel-install.mjs'
import { createUsageProbeMonitor, normalizeUsageProbeConfig } from './lib/oauth/usage-probe-monitor.mjs'
import { createCatalogMonitor } from './lib/admin/catalog-monitor.mjs'
import { normalizeOfficialCcConfig } from './lib/oauth/official-cc-bootstrap.mjs'
import { invalidateLiveCredentialCache } from './lib/admin/panel-live-credentials.mjs'
import { normalizeHealthProbeConfig, createHealthProbeMonitor, HEALTH_REAL_HEADER } from './lib/admin/health-probe.mjs'
import { normalizeNotifyConfig, createNotifyMonitor, dispatchNotify } from './lib/admin/notify.mjs'
import { snapshotVmConnectivity } from './lib/admin/vm-connectivity.mjs'
import { runVmTestChat } from './lib/admin/vm-test-chat.mjs'
import { VmTestScheduleRunner } from './lib/admin/vm-test-schedule.mjs'
import {
  preheatNextWindowEnd,
  preheatRenewEpisodeKey,
  preheatWindowStateLikeServer,
} from './lib/admin/vm-test-preheat-window.mjs'
import { StickyRouter } from './lib/pool/sticky-router.mjs'
import { AccountQuota } from './lib/pool/account-quota.mjs'
import { normalizeTiers } from './lib/pool/quota-tiers.mjs'
import { ApiKeyStore, makeApiKeyGateError } from './lib/admin/api-keys.mjs'
import {
  filterModelsForPoolAccess,
  keyScopeFromRequest,
  keyTierPolicyFromRecord,
  resolvePoolAccessForKey,
} from './lib/admin/key-scope.mjs'
import { requestedPoolIdFromHeaders } from './lib/protocol/pool-prompt-policy.mjs'
import { ownerScopeFromRequest } from './lib/admin/resource-owner.mjs'
import { filterModelCatalogForKey } from './lib/admin/key-models.mjs'
import { GroupsRepo } from './lib/db/repos/groups-repo.mjs'
import { GeminiOwnersRepo } from './lib/db/repos/gemini-owners-repo.mjs'
import { bootstrapSchedulerPools } from './lib/db/repos/scheduler-pools-repo.mjs'
import { createSchedulerRuntime } from './lib/scheduler/scheduler-runtime.mjs'
import { SettingsRepo } from './lib/db/repos/settings-repo.mjs'
import { ApiEndpointStore } from './lib/admin/api-endpoints.mjs'
import { ApiScheduler } from './lib/pool/api-scheduler.mjs'
import { apiScheduleScope, resolveInferenceBackend } from './lib/pool/api-protocol.mjs'
import { bootApiKernel, apiKernelPaths, apiKernelSnapshot } from './lib/transport/api-kernel-client.mjs'
import { bootProtoFront } from './lib/transport/proto-front-client.mjs'
import { PanelUserStore } from './lib/admin/panel-users.mjs'
import { RequestLogStore } from './lib/admin/request-log.mjs'
import {
  bindVmProxy,
  listVms,
  getVm,
  getActiveVmId,
  markUnschedulable,
  reconcileProxyScheduleHold,
  isCodexVm,
  syncCodexQuotaSchedule,
} from './lib/vm/vm-registry.mjs'
import { createCragSubscription } from './lib/vm/crag-subscription.mjs'
import { createCragRuntimeInventory } from './lib/vm/crag-runtime-inventory.mjs'
import { configureCragRuntimeAdmission } from './lib/vm/slot-runtime-admission.mjs'
import {
  inspectClusterPayloadChanges,
  refreshClusterSlotPayloads,
  refreshNodeSlotPayload,
  syncRemoteSlotRestartPolicy,
} from './lib/cluster/remote-slot.mjs'
import { installedCragV2Root } from './lib/vm/wrap-cli-runtime.mjs'
import { makeError, ErrorType, ErrorCode } from './lib/core/errors.mjs'
import * as panel from './lib/admin/panel-api.mjs'
import { ProxyPool } from './lib/vm/proxy-pool.mjs'
import { ensureProxyEgress, proxyEgressReady } from './lib/vm/egress.mjs'
import { syncIpv6ProxyEgress } from './lib/vm/proxy-policy-runtime.mjs'
import { GATEWAY_CAPABILITIES } from './lib/vm/execution-context.mjs'
import { isTelemetryPath, telemetryInterceptResponse } from './lib/identity/telemetry-rewrite.mjs'
import { openDatabaseAsync, closeDatabaseAsync, getDb, getDbEngine, getPgPool } from './lib/db/database.mjs'
import { startDashboardAggregator, stopDashboardAggregator } from './lib/db/pg/dashboard-aggregator.mjs'
import { snapshotCacheMetrics } from './lib/cache/index.mjs'
import { armWriteBehind } from './lib/db/write-behind.mjs'
import { JevUsageRepo } from './lib/db/repos/jev-usage-repo.mjs'
import { installJevUsageRecorder } from './lib/protocol/jev-usage.mjs'
import { jevHealthSnapshot, readJevConfig } from './lib/protocol/jev-intercept.mjs'
import { runLegacyImport } from './lib/db/legacy-import.mjs'
import { initVmDbSync, stopVmWatch } from './lib/vm/vm-db-sync.mjs'
import { BackupService } from './lib/admin/backup-service.mjs'
import { ensureRedaction } from './lib/redaction/runtime.mjs'
import { ClusterNodesRepo } from './lib/db/repos/cluster-nodes-repo.mjs'
import { ClusterManager } from './lib/cluster/cluster-manager.mjs'
import { createHostMemoryPressure, installHostMemoryPressure } from './lib/cluster/host-memory-pressure.mjs'
import { createClusterRoutes } from './lib/cluster/cluster-routes.mjs'
import { bindPlacement, isNativeNodeVm, nodeImageBuildRunning, warmNodeSlotImages } from './lib/cluster/placement.mjs'
import { ClusterError } from './lib/cluster/ssh-link.mjs'
import { nodeEgressProxyUrl, startNodeEgressSocks } from './lib/cluster/node-egress-socks.mjs'
import { createSlotShell } from './lib/vm/slot-shell.mjs'
import { createSlotDesktop } from './lib/vm/slot-desktop.mjs'
import { vmLockBusy, withVmLock } from './lib/vm/vm-file.mjs'
import { slotImageSpec } from './lib/cluster/slot-image.mjs'
import { OS_CATALOG } from './lib/vm/os-catalog.mjs'
import { isKvmRuntime } from './lib/vm/runtime-kind.mjs'
import { resolveKernelDataplane } from './lib/vm/slot-engine.mjs'
import {
  assertCragSubscriptionTarget,
  isCragSubscriptionSlotEnabled,
  refreshSlotGuestBinDir,
  syncLocalSlotRestartPolicies,
} from './lib/vm/vm-runtime.mjs'

import {
  PROACTIVE_REFRESH_SKEW_MS,
  classifyCredentialRefresh,
  clearUpgradeRequired,
  markVmRefreshError,
  refreshErrorCodeOf,
  mirrorWorkerCredentialsToVm,
  stripWorkerCredentialEmail,
} from './lib/oauth/oauth-credentials.mjs'
import { normalizeCredentialMode } from './lib/oauth/credential-mode.mjs'
import {
  ensureWorkerCredential,
  probeWorkerAttemptGuard,
  repairLocalCredentialLink,
} from './lib/transport/go-worker-client.mjs'
import { requestKernelReloadWhenIdle, stopAllRustKernels } from './lib/transport/rust-kernel-supervisor.mjs'
import { createRespond, parseRequestUrl } from './lib/http/respond.mjs'
import { corsHeadersForRequest } from './lib/http/cors.mjs'
import { isConsoleEntry, tryServeWebDist } from './lib/http/web-dist.mjs'
import { createGracefulShutdown } from './lib/http/graceful-shutdown.mjs'
import { createRoutingRuntime } from './lib/admin/routing-runtime.mjs'
import { createImportCommit } from './lib/oauth/import-commit.mjs'
import { createHandleProtocol } from './lib/protocol/handle-protocol.mjs'
import { createResponsesWsHandler } from './lib/protocol/responses-ws.mjs'
import { countTokensEnabled, handleUserCountTokens, handleUserUsage } from './lib/protocol/user-count-tokens.mjs'
import { createKeySelfHandler, KEY_SELF_PATHS } from './lib/protocol/key-self.mjs'
import { createPanelHandler, syncInstalledKernels } from './lib/admin/panel-routes.mjs'
import { IntegrationTokenStore } from './lib/admin/integration-tokens.mjs'
import { createIntegrationHandler } from './lib/admin/integration-routes.mjs'
import { createCragShopHandler, isCragShopPath, sessionBuyerOwner } from './lib/admin/crag-shop.mjs'

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
  'account_usage',
]
/** FEATURES for a request, which is the only place the count_tokens switch can be read.
 *
 * `pub` below is written to config/gateway-v2.public.json once at startup, so it keeps
 * the static list: a file produced at boot cannot describe a switch the operator flips
 * at runtime, and advertising either answer there would be wrong half the time.
 */
const featuresNow = () => (countTokensEnabled(routingConfig) ? [...FEATURES, 'count_tokens'] : FEATURES)
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
// Egress state lives under the project root even when SQLite uses KIN_DATA_DIR.
const stateDir = path.join(cfg.paths.project, 'data')
const inheritedLockFd = process.env.VM2API_BOOTSTRAP_LOCK_FD
// Blue/green deploys: KIN_STANDBY=1 boots the HTTP server, DB and api-kernel but defers every
// background job that mutates shared state (credential refresh, watchdogs, cluster links,
// restart-policy sync ...) until SIGUSR2. Two live controllers would otherwise race on token
// rotation. The old controller stops its jobs in beforeDrain, so activate the new one after SIGTERM.
// KIN_STANDBY_ACTIVE_FILE: written by the deploy script once this controller was activated, so a
// container restart after cutover boots straight into the active role instead of waiting for SIGUSR2.
const STANDBY =
  process.env.KIN_STANDBY === '1' &&
  !(process.env.KIN_STANDBY_ACTIVE_FILE && fs.existsSync(process.env.KIN_STANDBY_ACTIVE_FILE))
const BLUEGREEN = process.env.KIN_STANDBY === '1'
const standbyTasks = []
let standbyActive = !STANDBY
if (STANDBY) setHandoverRole('standby')
function runAtActivation(name, fn) {
  if (!STANDBY || standbyActive) return fn()
  standbyTasks.push({ name, fn })
  return undefined
}
let activating = false
let foreignLoadReader = null
let foreignLoadWriter = null
async function activateStandby(reason = 'signal') {
  if (standbyActive || activating) return false
  activating = true
  // The leader released the lock on SIGUSR1; wait briefly in case its release is still in flight.
  const lock = await controlPlaneFlock(['-w', String(Number(process.env.KIN_STANDBY_LOCK_WAIT_SEC) || 30), '-E', '75'])
  activating = false
  if (lock.status !== 0) {
    console.error(
      JSON.stringify({ event: 'standby-activate-failed', reason: lock.status === 75 ? 'lock_busy' : lock.stderr }),
    )
    return false
  }
  standbyActive = true
  setHandoverRole('leader')
  // The old controller is still finishing its streams: hold back anything that would cut them,
  // and count its live requests and seats against capacity until it has gone.
  setOverlap(true)
  try {
    const foreign = createForeignLoad({ scheduler: poolScheduler, accountQuota, apiKeys: apiKeyStore })
    schedulerRuntime?.setExternalLoadProvider?.(() => foreign.snapshot()?.vms || {})
    foreignLoadReader = startLoadReader({
      file: foreignLoadPath(dataDir),
      foreign,
      // Ends the overlap on its own if the deploy script never sends SIGHUP (watcher killed, host reboot).
      onGone: () => {
        console.log(JSON.stringify({ event: 'handover-peer-gone' }))
        void runExclusivePass()
      },
    })
  } catch (e) {
    console.warn('[handover] foreign load reader failed', e?.message || e)
  }
  console.log(JSON.stringify({ event: 'standby-activate', reason, tasks: standbyTasks.map((t) => t.name) }))
  for (const { name, fn } of standbyTasks.splice(0)) {
    try {
      const out = fn()
      if (out && typeof out.catch === 'function')
        out.catch((e) => console.warn(`[standby] ${name} failed`, e?.message || e))
    } catch (e) {
      console.warn(`[standby] ${name} failed`, e?.message || e)
    }
  }
  if (schedulerRuntime) {
    try {
      await schedulerRuntime.promoteToLeader({ rebootstrap: true, startDrain: true })
    } catch (e) {
      console.warn('[standby] scheduler-runtime promote failed', e?.message || e)
    }
  }
  console.log(JSON.stringify({ event: 'standby-activated' }))
  return true
}
const syncWrapAtStartup =
  inheritedLockFd !== undefined &&
  process.env.VM2API_BOOTSTRAP_WRAP_CHANGED === '1' &&
  process.env.KIN_AUTO_SYNC_WRAP === '1'
delete process.env.VM2API_BOOTSTRAP_LOCK_FD
delete process.env.VM2API_BOOTSTRAP_WRAP_CHANGED
fs.mkdirSync(stateDir, { recursive: true })
// Bootstrap passes the same open file description through exec, without releasing the lock.
// Node marks inherited fds close-on-exec, so helpers do not extend the owner's lifetime.
const controlPlaneFd =
  inheritedLockFd === undefined
    ? fs.openSync(stateDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
    : Number(inheritedLockFd)
if (inheritedLockFd !== undefined) {
  const actual = fs.fstatSync(controlPlaneFd, { bigint: true })
  const expected = fs.statSync(stateDir, { bigint: true })
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error('vm2api_control_plane_lock_failed: bootstrap fd does not identify project data')
  }
}
// A standby boots next to the leader and takes the lock only at activation (after the leader's SIGUSR1).
if (!STANDBY) {
  const lock = spawnSync('flock', ['-n', '-E', '75', '3'], {
    stdio: ['ignore', 'ignore', 'pipe', controlPlaneFd],
    encoding: 'utf8',
  })
  if (lock.status !== 0) {
    fs.closeSync(controlPlaneFd)
    if (lock.status === 75) throw new Error('vm2api_control_plane_already_running: stop the other controller first')
    throw new Error(`vm2api_control_plane_lock_failed: ${lock.error?.message || lock.stderr?.trim() || lock.signal}`)
  }
}
// flock(1) on fd 3 acts on our open file description, so the lock stays with this process.
function controlPlaneFlock(args) {
  return new Promise((resolve) => {
    const child = spawn('flock', [...args, '3'], { stdio: ['ignore', 'ignore', 'pipe', controlPlaneFd] })
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('error', (e) => resolve({ status: -1, stderr: e.message }))
    child.on('exit', (status) => resolve({ status, stderr: stderr.trim() }))
  })
}
fs.mkdirSync(cfg.paths.captures, { recursive: true })

const allowRate = createRateLimiter({
  capacity: cfg.limits.rate_capacity,
  refillPerSec: cfg.limits.rate_refill,
})

// --- Persistent store (PostgreSQL or SQLite) ---
const dataDir = cfg.paths.data || path.join(cfg.paths.root, 'data')
await openDatabaseAsync({ dataDir, pooled: true, enableAggregator: false })
armWriteBehind(getDb())
const jevUsageRepo = new JevUsageRepo()
installJevUsageRecorder((event) => jevUsageRepo.record(event))
try {
  loadModelPolicy()
} catch (e) {
  console.warn('[model-policy] boot load failed', e?.message || e)
}
try {
  loadGeminiModelPolicy()
} catch (e) {
  console.warn('[gemini-model-policy] boot load failed', e?.message || e)
}
// one-time migration of legacy JSON files (data/*.json + request-logs) into the DB
const legacyImport = runLegacyImport({ dataDir, projectRoot: cfg.paths.project })
if (legacyImport?.imported) {
  console.log('[db] legacy JSON import done:', JSON.stringify(legacyImport.counts || {}))
}
// VM/credential mirror: write-through hook + startup reconcile + fs.watch
const vmSync = initVmDbSync(cfg.paths.project)
if (vmSync.upserted || vmSync.rebuilt) {
  console.log(`[db] vm mirror reconciled: upserted=${vmSync.upserted} rebuilt=${vmSync.rebuilt}`)
}
if (vmSync.proxy_cli_repaired) {
  console.log(`[vm] repaired proxy_cli_enabled on ${vmSync.proxy_cli_repaired} slot(s)`)
}
if (vmSync.reclaimed_vm_ids.length) {
  console.log(`[vm] reclaimed ${vmSync.reclaimed_vm_ids.length} slot(s) assigned to deleted users`)
}
// Idempotent Leader-only backfill of legacy vm_pools -> scheduler_pools (skipped under KIN_STANDBY=1 until SIGUSR2).
runAtActivation('scheduler-pools-bootstrap', () => {
  const res = bootstrapSchedulerPools({ db: getDb(), isStandby: !standbyActive })
  if (res.pools || res.members || res.bindings || res.apiKeysUpdated) {
    console.log('[db] scheduler pools bootstrapped:', JSON.stringify(res))
  }
})

// --- P3 sticky + quota ---

const routingConfigPath = routingConfigFile(cfg.paths.project)
let healthMonitor = null
let credentialRefreshMonitor = null
let kernelWatchdog = null
let cliNodeGuard = null
let cragZombieGuard = null
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
let schedulerRuntime = null

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
    if (schedulerRuntime) v?.setSchedulerRuntime?.(schedulerRuntime)
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
  get cragZombieGuard() {
    return cragZombieGuard
  },

  get notifyMonitor() {
    return notifyMonitor
  },
  get failoverRunner() {
    return failoverRunner
  },
  setFailoverRunner: (v) => {
    failoverRunner = v
    if (schedulerRuntime) v?.setSchedulerRuntime?.(schedulerRuntime)
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
if (routingConfig.official_cc) {
  routingConfig.official_cc = normalizeOfficialCcConfig(routingConfig.official_cc)
}
routingConfig.health_probe = normalizeHealthProbeConfig(routingConfig.health_probe)
routingConfig.usage_probe = normalizeUsageProbeConfig(routingConfig.usage_probe)
routingConfig.crag_zombie_guard = normalizeCragZombieGuardConfig(routingConfig.crag_zombie_guard)
routingConfig.notify = normalizeNotifyConfig(routingConfig.notify)
routingConfig.tiers = normalizeTiers(routingConfig.tiers, routingConfig.quota, routingConfig.concurrency)
syncTierDefaultsIntoRouting()
stickyRouter = new StickyRouter({ dataDir, config: routingConfig })
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
accountQuota.loadVmQuotaOverrides(listVms(cfg.paths.project))

const apiKeyStore = new ApiKeyStore({ dataDir: cfg.paths.data })
groupsRepo = new GroupsRepo()
let geminiOwnersRepo = new GeminiOwnersRepo()
const geminiOwnersProxy = {
  getOwner: (envId) => geminiOwnersRepo.getOwner(envId),
  setOwner: (envId, ownerUserId) => geminiOwnersRepo.setOwner(envId, ownerUserId),
  remove: (envId) => geminiOwnersRepo.remove(envId),
  ownerMap: () => geminiOwnersRepo.ownerMap(),
  listEnvIdsByOwner: (ownerUserId) => geminiOwnersRepo.listEnvIdsByOwner(ownerUserId),
}
const apiEndpointStore = new ApiEndpointStore({ dataDir: cfg.paths.data })
const apiScheduler = new ApiScheduler()
apiScheduler.reload(apiEndpointStore.listRaw())
const panelUsers = new PanelUserStore({ dataDir: cfg.paths.data, projectRoot: cfg.paths.project })
try {
  panelUsers.bootstrapFromEnv(getPanelAdmin())
} catch (e) {
  console.warn('[panel-users] bootstrap failed', e?.message || e)
}
attachPanelAuth({
  authenticate: (username, password) => panelUsers.authenticate(username, password),
  lookupRole: (username) => panelUsers.getByUsername(username)?.role || null,
})
requestLog = new RequestLogStore({
  dataDir: cfg.paths.data,
  mode: process.env.KIN_REQUEST_LOG_MODE || routingConfig?.logging?.mode || 'normal',
})
if (routingConfig?.logging) {
  requestLog.setConfig({
    // Env wins at boot so e2e / ops can force off|debug. Panel PUT still hot-updates.
    mode: process.env.KIN_REQUEST_LOG_MODE || routingConfig.logging.mode,
    retainDays: routingConfig.logging.retain_days,
    debugRetainDays: routingConfig.logging.debug_retain_days,
    maxMb: routingConfig.logging.max_mb,
    mutedErrorClasses: routingConfig.logging.muted_error_classes,
  })
}
runAtActivation('request-log-cleanup', () => {
  try {
    requestLog.cleanup()
  } catch {}
  requestLog.startCleanupScheduler()
})

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
  usesHostEgress: (vmId, proxyId) => {
    const vm = getVm(cfg.paths.project, vmId)
    return vm?.proxy?.id === proxyId && !vm.node_id && !isCodexVm(vm) && ['running', 'paused'].includes(vm.status)
  },
  onDisableVm: (vmId, reason, proxyId) => reconcileProxyScheduleHold(cfg.paths.project, vmId, proxyId, reason),
  onEnableVm: (vmId, _reason, proxyId) => reconcileProxyScheduleHold(cfg.paths.project, vmId, proxyId),
  egressCheck: (proxy) => proxyEgressReady(proxy, cfg.paths.project),
  repairEgress: (proxy, shouldStart) => ensureProxyEgress(cfg.paths.project, proxy, { shouldStart }),
})
// An upgrade replaces bin/ files; slots mounting data/run/slot-guest-bin must see the new ones.
// A blue/green standby has not refreshed bin/ yet: the exclusive pass does this after the sync.
function refreshGuestBin() {
  try {
    refreshSlotGuestBinDir(cfg.paths.project)
  } catch (err) {
    console.warn('[bootstrap] slot-guest-bin refresh failed:', err?.message || err)
  }
}
if (!STANDBY) refreshGuestBin()
runAtActivation('proxy-pool', () => proxyPool.startScheduler())

// 首次安装的出口池是空的，槽没有可绑出口就起不来。本机出口永远成立，先补上。
try {
  if (!proxyPool.snapshot().proxies?.length) {
    const seeded = proxyPool.ensureLocal()
    if (seeded.created) {
      void ensureProxyEgress(cfg.paths.project, proxyPool.getProxyByIdWithAuth(seeded.proxy.id))
      console.log('[bootstrap] seeded local egress px-local')
    }
  }
} catch (e) {
  console.warn('[bootstrap] local egress seed failed', e?.message || e)
}

initPoolRuntime()
try {
  applyRoutingTierConcurrency(routingConfig.tiers, { preserveExisting: true })
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
  runChat: (vm, real) =>
    runVmTestChat({
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
  listGeminiTargets: async () => {
    if (!geminiScheduler?.catalog) return { models: [], accounts: [] }
    return geminiScheduler.catalog()
  },
  runGeminiProbe: async ({ model, prompt, timeout_ms }) => {
    if (!geminiScheduler?.complete) return { ok: false, error: 'gemini_scheduler_unavailable' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout_ms || 60_000)
    try {
      const turn = await geminiScheduler.complete({
        model,
        text: prompt || 'hello',
        startedAt: Date.now(),
        signal: controller.signal,
        allowUnprefixedNonGemini: false,
      })
      return {
        ok: true,
        status: turn?.upstream_status ?? 200,
        text: turn?.text || 'ok',
        vm_id: turn?.account_id ? `gemini:${turn.account_id}` : 'gemini',
        account_id: turn?.account_id || null,
        model: turn?.response_model || turn?.model || model,
        stop_reason: turn?.stopReason || 'end_turn',
        usage: turn?.usage || { input_tokens: 0, output_tokens: 0 },
      }
    } catch (error) {
      return {
        ok: false,
        status: error?.upstreamStatus || error?.status || 0,
        error: error?.message || error?.code || String(error),
      }
    } finally {
      clearTimeout(timer)
    }
  },
})
const vmTestSchedule = new VmTestScheduleRunner({
  projectRoot: cfg.paths.project,
  settings: () => new SettingsRepo(),
  list: () => listVms(cfg.paths.project),
  runTest: (vmId, params) =>
    runVmTestChat({
      projectRoot: cfg.paths.project,
      vmId,
      ...params,
      baseUrl: `http://127.0.0.1:${cfg.port}`,
      apiKey: cfg.api_key,
      accountQuota,
    }),
  // #979 preheat gates: read the same Extra/official windows the scheduler
  // gates on, so a preheat never fires into a live window and never retries
  // a slot the pool already parked.
  windowState: (vmId) => {
    try {
      const vm = getVm(cfg.paths.project, vmId)
      if (!vm) return { hasCredential: false, schedulable: false, windowLive: false }
      return preheatWindowStateLikeServer(vm, () => routingConfig, {
        projectRoot: cfg.paths.project,
        accountQuota,
      })
    } catch {
      return null
    }
  },
  nextWindowEnd: (vmId) => {
    try {
      const vm = getVm(cfg.paths.project, vmId)
      if (!vm) return null
      return preheatNextWindowEnd(vm, { projectRoot: cfg.paths.project, accountQuota })
    } catch {
      return null
    }
  },
  renewEpisodeKey: (vmId) => {
    try {
      const vm = getVm(cfg.paths.project, vmId)
      if (!vm) return null
      return preheatRenewEpisodeKey(vm, { projectRoot: cfg.paths.project, accountQuota })
    } catch {
      return null
    }
  },
  onRenewGateSkip: (event) => {
    console.debug?.('[vm-test-renew-gate-skip]', JSON.stringify(event))
  },
})
credentialRefreshMonitor = createCredentialRefreshMonitor({
  config: normalizeCredentialRefreshConfig(routingConfig.credential_refresh),
  ensureLink: (vm) => ensureRemoteOfficialCredentialLink(vm),
  ensureLocalLink: (vm) => repairLocalCredentialLink(path.join(cfg.paths.project, 'vms', vm.id, 'cli-home')),
  listTargets: () =>
    listVms(cfg.paths.project).map((vm) => {
      let lastProbe = vm.last_probe || null
      try {
        const acc = accountQuota?.repo?.get?.(vm.account_uuid || vm.id)
        lastProbe = acc?.unified?.last_probe || acc?.last_probe || lastProbe
      } catch {}
      return { ...vm, last_probe: lastProbe }
    }),
  reviveOne: async (vm) => {
    const vmPath = path.join(cfg.paths.project, 'vms', `${vm.id}.json`)
    const homeDir = path.join(cfg.paths.project, 'vms', vm.id, 'cli-home')
    const exec = { vmId: vm.id, vmPath, homeDir, vm: getVm(cfg.paths.project, vm.id) || vm }
    if (!(await probeWorkerAttemptGuard(exec))) return { revived: false }
    const cleared = clearUpgradeRequired(vmPath)
    if (cleared) invalidateLiveCredentialCache()
    return { revived: cleared }
  },
  refreshOne: (vm) =>
    refreshWorkerCredentialForVm({
      vmId: vm.id,
      vmPath: path.join(cfg.paths.project, 'vms', `${vm.id}.json`),
      homeDir: path.join(cfg.paths.project, 'vms', vm.id, 'cli-home'),
      vm: getVm(cfg.paths.project, vm.id) || vm,
      force: false,
      skewMs: PROACTIVE_REFRESH_SKEW_MS,
    }),
})
function bootSlot(id) {
  return powerOnSlot({ projectRoot: cfg.paths.project, id, proxyPool, routing: routingConfig })
}
kernelWatchdog = createKernelWatchdog({
  config: routingConfig.kernel_watchdog,
  listTargets: () => listVms(cfg.paths.project),
  getRouting: () => routingConfig,
  homeDirFor: (vm) => path.join(cfg.paths.project, 'vms', vm.id, 'cli-home'),
  revive: (vm) => bootSlot(vm.id),
  healBridges: createSlotBridgeHealer({ projectRoot: cfg.paths.project }),
})

configureSlotCapacity(routingConfig.slot_capacity)
const slotCapacityReconciler = createSlotCapacityReconciler({
  projectRoot: cfg.paths.project,
  listTargets: () => listVms(cfg.paths.project),
  getRouting: () => routingConfig,
  // Every cluster node gets a host budget from its 30s health probe (MemTotal / MemAvailable).
  nodeMemory: (id) => {
    try {
      const health = clusterManager.get(id)?.health
      const total = Number(health?.host?.mem_total)
      const used = Number(health?.host?.mem_used)
      if (!(total > 0) || !Number.isFinite(used)) return null
      return { totalBytes: total, availableBytes: Math.max(0, total - used), at: Date.parse(health.checked_at) || 0 }
    } catch {
      return null
    }
  },
})

usageProbeMonitor = createUsageProbeMonitor({
  config: routingConfig.usage_probe,
  listTargets: () => listVms(cfg.paths.project),
  // Codex quota lives on the slot file (vm.codex.extra), not in the accounts
  // repo, and summarization drops the extra while keeping the built view — so
  // synthesize from vm.codex_usage. Elapsed codex windows then get the same
  // one-shot /usage hop claude slots get.
  accountForVm: (vm) =>
    isCodexVm(vm)
      ? { vm_id: vm.id, unified: codexUnifiedForUsageProbe(vm?.codex_usage || {}) }
      : accountForUsageProbe(vm),
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
  probeOne: (vm) => panel.buildProbeOne({ cfg, accountQuota, id: vm.id, routingConfig }),
})
catalogMonitor = createCatalogMonitor({
  projectRoot: cfg.paths.project,
  codexCatalogVersion: () => routingConfig.codex?.catalog_client_version || 'auto',
  callGeminiHost,
  resolveGeminiProxy: (proxyId, envId) => {
    const ownerUserId = geminiOwnersRepo?.getOwner?.(envId) ?? null
    return geminiProxyFor(proxyPool, proxyId, { ownerUserId })
  },
  getApiEndpointStore: () => apiEndpointStore,
  cfg,
  log: (event) => console.log(JSON.stringify(event)),
})
notifyMonitor = createNotifyMonitor({
  vmSnapshot: () => snapshotVmConnectivity(listVms(cfg.paths.project)),
  jevSnapshot: () => jevHealthSnapshot(readJevConfig((k, d) => new SettingsRepo().get(k, d))),
  config: routingConfig.notify,
  baseUrl: cfg.base_url,
  snapshot: () =>
    panel.snapshotAccountPool({
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
  // A restore swaps the DatabaseSync instance and routing files. Rebuild every
  // holder before reporting success; otherwise requests keep stale snapshots
  // or silently write through statements owned by the closed connection.
  for (const store of [apiKeyStore, apiEndpointStore, panelUsers, accountQuota, stickyRouter, proxyPool, requestLog]) {
    store.rebind(db)
  }
  groupsRepo = new GroupsRepo(db)
  geminiOwnersRepo = new GeminiOwnersRepo(db)
  apiScheduler.reload(apiEndpointStore.listRaw())

  routingConfig = loadRoutingConfig()
  migrateLegacyOpenAIPolicies(routingConfig)
  if (routingConfig.official_cc) {
    routingConfig.official_cc = normalizeOfficialCcConfig(routingConfig.official_cc)
  }
  routingConfig.health_probe = normalizeHealthProbeConfig(routingConfig.health_probe)
  routingConfig.usage_probe = normalizeUsageProbeConfig(routingConfig.usage_probe)
  routingConfig.crag_zombie_guard = normalizeCragZombieGuardConfig(routingConfig.crag_zombie_guard)
  routingConfig.notify = normalizeNotifyConfig(routingConfig.notify)
  routingConfig.tiers = normalizeTiers(routingConfig.tiers, routingConfig.quota, routingConfig.concurrency)
  syncTierDefaultsIntoRouting()

  stickyRouter.reloadConfig(routingConfig)
  accountQuota.reloadConfig(routingConfig)
  accountQuota.loadVmQuotaOverrides(listVms(cfg.paths.project))
  requestLog.setConfig({
    mode: process.env.KIN_REQUEST_LOG_MODE || routingConfig.logging?.mode,
    retainDays: routingConfig.logging?.retain_days,
    debugRetainDays: routingConfig.logging?.debug_retain_days,
    maxMb: routingConfig.logging?.max_mb,
    mutedErrorClasses: routingConfig.logging?.muted_error_classes,
  })
  healthMonitor?.setConfig(routingConfig.health_probe)
  credentialRefreshMonitor?.setConfig(normalizeCredentialRefreshConfig(routingConfig.credential_refresh))
  kernelWatchdog?.setConfig(normalizeKernelWatchdogConfig(routingConfig.kernel_watchdog))
  cragZombieGuard?.setConfig(routingConfig.crag_zombie_guard)
  configureSlotCapacity(routingConfig.slot_capacity)
  usageProbeMonitor?.setConfig(routingConfig.usage_probe)
  notifyMonitor?.setConfig(routingConfig.notify)

  initPoolRuntime()
  void schedulerRuntime?.syncConfigNow?.('backup_restore').catch(() => {})
  reloadActiveVm(cfg)
  vmTestSchedule.reload()
  try {
    await ensureRedaction(routingConfig, { projectRoot: cfg.paths.project })
  } catch (err) {
    console.warn('[backup] redaction resync after restore failed:', String(err?.message || err))
  }
})
// A just-activated leader waits for the draining controller to exit before its catch-up backup:
// that one may still be mid-run, and two full snapshots of a large DB would run side by side.
runAtActivation('backup', () =>
  deferUntilExclusive('backup', () => {
    void backupService.cleanStaging()
    backupService.startScheduler()
  }),
)

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
    const derived = refreshErrorCodeOf(result)
    const code = derived === 'worker_upgrade_required' ? derived : result?.error?.code || 'credential_refresh_failed'
    out.error = {
      code,
      message:
        code === 'refresh_outcome_unknown'
          ? 'An earlier refresh with this credential has no recorded result; re-authorize the slot'
          : code === 'worker_upgrade_required'
            ? 'The slot worker cannot guard refresh retries; update kin-worker on this node'
            : refreshClass === 'fatal'
              ? 'OAuth credential was rejected'
              : refreshClass === 'retryable'
                ? 'OAuth credential refresh is temporarily unavailable'
                : 'OAuth credential refresh failed',
    }
  }
  return out
}

async function refreshWorkerCredentialForVm({ vmId, vmPath, homeDir, vm, force = false, skewMs }) {
  // Host RefreshIfNeeded is the credential writer. Slot workers only read AT.
  const result = await ensureWorkerCredential({ vmId, vm, homeDir }, { force: !!force, ...(skewMs ? { skewMs } : {}) })

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

const { json, writeSSEHeaders, readBody, readRawBody } = createRespond(cfg, {
  tcpNodelay: () => routingConfig?.inference?.tcp_nodelay !== false,
})

function rejectAuth(req, res, error) {
  req.authError = {
    code: error?.body?.error?.code || ErrorCode.INVALID_API_KEY,
    message: error?.body?.error?.message || 'Invalid credentials',
    status: error?.status || 401,
  }
  if (error?.headers) {
    for (const [header, value] of Object.entries(error.headers)) {
      if (value != null) res.setHeader?.(header, value)
    }
  }
  json(res, error.status, error.body)
  return false
}

/** `keyGate: false` (key self-service) skips the managed key's quota / RPM / concurrency gate. */
function requireAuth(req, res, { keyGate = true, buyer = false, optionalBuyer = false } = {}) {
  req.presentedApiKey = extractApiKey(req)
  const token = extractPanelToken(req) || req.presentedApiKey
  if (!token) {
    if (buyer && optionalBuyer) return false
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
  // Panel session
  const session = verifyPanelSession(token)
  if (session) {
    if (!allowRate('panel:' + session.user)) {
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
    req.panelRole = session.role || panelUsers.getByUsername(session.user)?.role || 'user'
    const rec = panelUsers.getByUsername(session.user)
    req.panelUserId = rec?.id || null
    req.panelVmCreateQuota = rec?.vm_create_quota ?? 0
    if (buyer) req.panelBuyerOwner = sessionBuyerOwner(session, rec, getPanelAdmin())
    return true
  }
  if (buyer) {
    if (optionalBuyer) return false
    json(res, 403, {
      ok: false,
      error: { code: 'shop_login_required', message: 'Sign in to the panel to access CRAG shop' },
    })
    return false
  }
  // Master env API key — unlimited admin unless KIN_RATE_CAP is explicitly configured
  if (timingSafeEqualStr(token, cfg.api_key)) {
    if (cfg.limits.rate_capacity_explicit && !allowRate(token)) {
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

  // Authenticate with the managed key store when the master key did not match.
  const managed = apiKeyStore.authenticate(token)
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
  if (
    managed.record.group_type === 'gemini' &&
    !geminiKeyAllowsPath(parseRequestUrl(req)?.pathname || '', req.method)
  ) {
    return rejectAuth(
      req,
      res,
      makeError({
        type: ErrorType.PERMISSION,
        code: 'key_group_mismatch',
        message: 'This key can only call Gemini endpoints.',
        status: 403,
      }),
    )
  }
  const gate = keyGate ? apiKeyStore.canAccept(managed.record) : { ok: true }
  if (!gate.ok) {
    return rejectAuth(req, res, makeApiKeyGateError(gate))
  }
  req.apiKeyKind = 'managed'
  req.apiKeyRecord = managed.record
  return true
}

function fetchWorkerModels(opts = {}) {
  const mappingKeys = Object.keys(routingConfig?.codex?.model_mappings || {})
  return gatewayModelCatalog({ ...opts, mappingKeys })
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

const handleKeySelf = createKeySelfHandler({
  json,
  requireAuth,
  apiKeyStore,
  getUsageLogs: () => requestLog.repo,
})

const { handleProtocol, handleSearch, handleImages } = createHandleProtocol({
  // The public handler routes `/v1/messages` itself and answers in the Anthropic
  // shape. Rewriting req.url into the session path made the response carry
  // `id: "messages"` and changed the path the request log attributes.
  handleGeminiMessages: (req, res, opts) => handleGeminiPublic(req, res, opts),
  handleGeminiPublic: (req, res, opts) => handleGeminiPublic(req, res, opts),
  get geminiScheduler() {
    return geminiScheduler
  },
  geminiOwnerMap: () => geminiOwnersProxy.ownerMap(),
  admitCragInference: (input) => cragSubscription.admitInference(input),
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
  getSchedulerRuntime: () => schedulerRuntime,
  get schedulerRuntime() {
    return schedulerRuntime
  },
  get groupsRepo() {
    return groupsRepo
  },
})

const responsesWs = createResponsesWsHandler({
  handleProtocol,
  requireAuth,
  json,
  getRouting: () => routingConfig,
  maxBodyBytes: cfg.limits.max_body_bytes,
  cfg,
  accountQuota,
  apiKeyStore,
  getSchedulerRuntime: () => schedulerRuntime,
  get schedulerRuntime() {
    return schedulerRuntime
  },
})

/**
 * One local egress row per VPS: rows for current nodes, and slots still on
 * another machine's row (the shared px-local before per-node rows) move onto
 * their own node's row, with the slot's recorded proxy rewritten to match.
 */
function syncNodeLocalEgress() {
  try {
    proxyPool.syncLocalNodes(clusterManager.list().map((node) => node.id))
    for (const move of proxyPool.adoptNodeLocalBindings()) {
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
  onNodesChanged: () => syncNodeLocalEgress(),
  // A node's local row follows its link: re-probe as soon as the link settles.
  onLinkState: (nodeId, state) => {
    if (state === 'ready' || state === 'error' || state === 'backoff') {
      proxyPool.probeLocalNode(nodeId).catch(() => {})
    }
    // Slot image tags change with every control-plane upgrade: rebuild what is missing now,
    // not when the first slot lands there.
    if (state === 'ready') warmNodeSlotImages(nodeId)
    if (state === 'ready') {
      void (async () => {
        for (const vm of listVms(cfg.paths.project)) {
          if (vm.node_id !== nodeId || resolveKernelDataplane(vm, routingConfig) !== 'crag') continue
          const result = await syncRemoteSlotRestartPolicy(vm, routingConfig)
          if (!result.ok) console.warn('[crag-restart-policy]', vm.id, result.code || 'sync_failed')
        }
      })().catch(() => console.warn('[crag-restart-policy] node reconciliation failed', nodeId))
    }
  },
})
localEgressCluster = clusterManager
bindPlacement({ manager: clusterManager, projectRoot: cfg.paths.project })
await startNodeEgressSocks({ clientFor: (nodeId) => clusterManager.client(nodeId) })
if (STANDBY) {
  clusterManager.prewarmLinks()
  // Hash the slot image payloads now (read-only CPU). Otherwise the new leader does it on the event loop
  // as each node link comes up after activation (warmNodeSlotImages), stalling requests for seconds.
  // `standby-warm` tells the deploy that activating now costs the first requests nothing.
  setImmediate(async () => {
    const startedAt = Date.now()
    for (const kernel of Object.keys(OS_CATALOG)) {
      try {
        slotImageSpec(cfg.paths.project, kernel)
      } catch {}
      await new Promise((resolve) => setImmediate(resolve))
    }
    const links = await clusterManager.prewarmReady({ timeoutMs: 20_000 })
    console.log(JSON.stringify({ event: 'standby-warm', ms: Date.now() - startedAt, links }))
  })
}
runAtActivation('cluster', () => {
  clusterManager.start()
  return clusterManager.restoreSlotRelays()
})
// Live memory pressure per machine: new conversations avoid hosts low on MemAvailable (overcommit guard).
const hostMemoryPressure = installHostMemoryPressure(
  createHostMemoryPressure({
    getConfig: () => routingConfig.host_memory_pressure,
    listNodes: () => clusterManager.list().map((node) => node.id),
    readNode: (id) => clusterManager.nodeHostMemory(id),
  }),
)
runAtActivation('host-memory', () => hostMemoryPressure.start())
async function syncBootEgress() {
  syncNodeLocalEgress()
  if (proxyPool.snapshot().config.ipv6_enabled !== true) {
    const exits = await syncIpv6ProxyEgress(cfg.paths.project, proxyPool)
    for (const exit of exits.filter((item) => !item.ok)) {
      console.warn('[ipv6-policy] exit not blocked', exit.vm_id || exit.proxy_id, exit.error)
    }
  }
}
if (STANDBY) runAtActivation('egress-sync', syncBootEgress)
else await syncBootEgress()
const clusterRoutes = createClusterRoutes({ manager: clusterManager, json, readBody, ok: panel.ok })
const slotShell = createSlotShell({
  projectRoot: cfg.paths.project,
  importOauth: commitImportedOauth,
})
const slotDesktop = createSlotDesktop({ projectRoot: cfg.paths.project })
for (const vm of listVms(cfg.paths.project)) {
  if (isCodexVm(vm)) continue
  try {
    ensureSlotSubscriptionType(path.join(cfg.paths.project, 'vms', vm.id, 'cli-home'), vm.account_tier, {
      source: vm.account_tier_source,
    })
  } catch (error) {
    console.warn('[credential-subscription]', vm.id, error?.message || error)
  }
}
cliNodeGuard = createCliNodeGuard({
  listTargets: () => listVms(cfg.paths.project),
  liveTokens: () => slotShell.liveShellTokens?.() || [],
  getRouting: () => routingConfig,
})
// Opt-in (routing.crag_zombie_guard.enabled): power-cycles idle CRAG slots whose
// gateway worker left unreaped claude children, through the panel 恢复服务 path.
cragZombieGuard = createCragZombieGuard({
  config: routingConfig.crag_zombie_guard,
  listTargets: () => listVms(cfg.paths.project),
  getRouting: () => routingConfig,
  getVm: (id) => getVm(cfg.paths.project, id),
  inflight: (id) => poolScheduler?.vmInflight?.get(id) || 0,
  nativeHealth: (vm) => rustKernelHealth(slotExec(cfg.paths.project, vm), { timeoutMs: 2000 }),
  isFaulted: (id) => kernelFaults.has(id),
  lockBusy: (id) => vmLockBusy(path.join(cfg.paths.project, 'vms', `${id}.json`)),
  recover: (vm, { beforeStop = null, verifyAfter = null } = {}) =>
    withVmLock(path.join(cfg.paths.project, 'vms', `${vm.id}.json`), async () => {
      const fresh = getVm(cfg.paths.project, vm.id)
      if (!fresh || !isCragZombieGuardTarget(fresh, routingConfig) || !isCragZombieGuardSchedulable(fresh)) {
        return { ok: false, code: 'slot_state_changed' }
      }
      const result = await recoverSlot({
        projectRoot: cfg.paths.project,
        id: vm.id,
        proxyPool,
        routing: routingConfig,
        fillTimezone: (id) => fillVmTimezoneFromExit(cfg.paths.project, proxyPool, id),
        watchdog: kernelWatchdog,
        poolScheduler,
        internal: true,
        clearUnschedulable: false,
        beforeStop,
        verifyAfter,
      })
      if (result.ok && result.report?.ok === true && result.post_verify?.ok !== false) {
        panel.resetVmCircuit({ cfg, poolScheduler, id: vm.id })
        releaseKernelInstallSafetyHold(cfg.paths.project, vm.id, kernelWatchdog)
      }
      return result
    }),
  park: (id, detail) => markUnschedulable(cfg.paths.project, id, 'maintenance_failed', detail),
  notify: (message) =>
    routingConfig.notify?.enabled
      ? dispatchNotify(routingConfig.notify, message)
      : Promise.resolve({ ok: false, skipped: 'disabled' }),
})
for (const vm of listVms(cfg.paths.project)) {
  if (isCodexVm(vm)) continue
  try {
    stripWorkerCredentialEmail(path.join(cfg.paths.project, 'vms', vm.id, 'cli-home'))
  } catch (error) {
    console.warn('[credential-email-strip]', vm.id, error?.message || error)
  }
}

const listCragTargets = () =>
  listVms(cfg.paths.project)
    .map(({ id }) => getVm(cfg.paths.project, id))
    .filter(Boolean)

const isCragSlot = (vm) => !isNativeNodeVm(vm) && !isCodexVm(vm) && resolveKernelDataplane(vm, routingConfig) === 'crag'

const cragSubscription = createCragSubscription({
  projectRoot: cfg.paths.project,
  listTargets: listCragTargets,
  runtimeInventory: createCragRuntimeInventory({
    projectRoot: cfg.paths.project,
    listTargets: listCragTargets,
    getRouting: () => routingConfig,
  }),
  getTarget: (id) => getVm(cfg.paths.project, id),
  isLocalCragSlot: (vm) =>
    !isNativeNodeVm(vm) &&
    !isCodexVm(vm) &&
    (vm.node_id || isKvmRuntime(vm) || Boolean(installedCragV2Root(cfg.paths.project, vm))),
  isSubscriptionSlot: isCragSlot,
  assertReady: (vm, opts) => assertCragSubscriptionTarget(cfg.paths.project, vm, routingConfig, opts),
  isSlotEnabled: (vm, opts) => isCragSubscriptionSlotEnabled(cfg.paths.project, vm, routingConfig, opts),
})
configureCragRuntimeAdmission(cfg.paths.project, cragSubscription.withRuntimeAdmission)

function isCragShopAdmin(owner) {
  if (owner?.startsWith('panel:')) {
    const record = panelUsers.getById(owner.slice('panel:'.length))
    return !!record?.enabled && record.role === 'admin'
  }
  const configured = getPanelAdmin()
  return (
    !!configured.password &&
    owner === `configured-admin:${configured.username}` &&
    !panelUsers.getByUsername(configured.username)
  )
}

const cragShopActivationEnabled =
  process.env.KIN_CRS_MOCK !== '1' && process.env.VM2API_CRAG_SHOP_AUTO_ACTIVATION !== '0'
const handleCragShop = createCragShopHandler({
  getDb,
  dataDir: cfg.paths.data,
  publicBaseUrl: cfg.base_url,
  json,
  readRawBody,
  subscription: cragSubscription,
  isCurrentAdmin: (req) => isCragShopAdmin(req.panelBuyerOwner),
  isActivationAdmin: isCragShopAdmin,
  allowDeviceRequest: () => allowRate('crag-shop:device'),
  activationEnabled: cragShopActivationEnabled,
})

// Runtime CRAGGemini trust root: uses KIN_GEMINI_PUBLIC_KEY_FILE when configured for
// authority rotation, otherwise verifies against the SHA-256 pin in deploy/payload.json
// (never self-attesting from share/gemini/current).
const geminiCragSubscription = createGeminiCragSubscription({
  projectRoot: cfg.paths.project,
  dataDir: cfg.paths.data,
  publicKeyFile: process.env.KIN_GEMINI_PUBLIC_KEY_FILE || null,
  callHost: callGeminiHost,
})
const geminiTerminal = createGeminiTerminal({ proxyPool: () => proxyPool })
const geminiSlotPrefs = createGeminiSlotPrefs({
  settingsRepo: {
    get: (key, fallback) => new SettingsRepo().get(key, fallback),
    set: (key, value) => new SettingsRepo().set(key, value),
  },
})
const geminiScheduler = createGeminiScheduler({
  callHost: callGeminiHost,
  resolveProxy: (proxyId, envOwnerId) => geminiProxyFor(proxyPool, proxyId, { ownerUserId: envOwnerId }),
  resolveProxyEgressOptions: (proxyId, envOwnerId) =>
    geminiProxyEgressOptionsFor(proxyPool, proxyId, { ownerUserId: envOwnerId }),
  poolScheduler,
  stickyRouter,
  apiKeyStore,
  groupsRepo: { rateMultiplier: (id) => groupsRepo.rateMultiplier(id) },
  geminiOwnersRepo: geminiOwnersProxy,
  slotPrefs: geminiSlotPrefs,
  cragSubscription: geminiCragSubscription,
  getRoutingConfig: () => routingConfig,
  getAttemptsRepo: () => attemptsRepo,
  getSchedulerRuntime: () => schedulerRuntime,
  get schedulerRuntime() {
    return schedulerRuntime
  },
  listCacheTtlMs: 2000,
})
const handleGeminiPublic = createGeminiPublicHandler({
  json,
  readBody,
  scheduler: geminiScheduler,
  stickyRouter,
  requestLog,
  groupsRepo: { rateMultiplier: (id) => groupsRepo.rateMultiplier(id) },
  apiKeyStore,
  getRoutingConfig: () => routingConfig,
  getHealthMonitor: () => healthMonitor,
  getSchedulerRuntime: () => schedulerRuntime,
  get schedulerRuntime() {
    return schedulerRuntime
  },
  cfg,
  geminiOwnerMap: () => geminiOwnersProxy.ownerMap(),
})
schedulerRuntime = createSchedulerRuntime({
  cfg,
  isStandby: STANDBY,
  getDb,
  settings: () => new SettingsRepo(),
  getVms: () => listVms(cfg.paths.project, routingConfig),
  getRoutingConfig: () => routingConfig,
  apiKeyStore,
  apiEndpointStore,
  accountQuota,
  poolScheduler: () => poolScheduler,
  geminiScheduler: () => geminiScheduler,
  geminiSlotPrefs,
  geminiOwnersRepo: geminiOwnersProxy,
  cragSubscription,
  geminiCragSubscription,
  proxyPool: () => proxyPool,
  hostMemoryPressure,
  onError: (err, info) => {
    console.warn(`[scheduler-runtime] ${info?.phase || 'error'}:`, err?.message || err)
  },
})
poolScheduler?.setSchedulerRuntime?.(schedulerRuntime)
failoverRunner?.setSchedulerRuntime?.(schedulerRuntime)
apiScheduler?.setSchedulerRuntime?.(schedulerRuntime)
const integrationTokenStore = new IntegrationTokenStore()
const handlePanel = createPanelHandler({
  getDb,
  getSchedulerRuntime: () => schedulerRuntime,
  get schedulerRuntime() {
    return schedulerRuntime
  },
  integrationTokenStore,
  cragSubscription,
  geminiCragSubscription,
  geminiOwnersRepo: geminiOwnersProxy,
  geminiSlotPrefs,
  geminiScheduler,
  handleCragShop,
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
  get cragZombieGuard() {
    return cragZombieGuard
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
  slotDesktop,
  geminiTerminal,
})
const handleIntegration = createIntegrationHandler({
  tokenStore: integrationTokenStore,
  handlePanel,
  json,
  readBody,
})

let geminiTerminalDrain
// Timers started in the leader-only background block; stopped at handover or on server close.
const leaderStoppers = []
function onLeaderStop(fn) {
  leaderStoppers.push(fn)
}
let leaderJobsStopped = false
function stopLeaderJobs() {
  if (leaderJobsStopped) return
  leaderJobsStopped = true
  for (const fn of leaderStoppers.splice(0)) {
    try {
      fn()
    } catch {}
  }
  try {
    vmTestSchedule.stop()
  } catch {}
  try {
    backupService.stopScheduler()
    void backupService.abortRunning()
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
    slotCapacityReconciler.stop()
  } catch {}
  try {
    hostMemoryPressure?.stop?.()
  } catch {}
  try {
    cliNodeGuard?.stop?.()
  } catch {}
  try {
    cragZombieGuard?.stop?.()
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
}

// Blue/green step 2 (SIGUSR1): stop every leader job and hand the data-dir lock to the standby.
// The listener stays open, so requests arriving before haproxy switches over are still served.
async function handoverLeadership() {
  // Only a blue/green controller has a successor; a plain one would stop its jobs and drop the lock for nobody.
  if (!BLUEGREEN) {
    console.warn('[handover] SIGUSR1 ignored: not started as a blue/green controller (KIN_STANDBY=1)')
    return false
  }
  if (handoverRole() !== 'leader' || !standbyActive) return false
  stopLeaderJobs()
  // Flush final dirty sticky/penalty deltas while still holding the leader flock.
  await schedulerRuntime?.drainPersistenceNow?.().catch(() => {})
  schedulerRuntime?.demoteToStandby?.()
  setHandoverRole('draining')
  // Publish our live load first, so the new leader counts it from its first scheduling decision.
  try {
    foreignLoadWriter = startLoadWriter({
      file: foreignLoadPath(dataDir),
      read: () => exportLiveLoad({ scheduler: poolScheduler, accountQuota, apiKeys: apiKeyStore }),
    })
  } catch (e) {
    console.warn('[handover] foreign load writer failed', e?.message || e)
  }
  const unlocked = await controlPlaneFlock(['-u'])
  endPanelStreams()
  console.log(
    JSON.stringify({
      event: 'handover-released',
      ok: unlocked.status === 0,
      inflight: gracefulShutdown.getActiveCount(),
    }),
  )
  return unlocked.status === 0
}

// Panel live streams (/api/panel/pool/stream) never end on their own. A controller that is handing over or
// shutting down ends them, so an open panel tab does not hold the drain for its whole timeout; the browser
// reconnects (through haproxy, to the leader) and polls meanwhile.
const panelStreams = new Set()
function endPanelStreams() {
  for (const res of panelStreams) {
    try {
      res.end()
    } catch {}
  }
  panelStreams.clear()
}

const gracefulShutdown = createGracefulShutdown({
  // A backup worker stuck in VACUUM INTO keeps process.exit() waiting on its thread; the database is
  // closed by now and the snapshot is a scratch copy, so after a short grace exit hard.
  exit: (code) => {
    const deadline = Date.now() + 5_000
    const tick = () => {
      if (!backupService.busy) return process.exit(code)
      if (Date.now() > deadline) {
        console.warn('[shutdown] backup worker still busy; forcing exit')
        return process.kill(process.pid, 'SIGKILL')
      }
      setTimeout(tick, 100)
    }
    tick()
  },
  beforeDrain: async () => {
    endPanelStreams()
    geminiTerminalDrain = geminiTerminal.close()
    // A handed-over controller keeps recording usage for the streams it is still finishing.
    if (handoverRole() !== 'draining') installJevUsageRecorder(null)
    stopLeaderJobs()
  },
  afterDrain: async () => {
    foreignLoadWriter?.stop()
    // Let host cleanup finish without extending shutdown to the launch deadline.
    await Promise.race([geminiTerminalDrain, delay(2000, undefined, { ref: false })])
    try {
      stopVmWatch()
    } catch {}
    try {
      stopAllRustKernels()
    } catch {}
    try {
      // After a handover the relay socket paths belong to the new leader: close ours, leave the files.
      await clusterManager.stop({ unlink: handoverRole() !== 'draining' })
    } catch {}
    try {
      await schedulerRuntime?.shutdown?.({ drain: handoverRole() !== 'draining', stopProcess: true })
    } catch (e) {
      console.warn('[shutdown] scheduler-runtime shutdown failed', e?.message || e)
    }
    try {
      await closeDatabaseAsync()
    } catch {}
  },
})

const server = http.createServer(async (req, res) => {
  try {
    res.req = req
    const url = parseRequestUrl(req)
    if (url && isCragShopPath(url.pathname)) res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeadersForRequest(req))
      return res.end()
    }

    if (!url) {
      return json(res, 400, { error: { message: 'Invalid URL', type: 'invalid_request' } })
    }
    const p = url.pathname
    const role = handoverRole()
    if (role !== 'leader' && (p === '/health' || p === '/healthz')) {
      // haproxy keeps a standby/draining server out of rotation by state, not by health.
      if (!(role === 'draining' && gracefulShutdown.isShuttingDown())) return json(res, 200, { status: 'ok', role })
    }
    if (
      role === 'standby' ||
      (role === 'draining' &&
        (p.startsWith('/admin') || p.startsWith('/api/panel') || p.startsWith('/api/integration')))
    ) {
      // Admin writes go only to the leader; a standby serves nothing until it holds the lock.
      res.setHeader('Connection', 'close')
      return json(res, 503, {
        error: {
          type: 'overloaded_error',
          code: role === 'standby' ? CONTROLLER_STANDBY : CONTROLLER_DRAINING,
          message: 'Gateway is switching versions; retry shortly',
        },
      })
    }
    if (
      p === '/api/panel/pool/stream' ||
      p === '/api/panel/scheduler/events' ||
      (p.startsWith('/api/panel/') && String(req.headers.accept || '').includes('text/event-stream'))
    ) {
      panelStreams.add(res)
      res.once('close', () => panelStreams.delete(res))
    }
    if (gracefulShutdown.isShuttingDown()) {
      res.setHeader('Connection', 'close')
      if (p === '/health' || p === '/healthz') {
        return json(res, 503, { status: 'shutting_down' })
      }
      return json(res, 503, {
        error: {
          type: 'overloaded_error',
          code: 'server_shutting_down',
          message: 'Gateway is shutting down; retry shortly',
        },
      })
    }
    gracefulShutdown.trackRequest(req, res)

    if (isTelemetryPath(p)) {
      return json(res, 200, telemetryInterceptResponse(p))
    }

    if (
      backupService.isRestoring &&
      (p.startsWith('/v1/') ||
        p.startsWith('/v1beta/') ||
        p === '/messages' ||
        p === '/chat/completions' ||
        p === '/responses')
    ) {
      return json(
        res,
        503,
        makeError({
          type: ErrorType.OVERLOADED,
          code: 'restore_in_progress',
          message: 'Gateway is restoring from backup; retry shortly',
          status: 503,
        }).body,
      )
    }

    if (p.startsWith('/api/integration')) {
      const handled = await handleIntegration(req, res, url)
      if (handled !== false) return
    }

    if (p.startsWith('/admin') || p.startsWith('/api/panel')) {
      const handled = await handlePanel(req, res, url)
      if (handled !== false) return
    }

    if (req.method === 'GET' && tryServeWebDist(res, cfg.paths.project, p)) return
    if (req.method === 'GET' && isConsoleEntry(p)) {
      return json(res, 404, { error: { message: 'console not found; run pnpm -C web build' } })
    }

    // Liveness check: no authentication or inference.
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
        features: featuresNow(),
        capabilities: GATEWAY_CAPABILITIES,
        limitations: LIMITATIONS,
        stats,
        health_probe: healthMonitor?.getSnapshot?.() || null,
        api_kernel: {
          ...apiKernelSnapshot(cfg),
          endpoints: apiEndpointStore.listRaw().filter((ep) => !ep.disabled).length,
        },
      })
    }

    if (req.method === 'GET' && p === '/v1/meta') {
      return json(res, 200, {
        base_url: cfg.base_url,
        rewrite_default: cfg.rewrite.enabled,
        features: featuresNow(),
        capabilities: GATEWAY_CAPABILITIES,
        limitations: LIMITATIONS,
        endpoints: {
          chat_completions: '/v1/chat/completions',
          responses: '/v1/responses',
          messages: '/v1/messages',
          usage: '/v1/usage',
          me_quota: '/v1/me/quota',
          me_usage: '/v1/me/usage',
          models: '/v1/models',
          intercept_rules: '/admin/intercept/rules',
        },
        vm: { id: cfg.vm.id, email: cfg.vm.email },
      })
    }

    const singleModelGet = req.method === 'GET' ? parseGeminiModelGetPath(p) : null
    if (
      req.method === 'GET' &&
      (p === '/v1/models' || p === '/models' || p === '/v1beta/models' || Boolean(singleModelGet))
    ) {
      if (!requireAuth(req, res)) return
      const modelOwnerScope = ownerScopeFromRequest(req, apiKeyStore?.users)
      const modelVms = listVms(cfg.paths.project)
      const modelApiEndpoints = apiEndpointStore.listRaw()
      const modelPoolAccess = resolvePoolAccessForKey({
        key: req.apiKeyRecord || null,
        apiKeyKind: req.apiKeyKind || null,
        requestedPoolId: requestedPoolIdFromHeaders(req.headers),
        vms: Array.isArray(modelVms) ? modelVms : null,
        geminiOwnerMap: geminiOwnersProxy.ownerMap(),
        apiEndpoints: Array.isArray(modelApiEndpoints) ? modelApiEndpoints : null,
        ownerScope: modelOwnerScope,
      })
      if (!modelPoolAccess.ok) {
        const status = modelPoolAccess.status || 403
        const code = modelPoolAccess.code || 'pool_unavailable'
        const message = modelPoolAccess.message || '分组池不可用'
        if (p === '/v1beta/models' || singleModelGet?.version === 'v1beta') {
          return json(res, status, {
            error: {
              code: status,
              status: 'PERMISSION_DENIED',
              message,
              details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: code }],
            },
          })
        }
        return json(res, status, makeError({ type: ErrorType.PERMISSION, code, message, status }).body)
      }
      const groupType = keyScopeFromRequest(req).group_type
      const backend = resolveInferenceBackend(req)
      let apiScopeForModels = apiScheduleScope(req, groupType, apiKeyStore?.users)
      if (!modelPoolAccess.legacy) {
        const poolEps = modelPoolAccess.allowedEndpointIds || []
        const existingEps = apiScopeForModels.allowedEndpointIds
        apiScopeForModels = {
          ...apiScopeForModels,
          allowedEndpointIds:
            Array.isArray(existingEps) && existingEps.length
              ? existingEps.filter((id) => poolEps.includes(id))
              : [...poolEps],
        }
      }
      const poolFilterCtx = { vms: modelVms, apiEndpoints: modelApiEndpoints }
      if (backend === 'api') {
        const filtered = filterModelsForPoolAccess(
          filterModelCatalogForKey(apiScheduler.catalog(apiScopeForModels), req),
          modelPoolAccess,
          poolFilterCtx,
        )
        if (singleModelGet) {
          const want = singleModelGet.model.replace(/^models\//i, '').toLowerCase()
          const hit = (filtered?.data || []).find((m) => String(m?.id || '').toLowerCase() === want)
          if (!hit) {
            return json(res, 404, {
              error: {
                type: 'not_found_error',
                code: 'model_not_found',
                message: `Model not found: ${singleModelGet.model}`,
              },
            })
          }
          return json(res, 200, singleModelGet.version === 'v1beta' ? googleModelEntry(hit) : hit)
        }
        return json(res, 200, p === '/v1beta/models' ? formatGoogleModelList(filtered?.data || []) : filtered)
      }
      const modelPolicy = req.apiKeyKind === 'managed' ? keyTierPolicyFromRecord(req.apiKeyRecord) : null
      let allowedGeminiEnvs =
        modelPolicy?.permission_tier === 'resource'
          ? modelPolicy.allowed_gemini_envs
          : modelPolicy?.allowed_gemini_envs?.length
            ? modelPolicy.allowed_gemini_envs
            : null
      if (!modelPoolAccess.legacy) {
        const poolEnvs = modelPoolAccess.allowedGeminiEnvIds || []
        allowedGeminiEnvs = Array.isArray(allowedGeminiEnvs)
          ? allowedGeminiEnvs.filter((id) => poolEnvs.includes(id))
          : [...poolEnvs]
      }
      const modelGeminiScope = {
        ownerScope: modelOwnerScope,
        allowedEnvIds: allowedGeminiEnvs,
      }
      if (p === '/v1beta/models' || singleModelGet?.version === 'v1beta' || groupType === 'gemini') {
        if (backend === 'all') {
          let gemModels = []
          let gemAccounts = null
          try {
            const gemCat = await geminiScheduler.catalog(modelGeminiScope)
            gemModels = Array.isArray(gemCat?.models) ? gemCat.models : []
            gemAccounts = Array.isArray(gemCat?.accounts) ? gemCat.accounts : null
          } catch {}
          let gemApiScope = apiScheduleScope(req, 'gemini', apiKeyStore?.users)
          if (!modelPoolAccess.legacy) {
            const poolEps = modelPoolAccess.allowedEndpointIds || []
            const existingEps = gemApiScope.allowedEndpointIds
            gemApiScope = {
              ...gemApiScope,
              allowedEndpointIds:
                Array.isArray(existingEps) && existingEps.length
                  ? existingEps.filter((id) => poolEps.includes(id))
                  : [...poolEps],
            }
          }
          const apiCat = apiScheduler.catalog(gemApiScope)
          const merged = []
          const seen = new Set()
          for (const m of [...gemModels, ...(apiCat?.data || [])]) {
            const id = String(m?.id || '').toLowerCase()
            if (!id || seen.has(id)) continue
            seen.add(id)
            merged.push(m)
          }
          const filtered = filterModelsForPoolAccess(
            filterModelCatalogForKey({ object: 'list', data: merged }, req),
            modelPoolAccess,
            { ...poolFilterCtx, geminiEnvs: gemAccounts },
          )
          if (singleModelGet) {
            const want = singleModelGet.model.replace(/^models\//i, '').toLowerCase()
            const hit = (filtered?.data || []).find((m) => String(m?.id || '').toLowerCase() === want)
            if (!hit) {
              return json(res, 404, {
                error: {
                  type: 'not_found_error',
                  code: 'model_not_found',
                  message: `Model not found: ${singleModelGet.model}`,
                },
              })
            }
            return json(res, 200, singleModelGet.version === 'v1beta' ? googleModelEntry(hit) : hit)
          }
          return json(res, 200, p === '/v1beta/models' ? formatGoogleModelList(filtered?.data || []) : filtered)
        }
        return handleGeminiPublic(req, res)
      }
      const result = await fetchWorkerModels({ groupType })
      let gemAccountsForAll = null
      if (groupType === 'all') {
        try {
          const gemCatalog = await geminiScheduler.catalog(modelGeminiScope)
          gemAccountsForAll = Array.isArray(gemCatalog?.accounts) ? gemCatalog.accounts : null
          if (Array.isArray(gemCatalog?.models) && gemCatalog.models.length) {
            const existing = Array.isArray(result?.data) ? result.data : []
            const seen = new Set(existing.map((m) => m?.id).filter(Boolean))
            const extra = gemCatalog.models.filter((m) => m?.id && !seen.has(m.id))
            if (extra.length) result.data = [...existing, ...extra]
          }
        } catch {}
      }
      if (backend === 'all') {
        const apiCat = apiScheduler.catalog(apiScopeForModels)
        if (Array.isArray(apiCat?.data) && apiCat.data.length) {
          const existing = Array.isArray(result?.data) ? result.data : []
          const seen = new Set(existing.map((m) => String(m?.id || '').toLowerCase()).filter(Boolean))
          const extra = apiCat.data.filter((m) => m?.id && !seen.has(String(m.id).toLowerCase()))
          if (extra.length) result.data = [...existing, ...extra]
        }
      }
      const filtered = filterModelsForPoolAccess(filterModelCatalogForKey(result, req), modelPoolAccess, {
        ...poolFilterCtx,
        geminiEnvs: gemAccountsForAll,
      })
      if (singleModelGet) {
        const want = singleModelGet.model.replace(/^models\//i, '').toLowerCase()
        const hit = (filtered?.data || []).find((m) => String(m?.id || '').toLowerCase() === want)
        if (!hit) {
          return json(res, 404, {
            error: {
              type: 'not_found_error',
              code: 'model_not_found',
              message: `Model not found: ${singleModelGet.model}`,
            },
          })
        }
        return json(res, 200, hit)
      }
      return json(res, 200, filtered)
    }
    if (req.method === 'POST' && p === '/admin/models/refresh') {
      if (!requireAuth(req, res)) return
      const result = await fetchWorkerModels()
      return json(res, 200, result)
    }
    if (req.method === 'GET' && p === '/v1/usage') {
      return await handleUserUsage(req, res, {
        json,
        requireAuth,
        apiKeyStore,
        stickyRouter,
        accountQuota,
        projectRoot: cfg.paths.project,
        getPoolScheduler: () => poolScheduler,
      })
    }
    if (req.method === 'GET' && KEY_SELF_PATHS.has(p)) {
      return await handleKeySelf(req, res, url)
    }
    if (req.method === 'POST' && (p === '/v1/messages/count_tokens' || p === '/messages/count_tokens')) {
      // Off by default: the handler and its Go-worker hop were kept when 94b6f728
      // stubbed this entry, so the switch only decides whether to reach them.
      if (!countTokensEnabled(routingConfig)) return json(res, 404, { error: { message: 'not found: ' + p } })
      return await handleUserCountTokens(req, res, {
        json,
        readBody,
        requireAuth,
        apiKeyStore,
        cfg,
        projectRoot: cfg.paths.project,
        stickyRouter,
        accountQuota,
        getPoolScheduler: () => poolScheduler,
        getRoutingConfig: () => routingConfig,
      })
    }

    if (isGeminiPublicPath(p)) {
      if (!requireAuth(req, res)) return
      const gemGen = req.method === 'POST' ? parseGeminiGeneratePath(p) : null
      const backend = resolveInferenceBackend(req)
      if (gemGen && backend === 'api') {
        return await handleProtocol(req, res, 'google.gemini', p, {
          routeModel: gemGen.model,
          routeStream: gemGen.stream,
        })
      }
      let preloadedGemCat = null
      if (gemGen && backend === 'all') {
        const policy = req.apiKeyKind === 'managed' ? keyTierPolicyFromRecord(req.apiKeyRecord) : null
        const gemScope = {
          ownerScope: ownerScopeFromRequest(req, apiKeyStore?.users),
          allowedEnvIds:
            policy?.permission_tier === 'resource'
              ? policy.allowed_gemini_envs
              : policy?.allowed_gemini_envs?.length
                ? policy.allowed_gemini_envs
                : null,
        }
        let hasOwnedGemEnv = false
        try {
          const cat = await geminiScheduler.catalog(gemScope)
          preloadedGemCat = cat
          hasOwnedGemEnv = Array.isArray(cat?.accounts) && cat.accounts.length > 0
        } catch {
          hasOwnedGemEnv = false
        }
        if (
          !hasOwnedGemEnv &&
          apiScheduler.matchEndpoints(gemGen.model, Date.now(), apiScheduleScope(req, 'gemini', apiKeyStore?.users))?.ok
        ) {
          return await handleProtocol(req, res, 'google.gemini', p, {
            routeModel: gemGen.model,
            routeStream: gemGen.stream,
          })
        }
      }
      return handleGeminiPublic(req, res, preloadedGemCat ? { catalogSnapshot: preloadedGemCat } : {})
    }
    // A shared path only belongs to Gemini when the key does. Dispatching on
    // the path alone would make the OpenAI handlers below unreachable, and
    // every other caller would get gemini_key_required. requireAuth has to run
    // first: it is what populates the key record this reads.
    if (isGeminiSharedPath(p)) {
      if (!requireAuth(req, res)) return
      if (keyScopeFromRequest(req).group_type === 'gemini') return handleGeminiPublic(req, res)
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
    if (req.method === 'POST' && (p === '/v1/images/generations' || p === '/images/generations')) {
      return await handleImages(req, res, p, 'generations')
    }
    if (req.method === 'POST' && (p === '/v1/images/edits' || p === '/images/edits')) {
      return await handleImages(req, res, p, 'edits')
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
  }
})
server.on('upgrade', (req, socket, head) => {
  if (gracefulShutdown.isShuttingDown()) {
    socket.destroy()
    return
  }
  if (geminiTerminal.handleUpgrade(req, socket, head)) return
  if (responsesWs.handleUpgrade(req, socket, head)) return
  if (clusterRoutes.handleUpgrade(req, socket, head)) return
  if (slotDesktop.handleUpgrade(req, socket, head)) return
  if (!slotShell.handleUpgrade(req, socket, head)) socket.destroy()
})
gracefulShutdown.setServer(server)

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
    usage: publicEndpoint('/v1/usage'),
    me_quota: publicEndpoint('/v1/me/quota'),
    me_usage: publicEndpoint('/v1/me/usage'),
    intercept_rules: publicEndpoint('/admin/intercept/rules'),
  },
}
// Never persist the raw API key. Public snapshot only.
fs.writeFileSync(path.join(cfg.paths.root, 'config', 'gateway-v2.public.json'), JSON.stringify(pub, null, 2))

process.on('uncaughtException', (e) => console.error('[uncaught]', e))
process.on('unhandledRejection', (e) => console.error('[unhandled]', e))

// Graceful shutdown on termination signals (Issue #376).
process.on('SIGTERM', () => gracefulShutdown.shutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown.shutdown('SIGINT'))
process.on('SIGUSR2', () => void activateStandby('SIGUSR2'))
process.on('SIGUSR1', () => void handoverLeadership())
// Blue/green step 6 (SIGHUP to the new leader): the old controller has exited. Now refresh the
// shared binaries this image ships (the standby skipped that), then run what the overlap held back.
// Kernels pick up a new wrap only when idle, so this leader's own streams are not cut.
let exclusivePass = null
function runExclusivePass() {
  if (handoverRole() !== 'leader' || exclusivePass) return exclusivePass
  exclusivePass = (async () => {
    const keys = deferredKeys()
    foreignLoadReader?.stop()
    foreignLoadReader = null
    schedulerRuntime?.setExternalLoadProvider?.(null)
    // Async: copying a new image's binaries can take a while and must not hold the event loop.
    const synced = await runCapture('/usr/local/bin/vm2api-entrypoint', ['sync'], { timeoutMs: 120_000 })
    const wrapChanged = /WRAP_CHANGED=1/.test(synced.stdout || '')
    if (synced.status !== 0) console.error(`[handover] shared sync failed: ${(synced.stderr || '').trim().slice(-300)}`)
    refreshGuestBin()
    const done = await markExclusive()
    // Gates whose recreate was deferred were just ensured by markExclusive; re-check only the others.
    const gatesDone = new Set(done.filter((k) => k.startsWith('gate:')).map((k) => k.slice(5)))
    if (process.env.KIN_CRS_MOCK !== '1') await clusterManager.refreshGates({ skip: gatesDone }).catch(() => {})
    if (wrapChanged && process.env.KIN_AUTO_SYNC_WRAP === '1') {
      const summary = await syncInstalledKernels({
        project: cfg.paths.project,
        routingConfig,
        body: { restart: true },
        // Settles when the kernel actually reloaded, so the summary does not report a pending reload as done.
        restartKernel: async (exec) => {
          const r = requestKernelReloadWhenIdle(exec)
          return r?.done ? await r.done : r
        },
        refreshCluster: (project, vms, opts) =>
          refreshClusterSlotPayloads(project, vms, { ...opts, refreshFn: refreshClusterSlotWhenIdle }),
      }).catch((e) => ({ ok: false, error: e?.message || String(e) }))
      const failed = (summary?.items || []).filter((item) => !item.ok)
      console.log(
        JSON.stringify({
          event: 'handover-wrap-sync',
          ok: summary?.ok !== false,
          error: summary?.error || null,
          failed: failed
            .slice(0, 20)
            .map((item) => ({ id: item.id, code: item.code || null, error: item.error || null })),
        }),
      )
    }
    console.log(
      JSON.stringify({ event: 'handover-exclusive', synced: synced.status === 0, wrapChanged, deferred: keys, done }),
    )
  })()
  return exclusivePass
}
process.on('SIGHUP', () => void runExclusivePass())
// A cluster slot takes a new payload by recreating its container, which would cut this leader's
// streams on it. Build the image first, then recreate once the slot has no request here; a slot
// that stays busy is left on its current payload for the next kernel sync.
async function refreshClusterSlotWhenIdle(vm, projectRoot, opts = {}, { timeoutMs = 10 * 60_000, pollMs = 1000 } = {}) {
  const check = await inspectClusterPayloadChanges(projectRoot, [vm], { routing: opts.routing }).catch(() => null)
  const item = check?.items?.[0]
  if (item && item.ok && item.kernel_changed === false) return refreshNodeSlotPayload(vm, projectRoot, opts)
  if (!item?.native && vm.status === 'running') {
    const built = await refreshNodeSlotPayload(vm, projectRoot, { ...opts, recreate: false })
    if (!built?.ok) return built
  }
  const deadline = Date.now() + timeoutMs
  while ((poolScheduler.vmInflight.get(vm.id) || 0) > 0) {
    if (Date.now() >= deadline) {
      return {
        id: vm.id,
        node_id: item?.node_id || null,
        ok: false,
        code: 'slot_busy',
        error: 'slot stayed busy; payload left for the next kernel sync',
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return refreshNodeSlotPayload(vm, projectRoot, opts)
}
function runCapture(cmd, args, { timeoutMs }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ status: null, stdout: '', stderr: e?.message || String(e) })
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ status: null, stdout, stderr: stderr + (e?.message || '') })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ status: code, stdout, stderr })
    })
  })
}

if (process.env.KIN_CRS_MOCK !== '1') {
  runAtActivation('restart-policies', () =>
    syncLocalSlotRestartPolicies(listVms(cfg.paths.project), { routing: routingConfig }),
  )
}
await bootApiKernel(cfg)
await bootProtoFront(cfg)
if (process.env.KIN_CRS_MOCK !== '1' || fs.existsSync(schedulerRuntime.client.paths.binPath)) {
  try {
    await schedulerRuntime.start({ waitMs: 5_000, startLoops: true })
  } catch (e) {
    console.error('[scheduler-runtime] startup failed (Fail-Closed 503 until recovered):', e?.message || e)
  }
}
server.keepAliveTimeout = 120_000
server.headersTimeout = 125_000
server.timeout = 0

server.listen(cfg.port, cfg.host, () => {
  runAtActivation('background', () => {
    if (getDbEngine() === 'postgres' && process.env.VM2API_DASHBOARD_AGGREGATOR_DISABLED !== '1') {
      startDashboardAggregator(getPgPool())
      onLeaderStop(() => stopDashboardAggregator())
    }
    if (process.env.KIN_CRS_MOCK !== '1') {
      void cragSubscription.recover().catch(() => {
        console.warn('[crag-subscription] startup recovery failed; use the administrator panel to retry')
      })
      void geminiCragSubscription.recover().catch(() => {
        console.warn('[crag-gemini-subscription] startup recovery failed; will retry in background')
      })
      let maintainingGeminiSub = false
      const maintainGeminiSub = () => {
        if (maintainingGeminiSub) return
        maintainingGeminiSub = true
        void (async () => {
          if (geminiCragSubscription.hasSyncPending?.()) {
            await geminiCragSubscription.recover().catch(() => {
              console.warn('[crag-gemini-subscription] background sync-pending recovery deferred')
            })
          }
          await geminiCragSubscription.refreshExpiredEntitlement?.().catch(() => {
            console.warn('[crag-gemini-subscription] expired quota refresh deferred')
          })
        })().finally(() => {
          maintainingGeminiSub = false
        })
      }
      const geminiSubTimer = setInterval(maintainGeminiSub, 15_000).unref()
      onLeaderStop(() => clearInterval(geminiSubTimer))
      maintainGeminiSub()
      const refresh = () =>
        void cragSubscription.refreshExpiredEntitlement().catch(() => {
          console.warn('[crag-subscription] expired quota refresh deferred')
        })
      const timer = setInterval(refresh, 1_000).unref()
      onLeaderStop(() => clearInterval(timer))
      refresh()
    }
    if (cragShopActivationEnabled) {
      const poll = () =>
        void handleCragShop.pollActivation().catch(() => {
          console.warn('[crag-shop] activation polling deferred')
        })
      const timer = setInterval(poll, 2_000).unref()
      onLeaderStop(() => clearInterval(timer))
      poll()
    }
    // An unpaid checkout link outliving its payment window is part of the order
    // lifecycle, so this runs whether or not activation polling is enabled. One order
    // per tick, so a backlog drains without bursting requests at the supplier.
    {
      const expireOrders = () =>
        void handleCragShop.pollOrderExpiry().catch(() => {
          console.warn('[crag-shop] order expiry deferred')
        })
      const timer = setInterval(expireOrders, 60_000).unref()
      onLeaderStop(() => clearInterval(timer))
      expireOrders()
    }
    if (process.env.KIN_CRS_MOCK !== '1' && typeof handleCragShop.warmPlans === 'function') {
      const warmCatalog = () =>
        void handleCragShop.warmPlans().catch(() => {
          console.warn('[crag-shop] catalog cache warm deferred')
        })
      const timer = setInterval(warmCatalog, 5 * 60_000).unref()
      onLeaderStop(() => clearInterval(timer))
      warmCatalog()
    }
    // Installation intent is durable; reconnecting nodes must not depend on a lost HTTP callback.
    if (process.env.KIN_CRS_MOCK !== '1') {
      let resuming = false
      const resume = async () => {
        if (resuming) return
        resuming = true
        try {
          const report = await resumePendingKernelInstalls({
            projectRoot: cfg.paths.project,
            routing: routingConfig,
            watchdog: kernelWatchdog,
            poolScheduler,
            releaseStoppedBinding: cragSubscription.releaseStoppedBinding.bind(cragSubscription),
          })
          for (const item of report.items) {
            if (!item.ok) console.warn(`[kernel-install] ${item.id} recovery failed (${item.code})`)
          }
        } catch (error) {
          console.warn(`[kernel-install] recovery pass failed (${error?.code || 'unknown'})`)
        } finally {
          resuming = false
        }
      }
      void resume()
      const timer = setInterval(resume, 15_000)
      timer.unref()
      onLeaderStop(() => clearInterval(timer))
    }
    // Keep authorized CRAGGemini native kernels & resident agy slots warm across restarts.
    if (process.env.KIN_CRS_MOCK !== '1') {
      let warmingGemini = false
      const warmGemini = async () => {
        if (warmingGemini) return
        warmingGemini = true
        try {
          await warmGeminiEnvironments({
            callHost: callGeminiHost,
            proxyPool: () => proxyPool,
          })
        } catch {
          // Host daemon may be absent on non-Gemini installs; stay silent.
        } finally {
          warmingGemini = false
        }
      }
      void warmGemini()
      const timer = setInterval(warmGemini, 30_000)
      timer.unref()
      onLeaderStop(() => clearInterval(timer))

      // Periodic Gemini account status, auth, eligibility, and quota replenishment checker.
      let checkingGeminiAccounts = false
      const checkGemini = async () => {
        if (checkingGeminiAccounts) return
        checkingGeminiAccounts = true
        try {
          await checkGeminiAccounts({
            callHost: callGeminiHost,
            proxyPool: () => proxyPool,
            slotPrefs: geminiSlotPrefs,
            geminiScheduler,
            geminiOwnersRepo: geminiOwnersProxy,
            getRoutingConfig: () => routingConfig,
          })
        } catch {
          // Host daemon may be absent on non-Gemini installs; stay silent.
        } finally {
          checkingGeminiAccounts = false
        }
      }
      const checkTimer = setInterval(checkGemini, 60_000)
      checkTimer.unref()
      onLeaderStop(() => clearInterval(checkTimer))
    }
    try {
      vmTestSchedule.start()
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
      // Size slots before the watchdog compares kernel slot counts: otherwise a slot
      // still recorded at its old small limits is reloaded down, then up again.
      slotCapacityReconciler
        .tick()
        .catch(() => {})
        .finally(() => {
          slotCapacityReconciler.start()
          kernelWatchdog?.start?.({ immediate: true })
        })
    } catch (e) {
      console.warn('[kernel-watchdog] start failed', e?.message || e)
    }
    // Proxy slots do not auto-start with Docker: boot restores egress before starting recorded-running slots.
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
      cragZombieGuard?.start?.()
    } catch (e) {
      console.warn('[crag-zombie-guard] start failed', e?.message || e)
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
  })
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
  console.log(
    JSON.stringify({
      event: 'vm2api-started',
      port: boundPort,
      base_url: cfg.base_url,
      db_engine: getDbEngine(),
      cache_mode: snapshotCacheMetrics()?.mode || 'l1',
      active_vm: getActiveVmId(cfg.paths.project),
      features: pub.features,
      capabilities: GATEWAY_CAPABILITIES,
      rewrite: cfg.rewrite.enabled,
      standby: STANDBY,
    }),
  )
  if (syncWrapAtStartup)
    runAtActivation('wrap-sync', () => {
      // Stay in the owning process: an HTTP request could hit a different controller after a failed start.
      void Promise.resolve()
        .then(() => syncInstalledKernels({ project: cfg.paths.project, routingConfig, body: { restart: true } }))
        .then((report) => {
          const summary = `${report.ok_count}/${report.total}, failed=${report.failed_count}`
          if (report.ok) console.log(`vm2api: wrap-cli slot sync complete (${summary})`)
          else console.error(`vm2api: wrap-cli slot sync failed (${summary})`)
        })
        .catch((error) => console.error(`vm2api: wrap-cli slot sync failed: ${error?.message || error}`))
    })
})
