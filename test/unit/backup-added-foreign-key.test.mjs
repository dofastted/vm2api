import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { BackupService } from '../../src/lib/admin/backup-service.mjs'

test('an older snapshot restores after a later same-schema parent adds an FK to a baseline table (019 shape)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-648-restore-fk-'))
  const service = new BackupService({ dataDir: path.join(root, 'data'), projectRoot: null, sharedTasks: null })
  t.after(async () => {
    await service.stopScheduler()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const db = getDb()
  const settings = new SettingsRepo(db)
  await settings.set('synthetic-restore-marker', 'before')
  const backup = await service.createBackup()
  // The same dependency shape as 019: a pre-existing request_attempts table
  // gains a foreign key to a newer request-context table outside the archive.
  await db.exec(`CREATE TABLE fixture_later_request_context(id text PRIMARY KEY);
    ALTER TABLE request_attempts ADD COLUMN fixture_request_context text
      REFERENCES fixture_later_request_context(id)`)
  await settings.set('synthetic-restore-marker', 'after')
  assert.equal((await service.restoreBackup(backup.id)).ok, true)
  assert.equal(await settings.get('synthetic-restore-marker'), 'before')
  assert.equal(
    (await db.prepare('SELECT to_regclass($1) AS name').get(`${db.schema}.fixture_later_request_context`)).name,
    null,
  )
})
