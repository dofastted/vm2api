import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
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
  execution: { requestId: 'synthetic-hop', started: true, ended: true, reason: 'eof' },
  body: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
})

function args(requestId, callAttempt, extra = {}) {
  return {
    requestId,
    stickyKey: 'shared-conversation',
    model: 'claude-test',
    canonicalBody: { model: 'claude-test', messages: [] },
    callAttempt,
    ...extra,
  }
}

async function until(check) {
  const deadline = Date.now() + 2000
  while (!(await check())) {
    if (Date.now() >= deadline) assert.fail('condition did not become true')
    await delay(5)
  }
}

async function fixture(t) {
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(async () => {
    await other.close()
    if (previous == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
  })
  return {
    db,
    other,
    rows: () => db.prepare('SELECT * FROM session_turns ORDER BY sequence').all(),
    runner(connection, { release = async () => {}, timeout = 2000, sessionTurns } = {}) {
      return new FailoverRunner({
        scheduler: {
          accountQuota: { db: connection },
          async selectAndReserve() {
            return {
              ok: true,
              accountId: 'synthetic-account',
              vmId: 'synthetic-vm',
              bindExecution: async () => {},
              markUncertain: async () => {},
              release,
            }
          },
          markSuccess() {},
          markCooldown() {},
        },
        sessionTurns,
        config: { session_queue_timeout_ms: timeout, max_total_attempts: 1 },
      })
    },
  }
}

test('a runner can use an explicitly injected shared turn service', async (t) => {
  const fx = await fixture(t)
  const { SharedSessionTurns } = await import('../../src/lib/pool/shared-session-turns.mjs')
  const service = new SharedSessionTurns(fx.other, { ownerId: 'injected-controller' })
  const runner = fx.runner(fx.db, { sessionTurns: service })
  const result = await runner.run(
    args('injected', async () => {
      const rows = await fx.rows()
      assert.equal(rows[0].owner_id, 'injected-controller')
      assert.equal(rows[0].state, 'active')
      return success()
    }),
  )
  assert.equal(result.ok, true)
  assert.deepEqual(await fx.rows(), [])
})

test('independent runners serialize one session in database FIFO order and await reservation release', async (t) => {
  const fx = await fixture(t)
  const entered = deferred()
  const finish = deferred()
  const releaseEntered = deferred()
  const released = deferred()
  let releaseCalls = 0
  const first = fx.runner(fx.db, {
    async release() {
      if (++releaseCalls !== 1) return
      releaseEntered.resolve()
      await released.promise
    },
  })
  const second = fx.runner(fx.other)
  const events = []
  const holder = first.run(
    args('first', async () => {
      events.push('first')
      entered.resolve()
      await finish.promise
      return success()
    }),
  )
  const pending = [holder]
  try {
    await entered.promise
    const follower = second.run(
      args('second', async () => {
        events.push('second')
        return success()
      }),
    )
    pending.push(follower)
    await delay(30)
    assert.deepEqual(events, ['first'], 'a separate runner must wait for the active conversation turn')
    await until(async () => (await fx.rows()).some((row) => row.request_id === 'second'))
    const third = first.run(
      args('third', async () => {
        events.push('third')
        return success()
      }),
    )
    pending.push(third)
    await until(async () => (await fx.rows()).some((row) => row.request_id === 'third'))
    const queue = await fx.rows()
    assert.deepEqual(
      queue.map((row) => [row.request_id, row.state]),
      [
        ['first', 'active'],
        ['second', 'waiting'],
        ['third', 'waiting'],
      ],
    )
    const unrelated = await second.run(
      args(
        'unrelated',
        async () => {
          events.push('unrelated')
          return success()
        },
        { stickyKey: 'another-conversation' },
      ),
    )
    assert.equal(unrelated.ok, true, 'a different conversation can execute while this one is held')
    finish.resolve()
    await releaseEntered.promise
    assert.deepEqual(events, ['first', 'unrelated'], 'the next turn waits for the selected lease release')
    released.resolve()
    await Promise.all(pending)
    assert.deepEqual(events, ['first', 'unrelated', 'second', 'third'])
    assert.deepEqual(await fx.rows(), [])
  } finally {
    finish.resolve()
    released.resolve()
    await Promise.allSettled(pending)
  }
})

test('waiting cancellation and timeout remove only their own records without overlapping the holder', async (t) => {
  const fx = await fixture(t)
  const entered = deferred()
  const finish = deferred()
  const first = fx.runner(fx.db)
  const second = fx.runner(fx.other)
  const holder = first.run(
    args('holder', async () => {
      entered.resolve()
      await finish.promise
      return success()
    }),
  )
  const controller = new AbortController()
  let cancelled
  try {
    await entered.promise
    cancelled = second.run(
      args('cancelled', () => assert.fail('a cancelled waiter cannot execute'), { signal: controller.signal }),
    )
    await until(async () => (await fx.rows()).some((row) => row.request_id === 'cancelled'))
    controller.abort()
    assert.equal((await cancelled).clientCancelled, true)
    const timedOut = await fx
      .runner(fx.other, { timeout: 100 })
      .run(args('timed-out', () => assert.fail('a timed out waiter cannot execute')))
    assert.equal(timedOut.status, 529)
    assert.equal(timedOut.body.error.details.reason, 'session_queue_timeout')
    assert.deepEqual(
      (await fx.rows()).map((row) => [row.request_id, row.state]),
      [['holder', 'active']],
    )
  } finally {
    controller.abort()
    finish.resolve()
    await Promise.allSettled([holder, cancelled])
  }
  assert.deepEqual(await fx.rows(), [])
})

test('an unknown execution retains its active session turn after the request returns', async (t) => {
  const fx = await fixture(t)
  const first = fx.runner(fx.db)
  const second = fx.runner(fx.other, { timeout: 40 })
  const result = await first.run(
    args('unknown', async () => ({
      ok: false,
      status: 0,
      transportError: true,
      execution: { requestId: 'unknown-hop', started: true, ended: false, reason: 'transport_error' },
    })),
  )
  assert.equal(result.executionUncertain, true)
  const rows = await fx.rows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, 'active')
  assert.ok(rows[0].uncertain_at)
  const blocked = await second.run(args('follower', () => assert.fail('the previous execution is not proven ended')))
  assert.equal(blocked.body.error.details.reason, 'session_queue_timeout')
  assert.equal((await fx.rows())[0].request_id, 'unknown')
})

