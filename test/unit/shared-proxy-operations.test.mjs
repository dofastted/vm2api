import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb } from '../../src/lib/db/database.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { BackgroundTaskRunsRepo } from '../../src/lib/db/repos/background-task-runs-repo.mjs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'

const TASK_KEY = 'proxy_operation:pool'

async function fixture(t) {
  const db = getDb()
  const peer = await createRepositoryTestDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(() => peer.close())
  const firstPool = await new ProxyPool({ db }).init()
  const secondPool = await new ProxyPool({ db: peer }).init()
  t.after(() => {
    firstPool.stopScheduler()
    secondPool.stopScheduler()
  })
  const imported = await firstPool.importLines('192.0.2.1:1080')
  firstPool.stopScheduler()
  return { db, peer, firstPool, secondPool, id: imported.items[0].id }
}

async function services(t) {
  const f = await fixture(t)
  const { SharedProxyOperations } = await import('../../src/lib/vm/shared-proxy-operations.mjs')
  return {
    ...f,
    first: new SharedProxyOperations(f.db, { ownerId: 'same-owner' }),
    second: new SharedProxyOperations(f.peer, { ownerId: 'same-owner' }),
  }
}

test('even an empty proxy cannot be edited while a foreign persistent proxy operation is active', async (t) => {
  const f = await fixture(t)
  const mode = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  t.after(() => {
    if (mode == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = mode
  })
  await new BackgroundTaskRunsRepo(f.peer).tryClaim({
    taskKey: TASK_KEY,
    executionId: 'foreign',
    ownerId: 'same-owner',
  })
  await assert.rejects(f.firstPool.update(f.id, { port: 2080 }), { code: 'proxy_operation_active' })
  assert.equal((await f.firstPool.repo.getById(f.id)).port, 1080)
})

test('proxy operation claims commit before callback and have exactly one winner across PG connections', async (t) => {
  const f = await services(t)
  const result = await Promise.all([f.first.tryAcquire(), f.second.tryAcquire()])
  assert.equal(result.filter((claim) => claim.ok).length, 1)
  const winner = result.find((claim) => claim.ok)
  assert.equal(
    (
      await f.peer
        .prepare('SELECT count(*) AS n FROM background_task_runs WHERE task_key = $1 AND finished_at IS NULL')
        .get(TASK_KEY)
    ).n,
    1,
  )
  assert.equal((await winner.release()).released, true)
  const next = await f.second.tryAcquire()
  assert.equal(next.ok, true)
  await next.release()
})

test('only the current exact task/execution/owner identity can edit or bind under its pool operation', async (t) => {
  const f = await services(t)
  const mode = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  t.after(() => {
    if (mode == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = mode
  })
  await f.first.run(async () => {
    assert.equal((await f.firstPool.update(f.id, { port: 2080 })).ok, true)
    // VM claim and pool operation are independent, nested permissions.
    await new SharedVmOperations(f.db).run('vm-new', () => f.firstPool.bind(f.id, 'vm-new'))
    return { terminal: true }
  })
  assert.equal((await f.firstPool.repo.getById(f.id)).port, 2080)
})

test('uncertain proxy operations survive owner DB disconnection and do not expire', async (t) => {
  const f = await services(t)
  const claim = await f.second.tryAcquire()
  await claim.markUncertain()
  assert.equal((await claim.release()).released, false)
  await f.peer.close()
  await f.db.prepare("UPDATE background_task_runs SET claimed_at = '2000-01-01' WHERE task_key = $1").run(TASK_KEY)
  assert.equal((await f.first.tryAcquire()).ok, false)
})

test('a normal callback without explicit terminal proof retains its persistent proxy operation', async (t) => {
  const f = await services(t)
  await f.first.run(async () => ({ value: 'HTTP response sent' }))
  assert.equal((await f.second.tryAcquire()).ok, false)
})

test('an exception retains ownership while an explicitly not-started failure can release', async (t) => {
  const f = await services(t)
  await assert.rejects(
    f.first.run(async () => {
      throw Object.assign(new Error('synthetic unsubmitted'), { proxyOperationNotStarted: true })
    }),
  )
  assert.equal((await f.second.tryAcquire()).ok, true)
})

test('expired callback contexts cannot authorize detached proxy mutations', async (t) => {
  const f = await services(t)
  let start
  const pending = new Promise((resolve) => {
    start = resolve
  })
  let descendant
  await f.first.run(async () => {
    descendant = pending.then(() => f.firstPool.update(f.id, { port: 2080 }))
    return { terminal: true }
  })
  const foreign = await f.second.tryAcquire()
  const mode = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  t.after(() => {
    if (mode == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = mode
  })
  start()
  await assert.rejects(descendant, { code: 'proxy_operation_active' })
  await foreign.release()
})

test('completed callback contexts cannot fall back to unclaimed mutations when no new owner exists', async (t) => {
  const f = await services(t)
  let start
  const pending = new Promise((resolve) => {
    start = resolve
  })
  let descendant
  await f.first.run(async () => {
    descendant = pending.then(() => f.firstPool.update(f.id, { port: 2080 }))
    return { terminal: true }
  })
  const mode = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  t.after(() => {
    if (mode == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = mode
  })
  start()
  await assert.rejects(descendant, { code: 'proxy_operation_inactive' })
})

test('nested pool operations reuse one claim and retain the value contract', async (t) => {
  const f = await services(t)
  await f.first.run(async () => {
    const value = await f.second.run(async () => ({ terminal: true, value: 'synthetic' }))
    assert.equal(value, 'synthetic')
    assert.equal(
      (
        await f.peer
          .prepare('SELECT count(*) AS n FROM background_task_runs WHERE task_key = $1 AND finished_at IS NULL')
          .get(TASK_KEY)
      ).n,
      1,
    )
    return { terminal: true }
  })
})

test('SIGKILL does not resell a proxy pool operation to another process', async (t) => {
  const f = await services(t)
  const repositoryUrl = new URL('../repository-database.mjs', import.meta.url).href
  const serviceUrl = new URL('../../src/lib/vm/shared-proxy-operations.mjs', import.meta.url).href
  const script = `import { createRepositoryTestDatabase } from ${JSON.stringify(repositoryUrl)};
    import { SharedProxyOperations } from ${JSON.stringify(serviceUrl)};
    const db = await createRepositoryTestDatabase({ connectionString: process.env.VM2API_TEST_DATABASE_URL, schema: process.env.KIN_DATABASE_SCHEMA });
    const claim = await new SharedProxyOperations(db).tryAcquire();
    process.stdout.write(JSON.stringify({ ok: claim.ok }) + '\\n');
    setInterval(() => {}, 1000);`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, KIN_DATABASE_SCHEMA: f.db.schema },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  t.after(() => child.kill('SIGKILL'))
  const lines = createInterface({ input: child.stdout })
  const message = await Promise.race([
    once(lines, 'line').then(([line]) => JSON.parse(line)),
    once(child, 'exit').then(() => {
      throw new Error('synthetic owner exited before reporting')
    }),
  ])
  assert.equal(message.ok, true)
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  assert.equal((await f.second.tryAcquire()).ok, false)
})
