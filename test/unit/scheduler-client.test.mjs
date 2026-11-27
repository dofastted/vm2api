import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  computeAcquireTimeoutMs,
  computeSwitchTimeoutMs,
  createSchedulerClient,
  DEFAULT_RECONNECT_WINDOW_MS,
  ensureSchedulerToken,
  SchedulerApiError,
  SchedulerClient,
  SchedulerUnavailableError,
  schedulerPaths,
} from '../../src/lib/transport/scheduler-client.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')

function makeTempDir(prefix = 'vm2api-sched-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function startMockServer({ socketPath = null, host = '127.0.0.1', port = 0, handler }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'internal_error', message: err.message } }))
        }
      })
    })
    server.once('error', reject)
    if (socketPath) {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true })
      try {
        fs.rmSync(socketPath, { force: true })
      } catch {}
      server.listen(socketPath, () => {
        resolve({
          server,
          socketPath,
          close: () =>
            new Promise((done) => {
              server.closeAllConnections?.()
              server.close(() => done())
            }),
        })
      })
    } else {
      server.listen(port, host, () => {
        const addr = server.address()
        resolve({
          server,
          host: addr.address,
          port: addr.port,
          close: () =>
            new Promise((done) => {
              server.closeAllConnections?.()
              server.close(() => done())
            }),
        })
      })
    }
  })
}

function resolveRealSchedulerBin() {
  const candidates = [
    process.env.KIN_SCHEDULER_BIN,
    path.join(REPO_ROOT, 'bin', process.platform === 'win32' ? 'kin-scheduler.exe' : 'kin-scheduler'),
    '/tmp/vm2api-sched-target/release/kin-scheduler',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function makeSampleSnapshot(configVersion = 1, poolOverrides = {}) {
  return {
    config_version: configVersion,
    global_prompt_policy: {
      mode: 'official',
      preset: 'official_full',
      text: '',
      client_system_policy: 'prepend_pool',
    },
    trusted_downgrade_pool_ids: [],
    pools: [
      {
        id: 'pool_alpha',
        slug: 'alpha',
        name: 'Alpha Pool',
        enabled: true,
        exclusive_members: false,
        provider_scope: 'anthropic',
        plan_tags: [],
        pool_role: 'primary',
        sort_order: 0,
        fallback_pool_id: null,
        allow_cross_prompt_fallback: false,
        intra_tier_strategy: 'least_inflight_swrr',
        session_queue_max: 16,
        session_queue_timeout_ms: 5_000,
        queue_wait_ms: 1_000,
        queue_max: 50,
        machine_sticky_enabled: true,
        machine_ttl_seconds: 604_800,
        session_sticky_enabled: true,
        session_ttl_seconds: 86_400,
        session_busy_wait_ms: 0,
        session_overflow_policy: 'spill_immediately',
        system_prompt_mode: 'zero_inject',
        system_prompt_preset: 'official_full',
        system_prompt_text: '',
        client_system_policy: 'prepend_pool',
        jev_profile: 'inherit_global',
        members: [
          {
            node_key: 'claude_vm:vm-1',
            node_type: 'claude_vm',
            node_id: 'vm-1',
            enabled: true,
            member_role: 'active',
            weight_tier_override: 9,
            sub_weight_override: 10,
            member_order: 0,
          },
          {
            node_key: 'claude_vm:vm-2',
            node_type: 'claude_vm',
            node_id: 'vm-2',
            enabled: true,
            member_role: 'active',
            weight_tier_override: 8,
            sub_weight_override: 10,
            member_order: 1,
          },
        ],
        ...poolOverrides,
      },
    ],
    nodes: [
      {
        node_key: 'claude_vm:vm-1',
        node_type: 'claude_vm',
        node_id: 'vm-1',
        provider: 'anthropic',
        protocol: 'anthropic',
        weight_tier_mode: 'manual',
        weight_tier: 9,
        sub_weight: 10,
        supported_models: [],
        capacity: { max_concurrency: 2, max_sessions: 4 },
        enabled: true,
      },
      {
        node_key: 'claude_vm:vm-2',
        node_type: 'claude_vm',
        node_id: 'vm-2',
        provider: 'anthropic',
        protocol: 'anthropic',
        weight_tier_mode: 'manual',
        weight_tier: 8,
        sub_weight: 10,
        supported_models: [],
        capacity: { max_concurrency: 2, max_sessions: 4 },
        enabled: true,
      },
    ],
  }
}

function makeAcquireRequest(overrides = {}) {
  return {
    request_id: `req_${Math.random().toString(16).slice(2, 10)}`,
    attempt_no: 1,
    min_config_version: 1,
    origin_pool_id: 'pool_alpha',
    api_key_scope: {
      api_key_id: 'key_1',
      pool_binding_mode: 'strict_pool',
      default_pool_id: 'pool_alpha',
      allowed_pool_ids: ['pool_alpha'],
      allowed_models: [],
      strict_tenant_only: false,
      allowed_node_keys: [],
    },
    model: 'claude-sonnet-4-5',
    model_family: 'claude',
    protocol: 'anthropic',
    machine_id: 'mach_0001',
    session_id: '11111111-1111-4111-8111-111111111111',
    session_id_source: 'caller',
    is_ephemeral_probe: false,
    no_queue: false,
    is_admin_diagnostic: false,
    exclude_nodes: [],
    ...overrides,
  }
}

function rawUnixPost(socketPath, endpointPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body))
    const req = http.request(
      {
        socketPath,
        path: endpointPath,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.length),
          'x-kin-internal-token': token,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode, body: JSON.parse(text) })
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// ============================================================================
// Suite A: Unit, Contract, D4 Hygiene & Packaging Tests
// ============================================================================

