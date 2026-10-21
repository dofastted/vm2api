import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { getDb } from '../../src/lib/db/database.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const success = () => ({
  ok: true,
  status: 200,
  terminalState: 'verified',
  body: {
    type: 'message',
    id: 'msg_release',
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
  },
})

function schedulerWithRelease(release, extra = {}) {
  return {
    async selectAndReserve() {
      return { ok: true, accountId: 'account-release', vmId: 'vm-release', release, ...extra }
    },
    markSuccess() {},
  }
}

function request(requestId, overrides = {}) {
  return {
    requestId,
    model: 'claude-sonnet-4-6',
    canonicalBody: { model: 'claude-sonnet-4-6' },
    callAttempt: success,
    ...overrides,
  }
}

test('prebinding failure releases the selected reservation before propagating', async () => {
  let releases = 0
  const runner = new FailoverRunner({
    scheduler: schedulerWithRelease(async () => {
      await getDb().prepare('SELECT 1').get()
      releases++
    }),
    stickyRouter: {
      bind() {
        throw new Error('prebinding failed')
      },
    },
  })
  await assert.rejects(
    runner.run(
      request('bind-release', {
        stickyKey: 'bind-session',
        callAttempt: () => assert.fail('prebinding failure must not execute upstream'),
      }),
    ),
    /prebinding failed/,
  )
  assert.equal(releases, 1)
})

test('family prebinding failure also releases a successful reservation', async () => {
  let releases = 0
  const runner = new FailoverRunner({
    scheduler: schedulerWithRelease(() => releases++, { familyGated: true }),
    stickyRouter: {
      resolve() {
        throw new Error('family binding unavailable')
      },
    },
  })
  await assert.rejects(
    runner.run(
      request('family-release', {
        familyKey: 'family-session',
        familyVmId: 'vm-family',
        callAttempt: () => assert.fail('family binding failure must not execute upstream'),
      }),
    ),
    /family binding unavailable/,
  )
  assert.equal(releases, 1)
})

test('a PostgreSQL attempt begin failure releases capacity without completing or executing the attempt', async () => {
  const attempts = new RequestAttemptsRepo(getDb())
  await attempts.begin({ requestId: 'duplicate-attempt', attemptNo: 1 })
  let releases = 0
  const runner = new FailoverRunner({
    scheduler: schedulerWithRelease(async () => {
      await getDb().prepare('SELECT 1').get()
      releases++
    }),
    attemptsRepo: attempts,
  })
  await assert.rejects(
    runner.run(
      request('duplicate-attempt', {
        callAttempt: () => assert.fail('attempt begin failure must not execute upstream'),
      }),
    ),
    { code: '23505' },
  )
  assert.equal(releases, 1)
  const rows = await attempts.list('duplicate-attempt')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].terminal_state, 'started')
  assert.equal(rows[0].completed_at, null)
})

test('same-session requests wait until asynchronous capacity release completes', async () => {
  const releasing = deferred()
  const finishRelease = deferred()
  let reservations = 0
  let releases = 0
  let calls = 0
  let holderSettled = false
  const runner = new FailoverRunner({
    scheduler: {
      async selectAndReserve() {
        const turn = ++reservations
        return {
          ok: true,
          accountId: 'account-release',
          vmId: 'vm-release',
          async release() {
            if (turn === 1) {
              releasing.resolve()
              await finishRelease.promise
            }
            await getDb().prepare('SELECT 1').get()
            releases++
          },
        }
      },
      markSuccess() {},
    },
  })
  const args = (id) =>
    request(id, {
      stickyKey: 'shared-release-session',
      callAttempt: () => {
        calls++
        return success()
      },
    })
  const holder = runner.run(args('release-holder'))
  holder.then(() => {
    holderSettled = true
  })
  await releasing.promise
  const follower = runner.run(args('release-follower'))
  try {
    await setImmediate()
    assert.equal(holderSettled, false)
    assert.equal(reservations, 1)
    assert.equal(calls, 1)
  } finally {
    finishRelease.resolve()
    await Promise.all([holder, follower])
  }
  assert.equal(reservations, 2)
  assert.equal(releases, 2)
  assert.equal(calls, 2)
})
