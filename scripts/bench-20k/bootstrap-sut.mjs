#!/usr/bin/env node
/**
 * Full-lifecycle Benchmark Environment Bootstrapper for vm2api 20K RPM replay.
 *
 * Orchestrates:
 *   1. Clean reset of isolated bench PostgreSQL 18 (127.0.0.1:55432) & Redis 8 (127.0.0.1:56379)
 *   2. Exact SUT PostgreSQL schema migrations from `--sut-dir`
 *   3. Multi-worker `mock-upstream.mjs` pool (TCP + per-worker Unix domain sockets)
 *   4. Bulk seed of admin, tenant users, groups, managed API keys, 200 Mock VMs & accounts
 *   5. Launch 1..8 SUT processes (`<sut-dir>/src/server.mjs`) with zero-intrusion
 *      `sut-probe-preload.mjs` (`NODE_OPTIONS=--import`) & real Rust `kin-scheduler`
 *   6. Real panel login for admin + tenants (sharing session file across all SUT instances)
 *   7. Writes contract `session.json` and exports `startBenchEnv(opts)` / `stopBenchEnv(handle)`
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Redis from 'ioredis'
import pg from 'pg'
import { startMockUpstream } from './mock-upstream.mjs'

const { Pool } = pg
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BENCH_REPO_ROOT = path.resolve(__dirname, '../..')
const PROBE_PRELOAD_PATH = path.join(__dirname, 'sut-probe-preload.mjs')
const MOCK_UPSTREAM_PATH = path.join(__dirname, 'mock-upstream.mjs')

export const DEFAULT_BENCH_PG_URL = 'postgresql://vm2api:vm2api_bench_pass@127.0.0.1:55432/vm2api_bench'
export const DEFAULT_BENCH_REDIS_URL = 'redis://:vm2api_bench_redis@127.0.0.1:56379/0'
export const DEFAULT_SESSION_PATH = path.join(BENCH_REPO_ROOT, '.local', 'bench-20k', 'session.json')

const BENCH_ADMIN_USER = 'admin'
const BENCH_ADMIN_PASSWORD = 'BenchAdminPassword!2026'
const BENCH_TENANT_PASSWORD = 'BenchTenantPassword!2026'
const BENCH_HASH_SECRET = 'vm2api-bench-20k-hmac-secret-2026'
const BENCH_MASTER_KEY = 'sk-bench-master-20k-replay-2026'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function clampNum(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function parseBootstrapArgs(argv = []) {
  const opts = {
    sutDir: process.cwd(),
    instances: 1,
    vms: 200,
    keys: 100,
    tenants: 10,
    pgUrl: process.env.VM2API_BENCH_PG_URL || DEFAULT_BENCH_PG_URL,
    redisUrl: process.env.VM2API_BENCH_REDIS_URL || DEFAULT_BENCH_REDIS_URL,
    mockWorkers: 4,
    mockPort: 0,
    ttftMs: 10,
    streamMs: 20,
    faultRate: 0.02,
    sutBasePort: 18800,
    probeBasePort: 19800,
    outSession: DEFAULT_SESSION_PATH,
    workDir: '',
    resetDb: true,
    keepAlive: false,
    allowPort5432: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--sut-dir') opts.sutDir = path.resolve(argv[++i] || process.cwd())
    else if (a === '--instances') opts.instances = clampInt(argv[++i], 1, 1, 8)
    else if (a === '--vms') opts.vms = clampInt(argv[++i], 200, 1, 500)
    else if (a === '--keys') opts.keys = clampInt(argv[++i], 100, 1, 2000)
    else if (a === '--tenants') opts.tenants = clampInt(argv[++i], 10, 1, 200)
    else if (a === '--pg-url') opts.pgUrl = String(argv[++i] || DEFAULT_BENCH_PG_URL)
    else if (a === '--redis-url') opts.redisUrl = String(argv[++i] || DEFAULT_BENCH_REDIS_URL)
    else if (a === '--mock-workers') opts.mockWorkers = clampInt(argv[++i], 4, 1, 32)
    else if (a === '--mock-port') opts.mockPort = clampInt(argv[++i], 0, 0, 65535)
    else if (a === '--ttft-ms') opts.ttftMs = clampNum(argv[++i], 10, 0, 60_000)
    else if (a === '--stream-ms') opts.streamMs = clampNum(argv[++i], 20, 0, 120_000)
    else if (a === '--fault-rate') opts.faultRate = clampNum(argv[++i], 0.02, 0, 1)
    else if (a === '--sut-base-port') opts.sutBasePort = clampInt(argv[++i], 18800, 1024, 65000)
    else if (a === '--probe-base-port') opts.probeBasePort = clampInt(argv[++i], 19800, 1024, 65000)
    else if (a === '--out-session') opts.outSession = path.resolve(argv[++i] || DEFAULT_SESSION_PATH)
    else if (a === '--work-dir') opts.workDir = path.resolve(argv[++i] || '')
    else if (a === '--no-reset-db') opts.resetDb = false
    else if (a === '--keep-alive') opts.keepAlive = true
    else if (a === '--allow-port-5432') opts.allowPort5432 = true
  }
  return opts
}

/** Safety rail: never accidentally wipe a host PostgreSQL instance on default port 5432. */
export function assertSafeBenchPgUrl(pgUrl, { allowPort5432 = false } = {}) {
  let parsed
  try {
    parsed = new URL(pgUrl)
  } catch (err) {
    throw new Error(`Invalid bench PostgreSQL URL: ${err.message}`)
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`Refusing to reset non-local PostgreSQL host: ${host}`)
  }
  const port = parsed.port ? Number(parsed.port) : 5432
  if (port === 5432 && !allowPort5432) {
    throw new Error('Refusing to reset PostgreSQL on port 5432 (reserved for host DB); use isolated port 55432')
  }
  return parsed
}