test('schedulerPaths resolves UDS/TCP, blue/green color suffix, and 0600 token permissions', (t) => {
  const tmpDir = makeTempDir()
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const uds = schedulerPaths({ paths: { project: tmpDir, data: path.join(tmpDir, 'data') } }, { transport: 'uds' })
  assert.equal(uds.transport, 'uds')
  assert.equal(uds.socketPath, path.join(tmpDir, 'data', 'run', 'scheduler.sock'))
  assert.equal(uds.tokenPath, path.join(tmpDir, 'data', 'run', 'scheduler.token'))

  const bg = schedulerPaths(
    { paths: { project: tmpDir, data: path.join(tmpDir, 'data') } },
    { transport: 'uds', color: 'green' },
  )
  assert.equal(bg.socketPath, path.join(tmpDir, 'data', 'run', 'scheduler-green.sock'))
  assert.equal(bg.tokenPath, path.join(tmpDir, 'data', 'run', 'scheduler-green.token'))

  const tcp = schedulerPaths(
    { paths: { project: tmpDir, data: path.join(tmpDir, 'data') } },
    { listenAddr: '127.0.0.1:0' },
  )
  assert.equal(tcp.transport, 'tcp')
  assert.equal(tcp.host, '127.0.0.1')
  assert.equal(tcp.port, 0)
  assert.equal(tcp.socketPath, null)

  const tok1 = ensureSchedulerToken(uds.tokenPath)
  assert.equal(tok1.length, 64)
  assert.equal(ensureSchedulerToken(uds.tokenPath), tok1)
  if (process.platform !== 'win32') {
    const mode = fs.statSync(uds.tokenPath).mode & 0o777
    // WSL DrvFS ignores chmod (0777), native Linux/tmpfs enforces 0600.
    assert.ok(mode === 0o600 || mode === 0o777, `unexpected token mode: ${mode.toString(8)}`)
  }
})

test('D4 strict replacement hygiene: zero legacy fallback/shadow identifiers in scheduler-client.mjs', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src/lib/transport/scheduler-client.mjs'), 'utf8')
  for (const forbidden of [
    'KIN_SCHEDULER_FAIL_MODE',
    'fallback_node',
    'KIN_SCHEDULER_MODE',
    'KIN_SCHEDULER_RUST_POOLS',
    'scheduler_shadow_diff_total',
  ]) {
    assert.equal(src.includes(forbidden), false, `forbidden D4 identifier found: ${forbidden}`)
  }

  const err = new SchedulerUnavailableError('sidecar unreachable')
  assert.equal(err.status, 503)
  assert.equal(err.code, 'scheduler_unavailable')
  assert.equal(err.retryAfterSec, 1)
  assert.deepEqual(err.toHttpError(), {
    status: 503,
    retryAfterSec: 1,
    headers: { 'retry-after': '1' },
    body: {
      type: 'error',
      error: {
        type: 'api_error',
        code: 'scheduler_unavailable',
        message: 'sidecar unreachable',
      },
    },
  })
})

test('computeAcquireTimeoutMs and computeSwitchTimeoutMs enforce dynamic queueing budgets', () => {
  assert.equal(computeAcquireTimeoutMs({ session_queue_timeout_ms: 60_000, queue_wait_ms: 15_000 }), 77_000)
  assert.equal(computeAcquireTimeoutMs({ sessionQueueTimeoutMs: 5_000, queueWaitMs: 2_000 }), 9_000)
  assert.equal(
    computeAcquireTimeoutMs({ sessionQueueTimeoutMs: 5_000, sessionBusyWaitMs: 3_000, queueWaitMs: 1_000 }),
    10_000,
  )
  assert.equal(computeAcquireTimeoutMs({ no_queue: true, sessionQueueTimeoutMs: 60_000 }), 2_000)
  assert.equal(computeAcquireTimeoutMs({ timeoutMs: 450 }), 450)
  assert.equal(computeSwitchTimeoutMs({ queueWaitMs: 15_000 }), 17_000)
  assert.equal(computeSwitchTimeoutMs({ no_queue: true }), 2_000)
})

