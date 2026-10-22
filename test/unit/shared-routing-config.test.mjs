import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'
import { createDatabase, getDb, withTransaction } from '../../src/lib/db/database.mjs'
import { readRoutingDocument } from '../../src/lib/core/routing-document.mjs'
import { readRoutingConfigFile } from '../../src/lib/core/config.mjs'
import { cacheTtlFromRoutingFile } from '../../src/lib/protocol/cache-ttl.mjs'
import { personaModeFromRoutingFile } from '../../src/lib/identity/crs-persona.mjs'

async function fixture(t) {
  const db = getDb()
  const peer = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shared-routing-'))
  const seed = { sticky: { enabled: true, ttl_seconds: 60 }, codex: { quota: {} }, pool: { queue_max: 10 } }
  const apps = []
  for (const [index, connection] of [db, peer].entries()) {
    const project = path.join(dir, String(index))
    fs.mkdirSync(path.join(project, 'vms'), { recursive: true })
    const file = path.join(project, 'routing.json')
    fs.writeFileSync(file, JSON.stringify(seed))
    let config = structuredClone(seed)
    const calls = []
    const runtime = createRoutingRuntime({
      db: connection,
      shared: true,
      cfg: { paths: { project } },
      routingConfigPath: file,
      getRoutingConfig: () => config,
      setRoutingConfig: (next) => {
        config = next
      },
      stickyRouter: { reloadConfig() {} },
      accountQuota: { reloadConfig() {}, repo: { list: () => [] } },
      healthMonitor: {
        setConfig(value) {
          calls.push(value)
        },
      },
    })
    config = await (runtime.initRoutingConfig ? runtime.initRoutingConfig() : runtime.loadRoutingConfig())
    apps.push({ runtime, file, calls, get: () => config })
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { db, peer, apps, seed }
}

test('routing patches merge into committed PG configuration across independent replicas', async (t) => {
  const {
    apps: [first, second],
  } = await fixture(t)
  await first.runtime.persistRoutingPatch({ sticky: { ttl_seconds: 300 } })
  await second.runtime.persistRoutingPatch({ pool: { queue_max: 20 } })
  assert.equal(second.get().sticky.ttl_seconds, 300)
  assert.equal(second.get().pool.queue_max, 20)
})

test('a shared routing update treats its seed file as read-only input', async (t) => {
  const {
    apps: [first],
  } = await fixture(t)
  const before = fs.readFileSync(first.file, 'utf8')
  fs.chmodSync(first.file, 0o444)
  await first.runtime.persistRoutingPatch({ sticky: { ttl_seconds: 300 } })
  assert.equal(first.get().sticky.ttl_seconds, 300)
  assert.equal(fs.readFileSync(first.file, 'utf8'), before)
})

test('PG routing commit failure does not publish memory, monitor changes or seed-file writes', async (t) => {
  const {
    db,
    apps: [first],
  } = await fixture(t)
  const before = structuredClone(first.get())
  const file = fs.readFileSync(first.file, 'utf8')
  first.calls.length = 0
  await db.exec(`CREATE FUNCTION reject_routing_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic routing commit failure' USING ERRCODE = 'P0001'; END $$;
    CREATE TRIGGER reject_routing_write BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION reject_routing_write()`)
  await assert.rejects(first.runtime.persistRoutingPatch({ health_probe: { enabled: false } }), { code: 'P0001' })
  assert.deepEqual(first.get(), before)
  assert.deepEqual(first.calls, [])
  assert.equal(fs.readFileSync(first.file, 'utf8'), file)
})

test('an explicitly stale routing revision is rejected instead of overwriting newer settings', async (t) => {
  const {
    apps: [first, second],
  } = await fixture(t)
  const revision = second.runtime.routingState?.currentRevision || 1
  await first.runtime.persistRoutingPatch({ sticky: { ttl_seconds: 300 } })
  await assert.rejects(second.runtime.persistRoutingPatch({ sticky: { ttl_seconds: 999 } }, { ifRevision: revision }), {
    code: 'routing_config_stale',
  })
})

test('a new replica uses PG once seeded even if its local bootstrap document is invalid', async (t) => {
  const {
    peer,
    apps: [first, second],
  } = await fixture(t)
  await first.runtime.persistRoutingPatch({ sticky: { ttl_seconds: 300 } })
  fs.writeFileSync(second.file, '{invalid bootstrap JSON')
  let config
  const runtime = createRoutingRuntime({
    db: peer,
    shared: true,
    cfg: { paths: { project: path.dirname(second.file) } },
    routingConfigPath: second.file,
    getRoutingConfig: () => config,
    setRoutingConfig: (value) => {
      config = value
    },
  })
  await runtime.initRoutingConfig()
  assert.equal(config.sticky.ttl_seconds, 300)
})

test('synchronous routing consumers read committed snapshots after refresh without touching input files', async (t) => {
  const {
    apps: [first, second],
  } = await fixture(t)
  await first.runtime.persistRoutingPatch({ compatibility: { cache_ttl: '5m', persona_inject: 'zero' } })
  await second.runtime.refreshRouting()
  fs.unlinkSync(second.file)
  assert.equal(readRoutingDocument(second.file).compatibility.cache_ttl, '5m')
  assert.equal(cacheTtlFromRoutingFile(second.file), '5m')
  assert.equal(personaModeFromRoutingFile(second.file), 'zero')
  const previous = process.env.KIN_ROUTING_FILE
  process.env.KIN_ROUTING_FILE = second.file
  try {
    assert.equal(readRoutingConfigFile().compatibility.cache_ttl, '5m')
  } finally {
    if (previous === undefined) delete process.env.KIN_ROUTING_FILE
    else process.env.KIN_ROUTING_FILE = previous
  }
})

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('a delayed routing refresh cannot overwrite a newer committed revision', async (t) => {
  const {
    apps: [first, second],
  } = await fixture(t)
  const state = second.runtime.routingState
  const read = state.repo.get.bind(state.repo)
  const entered = deferred()
  const resume = deferred()
  state.repo.get = async () => {
    const value = await read()
    entered.resolve()
    await resume.promise
    return value
  }
  const delayed = state.refresh()
  await entered.promise
  state.repo.get = read
  await first.runtime.persistRoutingPatch({ sticky: { ttl_seconds: 300 } })
  await state.refresh()
  resume.resolve()
  await delayed
  assert.equal(second.get().sticky.ttl_seconds, 300)
  assert.equal(readRoutingDocument(second.file).sticky.ttl_seconds, 300)
})

test('routing revision validation holds the PG share lock until execution admission commits', async (t) => {
  const {
    db,
    apps: [first, second],
  } = await fixture(t)
  const entered = deferred()
  const resume = deferred()
  const revision = first.runtime.routingState.currentRevision
  const admission = withTransaction(db, async () => {
    await first.runtime.routingState.assertRevision(revision)
    entered.resolve()
    await resume.promise
  })
  await entered.promise
  let committed = false
  const patch = second.runtime.persistRoutingPatch({ sticky: { ttl_seconds: 300 } }).then(() => {
    committed = true
  })
  try {
    await setImmediate()
    assert.equal(committed, false)
  } finally {
    resume.resolve()
    await admission
    await patch
  }
  await assert.rejects(first.runtime.routingState.assertRevision(revision), { code: 'routing_config_stale' })
  await assert.rejects(first.runtime.routingState.assertRevision(undefined), { code: 'routing_config_stale' })
})

test('shared config reports pending VM projection without writing its VM fixture', async (t) => {
  const {
    apps: [first],
  } = await fixture(t)
  const project = path.dirname(first.file)
  const vmFile = path.join(project, 'vms', 'vm-projection.json')
  const content = JSON.stringify({ id: 'vm-projection', status: 'running', policy: { maxConcurrency: 2 } })
  fs.writeFileSync(vmFile, content)
  const result = await first.runtime.persistRoutingPatch({ tiers: { default: { max_concurrency: 1 } } })
  assert.equal(result.application.status, 'pending')
  assert.ok(
    result.application.pending.some((item) => item.component === 'vm_projection' && item.vm_id === 'vm-projection'),
  )
  assert.equal(fs.readFileSync(vmFile, 'utf8'), content)
})
