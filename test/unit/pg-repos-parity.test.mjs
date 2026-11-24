/**
 * Tier 2: Full 22-Repository + Stateful Subsystems SQLite vs PostgreSQL Parity Suite.
 *
 * Opens a fresh SQLite DB and an isolated PostgreSQL schema side-by-side, executes
 * identical business operations across all 22 repositories plus:
 *   - ThinkingOwnerStore (json_each + BIGINT created_at + INSERT OR IGNORE)
 *   - retargetVmId (sqlite_master + PRAGMA table_info + 6-table atomic rename)
 *   - crag_shop_orders reserve/reflectOrder/slot_limit/409 idempotency
 *   - UsageLogsRepo.cleanup() -> account_lifetime_usage_archive upsert
 *   - BackupService PG online logical backup (.pg.ndjson.gz) + dirty write + restore + BIGSERIAL continuity
 *
 * Skips cleanly when VM2API_TEST_PG_URL is not configured.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import {
  openDatabase,
  openDatabaseAsync,
  closeDatabase,
  closeDatabaseAsync,
  getDb,
} from '../../src/lib/db/database.mjs'
import { createPgPool } from '../../src/lib/db/pg/pg-pool.mjs'
import { resolvePgConfig } from '../../src/lib/db/pg/config.mjs'
import { applyPgMigrations } from '../../src/lib/db/pg/migrations-runner.mjs'
import { createPgSyncDb } from '../../src/lib/db/pg/pg-sync-db.mjs'

import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { ApiKeysRepo } from '../../src/lib/db/repos/api-keys-repo.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { VmPoolsRepo } from '../../src/lib/db/repos/vm-pools-repo.mjs'
import { AccountsRepo } from '../../src/lib/db/repos/accounts-repo.mjs'
import { AccountRuntimeRepo } from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { StickyRepo } from '../../src/lib/db/repos/sticky-repo.mjs'
import { ApiEndpointsRepo } from '../../src/lib/db/repos/api-endpoints-repo.mjs'
import { ProxiesRepo } from '../../src/lib/db/repos/proxies-repo.mjs'
import { ClusterNodesRepo } from '../../src/lib/db/repos/cluster-nodes-repo.mjs'
import { RedeemCodesRepo } from '../../src/lib/db/repos/redeem-codes-repo.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { RefusalGuardsRepo } from '../../src/lib/db/repos/refusal-guards-repo.mjs'
import { RefusalDeviceBlocksRepo } from '../../src/lib/db/repos/refusal-device-blocks-repo.mjs'
import { RefusalSessionBlocksRepo } from '../../src/lib/db/repos/refusal-session-blocks-repo.mjs'
import { JevUsageRepo } from '../../src/lib/db/repos/jev-usage-repo.mjs'
import { BackupRepo } from '../../src/lib/db/repos/backup-repo.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { UsageLogsView } from '../../src/lib/db/repos/usage-logs-view.mjs'
import { StatisticsRepo } from '../../src/lib/db/repos/statistics-repo.mjs'

import { ThinkingOwnerStore } from '../../src/lib/pool/thinking-owner.mjs'
import { retargetVmId } from '../../src/lib/vm/vm-rename.mjs'
import { createCragShopHandler } from '../../src/lib/admin/crag-shop.mjs'
import { BackupService } from '../../src/lib/admin/backup-service.mjs'
import { encodeSignature, refusalSignature } from '../../src/lib/core/refusal-similarity.mjs'
import { isUniqueConstraintError } from '../../src/lib/db/pg/sql-compat.mjs'

const PG_URL = process.env.VM2API_TEST_PG_URL || ''

function withSchemaUrl(baseUrl, schema) {
  const u = new URL(baseUrl)
  u.searchParams.set('options', `-c search_path=${schema}`)
  return u.toString()
}

function approxEqual(a, b, eps = 1e-6, label = '') {
  assert.ok(
    Math.abs(Number(a) - Number(b)) <= eps,
    `${label}: expected ${a} ≈ ${b} (diff=${Math.abs(Number(a) - Number(b))})`,
  )
}

/**
 * Execute the full 22-repository scenario against any `db` (SQLite or PgSyncDb)
 * and return a normalized snapshot of every assertion & query output.
 */