test('Dockerfiles, entrypoint, and CI workflow wire native kin-scheduler build and conditional Rust CI', () => {
  const pinnedDigest = 'rust:1.86-bookworm@sha256:300ec56abce8cc9448ddea2172747d048ed902a3090e6b57babb2bf19f754081'
  const amd64Dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8')
  assert.match(amd64Dockerfile, new RegExp(pinnedDigest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(amd64Dockerfile, /FROM --platform=linux\/amd64 \$\{RUST_IMAGE\} AS scheduler/)
  assert.match(amd64Dockerfile, /COPY --from=scheduler \/out\/kin-scheduler \/opt\/vm2api\/image-bin\/kin-scheduler/)
  assert.match(amd64Dockerfile, /KIN_SCHEDULER_BIN=\/opt\/vm2api\/bin\/kin-scheduler/)

  const arm64Dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'deploy/Dockerfile.arm64-control'), 'utf8')
  assert.match(arm64Dockerfile, new RegExp(pinnedDigest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(arm64Dockerfile, /FROM --platform=linux\/arm64 \$\{RUST_IMAGE\} AS scheduler/)
  assert.match(arm64Dockerfile, /COPY --from=scheduler \/out\/kin-scheduler \/opt\/vm2api\/image-bin\/kin-scheduler/)
  assert.match(arm64Dockerfile, /KIN_SCHEDULER_BIN=\/opt\/vm2api\/bin\/kin-scheduler/)

  const entrypoint = fs.readFileSync(path.join(REPO_ROOT, 'scripts/docker-entrypoint.sh'), 'utf8')
  assert.match(entrypoint, /ensure_bin kin-scheduler/)
  assert.match(entrypoint, /KIN_SCHEDULER_BIN/)

  const ciYml = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8')
  assert.match(ciYml, /rust_scheduler:/)
  assert.match(ciYml, /'scheduler\/\*\*'/)
  assert.match(ciYml, /dtolnay\/rust-toolchain@1\.86\.0/)
  assert.match(ciYml, /RUSTUP_TOOLCHAIN:\s*'1\.86\.0'/)
  assert.match(ciYml, /cargo fmt --check/)
  assert.match(ciYml, /cargo clippy --workspace --all-targets -- -D warnings/)
  assert.match(ciYml, /cargo test --workspace --locked/)
})

test('mock UDS contract: all 14 endpoints, batch heartbeat, throttled telemetry, drain ACK, SSE & standby guard', async (t) => {
  const tmpDir = makeTempDir()
  const socketPath = path.join(tmpDir, 'run', 'scheduler.sock')
  const token = 'test-internal-token-0123456789abcdef'
  const seen = []
  let drainCalls = 0
  let drainAcked = false
  let heartbeatBatches = []
  let telemetryBatches = []

  const mock = await startMockServer({
    socketPath,
    handler: async (req, res) => {
      if (req.headers['x-kin-internal-token'] !== token) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'invalid token' } }))
        return
      }
      const url = new URL(req.url, 'http://localhost')
      seen.push(`${req.method} ${url.pathname}${url.search}`)

      if (req.method === 'GET' && url.pathname === '/internal/v1/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            bootstrapped: true,
            role: 'leader',
            config_version: 2,
            epoch: 'ep-1',
            active_leases: 0,
            active_session_gates: 0,
            dirty_deltas: 0,
            uptime_ms: 42,
          }),
        )
        return
      }

      if (req.method === 'GET' && url.pathname === '/internal/v1/events') {
        const after = url.searchParams.get('after')
        if (after === 'stale:0') {
          res.writeHead(409, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              error: {
                code: 'snapshot_required',
                message: 'cursor out of window',
                current_epoch: 'ep-1',
                oldest_seq: 10,
                latest_seq: 20,
              },
            }),
          )
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(': heartbeat\n\n')
        res.write(
          'id: ep-1:1\nevent: lease_acquired\ndata: {"cursor":"ep-1:1","epoch":"ep-1","seq":1,"kind":"lease_acquired"}\n\n',
        )
        res.write(
          'id: ep-1:2\nevent: lease_released\ndata: {"cursor":"ep-1:2","epoch":"ep-1","seq":2,"kind":"lease_released"}\n\n',
        )
        res.end()
        return
      }

      if (req.method === 'GET' && url.pathname === '/internal/v1/sticky') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, bindings: [{ pool_id: url.searchParams.get('pool_id') }], total: 1 }))
        return
      }

      const body = await readJsonBody(req)
      const json = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(obj))
      }

      switch (`${req.method} ${url.pathname}`) {
        case 'POST /internal/v1/bootstrap':
          return json(200, {
            ok: true,
            bootstrapped: true,
            role: body.role,
            epoch: body.controller_epoch,
            config_version: 1,
          })
        case 'POST /internal/v1/config/sync':
          return json(200, { ok: true, applied: true, config_version: body.config_version })
        case 'POST /internal/v1/nodes/telemetry':
          telemetryBatches.push(body.nodes)
          return json(200, { ok: true, updated: body.nodes.length })
        case 'POST /internal/v1/schedule/acquire':
          return json(200, {
            lease_id: `lease_${body.request_id}`,
            lease_ttl_ms: 120_000,
            selected_node: {
              node_key: 'claude_vm:vm-1',
              node_type: 'claude_vm',
              node_id: 'vm-1',
              provider: 'anthropic',
            },
            resolved_pool_id: body.origin_pool_id,
            prompt_policy: { mode: 'zero_inject', source: 'pool' },
            stood_in: false,
            preserve_machine_home: false,
            session_gate_wait_ms: 0,
            explain: { request_id: body.request_id },
          })
        case 'POST /internal/v1/schedule/switch':
          return json(200, {
            lease_id: `lease_switched_${body.next_attempt.request_id}`,
            lease_ttl_ms: 120_000,
            selected_node: {
              node_key: 'claude_vm:vm-2',
              node_type: 'claude_vm',
              node_id: 'vm-2',
              provider: 'anthropic',
            },
            resolved_pool_id: body.next_attempt.origin_pool_id,
            prompt_policy: { mode: 'zero_inject', source: 'pool' },
            stood_in: false,
            preserve_machine_home: false,
            session_gate_wait_ms: 0,
            explain: { request_id: body.next_attempt.request_id },
          })
        case 'POST /internal/v1/schedule/heartbeat':
          heartbeatBatches.push(body)
          return json(200, {
            ok: true,
            renewed: body.lease_ids.filter((id) => id !== 'lease_missing').length,
            missing: body.lease_ids.filter((id) => id === 'lease_missing'),
          })
        case 'POST /internal/v1/schedule/commit':
          return json(200, { ok: true, committed: true, already_committed: false, lease_found: true })
        case 'POST /internal/v1/schedule/release':
          return json(200, { ok: true, released: true })
        case 'POST /internal/v1/schedule/explain':
          return json(200, { ok: true, selected_node: { node_key: 'claude_vm:vm-1' }, explain: { dry_run: true } })
        case 'POST /internal/v1/persistence/drain':
          drainCalls += 1
          if (body.ack_only && body.ack_batch_id === 7) {
            drainAcked = true
            return json(200, {
              ok: true,
              sticky_upserts: [],
              sticky_deletes: [],
              penalty_upserts: [],
              penalty_deletes: [],
              remaining: 0,
            })
          }
          if (drainAcked) {
            return json(200, {
              ok: true,
              sticky_upserts: [],
              sticky_deletes: [],
              penalty_upserts: [],
              penalty_deletes: [],
              remaining: 0,
            })
          }
          return json(200, {
            ok: true,
            batch_id: 7,
            sticky_upserts: [{ scope_kind: 'session', pool_id: 'pool_alpha', identity_id: 's1' }],
            sticky_deletes: [],
            penalty_upserts: [],
            penalty_deletes: [],
            remaining: 0,
          })
        case 'DELETE /internal/v1/sticky':
          return json(200, { ok: true, deleted: 1 })
        case 'POST /internal/v1/admin/unrest':
          return json(200, { ok: true, node_key: body.node_key, cleared_cooldowns: 1, sink_cleared: true })
        default:
          return json(404, { error: { code: 'not_found', message: 'unknown route' } })
      }
    },
  })

  const client = createSchedulerClient({
    socketPath,
    token,
    manageProcess: false,
    telemetryThrottleMs: 30,
    heartbeatIntervalMs: 60,
  })

  t.after(async () => {
    await client.shutdown({ drain: false, stopProcess: false })
    await mock.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // 1-4: health, bootstrap, syncConfig, pushTelemetry
  assert.equal((await client.health()).ok, true)
  await assert.rejects(
    () => client.health({ tokenOverride: 'bad-token' }),
    (err) => err instanceof SchedulerApiError && err.status === 401 && err.code === 'unauthorized',
  )
  assert.equal((await client.bootstrap({ config_snapshot: makeSampleSnapshot(1) })).bootstrapped, true)
  assert.equal((await client.syncConfig({ config_version: 2, config_snapshot: makeSampleSnapshot(2) })).applied, true)
  assert.equal((await client.pushTelemetry([{ node_key: 'claude_vm:vm-1', schedulable: true }])).updated, 1)

  // Throttled telemetry coalescing: 3 rapid updates on 2 nodes -> 1 batched POST with latest state
  telemetryBatches = []
  client.enqueueTelemetry({ node_key: 'claude_vm:vm-1', quota_util_5h_pct: 40 })
  client.enqueueTelemetry({ node_key: 'claude_vm:vm-2', proxy_ready: true })
  client.enqueueTelemetry({ node_key: 'claude_vm:vm-1', quota_util_5h_pct: 88 })
  await new Promise((r) => setTimeout(r, 70))
  assert.equal(telemetryBatches.length, 1)
  assert.equal(telemetryBatches[0].length, 2)
  assert.equal(telemetryBatches[0].find((n) => n.node_key === 'claude_vm:vm-1').quota_util_5h_pct, 88)

  // 5-10: acquire, switchLease, heartbeat loop, commit, release, explain
  const acq = await client.acquire(makeAcquireRequest({ request_id: 'r1' }))
  assert.equal(acq.lease_id, 'lease_r1')
  assert.equal(client.activeLeaseCount, 1)

  const sw = await client.switchLease({
    release_lease_id: acq.lease_id,
    failure: { http_status: 529, error_class: 'overloaded529' },
    next_attempt: makeAcquireRequest({ request_id: 'r1', attempt_no: 2, exclude_nodes: ['claude_vm:vm-1'] }),
  })
  assert.equal(sw.lease_id, 'lease_switched_r1')
  assert.equal(client.activeLeaseCount, 1)

  // Track an extra missing lease to verify auto-untrack on heartbeat response
  client.trackLease('lease_missing')
  assert.equal(client.activeLeaseCount, 2)
  const hb = await client.flushHeartbeat()
  assert.equal(hb.renewed, 1)
  assert.deepEqual(hb.missing, ['lease_missing'])
  assert.equal(client.activeLeaseCount, 1)

  assert.equal((await client.commit(sw.lease_id)).committed, true)
  assert.equal((await client.release(sw.lease_id, 'ok')).released, true)
  assert.equal(client.activeLeaseCount, 0)
  assert.equal((await client.explain(makeAcquireRequest({ request_id: 'r_explain' }))).ok, true)

  // 11: drainPersistence with retry-on-DB-failure (no ACK on error, ACK on success)
  await assert.rejects(() =>
    client.runDrainTick({
      onDrain: async () => {
        throw new Error('simulated pg jitter')
      },
    }),
  )
  assert.equal(drainAcked, false)
  const drainedBatches = []
  const drainRes = await client.runDrainTick({
    onDrain: async (batch) => {
      drainedBatches.push(batch)
    },
  })
  assert.equal(drainRes.drained, true)
  assert.equal(drainAcked, true)
  assert.equal(drainedBatches.length, 1)
  assert.equal(drainedBatches[0].batch_id, 7)

  // 12-13: querySticky, deleteSticky, unrestNode
  assert.equal((await client.querySticky({ pool_id: 'pool_alpha' })).total, 1)
  assert.equal((await client.deleteSticky({ pool_id: 'pool_alpha' })).deleted, 1)
  assert.equal((await client.unrestNode('claude_vm:vm-1')).sink_cleared, true)

  // 14: subscribeEvents SSE stream + 409 snapshot_required
  const events = []
  const sub = client.subscribeEvents({ after: 'ep-1:0' })
  await sub.ready
  for await (const ev of sub) {
    events.push(ev)
  }
  assert.equal(events.length, 2)
  assert.equal(events[0].id, 'ep-1:1')
  assert.equal(events[0].event, 'lease_acquired')
  assert.equal(events[1].data.seq, 2)
  assert.equal(sub.lastCursor, 'ep-1:2')

  const staleSub = client.subscribeEvents({ after: 'stale:0' })
  await assert.rejects(
    () => staleSub.ready,
    (err) =>
      err instanceof SchedulerApiError &&
      err.status === 409 &&
      err.code === 'snapshot_required' &&
      err.currentEpoch === 'ep-1' &&
      err.oldestSeq === 10 &&
      err.latestSeq === 20,
  )

  // Standby strictly forbids /persistence/drain without touching network
  const standbyClient = createSchedulerClient({
    socketPath,
    token,
    manageProcess: false,
    isStandby: true,
  })
  t.after(() => standbyClient.shutdown({ drain: false, stopProcess: false }))
  const callsBefore = drainCalls
  await assert.rejects(
    () => standbyClient.drainPersistence(),
    (err) => err instanceof SchedulerApiError && err.status === 403 && err.code === 'standby_drain_forbidden',
  )
  assert.equal(standbyClient.startDrainLoop({ onDrain: () => {} }), false)
  assert.equal(drainCalls, callsBefore, 'standby must never call /persistence/drain over IPC')
})

