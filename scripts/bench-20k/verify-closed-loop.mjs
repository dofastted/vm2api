#!/usr/bin/env node
/**
 * Closed-loop zero-loss & zero-drift integrity verifier for Phase 0 20K RPM benchmarks.
 *
 * After load finishes, waits for PgLogWriter + ApiKeyStore write-behind drain and verifies:
 * 1. PG `usage_logs` persisted row count vs expected completed requests (loss rate / diff).
 * 2. PG `api_keys` billing counters (`quota_requests_used`, `tokens_in`, `tokens_out`, `quota_used`)
 *    vs `SUM(...) FROM usage_logs GROUP BY api_key_id`.
 * 3. `PgLogWriter` counters (`overflowDirect`, `fallbacks`, `dropped`, `errors`, `queued`).
 * 4. Redis `evicted_keys` and residual `vm2api:live:inflight` orphan count.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Redis from 'ioredis'
import pg from 'pg'
import { extractPgLogWriterStats, parseRedisInfo } from './metrics-collector.mjs'

const DEFAULT_DRAIN_TIMEOUT_MS = 15_000
const DEFAULT_POLL_INTERVAL_MS = 500
const DEFAULT_STABLE_CHECKS = 2
const DEFAULT_COST_TOLERANCE_USD = 1e-4
const DEFAULT_REDIS_KEY_PREFIX = 'vm2api:'

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function round6(v) {
  return Math.round(v * 1_000_000) / 1_000_000
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchPgLogWriterAggregate(
  sutUrls = [],
  adminCookie = '',
  { fetchImpl = fetch, timeoutMs = 5_000 } = {},
) {
  const urls = Array.isArray(sutUrls) ? sutUrls.filter(Boolean) : []
  if (urls.length === 0) return { available: false, aggregate: null, instances: [] }

  const headers = adminCookie ? { cookie: adminCookie } : {}
  const instances = await Promise.all(
    urls.map(async (raw) => {
      const endpoint = new URL('/api/panel/request-logs/stats', raw).toString()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetchImpl(endpoint, { method: 'GET', headers, signal: controller.signal })
        if (!res.ok) return { url: endpoint, ok: false, status: res.status, pgLogWriter: null }
        const data = await res.json().catch(() => null)
        return { url: endpoint, ok: true, status: res.status, pgLogWriter: extractPgLogWriterStats(data) }
      } catch (err) {
        return { url: endpoint, ok: false, status: 0, error: err?.message || String(err), pgLogWriter: null }
      } finally {
        clearTimeout(timer)
      }
    }),
  )

  const writers = instances.map((i) => i.pgLogWriter).filter(Boolean)
  if (writers.length === 0) {
    return { available: false, aggregate: null, instances }
  }
  const aggregate = {
    queued: writers.reduce((s, w) => s + w.queued, 0),
    enqueued: writers.reduce((s, w) => s + w.enqueued, 0),
    flushed: writers.reduce((s, w) => s + w.flushed, 0),
    batches: writers.reduce((s, w) => s + w.batches, 0),
    fallbacks: writers.reduce((s, w) => s + w.fallbacks, 0),
    overflowDirect: writers.reduce((s, w) => s + w.overflowDirect, 0),
    dropped: writers.reduce((s, w) => s + w.dropped, 0),
    errors: writers.reduce((s, w) => s + w.errors, 0),
  }
  return { available: true, aggregate, instances }
}

/**
 * Pure reconciliation between `api_keys` billing columns and grouped `usage_logs` aggregates.
 */
