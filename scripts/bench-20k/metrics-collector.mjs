#!/usr/bin/env node
/**
 * Full-spectrum telemetry collector for PG 18 + Redis 8 + SUT probes + PgLogWriter + Mock Upstream.
 *
 * All PG queries strictly read O(1) system statistics catalogs so telemetry sampling never perturbs
 * the SUT under test. Supports dependency injection (`pgClient`, `redisClient`, `fetchImpl`) for
 * fast zero-Docker unit testing alongside live PG/Redis/HTTP collection.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Redis from 'ioredis'
import pg from 'pg'

export const FOCUS_PG_TABLES = ['usage_logs', 'request_attempts', 'api_keys', 'accounts', 'account_runtime']

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function round3(v) {
  return Math.round(v * 1000) / 1000
}

/**
 * Parse Redis `INFO` (and `INFO commandstats`) text into structured metrics & top commandstats.
 */
export function parseRedisInfo(rawText) {
  const kv = {}
  const commandstats = {}
  if (typeof rawText === 'string') {
    for (const rawLine of rawText.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const colon = line.indexOf(':')
      if (colon <= 0) continue
      const key = line.slice(0, colon)
      const val = line.slice(colon + 1)
      if (key.startsWith('cmdstat_')) {
        const cmd = key.slice('cmdstat_'.length)
        const entry = { cmd, calls: 0, usec: 0, usecPerCall: 0 }
        for (const pair of val.split(',')) {
          const eq = pair.indexOf('=')
          if (eq <= 0) continue
          const k = pair.slice(0, eq)
          const v = Number(pair.slice(eq + 1))
          if (!Number.isFinite(v)) continue
          if (k === 'calls') entry.calls = v
          else if (k === 'usec') entry.usec = v
          else if (k === 'usec_per_call') entry.usecPerCall = v
        }
        commandstats[cmd] = entry
      } else {
        kv[key] = val
      }
    }
  }

  const hits = num(kv.keyspace_hits)
  const misses = num(kv.keyspace_misses)
  const hitRate = hits + misses > 0 ? round3(hits / (hits + misses)) : null

  const topCommandStats = Object.values(commandstats)
    .sort((a, b) => b.usec - a.usec)
    .slice(0, 15)

  return {
    usedMemoryBytes: num(kv.used_memory),
    usedMemoryRssBytes: num(kv.used_memory_rss),
    maxmemoryBytes: num(kv.maxmemory),
    evictedKeys: num(kv.evicted_keys),
    expiredKeys: num(kv.expired_keys),
    instantaneousOpsPerSec: num(kv.instantaneous_ops_per_sec),
    totalCommandsProcessed: num(kv.total_commands_processed),
    keyspaceHits: hits,
    keyspaceMisses: misses,
    hitRate,
    aofEnabled: num(kv.aof_enabled) === 1,
    aofDelayedFsync: num(kv.aof_delayed_fsync),
    aofCurrentSizeBytes: num(kv.aof_current_size),
    connectedClients: num(kv.connected_clients),
    commandstats,
    topCommandStats,
  }
}

