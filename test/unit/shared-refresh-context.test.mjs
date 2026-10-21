import test from 'node:test'
import assert from 'node:assert/strict'
import * as refresh from '../../src/lib/oauth/shared-credential-refresh.mjs'

const db = { schema: 'synthetic', connectionString: 'synthetic-connection' }
const admission = { admissionId: 'admission', ownerId: 'owner', vmId: 'vm', accountId: 'account' }

test('refresh context carries only the exact database and active admission callback', async () => {
  assert.equal(refresh.currentRefreshAdmission(db), null)
  await refresh.withRefreshAdmission(db, admission, async () => {
    assert.deepEqual(refresh.currentRefreshAdmission(db), { db, ...admission })
    assert.equal(refresh.currentRefreshAdmission({ ...db, schema: 'other' }), null)
    assert.equal(refresh.currentRefreshAdmission({ ...db, connectionString: 'other' }), null)
  })
  assert.equal(refresh.currentRefreshAdmission(db), null)
})

test('detached descendants cannot reuse a completed refresh admission scope', async () => {
  let release
  const wait = new Promise((resolve) => { release = resolve })
  let detached
  await refresh.withRefreshAdmission(db, admission, async () => {
    detached = wait.then(() => refresh.currentRefreshAdmission(db))
  })
  release()
  assert.equal(await detached, null)
})