export function reconcileApiKeyBilling(
  apiKeyRows = [],
  usageLogAggRows = [],
  { costToleranceUsd = DEFAULT_COST_TOLERANCE_USD, baselineByKey = null } = {},
) {
  const keyMap = new Map()
  for (const row of apiKeyRows) {
    if (!row?.id) continue
    const base = baselineByKey?.[row.id] || {}
    keyMap.set(String(row.id), {
      id: String(row.id),
      quotaRequestsUsed: num(row.quota_requests_used) - num(base.quota_requests_used),
      requests: num(row.requests) - num(base.requests),
      tokensIn: num(row.tokens_in) - num(base.tokens_in),
      tokensOut: num(row.tokens_out) - num(base.tokens_out),
      quotaUsed: num(row.quota_used) - num(base.quota_used),
    })
  }

  const logMap = new Map()
  for (const row of usageLogAggRows) {
    const keyId = row?.api_key_id != null ? String(row.api_key_id) : ''
    if (!keyId) continue
    logMap.set(keyId, {
      apiKeyId: keyId,
      totalLogs: num(row.total_logs),
      okLogs: row.ok_logs != null ? num(row.ok_logs) : num(row.total_logs),
      sumTokensIn: num(row.sum_tokens_in),
      sumTokensOut: num(row.sum_tokens_out),
      sumCost: num(row.sum_cost),
    })
  }

  const allIds = new Set([...keyMap.keys(), ...logMap.keys()])
  const diffs = []
  let totalKeysChecked = 0
  const totals = {
    apiKeysQuotaRequestsUsed: 0,
    usageLogsOkCount: 0,
    usageLogsTotalCount: 0,
    apiKeysTokensIn: 0,
    usageLogsTokensIn: 0,
    apiKeysTokensOut: 0,
    usageLogsTokensOut: 0,
    apiKeysQuotaUsed: 0,
    usageLogsCost: 0,
  }

  for (const id of allIds) {
    const k = keyMap.get(id) || {
      id,
      quotaRequestsUsed: 0,
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
      quotaUsed: 0,
    }
    const l = logMap.get(id) || {
      apiKeyId: id,
      totalLogs: 0,
      okLogs: 0,
      sumTokensIn: 0,
      sumTokensOut: 0,
      sumCost: 0,
    }

    // Skip completely unused keys
    if (k.quotaRequestsUsed === 0 && k.tokensIn === 0 && k.tokensOut === 0 && l.totalLogs === 0) {
      continue
    }
    totalKeysChecked++

    totals.apiKeysQuotaRequestsUsed += k.quotaRequestsUsed
    totals.usageLogsOkCount += l.okLogs
    totals.usageLogsTotalCount += l.totalLogs
    totals.apiKeysTokensIn += k.tokensIn
    totals.usageLogsTokensIn += l.sumTokensIn
    totals.apiKeysTokensOut += k.tokensOut
    totals.usageLogsTokensOut += l.sumTokensOut
    totals.apiKeysQuotaUsed += k.quotaUsed
    totals.usageLogsCost += l.sumCost

    const quotaRequestsDiff = k.quotaRequestsUsed - l.okLogs
    const tokensInDiff = k.tokensIn - l.sumTokensIn
    const tokensOutDiff = k.tokensOut - l.sumTokensOut
    const quotaUsedDiff = round6(k.quotaUsed - l.sumCost)

    const hasDrift =
      quotaRequestsDiff !== 0 || tokensInDiff !== 0 || tokensOutDiff !== 0 || Math.abs(quotaUsedDiff) > costToleranceUsd

    if (hasDrift) {
      diffs.push({
        apiKeyId: id,
        apiKeys: {
          quota_requests_used: k.quotaRequestsUsed,
          tokens_in: k.tokensIn,
          tokens_out: k.tokensOut,
          quota_used: round6(k.quotaUsed),
        },
        usageLogs: {
          ok_logs: l.okLogs,
          total_logs: l.totalLogs,
          sum_tokens_in: l.sumTokensIn,
          sum_tokens_out: l.sumTokensOut,
          sum_cost: round6(l.sumCost),
        },
        diff: {
          quota_requests_used: quotaRequestsDiff,
          tokens_in: tokensInDiff,
          tokens_out: tokensOutDiff,
          quota_used: quotaUsedDiff,
        },
      })
    }
  }

  totals.apiKeysQuotaUsed = round6(totals.apiKeysQuotaUsed)
  totals.usageLogsCost = round6(totals.usageLogsCost)

  return {
    passed: diffs.length === 0,
    totalKeysChecked,
    driftedKeyCount: diffs.length,
    totals,
    diffs,
  }
}