test('mock TCP + cap-file discovery, AbortSignal immediate cancel, transient reconnect, and fail-closed 503', async (t) => {
  const tmpDir = makeTempDir()
  const capFile = path.join(tmpDir, 'run', 'scheduler.cap.json')
  const token = 'tcp-token-abcdef0123456789'
  let serverAborted = false
  let acquireHits = 0

  const tcpMock = await startMockServer({
    host: '127.0.0.1',
    port: 0,
    handler: async (req, res) => {
      if (req.url === '/internal/v1/schedule/acquire') {
        acquireHits += 1
        const body = await readJsonBody(req)
        if (body.request_id === 'hang_forever') {
          res.on('close', () => {
            if (!res.writableEnded) serverAborted = true
          })
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            lease_id: 'tcp_lease_1',
            lease_ttl_ms: 120_000,
            selected_node: { node_key: 'claude_vm:vm-1' },
            resolved_pool_id: 'pool_alpha',
            prompt_policy: { mode: 'passthrough', source: 'provider_exempt' },
            stood_in: false,
            preserve_machine_home: false,
            session_gate_wait_ms: 0,
            explain: {},
          }),
        )
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, bootstrapped: true }))
    },
  })

  fs.mkdirSync(path.dirname(capFile), { recursive: true })
  fs.writeFileSync(
    capFile,
    JSON.stringify({
      transport: 'tcp',
      addr: `127.0.0.1:${tcpMock.port}`,
      host: '127.0.0.1',
      port: tcpMock.port,
      token,
    }),
  )

  const tcpClient = new SchedulerClient({
    transport: 'tcp',
    listenAddr: '127.0.0.1:0',
    capFile,
    manageProcess: false,
  })

  t.after(async () => {
    await tcpClient.shutdown({ drain: false, stopProcess: false })
    await tcpMock.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // Discovers port + token from cap-file and succeeds
  const res = await tcpClient.acquire(makeAcquireRequest({ request_id: 'tcp_ok' }))
  assert.equal(res.lease_id, 'tcp_lease_1')

  // AbortSignal immediately aborts in-flight acquire without retrying
  const ac = new AbortController()
  const hangPromise = tcpClient.acquire(makeAcquireRequest({ request_id: 'hang_forever' }), {
    signal: ac.signal,
    timeoutMs: 10_000,
  })
  setTimeout(() => ac.abort(), 30)
  await assert.rejects(
    () => hangPromise,
    (err) => err.name === 'AbortError' || err.code === 'ABORT_ERR',
  )
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(serverAborted, true, 'aborting acquire must drop connection so server cancels wait guard')
  assert.equal(acquireHits, 2, 'aborted acquire must not retry')

  // Permanent outage -> fail-closed 503 SchedulerUnavailableError within <= 300ms
  const deadClient = createSchedulerClient({
    socketPath: path.join(tmpDir, 'run', 'nonexistent.sock'),
    token,
    manageProcess: false,
    reconnectWindowMs: DEFAULT_RECONNECT_WINDOW_MS,
  })
  t.after(() => deadClient.shutdown({ drain: false, stopProcess: false }))
  const t0 = Date.now()
  await assert.rejects(
    () => deadClient.acquire(makeAcquireRequest({ request_id: 'dead_1' })),
    (err) =>
      err instanceof SchedulerUnavailableError &&
      err.status === 503 &&
      err.code === 'scheduler_unavailable' &&
      err.retryAfterSec === 1,
  )
  const elapsed = Date.now() - t0
  assert.ok(elapsed <= 500, `fail-closed 503 took too long: ${elapsed}ms`)

  // Missing binary with manageProcess=true -> immediate fail-closed 503
  const missingBinClient = createSchedulerClient({
    socketPath: path.join(tmpDir, 'run', 'missing-bin.sock'),
    binPath: path.join(tmpDir, 'does-not-exist-kin-scheduler'),
    manageProcess: true,
  })
  t.after(() => missingBinClient.shutdown({ drain: false, stopProcess: false }))
  await assert.rejects(
    () => missingBinClient.acquire(makeAcquireRequest({ request_id: 'missing_bin_1' })),
    (err) =>
      err instanceof SchedulerUnavailableError &&
      err.status === 503 &&
      err.code === 'scheduler_unavailable' &&
      err.retryAfterSec === 1 &&
      err.reason === 'bin_missing',
  )

  // Transient single-drop reconnect within <=300ms succeeds on retry
  let transientAttempts = 0
  const transientSock = path.join(tmpDir, 'run', 'transient.sock')
  const transientMock = await startMockServer({
    socketPath: transientSock,
    handler: async (req, res) => {
      transientAttempts += 1
      if (transientAttempts === 1) {
        req.socket.destroy()
        return
      }
      await readJsonBody(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          lease_id: 'transient_ok_lease',
          lease_ttl_ms: 120_000,
          selected_node: { node_key: 'claude_vm:vm-1' },
          resolved_pool_id: 'pool_alpha',
          prompt_policy: { mode: 'passthrough', source: 'provider_exempt' },
          stood_in: false,
          preserve_machine_home: false,
          session_gate_wait_ms: 0,
          explain: {},
        }),
      )
    },
  })
  const transientClient = createSchedulerClient({
    socketPath: transientSock,
    token,
    manageProcess: false,
    reconnectWindowMs: 300,
  })
  t.after(async () => {
    await transientClient.shutdown({ drain: false, stopProcess: false })
    await transientMock.close()
  })
  const recoveredTransient = await transientClient.acquire(makeAcquireRequest({ request_id: 'transient_1' }))
  assert.equal(recoveredTransient.lease_id, 'transient_ok_lease')
  assert.equal(transientAttempts, 2, 'must retry exactly once on transient transport drop')

  // Graceful shutdown triggers final synchronous drainAll before closing
  let shutdownDrainCount = 0
  let shutdownAcked = false
  const drainSock = path.join(tmpDir, 'run', 'shutdown-drain.sock')
  const drainMock = await startMockServer({
    socketPath: drainSock,
    handler: async (req, res) => {
      const body = await readJsonBody(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (body.ack_only && body.ack_batch_id === 99) {
        shutdownAcked = true
        res.end(
          JSON.stringify({
            ok: true,
            sticky_upserts: [],
            sticky_deletes: [],
            penalty_upserts: [],
            penalty_deletes: [],
            remaining: 0,
          }),
        )
        return
      }
      if (shutdownAcked) {
        res.end(
          JSON.stringify({
            ok: true,
            sticky_upserts: [],
            sticky_deletes: [],
            penalty_upserts: [],
            penalty_deletes: [],
            remaining: 0,
          }),
        )
        return
      }
      res.end(
        JSON.stringify({
          ok: true,
          batch_id: 99,
          sticky_upserts: [{ scope_kind: 'machine', pool_id: 'pool_alpha', identity_id: 'm1' }],
          sticky_deletes: [],
          penalty_upserts: [],
          penalty_deletes: [],
          remaining: 0,
        }),
      )
    },
  })
  const drainClient = createSchedulerClient({
    socketPath: drainSock,
    token,
    manageProcess: false,
    onDrain: async (batch) => {
      shutdownDrainCount += batch.sticky_upserts.length
    },
  })
  t.after(() => drainMock.close())
  const shut = await drainClient.shutdown({ drain: true, stopProcess: false })
  assert.equal(shut.ok, true)
  assert.equal(shutdownDrainCount, 1)
  assert.equal(shutdownAcked, true)
})

