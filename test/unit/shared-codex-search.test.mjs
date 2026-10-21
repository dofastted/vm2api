import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import fetch from 'node-fetch'
import pg from 'pg'
import { getDb, getActivityCoordinator, quoteIdentifier } from '../../src/lib/db/database.mjs'
import { withDatabaseActivities } from '../maintenance-fixture.mjs'
import { createRepositoryTestDatabase as createDatabase } from '../repository-database.mjs'
import { handleCodexSearch } from '../../src/lib/protocol/handle-codex.mjs'
import { SharedCodexRuntime } from '../../src/lib/pool/shared-codex-runtime.mjs'
import { SharedExecutionAdmissions } from '../../src/lib/pool/shared-execution-admissions.mjs'
import { SharedRoutingConfig } from '../../src/lib/admin/shared-routing-config.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

const accountId = 'codex:synthetic-search-account'
const vmId = 'vm-search-a'

async function until(check) {
  const deadline = Date.now() + 2000
  while (!(await check())) {
    if (Date.now() >= deadline) assert.fail('condition did not become true')
    await delay(5)
  }
}

function answer(res, status = 200, body = { output: 'synthetic search result' }) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function fixture(t, handle = (_req, res) => answer(res), { vms = 1 } = {}) {
  resetOpenAIAccountRuntime()
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shared-search-'))
  for (const id of [vmId, 'vm-search-b'].slice(0, vms)) {
    fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({
        id,
        platform: 'openai',
        family: 'codex',
        schedulable: true,
        status: 'running',
        policy: { maxConcurrency: 1, concurrencyOverride: false, maxRpm: 99, rpmOverride: false },
      }),
    )
    fs.writeFileSync(
      path.join(root, 'vms', id, 'codex-credentials.json'),
      JSON.stringify({
        accounts: [
          {
            id: 'synthetic-account',
            access_token: 'synthetic-access',
            refresh_token: 'synthetic-refresh',
            chatgpt_account_id: 'synthetic-search-account',
          },
        ],
      }),
    )
  }
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  const runtimes = [db, other].map(
    (connection, index) => new SharedCodexRuntime(connection, { ownerId: `search-${index}` }),
  )
  const calls = []
  const bindings = []
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      calls.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) })
      bindings.push(
        await other
          .prepare('SELECT * FROM execution_jobs WHERE request_id = $1')
          .get(req.headers['x-client-request-id'] || ''),
      )
      await handle(req, res, calls.length)
    })().catch((error) => res.destroy(error))
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    const coordinators = [db, other].map((connection) => getActivityCoordinator(connection)).filter(Boolean)
    for (const coordinator of coordinators) await coordinator.stop()
    await other.close()
    if (coordinators.length) {
      const client = new pg.Client({ connectionString: db.connectionString })
      await client.connect()
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(coordinators[0].schema)} CASCADE`)
      } finally {
        await client.end()
      }
    }
    fs.rmSync(root, { recursive: true, force: true })
    if (previous == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const url = `http://127.0.0.1:${server.address().port}/search`
  return {
    root,
    db,
    other,
    calls,
    bindings,
    runtimes,
    counts: () => runtimes[1].admissions.getCounts(accountId, vmId),
    async run({ controller = 0, signal, timeoutMs, quota = {}, refresh, pin = null } = {}) {
      const req = Object.assign(new EventEmitter(), {
        headers: { 'user-agent': 'codex_exec/0.160.1', ...(pin ? { 'x-kin-vm': pin } : {}) },
        apiKeyKind: pin ? 'master' : 'user',
      })
      const res = Object.assign(new EventEmitter(), { statusCode: 0, setHeader() {} })
      const logBag = {}
      const aborted = () => req.emit('aborted')
      signal?.addEventListener('abort', aborted, { once: true })
      try {
        await handleCodexSearch({
          req,
          res,
          body: { id: 'search-request-id', model: 'gpt-6.1-sol', commands: { search_query: [{ q: 'synthetic' }] } },
          logBag,
          stats: { requests: 0, errors: 0, by_route: {} },
          routing: { codex: { quota: { max_concurrency: 1, ...quota } }, pool: { fallback_wait_timeout_ms: 1000 } },
          projectRoot: root,
          json(_res, status, body) {
            res.statusCode = status
            res.body = body
          },
          ops: {
            sharedRuntime: runtimes[controller],
            // Bound the old truncated-body behavior as well as the implementation under test.
            fetchImpl: (_url, init) => fetch(url, { timeout: 2500, ...init }),
            refresh,
            searchTimeoutMs: timeoutMs,
          },
        })
      } finally {
        signal?.removeEventListener('abort', aborted)
      }
      return { res, logBag }
    },
  }
}

