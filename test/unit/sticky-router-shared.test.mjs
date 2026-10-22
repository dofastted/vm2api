import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
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

test('shared writes return committed native sessions and invalidate same-VM replacements', async () => {
  const [first, second] = await replicas()
  const key = 'sess:native-replacement'
  const initial = await first.bindShared(key, { accountId: 'account', vmId: 'vm', sessionId: 'native-1', slotIndex: 0 })
  assert.equal(initial.applied, true)
  assert.equal(initial.nativeSessionId, 'native-1')
  assert.equal(initial.record.generation, initial.generation)
  await second.refresh()
  const touched = await first.bindShared(key, { accountId: 'account', vmId: 'vm', sessionId: 'ignored' })
  assert.equal(touched.nativeSessionId, 'native-1')
  assert.equal(touched.generation, initial.generation)
  const replaced = await first.bindShared(
    key,
    { accountId: 'account', vmId: 'vm', sessionId: 'native-2' },
    {
      replaceSession: true,
      clearSlot: true,
    },
  )
  assert.ok(replaced.generation > initial.generation)
  assert.equal(replaced.nativeSessionId, 'native-2')
  assert.equal(replaced.record.slotIndex, null)
  const stale = await second.bindShared(
    key,
    { accountId: 'account', vmId: 'vm', sessionId: 'native-1' },
    {
      ifGeneration: initial.generation,
      replaceSession: true,
    },
  )
  assert.equal(stale.applied, false)
  assert.equal(stale.reason, 'sticky_changed')
  assert.equal(stale.nativeSessionId, 'native-2')
  assert.equal(stale.generation, replaced.generation)
})

test('shared same-identity touches increment hits from PG instead of a stale cache', async () => {
  const [first, second] = await replicas()
  const key = 'sess:atomic-hits'
  const initial = await first.bindShared(key, { accountId: 'account', vmId: 'vm', sessionId: 'native' })
  await second.refresh()
  const touches = await Promise.all(
    [first, second].map((router) =>
      router.bindShared(key, { accountId: 'account', vmId: 'vm' }, { ifGeneration: initial.generation }),
    ),
  )
  assert.ok(touches.every((result) => result.applied))
  assert.equal((await first.persistence.get(key)).hits, 3)
})

test('credential invalidation finds peer-only bindings and retains tombstone versions', async () => {
  const [first, second] = await replicas()
  await first.bindShared('sess:credential-a', { accountId: 'dead-account', vmId: 'vm-a' })
  await first.bindShared('sess:credential-b', { accountId: 'dead-account', vmId: 'vm-b' })
  await first.bindShared('sess:unrelated', { accountId: 'live-account', vmId: 'vm-c' })
  assert.equal(second.stats().active_sessions, 0)
  assert.equal(await second.unbindByAccountShared({ accountId: 'dead-account' }), 2)
  await first.refresh()
  assert.equal(first.resolve('sess:credential-a'), null)
  assert.equal(first.resolve('sess:credential-b'), null)
  assert.ok(first.versionOf('sess:credential-a') > 0)
  assert.equal(first.resolve('sess:unrelated').vmId, 'vm-c')
})

test('unbinding an absent key invalidates a pending first bind', async () => {
  const [first, second] = await replicas()
  const key = 'sess:absent-unbind'
  const deleted = await first.unbindShared(key, { ifGeneration: 0 })
  assert.equal(deleted.applied, true)
  assert.ok(deleted.generation > 0)
  const stale = await second.bindShared(key, { accountId: 'account', vmId: 'vm' }, { ifGeneration: 0 })
  assert.equal(stale.applied, false)
  assert.equal(stale.record, null)
  assert.equal(stale.generation, deleted.generation)
})

test('expiry retires its version and a stale binder cannot revive it', async () => {
  const [first, second] = await replicas()
  const key = 'sess:expired'
  const initial = await first.bindShared(key, { accountId: 'account', vmId: 'vm' })
  await second.refresh()
  const entry = await first.persistence.get(key)
  assert.equal(await first.purgeExpiredShared(entry.expires_at + 1), 1)
  const stale = await second.bindShared(key, { accountId: 'account', vmId: 'vm' }, { ifGeneration: initial.generation })
  assert.equal(stale.applied, false)
  assert.equal(stale.record, null)
  assert.ok(stale.generation > initial.generation)
  assert.equal(first.stats().active_sessions, 0)
})

test('legacy migration validates its source and never restores a deleted canonical destination', async () => {
  const [first, second] = await replicas()
  const legacy = 'p:anthropic:kkey:legacy-session'
  await first.bindShared(legacy, { accountId: 'account', vmId: 'vm', sessionId: 'native' })
  await second.refresh()
  await first.unbindShared(legacy)
  assert.deepEqual(await second.migrateLegacyIdentityShared(legacy, { sessionId: 'new-session', deviceId: 'device' }), {
    sessionKey: null,
    deviceKey: null,
  })
  assert.equal(await first.persistence.get('sess:new-session'), null)
  assert.equal(await first.persistence.get('dev2:device'), null)

  await first.bindShared(legacy, { accountId: 'account', vmId: 'vm', sessionId: 'native' })
  await first.unbindShared('sess:retired-canonical', { ifGeneration: 0 })
  await second.refresh()
  const result = await second.migrateLegacyIdentityShared(legacy, { sessionId: 'retired-canonical' })
  assert.equal(result.sessionKey, null)
  assert.equal(await first.persistence.get('sess:retired-canonical'), null)
})

