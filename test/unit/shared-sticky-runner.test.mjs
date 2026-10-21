import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'

async function fixture(t) {
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  const config = { sticky: { enabled: true, ttl_seconds: 60 } }
  const [router, peer] = await Promise.all([
    new StickyRouter({ db, config, shared: true }).init(),
    new StickyRouter({ db: other, config, shared: true }).init(),
  ])
  t.after(async () => {
    await router.flush()
    await peer.flush()
    await other.close()
  })
  const scheduler = {
    async selectAndReserve() {
      return { ok: true, accountId: 'account-a', vmId: 'vm-a', release() {} }
    },
    markSuccess() {},
  }
  return { router, peer, runner: new FailoverRunner({ scheduler, stickyRouter: router }) }
}

function success() {
  return { ok: true, status: 200, terminalState: 'verified', body: { content: [{ type: 'text', text: 'ok' }] } }
}

for (const initial of ['absent', 'tombstone']) {
  test(`runner durably binds ${initial} shared session before kernel submission`, async (t) => {
    const fx = await fixture(t)
    const key = `runner-${initial}`
    if (initial === 'tombstone') {
      await fx.router.bindShared(key, { accountId: 'account-a', vmId: 'vm-a' })
      await fx.router.unbindShared(key)
    }
    let calls = 0
    const result = await fx.runner.run({
      requestId: key,
      stickyKey: key,
      canonicalBody: { model: 'claude-test' },
      applyAttempt: () => ({ body: {}, meta: { sessionId: 'native-a' } }),
      callAttempt: async () => {
        calls++
        const stored = await fx.peer.persistence.get(key)
        assert.equal(stored.account_id, 'account-a')
        assert.equal(stored.session_id, 'native-a')
        return success()
      },
    })
    assert.equal(result.ok, true)
    assert.equal(calls, 1)
  })
}

test('runner rejects shared native-session CAS conflict before submission', async (t) => {
  const fx = await fixture(t)
  const key = 'runner-pre-submit-conflict'
  let calls = 0
  const result = await fx.runner.run({
    requestId: key,
    stickyKey: key,
    canonicalBody: { model: 'claude-test' },
    applyAttempt: async () => {
      await fx.peer.refresh()
      await fx.peer.rebindFamilyShared(key, { accountId: 'account-b', vmId: 'vm-b' }, { ifGeneration: fx.peer.versionOf(key) })
      return { body: {}, meta: { sessionId: 'native-a' } }
    },
    callAttempt: async () => { calls++; return success() },
  })
  assert.equal(calls, 0)
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'sticky_binding_conflict')
  assert.equal((await fx.peer.persistence.get(key)).vm_id, 'vm-b')
})

test('runner late success preserves shared pin moved during execution', async (t) => {
  const fx = await fixture(t)
  const key = 'runner-late-success'
  const result = await fx.runner.run({
    requestId: key,
    stickyKey: key,
    canonicalBody: { model: 'claude-test' },
    applyAttempt: () => ({ body: {}, meta: { sessionId: 'native-a' } }),
    callAttempt: async () => {
      await fx.peer.refresh()
      await fx.peer.rebindFamilyShared(key, { accountId: 'account-b', vmId: 'vm-b' }, { ifGeneration: fx.peer.versionOf(key) })
      await fx.router.refresh()
      return success()
    },
  })
  assert.equal(result.ok, true)
  const stored = await fx.peer.persistence.get(key)
  assert.equal(stored.vm_id, 'vm-b')
  assert.equal(stored.session_id, null)
})