function hashScryptPassword(password) {
  const N = 16384
  const r = 8
  const p = 1
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(String(password), salt, 32, { N, r, p })
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`
}

function hmacApiKey(secret, plainKey) {
  return crypto.createHmac('sha256', secret).update(plainKey).digest('hex')
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close((err) => (err ? reject(err) : resolve(p)))
    })
  })
}

function findExistingFile(candidates) {
  for (const file of candidates) {
    if (!file) continue
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
    } catch {}
  }
  return ''
}

function resolveBinaries(sutDir, workDir) {
  const home = os.homedir()
  const schedulerBin = findExistingFile([
    process.env.KIN_SCHEDULER_BIN,
    path.join(sutDir, 'bin', 'kin-scheduler'),
    path.join(BENCH_REPO_ROOT, 'bin', 'kin-scheduler'),
    '/mnt/x/vm2api/bin/kin-scheduler',
    path.join(home, '.cache', 'cargo-build', 'kin-scheduler', 'release', 'kin-scheduler'),
    '/home/mci777/.cache/cargo-build/kin-scheduler/release/kin-scheduler',
  ])

  const apiKernelBin = findExistingFile([
    process.env.KIN_API_KERNEL_BIN,
    path.join(sutDir, 'bin', 'kin-api-kernel'),
    path.join(BENCH_REPO_ROOT, 'bin', 'kin-api-kernel'),
    '/mnt/x/vm2api/bin/kin-api-kernel',
  ])

  let kernelBin = findExistingFile([
    process.env.KIN_KERNEL_BIN,
    path.join(sutDir, 'bin', 'kin-kernel'),
    path.join(BENCH_REPO_ROOT, 'bin', 'kin-kernel'),
    '/mnt/x/vm2api/bin/kin-kernel',
  ])
  if (!kernelBin) {
    // resolveHopEngine only checks binary existence; the mock Unix socket serves /internal/health & inference.
    const stubDir = path.join(workDir, 'bin')
    fs.mkdirSync(stubDir, { recursive: true })
    kernelBin = path.join(stubDir, 'kin-kernel')
    fs.writeFileSync(kernelBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }

  return { schedulerBin, apiKernelBin, kernelBin }
}

/**
 * Partition VMs and keys cleanly across platform admin + tenants so every key has
 * >= 2 mock VMs in its ownerScope for real failover without owner-scope starvation.
 */
function buildOwnershipPlan({ vmsCount, keysCount, tenantsCount }) {
  const adminUserId = 'u_bench_admin'
  const tenantIds = Array.from({ length: tenantsCount }, (_, i) => `u_bench_tenant_${String(i + 1).padStart(2, '0')}`)

  // Every active owner scope needs >= 2 VMs so 429/502 failover always has a switch target.
  const activeTenantCount = vmsCount >= 4 ? Math.min(tenantsCount, Math.floor((vmsCount - 2) / 2)) : 0
  const platformVmCount = activeTenantCount === 0 ? vmsCount : Math.max(2, Math.floor(vmsCount * 0.1))
  const tenantVmPool = vmsCount - platformVmCount

  const vmOwners = []
  for (let i = 0; i < vmsCount; i += 1) {
    if (i < platformVmCount || activeTenantCount === 0) {
      vmOwners.push(null) // platform VM
    } else {
      const idx = (i - platformVmCount) % activeTenantCount
      vmOwners.push(tenantIds[idx])
    }
  }

  const keyOwners = []
  const platformKeyCount =
    activeTenantCount === 0 ? keysCount : Math.max(1, Math.min(keysCount, Math.ceil(keysCount * 0.1)))
  for (let i = 0; i < keysCount; i += 1) {
    if (i < platformKeyCount || activeTenantCount === 0) {
      keyOwners.push(adminUserId)
    } else {
      const idx = (i - platformKeyCount) % activeTenantCount
      keyOwners.push(tenantIds[idx])
    }
  }

  return { adminUserId, tenantIds, activeTenantCount, platformVmCount, tenantVmPool, vmOwners, keyOwners }
}

async function resetAndMigratePg({ pgUrl, sutDir, resetDb, allowPort5432 }) {
  assertSafeBenchPgUrl(pgUrl, { allowPort5432 })
  const pool = new Pool({ connectionString: pgUrl, max: 4 })
  try {
    if (resetDb) {
      await pool.query('DROP SCHEMA IF EXISTS public CASCADE')
      await pool.query('CREATE SCHEMA public')
    }
    const runnerPath = path.join(sutDir, 'src', 'lib', 'db', 'pg', 'migrations-runner.mjs')
    const migrationsDir = path.join(sutDir, 'src', 'lib', 'db', 'pg', 'pg-migrations')
    const { applyPgMigrations } = await import(pathToFileURL(runnerPath).href)
    const applied = await applyPgMigrations(pool, { migrationsDir })
    return { applied }
  } finally {
    await pool.end()
  }
}

async function flushBenchRedis(redisUrl) {
  if (!redisUrl) return
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    lazyConnect: false,
  })
  try {
    await redis.flushdb()
  } finally {
    await redis.quit().catch(() => redis.disconnect())
  }
}

async function seedBenchDatabase({ pgUrl, plan, vmsCount, keysCount }) {
  const pool = new Pool({ connectionString: pgUrl, max: 4 })
  const nowIso = new Date().toISOString()
  const expiresIso = new Date(Date.now() + 30 * 86_400_000).toISOString()
  const adminHash = hashScryptPassword(BENCH_ADMIN_PASSWORD)
  const tenantHash = hashScryptPassword(BENCH_TENANT_PASSWORD)

  const apiKeys = []
  const vmIds = []
  const tenants = []

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // 1. Admin + tenant panel users (concurrency = 0 => unlimited user-level concurrency cap)
    await client.query(
      `INSERT INTO users (
         id, email, username, password_hash, role, balance, concurrency, status, notes,
         created_at, updated_at, vm_create_quota
       ) VALUES ($1, $2, $3, $4, 'admin', 1000000, 0, 'active', 'bench admin', $5, $5, 100)
       ON CONFLICT (id) DO NOTHING`,
      [plan.adminUserId, 'admin@bench.local', BENCH_ADMIN_USER, adminHash, nowIso],
    )

    for (let i = 0; i < plan.tenantIds.length; i += 1) {
      const id = plan.tenantIds[i]
      const username = `bench_tenant_${String(i + 1).padStart(2, '0')}`
      const email = `${username}@bench.local`
      tenants.push({ id, username, password: BENCH_TENANT_PASSWORD })
      await client.query(
        `INSERT INTO users (
           id, email, username, password_hash, role, balance, concurrency, status, notes,
           created_at, updated_at, vm_create_quota
         ) VALUES ($1, $2, $3, $4, 'user', 1000000, 0, 'active', 'bench tenant', $5, $5, 50)
         ON CONFLICT (id) DO NOTHING`,
        [id, email, username, tenantHash, nowIso],
      )
    }

    // 2. Custom bench group (group 1 & 2 are seeded by 001_init.sql)
    await client.query(
      `INSERT INTO groups (id, name, description, rate_multiplier, is_exclusive, platform, rpm_limit, sort_order, status, created_at, updated_at)
       VALUES (3, 'bench-20k', '20K RPM replay benchmark group', 1.0, 0, 'claude', 0, 2, 'active', $1, $1)
       ON CONFLICT (id) DO NOTHING`,
      [nowIso],
    )
    await client.query(
      `SELECT setval(pg_get_serial_sequence('groups', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM groups), 3), true)`,
    )

    // 3. Local egress proxy row (`px-local`)
    await client.query(
      `INSERT INTO proxies (id, protocol, host, port, raw, status, enabled, created_at, name, updated_at)
       VALUES ('px-local', 'local', 'local', 0, 'local://direct', 'ok', 1, $1, 'Local Direct', $1)
       ON CONFLICT (id) DO NOTHING`,
      [nowIso],
    )

    // 4. Mock VM accounts + account_groups + account_runtime
    for (let i = 0; i < vmsCount; i += 1) {
      const pad = String(i + 1).padStart(3, '0')
      const vmId = `vm-bench-${pad}`
      const accountId = `acct-bench-${pad}`
      const email = `bench-${pad}@mock.local`
      vmIds.push(vmId)

      await client.query(
        `INSERT INTO accounts (
           id, vm_id, email, concurrency, requests, tokens_in, tokens_out, updated_at,
           cache_read_tokens, cache_creation_tokens, concurrency_override, max_rpm, rpm_override,
           name, platform, type, credentials, extra, proxy_id, load_factor, priority, rate_multiplier,
           status, last_used_at, expires_at, schedulable, created_at
         ) VALUES (
           $1, $2, $3, 64, 0, 0, 0, $4,
           0, 0, 0, 0, 0,
           $5, 'claude', 'oauth', '{}', $6, 'px-local', 100, 50, 1.0,
           'active', $4, $7, 1, $4
         ) ON CONFLICT (id) DO NOTHING`,
        [accountId, vmId, email, nowIso, `Bench Account ${pad}`, JSON.stringify({ tier: 'max' }), expiresIso],
      )

      await client.query(
        `INSERT INTO account_groups (account_id, group_id, priority, created_at)
         VALUES ($1, 1, 50, $2), ($1, 3, 50, $2)
         ON CONFLICT (account_id, group_id) DO NOTHING`,
        [accountId, nowIso],
      )

      await client.query(
        `INSERT INTO account_runtime (
           account_id, vm_id, status, model_states_json, credential_generation, refresh_status,
           worker_heartbeat_at, worker_status_json, updated_at
         ) VALUES ($1, $2, 'ready', '{}', 1, 'ok', $3, $4, $5)
         ON CONFLICT (account_id) DO NOTHING`,
        [accountId, vmId, Date.now(), JSON.stringify({ ok: true, ready: true, engine: 'rust' }), nowIso],
      )
    }

    // 5. Managed API keys (high concurrency=500 & rpm=10000 to exercise real Redis gates without false throttling)
    for (let i = 0; i < keysCount; i += 1) {
      const pad = String(i + 1).padStart(4, '0')
      const keyId = `key_bench_${pad}`
      const plainKey = `sk-vm-bench20k${pad}${crypto.randomBytes(16).toString('hex')}`
      const keyHash = hmacApiKey(BENCH_HASH_SECRET, plainKey)
      const userId = plan.keyOwners[i]
      const groupId = i % 2 === 0 ? 1 : 3

      await client.query(
        `INSERT INTO api_keys (
           id, name, key, status, max_concurrency, quota_requests, quota_requests_used, rpm,
           expires_at, created_at, updated_at, requests, tokens_in, tokens_out,
           key_hash, key_prefix, key_suffix, cache_read_tokens, cache_creation_tokens,
           category, key_secret, user_id, group_id, quota, quota_used,
           rate_limit_5h, rate_limit_1d, rate_limit_7d, usage_5h, usage_1d, usage_7d,
           ip_whitelist, ip_blacklist, group_type, allowed_vms, allowed_models,
           permission_tier, pool_binding_mode
         ) VALUES (
           $1, $2, $3, 'active', 500, 0, 0, 10000,
           $4, $5, $5, 0, 0, 0,
           $6, $7, $8, 0, 0,
           'oauth', $9, $10, $11, 0, 0,
           0, 0, 0, 0, 0, 0,
           '[]', '[]', 'all', '[]', '[]',
           'platform', 'legacy_scope'
         )`,
        [
          keyId,
          `Bench Key ${pad}`,
          `hmac:${keyHash}`,
          expiresIso,
          nowIso,
          keyHash,
          plainKey.slice(0, 10),
          plainKey.slice(-4),
          plainKey,
          userId,
          groupId,
        ],
      )

      apiKeys.push({ id: keyId, key: plainKey, userId })
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
    await pool.end()
  }

  return { apiKeys, vmIds, tenants }
}

/** Materialize mock VM slot records & OAuth credential files on native Linux tmpfs/ext4. */
function materializeMockVms({ vmsDir, vmIds, plan, socketPaths }) {
  fs.mkdirSync(vmsDir, { recursive: true })
  const expiresAtSec = Math.floor(Date.now() / 1000) + 30 * 86400
  const expiresAtMs = expiresAtSec * 1000
  const nowIso = new Date().toISOString()

  for (let i = 0; i < vmIds.length; i += 1) {
    const vmId = vmIds[i]
    const pad = String(i + 1).padStart(3, '0')
    const accountId = `acct-bench-${pad}`
    const ownerUserId = plan.vmOwners[i]
    const sockPath = socketPaths[i % socketPaths.length]

    const vmDir = path.join(vmsDir, vmId)
    const claudeDir = path.join(vmDir, 'cli-home', '.claude')
    const runDir = path.join(vmDir, 'run')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.mkdirSync(runDir, { recursive: true })

    // Real slot credentials.json + relative symlink .credentials.json -> credentials.json
    const credFile = path.join(claudeDir, 'credentials.json')
    const credAlias = path.join(claudeDir, '.credentials.json')
    const credPayload = {
      claudeAiOauth: {
        accessToken: `sk-ant-oat01-bench-${pad}`,
        refreshToken: `sk-ant-ort01-bench-${pad}`,
        expiresAt: expiresAtMs,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    }
    fs.writeFileSync(credFile, `${JSON.stringify(credPayload, null, 2)}\n`, { mode: 0o600 })
    try {
      fs.rmSync(credAlias, { force: true })
    } catch {}
    fs.symlinkSync('credentials.json', credAlias)

    const vmRecord = {
      id: vmId,
      name: `bench-${pad}`,
      status: 'running',
      schedulable: true,
      dataplane: 'wrap',
      inference_engine: 'rust',
      timezone: 'UTC',
      locale: 'en_US.UTF-8',
      claude_code_version: '2.1.321',
      seed_policy: { telemetry_disabled: true },
      fingerprint: {
        device_id: `dev-bench-${pad}`,
        session_id: `sess-bench-${pad}`,
        machineID: `mid-bench-${pad}`,
      },
      policy: {
        maxConcurrency: 64,
        maxRpm: 0,
        sessionSlots: 20,
        weight: 1,
      },
      proxy_cli_enabled: true,
      proxy: {
        id: 'px-local',
        scheme: 'local',
        protocol: 'local',
        kind: 'local',
        host: 'local',
      },
      runtime: {
        worker: 'go',
        kernel_socket: sockPath,
        worker_socket: sockPath,
        worker_run_dir: runDir,
        worker_token_file: '',
      },
      claude: {
        has_access: true,
        has_refresh: true,
        expires_at: expiresAtSec,
        email: `bench-${pad}@mock.local`,
        account_uuid: accountId,
        org_uuid: 'org-bench-20k',
        subscription_type: 'max',
        account_tier: 'max',
        rate_limit_tier: 'default_claude_max_20x',
        source: 'bench-seed',
      },
      ...(ownerUserId ? { owner_user_id: ownerUserId, origin: 'admin_assigned' } : { origin: 'platform' }),
      created_at: nowIso,
      updated_at: nowIso,
    }
    fs.writeFileSync(path.join(vmsDir, `${vmId}.json`), JSON.stringify(vmRecord, null, 2), { mode: 0o600 })
  }

  if (vmIds.length > 0) {
    fs.writeFileSync(path.join(vmsDir, 'active.json'), JSON.stringify({ active_vm: vmIds[0] }, null, 2))
  }
}

/** Create tuned bench routing.json (disables background Docker watchdogs/probes, keeps real request pipeline). */
function buildBenchRoutingConfig(sutDir) {
  const basePath = path.join(sutDir, 'src', 'config', 'routing.json')
  const base = JSON.parse(fs.readFileSync(basePath, 'utf8'))
  return {
    ...base,
    concurrency: {
      ...(base.concurrency || {}),
      default_max_per_account: 64,
      default_key_concurrency: 500,
      fable_max_per_account: 64,
      default_max_rpm: 0,
    },
    quota: {
      ...(base.quota || {}),
      safety_ratio: 0.95,
      weekly_safety_ratio: 0.95,
      warn_ratio: 0.85,
      block_on_5h: true,
      block_on_7d: true,
      guard_large_cold: false,
    },
    pool: {
      ...(base.pool || {}),
      strategy: 'balanced',
      queue_max: 2000,
      fallback_wait_timeout_ms: 30_000,
      worker_health_ttl_ms: 60_000,
      circuit_failure_threshold: 10,
      circuit_open_ms: 5_000,
    },
    failover: {
      ...(base.failover || {}),
      max_total_attempts: 8,
      max_account_switches: 3,
      max_same_account_retries: 0,
      same_account_retry_delay_ms: 50,
      total_retry_deadline_ms: 60_000,
      delivery_mode: 'realtime',
    },
    inference: {
      ...(base.inference || {}),
      engine: 'rust',
      fallback_to_go: false,
      eager_start: false,
      health_ttl_ms: 60_000,
      health_timeout_ms: 2_000,
      kernel_down_reprobe_ms: 0,
      session_slots: 20,
      dataplane: 'wrap',
    },
    kernel_watchdog: { ...(base.kernel_watchdog || {}), enabled: false },
    credential_refresh: { ...(base.credential_refresh || {}), enabled: false },
    health_probe: { ...(base.health_probe || {}), enabled: false },
    usage_probe: { ...(base.usage_probe || {}), enabled: false },
    warmup: { ...(base.warmup || {}), enabled: false },
    crag_zombie_guard: { ...(base.crag_zombie_guard || {}), enabled: false },
    notify: { ...(base.notify || {}), enabled: false },
  }
}

async function launchMockUpstreamPool({ workDir, workers, nodes, port, ttftMs, streamMs, faultRate }) {
  const sockDir = path.join(workDir, 'm')
  fs.mkdirSync(sockDir, { recursive: true })

  if (workers <= 1) {
    const handle = await startMockUpstream({
      host: '127.0.0.1',
      port,
      nodes,
      ttftMs,
      streamMs,
      faultRate,
      sockDir,
    })
    return {
      url: handle.url,
      socketPaths: handle.socketPaths,
      pid: process.pid,
      async stop() {
        await handle.close()
      },
    }
  }

  const resolvedPort = port || (await pickFreePort())
  const readyFile = path.join(workDir, 'mock-ready.json')
  const logs = []
  const child = spawn(
    process.execPath,
    [
      MOCK_UPSTREAM_PATH,
      '--host',
      '127.0.0.1',
      '--port',
      String(resolvedPort),
      '--workers',
      String(workers),
      '--nodes',
      String(nodes),
      '--ttft-ms',
      String(ttftMs),
      '--stream-ms',
      String(streamMs),
      '--fault-rate',
      String(faultRate),
      '--sock-dir',
      sockDir,
      '--ready-file',
      readyFile,
    ],
    {
      cwd: BENCH_REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.on('data', (d) => {
    if (logs.length < 100) logs.push(d.toString())
  })
  child.stderr.on('data', (d) => {
    if (logs.length < 100) logs.push(`[stderr] ${d.toString()}`)
  })

  const deadline = Date.now() + 15_000
  let info = null
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`mock-upstream exited early (${child.exitCode}):\n${logs.join('')}`)
    }
    if (fs.existsSync(readyFile)) {
      try {
        info = JSON.parse(fs.readFileSync(readyFile, 'utf8'))
        if (info?.ok && info?.url) break
      } catch {}
    }
    await sleep(100)
  }
  if (!info?.url) {
    try {
      child.kill('SIGKILL')
    } catch {}
    throw new Error(`mock-upstream did not become ready:\n${logs.join('')}`)
  }

  // Confirm TCP /__stats is answering
  const statsRes = await fetch(`${info.url}/__stats`)
  if (!statsRes.ok) {
    try {
      child.kill('SIGKILL')
    } catch {}
    throw new Error(`mock-upstream /__stats returned ${statsRes.status}`)
  }

  return {
    url: info.url,
    socketPaths: info.socketPaths,
    pid: child.pid,
    child,
    async stop() {
      if (child.exitCode !== null) return
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {}
          resolve()
        }, 5_000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        child.kill('SIGTERM')
      })
    },
  }
}

async function spawnSutInstance({
  index,
  sutDir,
  instDir,
  vmsDir,
  routingConfig,
  sutPort,
  probePort,
  pgUrl,
  redisUrl,
  binaries,
}) {
  const dataDir = path.join(instDir, 'data')
  const capturesDir = path.join(instDir, 'captures')
  const srcConfigDir = path.join(instDir, 'src', 'config')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(capturesDir, { recursive: true })
  fs.mkdirSync(path.join(instDir, 'config'), { recursive: true })
  fs.cpSync(path.join(sutDir, 'src', 'config'), srcConfigDir, { recursive: true })
  const routingFile = path.join(srcConfigDir, 'routing.json')
  fs.writeFileSync(routingFile, `${JSON.stringify(routingConfig, null, 2)}\n`)

  // Mount shared vms directory into instance project root
  const instVms = path.join(instDir, 'vms')
  if (!fs.existsSync(instVms)) {
    fs.symlinkSync(vmsDir, instVms, 'dir')
  }

  const preloadFlag = `--import ${PROBE_PRELOAD_PATH}`
  const existingNodeOpts = String(process.env.NODE_OPTIONS || '').trim()
  const nodeOptions = existingNodeOpts ? `${existingNodeOpts} ${preloadFlag}` : preloadFlag

  const env = {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    VM2API_BENCH_PROBE_PORT: String(probePort),
    VM2API_BENCH_PROBE_HOST: '127.0.0.1',
    HOST: '127.0.0.1',
    PORT: String(sutPort),
    PUBLIC_HOST: '127.0.0.1',
    PUBLIC_SCHEME: 'http',
    PUBLIC_BASE_URL: `http://127.0.0.1:${sutPort}`,
    KIN_PROJECT_ROOT: instDir,
    KIN_DATA_DIR: dataDir,
    KIN_CAPTURES_DIR: capturesDir,
    KIN_ROUTING_FILE: routingFile,
    KIN_KERNEL_BIN: binaries.kernelBin,
    ...(binaries.apiKernelBin ? { KIN_API_KERNEL_BIN: binaries.apiKernelBin } : {}),
    ...(binaries.schedulerBin ? { KIN_SCHEDULER_BIN: binaries.schedulerBin } : {}),
    KIN_CRS_MOCK: '0',
    VM2API_DB_DRIVER: 'postgres',
    DATABASE_URL: pgUrl,
    ...(redisUrl ? { REDIS_URL: redisUrl, VM2API_REDIS_DISABLED: '0' } : { VM2API_REDIS_DISABLED: '1', REDIS_URL: '' }),
    VM2API_API_KEY: BENCH_MASTER_KEY,
    KIN_API_KEY: BENCH_MASTER_KEY,
    VM2API_API_KEY_HASH_SECRET: BENCH_HASH_SECRET,
    VM2API_ADMIN_USER: BENCH_ADMIN_USER,
    VM2API_ADMIN_PASSWORD: BENCH_ADMIN_PASSWORD,
    KIN_RATE_CAP: '0',
    KIN_BACKUP_DISABLED: '1',
    VM2API_CRAG_SHOP_AUTO_ACTIVATION: '0',
    VM2API_DASHBOARD_AGGREGATOR_DISABLED: index === 0 ? '0' : '1',
    NO_PROXY: '127.0.0.1,localhost',
  }

  const logs = []
  const child = spawn(process.execPath, [path.join(sutDir, 'src', 'server.mjs')], {
    cwd: sutDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => {
    const s = d.toString()
    if (logs.length < 300) logs.push(s)
  })
  child.stderr.on('data', (d) => {
    const s = d.toString()
    if (logs.length < 300) logs.push(`[stderr] ${s}`)
  })

  const sutUrl = `http://127.0.0.1:${sutPort}`
  const probeStatsUrl = `http://127.0.0.1:${probePort}/metrics`
  const deadline = Date.now() + 30_000
  let sutHealthy = false
  let probeHealthy = false

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`SUT[${index}] exited early (code=${child.exitCode}):\n${logs.join('')}`)
    }
    if (!sutHealthy) {
      try {
        const r = await fetch(`${sutUrl}/health`)
        if (r.status === 200) sutHealthy = true
      } catch {}
    }
    if (!probeHealthy) {
      try {
        const r = await fetch(probeStatsUrl)
        if (r.status === 200) probeHealthy = true
      } catch {}
    }
    if (sutHealthy && probeHealthy) {
      return { index, child, pid: child.pid, sutUrl, probeStatsUrl, instDir, dataDir, logs }
    }
    await sleep(200)
  }

  try {
    child.kill('SIGKILL')
  } catch {}
  throw new Error(
    `SUT[${index}] timed out waiting for ready (sut=${sutHealthy}, probe=${probeHealthy}):\n${logs.join('')}`,
  )
}

