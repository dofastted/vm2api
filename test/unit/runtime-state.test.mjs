import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import http from 'node:http'
import { localDocker } from '../../src/lib/cluster/docker-remote.mjs'
import { raiseDockerSlotMemory } from '../../src/lib/vm/docker-slot-memory.mjs'
import { powerOnSlot } from '../../src/lib/vm/slot-recovery.mjs'
import { runtimePatch } from '../../src/lib/vm/vm-runtime.mjs'
import { getVm, patchVmRecord } from '../../src/lib/vm/vm-registry.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import {
  AccountRuntimeRepo,
  listAllSnapshotsAsync,
  listAllVmsAsync,
} from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { SchedulerSnapshotCache } from '../../src/lib/cache/scheduler-cache.mjs'
import { closeCacheRuntime, initCacheRuntime, invalidateAllCaches } from '../../src/lib/cache/index.mjs'
import { VIRTUAL_POOL_IDS, createSchedulerRuntime } from '../../src/lib/scheduler/scheduler-runtime.mjs'

for (const type of ['docker', 'kvm']) {
  test(`runtime observation replaces stale stopped state (${type})`, () => {
    const vm = { id: 'vm-01', runtime: { type, stopped: true, pid: 7 } }
    runtimePatch(vm, { running: true, pid: 42, startedAt: '2026-01-01T00:00:00Z' })
    assert.equal(vm.runtime.stopped, false)
    assert.equal(vm.runtime.pid, 42)
    assert.equal(vm.runtime.started_at, '2026-01-01T00:00:00Z')
    runtimePatch(vm, { running: false, pid: 0 })
    assert.equal(vm.runtime.stopped, true)
    assert.equal(vm.runtime.pid, null)
  })
}

test('missing runtime observation does not claim a running container', () => {
  const vm = { id: 'vm-01' }
  runtimePatch(vm, null)
  assert.equal(vm.runtime.stopped, true)
  assert.equal(vm.runtime.pid, null)
})

function fixture(t, credential = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-state-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  const vm = {
    id: 'vm-01',
    status: 'stopped',
    runtime: { type: 'docker', stopped: true, pid: 7, started_at: 'old' },
    ...(credential ? { claude: { has_access: true, has_refresh: true } } : {}),
  }
  const file = path.join(root, 'vms', `${vm.id}.json`)
  fs.writeFileSync(file, JSON.stringify(vm))
  return {
    file,
    options: {
      projectRoot: root,
      id: vm.id,
      proxyPool: { ensureBoundToVm: () => ({ id: 'px-local', kind: 'local' }) },
      fillTimezone: async () => {},
    },
  }
}

for (const credential of [false, true]) {
  test(`power-on persists fresh runtime without changing credential gating (${credential})`, async (t) => {
    const { file, options } = fixture(t, credential)
    const runtime = { type: 'docker', stopped: false, pid: 42, started_at: 'new' }
    const result = await powerOnSlot({
      ...options,
      ops: { startSlotReady: async () => ({ ok: true, runtime }) },
    })
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(result.ok, true)
    assert.deepEqual(saved.runtime, runtime)
    assert.deepEqual(result.vm.runtime, runtime)
    assert.equal(saved.status, 'running')
    assert.equal(saved.schedulable, credential)
    assert.equal(saved.schedule_disabled_reason, credential ? null : 'no_credential')
  })
}

test('power-on persists the nested runtime returned by Codex boot', async (t) => {
  const { file, options } = fixture(t)
  const runtime = { type: 'docker', stopped: false, pid: 99, started_at: 'new' }
  const result = await powerOnSlot({
    ...options,
    ops: { startSlotReady: async () => ({ ok: true, engine: 'codex', docker: { ok: true, runtime } }) },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).runtime, runtime)
})

test('failed power-on never publishes successful runtime metadata', async (t) => {
  const { file, options } = fixture(t)
  const result = await powerOnSlot({
    ...options,
    ops: { startSlotReady: async () => ({ ok: false, error: 'injected failure', runtime: { pid: 42 } }) },
  })
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(result.ok, false)
  assert.equal(saved.status, 'stopped')
  assert.equal(saved.runtime.pid, 7)
  assert.equal(saved.runtime.stopped, true)
})