test('B1 regression: transient ECONNRESET against alive bootstrapped managed sidecar preserves controller_epoch and existing lease heartbeat', async (t) => {
  if (process.platform === 'win32') {
    t.skip('executable Node sidecar script test runs on Linux/WSL')
    return
  }
  const tmpDir = makeTempDir('vm2api-sched-b1-')
  const fakeBin = path.join(tmpDir, 'fake-kin-scheduler.mjs')
  const socketPath = path.join(tmpDir, 'run', 'scheduler.sock')
  const tokenPath = path.join(tmpDir, 'run', 'scheduler.token')
  const capFile = path.join(tmpDir, 'run', 'scheduler.cap.json')

  // Minimal live sidecar child that mirrors Rust engine.rs epoch-checked heartbeat semantics
  // and injects ONE transient ECONNRESET on the 2nd /schedule/acquire while staying alive.
  fs.writeFileSync(
    fakeBin,
    `#!${process.execPath}
import fs from 'node:fs'
import http from 'node:http'
const args = process.argv.slice(2)
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : '' }
const sock = arg('--socket')
const tok = fs.readFileSync(arg('--token-file'), 'utf8').trim()
let bootstrapped = false
let activeEpoch = ''
let acquireCount = 0
let injectedReset = false
const leases = new Map()
const readJson = (req) => new Promise((res) => {
  const c = []
  req.on('data', (d) => c.push(d))
  req.on('end', () => res(c.length ? JSON.parse(Buffer.concat(c).toString('utf8')) : {}))
})
const server = http.createServer(async (req, res) => {
  if (req.headers['x-kin-internal-token'] !== tok) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'bad token' } }))
    return
  }
  if (req.method === 'GET' && req.url === '/internal/v1/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, bootstrapped, role: 'leader', config_version: 1, epoch: activeEpoch, active_leases: leases.size, active_session_gates: 0, dirty_deltas: 0, uptime_ms: 1 }))
    return
  }
  const body = await readJson(req)
  if (req.method === 'POST' && req.url === '/internal/v1/bootstrap') {
    bootstrapped = true
    activeEpoch = String(body.controller_epoch)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, bootstrapped: true, role: body.role || 'leader', epoch: activeEpoch, config_version: 1 }))
    return
  }
  if (req.method === 'POST' && req.url === '/internal/v1/schedule/acquire') {
    acquireCount += 1
    if (acquireCount === 2 && !injectedReset) {
      injectedReset = true
      req.socket.destroy()
      return
    }
    const id = 'lease_' + acquireCount
    leases.set(id, String(body.controller_epoch))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ lease_id: id, lease_ttl_ms: 120000, selected_node: { node_key: 'claude_vm:vm-1' }, resolved_pool_id: body.origin_pool_id, prompt_policy: { mode: 'passthrough', source: 'provider_exempt' }, stood_in: false, preserve_machine_home: false, session_gate_wait_ms: 0, explain: {} }))
    return
  }
  if (req.method === 'POST' && req.url === '/internal/v1/schedule/heartbeat') {
    let renewed = 0
    const missing = []
    for (const id of body.lease_ids || []) {
      if (leases.get(id) === String(body.controller_epoch)) renewed += 1
      else missing.push(id)
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, renewed, missing }))
    return
  }
  res.writeHead(404)
  res.end()
})
server.listen(sock)
process.on('SIGTERM', () => { server.close(() => process.exit(0)) })
`,
    { mode: 0o755 },
  )

  let bootstrapCalls = 0
  const client = createSchedulerClient({
    binPath: fakeBin,
    socketPath,
    tokenPath,
    capFile,
    manageProcess: true,
    autoRestart: true,
    onBootstrap: ({ controllerEpoch, role }) => {
      bootstrapCalls += 1
      return { controller_epoch: controllerEpoch, role, config_version: 1, config_snapshot: makeSampleSnapshot(1) }
    },
  })

  t.after(async () => {
    await client.shutdown({ drain: false, stopProcess: true })
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  await client.start({ waitMs: 5_000 })
  const pidBefore = client.pid
  const epochBefore = client.controllerEpoch
  assert.equal(bootstrapCalls, 1)

  // Lease #1 acquired under original epoch
  const l1 = await client.acquire(makeAcquireRequest({ request_id: 'b1_req_1' }))
  assert.equal(l1.lease_id, 'lease_1')

  // Acquire #2 hits injected ECONNRESET on live sidecar -> retries once and succeeds WITHOUT bumping epoch
  const l2 = await client.acquire(makeAcquireRequest({ request_id: 'b1_req_2' }))
  assert.equal(l2.lease_id, 'lease_3')
  assert.equal(client.pid, pidBefore, 'alive sidecar must not be respawned on single transient ECONNRESET')
  assert.equal(
    client.controllerEpoch,
    epochBefore,
    'controller_epoch must stay unchanged when sidecar stays alive & bootstrapped',
  )
  assert.equal(bootstrapCalls, 1, 'must not re-bootstrap an already-bootstrapped live sidecar')

  // Heartbeat with original Lease #1 + Lease #2 must renew both with ZERO missing!
  const hb = await client.flushHeartbeat()
  assert.equal(hb.ok, true)
  assert.equal(hb.renewed, 2)
  assert.deepEqual(hb.missing, [])
  assert.equal(client.activeLeaseCount, 2)
})

// ============================================================================
// Suite B: Real Rust `kin-scheduler` UDS & TCP End-to-End Integration Tests
// ============================================================================

test('real kin-scheduler E2E: UDS boot, token auth, acquire/commit/release, FIFO + Abort, switch keeps gate, crash <300ms recovery, fail-closed 503, standby drain ban', async (t) => {
  const binPath = resolveRealSchedulerBin()
  if (!binPath) {
    t.skip('real kin-scheduler binary not built yet (set KIN_SCHEDULER_BIN or build scheduler/)')
    return
  }
  if (process.platform === 'win32') {
    t.skip('UDS integration test runs on Linux/WSL')
    return
  }

  const tmpDir = makeTempDir('vm2api-sched-e2e-')
  const socketPath = path.join(tmpDir, 'run', 'scheduler.sock')
  const tokenPath = path.join(tmpDir, 'run', 'scheduler.token')
  const capFile = path.join(tmpDir, 'run', 'scheduler.cap.json')

  let bootstrapCalls = 0
  const seenEpochs = []
  const drainedOnShutdown = []

  const client = createSchedulerClient({
    binPath,
    socketPath,
    tokenPath,
    capFile,
    manageProcess: true,
    autoRestart: true,
    reconnectWindowMs: 300,
    onBootstrap: ({ controllerEpoch, role }) => {
      bootstrapCalls += 1
      seenEpochs.push(controllerEpoch)
      return {
        controller_epoch: controllerEpoch,
        role,
        config_version: 1,
        config_snapshot: makeSampleSnapshot(1),
        initial_telemetry: [
          { node_key: 'claude_vm:vm-1', schedulable: true, active_hours_ok: true, proxy_ready: true },
          { node_key: 'claude_vm:vm-2', schedulable: true, active_hours_ok: true, proxy_ready: true },
        ],
      }
    },
    onDrain: async (batch) => {
      drainedOnShutdown.push(batch)
    },
  })

  t.after(async () => {
    await client.shutdown({ drain: false, stopProcess: true })
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // 1. Boot over UDS + Token auth enforcement
  const booted = await client.start({ waitMs: 5_000 })
  assert.equal(booted.ok, true)
  assert.ok(client.pid > 0)
  assert.equal(bootstrapCalls, 1)

  const h1 = await client.health()
  assert.equal(h1.ok, true)
  assert.equal(h1.bootstrapped, true)
  assert.equal(h1.role, 'leader')
  assert.equal(h1.config_version, 1)

  await assert.rejects(
    () => client.health({ tokenOverride: 'invalid-secret-token' }),
    (err) => err instanceof SchedulerApiError && err.status === 401 && err.code === 'unauthorized',
  )

  // 2. Real SSE subscription receives events
  const sseEvents = []
  const sseAc = new AbortController()
  const sub = client.subscribeEvents({
    signal: sseAc.signal,
    onEvent: (ev) => sseEvents.push(ev),
  })
  await sub.ready

  // 3. acquire -> commit -> sticky query -> explain -> release -> drain
  const sid1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const acq1 = await client.acquire(
    makeAcquireRequest({ request_id: 'e2e_1', session_id: sid1, machine_id: 'm_e2e_1' }),
  )
  assert.equal(acq1.selected_node.node_key, 'claude_vm:vm-1')
  assert.equal(acq1.prompt_policy.mode, 'zero_inject')
  assert.equal(acq1.prompt_policy.source, 'pool')

  const com1 = await client.commit(acq1.lease_id)
  assert.equal(com1.ok, true)
  assert.equal(com1.committed, true)

  const exp1 = await client.explain(
    makeAcquireRequest({ request_id: 'e2e_exp', session_id: sid1, machine_id: 'm_e2e_1' }),
  )
  assert.equal(exp1.ok, true)
  assert.equal(exp1.explain.session_gate.busy_at_peek, true, 'explain must peek active SessionGate without blocking')

  const rel1 = await client.release(acq1.lease_id, 'ok')
  assert.equal(rel1.ok, true)
  assert.equal(rel1.released, true)

  const stickyList = await client.querySticky({ pool_id: 'pool_alpha' })
  assert.equal(stickyList.ok, true)
  assert.ok(stickyList.bindings.length >= 2, 'commit should create session + machine sticky bindings')

  const drainTick = await client.runDrainTick({
    onDrain: async (batch) => {
      assert.ok(batch.sticky_upserts.length >= 1)
    },
  })
  assert.equal(drainTick.drained, true)

  const delSticky = await client.deleteSticky({ pool_id: 'pool_alpha', session_id: sid1 })
  assert.equal(delSticky.ok, true)

  // 4. Same session_id concurrent FIFO queueing + mid-queue Abort cancellation (SessionWaitGuard::drop)
  const sidFifo = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const r1 = await client.acquire(
    makeAcquireRequest({ request_id: 'fifo_1', session_id: sidFifo, machine_id: 'm_fifo' }),
  )

  let r2Settled = false
  let r3Settled = false
  const ac2 = new AbortController()
  const p2 = client
    .acquire(makeAcquireRequest({ request_id: 'fifo_2', session_id: sidFifo, machine_id: 'm_fifo' }), {
      signal: ac2.signal,
      sessionQueueTimeoutMs: 5_000,
    })
    .finally(() => {
      r2Settled = true
    })
  await new Promise((r) => setTimeout(r, 30))

  const p3 = client
    .acquire(makeAcquireRequest({ request_id: 'fifo_3', session_id: sidFifo, machine_id: 'm_fifo' }), {
      sessionQueueTimeoutMs: 5_000,
    })
    .then((res) => {
      r3Settled = true
      return res
    })
  await new Promise((r) => setTimeout(r, 40))

  assert.equal(r2Settled, false, 'R2 must wait in SessionGate FIFO while R1 holds gate')
  assert.equal(r3Settled, false, 'R3 must wait in SessionGate FIFO while R1 holds gate')

  // Abort R2 mid-queue -> must immediately reject without deadlocking R3
  ac2.abort()
  await assert.rejects(
    () => p2,
    (err) => err.name === 'AbortError' || err.code === 'ABORT_ERR',
  )
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(r3Settled, false, 'R3 must still wait until R1 releases')

  await client.release(r1.lease_id, 'ok')
  const r3 = await p3
  assert.ok(r3.lease_id)
  assert.ok(r3.session_gate_wait_ms >= 30, `expected R3 to report gate wait, got ${r3.session_gate_wait_ms}`)
  await client.release(r3.lease_id, 'ok')

  const hAfterFifo = await client.health()
  assert.equal(hAfterFifo.active_leases, 0)
  assert.equal(hAfterFifo.active_session_gates, 0)

  // 5. /schedule/switch swaps VM slot WITHOUT releasing SessionGate to queued R2
  const sidSwitch = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const sw1 = await client.acquire(
    makeAcquireRequest({ request_id: 'sw_1', session_id: sidSwitch, machine_id: 'm_sw' }),
  )
  assert.equal(sw1.selected_node.node_key, 'claude_vm:vm-1')

  let sw2Acquired = false
  const sw2Promise = client
    .acquire(makeAcquireRequest({ request_id: 'sw_2', session_id: sidSwitch, machine_id: 'm_sw' }), {
      sessionQueueTimeoutMs: 5_000,
    })
    .then((res) => {
      sw2Acquired = true
      return res
    })
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(sw2Acquired, false)

  const sw1Next = await client.switchLease({
    release_lease_id: sw1.lease_id,
    failure: { http_status: 529, error_class: 'overloaded529', error_message: 'overloaded' },
    next_attempt: makeAcquireRequest({
      request_id: 'sw_1',
      attempt_no: 2,
      session_id: sidSwitch,
      machine_id: 'm_sw',
      exclude_nodes: ['claude_vm:vm-1'],
    }),
  })
  assert.equal(sw1Next.selected_node.node_key, 'claude_vm:vm-2')
  assert.notEqual(sw1Next.lease_id, sw1.lease_id)

  // Wait briefly to confirm sw2 was NOT released during /schedule/switch!
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(sw2Acquired, false, '/schedule/switch must keep SessionGate locked and not wake R2')

  await client.release(sw1Next.lease_id, 'ok')
  const sw2 = await sw2Promise
  assert.ok(sw2.lease_id)
  await client.release(sw2.lease_id, 'ok')

  // Unrest vm-1 after 529 cooldown
  const unrest = await client.unrestNode('claude_vm:vm-1')
  assert.equal(unrest.ok, true)

  sseAc.abort()
  assert.ok(sseEvents.length >= 2, `expected real SSE events from kin-scheduler, got ${sseEvents.length}`)

  // 6. Sidecar SIGKILL crash -> <300ms Supervisor respawn + re-bootstrap with bumped controller_epoch
  const pidBefore = client.pid
  const epochBefore = client.controllerEpoch
  const tCrash = Date.now()
  process.kill(pidBefore, 'SIGKILL')

  // Immediately issue acquire without waiting: client must respawn + re-bootstrap + succeed within <=300ms
  const recovered = await client.acquire(
    makeAcquireRequest({
      request_id: 'post_crash_1',
      session_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    }),
  )
  const recoverMs = Date.now() - tCrash
  assert.ok(recovered.lease_id)
  assert.notEqual(client.pid, pidBefore, 'Supervisor must spawn a fresh kin-scheduler PID')
  assert.notEqual(client.controllerEpoch, epochBefore, 'Supervisor must increment controller_epoch on respawn')
  assert.ok(bootstrapCalls >= 2, 'Supervisor must re-run onBootstrap after crash')
  assert.ok(recoverMs <= 500, `crash recovery expected fast (<300ms window), took ${recoverMs}ms`)
  await client.release(recovered.lease_id, 'ok')

  // 7. Permanent outage (autoRestart disabled + SIGKILL) -> strict fail-closed 503 scheduler_unavailable
  const noRestartClient = createSchedulerClient({
    binPath,
    socketPath: path.join(tmpDir, 'run', 'no-restart.sock'),
    tokenPath: path.join(tmpDir, 'run', 'no-restart.token'),
    capFile: path.join(tmpDir, 'run', 'no-restart.cap.json'),
    manageProcess: true,
    autoRestart: false,
    reconnectWindowMs: 200,
    onBootstrap: ({ controllerEpoch, role }) => ({
      controller_epoch: controllerEpoch,
      role,
      config_version: 1,
      config_snapshot: makeSampleSnapshot(1),
    }),
  })
  t.after(() => noRestartClient.shutdown({ drain: false, stopProcess: true }))
  await noRestartClient.start({ waitMs: 5_000 })
  process.kill(noRestartClient.pid, 'SIGKILL')
  await new Promise((r) => setTimeout(r, 40))

  await assert.rejects(
    () =>
      noRestartClient.acquire(
        makeAcquireRequest({
          request_id: 'dead_permanent',
          session_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        }),
      ),
    (err) =>
      err instanceof SchedulerUnavailableError &&
      err.status === 503 &&
      err.code === 'scheduler_unavailable' &&
      err.retryAfterSec === 1,
  )

  // 8. Standby role forbids drain both client-side and server-side, then allows after promoteToLeader
  const standbySock = path.join(tmpDir, 'run', 'standby.sock')
  const standbyTokPath = path.join(tmpDir, 'run', 'standby.token')
  const standbyClient = createSchedulerClient({
    binPath,
    socketPath: standbySock,
    tokenPath: standbyTokPath,
    capFile: path.join(tmpDir, 'run', 'standby.cap.json'),
    manageProcess: true,
    isStandby: true,
    onBootstrap: ({ controllerEpoch, role }) => ({
      controller_epoch: controllerEpoch,
      role,
      config_version: 1,
      config_snapshot: makeSampleSnapshot(1),
    }),
  })
  t.after(() => standbyClient.shutdown({ drain: false, stopProcess: true }))
  await standbyClient.start({ waitMs: 5_000 })
  assert.equal((await standbyClient.health()).role, 'standby')

  await assert.rejects(
    () => standbyClient.drainPersistence(),
    (err) => err instanceof SchedulerApiError && err.status === 403 && err.code === 'standby_drain_forbidden',
  )

  // Verify real Rust daemon also enforces 403 standby_drain_forbidden directly over UDS
  const rawToken = fs.readFileSync(standbyTokPath, 'utf8').trim()
  const rawDrain = await rawUnixPost(standbySock, '/internal/v1/persistence/drain', rawToken, {})
  assert.equal(rawDrain.status, 403)
  assert.equal(rawDrain.body?.error?.code, 'standby_drain_forbidden')

  // Promote to leader -> drain now allowed
  await standbyClient.promoteToLeader({ rebootstrap: true, startDrain: false })
  assert.equal((await standbyClient.health()).role, 'leader')
  const leaderDrain = await standbyClient.drainPersistence()
  assert.equal(leaderDrain.ok, true)

  // 9. Loopback TCP + ephemeral port cap-file mode with real kin-scheduler
  const tcpClient = createSchedulerClient({
    binPath,
    transport: 'tcp',
    listenAddr: '127.0.0.1:0',
    tokenPath: path.join(tmpDir, 'run', 'tcp.token'),
    capFile: path.join(tmpDir, 'run', 'tcp.cap.json'),
    manageProcess: true,
    onBootstrap: ({ controllerEpoch, role }) => ({
      controller_epoch: controllerEpoch,
      role,
      config_version: 1,
      config_snapshot: makeSampleSnapshot(1),
    }),
  })
  t.after(() => tcpClient.shutdown({ drain: false, stopProcess: true }))
  await tcpClient.start({ waitMs: 5_000 })
  assert.ok(tcpClient.paths.port > 0, 'TCP ephemeral port must be discovered from cap-file')
  const tcpHealth = await tcpClient.health()
  assert.equal(tcpHealth.ok, true)
  assert.equal(tcpHealth.bootstrapped, true)
})