async function loginPanel(sutUrl, username, password) {
  const res = await fetch(`${sutUrl}/api/panel/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.ok || !data?.token) {
    throw new Error(`Panel login failed for ${username} (${res.status}): ${JSON.stringify(data)}`)
  }
  const setCookie = res.headers.get('set-cookie') || ''
  const match = /kin_panel_token=[^;]+/.exec(setCookie)
  return match ? match[0] : `kin_panel_token=${encodeURIComponent(data.token)}`
}

async function stopChildGracefully(child, timeoutMs = 10_000) {
  if (!child || child.exitCode !== null) return
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      resolve()
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try {
      child.kill('SIGTERM')
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

/**
 * Cleanly tear down all SUT processes, mock upstream pool, and temporary workDir.
 */
export async function stopBenchEnv(handle) {
  if (!handle || handle._stopped) return
  handle._stopped = true

  const sutInstances = Array.isArray(handle.sutInstances) ? handle.sutInstances : []
  await Promise.all(sutInstances.map((inst) => stopChildGracefully(inst.child, 10_000)))

  if (handle.mockHandle) {
    await handle.mockHandle.stop().catch(() => {})
  }

  if (handle.ownsWorkDir && handle.workDir) {
    try {
      fs.rmSync(handle.workDir, { recursive: true, force: true })
    } catch {}
  }
}

/**
 * Provision the complete isolated benchmark environment (PG18 + Redis8 + Mock Upstream + 1..N SUTs).
 */
export async function startBenchEnv(rawOpts = {}) {
  const opts = {
    sutDir: path.resolve(rawOpts.sutDir || process.cwd()),
    instances: clampInt(rawOpts.instances, 1, 1, 8),
    vms: clampInt(rawOpts.vms, 200, 1, 500),
    keys: clampInt(rawOpts.keys, 100, 1, 2000),
    tenants: clampInt(rawOpts.tenants, 10, 1, 200),
    pgUrl: rawOpts.pgUrl || process.env.VM2API_BENCH_PG_URL || DEFAULT_BENCH_PG_URL,
    redisUrl: rawOpts.redisUrl ?? process.env.VM2API_BENCH_REDIS_URL ?? DEFAULT_BENCH_REDIS_URL,
    mockWorkers: clampInt(rawOpts.mockWorkers, 4, 1, 32),
    mockPort: clampInt(rawOpts.mockPort, 0, 0, 65535),
    ttftMs: clampNum(rawOpts.ttftMs, 10, 0, 60_000),
    streamMs: clampNum(rawOpts.streamMs, 20, 0, 120_000),
    faultRate: clampNum(rawOpts.faultRate, 0.02, 0, 1),
    sutBasePort: clampInt(rawOpts.sutBasePort, 18800, 1024, 65000),
    probeBasePort: clampInt(rawOpts.probeBasePort, 19800, 1024, 65000),
    outSession: rawOpts.outSession !== undefined ? rawOpts.outSession : DEFAULT_SESSION_PATH,
    workDir: rawOpts.workDir || '',
    resetDb: rawOpts.resetDb !== false,
    allowPort5432: rawOpts.allowPort5432 === true,
  }

  const serverEntry = path.join(opts.sutDir, 'src', 'server.mjs')
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`Invalid --sut-dir (${opts.sutDir}): missing src/server.mjs`)
  }
  const pgDepPath = path.join(opts.sutDir, 'node_modules', 'pg', 'package.json')
  if (!fs.existsSync(pgDepPath)) {
    throw new Error(
      `SUT directory ${opts.sutDir} is missing node_modules/pg; run \`npm ci --prefer-offline\` in that directory first`,
    )
  }

  const runId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
  const ownsWorkDir = !opts.workDir
  // Short path under /tmp (native Linux ext4/tmpfs on WSL2) keeps Unix domain sockets well under 108 bytes.
  const workDir = opts.workDir || path.join(os.tmpdir(), `v2b-${runId}`)
  fs.mkdirSync(workDir, { recursive: true })

  const handle = {
    workDir,
    ownsWorkDir,
    mockHandle: null,
    sutInstances: [],
    _stopped: false,
  }

  try {
    // 1. Reset & migrate PG + flush Redis
    await resetAndMigratePg({
      pgUrl: opts.pgUrl,
      sutDir: opts.sutDir,
      resetDb: opts.resetDb,
      allowPort5432: opts.allowPort5432,
    })
    if (opts.redisUrl) {
      await flushBenchRedis(opts.redisUrl)
    }

    // 2. Launch multi-worker mock upstream pool
    handle.mockHandle = await launchMockUpstreamPool({
      workDir,
      workers: opts.mockWorkers,
      nodes: opts.vms,
      port: opts.mockPort,
      ttftMs: opts.ttftMs,
      streamMs: opts.streamMs,
      faultRate: opts.faultRate,
    })

    // 3. Seed PG users, groups, proxies, accounts, API keys
    const plan = buildOwnershipPlan({
      vmsCount: opts.vms,
      keysCount: opts.keys,
      tenantsCount: opts.tenants,
    })
    const seeded = await seedBenchDatabase({
      pgUrl: opts.pgUrl,
      plan,
      vmsCount: opts.vms,
      keysCount: opts.keys,
    })

    // 4. Materialize mock VM slot files & OAuth credentials
    const vmsDir = path.join(workDir, 'vms')
    materializeMockVms({
      vmsDir,
      vmIds: seeded.vmIds,
      plan,
      socketPaths: handle.mockHandle.socketPaths,
    })

    // 5. Start 1..N SUT instances with probe preload & Rust scheduler
    const binaries = resolveBinaries(opts.sutDir, workDir)
    const routingConfig = buildBenchRoutingConfig(opts.sutDir)
    for (let i = 0; i < opts.instances; i += 1) {
      const instDir = path.join(workDir, `s${i}`)
      fs.mkdirSync(instDir, { recursive: true })
      const inst = await spawnSutInstance({
        index: i,
        sutDir: opts.sutDir,
        instDir,
        vmsDir,
        routingConfig,
        sutPort: opts.sutBasePort + i,
        probePort: opts.probeBasePort + i,
        pgUrl: opts.pgUrl,
        redisUrl: opts.redisUrl,
        binaries,
      })
      handle.sutInstances.push(inst)
    }

    // 6. Login admin + tenants on instance 0, then replicate panel-sessions.json to instances 1..N-1
    const primaryUrl = handle.sutInstances[0].sutUrl
    const adminCookie = await loginPanel(primaryUrl, BENCH_ADMIN_USER, BENCH_ADMIN_PASSWORD)
    const tenantCookies = []
    for (const tenant of seeded.tenants) {
      const cookie = await loginPanel(primaryUrl, tenant.username, tenant.password)
      tenantCookies.push(cookie)
    }

    if (handle.sutInstances.length > 1) {
      const srcSessions = path.join(handle.sutInstances[0].dataDir, 'panel-sessions.json')
      if (fs.existsSync(srcSessions)) {
        for (let i = 1; i < handle.sutInstances.length; i += 1) {
          fs.copyFileSync(srcSessions, path.join(handle.sutInstances[i].dataDir, 'panel-sessions.json'))
        }
      }
    }

    const session = {
      sutDir: opts.sutDir,
      pgUrl: opts.pgUrl,
      redisUrl: opts.redisUrl,
      mockUpstreamUrl: handle.mockHandle.url,
      sutUrls: handle.sutInstances.map((s) => s.sutUrl),
      sutPids: handle.sutInstances.map((s) => s.pid),
      probeStatsUrls: handle.sutInstances.map((s) => s.probeStatsUrl),
      adminCookie,
      tenantCookies,
      apiKeys: seeded.apiKeys,
      vmIds: seeded.vmIds,
      masterKey: BENCH_MASTER_KEY,
      schedulerBin: binaries.schedulerBin || null,
      createdAt: new Date().toISOString(),
    }

    if (opts.outSession) {
      fs.mkdirSync(path.dirname(opts.outSession), { recursive: true })
      const tmpFile = `${opts.outSession}.${process.pid}.tmp`
      fs.writeFileSync(tmpFile, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(tmpFile, opts.outSession)
    }

    Object.assign(handle, session, {
      session,
      sessionPath: opts.outSession || null,
      stop: () => stopBenchEnv(handle),
    })
    return handle
  } catch (err) {
    await stopBenchEnv(handle).catch(() => {})
    throw err
  }
}

async function runCli() {
  const opts = parseBootstrapArgs(process.argv.slice(2))
  const handle = await startBenchEnv(opts)
  console.log(
    JSON.stringify(
      {
        event: 'bench-env-ready',
        sessionPath: handle.sessionPath,
        sutDir: handle.sutDir,
        sutUrls: handle.sutUrls,
        sutPids: handle.sutPids,
        probeStatsUrls: handle.probeStatsUrls,
        mockUpstreamUrl: handle.mockUpstreamUrl,
        vms: handle.vmIds.length,
        apiKeys: handle.apiKeys.length,
        tenants: handle.tenantCookies.length,
        schedulerBin: handle.schedulerBin,
      },
      null,
      2,
    ),
  )

  const shutdown = async () => {
    await stopBenchEnv(handle)
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown())
  process.once('SIGINT', () => void shutdown())

  if (!opts.keepAlive) {
    // Keep alive by default in CLI mode so spawned SUT + mock processes stay running until killed.
    await new Promise(() => {})
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  runCli().catch((err) => {
    console.error('[bootstrap-sut] fatal:', err)
    process.exit(1)
  })
}