/**
 * Wait for PgLogWriter queues, Redis live:inflight set, and PG usage_logs/api_keys counts to drain & stabilize.
 */
export async function waitForDrain({
  pgClient = null,
  redisClient = null,
  sutUrls = [],
  adminCookie = '',
  fetchImpl = fetch,
  redisKeyPrefix = DEFAULT_REDIS_KEY_PREFIX,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  stableChecks = DEFAULT_STABLE_CHECKS,
  expectedUsageLogCount = null,
  triggerFlush = null,
} = {}) {
  const inflightKey = `${redisKeyPrefix}live:inflight`
  const start = Date.now()
  let polls = 0
  let stableStreak = 0
  let prevUsageCount = null
  let prevApiKeyReqSum = null
  let lastState = {
    usageLogsCount: null,
    apiKeysReqSum: null,
    pgLogWriterQueued: 0,
    liveInflight: 0,
  }

  if (typeof triggerFlush === 'function') {
    await triggerFlush().catch(() => {})
  }

  while (true) {
    polls++
    const [usageRes, keysRes, writerRes, inflightCard] = await Promise.all([
      pgClient ? pgClient.query('SELECT COUNT(*)::bigint AS cnt FROM usage_logs').catch(() => null) : null,
      pgClient
        ? pgClient
            .query('SELECT COALESCE(SUM(quota_requests_used), 0)::bigint AS cnt FROM api_keys WHERE deleted_at IS NULL')
            .catch(() => null)
        : null,
      fetchPgLogWriterAggregate(sutUrls, adminCookie, { fetchImpl }).catch(() => ({
        available: false,
        aggregate: null,
      })),
      redisClient ? redisClient.zcard(inflightKey).catch(() => 0) : 0,
    ])

    const usageLogsCount = usageRes?.rows?.[0] ? num(usageRes.rows[0].cnt) : null
    const apiKeysReqSum = keysRes?.rows?.[0] ? num(keysRes.rows[0].cnt) : null
    const pgLogWriterQueued = writerRes?.available ? num(writerRes.aggregate?.queued) : 0
    const liveInflight = num(inflightCard)

    lastState = { usageLogsCount, apiKeysReqSum, pgLogWriterQueued, liveInflight }

    const queuesEmpty = pgLogWriterQueued === 0 && liveInflight === 0
    const countsUnchanged =
      prevUsageCount !== null && usageLogsCount === prevUsageCount && apiKeysReqSum === prevApiKeyReqSum
    const reachedExpected =
      expectedUsageLogCount != null && usageLogsCount != null && usageLogsCount >= expectedUsageLogCount

    if (queuesEmpty && (countsUnchanged || (reachedExpected && polls >= 1))) {
      stableStreak++
    } else {
      stableStreak = 0
    }

    prevUsageCount = usageLogsCount
    prevApiKeyReqSum = apiKeysReqSum

    const elapsedMs = Date.now() - start
    if (stableStreak >= stableChecks || elapsedMs >= drainTimeoutMs) {
      return {
        drained: stableStreak >= stableChecks,
        elapsedMs,
        polls,
        ...lastState,
      }
    }

    await sleep(Math.min(pollIntervalMs, Math.max(10, drainTimeoutMs - elapsedMs)))
  }
}

/**
 * Evaluate closed-loop verification data against zero-loss / zero-drift assertions.
 */
