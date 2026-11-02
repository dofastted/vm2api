import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { armWriteBehind, flushWrites, pendingWrites, writeBehindArmed } from '../../src/lib/db/write-behind.mjs'

test('finish returns before the usage row is written, and flush commits it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-write-behind-'))
  const db = createDatabase({ dataDir: dir })
  const store = new RequestLogStore({ dataDir: dir, db, mode: 'normal' })
  armWriteBehind(db)
  try {
    const ctx = store.start({ headers: {}, socket: {} }, { protocol: 'anthropic.messages', pathName: '/v1/messages' })
    const summary = store.finish(ctx, { status: 200, model: 'claude-haiku-4-5', input_tokens: 3, output_tokens: 1 })
    assert.equal(pendingWrites() > 0, true)
    assert.equal(store.repo.getByRequestId(summary.request_id), null)
    flushWrites()
    assert.equal(pendingWrites(), 0)
    assert.equal(store.repo.getByRequestId(summary.request_id)?.status, 200)
    assert.equal(writeBehindArmed(), true)
  } finally {
    armWriteBehind(null)
    flushWrites()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('write-behind request attempts bind every declared column', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-write-behind-attempt-'))
  const db = createDatabase({ dataDir: dir })
  const repo = new RequestAttemptsRepo(db)
  armWriteBehind(db)
  try {
    repo.begin({
      requestId: 'attempt-probe',
      attemptNo: 1,
      vmId: 'vm-01',
      accountId: 'account-01',
      model: 'claude-haiku-4-5',
      selectionReason: 'probe',
      waitMs: 3,
      queueWaitMs: 4,
      schedulingMs: 5,
    })
    repo.complete('attempt-probe', 1, { terminalState: 'done', ttftMs: 6, latencyMs: 7 })
    flushWrites()
    const [attempt] = repo.list('attempt-probe')
    assert.equal(attempt.request_id, 'attempt-probe')
    assert.equal(attempt.attempt_no, 1)
    assert.equal(attempt.vm_id, 'vm-01')
    assert.equal(attempt.account_id, 'account-01')
    assert.equal(attempt.model, 'claude-haiku-4-5')
    assert.equal(attempt.selection_reason, 'probe')
    assert.equal(typeof attempt.started_at, 'string')
    assert.equal(typeof attempt.completed_at, 'string')
    assert.equal(attempt.terminal_state, 'done')
    assert.equal(attempt.downstream_committed, false)
    assert.equal(attempt.wait_ms, 3)
    assert.equal(attempt.queue_wait_ms, 4)
    assert.equal(attempt.scheduling_ms, 5)
    assert.equal(attempt.ttft_ms, 6)
    assert.equal(attempt.latency_ms, 7)
  } finally {
    armWriteBehind(null)
    flushWrites()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
