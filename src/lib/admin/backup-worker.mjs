/**
 * Worker entry for the backup pipeline (supports both SQLite and PostgreSQL).
 */

import { parentPort, workerData } from 'node:worker_threads'
import { openDatabase, openDatabaseAsync, closeDatabase, closeDatabaseAsync } from '../db/database.mjs'
import { resolvePgConfig } from '../db/pg/config.mjs'
import { createPgPool } from '../db/pg/pg-pool.mjs'
import { runBackupJob, runPgBackupJob, restorePgSnapshotJob } from './backup-core.mjs'

async function main() {
  if (workerData.op === 'pg_restore') {
    const pgConfig = resolvePgConfig({ connectionString: workerData.pgConnectionString })
    const pool = createPgPool(pgConfig, { maxOverride: 2 })
    try {
      await restorePgSnapshotJob({
        pool,
        connectionString: workerData.pgConnectionString,
        dbFile: workerData.dbFile,
      })
      parentPort.postMessage({ ok: true })
    } catch (e) {
      parentPort.postMessage({
        ok: false,
        error: { message: String((e && e.message) || e), code: (e && e.code) || null },
      })
    } finally {
      await pool.end().catch(() => {})
    }
    return
  }

  if (workerData.engine === 'postgres') {
    try {
      await openDatabaseAsync({
        dataDir: workerData.dataDir,
        driver: 'postgres',
        connectionString: workerData.pgConnectionString,
        pooled: false,
        enableAggregator: false,
      })
      const rec = await runPgBackupJob(workerData.ctx, workerData.job)
      parentPort.postMessage({ ok: true, rec })
    } catch (e) {
      parentPort.postMessage({
        ok: false,
        error: { message: String((e && e.message) || e), code: (e && e.code) || null },
      })
    } finally {
      try {
        await closeDatabaseAsync()
      } catch {}
    }
    return
  }

  try {
    openDatabase({ dataDir: workerData.dataDir })
    const rec = runBackupJob(workerData.ctx, workerData.job)
    parentPort.postMessage({ ok: true, rec })
  } catch (e) {
    parentPort.postMessage({
      ok: false,
      error: { message: String((e && e.message) || e), code: (e && e.code) || null },
    })
  } finally {
    try {
      closeDatabase()
    } catch {}
  }
}

void main()