export function evaluateClosedLoopAssertions(
  { expectedCompleted = 0, actualUsageLogs = 0, usageLogStatusBreakdown = {}, apiKeyBilling, pgLogWriter, redis },
  { maxLossRate = 0, strictOverflowDirect = true, strictFallbacks = true } = {},
) {
  const failures = []

  // 1. PG usage_logs completeness
  const missingRows = Math.max(0, expectedCompleted - actualUsageLogs)
  const extraRows = Math.max(0, actualUsageLogs - expectedCompleted)
  const lossRate = expectedCompleted > 0 ? round6(missingRows / expectedCompleted) : 0
  const usageLogsPassed = missingRows === 0 || lossRate <= maxLossRate
  if (!usageLogsPassed) {
    failures.push(
      `usage_logs loss: expected=${expectedCompleted}, actual=${actualUsageLogs}, missing=${missingRows} (${(lossRate * 100).toFixed(4)}%)`,
    )
  }

  // 2. api_keys billing counters vs SUM(usage_logs)
  const billingPassed = Boolean(apiKeyBilling?.passed)
  if (!billingPassed) {
    failures.push(`api_keys billing drift on ${apiKeyBilling?.driftedKeyCount ?? 0} key(s)`)
  }

  // 3. PgLogWriter counters
  let pgLogWriterPassed = true
  if (pgLogWriter?.available && pgLogWriter.counters) {
    const c = pgLogWriter.counters
    if (c.dropped > 0) {
      pgLogWriterPassed = false
      failures.push(`PgLogWriter dropped=${c.dropped}`)
    }
    if (c.errors > 0) {
      pgLogWriterPassed = false
      failures.push(`PgLogWriter errors=${c.errors}`)
    }
    if (c.queued > 0) {
      pgLogWriterPassed = false
      failures.push(`PgLogWriter queued=${c.queued} remaining after drain`)
    }
    if (strictOverflowDirect && c.overflowDirect > 0) {
      pgLogWriterPassed = false
      failures.push(`PgLogWriter overflowDirect=${c.overflowDirect}`)
    }
    if (strictFallbacks && c.fallbacks > 0) {
      pgLogWriterPassed = false
      failures.push(`PgLogWriter fallbacks=${c.fallbacks}`)
    }
  }

  // 4. Redis evictions & live:inflight orphans
  let redisPassed = true
  if (redis?.available) {
    if (num(redis.evictedKeys) > 0) {
      redisPassed = false
      failures.push(`Redis evicted_keys=${redis.evictedKeys}`)
    }
    if (num(redis.liveInflightOrphans) > 0) {
      redisPassed = false
      failures.push(`Redis ${redis.inflightKey} orphans=${redis.liveInflightOrphans}`)
    }
  }

  return {
    passed: usageLogsPassed && billingPassed && pgLogWriterPassed && redisPassed,
    failures,
    checks: {
      usageLogs: {
        passed: usageLogsPassed,
        expectedCompleted,
        actualUsageLogs,
        missingRows,
        extraRows,
        lossRate,
        statusBreakdown: usageLogStatusBreakdown,
      },
      apiKeyBilling: {
        ...apiKeyBilling,
        passed: billingPassed,
      },
      pgLogWriter: {
        ...pgLogWriter,
        passed: pgLogWriterPassed,
      },
      redis: {
        ...redis,
        passed: redisPassed,
      },
    },
  }
}

/**
 * Run complete closed-loop verification against PG 18, Redis 8, and SUT instances.
 */
