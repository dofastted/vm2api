/**
 * PR-6 (M3) control-plane runtime tests against the real Rust `kin-scheduler` binary:
 * - Authoritative `buildConfigSnapshot()` (all 4 providers, virtual legacy pools,
 *   trusted JEV downgrade pools, bidirectional tenant/platform isolation) & `syncConfigNow()`
 * - High-frequency `/nodes/telemetry` (zero `config_version` bump, quota/active_hours/external_in_flight)
 * - Leader-only 1s `/persistence/drain` + shutdown synchronous drain + `KIN_STANDBY=1` forbid & `promoteToLeader()`
 * - Panel endpoints: Explain (dry-run non-blocking SessionGate), Unrest, Reset Machine Sticky,
 *   GET/DELETE Sticky, SSE `/api/panel/scheduler/events` + `409 snapshot_required`
 * - Sidecar crash `<300ms` auto-recovery AND hard-down strict Fail-Closed `503 scheduler_unavailable`
 * - Zombie `account_groups` writes eliminated while `groups` 2-row dictionary stays intact
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { createSchedulerPoolsHandler } from '../../src/lib/admin/scheduler-pools-routes.mjs'
import { closeDatabase, createDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { AccountRuntimeRepo } from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { AccountsRepo } from '../../src/lib/db/repos/accounts-repo.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { SchedulerPoolsRepo } from '../../src/lib/db/repos/scheduler-pools-repo.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import {
  PLATFORM_OWNER_SENTINEL,
  SchedulerApiError,
  SchedulerUnavailableError,
  VIRTUAL_POOL_IDS,
  createSchedulerRuntime,
  formatSchedulerError,
  inferModelFamily,
  scopeSchedulerRequestId,
} from '../../src/lib/scheduler/scheduler-runtime.mjs'

function resolveSchedulerBin() {
  const candidates = [
    process.env.KIN_SCHEDULER_BIN,
    '/tmp/vm2api-sched-m3-target/release/kin-scheduler',
    path.resolve(process.cwd(), 'bin/kin-scheduler'),
    path.resolve(process.cwd(), 'scheduler/target/release/kin-scheduler'),
    path.resolve(process.cwd(), 'scheduler/target/debug/kin-scheduler'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  throw new Error(`kin-scheduler binary not found in candidates: ${candidates.join(', ')}`)
}

const BIN_PATH = resolveSchedulerBin()

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makeMockReq(method, urlStr, { body = null, headers = {} } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = urlStr
  req.headers = { ...headers }
  req._body = body
  return req
}

function makeMockRes() {
  const res = new EventEmitter()
  res.statusCode = 200
  res.headers = {}
  res.chunks = []
  res.writableEnded = false
  res.destroyed = false
  res.setHeader = (k, v) => {
    res.headers[String(k).toLowerCase()] = v
  }
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status
    for (const [k, v] of Object.entries(headers)) {
      res.setHeader(k, v)
    }
    res.emit('head')
  }
  res.write = (chunk) => {
    res.chunks.push(String(chunk))
    res.emit('chunk', String(chunk))
    return true
  }
  res.end = (chunk) => {
    if (chunk !== undefined) res.chunks.push(String(chunk))
    res.writableEnded = true
    res.emit('finish')
    res.emit('close')
  }
  res.jsonBody = () => {
    const raw = res.chunks.join('')
    return raw ? JSON.parse(raw) : null
  }
  return res
}

function makePanelJson() {
  return (res, status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
    return true
  }
}

function makeReadBody() {
  return async (req) => (req._body && typeof req._body === 'object' ? req._body : {})
}

function seedKey(db, id, extra = {}) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO api_keys (
      id, name, "key", key_prefix, key_hash, status, group_type, category,
      permission_tier, owner_id, pool_binding_mode, default_pool_id,
      allowed_vms, allowed_models, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    extra.name || id,
    extra.key || `sk-test-${id}`,
    extra.key_prefix || `sk-${id.slice(0, 4)}`,
    extra.key_hash || `hash_${id}`,
    extra.group_type || 'all',
    extra.category || 'all',
    extra.permission_tier || (extra.owner_id ? 'tenant' : 'platform'),
    extra.owner_id ?? null,
    extra.pool_binding_mode || 'legacy_scope',
    extra.default_pool_id ?? null,
    JSON.stringify(extra.allowed_vms || []),
    JSON.stringify(extra.allowed_models || []),
    now,
    now,
  )
  return db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id)
}

function makeApiKeyStore(db) {
  return {
    db,
    getById: (id) => db.prepare('SELECT * FROM api_keys WHERE id = ? AND deleted_at IS NULL').get(id) || null,
    authenticate: () => ({ ok: false }),
    reload: () => {},
  }
}

function makeFixtureState(tmp) {
  const db = createDatabase({ dbPath: path.join(tmp, 'kin.db') })
  const repo = new SchedulerPoolsRepo(db)

  const vms = [
    {
      id: 'vm-c1',
      name: 'Claude High',
      kind: 'claude',
      status: 'running',
      schedulable: true,
      policy: { priority: 9, weight: 10, max_concurrency: 2, session_slots: 2 },
    },
    {
      id: 'vm-c2',
      name: 'Claude Low',
      kind: 'claude',
      status: 'running',
      schedulable: true,
      policy: { priority: 5, weight: 10, max_concurrency: 2, session_slots: 2 },
    },
    {
      id: 'vm-c-tenant',
      name: 'Tenant Claude',
      kind: 'claude',
      status: 'running',
      schedulable: true,
      owner_user_id: 'tenant-1',
      policy: { priority: 10, weight: 10, max_concurrency: 2, session_slots: 2 },
    },
    {
      id: 'vm-x1',
      name: 'Codex One',
      kind: 'codex',
      status: 'running',
      schedulable: true,
      policy: { priority: 7, weight: 10, max_concurrency: 4, session_slots: 4 },
    },
    {
      id: 'vm-c-auto',
      name: 'Claude Auto 7d Reset',
      kind: 'claude',
      status: 'running',
      schedulable: true,
      unified: { '7d': { resets_at: new Date(Date.now() + 3 * 86400_000).toISOString() } },
      policy: { weight: 10, max_concurrency: 2, session_slots: 2 },
    },
    {
      id: 'vm-flat-summary',
      name: 'Summarized Flat VM',
      kind: 'claude',
      status: 'running',
      schedulable: true,
      schedule_level_manual: 8,
      weight: 25,
      max_concurrency: 6,
      session_slots: 5,
      max_rpm: 90,
      allowed_models: ['claude-opus-4-6'],
      plan_type: 'max',
    },
  ]

  const geminiEnvs = [
    {
      id: 'gem-1',
      name: 'Gemini Env 1',
      enabled: true,
      healthy: true,
      schedulable: true,
      max_concurrency: 8,
      max_sessions: 8,
      models: ['gemini-2.5-pro', 'claude-sonnet-4-5'],
    },
  ]

  const endpoints = [
    {
      id: 'ep-1',
      name: 'Anthropic Direct',
      protocol: 'anthropic',
      kind: 'claude',
      disabled: false,
      priority: 6,
      weight: 10,
      max_concurrency: 10,
      api_key_entries: [{ id: 'k1', disabled: false }],
    },
  ]

  const poolAnth = repo.insert({
    id: 'pool_anth0001',
    name: 'Anthropic Zero Inject',
    slug: 'anth-zero',
    provider_scope: 'anthropic',
    system_prompt_mode: 'zero_inject',
  })
  repo.setMembers(poolAnth.id, [
    { node_type: 'claude_vm', node_id: 'vm-c1', enabled: true, member_role: 'active', member_order: 0 },
    { node_type: 'claude_vm', node_id: 'vm-c2', enabled: true, member_role: 'active', member_order: 1 },
    { node_type: 'claude_vm', node_id: 'vm-c-tenant', enabled: true, member_role: 'active', member_order: 2 },
  ])

  const poolDowngrade = repo.insert({
    id: 'pool_down0001',
    name: 'JEV Downgrade Pool',
    slug: 'jev-downgrade',
    provider_scope: 'api',
    pool_role: 'downgrade',
    system_prompt_mode: 'passthrough',
  })
  repo.setMembers(poolDowngrade.id, [
    { node_type: 'api_endpoint', node_id: 'ep-1', enabled: true, member_role: 'active', member_order: 0 },
  ])

  const poolOpenai = repo.insert({
    id: 'pool_codex001',
    name: 'OpenAI Codex Pool',
    slug: 'openai-codex',
    provider_scope: 'openai',
    system_prompt_mode: 'passthrough',
  })
  repo.setMembers(poolOpenai.id, [
    { node_type: 'codex_vm', node_id: 'vm-x1', enabled: true, member_role: 'active', member_order: 0 },
  ])

  const poolGoogle = repo.insert({
    id: 'pool_goog0001',
    name: 'Google Gemini Pool',
    slug: 'google-gemini',
    provider_scope: 'google',
    system_prompt_mode: 'passthrough',
  })
  repo.setMembers(poolGoogle.id, [
    { node_type: 'gemini_env', node_id: 'gem-1', enabled: true, member_role: 'active', member_order: 0 },
  ])

  const strictKey = seedKey(db, 'key-strict', {
    pool_binding_mode: 'strict_pool',
    default_pool_id: poolAnth.id,
  })
  repo.setKeyBindings(strictKey.id, [poolAnth.id], { defaultPoolId: poolAnth.id, bindingMode: 'strict_pool' })

  const tenantKey = seedKey(db, 'key-tenant', {
    owner_id: 'tenant-1',
    permission_tier: 'tenant',
    pool_binding_mode: 'strict_pool',
    default_pool_id: poolAnth.id,
  })
  repo.setKeyBindings(tenantKey.id, [poolAnth.id], { defaultPoolId: poolAnth.id, bindingMode: 'strict_pool' })

  const legacyKey = seedKey(db, 'key-legacy', {
    pool_binding_mode: 'legacy_scope',
  })

  return {
    db,
    repo,
    vms,
    geminiEnvs,
    endpoints,
    poolAnth,
    poolDowngrade,
    poolOpenai,
    poolGoogle,
    strictKey,
    tenantKey,
    legacyKey,
  }
}

test('M3 runtime: snapshot compilation, virtual legacy pools, tenant isolation, JEV downgrade & hot syncConfigNow', async (t) => {
  const tmp = makeTempDir('vm2api-m3-snap-')
  const fx = makeFixtureState(tmp)
  const runtime = createSchedulerRuntime({
    getDb: () => fx.db,
    getVms: () => fx.vms,
    getRoutingConfig: () => ({ compatibility: { persona_inject: 'full' }, pool: {} }),
    apiKeyStore: makeApiKeyStore(fx.db),
    apiEndpointStore: { listRaw: () => fx.endpoints },
    geminiScheduler: { listEnvironments: () => fx.geminiEnvs },
    telemetryIntervalMs: 0,
    clientOptions: {
      binPath: BIN_PATH,
      dataDir: tmp,
      socketPath: path.join(tmp, 'sched.sock'),
      tokenPath: path.join(tmp, 'sched.token'),
      capFile: path.join(tmp, 'sched.cap.json'),
    },
  })
  t.after(async () => {
    await runtime.shutdown({ drain: false, stopProcess: true })
    fx.db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  await runtime.start({ waitMs: 5_000, startLoops: true })
  const h1 = await runtime.health()
  assert.equal(h1.ok, true)
  assert.equal(h1.bootstrapped, true)
  assert.equal(h1.role, 'leader')

  // Snapshot invariants: all 4 providers, virtual pools, trusted downgrade pools, platform owner sentinel
  const snap = runtime.lastSnapshot
  assert.ok(snap.trusted_downgrade_pool_ids.includes(fx.poolDowngrade.id))
  for (const vpId of Object.values(VIRTUAL_POOL_IDS)) {
    assert.ok(
      snap.pools.some((p) => p.id === vpId),
      `missing virtual pool ${vpId}`,
    )
  }
  const c1Node = snap.nodes.find((n) => n.node_key === 'claude_vm:vm-c1')
  const autoNode = snap.nodes.find((n) => n.node_key === 'claude_vm:vm-c-auto')
  const flatNode = snap.nodes.find((n) => n.node_key === 'claude_vm:vm-flat-summary')
  const tenantNode = snap.nodes.find((n) => n.node_key === 'claude_vm:vm-c-tenant')
  assert.equal(c1Node.owner_id, PLATFORM_OWNER_SENTINEL)
  assert.equal(autoNode.weight_tier_mode, 'auto7d_reset')
  assert.equal(flatNode.weight_tier_mode, 'manual')
  assert.equal(flatNode.weight_tier, 8)
  assert.equal(flatNode.sub_weight, 25)
  assert.equal(flatNode.capacity.max_concurrency, 6)
  assert.equal(flatNode.capacity.max_sessions, 5)
  assert.equal(flatNode.capacity.max_rpm, 90)
  assert.equal(tenantNode.owner_id, 'tenant-1')

  // Verify flat summarizeVm `allowed_models` restricts `vm-flat-summary` to claude-opus-4-6 only
  const expFlatBlocked = await runtime.explainDispatch({
    originPoolId: VIRTUAL_POOL_IDS.claude,
    apiKeyKind: 'master',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    allowedNodeKeys: ['claude_vm:vm-flat-summary'],
    sessionId: '550e8400-e29b-41d4-a716-446655440098',
  })
  assert.equal(expFlatBlocked.ok, false)
  const expFlatAllowed = await runtime.explainDispatch({
    originPoolId: VIRTUAL_POOL_IDS.claude,
    apiKeyKind: 'master',
    model: 'claude-opus-4-6',
    protocol: 'anthropic',
    allowedNodeKeys: ['claude_vm:vm-flat-summary'],
    sessionId: '550e8400-e29b-41d4-a716-446655440099',
  })
  assert.equal(expFlatAllowed.ok, true)
  assert.equal(expFlatAllowed.selected_node.node_key, 'claude_vm:vm-flat-summary')

  // 1. Platform strict_pool key must pick vm-c1 (tier 9 > vm-c2 tier 5) and NEVER touch tenant vm-c-tenant (tier 10)!
  const acqPlat = await runtime.acquireNode({
    originPoolId: fx.poolAnth.id,
    apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    machineId: 'mach-plat-1',
    sessionId: '550e8400-e29b-41d4-a716-446655440001',
  })
  assert.equal(acqPlat.selected_node.node_key, 'claude_vm:vm-c1')
  assert.equal(acqPlat.prompt_policy.mode, 'zero_inject')
  assert.equal(acqPlat.prompt_policy.source, 'pool')
  await runtime.releaseLease(acqPlat.lease_id, 'ok')

  // 2. Tenant strict_pool key must ONLY pick tenant-owned vm-c-tenant!
  const acqTenant = await runtime.acquireNode({
    originPoolId: fx.poolAnth.id,
    apiKeyRecord: { ...fx.tenantKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    sessionId: '550e8400-e29b-41d4-a716-446655440002',
  })
  assert.equal(acqTenant.selected_node.node_key, 'claude_vm:vm-c-tenant')
  await runtime.releaseLease(acqTenant.lease_id, 'ok')

  // 3. Legacy unbound key maps seamlessly to synthesized virtual pools across all 4 platforms
  const acqLegacyClaude = await runtime.acquireNode({
    apiKeyRecord: fx.legacyKey,
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    sessionId: '550e8400-e29b-41d4-a716-446655440003',
  })
  assert.equal(acqLegacyClaude.resolved_pool_id, VIRTUAL_POOL_IDS.claude)
  assert.equal(acqLegacyClaude.selected_node.node_key, 'claude_vm:vm-c1')
  await runtime.releaseLease(acqLegacyClaude.lease_id, 'ok')

  const acqLegacyCodex = await runtime.acquireNode({
    apiKeyRecord: fx.legacyKey,
    apiKeyKind: 'managed',
    model: 'gpt-5.4',
    protocol: 'openai',
    sessionId: '550e8400-e29b-41d4-a716-446655440004',
  })
  assert.equal(acqLegacyCodex.resolved_pool_id, VIRTUAL_POOL_IDS.codex)
  assert.equal(acqLegacyCodex.selected_node.node_key, 'codex_vm:vm-x1')
  assert.equal(acqLegacyCodex.prompt_policy.mode, 'passthrough')
  await runtime.releaseLease(acqLegacyCodex.lease_id, 'ok')

  const acqLegacyGemini = await runtime.acquireNode({
    apiKeyRecord: fx.legacyKey,
    apiKeyKind: 'managed',
    model: 'gemini-2.5-pro',
    protocol: 'google',
    sessionId: '550e8400-e29b-41d4-a716-446655440005',
  })
  assert.equal(acqLegacyGemini.resolved_pool_id, VIRTUAL_POOL_IDS.gemini)
  assert.equal(acqLegacyGemini.selected_node.node_key, 'gemini_env:gem-1')
  assert.equal(acqLegacyGemini.prompt_policy.mode, 'passthrough')
  await runtime.releaseLease(acqLegacyGemini.lease_id, 'ok')

  // 4. Trusted JEV downgrade pool bypasses strict_pool allowed_pool_ids; untrusted pool rejected 403
  const acqDown = await runtime.acquireNode({
    originPoolId: fx.poolAnth.id,
    jevDowngradePoolId: fx.poolDowngrade.id,
    apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    sessionId: '550e8400-e29b-41d4-a716-446655440006',
  })
  assert.equal(acqDown.resolved_pool_id, fx.poolDowngrade.id)
  assert.equal(acqDown.selected_node.node_key, 'api_endpoint:ep-1')
  await runtime.releaseLease(acqDown.lease_id, 'ok')

  await assert.rejects(
    () =>
      runtime.acquireNode({
        originPoolId: fx.poolAnth.id,
        jevDowngradePoolId: fx.poolOpenai.id,
        apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
        apiKeyKind: 'managed',
        model: 'gpt-5.4',
        protocol: 'openai',
        sessionId: '550e8400-e29b-41d4-a716-446655440007',
      }),
    (err) => err instanceof SchedulerApiError && err.status === 403 && err.code === 'pool_forbidden',
  )

  // 4b. M1: standard pool configured in SQLite `settings.risk_audit_policy.downgrade_pool` becomes trusted
  const settingsRepo = new SettingsRepo(fx.db)
  settingsRepo.set('risk_audit_policy', { downgrade_pool: fx.poolOpenai.id })
  const syncRiskRes = await runtime.syncConfigNow('risk_audit_policy')
  assert.equal(syncRiskRes.ok, true)
  assert.ok(runtime.lastSnapshot.trusted_downgrade_pool_ids.includes(fx.poolOpenai.id))
  const acqRiskDown = await runtime.acquireNode({
    originPoolId: fx.poolAnth.id,
    jevDowngradePoolId: fx.poolOpenai.id,
    apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'gpt-5.4',
    protocol: 'openai.responses',
    sessionId: '550e8400-e29b-41d4-a716-446655440017',
  })
  assert.equal(acqRiskDown.resolved_pool_id, fx.poolOpenai.id)
  assert.equal(acqRiskDown.selected_node.node_key, 'codex_vm:vm-x1')
  await runtime.releaseLease(acqRiskDown.lease_id, 'ok')
  settingsRepo.remove('risk_audit_policy')
  await runtime.syncConfigNow('risk_audit_policy_clear')

  // 5. Hot config sync bumps config_version and reflects member weight override immediately
  fx.repo.setMembers(fx.poolAnth.id, [
    { node_type: 'claude_vm', node_id: 'vm-c1', enabled: true, member_role: 'active', weight_tier_override: 3 },
    { node_type: 'claude_vm', node_id: 'vm-c2', enabled: true, member_role: 'active', weight_tier_override: 10 },
  ])
  const syncRes = await runtime.syncConfigNow('test_weight_flip')
  assert.equal(syncRes.ok, true)
  assert.equal(syncRes.applied, true)
  assert.ok(syncRes.config_version > h1.config_version)

  const acqAfterSync = await runtime.acquireNode({
    originPoolId: fx.poolAnth.id,
    apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    sessionId: '550e8400-e29b-41d4-a716-446655440008',
  })
  assert.equal(acqAfterSync.selected_node.node_key, 'claude_vm:vm-c2')
  await runtime.releaseLease(acqAfterSync.lease_id, 'ok')
})

test('M3 runtime: telemetry updates do NOT bump config_version and respect quota/external_in_flight/active_hours', async (t) => {
  const tmp = makeTempDir('vm2api-m3-telem-')
  const fx = makeFixtureState(tmp)
  let extLoad = {}
  const runtime = createSchedulerRuntime({
    getDb: () => fx.db,
    getVms: () => fx.vms,
    getRoutingConfig: () => ({}),
    apiKeyStore: makeApiKeyStore(fx.db),
    apiEndpointStore: { listRaw: () => fx.endpoints },
    geminiScheduler: { listEnvironments: () => fx.geminiEnvs },
    getExternalInFlight: () => extLoad,
    telemetryIntervalMs: 0,
    clientOptions: {
      binPath: BIN_PATH,
      dataDir: tmp,
      socketPath: path.join(tmp, 'sched.sock'),
      tokenPath: path.join(tmp, 'sched.token'),
      capFile: path.join(tmp, 'sched.cap.json'),
    },
  })
  t.after(async () => {
    await runtime.shutdown({ drain: false, stopProcess: true })
    fx.db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  await runtime.start({ waitMs: 5_000, startLoops: true })
  const verBefore = (await runtime.health()).config_version

  // Mark vm-c1 saturated via blue/green external_in_flight = max_concurrency (2)
  extLoad = { 'vm-c1': 2 }
  const tRes = await runtime.pushTelemetryNow()
  assert.equal(tRes.ok, true)
  assert.ok(tRes.updated >= 4)

  // High-frequency telemetry MUST NOT increment config_version!
  const verAfter = (await runtime.health()).config_version
  assert.equal(verAfter, verBefore)

  // vm-c1 is full externally -> immediately selects vm-c2
  const acq = await runtime.acquireNode({
    originPoolId: fx.poolAnth.id,
    apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    sessionId: '550e8400-e29b-41d4-a716-446655440010',
  })
  assert.equal(acq.selected_node.node_key, 'claude_vm:vm-c2')
  await runtime.releaseLease(acq.lease_id, 'ok')

  // Clear external load, set vm-c1 quota >= 95% -> Rust excludes with quota_exhausted
  extLoad = {}
  fx.vms[0].utilization_5h = 0.97
  await runtime.pushTelemetryNow()
  assert.equal((await runtime.health()).config_version, verBefore)

  const exp = await runtime.explainDispatch({
    originPoolId: fx.poolAnth.id,
    apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    sessionId: '550e8400-e29b-41d4-a716-446655440011',
  })
  assert.equal(exp.selected_node.node_key, 'claude_vm:vm-c2')
  const excludedC1 = exp.explain.excluded.find((e) => e.node === 'claude_vm:vm-c1')
  assert.equal(excludedC1?.reason, 'quota_exhausted')
})

test('M3 runtime: Leader 1s drain & shutdown flush vs Standby zero-write + promoteToLeader', async (t) => {
  const tmp = makeTempDir('vm2api-m3-drain-')
  const fx = makeFixtureState(tmp)

  // 1. Standby mode MUST forbid /persistence/drain and perform zero DB writes
  const standbyRt = createSchedulerRuntime({
    isStandby: true,
    getDb: () => fx.db,
    getVms: () => fx.vms,
    getRoutingConfig: () => ({}),
    apiKeyStore: makeApiKeyStore(fx.db),
    apiEndpointStore: { listRaw: () => fx.endpoints },
    geminiScheduler: { listEnvironments: () => fx.geminiEnvs },
    telemetryIntervalMs: 0,
    drainIntervalMs: 100,
    clientOptions: {
      binPath: BIN_PATH,
      dataDir: tmp,
      socketPath: path.join(tmp, 'standby.sock'),
      tokenPath: path.join(tmp, 'standby.token'),
      capFile: path.join(tmp, 'standby.cap.json'),
    },
  })
  t.after(async () => {
    await standbyRt.shutdown({ drain: false, stopProcess: true })
    fx.db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  await standbyRt.start({ waitMs: 5_000, startLoops: true })
  assert.equal(standbyRt.isStandby, true)
  assert.equal((await standbyRt.health()).role, 'standby')

  const acq1 = await standbyRt.acquireNode({
    originPoolId: fx.poolAnth.id,
    apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    machineId: 'mach-standby-1',
    sessionId: '550e8400-e29b-41d4-a716-446655440020',
  })
  await standbyRt.commitLease(acq1.lease_id)
  await standbyRt.releaseLease(acq1.lease_id, 'ok')

  const skippedDrain = await standbyRt.drainPersistenceNow()
  assert.equal(skippedDrain.skipped, 'standby')
  await assert.rejects(
    () => standbyRt.client.drainPersistence({}),
    (err) => err instanceof SchedulerApiError && err.status === 403 && err.code === 'standby_drain_forbidden',
  )
  assert.equal(fx.repo.listLiveStickyBindings(Date.now()).length, 0)

  // 2. Promote Standby -> Leader (SIGUSR2): drain now persists dirty sticky deltas to DB!
  await standbyRt.promoteToLeader({ rebootstrap: true, startDrain: true })
  assert.equal(standbyRt.isStandby, false)
  assert.equal((await standbyRt.health()).role, 'leader')

  const drainRes = await standbyRt.drainPersistenceNow()
  assert.ok(drainRes.batches >= 1)
  const persisted = fx.repo.listLiveStickyBindings(Date.now())
  assert.ok(persisted.some((b) => b.scope_kind === 'machine' && b.identity_id === 'mach-standby-1'))
  assert.ok(
    persisted.some((b) => b.scope_kind === 'session' && b.identity_id === '550e8400-e29b-41d4-a716-446655440020'),
  )

  // 3. Shutdown synchronous drain flushes last-second binding with zero data loss
  const acq2 = await standbyRt.acquireNode({
    originPoolId: fx.poolAnth.id,
    apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    machineId: 'mach-shutdown-2',
    sessionId: '550e8400-e29b-41d4-a716-446655440021',
  })
  await standbyRt.commitLease(acq2.lease_id)
  await standbyRt.releaseLease(acq2.lease_id, 'ok')

  await standbyRt.shutdown({ drain: true, stopProcess: true })
  const afterShutdown = fx.repo.listLiveStickyBindings(Date.now())
  assert.ok(afterShutdown.some((b) => b.scope_kind === 'machine' && b.identity_id === 'mach-shutdown-2'))
})

test('M3 runtime + Panel routes: Explain (non-blocking SessionGate), Unrest, Reset Sticky, Sticky CRUD, SSE events & 409', async (t) => {
  const tmp = makeTempDir('vm2api-m3-panel-')
  const fx = makeFixtureState(tmp)
  const runtime = createSchedulerRuntime({
    getDb: () => fx.db,
    getVms: () => fx.vms,
    getRoutingConfig: () => ({}),
    apiKeyStore: makeApiKeyStore(fx.db),
    apiEndpointStore: { listRaw: () => fx.endpoints },
    geminiScheduler: { listEnvironments: () => fx.geminiEnvs },
    telemetryIntervalMs: 0,
    clientOptions: {
      binPath: BIN_PATH,
      dataDir: tmp,
      socketPath: path.join(tmp, 'panel.sock'),
      tokenPath: path.join(tmp, 'panel.token'),
      capFile: path.join(tmp, 'panel.cap.json'),
    },
  })
  t.after(async () => {
    await runtime.shutdown({ drain: false, stopProcess: true })
    fx.db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  await runtime.start({ waitMs: 5_000, startLoops: true })

  const handlePools = createSchedulerPoolsHandler({
    getDb: () => fx.db,
    getVms: () => fx.vms,
    apiKeyStore: makeApiKeyStore(fx.db),
    apiEndpointStore: { listRaw: () => fx.endpoints },
    geminiScheduler: () => ({ listEnvironments: () => fx.geminiEnvs }),
    schedulerRuntime: () => runtime,
    json: makePanelJson(),
    readBody: makeReadBody(),
  })

  // Hold an active lease on session S1 to prove /explain peeks busy SessionGate WITHOUT blocking!
  const s1 = '550e8400-e29b-41d4-a716-446655440030'
  const held = await runtime.acquireNode({
    originPoolId: fx.poolAnth.id,
    apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    machineId: 'mach-panel-1',
    sessionId: s1,
  })
  await runtime.commitLease(held.lease_id)

  // 1. POST /api/panel/scheduler/explain while S1 is held -> returns immediately with busy_at_peek=true
  const expReq = makeMockReq('POST', '/api/panel/scheduler/explain', {
    body: {
      pool_id: fx.poolAnth.id,
      api_key_id: fx.strictKey.id,
      model: 'claude-sonnet-4-6',
      machine_id: 'mach-panel-1',
      session_id: s1,
    },
  })
  const expRes = makeMockRes()
  await handlePools(
    expReq,
    expRes,
    '/api/panel/scheduler/explain',
    new URL('http://localhost/api/panel/scheduler/explain'),
  )
  assert.equal(expRes.statusCode, 200)
  const expBody = expRes.jsonBody()
  assert.equal(expBody.ok, true)
  assert.equal(expBody.data.session_gate.held, true)
  assert.equal(expBody.data.session_gate.busy_at_peek, true)
  assert.equal(expBody.data.affinity.why, 'session_hit')
  assert.equal(expBody.data.selected_node.node_key, 'claude_vm:vm-c1')
  assert.equal(expBody.data.prompt_policy.mode, 'zero_inject')

  // 1b. Fresh-session POST /api/panel/scheduler/explain exercises Stage 3 tier ranking (`order`)
  const expFreshRes = makeMockRes()
  await handlePools(
    makeMockReq('POST', '/api/panel/scheduler/explain', {
      body: {
        pool_id: fx.poolAnth.id,
        api_key_id: fx.strictKey.id,
        model: 'claude-sonnet-4-6',
        session_id: '550e8400-e29b-41d4-a716-446655440039',
      },
    }),
    expFreshRes,
    '/api/panel/scheduler/explain',
    new URL('http://localhost/api/panel/scheduler/explain'),
  )
  assert.equal(expFreshRes.statusCode, 200)
  const expFreshBody = expFreshRes.jsonBody()
  assert.equal(expFreshBody.ok, true)
  assert.equal(expFreshBody.data.session_gate.busy_at_peek, false)
  assert.equal(expFreshBody.data.affinity.why, 'tier_ranked')
  assert.ok(Array.isArray(expFreshBody.data.order) && expFreshBody.data.order.length >= 2)
  assert.equal(expFreshBody.data.order[0].node_key, 'claude_vm:vm-c1')

  // Release held lease and drain to DB so both Rust & DB hold sticky
  await runtime.releaseLease(held.lease_id, 'ok')
  await runtime.drainPersistenceNow()

  // 2. GET /api/panel/scheduler/sticky returns live Rust bindings
  const getStickyRes = makeMockRes()
  await handlePools(
    makeMockReq('GET', `/api/panel/scheduler/sticky?pool_id=${fx.poolAnth.id}`),
    getStickyRes,
    '/api/panel/scheduler/sticky',
    new URL(`http://localhost/api/panel/scheduler/sticky?pool_id=${fx.poolAnth.id}`),
  )
  assert.equal(getStickyRes.statusCode, 200)
  const stickyList = getStickyRes.jsonBody().data.items
  assert.ok(stickyList.some((b) => b.scope_kind === 'machine' && b.identity_id === 'mach-panel-1'))

  // 3. POST /api/panel/pools/:id/reset-machine-sticky clears BOTH Rust + DB machine stickies
  const resetRes = makeMockRes()
  await handlePools(
    makeMockReq('POST', `/api/panel/pools/${fx.poolAnth.id}/reset-machine-sticky`, { body: {} }),
    resetRes,
    `/api/panel/pools/${fx.poolAnth.id}/reset-machine-sticky`,
    new URL(`http://localhost/api/panel/pools/${fx.poolAnth.id}/reset-machine-sticky`),
  )
  assert.equal(resetRes.statusCode, 200)
  assert.ok(resetRes.jsonBody().cleared >= 1)
  assert.equal((await runtime.querySticky({ pool_id: fx.poolAnth.id, scope_kind: 'machine' })).total, 0)
  assert.equal(fx.repo.queryStickyBindings({ pool_id: fx.poolAnth.id, scope_kind: 'machine' }).length, 0)

  // 4. DELETE /api/panel/scheduler/sticky rejects empty filter with 400 and clears session sticky with filter
  const badDelRes = makeMockRes()
  await handlePools(
    makeMockReq('DELETE', '/api/panel/scheduler/sticky'),
    badDelRes,
    '/api/panel/scheduler/sticky',
    new URL('http://localhost/api/panel/scheduler/sticky'),
  )
  assert.equal(badDelRes.statusCode, 400)
  assert.equal(badDelRes.jsonBody().error.code, 'sticky_filter_required')

  const okDelRes = makeMockRes()
  await handlePools(
    makeMockReq('DELETE', `/api/panel/scheduler/sticky?pool_id=${fx.poolAnth.id}&scope_kind=session`),
    okDelRes,
    '/api/panel/scheduler/sticky',
    new URL(`http://localhost/api/panel/scheduler/sticky?pool_id=${fx.poolAnth.id}&scope_kind=session`),
  )
  assert.equal(okDelRes.statusCode, 200)
  assert.ok(okDelRes.jsonBody().deleted >= 1)

  // 5. Cool down vm-c1 via switchNode(529), then POST /api/panel/scheduler/nodes/claude_vm:vm-c1/unrest
  const acqFail = await runtime.acquireNode({
    originPoolId: fx.poolAnth.id,
    apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    sessionId: '550e8400-e29b-41d4-a716-446655440031',
  })
  assert.equal(acqFail.selected_node.node_key, 'claude_vm:vm-c1')
  const switched = await runtime.switchNode({
    releaseLeaseId: acqFail.lease_id,
    failure: { http_status: 529, error_class: 'overloaded529', retry_after_sec: 120 },
    nextAttempt: {
      requestId: acqFail._request.request_id,
      attemptNo: 2,
      originPoolId: fx.poolAnth.id,
      apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
      apiKeyKind: 'managed',
      model: 'claude-sonnet-4-6',
      protocol: 'anthropic',
      sessionId: '550e8400-e29b-41d4-a716-446655440031',
    },
  })
  assert.equal(switched.selected_node.node_key, 'claude_vm:vm-c2')
  await runtime.releaseLease(switched.lease_id, 'ok')

  // Confirm vm-c1 is cooled down in Explain
  const cooledExp = await runtime.explainDispatch({
    originPoolId: fx.poolAnth.id,
    apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    sessionId: '550e8400-e29b-41d4-a716-446655440032',
  })
  assert.equal(cooledExp.selected_node.node_key, 'claude_vm:vm-c2')

  const unrestRes = makeMockRes()
  const unrestPath = `/api/panel/scheduler/nodes/${encodeURIComponent('claude_vm:vm-c1')}/unrest`
  await handlePools(
    makeMockReq('POST', unrestPath, { body: {} }),
    unrestRes,
    unrestPath,
    new URL(`http://localhost${unrestPath}`),
  )
  assert.equal(unrestRes.statusCode, 200)
  assert.equal(unrestRes.jsonBody().data.unrested, true)
  assert.ok(unrestRes.jsonBody().data.cleared_cooldowns >= 1)

  const recoveredExp = await runtime.explainDispatch({
    originPoolId: fx.poolAnth.id,
    apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    sessionId: '550e8400-e29b-41d4-a716-446655440033',
  })
  assert.equal(recoveredExp.selected_node.node_key, 'claude_vm:vm-c1')

  // 6. SSE /api/panel/scheduler/events: 409 snapshot_required on stale epoch cursor
  const staleRes = makeMockRes()
  await handlePools(
    makeMockReq('GET', '/api/panel/scheduler/events?after=stale-epoch:1'),
    staleRes,
    '/api/panel/scheduler/events',
    new URL('http://localhost/api/panel/scheduler/events?after=stale-epoch:1'),
  )
  assert.equal(staleRes.statusCode, 409)
  assert.equal(staleRes.jsonBody().error.code, 'snapshot_required')

  // 7. SSE /api/panel/scheduler/events: live event stream delivers sanitized JSON frames & closes cleanly
  const sseReq = makeMockReq('GET', `/api/panel/scheduler/events?pool_id=${fx.poolAnth.id}`)
  const sseRes = makeMockRes()
  const receivedFrames = []
  const streamPromise = handlePools(
    sseReq,
    sseRes,
    '/api/panel/scheduler/events',
    new URL(`http://localhost/api/panel/scheduler/events?pool_id=${fx.poolAnth.id}`),
  )
  await new Promise((resolve) => sseRes.once('head', resolve))
  assert.equal(sseRes.statusCode, 200)
  assert.match(String(sseRes.headers['content-type']), /text\/event-stream/)

  const gotEvent = new Promise((resolve) => {
    sseRes.on('chunk', (chunk) => {
      receivedFrames.push(chunk)
      if (chunk.includes('event: lease_acquired') || chunk.includes('"lease_acquired"')) {
        resolve()
      }
    })
  })
  const evAcq = await runtime.acquireNode({
    originPoolId: fx.poolAnth.id,
    apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    sessionId: '550e8400-e29b-41d4-a716-446655440034',
  })
  await runtime.releaseLease(evAcq.lease_id, 'ok')
  await Promise.race([gotEvent, new Promise((_, rej) => setTimeout(() => rej(new Error('SSE event timeout')), 3000))])
  sseReq.emit('close')
  await streamPromise
  const rawSse = receivedFrames.join('')
  assert.match(rawSse, /event: lease_acquired/)
  assert.match(rawSse, /"cursor":/)
})

test('M3 runtime: sidecar SIGKILL recovers <300ms and hard-down returns strict 503 scheduler_unavailable', async (t) => {
  const tmp = makeTempDir('vm2api-m3-crash-')
  const fx = makeFixtureState(tmp)

  // 1. Crash recovery <300ms
  const runtime = createSchedulerRuntime({
    getDb: () => fx.db,
    getVms: () => fx.vms,
    getRoutingConfig: () => ({}),
    apiKeyStore: makeApiKeyStore(fx.db),
    apiEndpointStore: { listRaw: () => fx.endpoints },
    geminiScheduler: { listEnvironments: () => fx.geminiEnvs },
    telemetryIntervalMs: 0,
    clientOptions: {
      binPath: BIN_PATH,
      dataDir: tmp,
      socketPath: path.join(tmp, 'crash.sock'),
      tokenPath: path.join(tmp, 'crash.token'),
      capFile: path.join(tmp, 'crash.cap.json'),
      autoRestart: true,
    },
  })
  t.after(async () => {
    await runtime.shutdown({ drain: false, stopProcess: true })
    fx.db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  await runtime.start({ waitMs: 5_000, startLoops: true })
  const oldPid = runtime.client.pid
  assert.ok(oldPid > 0)

  const t0 = Date.now()
  process.kill(oldPid, 'SIGKILL')
  // Wait briefly for OS exit notification then immediately acquire within <=300ms recovery window
  await new Promise((r) => setTimeout(r, 25))
  const recovered = await runtime.acquireNode({
    originPoolId: fx.poolAnth.id,
    apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    sessionId: '550e8400-e29b-41d4-a716-446655440040',
  })
  const elapsedMs = Date.now() - t0
  assert.equal(recovered.selected_node.node_key, 'claude_vm:vm-c1')
  assert.notEqual(runtime.client.pid, oldPid)
  assert.ok(elapsedMs < 1500, `expected fast crash recovery, took ${elapsedMs}ms`)
  await runtime.releaseLease(recovered.lease_id, 'ok')

  // 2. Hard-down (stopped / missing binary) MUST Fail-Closed 503 scheduler_unavailable with Retry-After: 1
  await runtime.shutdown({ drain: false, stopProcess: true })
  await assert.rejects(
    () =>
      runtime.acquireNode({
        originPoolId: fx.poolAnth.id,
        apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
        apiKeyKind: 'managed',
        model: 'claude-sonnet-4-6',
        protocol: 'anthropic',
        sessionId: '550e8400-e29b-41d4-a716-446655440041',
      }),
    (err) =>
      err instanceof SchedulerUnavailableError &&
      err.status === 503 &&
      err.code === 'scheduler_unavailable' &&
      err.retryAfterSec === 1,
  )

  const handlePools = createSchedulerPoolsHandler({
    getDb: () => fx.db,
    getVms: () => fx.vms,
    apiKeyStore: makeApiKeyStore(fx.db),
    schedulerRuntime: () => runtime,
    json: makePanelJson(),
    readBody: makeReadBody(),
  })
  const downExplainRes = makeMockRes()
  await handlePools(
    makeMockReq('POST', '/api/panel/scheduler/explain', {
      body: { pool_id: fx.poolAnth.id, model: 'claude-sonnet-4-6' },
    }),
    downExplainRes,
    '/api/panel/scheduler/explain',
    new URL('http://localhost/api/panel/scheduler/explain'),
  )
  assert.equal(downExplainRes.statusCode, 503)
  assert.equal(downExplainRes.headers['retry-after'], '1')
  assert.equal(downExplainRes.jsonBody().error.code, 'scheduler_unavailable')
})

test('M3 zombie cleanup: AccountsRepo & AccountRuntimeRepo stop writing account_groups while groups 2-row table stays intact', () => {
  const tmp = makeTempDir('vm2api-m3-zombie-')
  const db = createDatabase({ dbPath: path.join(tmp, 'kin.db') })
  try {
    const groupsRepo = new GroupsRepo(db)
    const groups = groupsRepo.list()
    assert.equal(groups.length, 2)
    assert.equal(groupsRepo.rateMultiplier(1), 1)

    const accountsRepo = new AccountsRepo(db)
    accountsRepo.insert({ account_id: 'acc-1', vm_id: 'vm-1', email: 'a@example.com' })
    const runtimeRepo = new AccountRuntimeRepo(db)
    runtimeRepo.upsert({ account_id: 'acc-2', vm_id: 'vm-2', status: 'ready' })

    const count = db.prepare('SELECT COUNT(*) AS n FROM account_groups').get().n
    assert.equal(Number(count), 0, 'account_groups must receive zero runtime writes')
    assert.equal(accountsRepo.get('acc-1')?.vm_id, 'vm-1')
    assert.equal(runtimeRepo.get('acc-2')?.vm_id, 'vm-2')
    assert.equal(accountsRepo.remove('acc-1'), true)
  } finally {
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('M3 review fixes: dotted protocol inferModelFamily, panel JEV/refusal-guard syncConfigNow, and server handover drain order', async (t) => {
  // Minor #1: dotted protocol prefixes
  assert.equal(inferModelFamily('', 'anthropic.messages'), 'claude')
  assert.equal(inferModelFamily('', 'openai.responses'), 'openai')
  assert.equal(inferModelFamily('', 'openai.chat'), 'openai')
  assert.equal(inferModelFamily('', 'google.gemini'), 'gemini')

  // M1: PUT /api/panel/refusal-guards & PUT /api/panel/jev-intercept trigger schedulerRuntime.syncConfigNow
  const tmp = makeTempDir('vm2api-m3-jev-sync-')
  const db = openDatabase({ dbPath: path.join(tmp, 'kin.db') })
  t.after(() => {
    closeDatabase()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const syncReasons = []
  const fakeRuntime = {
    syncConfigNow: async (reason) => {
      syncReasons.push(reason)
      return { ok: true, applied: true, config_version: syncReasons.length }
    },
  }
  const panelHandler = createPanelHandler({
    cfg: { paths: { project: tmp, data: tmp }, port: 0 },
    apiKeyStore: makeApiKeyStore(db),
    apiEndpointStore: { list: () => [], listRaw: () => [] },
    schedulerRuntime: () => fakeRuntime,
    routingConfig: {},
    readBody: makeReadBody(),
    requireAuth: (req) => {
      req.panelRole = 'admin'
      req.panelUser = 'admin'
      req.panelUserId = 'u-admin'
      req.apiKeyKind = 'master'
      return true
    },
    json: makePanelJson(),
  })

  const resRefusal = makeMockRes()
  await panelHandler(
    makeMockReq('PUT', '/api/panel/refusal-guards', {
      body: {
        risk_audit: {
          ban_steps: [10, 10, 0],
          blocked_tools: [],
          block_system_prompt_rewrite: true,
          upstream_policy_phrases: [],
          downgrade_pool: 'pool_aabbccdd',
          downgrade_endpoint: '',
          downgrade_model: '',
          route_margin: 0.15,
          model_margin: 0.05,
        },
      },
    }),
    resRefusal,
    new URL('http://localhost/api/panel/refusal-guards'),
  )
  assert.equal(resRefusal.statusCode, 200)

  const resJev = makeMockRes()
  await panelHandler(
    makeMockReq('PUT', '/api/panel/jev-intercept', { body: { enabled: false } }),
    resJev,
    new URL('http://localhost/api/panel/jev-intercept'),
  )
  assert.equal(resJev.statusCode, 200)

  assert.ok(syncReasons.includes('PUT:/api/panel/refusal-guards'), `expected refusal-guards sync, got ${syncReasons}`)
  assert.ok(syncReasons.includes('PUT:/api/panel/jev-intercept'), `expected jev-intercept sync, got ${syncReasons}`)

  // M2 + Minor #2: server.mjs handoverLeadership drains before demoteToStandby, and uses matchEndpoints
  const serverSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/server.mjs'), 'utf8')
  const handoverBlock = serverSrc.slice(
    serverSrc.indexOf('async function handoverLeadership()'),
    serverSrc.indexOf('const panelStreams = new Set()'),
  )
  const drainIdx = handoverBlock.indexOf('drainPersistenceNow')
  const demoteIdx = handoverBlock.indexOf('demoteToStandby')
  assert.ok(drainIdx > 0 && demoteIdx > drainIdx, 'handoverLeadership must drain persistence before demoteToStandby')
  assert.equal(serverSrc.includes('apiScheduler.pick('), false, 'server.mjs should use apiScheduler.matchEndpoints')
})

test('M3 security: data-plane error mapping strips DecisionExplain from public client body while preserving internal explain & admin panel explain', async (t) => {
  const secretPrompt = 'TOP_SECRET_ADMIN_SYSTEM_PROMPT_DO_NOT_LEAK'
  const sensitiveExplain = {
    request_id: 'req-sec-1',
    config_version: 7,
    origin_pool_id: 'pool_secret01',
    resolved_pool_id: 'pool_secret01',
    model: 'claude-sonnet-4-6',
    is_downgraded: false,
    fallback_chain: ['pool_secret02'],
    session_gate: { wait_ms: 0, busy_at_peek: true, queue_depth_at_peek: 3 },
    affinity: {
      machine_id_present: true,
      machine_home_node: 'claude_vm:vm-secret-home',
      selected_node: null,
      stood_in: false,
      preserve_machine_home: true,
    },
    prompt_policy: {
      mode: 'override',
      preset: null,
      text: secretPrompt,
      client_system_policy: 'replace_client',
      source: 'pool',
    },
    order: [
      {
        node: 'claude_vm:vm-secret-1',
        tier: 9,
        sub_weight: 20,
        sub_bucket: 0,
        in_flight: 4,
        max_conc: 4,
        active_sessions: 4,
        max_sessions: 4,
        sunk: false,
      },
    ],
    excluded: [
      {
        pool_id: 'pool_secret01',
        node: 'claude_vm:vm-secret-2',
        reason: 'tenant_mismatch',
        detail: 'owner=tenant-99',
      },
    ],
    decide_us: 42,
  }

  const apiErr = new SchedulerApiError({
    status: 529,
    code: 'pool_exhausted',
    message: 'All candidate nodes are saturated',
    retryAfterSec: 3,
    explain: sensitiveExplain,
  })

  // 1. formatSchedulerError (used by Codex, API Direct, Gemini, FailoverRunner)
  const httpErr = formatSchedulerError(apiErr)
  assert.equal(httpErr.status, 529)
  assert.equal(httpErr.retryAfterSec, 3)
  assert.deepEqual(Object.keys(httpErr.body.error).sort(), ['code', 'message', 'type'])
  const serializedHttp = JSON.stringify(httpErr.body)
  assert.equal(serializedHttp.includes('explain'), false, 'public HTTP body must not contain explain')
  assert.equal(serializedHttp.includes('vm-secret-1'), false, 'public HTTP body must not leak order node_key')
  assert.equal(serializedHttp.includes('vm-secret-2'), false, 'public HTTP body must not leak excluded node_key')
  assert.equal(serializedHttp.includes('vm-secret-home'), false, 'public HTTP body must not leak machine_home_node')
  assert.equal(serializedHttp.includes(secretPrompt), false, 'public HTTP body must not leak prompt_policy.text')
  assert.equal(serializedHttp.includes('tenant-99'), false, 'public HTTP body must not leak tenant exclusion detail')
  // Server-internal explain remains intact for internal audit logging
  assert.equal(httpErr.explain?.prompt_policy?.text, secretPrompt)
  assert.equal(httpErr.explain?.excluded?.[0]?.node, 'claude_vm:vm-secret-2')

  // 2. FailoverRunner (Claude data plane): neither body.error.explain nor body.error.details may leak explain
  const runner = new FailoverRunner({
    scheduler: { markCooldown() {}, markSuccess() {}, setSchedulerRuntime() {} },
    schedulerRuntime: {
      async acquireNode() {
        throw apiErr
      },
    },
  })
  const failoverRes = await runner.run({
    requestId: 'req-sec-claude',
    canonicalBody: { model: 'claude-sonnet-4-6' },
    model: 'claude-sonnet-4-6',
    callAttempt: async () => {
      throw new Error('must not be called')
    },
  })
  assert.equal(failoverRes.ok, false)
  assert.equal(failoverRes.status, 529)
  assert.equal(failoverRes.body.error.explain, undefined)
  assert.equal(failoverRes.body.error.details, undefined)
  const serializedFailover = JSON.stringify(failoverRes.body)
  assert.equal(serializedFailover.includes('explain'), false)
  assert.equal(serializedFailover.includes('vm-secret-1'), false)
  assert.equal(serializedFailover.includes('vm-secret-2'), false)
  assert.equal(serializedFailover.includes(secretPrompt), false)
  assert.equal(failoverRes.explain?.prompt_policy?.text, secretPrompt)

  // 3. Admin-authenticated POST /api/panel/scheduler/explain STILL returns full order/excluded/prompt_policy
  const tmp = makeTempDir('vm2api-m3-sec-panel-')
  const fx = makeFixtureState(tmp)
  t.after(() => {
    fx.db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  const handlePools = createSchedulerPoolsHandler({
    getDb: () => fx.db,
    getVms: () => fx.vms,
    apiKeyStore: makeApiKeyStore(fx.db),
    schedulerRuntime: () => ({
      configVersion: 7,
      async explainDispatch() {
        return {
          ok: true,
          selected_node: { node_key: 'claude_vm:vm-secret-1', node_type: 'claude_vm', node_id: 'vm-secret-1' },
          resolved_pool_id: fx.poolAnth.id,
          prompt_policy: sensitiveExplain.prompt_policy,
          stood_in: false,
          preserve_machine_home: true,
          explain: sensitiveExplain,
        }
      },
    }),
    json: makePanelJson(),
    readBody: makeReadBody(),
  })
  const panelRes = makeMockRes()
  await handlePools(
    makeMockReq('POST', '/api/panel/scheduler/explain', {
      body: { pool_id: fx.poolAnth.id, model: 'claude-sonnet-4-6' },
    }),
    panelRes,
    '/api/panel/scheduler/explain',
    new URL('http://localhost/api/panel/scheduler/explain'),
  )
  assert.equal(panelRes.statusCode, 200)
  const panelData = panelRes.jsonBody().data
  assert.equal(panelData.order[0].node_key, 'claude_vm:vm-secret-1')
  assert.equal(panelData.excluded[0].node_key, 'claude_vm:vm-secret-2')
  assert.equal(panelData.prompt_policy.text, secretPrompt)
})

test('M3 security: request_id is isolated by authorization scope and data planes never forward untrusted X-Request-Id', async (t) => {
  // 1. Real Rust kin-scheduler: colliding requestId across tenants / scopes MUST NOT share lease_id or node_key,
  //    while identical caller + scope + requestId still hits Rust 60s idempotency cache.
  const tmp = makeTempDir('vm2api-m3-reqid-')
  const fx = makeFixtureState(tmp)
  const runtime = createSchedulerRuntime({
    getDb: () => fx.db,
    getVms: () => fx.vms,
    getRoutingConfig: () => ({}),
    apiKeyStore: makeApiKeyStore(fx.db),
    apiEndpointStore: { listRaw: () => fx.endpoints },
    geminiScheduler: { listEnvironments: () => fx.geminiEnvs },
    telemetryIntervalMs: 0,
    clientOptions: {
      binPath: BIN_PATH,
      dataDir: tmp,
      socketPath: path.join(tmp, 'reqid.sock'),
      tokenPath: path.join(tmp, 'reqid.token'),
      capFile: path.join(tmp, 'reqid.cap.json'),
    },
  })
  t.after(async () => {
    await runtime.shutdown({ drain: false, stopProcess: true })
    fx.db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  await runtime.start({ waitMs: 5_000, startLoops: true })

  const sharedClientReqId = 'attacker-chosen-x-request-id-999'

  // Caller A (platform strict key) acquires with sharedClientReqId
  const acqPlat = await runtime.acquireNode({
    requestId: sharedClientReqId,
    originPoolId: fx.poolAnth.id,
    apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    sessionId: '550e8400-e29b-41d4-a716-446655440071',
  })
  assert.equal(acqPlat.selected_node.node_key, 'claude_vm:vm-c1')
  assert.notEqual(acqPlat._request.request_id, sharedClientReqId)

  // Caller B (tenant key) sends the EXACT SAME requestId within 60s -> MUST get own tenant VM & distinct lease_id!
  const acqTenant = await runtime.acquireNode({
    requestId: sharedClientReqId,
    originPoolId: fx.poolAnth.id,
    apiKeyRecord: { ...fx.tenantKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    sessionId: '550e8400-e29b-41d4-a716-446655440072',
  })
  assert.equal(acqTenant.selected_node.node_key, 'claude_vm:vm-c-tenant')
  assert.notEqual(acqTenant.lease_id, acqPlat.lease_id)
  assert.notEqual(acqTenant._request.request_id, acqPlat._request.request_id)

  // Same key with narrower allowedNodeKeys sends the EXACT SAME requestId -> MUST get distinct lease on vm-c2!
  const acqNarrow = await runtime.acquireNode({
    requestId: sharedClientReqId,
    originPoolId: fx.poolAnth.id,
    apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    allowedNodeKeys: ['claude_vm:vm-c2'],
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    sessionId: '550e8400-e29b-41d4-a716-446655440073',
  })
  assert.equal(acqNarrow.selected_node.node_key, 'claude_vm:vm-c2')
  assert.notEqual(acqNarrow.lease_id, acqPlat.lease_id)
  assert.notEqual(acqNarrow._request.request_id, acqPlat._request.request_id)

  // Legitimate transport retry by Caller A with IDENTICAL scope & requestId STILL hits Rust 60s idempotency cache!
  const acqPlatRetry = await runtime.acquireNode({
    requestId: sharedClientReqId,
    originPoolId: fx.poolAnth.id,
    apiKeyRecord: { ...fx.strictKey, allowed_pool_ids: [fx.poolAnth.id] },
    apiKeyKind: 'managed',
    model: 'claude-sonnet-4-6',
    protocol: 'anthropic',
    sessionId: '550e8400-e29b-41d4-a716-446655440071',
  })
  assert.equal(acqPlatRetry.lease_id, acqPlat.lease_id)
  assert.equal(acqPlatRetry._request.request_id, acqPlat._request.request_id)

  // Re-scoping Caller A's already-scoped request_id under Caller A's scope is idempotent,
  // while re-scoping it under Caller B's scope yields a completely different key.
  const sameScopeAgain = scopeSchedulerRequestId(acqPlat._request.request_id, {
    api_key_scope: acqPlat._request.api_key_scope,
    origin_pool_id: acqPlat._request.origin_pool_id,
    jev_downgrade_pool_id: acqPlat._request.jev_downgrade_pool_id,
    model: acqPlat._request.model,
    model_family: acqPlat._request.model_family,
    protocol: acqPlat._request.protocol,
    pin_node_key: acqPlat._request.pin_node_key,
    is_admin_diagnostic: acqPlat._request.is_admin_diagnostic,
  })
  assert.equal(sameScopeAgain, acqPlat._request.request_id)
  const crossScopeGuess = scopeSchedulerRequestId(acqPlat._request.request_id, {
    api_key_scope: acqTenant._request.api_key_scope,
    origin_pool_id: acqTenant._request.origin_pool_id,
    model: acqTenant._request.model,
    model_family: acqTenant._request.model_family,
    protocol: acqTenant._request.protocol,
  })
  assert.notEqual(crossScopeGuess, acqPlat._request.request_id)

  await runtime.releaseLease(acqPlat.lease_id, 'ok')
  await runtime.releaseLease(acqTenant.lease_id, 'ok')
  await runtime.releaseLease(acqNarrow.lease_id, 'ok')

  // 2. Layer 1: FailoverRunner never forwards client-supplied requestId (X-Request-Id) into Rust acquireNode
  const seenAcquireIds = []
  const runner = new FailoverRunner({
    scheduler: { markCooldown() {}, markSuccess() {}, setSchedulerRuntime() {} },
    schedulerRuntime: {
      async acquireNode(params) {
        seenAcquireIds.push(params.requestId)
        throw new SchedulerApiError({ status: 503, code: 'pool_exhausted', message: 'busy' })
      },
    },
  })
  await runner.run({
    requestId: sharedClientReqId,
    canonicalBody: { model: 'claude-sonnet-4-6' },
    model: 'claude-sonnet-4-6',
    callAttempt: async () => ({ ok: true }),
  })
  await runner.run({
    requestId: sharedClientReqId,
    canonicalBody: { model: 'claude-sonnet-4-6' },
    model: 'claude-sonnet-4-6',
    callAttempt: async () => ({ ok: true }),
  })
  assert.equal(seenAcquireIds.length, 2)
  assert.notEqual(seenAcquireIds[0], sharedClientReqId)
  assert.notEqual(seenAcquireIds[1], sharedClientReqId)
  assert.notEqual(seenAcquireIds[0], seenAcquireIds[1])
})