async function fetchJsonSafe(url, { headers = {}, method = 'GET', timeoutMs = 5_000, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { method, headers, signal: controller.signal })
    if (!res.ok) {
      return { ok: false, status: res.status, data: null }
    }
    const text = await res.text()
    try {
      return { ok: true, status: res.status, data: text ? JSON.parse(text) : {} }
    } catch {
      return { ok: true, status: res.status, data: { raw: text } }
    }
  } catch (err) {
    return { ok: false, status: 0, error: err?.message || String(err), data: null }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Reset all SUT in-process probe counters (`POST /reset`) before a benchmark step.
 */
export async function resetSutProbes(probeStatsUrls = [], { fetchImpl = fetch, timeoutMs = 5_000 } = {}) {
  const urls = Array.isArray(probeStatsUrls) ? probeStatsUrls.filter(Boolean) : []
  const results = await Promise.all(
    urls.map(async (raw) => {
      const resetUrl = new URL('/reset', raw).toString()
      const res = await fetchJsonSafe(resetUrl, { method: 'POST', timeoutMs, fetchImpl })
      return { url: resetUrl, ok: res.ok, status: res.status }
    }),
  )
  return results
}

async function samplePostgres(pgClient) {
  if (!pgClient) return null
  const [dbRes, tablesRes, activityRes, walRes, sizeRes] = await Promise.all([
    pgClient.query(`
      SELECT datname, numbackends, xact_commit, xact_rollback,
             blks_read, blks_hit, tup_returned, tup_fetched,
             tup_inserted, tup_updated, tup_deleted,
             deadlocks, temp_files, temp_bytes
      FROM pg_stat_database
      WHERE datname = current_database()
    `),
    pgClient.query(`
      SELECT relname, seq_scan, seq_tup_read, idx_scan, idx_tup_fetch,
             n_tup_ins, n_tup_upd, n_tup_del, n_tup_hot_upd,
             n_live_tup, n_dead_tup, vacuum_count, autovacuum_count
      FROM pg_stat_user_tables
    `),
    pgClient.query(`
      SELECT COALESCE(state, 'unknown') AS state,
             wait_event_type,
             COUNT(*)::bigint AS cnt
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY COALESCE(state, 'unknown'), wait_event_type
    `),
    pgClient
      .query(`
        SELECT wal_records, wal_fpi, wal_bytes, wal_buffers_full
        FROM pg_stat_wal
      `)
      .catch(() => ({ rows: [] })),
    pgClient
      .query(`
        SELECT
          pg_relation_size(c.oid)::bigint AS table_bytes,
          pg_indexes_size(c.oid)::bigint AS index_bytes,
          pg_total_relation_size(c.oid)::bigint AS total_bytes,
          c.reltuples::bigint AS approx_rows
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'usage_logs' AND n.nspname = current_schema()
        LIMIT 1
      `)
      .catch(() => ({ rows: [] })),
  ])

  const dbRow = dbRes?.rows?.[0] || {}
  const blksRead = num(dbRow.blks_read)
  const blksHit = num(dbRow.blks_hit)
  const database = {
    datname: dbRow.datname || null,
    numbackends: num(dbRow.numbackends),
    xactCommit: num(dbRow.xact_commit),
    xactRollback: num(dbRow.xact_rollback),
    blksRead,
    blksHit,
    cacheHitRatio: blksRead + blksHit > 0 ? round3(blksHit / (blksRead + blksHit)) : null,
    tupReturned: num(dbRow.tup_returned),
    tupFetched: num(dbRow.tup_fetched),
    tupInserted: num(dbRow.tup_inserted),
    tupUpdated: num(dbRow.tup_updated),
    tupDeleted: num(dbRow.tup_deleted),
    deadlocks: num(dbRow.deadlocks),
    tempFiles: num(dbRow.temp_files),
    tempBytes: num(dbRow.temp_bytes),
  }

  const focusSet = new Set(FOCUS_PG_TABLES)
  const tables = {}
  const totals = {
    nTupIns: 0,
    nTupUpd: 0,
    nTupDel: 0,
    nTupHotUpd: 0,
    nLiveTup: 0,
    nDeadTup: 0,
    seqScan: 0,
    idxScan: 0,
  }
  for (const row of tablesRes?.rows || []) {
    const entry = {
      seqScan: num(row.seq_scan),
      seqTupRead: num(row.seq_tup_read),
      idxScan: num(row.idx_scan),
      idxTupFetch: num(row.idx_tup_fetch),
      nTupIns: num(row.n_tup_ins),
      nTupUpd: num(row.n_tup_upd),
      nTupDel: num(row.n_tup_del),
      nTupHotUpd: num(row.n_tup_hot_upd),
      nLiveTup: num(row.n_live_tup),
      nDeadTup: num(row.n_dead_tup),
      vacuumCount: num(row.vacuum_count),
      autovacuumCount: num(row.autovacuum_count),
    }
    totals.nTupIns += entry.nTupIns
    totals.nTupUpd += entry.nTupUpd
    totals.nTupDel += entry.nTupDel
    totals.nTupHotUpd += entry.nTupHotUpd
    totals.nLiveTup += entry.nLiveTup
    totals.nDeadTup += entry.nDeadTup
    totals.seqScan += entry.seqScan
    totals.idxScan += entry.idxScan
    if (focusSet.has(row.relname)) {
      tables[row.relname] = entry
    }
  }

  const byState = {}
  let totalConns = 0
  let activeConns = 0
  let idleConns = 0
  let idleInTxConns = 0
  let waitingConns = 0
  for (const row of activityRes?.rows || []) {
    const cnt = num(row.cnt)
    const state = String(row.state || 'unknown')
    totalConns += cnt
    byState[state] = (byState[state] || 0) + cnt
    if (state === 'active') activeConns += cnt
    else if (state === 'idle') idleConns += cnt
    else if (state === 'idle in transaction' || state === 'idle in transaction (aborted)') idleInTxConns += cnt
    if (state === 'active' && row.wait_event_type && row.wait_event_type !== 'Client') {
      waitingConns += cnt
    }
  }

  const walRow = walRes?.rows?.[0] || null
  const wal = walRow
    ? {
        walRecords: num(walRow.wal_records),
        walFpi: num(walRow.wal_fpi),
        walBytes: num(walRow.wal_bytes),
        walBuffersFull: num(walRow.wal_buffers_full),
      }
    : null

  const sizeRow = sizeRes?.rows?.[0] || null
  const usageLogsSize = sizeRow
    ? {
        tableBytes: num(sizeRow.table_bytes),
        indexBytes: num(sizeRow.index_bytes),
        totalBytes: num(sizeRow.total_bytes),
        approxRows: Math.max(0, num(sizeRow.approx_rows)),
      }
    : null

  return {
    database,
    tables,
    tableTotals: totals,
    activity: {
      total: totalConns,
      active: activeConns,
      idle: idleConns,
      idleInTransaction: idleInTxConns,
      waiting: waitingConns,
      byState,
    },
    wal,
    usageLogsSize,
  }
}

async function sampleRedis(redisClient) {
  if (!redisClient) return null
  let raw = ''
  try {
    raw = await redisClient.info('all')
  } catch {
    raw = await redisClient.info()
  }
  if (typeof raw === 'string' && !raw.includes('cmdstat_')) {
    try {
      const cmdRaw = await redisClient.info('commandstats')
      if (typeof cmdRaw === 'string') raw = `${raw}\n${cmdRaw}`
    } catch {
      // ignore if commandstats unsupported
    }
  }
  return parseRedisInfo(raw)
}

async function sampleSutProbes(probeStatsUrls = [], { fetchImpl = fetch, timeoutMs = 5_000 } = {}) {
  const urls = Array.isArray(probeStatsUrls) ? probeStatsUrls.filter(Boolean) : []
  if (urls.length === 0) return null

  const instances = await Promise.all(
    urls.map(async (url) => {
      const res = await fetchJsonSafe(url, { timeoutMs, fetchImpl })
      return { url, ok: res.ok, data: res.data || null }
    }),
  )

  const okList = instances.filter((i) => i.ok && i.data)
  if (okList.length === 0) {
    return { instances, aggregate: null }
  }

  let elP50 = 0
  let elP95 = 0
  let elP99 = 0
  let elMax = 0
  let awCount = 0
  let awTotalMs = 0
  let awMaxMs = 0
  let rssBytes = 0
  let heapUsedBytes = 0
  let heapTotalBytes = 0
  let cpuUserUs = 0
  let cpuSystemUs = 0
  let hasCumulativeCpu = true
  let cpuCumulativeUserUs = 0
  let cpuCumulativeSystemUs = 0

  for (const { data } of okList) {
    const el = data.eventLoopDelayMs || {}
    elP50 = Math.max(elP50, num(el.p50))
    elP95 = Math.max(elP95, num(el.p95))
    elP99 = Math.max(elP99, num(el.p99))
    elMax = Math.max(elMax, num(el.max))

    const aw = data.atomicsWait || {}
    awCount += num(aw.count)
    awTotalMs += num(aw.totalMs)
    awMaxMs = Math.max(awMaxMs, num(aw.maxMs))

    const mem = data.memory || {}
    rssBytes += num(mem.rss)
    heapUsedBytes += num(mem.heapUsed)
    heapTotalBytes += num(mem.heapTotal)

    const cpu = data.cpuUsage || {}
    cpuUserUs += num(cpu.userUs ?? cpu.user)
    cpuSystemUs += num(cpu.systemUs ?? cpu.system)
    if (cpu.cumulativeUserUs != null && cpu.cumulativeSystemUs != null) {
      cpuCumulativeUserUs += num(cpu.cumulativeUserUs)
      cpuCumulativeSystemUs += num(cpu.cumulativeSystemUs)
    } else {
      hasCumulativeCpu = false
    }
  }

  return {
    instanceCount: okList.length,
    instances,
    aggregate: {
      eventLoopDelayMs: {
        p50: round3(elP50),
        p95: round3(elP95),
        p99: round3(elP99),
        max: round3(elMax),
      },
      atomicsWait: {
        count: awCount,
        totalMs: round3(awTotalMs),
        maxMs: round3(awMaxMs),
      },
      memory: {
        rssBytes,
        heapUsedBytes,
        heapTotalBytes,
        rssMb: round3(rssBytes / (1024 * 1024)),
        heapUsedMb: round3(heapUsedBytes / (1024 * 1024)),
      },
      cpuUsage: {
        userUs: cpuUserUs,
        systemUs: cpuSystemUs,
        cumulativeUserUs: hasCumulativeCpu ? cpuCumulativeUserUs : null,
        cumulativeSystemUs: hasCumulativeCpu ? cpuCumulativeSystemUs : null,
      },
    },
  }
}

export function extractPgLogWriterStats(payload) {
  if (!payload || typeof payload !== 'object') return null
  const writer = payload.config?.pg_log_writer ?? payload.data?.config?.pg_log_writer ?? payload.pg_log_writer ?? null
  if (!writer || typeof writer !== 'object') return null
  return {
    queued: num(writer.queued),
    enqueued: num(writer.enqueued),
    flushed: num(writer.flushed),
    batches: num(writer.batches),
    fallbacks: num(writer.fallbacks),
    overflowDirect: num(writer.overflowDirect),
    dropped: num(writer.dropped),
    errors: num(writer.errors),
    lastFlushMs: num(writer.lastFlushMs),
    queues: {
      usageLogs: num(writer.queues?.usageLogs),
      attempts: num(writer.queues?.attempts),
      debugRecords: num(writer.queues?.debugRecords),
    },
  }
}

async function samplePanelRequestLogStats(
  sutUrls = [],
  adminCookie = '',
  { fetchImpl = fetch, timeoutMs = 5_000 } = {},
) {
  const urls = Array.isArray(sutUrls) ? sutUrls.filter(Boolean) : []
  if (urls.length === 0) return null

  const headers = adminCookie ? { cookie: adminCookie } : {}
  const instances = await Promise.all(
    urls.map(async (raw) => {
      const endpoint = new URL('/api/panel/request-logs/stats', raw).toString()
      const res = await fetchJsonSafe(endpoint, { headers, timeoutMs, fetchImpl })
      const writer = res.ok ? extractPgLogWriterStats(res.data) : null
      return {
        url: endpoint,
        ok: res.ok,
        status: res.status,
        backend: res.data?.config?.backend ?? null,
        totalRows: res.data?.config?.total_rows != null ? num(res.data.config.total_rows) : null,
        inflightCount: res.data?.config?.inflight_count != null ? num(res.data.config.inflight_count) : null,
        pgLogWriter: writer,
      }
    }),
  )

  const writers = instances.map((i) => i.pgLogWriter).filter(Boolean)
  const aggregatePgLogWriter =
    writers.length > 0
      ? {
          queued: writers.reduce((s, w) => s + w.queued, 0),
          enqueued: writers.reduce((s, w) => s + w.enqueued, 0),
          flushed: writers.reduce((s, w) => s + w.flushed, 0),
          batches: writers.reduce((s, w) => s + w.batches, 0),
          fallbacks: writers.reduce((s, w) => s + w.fallbacks, 0),
          overflowDirect: writers.reduce((s, w) => s + w.overflowDirect, 0),
          dropped: writers.reduce((s, w) => s + w.dropped, 0),
          errors: writers.reduce((s, w) => s + w.errors, 0),
          lastFlushMsMax: Math.max(...writers.map((w) => w.lastFlushMs)),
          queues: {
            usageLogs: writers.reduce((s, w) => s + w.queues.usageLogs, 0),
            attempts: writers.reduce((s, w) => s + w.queues.attempts, 0),
            debugRecords: writers.reduce((s, w) => s + w.queues.debugRecords, 0),
          },
        }
      : null

  return { instances, pgLogWriter: aggregatePgLogWriter }
}

async function sampleMockUpstream(mockUpstreamUrl, { fetchImpl = fetch, timeoutMs = 5_000 } = {}) {
  if (!mockUpstreamUrl) return null
  const statsUrl = new URL('/__stats', mockUpstreamUrl).toString()
  const res = await fetchJsonSafe(statsUrl, { timeoutMs, fetchImpl })
  if (!res.ok || !res.data) return null
  return {
    requests: num(res.data.requests),
    active: num(res.data.active),
    completed: num(res.data.completed),
    injected429: num(res.data.injected429),
    injected502: num(res.data.injected502),
    bytesIn: num(res.data.bytesIn),
    bytesOut: num(res.data.bytesOut),
    avgUpstreamMs: res.data.avgUpstreamMs != null ? num(res.data.avgUpstreamMs) : null,
    avgTtftMs: res.data.avgTtftMs != null ? num(res.data.avgTtftMs) : null,
    config: res.data.config || null,
  }
}

/**
 * Create a reusable telemetry collector for PG 18, Redis 8, SUT probes, PgLogWriter, and mock upstream.
 */
export function createMetricsCollector({
  pgUrl = '',
  redisUrl = '',
  probeStatsUrls = [],
  sutUrls = [],
  adminCookie = '',
  mockUpstreamUrl = '',
  pgClient = null,
  redisClient = null,
  fetchImpl = fetch,
  timeoutMs = 5_000,
} = {}) {
  let ownedPg = null
  let ownedRedis = null
  let activePg = pgClient
  let activeRedis = redisClient

  async function ensureClients() {
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
  }

  return {
    async snapshot() {
      await ensureClients()
      const tsMs = Date.now()
      const [postgres, redis, probes, panelStats, mockUpstream] = await Promise.all([
        samplePostgres(activePg).catch((err) => ({ error: err?.message || String(err) })),
        sampleRedis(activeRedis).catch((err) => ({ error: err?.message || String(err) })),
        sampleSutProbes(probeStatsUrls, { fetchImpl, timeoutMs }),
        samplePanelRequestLogStats(sutUrls, adminCookie, { fetchImpl, timeoutMs }),
        sampleMockUpstream(mockUpstreamUrl, { fetchImpl, timeoutMs }),
      ])
      return {
        tsMs,
        tsIso: new Date(tsMs).toISOString(),
        postgres,
        redis,
        probes,
        panelStats,
        mockUpstream,
      }
    },

    async resetProbes() {
      return resetSutProbes(probeStatsUrls, { fetchImpl, timeoutMs })
    },

    async close() {
      const tasks = []
      if (ownedPg) {
        tasks.push(ownedPg.end().catch(() => {}))
        ownedPg = null
      }
      if (ownedRedis) {
        tasks.push(ownedRedis.quit().catch(() => ownedRedis.disconnect()))
        ownedRedis = null
      }
      await Promise.all(tasks)
    },
  }
}

function deltaNonNeg(after, before) {
  return Math.max(0, num(after) - num(before))
}

/**
 * Compute precise per-step deltas and rates between two collector snapshots.
 */
export function diffSnapshots(before, after, { completedRequests = 0 } = {}) {
  const elapsedSec = Math.max(0.001, (num(after?.tsMs) - num(before?.tsMs)) / 1000)

  // PostgreSQL deltas
  let postgres = null
  if (before?.postgres && after?.postgres && !before.postgres.error && !after.postgres.error) {
    const bDb = before.postgres.database || {}
    const aDb = after.postgres.database || {}
    const blksReadDelta = deltaNonNeg(aDb.blksRead, bDb.blksRead)
    const blksHitDelta = deltaNonNeg(aDb.blksHit, bDb.blksHit)
    const xactCommitDelta = deltaNonNeg(aDb.xactCommit, bDb.xactCommit)
    const xactRollbackDelta = deltaNonNeg(aDb.xactRollback, bDb.xactRollback)

    const bTot = before.postgres.tableTotals || {}
    const aTot = after.postgres.tableTotals || {}
    const pgInsertsDelta = deltaNonNeg(aTot.nTupIns, bTot.nTupIns)
    const pgUpdatesDelta = deltaNonNeg(aTot.nTupUpd, bTot.nTupUpd)
    const pgDeletesDelta = deltaNonNeg(aTot.nTupDel, bTot.nTupDel)
    const pgSeqScansDelta = deltaNonNeg(aTot.seqScan, bTot.seqScan)
    const pgIdxScansDelta = deltaNonNeg(aTot.idxScan, bTot.idxScan)

    const tablesDelta = {}
    for (const tbl of FOCUS_PG_TABLES) {
      const bt = before.postgres.tables?.[tbl]
      const at = after.postgres.tables?.[tbl]
      if (!bt && !at) continue
      tablesDelta[tbl] = {
        insertsDelta: deltaNonNeg(at?.nTupIns, bt?.nTupIns),
        updatesDelta: deltaNonNeg(at?.nTupUpd, bt?.nTupUpd),
        deletesDelta: deltaNonNeg(at?.nTupDel, bt?.nTupDel),
        seqScansDelta: deltaNonNeg(at?.seqScan, bt?.seqScan),
        idxScansDelta: deltaNonNeg(at?.idxScan, bt?.idxScan),
        deadTupEnd: num(at?.nDeadTup),
        liveTupEnd: num(at?.nLiveTup),
      }
    }

    const walBytesDelta =
      before.postgres.wal && after.postgres.wal
        ? deltaNonNeg(after.postgres.wal.walBytes, before.postgres.wal.walBytes)
        : null
    const walRecordsDelta =
      before.postgres.wal && after.postgres.wal
        ? deltaNonNeg(after.postgres.wal.walRecords, before.postgres.wal.walRecords)
        : null
    const walBuffersFullDelta =
      before.postgres.wal && after.postgres.wal
        ? deltaNonNeg(after.postgres.wal.walBuffersFull, before.postgres.wal.walBuffersFull)
        : null

    const usageLogsSizeGrowthBytes =
      before.postgres.usageLogsSize && after.postgres.usageLogsSize
        ? Math.max(0, after.postgres.usageLogsSize.totalBytes - before.postgres.usageLogsSize.totalBytes)
        : null

    postgres = {
      xactCommitDelta,
      xactRollbackDelta,
      xactPerSec: round3((xactCommitDelta + xactRollbackDelta) / elapsedSec),
      cacheHitRatioDelta:
        blksReadDelta + blksHitDelta > 0 ? round3(blksHitDelta / (blksReadDelta + blksHitDelta)) : null,
      deadlocksDelta: deltaNonNeg(aDb.deadlocks, bDb.deadlocks),
      tempBytesDelta: deltaNonNeg(aDb.tempBytes, bDb.tempBytes),
      pgInsertsDelta,
      pgInsertsPerSec: round3(pgInsertsDelta / elapsedSec),
      pgUpdatesDelta,
      pgUpdatesPerSec: round3(pgUpdatesDelta / elapsedSec),
      pgDeletesDelta,
      pgSeqScansDelta,
      pgIdxScansDelta,
      tablesDelta,
      walBytesDelta,
      walBytesPerSec: walBytesDelta != null ? round3(walBytesDelta / elapsedSec) : null,
      walMBPerSec: walBytesDelta != null ? round3(walBytesDelta / (1024 * 1024) / elapsedSec) : null,
      walRecordsDelta,
      walBuffersFullDelta,
      usageLogsSizeEnd: after.postgres.usageLogsSize || null,
      usageLogsSizeGrowthBytes,
      activityEnd: after.postgres.activity || null,
    }
  }

  // Redis deltas
  let redis = null
  if (before?.redis && after?.redis && !before.redis.error && !after.redis.error) {
    const bR = before.redis
    const aR = after.redis
    const totalCommandsDelta = deltaNonNeg(aR.totalCommandsProcessed, bR.totalCommandsProcessed)
    const hitsDelta = deltaNonNeg(aR.keyspaceHits, bR.keyspaceHits)
    const missesDelta = deltaNonNeg(aR.keyspaceMisses, bR.keyspaceMisses)

    const topCommandStatsDelta = []
    const aCmds = aR.commandstats || {}
    const bCmds = bR.commandstats || {}
    for (const [cmd, aEntry] of Object.entries(aCmds)) {
      const bEntry = bCmds[cmd] || { calls: 0, usec: 0 }
      const calls = deltaNonNeg(aEntry.calls, bEntry.calls)
      const usec = deltaNonNeg(aEntry.usec, bEntry.usec)
      if (calls > 0 || usec > 0) {
        topCommandStatsDelta.push({
          cmd,
          calls,
          usec,
          usecPerCall: calls > 0 ? round3(usec / calls) : 0,
        })
      }
    }
    topCommandStatsDelta.sort((x, y) => y.usec - x.usec)

    redis = {
      totalCommandsDelta,
      redisOpsPerSec: round3(totalCommandsDelta / elapsedSec),
      instantaneousOpsPerSecEnd: aR.instantaneousOpsPerSec,
      usedMemoryEndBytes: aR.usedMemoryBytes,
      usedMemoryEndMb: round3(aR.usedMemoryBytes / (1024 * 1024)),
      maxmemoryBytes: aR.maxmemoryBytes,
      evictedKeysDelta: deltaNonNeg(aR.evictedKeys, bR.evictedKeys),
      evictedKeysEnd: aR.evictedKeys,
      keyspaceHitsDelta: hitsDelta,
      keyspaceMissesDelta: missesDelta,
      hitRateDelta: hitsDelta + missesDelta > 0 ? round3(hitsDelta / (hitsDelta + missesDelta)) : null,
      aofDelayedFsyncDelta: deltaNonNeg(aR.aofDelayedFsync, bR.aofDelayedFsync),
      aofDelayedFsyncEnd: aR.aofDelayedFsync,
      topCommandStatsDelta: topCommandStatsDelta.slice(0, 10),
    }
  }

  // SUT Probe deltas
  let probes = null
  const bAgg = before?.probes?.aggregate
  const aAgg = after?.probes?.aggregate
  if (aAgg) {
    // Handle case where probes were reset between snapshots or monotonically accumulated
    const awCountDelta =
      bAgg && aAgg.atomicsWait.count >= bAgg.atomicsWait.count
        ? aAgg.atomicsWait.count - bAgg.atomicsWait.count
        : aAgg.atomicsWait.count
    const awTotalMsDelta =
      bAgg && aAgg.atomicsWait.totalMs >= bAgg.atomicsWait.totalMs
        ? aAgg.atomicsWait.totalMs - bAgg.atomicsWait.totalMs
        : aAgg.atomicsWait.totalMs
    const useCumulativeCpu =
      bAgg?.cpuUsage?.cumulativeUserUs != null &&
      aAgg.cpuUsage?.cumulativeUserUs != null &&
      aAgg.cpuUsage.cumulativeUserUs >= bAgg.cpuUsage.cumulativeUserUs
    const cpuUserUsDelta = useCumulativeCpu
      ? aAgg.cpuUsage.cumulativeUserUs - bAgg.cpuUsage.cumulativeUserUs
      : bAgg && aAgg.cpuUsage.userUs >= bAgg.cpuUsage.userUs
        ? aAgg.cpuUsage.userUs - bAgg.cpuUsage.userUs
        : aAgg.cpuUsage.userUs
    const cpuSysUsDelta = useCumulativeCpu
      ? Math.max(0, aAgg.cpuUsage.cumulativeSystemUs - bAgg.cpuUsage.cumulativeSystemUs)
      : bAgg && aAgg.cpuUsage.systemUs >= bAgg.cpuUsage.systemUs
        ? aAgg.cpuUsage.systemUs - bAgg.cpuUsage.systemUs
        : aAgg.cpuUsage.systemUs

    const cpuTotalMsDelta = (cpuUserUsDelta + cpuSysUsDelta) / 1000
    const cpuPct = round3((cpuTotalMsDelta / (elapsedSec * 1000)) * 100)

    probes = {
      instanceCount: after.probes.instanceCount || 1,
      eventLoopDelayMs: aAgg.eventLoopDelayMs,
      atomicsWaitCountDelta: awCountDelta,
      atomicsWaitTotalMsDelta: round3(awTotalMsDelta),
      atomicsWaitMaxMs: aAgg.atomicsWait.maxMs,
      atomicsWaitsPerReq: completedRequests > 0 ? round3(awCountDelta / completedRequests) : 0,
      atomicsWaitMsPerReq: completedRequests > 0 ? round3(awTotalMsDelta / completedRequests) : 0,
      cpuUserMsDelta: round3(cpuUserUsDelta / 1000),
      cpuSystemMsDelta: round3(cpuSysUsDelta / 1000),
      cpuPct,
      rssEndMb: aAgg.memory.rssMb,
      heapUsedEndMb: aAgg.memory.heapUsedMb,
    }
  }

  // PgLogWriter deltas
  let pgLogWriter = null
  const aW = after?.panelStats?.pgLogWriter
  const bW = before?.panelStats?.pgLogWriter
  if (aW) {
    pgLogWriter = {
      queuedEnd: aW.queued,
      enqueuedDelta: deltaNonNeg(aW.enqueued, bW?.enqueued),
      flushedDelta: deltaNonNeg(aW.flushed, bW?.flushed),
      batchesDelta: deltaNonNeg(aW.batches, bW?.batches),
      fallbacksDelta: deltaNonNeg(aW.fallbacks, bW?.fallbacks),
      overflowDirectDelta: deltaNonNeg(aW.overflowDirect, bW?.overflowDirect),
      droppedDelta: deltaNonNeg(aW.dropped, bW?.dropped),
      errorsDelta: deltaNonNeg(aW.errors, bW?.errors),
      lastFlushMsMax: aW.lastFlushMsMax,
      queuesEnd: aW.queues,
    }
  }

  // Mock Upstream deltas
  let mockUpstream = null
  if (before?.mockUpstream && after?.mockUpstream) {
    const bM = before.mockUpstream
    const aM = after.mockUpstream
    mockUpstream = {
      requestsDelta: deltaNonNeg(aM.requests, bM.requests),
      completedDelta: deltaNonNeg(aM.completed, bM.completed),
      activeEnd: aM.active,
      injected429Delta: deltaNonNeg(aM.injected429, bM.injected429),
      injected502Delta: deltaNonNeg(aM.injected502, bM.injected502),
      bytesInDelta: deltaNonNeg(aM.bytesIn, bM.bytesIn),
      bytesOutDelta: deltaNonNeg(aM.bytesOut, bM.bytesOut),
      avgUpstreamMsEnd: aM.avgUpstreamMs ?? null,
      avgTtftMsEnd: aM.avgTtftMs ?? null,
    }
  }

  return {
    elapsedSec: round3(elapsedSec),
    completedRequests,
    postgres,
    redis,
    probes,
    pgLogWriter,
    mockUpstream,
  }
}

export function parseMetricsCollectorArgs(argv = process.argv.slice(2)) {
  const args = { session: '', out: '', resetProbes: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--session') args.session = argv[++i]
    else if (flag === '--out') args.out = argv[++i]
    else if (flag === '--reset-probes') args.resetProbes = true
  }
  return args
}

const isDirectCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectCli) {
  ;(async () => {
    const args = parseMetricsCollectorArgs()
    if (!args.session) throw new Error('--session <session.json> is required')
    const session = JSON.parse(fs.readFileSync(path.resolve(args.session), 'utf8'))
    const collector = createMetricsCollector({
      pgUrl: session.pgUrl,
      redisUrl: session.redisUrl,
      probeStatsUrls: session.probeStatsUrls || [],
      sutUrls: session.sutUrls || [],
      adminCookie: session.adminCookie || '',
      mockUpstreamUrl: session.mockUpstreamUrl || '',
    })
    try {
      const output = args.resetProbes ? await collector.resetProbes() : await collector.snapshot()
      const text = JSON.stringify(output, null, 2)
      if (args.out) {
        fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
        fs.writeFileSync(path.resolve(args.out), text, 'utf8')
      }
      process.stdout.write(`${text}\n`)
    } finally {
      await collector.close()
    }
  })().catch((err) => {
    process.stderr.write(`${err?.stack || err?.message || String(err)}\n`)
    process.exitCode = 1
  })
}