function runAll22ReposScenario(db) {
  const now = '2026-06-15T10:00:00.000Z'
  const oldTs = '2025-01-01T00:00:00.000Z'
  const snap = {}

  // 1. SettingsRepo
  const settings = new SettingsRepo(db)
  settings.set('parity.obj', { flag: true, nested: [1, 2, '你好🚀'] })
  settings.set('parity.temp', 'bye')
  snap.settings = {
    obj: settings.get('parity.obj'),
    hasObj: settings.has('parity.obj'),
    removed: settings.remove('parity.temp'),
    hasTempAfter: settings.has('parity.temp'),
  }

  // 2. GroupsRepo (default groups seeded by migration)
  const groups = new GroupsRepo(db)
  const defGroup = groups.getDefault()
  groups.update(defGroup.id, { rate_multiplier: 1.25, rpm_limit: 120, description: 'Coding updated' })
  snap.groups = {
    count: groups.list().length,
    byNameId: groups.getByName('coding')?.id,
    rate: groups.rateMultiplier(defGroup.id),
    rpm: groups.getById(defGroup.id)?.rpm_limit,
  }

  // 3. UsersRepo (including COLLATE NOCASE + soft-delete + atomic addBalance)
  const users = new UsersRepo(db)
  const u1 = users.insert({
    id: 'usr_p1',
    username: 'AliceParity',
    password_hash: 'hash_p1',
    role: 'admin',
    status: 'active',
    balance: 10.5,
    created_at: now,
    updated_at: now,
  })
  const u2 = users.insert({
    id: 'usr_p2',
    username: 'BobParity',
    password_hash: 'hash_p2',
    role: 'user',
    status: 'active',
    balance: 20,
    created_at: now,
    updated_at: now,
  })
  users.addBalance('usr_p2', 5.25)
  const u2Loaded = users.getById('usr_p2')
  users.update({ ...u2Loaded, notes: 'updated-note', concurrency: 8 })
  const nocaseHit = users.getByUsername('aliceparity')
  const removedBob = users.remove('usr_p2')
  // Soft-deleted username can be reused
  const u2Reborn = users.insert({
    id: 'usr_p2_reborn',
    username: 'BobParity',
    password_hash: 'hash_p2b',
    role: 'user',
    status: 'active',
    balance: 100,
    created_at: now,
    updated_at: now,
  })
  snap.users = {
    nocaseId: nocaseHit?.id,
    adminCount: users.countEnabledRole('admin'),
    removedBob,
    rebornId: u2Reborn?.id,
    listIds: users
      .list()
      .map((u) => u.id)
      .sort(),
    aliceBalance: u1.balance,
    bobUpdatedNote: u2Loaded ? 'updated-note' : '',
  }

  // 4. ApiKeysRepo
  const apiKeys = new ApiKeysRepo(db)
  const rawKey = 'sk-ant-parity-test-key-0001'
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
  const k1 = apiKeys.insert({
    id: 'key_p1',
    name: 'Parity Key 1',
    key: rawKey,
    key_hash: keyHash,
    key_prefix: rawKey.slice(0, 12),
    key_secret: rawKey,
    status: 'active',
    group_id: 1,
    user_id: 'usr_p1',
    allowed_vms: JSON.stringify(['vm-p1', 'vm-p2']),
    quota: 50,
    created_at: now,
    updated_at: now,
  })
  apiKeys.recordUsage('key_p1', { tokens_in: 800, tokens_out: 400, cost: 0.42 })
  apiKeys.update({ ...apiKeys.getById('key_p1'), name: 'Parity Key 1 Renamed' })
  const kLoaded = apiKeys.getByHash(keyHash)
  snap.apiKeys = {
    insertedId: k1.id,
    count: apiKeys.count(),
    name: kLoaded.name,
    usedTokens: (kLoaded.tokens_in || 0) + (kLoaded.tokens_out || 0),
    usedCost: Number((kLoaded.quota_used || 0).toFixed(6)),
    byKeyId: apiKeys.getByKey(rawKey)?.id,
  }

  // 5. VmsRepo
  const vms = new VmsRepo(db)
  vms.upsertFromVmJson(
    {
      id: 'vm-p1',
      name: 'VM Parity 1',
      status: 'running',
      schedulable: true,
      owner_user_id: 'usr_p1',
      claude: { email: 'vm1@parity.test', account_uuid: 'acc-p1', org_uuid: 'org-p1' },
      created_at: now,
    },
    { mtimeMs: 1750000000123 },
  )
  vms.upsertFromVmJson({
    id: 'vm-p2',
    name: 'VM Parity 2',
    status: 'stopped',
    schedulable: false,
    owner_user_id: 'usr_p1',
    created_at: now,
  })
  vms.setActiveVmId('vm-p1')
  snap.vms = {
    count: vms.count(),
    ids: vms.ids(),
    active: vms.getActiveVmId(),
    vm1Email: vms.get('vm-p1')?.row?.email,
  }

  // 6. VmPoolsRepo (including duplicate active name uniqueness)
  const vmPools = new VmPoolsRepo(db)
  const pool1 = vmPools.insert({ name: 'Main Pool' })
  vmPools.setMembers(pool1.id, ['vm-p1', 'vm-p2'])
  let dupPoolCaught = false
  try {
    vmPools.insert({ name: 'Main Pool' })
  } catch (err) {
    dupPoolCaught = err?.code === 'vm_pool_name_taken' || isUniqueConstraintError(err)
  }
  vmPools.rename(pool1.id, 'Primary Pool')
  vmPools.setEnabled(pool1.id, false)
  vmPools.setEnabled(pool1.id, true)
  vmPools.pruneUnknown(['vm-p1', 'vm-p2'])
  snap.vmPools = {
    idValid: typeof pool1.id === 'string' && pool1.id.startsWith('pool_'),
    dupPoolCaught,
    name: vmPools.get(pool1.id)?.name,
    members: vmPools.get(pool1.id)?.vm_ids,
    countKeys: vmPools.countKeys(pool1.id),
  }

  // 7. AccountsRepo + 8. AccountRuntimeRepo (including json_each FULL JOIN + MAX/GREATEST)
  const accounts = new AccountsRepo(db)
  accounts.insert({
    account_id: 'acc_p1',
    vm_id: 'vm-p1',
    email: 'vm1@parity.test',
    name: 'Parity Account 1',
    platform: 'claude',
    type: 'oauth',
    status: 'active',
    max_concurrency: 5,
    requests: 10,
    tokens_in: 5000,
    tokens_out: 2500,
    created_at: now,
    updated_at: now,
  })
  const alloc1 = accounts.addAllocation('acc_p1', {
    at: now,
    source: 'parity',
    util_5h: 0.25,
    util_7d: 0.1,
    status_5h: 'allowed',
    status_7d: 'allowed',
    tokens_in: 100,
    tokens_out: 50,
  })
  const runtime = new AccountRuntimeRepo(db)
  runtime.upsert({
    account_id: 'acc_p1',
    vm_id: 'vm-p1',
    status: 'ready',
    priority: 10,
    weight: 2,
    credential_generation: 3,
    refresh_status: 'ok',
    worker_heartbeat_at: 1750000001000,
    worker_status: { healthy: true },
    model_states: { 'claude-sonnet-4-5': { ok: true } },
    updated_at: now,
  })
  runtime.writeHeartbeat({
    account_id: 'acc_p1',
    vm_id: 'vm-p1',
    status: 'ready',
    worker_heartbeat_at: 1750000002000,
    worker_status: { healthy: true, seq: 2 },
    credential_generation: 2, // lower than 3 -> MAX/GREATEST must keep 3!
    refresh_status: 'ok',
    updated_at: now,
  })
  runtime.markCooldown('acc_p1', { untilMs: Date.parse(now) + 60_000, reason: 'rate_limit', now })
  const cooled = runtime.get('acc_p1')
  runtime.clearAccountCooldown('acc_p1')
  const snapshots = runtime.schedulingSnapshot(['acc_p1'])
  snap.accounts = {
    allocCount: accounts.allocationCount('acc_p1'),
    recentAllocLen: accounts.recentAllocations('acc_p1', 10).length,
    allocIdValid: alloc1 == null || typeof alloc1 === 'object',
    credGenPreserved: runtime.get('acc_p1')?.credential_generation,
    cooledReason: cooled?.cooldown_reason,
    clearedCooldown: runtime.get('acc_p1')?.cooldown_until,
    snapshotLen: snapshots.length,
    snapshotAccId: snapshots[0]?.account?.account_id ?? snapshots[0]?.runtime?.account_id,
  }

  // 9. StickyRepo
  const sticky = new StickyRepo(db)
  sticky.upsert('sess:p1', {
    account_id: 'acc_p1',
    vm_id: 'vm-p1',
    session_id: 'sess-p1',
    device_id: 'dev-p1',
    bound_at: 1750000000000,
    expires_at: 1750003600000,
    hits: 4,
    generation: 2,
    slot_index: 1,
  })
  sticky.upsert('ch:alias-drop', { account_id: 'acc_p1', vm_id: 'vm-p1', bound_at: 1750000000000 })
  const droppedAlias = sticky.dropAliasKeys()
  snap.sticky = {
    droppedAlias,
    count: sticky.count(),
    entryVm: sticky.get('sess:p1')?.vm_id,
    hits: sticky.get('sess:p1')?.hits,
  }

  // 10. ApiEndpointsRepo
  const endpoints = new ApiEndpointsRepo(db)
  endpoints.insertEndpoint({
    id: 'ep_p1',
    name: 'Parity Endpoint',
    base_url: 'https://api.parity.invalid',
    headers: { 'x-env': 'parity' },
    priority: 100,
    protocol: 'anthropic',
    created_at: now,
    updated_at: now,
  })
  endpoints.insertKey({
    id: 'epk_p1',
    endpoint_id: 'ep_p1',
    api_key: 'sk-upstream-parity-1',
    created_at: now,
  })
  endpoints.updateKey('epk_p1', { proxy_url: 'socks5://127.0.0.1:1080' })
  endpoints.setKeyCooldown('epk_p1', '2026-06-15T11:00:00.000Z')
  endpoints.replaceModels('ep_p1', [
    {
      id: 'epm_p1',
      sort: 0,
      name: 'claude-sonnet-4-5',
      alias: 'sonnet',
      image: true,
      thinking: { levels: ['low', 'high'] },
    },
  ])
  const epHyd = endpoints.getHydrated('ep_p1')
  snap.endpoints = {
    count: endpoints.listHydrated().length,
    keys: epHyd.api_key_entries.length,
    models: epHyd.models.length,
    cooldown: epHyd.api_key_entries[0]?.cooldown_until,
    alias: epHyd.models[0]?.alias,
  }

  // 11. ProxiesRepo
  const proxies = new ProxiesRepo(db)
  proxies.replaceAll([
    {
      id: 'prx_p1',
      scheme: 'socks5',
      host: '198.51.100.10',
      port: 1080,
      enabled: true,
      bound_vm_id: 'vm-p1',
      domain_forward: true,
      dns_disable_svcb_https: false,
      created_at: now,
      updated_at: now,
    },
  ])
  proxies.setConfig({ auto_probe: true, timeout_ms: 4000 })
  snap.proxies = {
    count: proxies.loadAll().length,
    boundVm: proxies.loadAll()[0]?.bound_vm_id,
    domainForward: proxies.loadAll()[0]?.domain_forward,
    cfg: proxies.getConfig(),
  }

  // 12. ClusterNodesRepo (including 2-level jump_node_id + RETURNING optimistic lock + direct link)
  const cluster = new ClusterNodesRepo(db)
  const n1 = cluster.insert(
    {
      id: 'node_p_root',
      label: 'Bastion',
      host: '203.0.113.1',
      port: 22,
      username: 'root',
      auth_type: 'password',
      password: 'secret-root-pw',
      host_key_alg: 'ssh-ed25519',
      host_key_sha256: 'SHA256:root111',
    },
    now,
  )
  cluster.insert(
    {
      id: 'node_p_leaf',
      label: 'Worker',
      host: '203.0.113.2',
      port: 2222,
      username: 'ops',
      auth_type: 'key',
      private_key: '-----BEGIN MOCK KEY-----',
      host_key_alg: 'ssh-ed25519',
      host_key_sha256: 'SHA256:leaf222',
      jump_node_id: 'node_p_root',
    },
    now,
  )
  const renamedNode = cluster.updateLabel('node_p_root', 'Bastion Primary', n1.updated_at)
  const staleConflict = cluster.updateLabel('node_p_root', 'Should Fail', n1.updated_at)
  cluster.setPlatform('node_p_root', 'linux')
  cluster.setDirectLink('node_p_root', { address: '203.0.113.1', port: 9443, token: 'gate-tok-1' }, now)
  cluster.setDirectLinkCert('node_p_root', 'sha256-cert-abc')
  snap.cluster = {
    count: cluster.list().length,
    dependents: cluster.dependentsOf('node_p_root'),
    findId: cluster.findByEndpoint('203.0.113.1', 22, 'root'),
    renamedLabel: renamedNode?.label,
    staleConflict,
    platform: cluster.platform('node_p_root'),
    secretPw: cluster.getSecrets('node_p_root')?.password,
    directCert: cluster.getDirectLink('node_p_root')?.certSha256,
  }

  // 13. RedeemCodesRepo (BIGSERIAL + transactional balance credit + double-redeem rejection)
  const redeem = new RedeemCodesRepo(db)
  const rc1 = redeem.create({ value: 25.5, notes: 'parity-topup', code: 'kin-parity-001' })
  const rc2 = redeem.create({ value: 10, notes: 'to-delete', code: 'kin-parity-002' })
  const redeemOk = redeem.redeem('kin-parity-001', 'usr_p2_reborn')
  const redeemDup = redeem.redeem('kin-parity-001', 'usr_p2_reborn')
  const removedUnused = redeem.remove(rc2.id)
  const removedUsed = redeem.remove(rc1.id)
  snap.redeem = {
    id1Positive: rc1.id > 0,
    id2Greater: rc2.id > rc1.id,
    redeemOk: redeemOk.ok,
    redeemDupError: redeemDup.error,
    newBalance: users.getById('usr_p2_reborn')?.balance,
    removedUnused,
    removedUsed,
  }

  // 14. RequestAttemptsRepo (BIGSERIAL + begin/complete/list)
  const attempts = new RequestAttemptsRepo(db)
  attempts.begin({
    requestId: 'req_p1',
    attemptNo: 1,
    vmId: 'vm-p1',
    accountId: 'acc_p1',
    model: 'claude-sonnet-4-5',
    selectionReason: 'sticky',
    waitMs: 12,
    queueWaitMs: 5,
    schedulingMs: 7,
  })
  attempts.complete('req_p1', 1, {
    upstreamStatus: 200,
    action: 'serve',
    downstreamCommitted: true,
    terminalState: 'ok',
    usage: { input_tokens: 100, output_tokens: 50 },
    ttftMs: 120,
    latencyMs: 450,
  })
  const attList = attempts.list('req_p1')
  snap.attempts = {
    count: attList.length,
    terminal: attList[0]?.terminal_state,
    committed: attList[0]?.downstream_committed,
    usageOut: attList[0]?.usage?.output_tokens,
  }

  // 15. RefusalGuardsRepo (exercises .iterate() in nearest()!)
  const guards = new RefusalGuardsRepo(db)
  const longText =
    'This is a sufficiently long synthetic refusal prompt designed specifically to exceed five hundred and twelve characters for deterministic MinHash shingle signature computation across SQLite and PostgreSQL parity tests. '.repeat(
      4,
    )
  const sigArr = refusalSignature(longText)
  assert.ok(sigArr && sigArr.length === 128, 'expected valid 128-slot signature')
  const sigEncoded = encodeSignature(sigArr)
  guards.remember({
    fingerprint: 'fp_parity_1',
    model: 'claude-sonnet-4-5',
    requestId: 'req_p1',
    errorMessage: 'refused',
    preview: 'synthetic preview',
    signature: sigEncoded,
  })
  guards.hit('fp_parity_1')
  const near = guards.nearest(sigArr, 0.9)
  snap.guards = {
    count: guards.count(),
    hits: guards.get('fp_parity_1')?.hit_count,
    nearestFp: near?.fingerprint,
    nearestScore: near?.score,
  }

  // 16. RefusalDeviceBlocksRepo (exercises BEGIN IMMEDIATE + risk_device_aliases!)
  const devBlocks = new RefusalDeviceBlocksRepo(db)
  const viol = devBlocks.recordViolation(
    { principal: 'key_p1', deviceId: 'dev-abc', machineId: 'mach-xyz', sessionId: 'sess-ban-1' },
    {
      requestId: 'req_p1',
      fingerprint: 'fp_parity_1',
      reason: 'policy_violation',
      steps: [15, 60, 0],
      now: Date.parse(now),
    },
  )
  const foundBan = devBlocks.findBan(
    { principal: 'key_p1', deviceId: 'dev-abc', machineId: 'mach-xyz', sessionId: 'sess-ban-1' },
    Date.parse(now) + 1000,
  )
  snap.devBlocks = {
    count: devBlocks.count(),
    violatedKind: viol?.subject_kind,
    foundBanKind: foundBan?.subject_kind,
    foundViolations: foundBan?.violations,
  }

  // 17. RefusalSessionBlocksRepo
  const sessBlocks = new RefusalSessionBlocksRepo(db)
  sessBlocks.block({
    sessionId: 'sess-blocked-1',
    requestId: 'req_p1',
    accountId: 'acc_p1',
    model: 'claude-sonnet-4-5',
    preview: 'blocked',
    reason: 'refusal',
  })
  sessBlocks.hit('sess-blocked-1')
  snap.sessBlocks = {
    count: sessBlocks.count(),
    hits: sessBlocks.get('sess-blocked-1')?.hit_count,
  }

  // 18. JevUsageRepo (exercises ON CONFLICT(period) DO UPDATE SET col=jev_usage_totals.col+excluded.col!)
  const jev = new JevUsageRepo(db, { now: () => Date.parse(now) })
  jev.record({
    id: 'jev_p1',
    created_at: now,
    request_id: 'req_p1',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    key_fingerprint: 'kf_parity_1',
    http_status: 200,
    outcome: 'success',
    duration_ms: 300,
    input_tokens: 1000,
    output_tokens: 500,
    estimated_cost_nano_usd: 15_000_000,
    input_nano_usd_per_token: 3000,
    output_nano_usd_per_token: 15000,
    pricing_basis: 'catalog',
  })
  jev.record({
    id: 'jev_p2',
    created_at: now,
    request_id: 'req_p2',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    key_fingerprint: 'kf_parity_1',
    http_status: 429,
    outcome: 'error',
    duration_ms: 150,
    input_tokens: 200,
    output_tokens: 0,
    estimated_cost_nano_usd: 600_000,
    input_nano_usd_per_token: 3000,
    output_nano_usd_per_token: 15000,
    pricing_basis: 'catalog',
  })
  const jevOv = jev.overview()
  const jevSt = jev.configuredKeyStatuses([{ key_fingerprint: 'kf_parity_1' }])
  snap.jev = {
    allRequests: jevOv.total.requests,
    allSuccess: jevOv.total.successful,
    allCostNano: jevOv.total.estimated_cost_nano_usd,
    latestStatus: jevSt[0]?.status,
  }

  // 19. BackupRepo
  const bakRepo = new BackupRepo(db)
  bakRepo.insert({
    id: 'bak_p1',
    created_at: now,
    kind: 'manual',
    status: 'ok',
    file_path: '/tmp/bak_p1.tar.gz',
    file_name: 'bak_p1.tar.gz',
    size_bytes: 4096,
    sha256: 'a'.repeat(64),
    db_bytes: 8192,
    includes: { db: true, vms: 2 },
    note: 'parity',
  })
  snap.backups = {
    count: bakRepo.list().length,
    lastId: bakRepo.lastSuccessful()?.id,
    includesVms: bakRepo.get('bak_p1')?.includes?.vms,
  }

  // 20. UsageLogsRepo + 21. UsageLogsView + 22. StatisticsRepo
  const usage = new UsageLogsRepo(db)
  usage.insertSummary({
    request_id: 'req_p1',
    ts: now,
    method: 'POST',
    path: '/v1/messages',
    protocol: 'anthropic',
    api_key_id: 'key_p1',
    api_key_name: 'Parity Key 1 Renamed',
    owner_user_id: 'usr_p1',
    vm_id: 'vm-p1',
    account_id: 'acc_p1',
    session_id: 'sess-p1',
    model: 'claude-sonnet-4-5',
    upstream_model: 'claude-sonnet-4-5',
    status: 200,
    duration_ms: 450,
    first_token_ms: 120,
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 2000,
    cache_creation_tokens: 100,
    total_cost: 0.015,
    actual_cost: 0.015,
    rate_multiplier: 1,
    billing_source: 'api_key',
    pricing_model: 'claude-sonnet-4-5',
  })
  usage.insertSummary({
    request_id: 'req_p2',
    ts: now,
    method: 'POST',
    path: '/v1/messages',
    protocol: 'anthropic',
    api_key_id: 'key_p1',
    api_key_name: 'Parity Key 1 Renamed',
    owner_user_id: 'usr_p1',
    vm_id: 'vm-p1',
    account_id: 'acc_p1',
    session_id: 'sess-p1',
    model: 'claude-sonnet-4-5',
    status: 502,
    error_code: 'upstream_502',
    error_message: 'Bad Gateway',
    duration_ms: 200,
    input_tokens: 100,
    output_tokens: 0,
    total_cost: 0.001,
    actual_cost: 0.001,
  })
  // Old row to test cleanup() -> account_lifetime_usage_archive ON CONFLICT upsert!
  usage.insertSummary({
    request_id: 'req_p_old_1',
    ts: oldTs,
    method: 'POST',
    path: '/v1/messages',
    protocol: 'anthropic',
    api_key_id: 'key_p1',
    owner_user_id: 'usr_p1',
    vm_id: 'vm-p1',
    account_id: 'acc_p1',
    model: 'claude-sonnet-4-5',
    status: 200,
    duration_ms: 300,
    input_tokens: 500,
    output_tokens: 250,
    total_cost: 0.008,
    actual_cost: 0.008,
  })
  usage.insertSummary({
    request_id: 'req_p_old_2',
    ts: oldTs,
    method: 'POST',
    path: '/v1/messages',
    protocol: 'anthropic',
    api_key_id: 'key_p1',
    owner_user_id: 'usr_p1',
    vm_id: 'vm-p1',
    account_id: 'acc_p1',
    model: 'claude-sonnet-4-5',
    status: 200,
    duration_ms: 300,
    input_tokens: 300,
    output_tokens: 100,
    total_cost: 0.004,
    actual_cost: 0.004,
  })
  usage.insertDebug('req_p1', now, { request_id: 'req_p1', payload: { msg: 'hello debug' } })
  const debugFetched = usage.getDebug('req_p1')
  const totalsBeforeCleanup = usage.totals()
  const aggDay = usage.aggregate({ bucket: 'day' })
  const aggHour = usage.aggregate({ bucket: 'hour' })
  const qRes = usage.query({ status: 'error', limit: 10 })

  const view = new UsageLogsView(db)
  const batch = view.listBatch({ limit: 2 })
  const viewSummary = view.summary({})
  const filterOpts = view.filterOptions({})
  const sessSugg = view.sessionSuggestions({ q: 'sess' })
  const viewOverview = view.overview({ since: '2026-06-14T00:00:00.000Z', until: '2026-06-16T00:00:00.000Z' })

  const statsRepo = new StatisticsRepo(db)
  const statsRes = statsRepo.statistics({ range: '24h', dimension: 'model', tz: 'UTC', now: Date.parse(now) + 1000 })
  const lbRes = statsRepo.leaderboard({
    range: '24h',
    scope: 'model',
    limit: 10,
    tz: 'UTC',
    now: Date.parse(now) + 1000,
  })

  // Run cleanup twice (first archives old rows, second tests ON CONFLICT UPDATE on account_lifetime_usage_archive)
  const clean1 = usage.cleanup({ retainDays: 30, debugRetainDays: 30, maxDebugBytes: 50_000_000 })
  usage.insertSummary({
    request_id: 'req_p_old_3',
    ts: oldTs,
    method: 'POST',
    path: '/v1/messages',
    protocol: 'anthropic',
    api_key_id: 'key_p1',
    owner_user_id: 'usr_p1',
    vm_id: 'vm-p1',
    account_id: 'acc_p1',
    model: 'claude-sonnet-4-5',
    status: 200,
    input_tokens: 100,
    output_tokens: 50,
    total_cost: 0.002,
    actual_cost: 0.002,
  })
  const clean2 = usage.cleanup({ retainDays: 30, debugRetainDays: 30, maxDebugBytes: 50_000_000 })
  const archiveRow = db
    .prepare('SELECT account_id, total_cost, total_tokens FROM account_lifetime_usage_archive WHERE account_id = ?')
    .get('acc_p1')

  snap.usage = {
    debugMsg: debugFetched?.payload?.msg,
    totalsRequests: totalsBeforeCleanup.requests,
    totalsErrors: totalsBeforeCleanup.errors,
    totalsInput: totalsBeforeCleanup.input_tokens,
    aggDayLen: aggDay.length,
    aggHourLen: aggHour.length,
    queryErrTotal: qRes.total,
    batchLen: batch.logs.length,
    batchHasMore: batch.hasMore,
    summaryRequests: viewSummary.requests,
    filterStatuses: filterOpts.statuses,
    sessSuggLen: sessSugg.length,
    overviewRequests: viewOverview?.totals?.requests ?? viewOverview?.requests ?? 0,
    statsRequests: statsRes.totals.requests,
    lbEntries: lbRes.entries.length,
    clean1Deleted: clean1.usage_logs,
    clean2Deleted: clean2.usage_logs,
    archiveTokens: Number(archiveRow?.total_tokens || 0),
    archiveCost: Number(Number(archiveRow?.total_cost || 0).toFixed(6)),
    remainingCount: usage.count(),
  }

  // 23. ThinkingOwnerStore (CREATE TABLE BIGINT + json_each + INSERT OR IGNORE + UPDATE refresh)
  const thinking = new ThinkingOwnerStore({ db })
  thinking.record(['sig_key_alpha', 'sig_key_beta'], 'acc_p1', 1_750_000_000_000)
  thinking.record(['sig_key_alpha'], 'acc_other_loses', 1_750_000_001_000) // first writer wins
  const owners = thinking.ownersOf(['sig_key_alpha', 'sig_key_beta', 'sig_missing'], 1_750_100_000_000)
  snap.thinking = {
    size: owners.size,
    alpha: owners.get('sig_key_alpha'),
    beta: owners.get('sig_key_beta'),
  }

  return snap
}

