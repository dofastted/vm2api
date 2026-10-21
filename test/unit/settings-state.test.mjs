import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb, withTransaction } from '../../src/lib/db/database.mjs'
import { RuntimeSettings } from '../../src/lib/db/settings-state.mjs'

test('settings cache changes only when its transaction commits', async () => {
  const db = getDb()
  const settings = new RuntimeSettings(db)
  await settings.set('runtime_cache_rollback', { version: 1 })
  await assert.rejects(
    withTransaction(db, async () => {
      await settings.set('runtime_cache_rollback', { version: 2 })
      throw new Error('synthetic rollback')
    }),
    /synthetic rollback/,
  )
  assert.deepEqual(settings.get('runtime_cache_rollback'), { version: 1 })
  await assert.rejects(
    withTransaction(db, async () => {
      await settings.remove('runtime_cache_rollback')
      throw new Error('synthetic rollback')
    }),
    /synthetic rollback/,
  )
  assert.deepEqual(settings.get('runtime_cache_rollback'), { version: 1 })
  await withTransaction(db, async () => {
    await settings.set('runtime_cache_rollback', { version: 3 })
  })
  assert.deepEqual(settings.get('runtime_cache_rollback'), { version: 3 })
})