test('canonical migration shares native ID while preserving the existing device home and family separation', async () => {
  const [first, second] = await replicas()
  const req = { apiKeyRecord: { id: 'key' }, headers: {} }
  const body = { metadata: { user_id: { session_id: 'trusted-session' } } }
  const legacy = first.collectPoolKeys(req, body, { platform: 'anthropic' })[0]
  await first.bindShared(legacy, { accountId: 'account', vmId: 'vm', sessionId: 'native' })
  await first.bindDeviceAffinityShared('dev2:device', { accountId: 'home-account', vmId: 'home-vm' })
  const keys = await second.sessionPoolKeysShared(req, body, { sessionId: 'trusted-session', deviceId: 'device' })
  assert.equal(keys.stickyKey, 'sess:trusted-session')
  assert.ok(keys.stickyKeys.includes(legacy))
  assert.equal(second.resolve(keys.stickyKey).sessionId, 'native')
  assert.equal(second.resolve('dev2:device').vmId, 'home-vm')
  assert.equal(second.resolve('dev2:device').slotIndex, null)
  assert.equal(second.resolve('dev2:device').sessionId, null)
  await first.refresh()
  assert.equal(first.resolve(keys.stickyKey).sessionId, 'native')
  const familyLegacy = first.familyKey(req, 'parent', 'anthropic')
  await first.bindShared(familyLegacy, { accountId: 'account', vmId: 'vm', sessionId: 'unused-session', slotIndex: 2 })
  assert.equal(await second.familyPoolKeyShared(req, 'parent', { trusted: true }), 'family2:parent')
  assert.equal(second.resolve('family2:parent').sessionId, null)
  assert.equal(second.resolve('family2:parent').slotIndex, null)
})

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('refresh never drains writes and delayed reads cannot overwrite a newer commit or refresh', async () => {
  const [first, second] = await replicas()
  const key = 'sess:refresh'
  await first.bindShared(key, { accountId: 'account', vmId: 'vm', sessionId: 'native' })
  const queued = deferred()
  first.writes.enqueue(() => queued.promise)
  try {
    await first.refresh()
    assert.equal(first.resolve(key).sessionId, 'native')
  } finally {
    queued.resolve()
  }
  const snapshot = second.persistence.snapshot.bind(second.persistence)
  const entered = deferred()
  const done = deferred()
  second.persistence.snapshot = async () => {
    const value = await snapshot()
    entered.resolve()
    await done.promise
    return value
  }
  const old = second.refresh()
  await entered.promise
  second.persistence.snapshot = snapshot
  await first.bindShared(key, { accountId: 'account', vmId: 'vm-new', sessionId: 'native-new' })
  await second.refresh()
  done.resolve()
  await old
  assert.equal(second.resolve(key).sessionId, 'native-new')
})

test('shared flush waits for pending CAS and failed persistence never publishes optimistic state', async () => {
  const [first] = await replicas()
  const key = 'sess:durable'
  const initial = await first.bindShared(key, { accountId: 'account', vmId: 'vm', sessionId: 'native' })
  const entered = deferred()
  const done = deferred()
  const compareAndSet = first.persistence.compareAndSet.bind(first.persistence)
  first.persistence.compareAndSet = async (...args) => {
    entered.resolve()
    await done.promise
    return compareAndSet(...args)
  }
  const binding = first.bindShared(key, { accountId: 'account', vmId: 'vm-new' })
  await entered.promise
  let flushed = false
  const flush = first.flush().then(() => {
    flushed = true
  })
  await setImmediate()
  assert.equal(flushed, false)
  done.resolve()
  await binding
  await flush
  first.persistence.compareAndSet = compareAndSet
  const before = first.resolve(key)
  await first.db.exec(`CREATE FUNCTION reject_sticky_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'mock sticky persistence failure' USING ERRCODE = 'P0001'; END $$;
    CREATE TRIGGER reject_sticky_write BEFORE UPDATE ON sticky_sessions FOR EACH ROW EXECUTE FUNCTION reject_sticky_write()`)
  await assert.rejects(first.bindShared(key, { accountId: 'account', vmId: 'vm-other' }), { code: 'P0001' })
  assert.deepEqual(first.resolve(key), before)
  assert.ok(before.generation > initial.generation)
  assert.equal((await first.persistence.get(key)).vm_id, 'vm-new')
})

test('shared synchronous mutation entry points fail before changing cached state', async () => {
  const [first] = await replicas()
  const key = 'sess:sync-forbidden'
  await first.bindShared(key, { accountId: 'account', vmId: 'vm' })
  const before = first.resolve(key)
  for (const call of [
    () => first.bind(key, { accountId: 'account', vmId: 'vm-new' }),
    () => first.unbind(key),
    () => first.rebindFamily(key, { accountId: 'other-account', vmId: 'other-vm' }),
    () => first.bindDeviceAffinity('dev2:device', { accountId: 'account', vmId: 'vm' }),
    () => first.unbindByAccount({ accountId: 'account' }),
  ])
    assert.throws(call, { code: 'shared_sticky_async_required' })
  assert.deepEqual(first.resolve(key), before)
})

test('the sticky generation sequence is owned by its table column', async () => {
  const [first] = await replicas()
  const row = await first.db.prepare("SELECT pg_get_serial_sequence('sticky_sessions', 'generation') AS owned").get()
  assert.match(row.owned, /sticky_generation_seq$/)
})

test('shared generations advance past an explicitly imported legacy generation', async () => {
  const [first] = await replicas()
  const key = 'sess:imported-generation'
  await first.persistence.upsert(key, {
    account_id: 'account',
    vm_id: 'vm',
    generation: 500,
    expires_at: Date.now() + 60_000,
  })
  await first.refresh()
  const moved = await first.bindShared(key, { accountId: 'account', vmId: 'vm-new' }, { ifGeneration: 500 })
  assert.equal(moved.applied, true)
  assert.ok(moved.generation > 500)
})