test('successful boot without runtime metadata preserves existing runtime', async (t) => {
  const { file, options } = fixture(t)
  const result = await powerOnSlot({ ...options, ops: { startSlotReady: async () => ({ ok: true }) } })
  assert.equal(result.ok, true)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).runtime.pid, 7)
})

test('power-on preserves a verified memory raise made while boot readiness is pending', async (t) => {
  const { file, options } = fixture(t)
  patchVmRecord(options.projectRoot, options.id, (record) => ({
    machine: { memory: '2g' },
    runtime: { ...record.runtime, memory: '2g' },
  }))
  const ready = Promise.withResolvers()
  const resume = Promise.withResolvers()
  t.after(() => resume.resolve())
  const starting = powerOnSlot({
    ...options,
    ops: {
      startSlotReady: async (vm) => {
        runtimePatch(vm, { running: true, pid: 42, startedAt: 'new' }, { memory: '2g' })
        const runtime = vm.runtime
        ready.resolve()
        await resume.promise
        return { ok: true, runtime }
      },
    },
  })
  await ready.promise
  let bytes = 2 * 1024 ** 3
  const socketPath = path.join(options.projectRoot, 'docker.sock')
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.url.endsWith('/update')) {
      bytes = JSON.parse(Buffer.concat(chunks)).Memory
      return res.end('{"Warnings":null}')
    }
    if (req.url.endsWith('/exec')) return res.writeHead(201).end(JSON.stringify({ Id: 'e'.repeat(64) }))
    if (req.url.endsWith('/start')) {
      const body = Buffer.from(String(bytes))
      const header = Buffer.alloc(8)
      header[0] = 1
      header.writeUInt32BE(body.length, 4)
      return res.end(Buffer.concat([header, body]))
    }
    res.end(
      JSON.stringify(
        req.url.startsWith('/exec/')
          ? { Running: false, ExitCode: 0 }
          : { Id: 'c'.repeat(64), HostConfig: { Memory: bytes, MemorySwap: bytes }, State: { Running: true } },
      ),
    )
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  const raised = await raiseDockerSlotMemory(options.projectRoot, getVm(options.projectRoot, options.id), '4g', {
    connect: localDocker(socketPath),
  })
  assert.equal(raised.ok, true)
  resume.resolve()
  const result = await starting
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(result.ok, true)
  assert.equal(saved.machine.memory, '4g')
  assert.equal(saved.runtime.memory, '4g')
  assert.equal(result.vm.runtime.memory, '4g')
  assert.equal(saved.runtime.pid, 42)
  assert.equal(saved.runtime.stopped, false)
  assert.equal(saved.runtime.started_at, 'new')
})

