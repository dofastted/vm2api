import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { createDatabase, getDb, withTransaction } from '../../src/lib/db/database.mjs'

async function service(db = getDb(), ownerId = 'owner-a') {
  const { SharedBackgroundTasks } = await import('../../src/lib/core/shared-background-tasks.mjs')
  return new SharedBackgroundTasks(db, { ownerId })
}

async function otherDatabase(t) {
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(() => other.close())
  return other
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const plan = (executionId, taskKey = 'synthetic-task') => ({ taskKey, executionId })

test('two PostgreSQL connections have one claim per task and completed executions remain deduplicated', async (t) => {
  const first = await service()
  const second = await service(await otherDatabase(t), 'owner-b')
  const claims = await Promise.all([first.tryClaim(plan('one')), second.tryClaim(plan('one'))])
  assert.equal(claims.filter((claim) => claim.ok).length, 1)
  assert.equal(claims.find((claim) => !claim.ok).code, 'background_task_active')
  const winner = claims.find((claim) => claim.ok)
  assert.deepEqual(await winner.complete(), { completed: true })
  assert.deepEqual(await winner.complete(), { completed: true })
  assert.equal((await second.tryClaim(plan('one'))).code, 'background_task_completed')
  const next = await second.tryClaim(plan('two'))
  assert.equal(next.ok, true)
  await next.complete()
})

test('interval execution IDs use PostgreSQL time rather than either controller clock', async (t) => {
  const first = await service()
  const second = await service(await otherDatabase(t), 'owner-b')
  t.mock.method(Date, 'now', () => 0)
  const claimed = await first.tryClaim({ taskKey: 'interval', intervalMs: 1_000_000_000_000 })
  const dbNow = await second.now()
  assert.equal(claimed.executionId, `interval:1000000000000:${Math.floor(dbNow / 1_000_000_000_000)}`)
  await claimed.complete()
  Date.now = () => 9_000_000_000_000
  assert.equal(
    (await second.tryClaim({ taskKey: 'interval', intervalMs: 1_000_000_000_000 })).code,
    'background_task_completed',
  )
})

test('exceptions, ordinary error returns and explicit unknown outcomes block subsequent plans without TTL', async (t) => {
  const first = await service()
  const second = await service(await otherDatabase(t), 'owner-b')
  await assert.rejects(
    first.run(plan('one', 'exception'), () => {
      throw new Error('synthetic remote outcome unknown')
    }),
    /synthetic remote outcome unknown/,
  )
  const ordinary = await first.run(plan('one', 'ordinary'), () => ({ value: { ok: false } }))
  assert.equal(ordinary.unknown, true)
  const unknown = await first.tryClaim(plan('one', 'unknown'))
  await unknown.markUnknown()
  assert.deepEqual(await unknown.complete(), { completed: false })
  await getDb().exec("UPDATE background_task_runs SET claimed_at = clock_timestamp() - interval '10 years'")
  for (const key of ['exception', 'ordinary', 'unknown']) {
    assert.equal((await second.tryClaim(plan('later', key))).code, 'background_task_active')
  }
})

test('explicit terminal failures and known not-started errors permit later plans', async (t) => {
  const first = await service()
  const second = await service(await otherDatabase(t), 'owner-b')
  const result = await first.run(plan('one'), () => ({ terminal: true, value: { ok: false, code: 'rejected' } }))
  assert.deepEqual(result.value, { ok: false, code: 'rejected' })
  assert.equal(result.unknown, false)
  const notStarted = await first.run(plan('two'), () => ({ notStarted: true, value: null }))
  assert.equal(notStarted.unknown, false)
  await assert.rejects(
    first.run(plan('three'), () => {
      throw Object.assign(new Error('synthetic validation failure'), { taskNotStarted: true })
    }),
    /synthetic validation failure/,
  )
  await assert.rejects(
    first.run(plan('four'), () => {
      throw Object.assign(new Error('synthetic terminal rejection'), { taskTerminal: true })
    }),
    /synthetic terminal rejection/,
  )
  const next = await second.tryClaim(plan('five'))
  assert.equal(next.ok, true)
  await next.complete()
})

test('shared results persist only when explicitly supplied and are returned to deduplicated callers', async (t) => {
  const first = await service()
  const second = await service(await otherDatabase(t), 'owner-b')
  await first.run(plan('private', 'private-task'), () => ({ terminal: true, value: { secret: 'synthetic' } }))
  assert.equal(
    (await getDb().prepare('SELECT shared_result FROM background_task_runs WHERE task_key = $1').get('private-task'))
      .shared_result,
    null,
  )
  const publicResult = { anthropic: { ok: true, message_id: 'synthetic-message' }, openai: null }
  await first.run(plan('one', 'public-task'), () => ({ terminal: true, value: 42, sharedResult: publicResult }))
  const skipped = await second.run(plan('one', 'public-task'), () => assert.fail('duplicate callback'))
  assert.equal(skipped.ran, false)
  assert.deepEqual(skipped.sharedResult, publicResult)
})

test('claim completion validates ownership and retries PostgreSQL after a failed completion', async (t) => {
  const first = await service()
  const second = await service(await otherDatabase(t), 'owner-b')
  const claimed = await first.tryClaim(plan('one'))
  assert.deepEqual(await second.complete({ ...claimed, ownerId: 'owner-b' }), { completed: false })
  await getDb().exec(`CREATE FUNCTION refuse_background_finish() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.finished_at IS NOT NULL THEN RAISE EXCEPTION 'synthetic completion failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER refuse_background_finish BEFORE UPDATE ON background_task_runs FOR EACH ROW EXECUTE FUNCTION refuse_background_finish()`)
  await assert.rejects(claimed.complete(), { code: 'P0001' })
  assert.equal((await second.tryClaim(plan('later'))).code, 'background_task_active')
  await getDb().exec('DROP TRIGGER refuse_background_finish ON background_task_runs')
  assert.deepEqual(await claimed.complete(), { completed: true })
})

test('closing the owner database cannot release its committed claim or run a fallback', async (t) => {
  const other = await otherDatabase(t)
  const first = await service(other)
  const second = await service(getDb(), 'owner-b')
  assert.equal((await first.tryClaim(plan('one'))).ok, true)
  await other.close()
  let called = false
  await assert.rejects(first.run(plan('other', 'closed'), () => (called = true)))
  assert.equal(called, false)
  assert.equal((await second.tryClaim(plan('later'))).code, 'background_task_active')
})

test('claims cannot be created within an outer transaction that could roll them back after a side effect', async () => {
  const tasks = await service()
  await assert.rejects(
    withTransaction(getDb(), () => tasks.tryClaim(plan('one'))),
    {
      code: 'background_task_transaction_active',
    },
  )
})

test('flush awaits the callback and its durable terminal state', async () => {
  const tasks = await service()
  const entered = deferred()
  const finish = deferred()
  const pending = tasks.run(plan('one'), async () => {
    entered.resolve()
    await finish.promise
    return { terminal: true }
  })
  await entered.promise
  let flushed = false
  const flushing = tasks.flush().then(() => {
    flushed = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(flushed, false)
  finish.resolve()
  await Promise.all([pending, flushing])
  assert.equal(
    (await getDb().prepare('SELECT count(*) AS n FROM background_task_runs WHERE finished_at IS NULL').get()).n,
    0,
  )
})

function spawnOwner(script) {
  return spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
}

function childSetup() {
  const databaseUrl = new URL('../../src/lib/db/database.mjs', import.meta.url).href
  const serviceUrl = new URL('../../src/lib/core/shared-background-tasks.mjs', import.meta.url).href
  return `import { createDatabase } from ${JSON.stringify(databaseUrl)};
    import { SharedBackgroundTasks } from ${JSON.stringify(serviceUrl)};
    const db = await createDatabase({ connectionString: process.env.VM2API_TEST_DATABASE_URL, schema: process.env.KIN_DATABASE_SCHEMA });
    const tasks = new SharedBackgroundTasks(db);`
}

async function firstLine(child) {
  const lines = createInterface({ input: child.stdout })
  return Promise.race([
    once(lines, 'line').then(([line]) => JSON.parse(line)),
    once(child, 'exit').then(() => {
      throw new Error('synthetic owner exited before reporting')
    }),
  ])
}

test('two separate processes execute the same explicit plan once', async (t) => {
  await service()
  await getDb().exec('CREATE TABLE synthetic_background_effects (id integer)')
  const script = `${childSetup()}
    const result = await tasks.run({ taskKey: 'process-race', executionId: 'same-plan' }, async () => {
      await db.prepare('INSERT INTO synthetic_background_effects VALUES (1)').run();
      return { terminal: true };
    });
    process.stdout.write(JSON.stringify({ ran: result.ran }) + '\\n');
    await db.close();`
  const children = [spawnOwner(script), spawnOwner(script)]
  t.after(() => children.forEach((child) => child.kill('SIGKILL')))
  const outcomes = await Promise.all(children.map(firstLine))
  assert.equal(outcomes.filter((outcome) => outcome.ran).length, 1)
  assert.equal((await getDb().prepare('SELECT count(*) AS n FROM synthetic_background_effects').get()).n, 1)
})

test('SIGKILL does not make a background task available to a new owner', async (t) => {
  const observer = await service()
  const child = spawnOwner(`${childSetup()}
    const claim = await tasks.tryClaim({ taskKey: 'killed', executionId: 'one' });
    process.stdout.write(JSON.stringify({ ok: claim.ok }) + '\\n');
    setInterval(() => {}, 1000);`)
  t.after(() => child.kill('SIGKILL'))
  assert.equal((await firstLine(child)).ok, true)
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  assert.equal((await observer.tryClaim(plan('later', 'killed'))).code, 'background_task_active')
})
