/** PostgreSQL archive worker; the parent owns the exported snapshot transaction. */
import { parentPort, workerData } from 'node:worker_threads'
import { runBackupJob } from './backup-core.mjs'

try {
  const rec = await runBackupJob(workerData.ctx, workerData.job, () => {
    parentPort.postMessage({ type: 'files-copied' })
  })
  parentPort.postMessage({ ok: true, rec })
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: { message: String(error.message || error), code: error.code || 'backup_failed' },
  })
}