test('request preparation rejection safely releases the shared session turn', async (t) => {
  const fx = await fixture(t)
  const first = fx.runner(fx.db)
  const rejected = await first.run(
    args('invalid', () => assert.fail('preparation precedes execution'), {
      applyAttempt() {
        throw Object.assign(new Error('synthetic invalid cache control'), {
          status: 400,
          body: { error: { code: 'invalid_cache_control' } },
        })
      },
    }),
  )
  assert.equal(rejected.status, 400)
  assert.deepEqual(await fx.rows(), [])
  assert.equal((await fx.runner(fx.other).run(args('next', async () => success()))).ok, true)
})

for (const failure of [
  Object.assign(new Error('synthetic response already sent'), { code: 'response_sent' }),
  Object.assign(new Error('synthetic rejection after entering execution'), {
    status: 400,
    body: { error: { code: 'invalid_cache_control' } },
  }),
]) {
  test(`a ${failure.code || failure.body.error.code} exception after entering execution keeps the shared turn`, async (t) => {
    const fx = await fixture(t)
    const result = await fx.runner(fx.db).run(
      args('unknown-rejection', () => {
        throw failure
      }),
    )
    assert.equal(result.executionUncertain, true)
    const rows = await fx.rows()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].state, 'active')
    assert.ok(rows[0].uncertain_at)
  })
}

test('an exception during selected reservation release conservatively retains the shared session turn', async (t) => {
  const fx = await fixture(t)
  const failure = new Error('synthetic reservation release failure')
  const first = fx.runner(fx.db, {
    release: async () => {
      throw failure
    },
  })
  await assert.rejects(first.run(args('release-failed', async () => success())), (error) => error === failure)
  const rows = await fx.rows()
  assert.equal(rows[0].state, 'active')
  assert.ok(rows[0].uncertain_at)
  const blocked = await fx.runner(fx.other, { timeout: 40 }).run(args('next', () => assert.fail('release failed')))
  assert.equal(blocked.status, 529)
})

test('terminating the owner process leaves its persistent active turn blocking another runner', {
  timeout: 5000,
}, async (t) => {
  const fx = await fixture(t)
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { createDatabase } from './src/lib/db/database.mjs';
    import { FailoverRunner } from './src/lib/pool/failover-runner.mjs';
    const db = await createDatabase({ connectionString: process.env.VM2API_TEST_DATABASE_URL, schema: process.env.KIN_DATABASE_SCHEMA });
    const runner = new FailoverRunner({ scheduler: {
      accountQuota: { db },
      selectAndReserve: async () => ({ ok: true, accountId: 'account', vmId: 'vm', release: async () => {} }),
    }});
    setInterval(() => {}, 1000);
    await runner.run({ requestId: 'killed-owner', stickyKey: 'shared-conversation', model: 'claude-test', canonicalBody: {},
      callAttempt: async () => { process.stdout.write('active\\n'); await new Promise(() => {}); }
    });
  `,
    ],
    { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  await Promise.race([
    once(child.stdout, 'data').then(([chunk]) => assert.match(String(chunk), /active/)),
    once(child, 'exit').then(() => assert.fail(`owner exited before entering execution: ${stderr}`)),
  ])
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  const rows = await fx.rows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, 'active')
  assert.equal(rows[0].request_id, 'killed-owner')
  const blocked = await fx
    .runner(fx.other, { timeout: 40 })
    .run(args('next', () => assert.fail('owner loss is not termination proof')))
  assert.equal(blocked.status, 529)
  assert.equal((await fx.rows())[0].id, rows[0].id)
})