test('AccountRuntimeRepo.schedulingSnapshot uses PK-indexed subqueries (no COALESCE/json_each) and matches async PG loaders', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-snap-idx-'))
  const db = createDatabase({ dbPath: path.join(dir, 'app.db') })
  t.after(() => {
    try {
      db.close()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const executedSql = []
  const origPrepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    const stmt = origPrepare(sql)
    return new Proxy(stmt, {
      get(target, prop) {
        const val = Reflect.get(target, prop, target)
        if (['get', 'all', 'run'].includes(prop)) {
          return (...args) => {
            executedSql.push(String(sql))
            return val.apply(target, args)
          }
        }
        return typeof val === 'function' ? val.bind(target) : val
      },
    })
  }

  const repo = new AccountRuntimeRepo(db)
  const vmsRepo = new VmsRepo(db)
  const nowIso = '2026-11-28T00:00:00.000Z'

  // Seed: acc-both (accounts + runtime), acc-only (accounts only), rt-only (runtime only)
  origPrepare(
    `INSERT INTO accounts (id, vm_id, email, name, platform, type, status, priority, load_factor, extra, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'claude', 'oauth', 'active', ?, ?, ?, ?, ?)`,
  ).run(
    'acc-both',
    'vm-1',
    'a1@example.com',
    'Acc 1',
    20,
    5,
    JSON.stringify({ unified: { account_tier: 'max' } }),
    nowIso,
    nowIso,
  )
  origPrepare(
    `INSERT INTO accounts (id, vm_id, email, name, platform, type, status, priority, load_factor, extra, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'claude', 'oauth', 'active', ?, ?, ?, ?, ?)`,
  ).run('acc-only', 'vm-2', 'a2@example.com', 'Acc 2', 10, 2, '{}', nowIso, nowIso)

  repo.writeHeartbeat({
    account_id: 'acc-both',
    vm_id: 'vm-1',
    status: 'ready',
    worker_heartbeat_at: 1_700_000_000_000,
    worker_status: { ok: true },
    credential_generation: 4,
    refresh_status: 'fresh',
  })
  repo.writeHeartbeat({
    account_id: 'rt-only',
    vm_id: 'vm-3',
    status: 'ready',
    worker_heartbeat_at: 1_700_000_000_123,
    worker_status: { ok: true },
    credential_generation: 2,
    refresh_status: 'fresh',
  })
  vmsRepo.upsertFromVmJson({
    id: 'vm-1',
    name: 'VM 1',
    status: 'running',
    schedulable: true,
    claude: { account_uuid: 'acc-both', account_tier: 'max', has_access: true },
  })

  executedSql.length = 0
  const single = repo.schedulingSnapshot(['acc-both'])
  const multi = repo.schedulingSnapshot(['acc-both', 'acc-only', 'rt-only', 'acc-both', 'missing'])

  assert.equal(single.size, 1)
  assert.equal(multi.size, 3)
  assert.deepEqual(multi.get('acc-both'), single.get('acc-both'))
  assert.equal(multi.get('acc-both').account.email, 'a1@example.com')
  assert.equal(multi.get('acc-both').state.credential_generation, 4)
  assert.equal(multi.get('acc-only').account.account_id, 'acc-only')
  assert.equal(multi.get('acc-only').state.status, 'unknown')
  assert.equal(multi.get('rt-only').account, null)
  assert.equal(multi.get('rt-only').state.vm_id, 'vm-3')
  assert.equal(multi.has('missing'), false)

  // Every schedulingSnapshot query must avoid COALESCE/json_each full-table scan patterns and omit credentials
  assert.equal(executedSql.length, 2)
  for (const sql of executedSql) {
    assert.equal(/COALESCE\s*\(\s*a\.id/i.test(sql), false, `must not filter on COALESCE(a.id, ...): ${sql}`)
    assert.equal(/json_each/i.test(sql), false, `must not use json_each: ${sql}`)
    assert.equal(/credentials|access_token|refresh_token/i.test(sql), false, `must omit credential columns: ${sql}`)
    assert.match(sql, /FROM accounts WHERE id\b/i)
    assert.match(sql, /FROM account_runtime WHERE account_id\b/i)
    const qCount = (sql.match(/\?/g) || []).length
    const plan = origPrepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(qCount).fill('acc-both'))
    const planText = plan.map((r) => r.detail || '').join('\n')
    assert.equal(
      /SCAN accounts\b|SCAN account_runtime\b/i.test(planText),
      false,
      `unexpected full table scan: ${planText}`,
    )
  }

  // listAllSnapshotsAsync & listAllVmsAsync run directly via async pgPool (0 sync db.prepare calls)
  const rawSnapRows = origPrepare(
    `SELECT a.id, a.vm_id, a.email, a.name, a.platform, a.type,
            a.status, a.schedulable, a.priority, a.rate_multiplier, a.concurrency,
            a.concurrency_override, a.max_rpm, a.rpm_override, a.requests,
            a.tokens_in, a.tokens_out, a.cache_read_tokens, a.cache_creation_tokens,
            a.extra, a.updated_at, a.load_factor, a.last_used_at, a.created_at,
            a.temp_unschedulable_until, a.temp_unschedulable_reason, a.rate_limited_at,
            a.rate_limit_reset_at, a.overload_until, a.session_window_start,
            a.session_window_end, a.session_window_status,
            r.account_id AS rt_account_id, r.vm_id AS rt_vm_id, r.status AS rt_status,
            r.updated_at AS rt_updated_at, r.model_states_json, r.credential_generation,
            r.refresh_status, r.worker_heartbeat_at, r.worker_status_json
     FROM accounts a FULL JOIN account_runtime r ON r.account_id = a.id`,
  ).all()
  const rawVmRows = origPrepare('SELECT * FROM vms ORDER BY id').all()
  const pgQueries = []
  const fakePgPool = {
    async query(sql, params) {
      pgQueries.push({ sql: String(sql), params })
      if (/FROM vms\b/i.test(sql)) return { rows: rawVmRows }
      return { rows: rawSnapRows }
    },
  }

  executedSql.length = 0
  const asyncSnaps = await listAllSnapshotsAsync(fakePgPool)
  const asyncVms = await listAllVmsAsync(fakePgPool)
  assert.equal(executedSql.length, 0, 'async PG loaders must never touch sync db')
  assert.equal(pgQueries.length, 2)
  assert.equal(asyncSnaps.size, 3)
  assert.equal(asyncSnaps.get('acc-both').account.email, 'a1@example.com')
  assert.equal(asyncSnaps.get('acc-both').runtime.credential_generation, 4)
  assert.equal(asyncVms.size, 1)
  assert.equal(asyncVms.get('vm-1').claude.account_tier, 'max')
  assert.equal(/access_token|refresh_token|session_key/i.test(pgQueries[1].sql), false)
})

test('SchedulerRuntime 200-VM hot path: 0 Atomics.wait / 0 N+1 DB calls, shared telemetry snapshot, and async PG UNNEST drain', async () => {
  const vmCount = 200
  const futureCooldown = Date.now() + 3_600_000
  const vms = []
  const pgAccountRows = []
  const pgVmRows = []

  for (let i = 0; i < vmCount; i += 1) {
    const id = `vm-${String(i).padStart(3, '0')}`
    const accountId = `acct-${id}`
    const isMax = i === 0 || i === 1
    const vm = {
      id,
      name: id,
      kind: 'claude',
      status: 'running',
      schedulable: true,
      proxy_cli_enabled: true,
      proxy: { host: '10.0.0.1', port: 1080 },
      claude: {
        account_uuid: accountId,
        account_tier: isMax ? 'max' : 'pro',
        account_tier_source: 'profile',
        has_access: true,
        has_refresh: true,
        expires_at: futureCooldown,
      },
      policy: { priority: isMax ? 10 : 5, weight: 10, max_concurrency: 4, session_slots: 4 },
    }
    vms.push(vm)
    pgVmRows.push({
      id,
      name: id,
      status: 'running',
      schedulable: 1,
      account_uuid: accountId,
      vm_json: JSON.stringify(vm),
      encrypted: 0,
      origin: 'platform',
    })
    pgAccountRows.push({
      id: accountId,
      vm_id: id,
      email: `${id}@example.com`,
      name: id,
      platform: 'claude',
      type: 'oauth',
      status: i === 2 ? 'disabled' : 'active',
      schedulable: 1,
      priority: isMax ? 10 : 5,
      rate_multiplier: 1,
      concurrency: 4,
      concurrency_override: 0,
      max_rpm: 0,
      rpm_override: 0,
      requests: 0,
      tokens_in: 0,
      tokens_out: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      extra: JSON.stringify({
        unified: {
          account_tier: isMax ? 'max' : 'pro',
          account_tier_source: 'profile',
          headers: { '5h': { utilization: i === 3 ? 0.98 : 0.2, reset: futureCooldown, status: 'allowed' } },
        },
      }),
      updated_at: '2026-11-28T00:00:00.000Z',
      load_factor: 10,
      last_used_at: null,
      created_at: '2026-11-28T00:00:00.000Z',
      temp_unschedulable_until: null,
      temp_unschedulable_reason: null,
      rate_limited_at: null,
      rate_limit_reset_at: null,
      overload_until: null,
      session_window_start: null,
      session_window_end: null,
      session_window_status: null,
      rt_account_id: accountId,
      rt_vm_id: id,
      rt_status: 'ready',
      rt_updated_at: '2026-11-28T00:00:00.000Z',
      // Put vm-000 (Max #1) in Fable cooldown so only vm-001 (Max #2) is eligible for Fable!
      model_states_json:
        i === 0
          ? JSON.stringify({ fable: { cooldown_until: futureCooldown, reason: 'fable_credits_required' } })
          : '{}',
      credential_generation: 1,
      refresh_status: 'fresh',
      worker_heartbeat_at: Date.now(),
      worker_status_json: JSON.stringify({ ok: true }),
    })
  }

  const pgQueries = []
  const fakePgPool = {
    async query(sql, params) {
      const text = String(sql)
      pgQueries.push({ sql: text, params })
      if (/FROM vms\b/i.test(text)) return { rows: pgVmRows }
      if (/FROM accounts a FULL JOIN account_runtime/i.test(text)) return { rows: pgAccountRows }
      return { rows: [], rowCount: 1 }
    },
    async connect() {
      return {
        query: (sql, params) => fakePgPool.query(sql, params),
        release() {},
      }
    },
  }

  let syncDbCalls = 0
  const forbidSyncPgDb = {
    engine: 'postgres',
    prepare(sql) {
      syncDbCalls += 1
      throw new Error(`Hot path must NOT invoke sync PgSyncDb.prepare: ${sql}`)
    },
    exec(sql) {
      syncDbCalls += 1
      throw new Error(`Hot path must NOT invoke sync PgSyncDb.exec: ${sql}`)
    },
  }

  const acquiredReqs = []
  const pushedTelemetries = []
  const mockClient = {
    stopped: false,
    isStandby: false,
    role: 'leader',
    controllerEpoch: 'epoch-1',
    async acquire(req) {
      acquiredReqs.push(req)
      return { ok: true, lease_id: `lease-${acquiredReqs.length}`, selected_node: { node_key: 'claude_vm:vm-001' } }
    },
    async pushTelemetry(batch) {
      pushedTelemetries.push(batch)
      return { ok: true, updated: batch.length }
    },
    async drainAll({ onDrain }) {
      await onDrain({
        sticky_upserts: [
          {
            scope_kind: 'session',
            pool_id: VIRTUAL_POOL_IDS.claude,
            model_family: 'claude',
            identity_id: 'sess-1',
            node_type: 'claude_vm',
            node_id: 'vm-000',
            bound_at_ms: 1000,
            last_seen_ms: 1000,
            expires_at_ms: 9000,
            hits: 1,
            generation: 1,
          },
          // Duplicate PK in same batch tests deduplication before PG UNNEST ON CONFLICT
          {
            scope_kind: 'session',
            pool_id: VIRTUAL_POOL_IDS.claude,
            model_family: 'claude',
            identity_id: 'sess-1',
            node_type: 'claude_vm',
            node_id: 'vm-001',
            bound_at_ms: 1000,
            last_seen_ms: 2000,
            expires_at_ms: 9999,
            hits: 2,
            generation: 2,
          },
        ],
        sticky_deletes: [
          { scope_kind: 'session', pool_id: VIRTUAL_POOL_IDS.claude, model_family: 'claude', identity_id: 'sess-old' },
        ],
        penalty_upserts: [
          {
            node_type: 'claude_vm',
            node_id: 'vm-002',
            model_scope: '*',
            reason: 'rate_limit',
            cooldown_until_ms: 5000,
            ladder_step: 1,
          },
        ],
        penalty_deletes: [{ node_key: 'claude_vm:vm-003', model_scope: '*' }],
      })
      return { batches: 1, remaining: 0 }
    },
  }

  const snapCache = new SchedulerSnapshotCache(null, { freshTtlMs: 2_000, staleTtlMs: 10_000 })
  const runtime = createSchedulerRuntime({
    cfg: { paths: { project: '/nonexistent-test-root' } },
    client: mockClient,
    getDb: () => forbidSyncPgDb,
    pgPool: fakePgPool,
    schedulerCache: snapCache,
    getVms: () => vms,
    getRoutingConfig: () => ({
      pool: { fable_requires_max: true },
      quota: { exhaustion_guard: true, exhaustion_guard_new_session: 0.85, exhaustion_guard_stop: 0.95 },
    }),
    accountQuota: {
      runtimeRepo: {
        db: forbidSyncPgDb,
        schedulingSnapshot() {
          throw new Error('Must NOT call sync runtimeRepo.schedulingSnapshot in 200-VM loop')
        },
      },
      repo: {
        get() {
          throw new Error('Must NOT call sync accountQuota.repo.get in 200-VM loop')
        },
      },
    },
    telemetryIntervalMs: 0,
  })

  // Build config snapshot (no DB pools query needed; swallow safe fallback if getDb throws)
  runtime.buildConfigSnapshot({ configVersion: 1 })
  syncDbCalls = 0
  pgQueries.length = 0

  // 1. Run 10 acquireNode calls across 200 VMs -> only 1 cold async PG snapshot load (2 queries), then 0 DB queries!
  for (let i = 0; i < 10; i += 1) {
    await runtime.acquireNode({
      originPoolId: VIRTUAL_POOL_IDS.claude,
      apiKeyKind: 'master',
      model: i % 2 === 0 ? 'claude-fable-5' : 'claude-sonnet-4-6',
      protocol: 'anthropic',
      nodeTypes: ['claude_vm'],
      sessionId: `sess-${i}`,
    })
  }
  assert.equal(syncDbCalls, 0, 'steady-state acquireNode must execute 0 sync PgSyncDb Atomics.wait calls')
  assert.equal(
    pgQueries.length,
    2,
    '10 requests across 200 VMs must trigger only 1 cold async snapshot load (accounts+vms)',
  )
  // Fable requests must exclude all 198 Pro VMs AND vm-000 (fable cooldown), leaving ONLY vm-001!
  assert.deepEqual(acquiredReqs[0].api_key_scope.allowed_node_keys, ['claude_vm:vm-001'])
  // Sonnet requests allow all 200 VMs (compact [] representation)
  assert.deepEqual(acquiredReqs[1].api_key_scope.allowed_node_keys, [])

  // 2. pushTelemetryNow reuses warm L1 snapshot with 0 sync DB calls and evaluates account_disabled & quota_guard_stop!
  await runtime.pushTelemetryNow()
  assert.equal(syncDbCalls, 0, 'pushTelemetryNow must execute 0 sync PgSyncDb calls')
  assert.equal(pgQueries.length, 2, 'pushTelemetryNow reuses fresh L1 snapshot with 0 extra PG queries')
  const teleByKey = new Map(pushedTelemetries[0].map((u) => [u.node_key, u]))
  assert.equal(teleByKey.get('claude_vm:vm-002').schedulable, false)
  assert.equal(teleByKey.get('claude_vm:vm-002').unschedulable_reason, 'account_disabled')
  assert.equal(teleByKey.get('claude_vm:vm-003').schedulable, false)
  assert.equal(teleByKey.get('claude_vm:vm-003').unschedulable_reason, 'quota_guard_stop')

  // 3. drainPersistenceNow executes batched UNNEST queries asynchronously on pgPool with 0 sync DB calls
  pgQueries.length = 0
  await runtime.drainPersistenceNow()
  assert.equal(syncDbCalls, 0, 'PG drain must execute 0 sync PgSyncDb calls')
  const drainSqls = pgQueries.map((q) => q.sql)
  assert.equal(drainSqls[0], 'BEGIN')
  assert.equal(drainSqls.at(-1), 'COMMIT')
  const stickyUpsertCall = pgQueries.find((q) => /INSERT INTO scheduler_sticky_bindings[\s\S]*UNNEST/i.test(q.sql))
  assert.ok(stickyUpsertCall, 'sticky_upserts must use PG UNNEST batch')
  // Duplicate PK (sess-1) deduplicated to 1 row keeping the last write (vm-001, generation 2)
  assert.deepEqual(stickyUpsertCall.params[5], ['vm-001'])
  assert.deepEqual(stickyUpsertCall.params[12], [2])
  assert.ok(pgQueries.some((q) => /DELETE FROM scheduler_sticky_bindings[\s\S]*UNNEST/i.test(q.sql)))
  assert.ok(pgQueries.some((q) => /INSERT INTO scheduler_node_penalties[\s\S]*UNNEST/i.test(q.sql)))
  assert.ok(pgQueries.some((q) => /DELETE FROM scheduler_node_penalties[\s\S]*UNNEST/i.test(q.sql)))
})

test('SchedulerRuntime caches empty/live api_endpoints and gemini_environment_owners with PG async load and write invalidation', async (t) => {
  await closeCacheRuntime()
  const cacheRt = await initCacheRuntime({ redisConfig: null })
  t.after(async () => {
    await closeCacheRuntime()
  })

  const pgQueries = []
  let pgEndpointRows = []
  let pgGeminiOwnerRows = []
  const mockPgPool = {
    async query(sql, params) {
      const text = String(sql)
      pgQueries.push({ sql: text, params })
      if (/FROM api_endpoints\b/i.test(text)) return { rows: pgEndpointRows }
      if (/FROM api_endpoint_keys\b/i.test(text)) {
        return {
          rows: [
            {
              id: 'ek-1',
              endpoint_id: 'ep-1',
              proxy_url: '',
              proxy_id: '',
              disabled: 0,
              cooldown_until: null,
              created_at: '2026-11-28T00:00:00.000Z',
            },
          ],
        }
      }
      if (/FROM api_endpoint_models\b/i.test(text)) return { rows: [] }
      if (/FROM gemini_environment_owners\b/i.test(text)) return { rows: pgGeminiOwnerRows }
      if (/FROM accounts a FULL JOIN account_runtime/i.test(text)) return { rows: [] }
      if (/FROM vms\b/i.test(text)) return { rows: [] }
      return { rows: [] }
    },
  }

  let syncAuxCalls = 0
  let syncDbPrepareCalls = 0
  const forbidSyncDb = {
    engine: 'postgres',
    prepare(sql) {
      syncDbPrepareCalls += 1
      throw new Error(`Must NOT run sync PgSyncDb.prepare on aux hot path: ${sql}`)
    },
  }

  const syncedConfigs = []
  const pushedTelemetries = []
  const mockClient = {
    stopped: false,
    isStandby: false,
    role: 'leader',
    controllerEpoch: 'epoch-aux',
    async syncConfig(payload) {
      syncedConfigs.push(payload)
      return { ok: true, applied: true, config_version: payload.config_version }
    },
    async pushTelemetry(batch) {
      pushedTelemetries.push(batch)
      return { ok: true, updated: batch.length }
    },
  }

  const snapCache = new SchedulerSnapshotCache(null, { freshTtlMs: 10_000, staleTtlMs: 30_000 })
  const runtime = createSchedulerRuntime({
    cfg: { paths: { project: '/nonexistent-aux-root' } },
    client: mockClient,
    getDb: () => forbidSyncDb,
    pgPool: mockPgPool,
    schedulerCache: snapCache,
    auxCacheTtlMs: 10_000,
    getVms: () => [],
    apiEndpointStore: {
      db: forbidSyncDb,
      listRaw() {
        syncAuxCalls += 1
        throw new Error('PG pushTelemetryNow/syncConfigNow must NOT call sync apiEndpointStore.listRaw')
      },
    },
    geminiOwnersRepo: {
      db: forbidSyncDb,
      ownerMap() {
        syncAuxCalls += 1
        throw new Error('PG syncConfigNow must NOT call sync geminiOwnersRepo.ownerMap')
      },
    },
    geminiScheduler: {
      listEnvironments: () => [{ id: 'gem-1', enabled: true, healthy: true, schedulable: true }],
    },
    telemetryIntervalMs: 0,
  })
  t.after(() => runtime.shutdown({ drain: false, stopProcess: false }))

  // 1. 5 consecutive pushTelemetryNow() calls on empty api_endpoints -> only 1 async PG query, 0 sync calls, 0 child table queries!
  for (let i = 0; i < 5; i += 1) {
    await runtime.pushTelemetryNow()
  }
  assert.equal(syncAuxCalls, 0)
  assert.equal(syncDbPrepareCalls, 0, 'pushTelemetryNow must execute 0 sync PgSyncDb.prepare calls')
  assert.equal(
    pgQueries.filter((q) => /FROM api_endpoints\b/i.test(q.sql)).length,
    1,
    '5 telemetry ticks within 10s TTL must hit api_endpoints at most once',
  )
  assert.equal(
    pgQueries.filter((q) => /FROM api_endpoint_(keys|models)\b/i.test(q.sql)).length,
    0,
    'empty api_endpoints must skip api_endpoint_keys and api_endpoint_models queries',
  )

  // 2. syncConfigNow() loads gemini_environment_owners asynchronously via pgPool (0 sync calls) and caches it
  pgGeminiOwnerRows = [{ env_id: 'gem-1', owner_user_id: 'tenant-42' }]
  await runtime.syncConfigNow('bootstrap_refresh')
  await runtime.syncConfigNow('bootstrap_refresh')
  assert.equal(syncAuxCalls, 0)
  assert.equal(
    pgQueries.filter((q) => /FROM gemini_environment_owners\b/i.test(q.sql)).length,
    1,
    'repeated non-mutating syncConfigNow within 10s TTL must reuse L1 gemini_environment_owners cache',
  )
  const gemNode = syncedConfigs.at(-1).config_snapshot.nodes.find((n) => n.node_key === 'gemini_env:gem-1')
  assert.equal(gemNode?.owner_id, 'tenant-42')

  // 3. Invalidation (via invalidateAllCaches / cache prefix) refreshes newly inserted endpoint without exposing api_key
  pgEndpointRows = [
    {
      id: 'ep-1',
      name: 'EP 1',
      disabled: 0,
      prefix: '',
      base_url: 'https://example.invalid',
      headers_json: '{}',
      disable_cooling: 0,
      priority: 5,
      kind: 'claude',
      protocol: 'anthropic',
      risk_review_enabled: 0,
      body_policy: 'caller',
      owner_user_id: null,
      created_at: '2026-11-28T00:00:00.000Z',
      updated_at: '2026-11-28T00:00:00.000Z',
    },
  ]
  await invalidateAllCaches({ broadcast: false })
  await runtime.pushTelemetryNow()
  assert.equal(
    pgQueries.filter((q) => /FROM api_endpoints\b/i.test(q.sql)).length,
    2,
    'invalidateAllCaches must force refresh on next telemetry tick',
  )
  const keysQuery = pgQueries.find((q) => /FROM api_endpoint_keys\b/i.test(q.sql))
  assert.ok(keysQuery)
  assert.equal(/\bapi_key\b/i.test(keysQuery.sql), false, 'scheduler aux cache must never select raw api_key secret')
  const epTele = pushedTelemetries.at(-1).find((u) => u.node_key === 'api_endpoint:ep-1')
  assert.equal(epTele?.schedulable, true)

  // Verify cache.client invalidation event also clears aux cache
  pgGeminiOwnerRows = [{ env_id: 'gem-1', owner_user_id: 'tenant-99' }]
  await cacheRt.client.invalidate({ prefixes: ['sched:aux:'], broadcast: false })
  await runtime.syncConfigNow('bootstrap_refresh')
  const gemNode2 = syncedConfigs.at(-1).config_snapshot.nodes.find((n) => n.node_key === 'gemini_env:gem-1')
  assert.equal(gemNode2?.owner_id, 'tenant-99')
})
