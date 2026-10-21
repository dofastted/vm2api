import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase, getDb, withTransaction } from '../../src/lib/db/database.mjs'
import { loadSettingsState, RuntimeSettings } from '../../src/lib/db/settings-state.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function otherConnection(t, db) {
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(() => other.close())
  await loadSettingsState(other)
  return new RuntimeSettings(other)
}

/** Hold one completed PG read so competing commits have deterministic order. */
function holdSnapshot(t, db) {
  const read = deferred()
  const resume = deferred()
  const query = db.query
  let held = false
  db.query = async function (sql, params) {
    const result = await query.call(this, sql, params)
    if (!held && sql === 'SELECT key, value, updated_at FROM settings ORDER BY key') {
      held = true
      read.resolve()
      await resume.promise
    }
    return result
  }
  t.after(() => {
    resume.resolve()
    db.query = query
  })
  return { read: read.promise, resume: resume.resolve }
}

test('refresh makes another PostgreSQL connection set and remove visible to synchronous readers', async (t) => {
  const db = getDb()
  const settings = new RuntimeSettings(db)
  const reader = new RuntimeSettings(db)
  const other = await otherConnection(t, db)
  await settings.set('runtime_shared', { version: 1 })
  await other.set('runtime_shared', { version: 2 })
  await other.set('runtime_added', true)
  assert.deepEqual(reader.get('runtime_shared'), { version: 1 })
  await settings.refresh()
  assert.deepEqual(reader.get('runtime_shared'), { version: 2 })
  assert.equal(reader.has('runtime_added'), true)
  assert.deepEqual(reader.all().runtime_shared, { version: 2 })
  await other.remove('runtime_shared')
  await settings.refresh()
  assert.equal(reader.has('runtime_shared'), false)
  assert.equal(reader.get('runtime_shared', 'missing'), 'missing')
})

test('an older settings snapshot cannot overwrite a newer completed refresh', async (t) => {
  const db = getDb()
  const settings = new RuntimeSettings(db)
  const other = await otherConnection(t, db)
  await settings.set('runtime_refresh_order', 1)
  const held = holdSnapshot(t, db)
  const oldRefresh = loadSettingsState(db)
  try {
    await held.read
    await other.set('runtime_refresh_order', 2)
    await loadSettingsState(db)
    assert.equal(settings.get('runtime_refresh_order'), 2)
  } finally {
    held.resume()
    await oldRefresh
  }
  assert.equal(settings.get('runtime_refresh_order'), 2)
})

test('an in-flight snapshot cannot overwrite a newer local committed set or remove', async (t) => {
  const db = getDb()
  const settings = new RuntimeSettings(db)
  await settings.set('runtime_local_set', 1)
  await settings.set('runtime_local_remove', true)
  const held = holdSnapshot(t, db)
  const oldRefresh = loadSettingsState(db)
  try {
    await held.read
    // Direct repository callers must advance the same cache revision.
    await withTransaction(db, async () => {
      await new SettingsRepo(db).set('runtime_local_set', 2)
      await new SettingsRepo(db).remove('runtime_local_remove')
    })
  } finally {
    held.resume()
    await oldRefresh
  }
  assert.equal(settings.get('runtime_local_set'), 2)
  assert.equal(settings.has('runtime_local_remove'), false)
})

test('a failed refresh preserves the previously published settings snapshot', async () => {
  const db = getDb()
  const settings = new RuntimeSettings(db)
  await settings.set('runtime_refresh_failure', true)
  const query = db.query
  db.query = async function (sql, params) {
    if (sql === 'SELECT key, value, updated_at FROM settings ORDER BY key') throw new Error('synthetic read failure')
    return query.call(this, sql, params)
  }
  try {
    await assert.rejects(settings.refresh(), /synthetic read failure/)
    assert.equal(settings.get('runtime_refresh_failure'), true)
  } finally {
    db.query = query
  }
})

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