export async function verifyClosedLoop({
  pgUrl = '',
  redisUrl = '',
  sutUrls = [],
  adminCookie = '',
  expectedCompleted = 0,
  sinceIso = null,
  baselineUsageLogCount = 0,
  baselineEvictedKeys = 0,
  baselinePgLogWriter = null,
  baselineApiKeysByKey = null,
  redisKeyPrefix = DEFAULT_REDIS_KEY_PREFIX,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  stableChecks = DEFAULT_STABLE_CHECKS,
  costToleranceUsd = DEFAULT_COST_TOLERANCE_USD,
  maxLossRate = 0,
  strictOverflowDirect = true,
  strictFallbacks = true,
  triggerFlush = null,
  pgClient = null,
  redisClient = null,
  fetchImpl = fetch,
} = {}) {
  let ownedPg = null
  let ownedRedis = null
  let activePg = pgClient
  let activeRedis = redisClient

  try {
    if (!activePg && pgUrl) {
      ownedPg = new pg.Pool({ connectionString: pgUrl, max: 4, idleTimeoutMillis: 15_000 })
      activePg = ownedPg
    }
    if (!activeRedis && redisUrl) {
      ownedRedis = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 3_000,
        lazyConnect: true,
      })
      await ownedRedis.connect()
      activeRedis = ownedRedis
    }

    const drain = await waitForDrain({
      pgClient: activePg,
      redisClient: activeRedis,
      sutUrls,
      adminCookie,
      fetchImpl,
      redisKeyPrefix,
      drainTimeoutMs,
      pollIntervalMs,
      stableChecks,
      expectedUsageLogCount: sinceIso ? null : baselineUsageLogCount + expectedCompleted,
      triggerFlush,
    })

    // 1. PG usage_logs count & status breakdown
    let actualUsageLogs = 0
    const usageLogStatusBreakdown = {}
    let apiKeyRows = []
    let usageLogAggRows = []

    if (activePg) {
      const whereClause = sinceIso ? 'WHERE created_at >= $1' : ''
      const params = sinceIso ? [sinceIso] : []

      const [statusRes, keysRes, aggRes] = await Promise.all([
        activePg.query(
          `SELECT COALESCE(status, 0) AS status, COUNT(*)::bigint AS cnt FROM usage_logs ${whereClause} GROUP BY COALESCE(status, 0)`,
          params,
        ),
        activePg.query(`
          SELECT id, quota_requests_used, requests, tokens_in, tokens_out,
                 cache_read_tokens, cache_creation_tokens, quota_used
          FROM api_keys
          WHERE deleted_at IS NULL
        `),
        activePg.query(
          `
          SELECT
            api_key_id,
            COUNT(*)::bigint AS total_logs,
            COUNT(*) FILTER (WHERE status >= 200 AND status < 300)::bigint AS ok_logs,
            COALESCE(SUM(COALESCE(input_tokens, 0)), 0)::bigint AS sum_tokens_in,
            COALESCE(SUM(COALESCE(output_tokens, 0)), 0)::bigint AS sum_tokens_out,
            COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0)::bigint AS sum_cache_read,
            COALESCE(SUM(COALESCE(cache_creation_tokens, 0)), 0)::bigint AS sum_cache_creation,
            COALESCE(SUM(COALESCE(actual_cost, total_cost * COALESCE(rate_multiplier, 1), total_cost, 0)), 0)::double precision AS sum_cost
          FROM usage_logs
          ${sinceIso ? 'WHERE api_key_id IS NOT NULL AND created_at >= $1' : 'WHERE api_key_id IS NOT NULL'}
          GROUP BY api_key_id
        `,
          params,
        ),
      ])

      let totalRowsInScope = 0
      for (const row of statusRes?.rows || []) {
        const cnt = num(row.cnt)
        totalRowsInScope += cnt
        usageLogStatusBreakdown[String(row.status)] = cnt
      }
      actualUsageLogs = sinceIso ? totalRowsInScope : Math.max(0, totalRowsInScope - baselineUsageLogCount)
      apiKeyRows = keysRes?.rows || []
      usageLogAggRows = aggRes?.rows || []
    }

    const apiKeyBilling = reconcileApiKeyBilling(apiKeyRows, usageLogAggRows, {
      costToleranceUsd,
      baselineByKey: baselineApiKeysByKey,
    })

    // 3. PgLogWriter stats
    const writerInfo = await fetchPgLogWriterAggregate(sutUrls, adminCookie, { fetchImpl })
    let pgLogWriter = { available: false, counters: null, note: 'pg_log_writer not exposed by SUT' }
    if (writerInfo.available && writerInfo.aggregate) {
      const a = writerInfo.aggregate
      const b = baselinePgLogWriter || {}
      pgLogWriter = {
        available: true,
        counters: {
          queued: a.queued,
          enqueued: Math.max(0, a.enqueued - num(b.enqueued)),
          flushed: Math.max(0, a.flushed - num(b.flushed)),
          batches: Math.max(0, a.batches - num(b.batches)),
          overflowDirect: Math.max(0, a.overflowDirect - num(b.overflowDirect)),
          fallbacks: Math.max(0, a.fallbacks - num(b.fallbacks)),
          dropped: Math.max(0, a.dropped - num(b.dropped)),
          errors: Math.max(0, a.errors - num(b.errors)),
        },
      }
    }

    // 4. Redis evicted_keys & vm2api:live:inflight orphans
    const inflightKey = `${redisKeyPrefix}live:inflight`
    let redis = { available: false, inflightKey, evictedKeys: 0, liveInflightOrphans: 0, sampleOrphans: [] }
    if (activeRedis) {
      let infoRaw = ''
      try {
        infoRaw = await activeRedis.info('stats')
      } catch {
        infoRaw = await activeRedis.info()
      }
      const parsed = parseRedisInfo(infoRaw)
      const evictedKeys = Math.max(0, parsed.evictedKeys - num(baselineEvictedKeys))
      const liveInflightOrphans = num(await activeRedis.zcard(inflightKey).catch(() => 0))
      const sampleOrphans =
        liveInflightOrphans > 0 && typeof activeRedis.zrange === 'function'
          ? await activeRedis.zrange(inflightKey, 0, 9).catch(() => [])
          : []
      redis = {
        available: true,
        inflightKey,
        evictedKeys,
        evictedKeysTotal: parsed.evictedKeys,
        liveInflightOrphans,
        sampleOrphans,
      }
    }

    const evaluation = evaluateClosedLoopAssertions(
      {
        expectedCompleted,
        actualUsageLogs,
        usageLogStatusBreakdown,
        apiKeyBilling,
        pgLogWriter,
        redis,
      },
      { maxLossRate, strictOverflowDirect, strictFallbacks },
    )

    return {
      verifiedAtIso: new Date().toISOString(),
      drain,
      ...evaluation,
    }
  } finally {
    if (ownedPg) await ownedPg.end().catch(() => {})
    if (ownedRedis) await ownedRedis.quit().catch(() => ownedRedis.disconnect())
  }
}

