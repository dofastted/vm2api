import test from 'node:test'
import assert from 'node:assert/strict'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'

async function replicas() {
  const db = getDb()
  const peer = await createDatabase({ connectionString: process.env.VM2API_TEST_DATABASE_URL, schema: db.schema })
  const config = { sticky: { enabled: true, ttl_seconds: 60 } }
  return Promise.all([
    new StickyRouter({ db, config, shared: true }).init(),
    new StickyRouter({ db: peer, config, shared: true }).init(),
  ])
}

// Keep the regression runnable before introducing the asynchronous shared API.
async function bind(router, key, value, options) {
  if (router.bindShared) return router.bindShared(key, value, options)
  const result = router.bind(key, value, options)
  await router.flush()
  return result
}

async function unbind(router, key, options) {
  if (router.unbindShared) return router.unbindShared(key, options)
  const result = router.unbind(key, options)
  await router.flush()
  return result
}

async function rebindFamily(router, key, value, options) {
  if (router.rebindFamilyShared) return router.rebindFamilyShared(key, value, options)
  const result = router.rebindFamily(key, value, options)
  await router.flush()
  return result
}

test('a delayed bind cannot overwrite a family migration committed by another connection', async () => {
  const [first, second] = await replicas()
  const key = 'family2:shared-family'
  await bind(first, key, { accountId: 'account-old', vmId: 'vm-old', sessionId: 'native-old' })
  await second.reload()
  const previous = second.resolve(key)
  await rebindFamily(first, key, { accountId: 'account-new', vmId: 'vm-new' })
  const migrated = await first.persistence.get(key)

  await bind(
    second,
    key,
    { accountId: previous.accountId, vmId: previous.vmId, sessionId: previous.sessionId },
    {
      ifGeneration: previous.generation,
    },
  )
  const stored = await first.persistence.get(key)
  assert.equal(stored.account_id, 'account-new')
  assert.equal(stored.vm_id, 'vm-new')
  assert.equal(stored.generation, migrated.generation)
})

test('a delayed generation-conditional unbind cannot delete a newer family binding', async () => {
  const [first, second] = await replicas()
  const key = 'family2:unbind-family'
  await bind(first, key, { accountId: 'account-old', vmId: 'vm-old' })
  await second.reload()
  const previous = second.resolve(key)
  await rebindFamily(first, key, { accountId: 'account-new', vmId: 'vm-new' })

  await unbind(second, key, { ifGeneration: previous.generation })
  const stored = await first.persistence.get(key)
  assert.ok(stored, 'the binding committed after the observed generation must survive')
  assert.equal(stored.vm_id, 'vm-new')
})

test('a delayed bind cannot resurrect a sticky key unbound by another connection', async () => {
  const [first, second] = await replicas()
  const key = 'sess:unbound-session'
  await bind(first, key, { accountId: 'account', vmId: 'vm', sessionId: 'native-before-delete' })
  await second.reload()
  const previous = second.resolve(key)
  await unbind(first, key, { ifGeneration: previous.generation })

  await bind(
    second,
    key,
    { accountId: 'account', vmId: 'vm', sessionId: 'native-before-delete' },
    {
      ifGeneration: previous.generation,
    },
  )
  assert.equal(await first.persistence.get(key), null, 'an unbind must invalidate every older binding token')
})

test('delete and recreate never reuse a generation accepted by a stale replica', async () => {
  const [first, second] = await replicas()
  const key = 'sess:recreated-session'
  await bind(first, key, { accountId: 'account', vmId: 'vm-old' })
  await second.reload()
  const previous = second.resolve(key)
  await unbind(first, key, { ifGeneration: previous.generation })
  await bind(first, key, { accountId: 'account', vmId: 'vm-new' })
  const recreated = await first.persistence.get(key)
  assert.notEqual(recreated.generation, previous.generation, 'a deleted binding token must never become current again')
})

test('a replica that observed no binding cannot replace the committed native session ID', async () => {
  const [first, second] = await replicas()
  const key = 'sess:one-native-session'
  assert.equal(second.resolve(key), null)
  await bind(first, key, { accountId: 'account', vmId: 'vm', sessionId: 'native-first' }, { ifGeneration: 0 })
  await bind(second, key, { accountId: 'account', vmId: 'vm', sessionId: 'native-second' }, { ifGeneration: 0 })

  await second.reload()
  assert.equal(second.resolve(key).sessionId, 'native-first')
  assert.equal((await first.persistence.get(key)).session_id, 'native-first')
})
