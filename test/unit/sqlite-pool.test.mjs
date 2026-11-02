import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { closeDatabase, getDb, openDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { readAll, usageRead } from '../../src/lib/db/sqlite-pool.mjs'

test('usage reads run on read-only workers and leave the event loop free', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sqlite-pool-'))
  openDatabase({ dataDir: dir, pooled: true })
  try {
    await readAll('SELECT 1 AS n')
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 5)
    const started = Date.now()
    const rows = await readAll(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 4000000) SELECT max(x) AS n FROM c',
    )
    const elapsed = Date.now() - started
    clearInterval(timer)
    assert.equal(Number(rows[0].n), 4000000)
    assert.ok(elapsed >= 20, `scan finished too fast to observe the loop: ${elapsed}ms`)
    assert.ok(ticks > 0, `main thread did not tick during a ${elapsed}ms scan`)

    await assert.rejects(readAll('CREATE TABLE forbidden_write (id INTEGER)'), /readonly/)

    const local = new UsageLogsRepo(getDb()).totals()
    const remote = await usageRead({ kind: 'repo', method: 'totals' })
    assert.equal(Number(remote.requests), Number(local.requests))
  } finally {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