test('Search holds global capacity until its complete HTTP body and persists the job before send', async (t) => {
  let response
  const fx = await fixture(t, (_req, res, count) => {
    if (count > 1) return answer(res)
    response = res
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"output":')
  })
  const first = fx.run()
  try {
    await until(() => fx.calls.length === 1)
    const blocked = await fx.run({ controller: 1 })
    assert.equal(blocked.res.statusCode, 429)
    assert.equal(fx.calls.length, 1)
    assert.ok(fx.bindings[0], 'the independent database connection must observe the job before HTTP submission')
    assert.equal((await fx.counts()).vmInflight, 1)
  } finally {
    response?.end('"complete"}')
    await first
  }
  assert.equal((await fx.counts()).vmInflight, 0)
  const row = await fx.other
    .prepare(
      'SELECT j.ended_at, a.released_at FROM execution_jobs j JOIN execution_admissions a ON a.id=j.admission_id',
    )
    .get()
  assert.ok(row.ended_at && row.released_at >= row.ended_at)
  assert.equal((await fx.other.prepare('SELECT count(*) AS count FROM session_turns').get()).count, 0)
})

test('a truncated Search body retains capacity and forbids retry on another VM', async (t) => {
  const fx = await fixture(
    t,
    (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json', 'content-length': '200' })
      res.write('{"error":')
      setImmediate(() => res.destroy())
    },
    { vms: 2 },
  )
  const result = await fx.run()
  assert.equal(fx.calls.length, 1)
  assert.equal(result.res.statusCode, 502)
  assert.equal(result.res.body.error.code, 'codex_search_execution_uncertain')
  assert.equal((await fx.counts()).accountInflight, 1)
  const job = await fx.other.prepare('SELECT * FROM execution_jobs').get()
  assert.equal(job.ended_at, null)
  const blocked = await fx.run({ controller: 1 })
  assert.equal(blocked.res.statusCode, 429)
  assert.equal(fx.calls.length, 1)
})

test('a complete Search HTTP error releases its admission before failover to another VM', async (t) => {
  const fx = await fixture(
    t,
    async (_req, res, count) => {
      if (count > 1) {
        const previous = await fx.other
          .prepare(`SELECT j.ended_at, a.released_at FROM execution_jobs j
          JOIN execution_admissions a ON a.id=j.admission_id WHERE j.request_id=$1`)
          .get(fx.calls[0].headers['x-client-request-id'])
        assert.ok(previous.ended_at && previous.released_at >= previous.ended_at)
      }
      answer(res, count === 1 ? 500 : 200)
    },
    { vms: 2 },
  )
  const result = await fx.run()
  assert.equal(result.res.statusCode, 200)
  assert.equal(fx.calls.length, 2)
  const jobs = await fx.other.prepare('SELECT * FROM execution_jobs').all()
  assert.equal(jobs.length, 2)
  assert.notEqual(jobs[0].admission_id, jobs[1].admission_id)
  assert.ok(jobs.every((job) => job.ended_at))
  assert.equal((await fx.counts()).accountInflight, 0)
})

test('released Search admissions still enforce the shared account RPM across controllers', async (t) => {
  const fx = await fixture(t)
  assert.equal((await fx.run({ quota: { max_rpm: 1 } })).res.statusCode, 200)
  assert.equal((await fx.run({ controller: 1, quota: { max_rpm: 1 } })).res.statusCode, 429)
  assert.equal(fx.calls.length, 1)
  assert.equal((await fx.counts()).accountInflight, 0)
  assert.equal((await fx.counts()).rpmCount, 1)
})

test('shared Search does not follow an HTTP redirect as an unregistered second job', async (t) => {
  const fx = await fixture(t, (_req, res, count) => {
    if (count === 1) {
      res.writeHead(307, { 'content-type': 'application/json', location: '/redirected-search' })
      res.end('{"redirected":true}')
    } else answer(res)
  })
  const result = await fx.run()
  assert.equal(result.res.statusCode, 307)
  assert.equal(fx.calls.length, 1)
  assert.equal((await fx.other.prepare('SELECT count(*) AS count FROM execution_jobs').get()).count, 1)
  assert.equal((await fx.counts()).accountInflight, 0)
})

for (const status of [401, 403]) {
  test(`Search completes its ${status} job before refresh and retries with a new persisted ID`, async (t) => {
    const fx = await fixture(t, (_req, res, count) => answer(res, count === 1 ? status : 200))
    let refreshes = 0
    await withDatabaseActivities([fx.db, fx.other], async () => {
      const result = await fx.run({
        refresh: async () => {
          refreshes += 1
          const previous = await fx.other.prepare('SELECT * FROM execution_jobs').get()
          assert.ok(previous?.ended_at, 'the first HTTP job must be durably complete before refresh/retry')
          return {
            ok: true,
            attemptFinished: true,
            access_token: 'synthetic-new-access',
            refresh_token: 'synthetic-new-refresh',
          }
        },
      })
      assert.equal(result.res.statusCode, 200)
      assert.equal(refreshes, 1)
      assert.equal(fx.calls.length, 2)
      assert.ok(fx.bindings.every(Boolean))
      assert.notEqual(fx.calls[0].headers['x-client-request-id'], fx.calls[1].headers['x-client-request-id'])
      const jobs = await fx.other.prepare('SELECT * FROM execution_jobs').all()
      assert.equal(jobs.length, 2)
      assert.ok(jobs.every((job) => job.ended_at))
      assert.equal((await fx.counts()).accountInflight, 0)
    })
  })
}

