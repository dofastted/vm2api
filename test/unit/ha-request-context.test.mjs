import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb, getActivityCoordinator, quoteIdentifier, withTransaction } from '../../src/lib/db/database.mjs'
import { coordinationSchemaFor } from '../../src/lib/db/global-maintenance.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'
import { withDatabaseActivities } from '../maintenance-fixture.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { SharedSessionTurns } from '../../src/lib/pool/shared-session-turns.mjs'
import { syntheticFence } from '../fixtures/fake-slotgate.mjs'

async function fixture(callback) {
  const db = getDb()
  const peer = await createRepositoryTestDatabase({ connectionString: db.connectionString, schema: db.schema })
  const before = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes-ha'
  try {
    return await withDatabaseActivities([db, peer], async () => {
      const module = await import('../../src/lib/core/ha-request-context.mjs')
      const scope = getActivityCoordinator(db).assertActivity()
      const activity = { activityId: scope.id, ownerId: getActivityCoordinator(db).ownerId, epoch: scope.epoch }
      return callback({ db, peer, activity, ...module })
    })
  } finally {
    if (before == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = before
    await getActivityCoordinator(peer)?.stop()
    await getActivityCoordinator(db)?.stop()
    await db.pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(coordinationSchemaFor(db.schema))} CASCADE`)
    await peer.close()
  }
}

const input = (requestId = 'unrelated-local-id') => ({
  accountId: 'fixture-account',
  vmId: 'vm-fixture',
  requestId,
  accountLimit: 5,
  vmLimit: 5,
  fableLimit: 0,
  rpmLimit: 0,
})
const binding = {
  protocol: 'KSG2',
  nodeId: 'fixture-node',
  vmId: 'vm-fixture',
  kind: 'kernel',
  fence: syntheticFence(),
}

test('two PG connections see exact activity, key, turn, execution, attempt and original node-job links before submission', async () => {
  await fixture(async ({ db, peer, activity, withHaRequestContext, withHaRequestAttempt }) => {
    const keys = new ApiKeyStore({ db })
    const key = await keys.create({ name: 'synthetic-recovery-key' })
    await withHaRequestContext({ db, activity, requestId: 'server-request-one' }, async () => {
      const keyLease = await keys.reserve(key)
      assert.equal(keyLease.ok, true)
      const turn = await new SharedSessionTurns(db).enqueue('fixture-session', 'not-a-join-key')
      const lease = await new ExecutionAdmissionsRepo(db).tryReserve(input())
      assert.equal(lease.ok, true)
      await new RequestAttemptsRepo(db).begin({
        requestId: 'not-a-join-key',
        attemptNo: 1,
        vmId: 'vm-fixture',
        accountId: 'fixture-account',
        model: 'claude-synthetic',
      })
      await withHaRequestAttempt(1, () => lease.bindExecution({ requestId: 'node-command-one', nodeBinding: binding }))
      const request = await peer.prepare('SELECT * FROM ha_request_contexts WHERE id=$1').get('server-request-one')
      assert.equal(request.activity_id, activity.activityId)
      assert.equal(request.activity_owner_id, activity.ownerId)
      assert.equal(String(request.activity_epoch), String(activity.epoch))
      assert.equal(request.accepting_children, true)
      for (const [table, id] of [
        ['api_key_admissions', keyLease.reservationId],
        ['session_turns', turn.id],
        ['execution_admissions', lease.admissionId],
      ]) {
        const row = await peer.prepare(`SELECT ha_request_id FROM ${table} WHERE id=$1`).get(id)
        assert.equal(row.ha_request_id, 'server-request-one')
      }
      const job = await peer.prepare('SELECT * FROM execution_jobs WHERE request_id=$1').get('node-command-one')
      assert.equal(job.ha_request_id, 'server-request-one')
      assert.equal(job.attempt_no, 1)
      assert.equal(job.admission_id, lease.admissionId)
      assert.deepEqual(job.node_binding, binding)
      const attempt = await peer.prepare('SELECT ha_request_id FROM request_attempts WHERE attempt_no=1').get()
      assert.equal(attempt.ha_request_id, 'server-request-one')
    })
    const ended = await peer.prepare('SELECT * FROM ha_request_contexts WHERE id=$1').get('server-request-one')
    assert.equal(ended.accepting_children, false)
    assert.ok(ended.handler_returned_at)
    assert.equal(
      (await peer.prepare('SELECT count(*) AS count FROM execution_admissions WHERE released_at IS NULL').get()).count,
      1,
    )
    assert.equal(
      (await peer.prepare('SELECT count(*) AS count FROM api_key_admissions WHERE released_at IS NULL').get()).count,
      1,
    )
  })
})

test('a late child waits for the parent SQL lock and is rejected after another connection seals the request', async () => {
  await fixture(async ({ db, peer, activity, withHaRequestContext }) => {
    await withHaRequestContext({ db, activity, requestId: 'sealed-request' }, async () => {
      let resume, locked
      const waiting = new Promise((resolve) => {
        resume = resolve
      })
      const ready = new Promise((resolve) => {
        locked = resolve
      })
      const close = withTransaction(peer, async () => {
        await peer.prepare('SELECT id FROM ha_request_contexts WHERE id=$1 FOR UPDATE').get('sealed-request')
        locked()
        await waiting
        await peer.prepare('UPDATE ha_request_contexts SET accepting_children=false WHERE id=$1').run('sealed-request')
      })
      await ready
      const reserve = new ExecutionAdmissionsRepo(db).tryReserve(input())
      reserve.catch(() => {})
      await new Promise((resolve) => setImmediate(resolve))
      resume()
      await close
      await assert.rejects(reserve, { code: 'ha_request_context_closed' })
      assert.equal((await peer.prepare('SELECT count(*) AS count FROM execution_admissions').get()).count, 0)
    })
  })
})

test('a node job cannot bind an admission from a different HA request or an absent attempt', async () => {
  await fixture(async ({ db, peer, activity, withHaRequestContext, withHaRequestAttempt }) => {
    let lease
    await withHaRequestContext({ db, activity, requestId: 'request-a' }, async () => {
      lease = await new ExecutionAdmissionsRepo(db).tryReserve(input())
      await assert.rejects(
        withHaRequestAttempt(1, () => lease.bindExecution({ requestId: 'missing-attempt', nodeBinding: binding })),
        { code: 'ha_request_attempt_missing' },
      )
    })
    await withHaRequestContext({ db, activity, requestId: 'request-b' }, async () => {
      await new RequestAttemptsRepo(db).begin({
        requestId: 'request-b',
        attemptNo: 1,
        vmId: 'vm-fixture',
        accountId: 'fixture-account',
        model: 'claude-synthetic',
      })
      await assert.rejects(
        withHaRequestAttempt(1, () => lease.bindExecution({ requestId: 'cross-request', nodeBinding: binding })),
        { code: 'ha_request_context_mismatch' },
      )
    })
    assert.equal((await peer.prepare('SELECT count(*) AS count FROM execution_jobs').get()).count, 0)
  })
})

test('HA requires its original live activity and context before reserving execution', async () => {
  await fixture(async ({ db, peer, activity, withHaRequestContext }) => {
    await assert.rejects(
      withHaRequestContext(
        { db, activity: { ...activity, activityId: 'other-activity' }, requestId: 'forged' },
        async () => {},
      ),
      { code: 'ha_request_activity_mismatch' },
    )
    await assert.rejects(new ExecutionAdmissionsRepo(db).tryReserve(input()), { code: 'ha_request_context_required' })
    assert.equal((await peer.prepare('SELECT count(*) AS count FROM execution_admissions').get()).count, 0)
  })
})

test('sealing the SQL parent rejects late key reservations, turns and attempts without new child rows', async () => {
  await fixture(async ({ db, peer, activity, withHaRequestContext }) => {
    const keys = new ApiKeyStore({ db })
    const key = await keys.create({ name: 'synthetic-sealed-key' })
    await withHaRequestContext({ db, activity, requestId: 'sealed-all-children' }, async () => {
      await peer
        .prepare('UPDATE ha_request_contexts SET accepting_children=false WHERE id=$1')
        .run('sealed-all-children')
      await assert.rejects(keys.reserve(key), { code: 'ha_request_context_closed' })
      await assert.rejects(new SharedSessionTurns(db).enqueue('late-session', 'late-request'), {
        code: 'ha_request_context_closed',
      })
      await assert.rejects(new RequestAttemptsRepo(db).begin({ requestId: 'late-request', attemptNo: 1 }), {
        code: 'ha_request_context_closed',
      })
      for (const table of ['api_key_admissions', 'session_turns', 'request_attempts'])
        assert.equal((await peer.prepare(`SELECT count(*) AS count FROM ${table}`).get()).count, 0)
    })
  })
})

test('a waiting session turn cannot activate after another connection seals its request', async () => {
  await fixture(async ({ db, peer, activity, withHaRequestContext }) => {
    await withHaRequestContext({ db, activity, requestId: 'sealed-turn' }, async () => {
      const turns = new SharedSessionTurns(db)
      const handle = await turns.enqueue('sealed-session', 'untrusted-correlation')
      await peer.prepare('UPDATE ha_request_contexts SET accepting_children=false WHERE id=$1').run('sealed-turn')
      await assert.rejects(turns.tryActivate(handle), { code: 'ha_request_context_closed' })
      assert.equal((await peer.prepare('SELECT state FROM session_turns WHERE id=$1').get(handle.id)).state, 'waiting')
    })
  })
})

test('a callback retained past its request wrapper cannot create another execution', async () => {
  await fixture(async ({ db, peer, activity, withHaRequestContext }) => {
    let resume
    const blocked = new Promise((resolve) => {
      resume = resolve
    })
    let pending
    await withHaRequestContext({ db, activity, requestId: 'returned-request' }, async () => {
      pending = blocked.then(() => new ExecutionAdmissionsRepo(db).tryReserve(input()))
      pending.catch(() => {})
    })
    resume()
    await assert.rejects(pending, { code: 'ha_request_context_closed' })
    assert.equal((await peer.prepare('SELECT count(*) AS count FROM execution_admissions').get()).count, 0)
  })
})

for (const mode of ['standalone', 'kubernetes']) {
  test(`${mode} keeps nullable request links and does not require an HA wrapper`, async () => {
    await fixture(async ({ db, peer, withHaRequestContext }) => {
      process.env.VM2API_CONTROL_PLANE_MODE = mode
      try {
        await withHaRequestContext({ db, requestId: 'unused-legacy', activity: null }, async () => {
          const lease = await new ExecutionAdmissionsRepo(db).tryReserve(input())
          await lease.bindExecution({ requestId: 'legacy-job' })
          await new SharedSessionTurns(db).enqueue('legacy-session', 'legacy-request')
          await new RequestAttemptsRepo(db).begin({ requestId: 'legacy-request', attemptNo: 1 })
          assert.equal((await peer.prepare('SELECT count(*) AS count FROM ha_request_contexts').get()).count, 0)
          for (const table of ['execution_admissions', 'execution_jobs', 'session_turns', 'request_attempts'])
            assert.equal((await peer.prepare(`SELECT ha_request_id FROM ${table}`).get()).ha_request_id, null)
        })
      } finally {
        process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes-ha'
      }
    })
  })
}

test('a closed inherited context permits a newly admitted activity but cannot revive its original activity', async () => {
  await fixture(async ({ db, activity, withHaRequestContext }) => {
    let resume
    const later = new Promise((resolve) => {
      resume = resolve
    })
    let inherited
    await withHaRequestContext({ db, activity, requestId: 'closed-parent' }, async () => {
      inherited = later.then(async () => {
        await assert.rejects(
          withHaRequestContext({ db, activity, requestId: 'revived-parent' }, async () => {}),
          { code: 'ha_request_context_closed' },
        )
        const fresh = await getActivityCoordinator(db).admit({ kind: 'request', requestId: 'fresh-after-closed' })
        try {
          await fresh.run(() =>
            withHaRequestContext({ db, activity: fresh, requestId: 'fresh-after-closed' }, async () => {
              const lease = await new ExecutionAdmissionsRepo(db).tryReserve(input())
              assert.equal(lease.ok, true)
              await lease.release()
            }),
          )
        } finally {
          await fresh.complete({ ended: true })
        }
      })
      inherited.catch(() => {})
    })
    resume()
    await inherited
    assert.equal(await db.prepare('SELECT id FROM ha_request_contexts WHERE id=$1').get('revived-parent'), undefined)
    assert.ok(await db.prepare('SELECT id FROM ha_request_contexts WHERE id=$1').get('fresh-after-closed'))
  })
})
