import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { filterModelsForPoolAccess, resolvePoolAccessForKey } from '../../src/lib/admin/key-scope.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { createSchedulerPoolsHandler } from '../../src/lib/admin/scheduler-pools-routes.mjs'
import { SchedulerPoolsRepo } from '../../src/lib/db/repos/scheduler-pools-repo.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'

function makeRequest(method, urlPath, body = null, { role = 'admin', user = 'admin', userId = 'u-admin' } = {}) {
  const chunks = body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.url = urlPath
  req.headers = { 'content-type': 'application/json' }
  req._testAuth = { role, user, userId }
  return req
}

function makeHarness({ vms = [], endpoints = [], geminiEnvs = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sched-m1b-'))
  const vmsDir = path.join(dir, 'vms')
  fs.mkdirSync(vmsDir, { recursive: true })
  for (const vm of vms) {
    fs.writeFileSync(path.join(vmsDir, `${vm.id}.json`), JSON.stringify(vm, null, 2))
  }
  const apiKeyStore = new ApiKeyStore({ dataDir: dir })
  const repo = new SchedulerPoolsRepo(apiKeyStore.db)
  const apiEndpointStore = {
    listRaw: () => endpoints,
    list: () => endpoints,
    get: (id) => endpoints.find((e) => e.id === id) || null,
  }
  const geminiScheduler = {
    listEnvironments: () => geminiEnvs,
  }
  const handler = createSchedulerPoolsHandler({
    getDb: () => apiKeyStore.db,
    getVms: () => vms,
    apiKeyStore,
    apiEndpointStore,
    geminiScheduler,
    json: (_res, status, payload) => ({ status, body: payload }),
    readBody,
  })
  const callPool = async (method, urlPath, body = null) => {
    const req = makeRequest(method, urlPath, body)
    const u = new URL(`http://localhost${urlPath}`)
    return handler(req, {}, u.pathname, u)
  }

  const panelHandler = createPanelHandler({
    cfg: { paths: { project: dir, data: dir } },
    apiKeyStore,
    apiEndpointStore,
    geminiScheduler,
    routingConfig: { concurrency: { default_key_concurrency: 20 } },
    readBody,
    requireAuth(req) {
      const a = req._testAuth || { role: 'admin', user: 'admin', userId: 'u-admin' }
      req.panelRole = a.role
      req.panelUser = a.user
      req.panelUserId = a.userId
      if (a.role === 'admin') req.apiKeyKind = 'master'
      return true
    },
    json(res, status, payload) {
      res.status = status
      res.body = payload
    },
  })
  const callPanel = async (method, urlPath, body = null, auth = {}) => {
    const req = makeRequest(method, urlPath, body, auth)
    const res = {}
    const u = new URL(`http://localhost${urlPath}`)
    await panelHandler(req, res, u)
    return res
  }

  const cleanup = () => {
    try {
      apiKeyStore.db.close()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  }

  return { dir, apiKeyStore, repo, callPool, callPanel, cleanup }
}

const SAMPLE_VMS = [
  {
    id: 'vm-crag-1',
    name: 'Claude CRAG 1',
    platform: 'anthropic',
    dataplane: 'crag',
    runtime_kind: 'crag',
    status: 'running',
    schedulable: true,
    policy: { max_concurrency: 6, weight: 20, priority: 3 },
    claude: { account_tier: 'max_20x' },
  },
  {
    id: 'vm-legacy-1',
    name: 'Claude Legacy CLI 1',
    platform: 'anthropic',
    dataplane: 'cli-node',
    runtime_kind: 'cli-node',
    status: 'running',
    schedulable: true,
    policy: { max_concurrency: 4, weight: 10 },
  },
  {
    id: 'vm-codex-1',
    name: 'Codex 1',
    platform: 'openai',
    family: 'codex',
    codex_kernel: true,
    status: 'running',
    schedulable: true,
    policy: { max_concurrency: 8, weight: 15 },
    codex: { plan_type: 'pro' },
  },
]

const SAMPLE_ENDPOINTS = [
  {
    id: 'ep_anth_1',
    name: 'Official Anthropic',
    protocol: 'anthropic',
    disabled: false,
    priority: 4,
    weight: 30,
    models: [{ alias: 'claude-sonnet-4-5', upstream_name: 'claude-sonnet-4-5' }],
  },
]

const SAMPLE_GEMINI = [
  {
    id: 'gem-env-1',
    name: 'Gemini Pro 1',
    email: 'gem1@example.com',
    enabled: true,
    healthy: true,
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
]

test('pools CRUD enforces v4 locked defaults, filters, prompt rules, and fallback chain guards', async () => {
  const h = makeHarness({ vms: SAMPLE_VMS, endpoints: SAMPLE_ENDPOINTS, geminiEnvs: SAMPLE_GEMINI })
  try {
    // Create with minimal body verifies v4 locked defaults
    const c1 = await h.callPool('POST', '/api/panel/pools', {
      name: 'Anthropic Official',
      provider_scope: 'anthropic',
      pool_role: 'primary',
      plan_tags: ['max_20x', 'pro'],
      system_prompt_mode: 'official',
    })
    assert.equal(c1.status, 201)
    assert.equal(c1.body.ok, true)
    const p1 = c1.body.data.pool
    assert.equal(p1.exclusive_members, false)
    assert.equal(p1.session_overflow_policy, 'spill_immediately')
    assert.equal(p1.session_busy_wait_ms, 0)
    assert.equal(p1.machine_ttl_seconds, 604800)
    assert.equal(p1.session_ttl_seconds, 86400)
    assert.equal(p1.session_queue_max, 16)
    assert.equal(p1.session_queue_timeout_ms, 60000)
    assert.equal(p1.system_prompt_mode, 'official')
    assert.deepEqual(p1.plan_tags, ['max_20x', 'pro'])
    assert.equal(p1.config_version, 1)

    // gemini alias -> google, passthrough allowed; openai defaults to passthrough;
    // anthropic / mixed / api default to inherit_global when system_prompt_mode is omitted
    const cGem = await h.callPool('POST', '/api/panel/pools', {
      name: 'Gemini Pool',
      provider_scope: 'gemini',
      pool_role: 'standard',
    })
    assert.equal(cGem.status, 201)
    assert.equal(cGem.body.data.pool.provider_scope, 'google')
    assert.equal(cGem.body.data.pool.system_prompt_mode, 'passthrough')

    const cOpenaiDefault = await h.callPool('POST', '/api/panel/pools', {
      name: 'OpenAI Default Pool',
      provider_scope: 'openai',
    })
    assert.equal(cOpenaiDefault.status, 201)
    assert.equal(cOpenaiDefault.body.data.pool.system_prompt_mode, 'passthrough')

    for (const scope of ['anthropic', 'mixed', 'api']) {
      const createdDefault = await h.callPool('POST', '/api/panel/pools', {
        name: `Default ${scope}`,
        provider_scope: scope,
      })
      assert.equal(createdDefault.status, 201, scope)
      assert.equal(createdDefault.body.data.pool.system_prompt_mode, 'inherit_global', scope)
    }

    // openai / google non-passthrough rejected with 400 pool_prompt_unsupported_provider
    for (const scope of ['openai', 'google', 'gemini']) {
      const bad = await h.callPool('POST', '/api/panel/pools', {
        name: `Bad ${scope}`,
        provider_scope: scope,
        system_prompt_mode: 'official',
      })
      assert.equal(bad.status, 400, scope)
      assert.equal(bad.body.error.code, 'pool_prompt_unsupported_provider', scope)
    }

    // override / append empty or >64 KiB rejected
    const emptyPrompt = await h.callPool('POST', '/api/panel/pools', {
      name: 'Empty Override',
      provider_scope: 'anthropic',
      system_prompt_mode: 'override',
      system_prompt_text: '   ',
    })
    assert.equal(emptyPrompt.status, 400)
    assert.equal(emptyPrompt.body.error.code, 'prompt_empty')

    const hugePrompt = await h.callPool('POST', '/api/panel/pools', {
      name: 'Huge Append',
      provider_scope: 'anthropic',
      system_prompt_mode: 'append',
      system_prompt_text: 'x'.repeat(64 * 1024 + 1),
    })
    assert.equal(hugePrompt.status, 400)
    assert.equal(hugePrompt.body.error.code, 'prompt_too_large')

    // Create additional Anthropic pools for fallback & filter tests
    const c2 = await h.callPool('POST', '/api/panel/pools', {
      name: 'Anthropic Zero',
      provider_scope: 'anthropic',
      pool_role: 'overflow',
      system_prompt_mode: 'zero_inject',
    })
    assert.equal(c2.status, 201)
    const p2 = c2.body.data.pool

    const c3 = await h.callPool('POST', '/api/panel/pools', {
      name: 'Anthropic Official B',
      provider_scope: 'anthropic',
      pool_role: 'overflow',
      system_prompt_mode: 'official',
    })
    const p3 = c3.body.data.pool

    const c4 = await h.callPool('POST', '/api/panel/pools', {
      name: 'Anthropic Official C',
      provider_scope: 'anthropic',
      pool_role: 'overflow',
      system_prompt_mode: 'official',
    })
    const p4 = c4.body.data.pool

    // Filters on GET /api/panel/pools
    const byScope = await h.callPool('GET', '/api/panel/pools?provider_scope=gemini')
    assert.equal(byScope.status, 200)
    assert.equal(byScope.body.data.pools.length, 1)
    assert.equal(byScope.body.data.pools[0].id, cGem.body.data.pool.id)

    const byTag = await h.callPool('GET', '/api/panel/pools?plan_tag=max_20x&pool_role=primary&enabled=1')
    assert.equal(byTag.body.data.pools.length, 1)
    assert.equal(byTag.body.data.pools[0].id, p1.id)

    // Fallback self-loop rejected
    const selfFb = await h.callPool('PATCH', `/api/panel/pools/${p1.id}`, { fallback_pool_id: p1.id })
    assert.equal(selfFb.status, 400)
    assert.equal(selfFb.body.error.code, 'fallback_self')

    // Cross-prompt fallback blocked unless allow_cross_prompt_fallback=true
    const crossBlocked = await h.callPool('PATCH', `/api/panel/pools/${p1.id}`, { fallback_pool_id: p2.id })
    assert.equal(crossBlocked.status, 400)
    assert.equal(crossBlocked.body.error.code, 'fallback_cross_prompt_forbidden')

    const crossAllowed = await h.callPool('PATCH', `/api/panel/pools/${p1.id}`, {
      fallback_pool_id: p2.id,
      allow_cross_prompt_fallback: true,
    })
    assert.equal(crossAllowed.status, 200)
    assert.equal(
      crossAllowed.body.data.warnings.some((w) => w.code === 'fallback_cross_prompt'),
      true,
    )
    assert.equal(crossAllowed.body.data.pool.config_version, 2)

    // Cycle detection (p2 -> p1 when p1 -> p2)
    const cycleRes = await h.callPool('PATCH', `/api/panel/pools/${p2.id}`, {
      fallback_pool_id: p1.id,
      allow_cross_prompt_fallback: true,
    })
    assert.equal(cycleRes.status, 400)
    assert.equal(cycleRes.body.error.code, 'fallback_cycle')

    // Same-prompt chain p1 -> p3 -> p4 (length 3 ok), then p4 -> p2 would make length 4 (rejected)
    assert.equal(
      (
        await h.callPool('PATCH', `/api/panel/pools/${p1.id}`, {
          fallback_pool_id: p3.id,
          allow_cross_prompt_fallback: false,
        })
      ).status,
      200,
    )
    assert.equal((await h.callPool('PATCH', `/api/panel/pools/${p3.id}`, { fallback_pool_id: p4.id })).status, 200)
    const depthExceeded = await h.callPool('PATCH', `/api/panel/pools/${p4.id}`, {
      fallback_pool_id: p2.id,
      allow_cross_prompt_fallback: true,
    })
    assert.equal(depthExceeded.status, 400)
    assert.equal(depthExceeded.body.error.code, 'fallback_depth_exceeded')

    // Upstream cross-prompt guard: p1 (official, allow_cross_prompt_fallback=false) -> p3 (official).
    // Changing p3 to zero_inject must be rejected because p1 points to p3 without cross-prompt consent.
    const upstreamGuard = await h.callPool('PATCH', `/api/panel/pools/${p3.id}`, {
      system_prompt_mode: 'zero_inject',
    })
    assert.equal(upstreamGuard.status, 400)
    assert.equal(upstreamGuard.body.error.code, 'fallback_cross_prompt_forbidden')
  } finally {
    h.cleanup()
  }
})

test('PUT /api/panel/pools/:id/members enforces D1 CRAG cross-prompt warning, cli-node reject, exclusive reject, and telemetry', async () => {
  const h = makeHarness({ vms: SAMPLE_VMS, endpoints: SAMPLE_ENDPOINTS, geminiEnvs: SAMPLE_GEMINI })
  try {
    const pOff = (
      await h.callPool('POST', '/api/panel/pools', {
        name: 'Official Pool',
        provider_scope: 'anthropic',
        system_prompt_mode: 'official',
      })
    ).body.data.pool
    const pZero = (
      await h.callPool('POST', '/api/panel/pools', {
        name: 'Zero Pool',
        provider_scope: 'anthropic',
        system_prompt_mode: 'zero_inject',
      })
    ).body.data.pool
    const pExcl = (
      await h.callPool('POST', '/api/panel/pools', {
        name: 'Exclusive Pool',
        provider_scope: 'mixed',
        exclusive_members: true,
      })
    ).body.data.pool

    // Add both CRAG VM and legacy cli-node VM to pOff with weight override
    const m1 = await h.callPool('PUT', `/api/panel/pools/${pOff.id}/members`, {
      members: [
        { node_type: 'claude_vm', node_id: 'vm-crag-1', weight_tier_override: 1, sub_weight_override: 50 },
        { node_type: 'claude_vm', node_id: 'vm-legacy-1' },
      ],
    })
    assert.equal(m1.status, 200)
    assert.equal(m1.body.data.warnings.length, 0)
    const cragMem = m1.body.data.pool.members.find((m) => m.node_id === 'vm-crag-1')
    assert.equal(cragMem.base_weight_tier, 3)
    assert.equal(cragMem.effective_weight_tier, 1)
    assert.equal(cragMem.effective_sub_weight, 50)
    assert.equal(cragMem.runtime_kind, 'crag')
    assert.equal(m1.body.data.pool.metrics.total_members, 2)
    assert.equal(m1.body.data.pool.metrics.healthy_members, 2)

    // D1: CRAG VM cross-prompt into pZero is ALLOWED with crag_cross_prompt warning
    const mCragCross = await h.callPool('PUT', `/api/panel/pools/${pZero.id}/members`, {
      members: [{ node_type: 'claude_vm', node_id: 'vm-crag-1' }],
    })
    assert.equal(mCragCross.status, 200)
    assert.equal(
      mCragCross.body.data.warnings.some((w) => w.code === 'crag_cross_prompt' && w.node_id === 'vm-crag-1'),
      true,
    )

    // Legacy cli-node VM cross-prompt into pZero is REJECTED with 400 cli_node_prompt_conflict
    const mLegacyCross = await h.callPool('PUT', `/api/panel/pools/${pZero.id}/members`, {
      members: [{ node_type: 'claude_vm', node_id: 'vm-legacy-1' }],
    })
    assert.equal(mLegacyCross.status, 400)
    assert.equal(mLegacyCross.body.error.code, 'cli_node_prompt_conflict')

    // Exclusive pool rejects already-assigned member
    const mExclConflict = await h.callPool('PUT', `/api/panel/pools/${pExcl.id}/members`, {
      members: [{ node_type: 'claude_vm', node_id: 'vm-crag-1' }],
    })
    assert.equal(mExclConflict.status, 400)
    assert.equal(mExclConflict.body.error.code, 'exclusive_member_conflict')

    // Active penalty marks member unhealthy with cooldown info
    const futureMs = Date.now() + 120_000
    h.repo.upsertNodePenalty({
      node_type: 'claude_vm',
      node_id: 'vm-crag-1',
      model_scope: 'claude',
      reason: 'http_429',
      cooldown_until_ms: futureMs,
      ladder_step: 1,
    })
    const detail = await h.callPool('GET', `/api/panel/pools/${pOff.id}`)
    const penalized = detail.body.data.pool.members.find((m) => m.node_id === 'vm-crag-1')
    assert.equal(penalized.healthy, false)
    assert.equal(penalized.cooldown_reason, 'http_429')
    assert.equal(penalized.cooldown_until_ms, futureMs)
    assert.equal(detail.body.data.pool.healthy_members, 1)
  } finally {
    h.cleanup()
  }
})

test('pool deletion guard (409 / migrate / force), sticky reset & admin routes, and pool key bindings preserve Fail-Closed', async () => {
  const h = makeHarness({ vms: SAMPLE_VMS })
  try {
    const p1 = (await h.callPool('POST', '/api/panel/pools', { name: 'Pool 1', provider_scope: 'anthropic' })).body.data
      .pool
    const p2 = (await h.callPool('POST', '/api/panel/pools', { name: 'Pool 2', provider_scope: 'anthropic' })).body.data
      .pool
    await h.callPool('PUT', `/api/panel/pools/${p1.id}/members`, {
      members: [{ node_type: 'claude_vm', node_id: 'vm-crag-1' }],
    })
    await h.callPool('PUT', `/api/panel/pools/${p2.id}/members`, {
      members: [{ node_type: 'claude_vm', node_id: 'vm-crag-1' }],
    })

    const key = h.apiKeyStore.create({ name: 'strict-key' })
    // Bind via POST /api/panel/pools/:id/keys
    const bindRes = await h.callPool('POST', `/api/panel/pools/${p1.id}/keys`, {
      api_key_id: key.id,
      is_default: true,
      pool_binding_mode: 'strict_pool',
    })
    assert.equal(bindRes.status, 200)
    assert.equal(bindRes.body.data.bindings.length, 1)

    const listKeysRes = await h.callPool('GET', `/api/panel/pools/${p1.id}/keys`)
    assert.equal(listKeysRes.status, 200)
    assert.equal(listKeysRes.body.data.keys.length, 1)
    assert.equal(listKeysRes.body.data.keys[0].api_key_id, key.id)

    // Delete p1 without force/migrate -> 409 scheduler_pool_in_use
    const delBlocked = await h.callPool('DELETE', `/api/panel/pools/${p1.id}`)
    assert.equal(delBlocked.status, 409)
    assert.equal(delBlocked.body.error.code, 'scheduler_pool_in_use')
    assert.equal(delBlocked.body.error.keys, 1)

    // Migrate keys on delete p1 -> p2
    const delMigrated = await h.callPool('DELETE', `/api/panel/pools/${p1.id}?migrate_to_pool_id=${p2.id}`)
    assert.equal(delMigrated.status, 200)
    assert.equal(delMigrated.body.deleted, true)
    const afterMigrateKey = h.apiKeyStore.getById(key.id)
    assert.equal(afterMigrateKey.default_pool_id, p2.id)
    assert.equal(afterMigrateKey.pool_binding_mode, 'strict_pool')

    // Seed machine & session sticky bindings on p2
    const now = Date.now()
    h.repo.upsertStickyBinding({
      scope_kind: 'machine',
      pool_id: p2.id,
      model_family: 'claude',
      identity_id: 'mach-1',
      node_type: 'claude_vm',
      node_id: 'vm-crag-1',
      bound_at_ms: now,
      last_seen_ms: now,
      expires_at_ms: now + 60_000,
    })
    h.repo.upsertStickyBinding({
      scope_kind: 'machine',
      pool_id: p2.id,
      model_family: 'claude',
      identity_id: 'mach-2',
      node_type: 'claude_vm',
      node_id: 'vm-legacy-1',
      bound_at_ms: now,
      last_seen_ms: now,
      expires_at_ms: now + 60_000,
    })
    h.repo.upsertStickyBinding({
      scope_kind: 'session',
      pool_id: p2.id,
      model_family: 'claude',
      identity_id: 'sess-1',
      machine_id: 'mach-1',
      node_type: 'claude_vm',
      node_id: 'vm-crag-1',
      bound_at_ms: now,
      last_seen_ms: now,
      expires_at_ms: now + 60_000,
    })

    // Query sticky by pool & machine_id
    const qAll = await h.callPool('GET', `/api/panel/scheduler/sticky?pool_id=${p2.id}`)
    assert.equal(qAll.status, 200)
    assert.equal(qAll.body.data.items.length, 3)
    assert.equal(qAll.body.data.bindings.length, 3)

    const qMach1 = await h.callPool('GET', `/api/panel/scheduler/sticky?machine_id=mach-1`)
    assert.equal(qMach1.body.data.items.length, 2) // machine + session with machine_id='mach-1'

    // Reset machine sticky for single node_key leaves other machine & session bindings intact
    const resetOne = await h.callPool('POST', `/api/panel/pools/${p2.id}/reset-machine-sticky`, {
      node_key: 'claude_vm:vm-crag-1',
    })
    assert.equal(resetOne.status, 200)
    assert.equal(resetOne.body.cleared, 1)
    assert.equal(resetOne.body.count, 1)

    // DELETE sticky without filter rejected
    const delNoFilter = await h.callPool('DELETE', '/api/panel/scheduler/sticky')
    assert.equal(delNoFilter.status, 400)
    assert.equal(delNoFilter.body.error.code, 'sticky_filter_required')

    // DELETE sticky by session_id
    const delSess = await h.callPool('DELETE', '/api/panel/scheduler/sticky?session_id=sess-1')
    assert.equal(delSess.status, 200)
    assert.equal(delSess.body.deleted, 1)

    // DELETE /api/panel/pools/:id/keys/:keyId preserves strict_pool Fail-Closed!
    const unbindRes = await h.callPool('DELETE', `/api/panel/pools/${p2.id}/keys/${key.id}`)
    assert.equal(unbindRes.status, 200)
    const unboundRec = h.apiKeyStore.getById(key.id)
    assert.equal(unboundRec.default_pool_id, null)
    assert.equal(unboundRec.pool_binding_mode, 'strict_pool')

    // Re-bind then force delete p2 -> strict_pool stays Fail-Closed and sticky cleared
    await h.callPool('POST', `/api/panel/pools/${p2.id}/keys`, { api_key_id: key.id, pool_binding_mode: 'strict_pool' })
    const delForce = await h.callPool('DELETE', `/api/panel/pools/${p2.id}?force=1`)
    assert.equal(delForce.status, 200)
    const afterForceKey = h.apiKeyStore.getById(key.id)
    assert.equal(afterForceKey.default_pool_id, null)
    assert.equal(afterForceKey.pool_binding_mode, 'strict_pool')
    assert.equal((await h.callPool('GET', `/api/panel/scheduler/sticky?pool_id=${p2.id}`)).body.data.items.length, 0)
  } finally {
    h.cleanup()
  }
})

test('panel-routes wires /api/panel/pools RBAC, /api/panel/vm-pools thin sync, and /api/panel/api-keys pool bindings', async () => {
  const h = makeHarness({ vms: SAMPLE_VMS, endpoints: SAMPLE_ENDPOINTS, geminiEnvs: SAMPLE_GEMINI })
  try {
    // Non-admin blocked on /api/panel/pools and /api/panel/scheduler/sticky
    for (const role of ['user', 'super']) {
      const r1 = await h.callPanel('GET', '/api/panel/pools', null, { role, user: 'alice', userId: 'u-1' })
      assert.equal(r1.status, 403, `${role} GET /api/panel/pools`)
      const r2 = await h.callPanel('GET', '/api/panel/scheduler/sticky', null, { role, user: 'alice', userId: 'u-1' })
      assert.equal(r2.status, 403, `${role} GET /api/panel/scheduler/sticky`)
    }

    // Legacy /api/panel/vm-pools syncs into scheduler_pools
    const legacyCreate = await h.callPanel('POST', '/api/panel/vm-pools', {
      name: 'Legacy Sync Pool',
      vm_ids: ['vm-crag-1', 'vm-codex-1'],
    })
    assert.equal(legacyCreate.status, 201)
    const legacyId = legacyCreate.body.data.pool.id
    const synced = h.repo.get(legacyId)
    assert.ok(synced)
    assert.equal(synced.name, 'Legacy Sync Pool')
    assert.equal(synced.provider_scope, 'anthropic')
    assert.equal(synced.system_prompt_mode, 'inherit_global')
    assert.deepEqual(synced.members.map((m) => `${m.node_type}:${m.node_id}`).sort(), [
      'claude_vm:vm-crag-1',
      'codex_vm:vm-codex-1',
    ])

    // Create custom-ID scheduler pool & Google pool via panel route
    const customPoolRes = await h.callPanel('POST', '/api/panel/pools', {
      id: 'pool_custom_alpha',
      name: 'Custom Alpha',
      provider_scope: 'google',
      members: [{ node_type: 'gemini_env', node_id: 'gem-env-1' }],
    })
    assert.equal(customPoolRes.status, 201)

    // Non-admin cannot set pool fields on API keys
    const userDenied = await h.callPanel(
      'POST',
      '/api/panel/api-keys',
      { name: 'bad', pool_binding_mode: 'strict_pool', default_pool_id: legacyId },
      { role: 'user', user: 'alice', userId: 'u-1' },
    )
    assert.equal(userDenied.status, 403)
    assert.equal(userDenied.body.error.code, 'key_pool_forbidden')

    // Admin creates strict_pool key spanning custom ID & legacy pool
    const keyRes = await h.callPanel('POST', '/api/panel/api-keys', {
      name: 'Multi Pool Key',
      pool_binding_mode: 'strict_pool',
      default_pool_id: 'pool_custom_alpha',
      allowed_pool_ids: ['pool_custom_alpha', legacyId],
      vm_pool_id: 'pool_custom_alpha', // mimics frontend key-payload.ts sending vm_pool_id alias
    })
    assert.equal(keyRes.status, 201)
    assert.equal(keyRes.body.item.pool_binding_mode, 'strict_pool')
    assert.equal(keyRes.body.item.default_pool_id, 'pool_custom_alpha')
    assert.equal(keyRes.body.item.default_pool_name, 'Custom Alpha')
    assert.deepEqual(keyRes.body.item.allowed_pool_ids, ['pool_custom_alpha', legacyId])

    // GET /api/panel/api-keys & /:id/stats return enriched pool fields
    const listRes = await h.callPanel('GET', '/api/panel/api-keys')
    assert.equal(listRes.status, 200)
    const listed = listRes.body.keys.find((k) => k.id === keyRes.body.item.id)
    assert.equal(listed.default_pool_id, 'pool_custom_alpha')
    assert.equal(listed.default_pool_name, 'Custom Alpha')
    assert.equal(listed.pool_binding_mode, 'strict_pool')

    const statsRes = await h.callPanel('GET', `/api/panel/api-keys/${keyRes.body.item.id}/stats`)
    assert.equal(statsRes.status, 200)
    assert.equal(statsRes.body.item.default_pool_id, 'pool_custom_alpha')

    // PATCH api key switches default pool
    const patchRes = await h.callPanel('PATCH', `/api/panel/api-keys/${keyRes.body.item.id}`, {
      default_pool_id: legacyId,
      allowed_pool_ids: [legacyId],
      pool_binding_mode: 'strict_pool',
    })
    assert.equal(patchRes.status, 200)
    assert.equal(patchRes.body.item.default_pool_id, legacyId)
    assert.deepEqual(patchRes.body.item.allowed_pool_ids, [legacyId])

    // DELETE api key removes api_key_pool_bindings
    const delKey = await h.callPanel('DELETE', `/api/panel/api-keys/${keyRes.body.item.id}`)
    assert.equal(delKey.status, 200)
    assert.equal(h.repo.listBindingsByKey(keyRes.body.item.id).length, 0)

    // DELETE legacy vm-pool removes synced scheduler_pool
    const delLegacy = await h.callPanel('DELETE', `/api/panel/vm-pools/${legacyId}`)
    assert.equal(delLegacy.status, 200)
    assert.equal(h.repo.get(legacyId), null)
  } finally {
    h.cleanup()
  }
})

test('resolvePoolAccessForKey and filterModelsForPoolAccess enforce Fail-Closed, X-VM2API-Pool, owner/model intersection, and trusted JEV downgrade', () => {
  const h = makeHarness()
  try {
    const mainPool = h.repo.insert({
      id: 'pool_main_1',
      name: 'Main Claude',
      provider_scope: 'anthropic',
      pool_role: 'primary',
      system_prompt_mode: 'official',
    })
    h.repo.setMembers(mainPool.id, [{ node_type: 'claude_vm', node_id: 'vm-plat-1' }])

    const secondPool = h.repo.insert({
      id: 'pool_codex_2',
      name: 'Codex Pool',
      provider_scope: 'openai',
      pool_role: 'standard',
    })
    h.repo.setMembers(secondPool.id, [{ node_type: 'codex_vm', node_id: 'vm-codex-1' }])

    const downgradePool = h.repo.insert({
      id: 'pool_down_3',
      name: 'JEV Downgrade',
      provider_scope: 'anthropic',
      pool_role: 'downgrade',
      system_prompt_mode: 'zero_inject',
    })
    h.repo.setMembers(downgradePool.id, [
      { node_type: 'claude_vm', node_id: 'vm-plat-down' },
      { node_type: 'claude_vm', node_id: 'vm-tenant-a' },
    ])

    const disabledPool = h.repo.insert({
      id: 'pool_off_4',
      name: 'Disabled',
      enabled: false,
      provider_scope: 'anthropic',
    })
    h.repo.setMembers(disabledPool.id, [{ node_type: 'claude_vm', node_id: 'vm-plat-1' }])

    const emptyPool = h.repo.insert({
      id: 'pool_empty_5',
      name: 'Empty',
      provider_scope: 'anthropic',
    })

    const vms = [
      { id: 'vm-plat-1', platform: 'anthropic', owner_user_id: null },
      { id: 'vm-plat-down', platform: 'anthropic', owner_user_id: null },
      { id: 'vm-tenant-a', platform: 'anthropic', owner_user_id: 'tenant-a' },
      { id: 'vm-codex-1', platform: 'openai', family: 'codex', owner_user_id: null },
    ]

    // 1. legacy_scope unbound key -> legacy: true
    const legacyKey = h.apiKeyStore.create({ name: 'legacy' })
    const legRes = resolvePoolAccessForKey({ key: legacyKey, poolsRepo: h.repo, vms })
    assert.equal(legRes.ok, true)
    assert.equal(legRes.legacy, true)
    assert.equal(legRes.effectivePool, null)

    // 2. strict_pool unbound key -> 403 pool_unavailable
    const strictKey = h.apiKeyStore.create({ name: 'strict' })
    h.repo.setKeyBindings(strictKey.id, [], { defaultPoolId: null, bindingMode: 'strict_pool' })
    h.apiKeyStore.reload()
    const unboundRes = resolvePoolAccessForKey({
      key: h.apiKeyStore.getById(strictKey.id),
      poolsRepo: h.repo,
      vms,
    })
    assert.equal(unboundRes.ok, false)
    assert.equal(unboundRes.status, 403)
    assert.equal(unboundRes.code, 'pool_unavailable')
    assert.equal(unboundRes.reason, 'no_pool_bound')

    // 3. Disabled / empty / missing pools fail closed
    h.repo.setKeyBindings(strictKey.id, [disabledPool.id], {
      defaultPoolId: disabledPool.id,
      bindingMode: 'strict_pool',
    })
    h.apiKeyStore.reload()
    const disRes = resolvePoolAccessForKey({ key: h.apiKeyStore.getById(strictKey.id), poolsRepo: h.repo, vms })
    assert.equal(disRes.ok, false)
    assert.equal(disRes.code, 'pool_unavailable')
    assert.equal(disRes.reason, 'disabled')

    h.repo.setKeyBindings(strictKey.id, [emptyPool.id], { defaultPoolId: emptyPool.id, bindingMode: 'strict_pool' })
    h.apiKeyStore.reload()
    const empRes = resolvePoolAccessForKey({ key: h.apiKeyStore.getById(strictKey.id), poolsRepo: h.repo, vms })
    assert.equal(empRes.ok, false)
    assert.equal(empRes.code, 'pool_unavailable')
    assert.equal(empRes.reason, 'empty')

    // 4. Bind strictKey to mainPool only -> X-VM2API-Pool for secondPool returns 403 pool_forbidden
    h.repo.setKeyBindings(strictKey.id, [mainPool.id], { defaultPoolId: mainPool.id, bindingMode: 'strict_pool' })
    h.apiKeyStore.reload()
    const boundKey = h.apiKeyStore.getById(strictKey.id)

    const forbidden = resolvePoolAccessForKey({
      key: boundKey,
      requestedPoolId: secondPool.id,
      poolsRepo: h.repo,
      vms,
    })
    assert.equal(forbidden.ok, false)
    assert.equal(forbidden.status, 403)
    assert.equal(forbidden.code, 'pool_forbidden')

    // Model family mismatch (requesting gpt-5 against Claude-only pool) -> 403 empty_intersection
    const modelMismatch = resolvePoolAccessForKey({
      key: boundKey,
      model: 'gpt-5',
      poolsRepo: h.repo,
      vms,
    })
    assert.equal(modelMismatch.ok, false)
    assert.equal(modelMismatch.code, 'pool_unavailable')
    assert.equal(modelMismatch.reason, 'empty_intersection')

    // Normal Claude request succeeds with exact member lists
    const okMain = resolvePoolAccessForKey({
      key: boundKey,
      model: 'claude-sonnet-4-5',
      poolsRepo: h.repo,
      vms,
    })
    assert.equal(okMain.ok, true)
    assert.equal(okMain.legacy, false)
    assert.equal(okMain.isDowngraded, false)
    assert.equal(okMain.effectivePool.id, mainPool.id)
    assert.deepEqual(okMain.allowedClaudeVmIds, ['vm-plat-1'])

    // 5. Trusted JEV downgrade bypasses allowed_pool_ids whitelist (downgradePool NOT in boundKey's allowed pools),
    // while keeping platform owner isolation (vm-tenant-a excluded for platform key!)
    const downgraded = resolvePoolAccessForKey({
      key: boundKey,
      jevDowngradePoolId: downgradePool.id,
      isTrustedDowngrade: true,
      model: 'claude-sonnet-4-5',
      poolsRepo: h.repo,
      vms,
    })
    assert.equal(downgraded.ok, true)
    assert.equal(downgraded.isDowngraded, true)
    assert.equal(downgraded.originPool.id, mainPool.id)
    assert.equal(downgraded.effectivePool.id, downgradePool.id)
    assert.deepEqual(downgraded.allowedClaudeVmIds, ['vm-plat-down'])

    // Untrusted downgrade target (standard role, not in trustedDowngradePoolIds) -> 403
    const untrustedTarget = resolvePoolAccessForKey({
      key: boundKey,
      jevDowngradePoolId: secondPool.id,
      isTrustedDowngrade: true,
      poolsRepo: h.repo,
      vms,
    })
    assert.equal(untrustedTarget.ok, false)
    assert.equal(untrustedTarget.code, 'pool_unavailable')
    assert.equal(untrustedTarget.reason, 'downgrade_pool_untrusted_or_unavailable')

    // Caller without isTrustedDowngrade=true cannot trigger downgrade
    const notTrustedFlag = resolvePoolAccessForKey({
      key: boundKey,
      jevDowngradePoolId: downgradePool.id,
      isTrustedDowngrade: false,
      model: 'claude-sonnet-4-5',
      poolsRepo: h.repo,
      vms,
    })
    assert.equal(notTrustedFlag.ok, true)
    assert.equal(notTrustedFlag.isDowngraded, false)
    assert.equal(notTrustedFlag.effectivePool.id, mainPool.id)

    // Tenant key still enforces owner_id isolation during trusted downgrade
    const tenantKey = h.apiKeyStore.create({
      name: 'tenant-a-key',
      permission_tier: 'tenant',
      owner_id: 'tenant-a',
      allowed_models: ['claude-sonnet-4-5'],
    })
    h.repo.setKeyBindings(tenantKey.id, [downgradePool.id], {
      defaultPoolId: downgradePool.id,
      bindingMode: 'strict_pool',
    })
    h.apiKeyStore.reload()
    const tenantRec = h.apiKeyStore.getById(tenantKey.id)

    const tenantOk = resolvePoolAccessForKey({
      key: tenantRec,
      jevDowngradePoolId: downgradePool.id,
      isTrustedDowngrade: true,
      model: 'claude-sonnet-4-5',
      poolsRepo: h.repo,
      vms,
    })
    assert.equal(tenantOk.ok, true)
    assert.deepEqual(tenantOk.allowedClaudeVmIds, ['vm-tenant-a'])

    // Key allowed_models still enforced on downgrade
    const tenantDeniedModel = resolvePoolAccessForKey({
      key: tenantRec,
      jevDowngradePoolId: downgradePool.id,
      isTrustedDowngrade: true,
      model: 'claude-opus-4-6',
      poolsRepo: h.repo,
      vms,
    })
    assert.equal(tenantDeniedModel.ok, false)
    assert.equal(tenantDeniedModel.reason, 'model_not_allowed')

    // 6. filterModelsForPoolAccess filters { data } and { models } and fails closed on denied access
    const openaiCatalog = {
      object: 'list',
      data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-opus-4-6' }, { id: 'gpt-5' }, { id: 'gemini-2.5-pro' }],
    }
    const filteredMain = filterModelsForPoolAccess(openaiCatalog, okMain, { vms })
    assert.deepEqual(
      filteredMain.data.map((m) => m.id),
      ['claude-sonnet-4-5', 'claude-opus-4-6'],
    )

    const filteredTenant = filterModelsForPoolAccess(openaiCatalog, tenantOk, { vms })
    assert.deepEqual(
      filteredTenant.data.map((m) => m.id),
      ['claude-sonnet-4-5'],
    )

    const filteredDenied = filterModelsForPoolAccess(openaiCatalog, unboundRes, { vms })
    assert.deepEqual(filteredDenied.data, [])

    const googleCatalog = {
      models: [{ name: 'models/gemini-2.5-pro' }, { name: 'models/claude-sonnet-4-5' }],
    }
    const gemPool = h.repo.insert({ id: 'pool_gem_6', name: 'Gem', provider_scope: 'google' })
    h.repo.setMembers(gemPool.id, [{ node_type: 'gemini_env', node_id: 'gem-env-1' }])
    h.repo.setKeyBindings(strictKey.id, [gemPool.id], { defaultPoolId: gemPool.id, bindingMode: 'strict_pool' })
    h.apiKeyStore.reload()
    const gemAccess = resolvePoolAccessForKey({
      key: h.apiKeyStore.getById(strictKey.id),
      poolsRepo: h.repo,
      geminiEnvs: SAMPLE_GEMINI,
    })
    assert.equal(gemAccess.ok, true)
    const filteredGoogle = filterModelsForPoolAccess(googleCatalog, gemAccess, { geminiEnvs: SAMPLE_GEMINI })
    assert.deepEqual(filteredGoogle.models, [{ name: 'models/gemini-2.5-pro' }])
  } finally {
    h.cleanup()
  }
})

test('Major #4: memberServesModel & endpointServesModel handle ag-* Antigravity 3P, gemini key bare claude, ep.prefix, m.name, and official preset catalogs', async () => {
  const h = makeHarness({ vms: SAMPLE_VMS })
  try {
    const agGeminiEnvs = [
      {
        id: 'gem-ag-1',
        enabled: true,
        models: ['gemini-2.5-pro', 'claude-sonnet-4-6-high', 'gpt-oss-120b-medium'],
      },
    ]
    const gemPool = h.repo.insert({ id: 'pool_ag_gem', name: 'AG Gemini', provider_scope: 'google' })
    h.repo.setMembers(gemPool.id, [{ node_type: 'gemini_env', node_id: 'gem-ag-1' }])

    const vmPool = h.repo.insert({ id: 'pool_vm_only', name: 'VM Only', provider_scope: 'mixed' })
    h.repo.setMembers(vmPool.id, [
      { node_type: 'claude_vm', node_id: 'vm-crag-1' },
      { node_type: 'codex_vm', node_id: 'vm-codex-1' },
    ])

    // 1. ag-* is classified as 'gemini': VM-only pool must NOT match ag-claude-*; gemini_env matches raw upstream slug
    const allKey = h.apiKeyStore.create({ name: 'all-key', group_type: 'all' })
    h.repo.setKeyBindings(allKey.id, [vmPool.id, gemPool.id], {
      defaultPoolId: vmPool.id,
      bindingMode: 'strict_pool',
    })
    h.apiKeyStore.reload()
    const allKeyRec = h.apiKeyStore.getById(allKey.id)

    const vmAgDenied = resolvePoolAccessForKey({
      key: allKeyRec,
      requestedPoolId: vmPool.id,
      model: 'ag-claude-sonnet-4-6-high',
      poolsRepo: h.repo,
      vms: SAMPLE_VMS,
    })
    assert.equal(vmAgDenied.ok, false)
    assert.equal(vmAgDenied.reason, 'empty_intersection')

    const gemAgAllowed = resolvePoolAccessForKey({
      key: allKeyRec,
      requestedPoolId: gemPool.id,
      model: 'ag-claude-sonnet-4-6-high',
      poolsRepo: h.repo,
      geminiEnvs: agGeminiEnvs,
    })
    assert.equal(gemAgAllowed.ok, true)
    assert.deepEqual(gemAgAllowed.allowedGeminiEnvIds, ['gem-ag-1'])

    // all-group key must NOT route bare claude-* to gemini_env
    const allKeyBareClaudeDenied = resolvePoolAccessForKey({
      key: allKeyRec,
      requestedPoolId: gemPool.id,
      model: 'claude-sonnet-4-6-high',
      poolsRepo: h.repo,
      geminiEnvs: agGeminiEnvs,
    })
    assert.equal(allKeyBareClaudeDenied.ok, false)
    assert.equal(allKeyBareClaudeDenied.reason, 'empty_intersection')

    // Dedicated group_type='gemini' key CAN route bare claude-* (Antigravity 3P) through gemini_env
    const gemOnlyKey = h.apiKeyStore.create({ name: 'gem-only-key', group_type: 'gemini' })
    h.repo.setKeyBindings(gemOnlyKey.id, [gemPool.id], { defaultPoolId: gemPool.id, bindingMode: 'strict_pool' })
    h.apiKeyStore.reload()
    const gemOnlyRec = h.apiKeyStore.getById(gemOnlyKey.id)

    const gemBareClaudeOk = resolvePoolAccessForKey({
      key: gemOnlyRec,
      model: 'claude-sonnet-4-6-high',
      poolsRepo: h.repo,
      geminiEnvs: agGeminiEnvs,
    })
    assert.equal(gemBareClaudeOk.ok, true)
    assert.deepEqual(gemBareClaudeOk.allowedGeminiEnvIds, ['gem-ag-1'])

    // 2. api_endpoint: supports m.name (ApiEndpointsRepo shape), ep.prefix, and official kind='claude'/'openai' catalogs
    const apiEndpoints = [
      {
        id: 'ep_prefixed',
        kind: 'custom',
        protocol: 'anthropic',
        prefix: 'acme',
        disabled: false,
        models: [{ name: 'claude-sonnet-4-6', alias: 'sonnet-fast' }],
      },
      {
        id: 'ep_official_claude',
        kind: 'claude',
        protocol: 'anthropic',
        prefix: '',
        disabled: false,
        models: [],
      },
    ]
    const apiPool = h.repo.insert({ id: 'pool_api_ep', name: 'API Endpoints', provider_scope: 'api' })
    h.repo.setMembers(apiPool.id, [
      { node_type: 'api_endpoint', node_id: 'ep_prefixed' },
      { node_type: 'api_endpoint', node_id: 'ep_official_claude' },
    ])
    const apiKey = h.apiKeyStore.create({ name: 'api-key', category: 'api', group_type: 'all' })
    h.repo.setKeyBindings(apiKey.id, [apiPool.id], { defaultPoolId: apiPool.id, bindingMode: 'strict_pool' })
    h.apiKeyStore.reload()
    const apiKeyRec = h.apiKeyStore.getById(apiKey.id)

    // Prefixed alias (`acme/sonnet-fast`) and raw m.name (`acme/claude-sonnet-4-6`) match ep_prefixed
    const prefAlias = resolvePoolAccessForKey({
      key: apiKeyRec,
      model: 'acme/sonnet-fast',
      poolsRepo: h.repo,
      apiEndpoints,
    })
    assert.equal(prefAlias.ok, true)
    assert.deepEqual(prefAlias.allowedEndpointIds, ['ep_prefixed'])

    const prefName = resolvePoolAccessForKey({
      key: apiKeyRec,
      model: 'acme/claude-sonnet-4-6',
      poolsRepo: h.repo,
      apiEndpoints,
    })
    assert.equal(prefName.ok, true)
    assert.deepEqual(prefName.allowedEndpointIds, ['ep_prefixed'])

    // Official kind='claude' endpoint with empty models[] matches built-in Claude catalog, rejects gpt-5
    const officialClaudeHit = resolvePoolAccessForKey({
      key: apiKeyRec,
      model: 'claude-sonnet-4-5',
      poolsRepo: h.repo,
      apiEndpoints,
    })
    assert.equal(officialClaudeHit.ok, true)
    assert.deepEqual(officialClaudeHit.allowedEndpointIds, ['ep_official_claude'])

    const officialClaudeRejectGpt = resolvePoolAccessForKey({
      key: apiKeyRec,
      model: 'gpt-5',
      poolsRepo: h.repo,
      apiEndpoints,
    })
    assert.equal(officialClaudeRejectGpt.ok, false)
    assert.equal(officialClaudeRejectGpt.reason, 'empty_intersection')

    // filterModelsForPoolAccess also reflects ep.prefix & official preset catalogs accurately
    const apiAccessAll = resolvePoolAccessForKey({
      key: apiKeyRec,
      poolsRepo: h.repo,
      apiEndpoints,
    })
    assert.equal(apiAccessAll.ok, true)
    const filteredApi = filterModelsForPoolAccess(
      { data: [{ id: 'acme/sonnet-fast' }, { id: 'claude-sonnet-4-5' }, { id: 'gpt-5' }] },
      apiAccessAll,
      { apiEndpoints },
    )
    assert.deepEqual(
      filteredApi.data.map((m) => m.id),
      ['acme/sonnet-fast', 'claude-sonnet-4-5'],
    )
  } finally {
    h.cleanup()
  }
})

test('Major #5: POST/DELETE /api/panel/pools/:id/keys clears stale vm_pool_id on custom pool IDs and normalizes strict_pool group_type/allowed_vms', async () => {
  const h = makeHarness({ vms: SAMPLE_VMS })
  try {
    const hexPool = h.repo.insert({ id: 'pool_a1b2c3d4', name: 'Hex Pool', provider_scope: 'anthropic' })
    const customPool = h.repo.insert({ id: 'pool_custom_openai', name: 'Custom OpenAI', provider_scope: 'openai' })
    h.repo.setMembers(hexPool.id, [{ node_type: 'claude_vm', node_id: 'vm-crag-1' }])
    h.repo.setMembers(customPool.id, [{ node_type: 'codex_vm', node_id: 'vm-codex-1' }])

    // Existing key with legacy group_type='anthropic', allowed_vms=['vm-crag-1'], and 8-hex vm_pool_id
    const key = h.apiKeyStore.create({
      name: 'legacy-anth-key',
      group_type: 'anthropic',
      allowed_vms: ['vm-crag-1'],
      vm_pool_id: hexPool.id,
    })
    h.repo.setKeyBindings(key.id, [hexPool.id], { defaultPoolId: hexPool.id, bindingMode: 'legacy_scope' })
    h.apiKeyStore.reload()

    // Bind to custom-ID openai pool as default with strict_pool via POST /api/panel/pools/:id/keys
    const bindRes = await h.callPool('POST', `/api/panel/pools/${customPool.id}/keys`, {
      api_key_id: key.id,
      is_default: true,
      pool_binding_mode: 'strict_pool',
    })
    assert.equal(bindRes.status, 200)
    const afterBind = h.apiKeyStore.getById(key.id)
    assert.equal(afterBind.default_pool_id, customPool.id)
    assert.equal(afterBind.vm_pool_id, null) // stale 8-hex vm_pool_id MUST be cleared
    assert.equal(afterBind.pool_binding_mode, 'strict_pool')
    assert.equal(afterBind.group_type, 'all') // normalized so openai/mixed pool won't hit 403 key_group_mismatch
    assert.deepEqual(JSON.parse(afterBind.allowed_vms || '[]'), [])

    // Re-bind back to hexPool as default, then delete hexPool binding -> falls back to customPool & clears vm_pool_id
    const bindHexRes = await h.callPool('POST', `/api/panel/pools/${hexPool.id}/keys`, {
      api_key_id: key.id,
      is_default: true,
      pool_binding_mode: 'strict_pool',
    })
    assert.equal(bindHexRes.status, 200)
    assert.equal(h.apiKeyStore.getById(key.id).vm_pool_id, hexPool.id)

    const unbindHexRes = await h.callPool('DELETE', `/api/panel/pools/${hexPool.id}/keys/${key.id}`)
    assert.equal(unbindHexRes.status, 200)
    const afterUnbind = h.apiKeyStore.getById(key.id)
    assert.equal(afterUnbind.default_pool_id, customPool.id)
    assert.equal(afterUnbind.vm_pool_id, null) // stale hexPool ID MUST be cleared when falling back to customPool
    assert.equal(afterUnbind.pool_binding_mode, 'strict_pool')
  } finally {
    h.cleanup()
  }
})
