import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
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