test('an uncertain Search token refresh retains its original admission and both refresh claims', async (t) => {
  const fx = await fixture(t, (_req, res) => answer(res, 401))
  await withDatabaseActivities([fx.db, fx.other], async () => {
    let refreshes = 0
    const result = await fx.run({
      refresh: async () => {
        refreshes++
        return { ok: false, attemptFinished: false, error: 'fetch_failed' }
      },
    })
    assert.equal(result.res.statusCode, 502)
    assert.equal(refreshes, 1)
    assert.equal(fx.calls.length, 1)
    assert.equal((await fx.counts()).accountInflight, 1)
    const operation = await fx.other.prepare('SELECT released_at,uncertain_at FROM vm_operations').get()
    assert.equal(operation.released_at, null)
    assert.ok(operation.uncertain_at)
    const task = await fx.other.prepare('SELECT finished_at,unknown_at FROM background_task_runs').get()
    assert.equal(task.finished_at, null)
    assert.ok(task.unknown_at)
  })
})

for (const phase of ['timeout', 'cancel']) {
  test(`Search ${phase} after response headers retains its job and capacity`, async (t) => {
    let timer
    const fx = await fixture(
      t,
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('{"output":')
        // The finite drain also makes the old missing-timeout implementation fail without hanging the test.
        timer = setTimeout(() => res.end('"late"}'), 200)
      },
      { vms: 2 },
    )
    t.after(() => clearTimeout(timer))
    const controller = new AbortController()
    const pending = fx.run({ signal: controller.signal, timeoutMs: phase === 'timeout' ? 30 : undefined })
    await until(() => fx.calls.length === 1)
    if (phase === 'cancel') controller.abort()
    const result = await pending
    if (phase === 'timeout') {
      assert.equal(result.res.statusCode, 502)
      assert.equal(result.res.body.error.code, 'codex_search_execution_uncertain')
    } else assert.equal(result.logBag.final_state, 'cancelled')
    assert.equal(fx.calls.length, 1)
    assert.equal((await fx.counts()).accountInflight, 1)
    const job = await fx.other.prepare('SELECT * FROM execution_jobs').get()
    assert.equal(job.ended_at, null)
  })
}

for (const [phase, table, trigger, code, expectedCalls] of [
  ['binding', 'execution_jobs', 'INSERT', 'P6491', 0],
  ['completion', 'execution_jobs', 'UPDATE OF ended_at', 'P6492', 1],
  ['release', 'execution_admissions', 'UPDATE OF released_at', 'P6493', 1],
]) {
  test(`a Search database ${phase} failure stops further HTTP jobs and retains capacity`, async (t) => {
    const fx = await fixture(t, (_req, res) => answer(res, 500), { vms: 2 })
    await fx.db.exec(`CREATE FUNCTION reject_search_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic search ${phase}' USING ERRCODE = '${code}'; END;
      $$; CREATE TRIGGER reject_search_job BEFORE ${trigger} ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_search_job();`)
    await assert.rejects(fx.run(), { code })
    assert.equal(fx.calls.length, expectedCalls)
    assert.equal((await fx.counts()).accountInflight, 1)
    assert.equal((await fx.other.prepare('SELECT * FROM execution_admissions').get()).released_at, null)
  })
}

test('Search reselects captured PostgreSQL policy after a configuration revision race', async (t) => {
  const fx = await fixture(t)
  const file = path.join(fx.root, 'synthetic-routing.json')
  fs.writeFileSync(file, JSON.stringify({ codex: { quota: { max_concurrency: 2, max_rpm: 0 } } }))
  const state = new SharedRoutingConfig({
    db: fx.db,
    file,
    normalize: (value) => value,
    merge: (current, patch) => ({ ...current, ...patch }),
    apply: async () => {},
  })
  await state.init()
  fx.runtimes[0] = new SharedCodexRuntime(fx.db)
  const held = await new SharedExecutionAdmissions(fx.other).tryReserve({
    accountId,
    vmId: 'vm-held-elsewhere',
    accountLimit: 2,
    vmLimit: 1,
    rpmLimit: 0,
    fableLimit: 0,
  })
  const reserve = fx.runtimes[0].tryReserve.bind(fx.runtimes[0])
  let changed = false
  fx.runtimes[0].tryReserve = async (...args) => {
    if (!changed) {
      changed = true
      await state.patch({ codex: { quota: { max_concurrency: 1, max_rpm: 0 } } })
    }
    return reserve(...args)
  }
  try {
    const result = await fx.run({ quota: { max_concurrency: 9, max_rpm: 99 } })
    assert.equal(changed, true)
    assert.equal(result.res.statusCode, 429)
    assert.equal(fx.calls.length, 0)
  } finally {
    await held.release()
  }
})