export function parseVerifyArgs(argv = process.argv.slice(2)) {
  const args = {
    session: '',
    expectedCompleted: 0,
    sinceIso: null,
    drainTimeoutMs: DEFAULT_DRAIN_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    redisKeyPrefix: DEFAULT_REDIS_KEY_PREFIX,
    maxLossRate: 0,
    out: '',
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = () => argv[++i]
    if (flag === '--session') args.session = next()
    else if (flag === '--expected-completed') args.expectedCompleted = Number(next())
    else if (flag === '--since') args.sinceIso = next()
    else if (flag === '--drain-timeout-ms') args.drainTimeoutMs = Number(next())
    else if (flag === '--poll-interval-ms') args.pollIntervalMs = Number(next())
    else if (flag === '--redis-prefix') args.redisKeyPrefix = next()
    else if (flag === '--max-loss-rate') args.maxLossRate = Number(next())
    else if (flag === '--out') args.out = next()
  }
  return args
}

const isDirectCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectCli) {
  ;(async () => {
    const args = parseVerifyArgs()
    if (!args.session) throw new Error('--session <session.json> is required')
    const session = JSON.parse(fs.readFileSync(path.resolve(args.session), 'utf8'))
    const result = await verifyClosedLoop({
      pgUrl: session.pgUrl,
      redisUrl: session.redisUrl,
      sutUrls: session.sutUrls || [],
      adminCookie: session.adminCookie || '',
      expectedCompleted: args.expectedCompleted,
      sinceIso: args.sinceIso,
      drainTimeoutMs: args.drainTimeoutMs,
      pollIntervalMs: args.pollIntervalMs,
      redisKeyPrefix: args.redisKeyPrefix,
      maxLossRate: args.maxLossRate,
    })
    const text = JSON.stringify(result, null, 2)
    if (args.out) {
      fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
      fs.writeFileSync(path.resolve(args.out), text, 'utf8')
    }
    process.stdout.write(`${text}\n`)
    if (!result.passed) process.exitCode = 2
  })().catch((err) => {
    process.stderr.write(`${err?.stack || err?.message || String(err)}\n`)
    process.exitCode = 1
  })
}
