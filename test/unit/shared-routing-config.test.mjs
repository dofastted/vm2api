import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'

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