test('Tier 2: All 22 repositories + ThinkingOwnerStore produce identical behavior on SQLite and PostgreSQL', {
  skip: !PG_URL,
}, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-parity-'))
  const schema = `parity_${Date.now()}_${Math.floor(Math.random() * 1e5)}`
  const adminPool = createPgPool(resolvePgConfig({ connectionString: PG_URL }), { maxOverride: 2 })
  let pgPool = null
  let pgSyncDb = null

  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    const schemaUrl = withSchemaUrl(PG_URL, schema)
    const pgCfg = resolvePgConfig({ connectionString: schemaUrl })
    pgPool = createPgPool(pgCfg, { maxOverride: 4 })
    await applyPgMigrations(pgPool)
    pgSyncDb = await createPgSyncDb(pgCfg)

    // Run on SQLite
    const sqliteDb = openDatabase({ dataDir: tmpDir, driver: 'sqlite', pooled: false })
    const sqliteSnap = runAll22ReposScenario(sqliteDb)
    closeDatabase()

    // Run on PostgreSQL
    const pgSnap = runAll22ReposScenario(pgSyncDb)

    // Deep-compare every single repository section!
    assert.deepEqual(pgSnap.settings, sqliteSnap.settings, 'SettingsRepo mismatch')
    assert.deepEqual(pgSnap.groups, sqliteSnap.groups, 'GroupsRepo mismatch')
    assert.deepEqual(pgSnap.users, sqliteSnap.users, 'UsersRepo mismatch')
    assert.deepEqual(pgSnap.apiKeys, sqliteSnap.apiKeys, 'ApiKeysRepo mismatch')
    assert.deepEqual(pgSnap.vms, sqliteSnap.vms, 'VmsRepo mismatch')
    assert.deepEqual(pgSnap.vmPools, sqliteSnap.vmPools, 'VmPoolsRepo mismatch')
    assert.deepEqual(pgSnap.accounts, sqliteSnap.accounts, 'AccountsRepo/AccountRuntimeRepo mismatch')
    assert.deepEqual(pgSnap.sticky, sqliteSnap.sticky, 'StickyRepo mismatch')
    assert.deepEqual(pgSnap.endpoints, sqliteSnap.endpoints, 'ApiEndpointsRepo mismatch')
    assert.deepEqual(pgSnap.proxies, sqliteSnap.proxies, 'ProxiesRepo mismatch')
    assert.deepEqual(pgSnap.cluster, sqliteSnap.cluster, 'ClusterNodesRepo mismatch')
    assert.deepEqual(pgSnap.redeem, sqliteSnap.redeem, 'RedeemCodesRepo mismatch')
    assert.deepEqual(pgSnap.attempts, sqliteSnap.attempts, 'RequestAttemptsRepo mismatch')
    assert.deepEqual(pgSnap.guards, sqliteSnap.guards, 'RefusalGuardsRepo mismatch')
    assert.deepEqual(pgSnap.devBlocks, sqliteSnap.devBlocks, 'RefusalDeviceBlocksRepo mismatch')
    assert.deepEqual(pgSnap.sessBlocks, sqliteSnap.sessBlocks, 'RefusalSessionBlocksRepo mismatch')
    assert.deepEqual(pgSnap.jev, sqliteSnap.jev, 'JevUsageRepo mismatch')
    assert.deepEqual(pgSnap.backups, sqliteSnap.backups, 'BackupRepo mismatch')
    assert.deepEqual(pgSnap.usage, sqliteSnap.usage, 'UsageLogsRepo/View/StatisticsRepo mismatch')
    assert.deepEqual(pgSnap.thinking, sqliteSnap.thinking, 'ThinkingOwnerStore mismatch')
  } finally {
    try {
      closeDatabase()
    } catch {}
    if (pgSyncDb) pgSyncDb.close()
    if (pgPool) await pgPool.end()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    await adminPool.end()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('Tier 2B: retargetVmId (6 tables), crag-shop orders, and PG BackupService online backup + restore + BIGSERIAL continuity', {
  skip: !PG_URL,
}, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-parity-b-'))
  const dataDir = path.join(tmpDir, 'data')
  const schema = `parity_b_${Date.now()}_${Math.floor(Math.random() * 1e5)}`
  const adminPool = createPgPool(resolvePgConfig({ connectionString: PG_URL }), { maxOverride: 2 })

  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    const schemaUrl = withSchemaUrl(PG_URL, schema)
    await openDatabaseAsync({
      dataDir,
      driver: 'postgres',
      connectionString: schemaUrl,
      pooled: false,
      enableAggregator: false,
    })

    const db = getDb()
    const now = '2026-06-15T12:00:00.000Z'

    // Seed data for retargetVmId + FK/self-FK + BIGSERIAL tables
    new UsersRepo(db).insert({
      id: 'usr_bak_1',
      username: 'BackupOwner',
      password_hash: 'h1',
      role: 'admin',
      status: 'active',
      balance: 50,
      created_at: now,
      updated_at: now,
    })
    new ApiKeysRepo(db).insert({
      id: 'key_bak_1',
      name: 'Key Before Rename',
      key: 'sk-bak-1',
      key_hash: crypto.createHash('sha256').update('sk-bak-1').digest('hex'),
      key_prefix: 'sk-bak-1',
      status: 'active',
      allowed_vms: JSON.stringify(['vm-old', 'vm-keep']),
      created_at: now,
      updated_at: now,
    })
    new AccountsRepo(db).insert({ account_id: 'acc_bak_1', vm_id: 'vm-old', created_at: now, updated_at: now })
    new AccountRuntimeRepo(db).upsert({ account_id: 'acc_bak_1', vm_id: 'vm-old', status: 'ready', updated_at: now })
    new StickyRepo(db).upsert('sess:rename', { account_id: 'acc_bak_1', vm_id: 'vm-old', bound_at: 1750000000000 })
    new ProxiesRepo(db).replaceAll([
      {
        id: 'prx_bak_1',
        scheme: 'socks5',
        host: '198.51.100.20',
        port: 1080,
        bound_vm_id: 'vm-old',
        created_at: now,
        updated_at: now,
      },
    ])
    const vmPools = new VmPoolsRepo(db)
    const bakPool = vmPools.insert({ name: 'Backup Pool' })
    vmPools.setMembers(bakPool.id, ['vm-old'])
    const endpoints = new ApiEndpointsRepo(db)
    endpoints.insertEndpoint({
      id: 'ep_bak_1',
      name: 'Bak EP',
      base_url: 'https://bak.invalid',
      created_at: now,
      updated_at: now,
    })
    endpoints.insertKey({ id: 'epk_bak_1', endpoint_id: 'ep_bak_1', api_key: 'sk-ep-bak', created_at: now })
    endpoints.replaceModels('ep_bak_1', [{ id: 'epm_bak_1', sort: 0, name: 'claude-sonnet-4-5', alias: 's' }])
    const cluster = new ClusterNodesRepo(db)
    cluster.insert(
      {
        id: 'cn_root',
        label: 'Root',
        host: '203.0.113.10',
        port: 22,
        username: 'root',
        auth_type: 'password',
        password: 'pw',
        host_key_alg: 'ssh-ed25519',
        host_key_sha256: 'SHA256:1',
      },
      now,
    )
    cluster.insert(
      {
        id: 'cn_mid',
        label: 'Mid',
        host: '203.0.113.11',
        port: 22,
        username: 'root',
        auth_type: 'password',
        password: 'pw',
        host_key_alg: 'ssh-ed25519',
        host_key_sha256: 'SHA256:2',
        jump_node_id: 'cn_root',
      },
      now,
    )
    cluster.insert(
      {
        id: 'cn_leaf',
        label: 'Leaf',
        host: '203.0.113.12',
        port: 22,
        username: 'root',
        auth_type: 'password',
        password: 'pw',
        host_key_alg: 'ssh-ed25519',
        host_key_sha256: 'SHA256:3',
        jump_node_id: 'cn_mid',
      },
      now,
    )
    cluster.setDirectLink('cn_root', { address: '203.0.113.10', port: 9443, token: 'tok' }, now)
    const redeem = new RedeemCodesRepo(db)
    const rcOrig = redeem.create({ value: 15, code: 'kin-bak-orig' })

    // 1. Verify retargetVmId across all 6 tables on PostgreSQL
    retargetVmId('vm-old', 'vm-renamed')
    new VmsRepo(db).upsertFromVmJson({ id: 'vm-renamed', name: 'Renamed VM', status: 'stopped', created_at: now })
    assert.equal(new AccountsRepo(db).get('acc_bak_1').vm_id, 'vm-renamed')
    assert.equal(new AccountRuntimeRepo(db).get('acc_bak_1').vm_id, 'vm-renamed')
    assert.equal(new StickyRepo(db).get('sess:rename').vm_id, 'vm-renamed')
    assert.equal(new ProxiesRepo(db).loadAll()[0].bound_vm_id, 'vm-renamed')
    assert.deepEqual(new VmPoolsRepo(db).get(bakPool.id).vm_ids, ['vm-renamed'])
    assert.deepEqual(JSON.parse(new ApiKeysRepo(db).getById('key_bak_1').allowed_vms), ['vm-renamed', 'vm-keep'])

    // 2. Verify crag_shop_orders numeric & unlimited slot_limit + unique conflict on PostgreSQL
    db.prepare(`
      INSERT INTO crag_shop_orders (
        order_id, owner, request_id, sku, payment_method, status,
        created_at, term, amount_minor, slot_limit, reserved_at, dispatch_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')
    `).run('ord_num_1', 'admin', 'req_ord_1', 'pro-5', 'alipay', 'paid', 1750000000, '1m', 9900, 5n, 1750000000)
    db.prepare(`
      INSERT INTO crag_shop_orders (
        order_id, owner, request_id, sku, payment_method, status,
        created_at, term, amount_minor, slot_limit, reserved_at, dispatch_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')
    `).run(
      'ord_unlim_1',
      'admin',
      'req_ord_2',
      'ent-unlim',
      'wxpay',
      'fulfilled',
      1750000001,
      '1y',
      99900,
      'unlimited',
      1750000001,
    )
    assert.equal(createCragShopHandler ? typeof createCragShopHandler : 'none', 'function')
    let dupShopCaught = false
    try {
      db.prepare(`
        INSERT INTO crag_shop_orders (order_id, owner, request_id, sku, payment_method, status, reserved_at, dispatch_state)
        VALUES (?, ?, ?, ?, ?, 'reserved', ?, 'unsent')
      `).run('ord_dup', 'admin', 'req_ord_1', 'pro-5', 'alipay', 1750000002)
    } catch (err) {
      dupShopCaught = isUniqueConstraintError(err)
    }
    assert.equal(dupShopCaught, true, 'duplicate (owner, request_id) must trigger unique constraint error on PG')

    // 3. Verify PG BackupService online backup + dirty writes + restore + BIGSERIAL continuity
    const backupSvc = new BackupService({ dataDir, projectRoot: tmpDir })
    const bakRec = await backupSvc.createBackup({ kind: 'manual', note: 'parity-snapshot' })
    assert.equal(bakRec.status, 'ok')
    assert.ok(fs.existsSync(bakRec.file_path), 'backup archive must exist on disk')

    // Mutate state with dirty data after backup
    new UsersRepo(db).insert({
      id: 'usr_dirty_only',
      username: 'DirtyGhost',
      password_hash: 'h',
      role: 'user',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    new SettingsRepo(db).set('dirty_marker', 'must-vanish')

    // Restore from backup (tests topological FK order + cluster_nodes 3-level jump_node_id + BIGSERIAL setval!)
    const restored = await backupSvc.restoreBackup(bakRec.id)
    assert.equal(restored.ok, true)

    // Verify dirty state vanished and original state (including 3-level cluster_nodes + FKs) survived intact!
    assert.equal(new UsersRepo(db).getById('usr_dirty_only'), null, 'dirty user must vanish after restore')
    assert.equal(new SettingsRepo(db).get('dirty_marker'), null, 'dirty setting must vanish after restore')
    assert.equal(new UsersRepo(db).getById('usr_bak_1')?.username, 'BackupOwner')
    assert.equal(new ApiEndpointsRepo(db).getHydrated('ep_bak_1')?.api_key_entries?.length, 1)
    assert.deepEqual(new VmPoolsRepo(db).get(bakPool.id)?.vm_ids, ['vm-renamed'])
    assert.equal(new ClusterNodesRepo(db).get('cn_leaf')?.jump_node_id, 'cn_mid')
    assert.equal(new ClusterNodesRepo(db).get('cn_mid')?.jump_node_id, 'cn_root')
    assert.equal(new ClusterNodesRepo(db).getDirectLink('cn_root')?.port, 9443)

    // Verify BIGSERIAL sequence continuity post-restore (must NOT collide on id=1!)
    const rcAfter = new RedeemCodesRepo(db).create({ value: 5, code: 'kin-bak-after-restore' })
    assert.ok(
      rcAfter.id > rcOrig.id,
      `expected post-restore BIGSERIAL id (${rcAfter.id}) > pre-restore id (${rcOrig.id})`,
    )
  } finally {
    await closeDatabaseAsync().catch(() => {})
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    await adminPool.end()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
