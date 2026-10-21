import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { SharedBackgroundTasks } from '../../src/lib/core/shared-background-tasks.mjs'
import {
  loadModelPolicy,
  getModelPolicy,
  syncWorkerModelsIntoPolicy,
  saveModelPolicy,
  resetModelPolicy,
} from '../../src/lib/protocol/model-policy.mjs'
import {
  loadGptModelPolicy,
  getGptModelPolicy,
  syncGptIdsIntoPolicy,
  saveGptModelPolicy,
  resetGptModelPolicy,
} from '../../src/lib/protocol/gpt-model-policy.mjs'
import {
  syncClaudeCatalog,
  syncGptCatalog,
  readCatalogSync,
  createCatalogMonitor,
} from '../../src/lib/admin/catalog-monitor.mjs'
import { syncModelsDev } from '../../src/lib/admin/price-catalog.mjs'

async function fixture(t) {
  const db = getDb()
  const peer = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shared-catalog-'))
  fs.mkdirSync(path.join(projectRoot, 'vms'))
  t.after(async () => {
    await peer.close()
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })
  await loadModelPolicy({ force: true })
  await loadGptModelPolicy({ force: true })
  return { db, peer, projectRoot, repo: new SettingsRepo(peer) }
}

function seedVm(projectRoot) {
  fs.writeFileSync(
    path.join(projectRoot, 'vms', 'catalog-vm.json'),
    JSON.stringify({
      id: 'catalog-vm',
      status: 'running',
      claude: { access_token: 'synthetic', refresh_token: 'synthetic', account_uuid: 'synthetic' },
      proxy: { url: 'socks5h://127.0.0.1:19099' },
    }),
  )
}

test("Claude catalog merging preserves another connection's committed model edits", async (t) => {
  const { repo } = await fixture(t)
  const current = await repo.get('model_policy')
  current.models['claude-opus-5'].enabled = false
  await repo.set('model_policy', current)
  await syncWorkerModelsIntoPolicy(['claude-opus-6-synthetic'])
  const stored = await repo.get('model_policy')
  assert.equal(stored.models['claude-opus-5'].enabled, false)
  assert.ok(stored.models['claude-opus-6-synthetic'])
})

test("GPT catalog merging preserves another connection's committed model edits", async (t) => {
  const { repo } = await fixture(t)
  const current = await repo.get('gpt_model_policy')
  current.models['gpt-5.6'].enabled = false
  await repo.set('gpt_model_policy', current)
  await syncGptIdsIntoPolicy(['gpt-5.6', 'gpt-7-synthetic'])
  assert.equal((await repo.get('gpt_model_policy')).models['gpt-5.6'].enabled, false)
})

test('failed catalog policy commits reject without publishing uncommitted models', async (t) => {
  const { db } = await fixture(t)
  await db.exec(`CREATE FUNCTION refuse_catalog_policy() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.key IN ('model_policy','gpt_model_policy') THEN
      RAISE EXCEPTION 'synthetic catalog commit failure' USING ERRCODE='P6485'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER refuse_catalog_policy BEFORE INSERT OR UPDATE ON settings
    FOR EACH ROW EXECUTE FUNCTION refuse_catalog_policy()`)
  await assert.rejects(syncWorkerModelsIntoPolicy(['claude-opus-6-synthetic']), { code: 'P6485' })
  assert.equal(getModelPolicy().models['claude-opus-6-synthetic'], undefined)
  await assert.rejects(syncGptIdsIntoPolicy(['gpt-7-synthetic']), { code: 'P6485' })
  assert.equal(getGptModelPolicy().models['gpt-7-synthetic'], undefined)
})

for (const [name, write, read] of [
  ['Claude save', saveModelPolicy, getModelPolicy],
  ['Claude reset', resetModelPolicy, getModelPolicy],
  ['GPT save', saveGptModelPolicy, getGptModelPolicy],
  ['GPT reset', resetGptModelPolicy, getGptModelPolicy],
]) {
  test(`${name} rejects a PostgreSQL failure before publishing local policy`, async (t) => {
    const { db } = await fixture(t)
    const before = structuredClone(read())
    await db.exec(`CREATE FUNCTION refuse_policy_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic policy write failure' USING ERRCODE='P6486'; END $$;
      CREATE TRIGGER refuse_policy_write BEFORE INSERT OR UPDATE ON settings
      FOR EACH ROW EXECUTE FUNCTION refuse_policy_write()`)
    await assert.rejects(write({ ...before, source: 'synthetic-not-committed' }), { code: 'P6486' })
    assert.deepEqual(read(), before)
  })
}

test('concurrent Claude and GPT status writes preserve both platform fields', async (t) => {
  const { projectRoot } = await fixture(t)
  seedVm(projectRoot)
  await Promise.all([
    syncClaudeCatalog({ projectRoot, runOauth: async () => ({ ok: true, body: { data: [{ id: 'claude-opus-5' }] } }) }),
    syncGptCatalog({ projectRoot }),
  ])
  assert.equal(readCatalogSync().claude?.status, 'ok')
  assert.equal(readCatalogSync().codex?.status, 'skipped')
})

test('two catalog monitors share the scheduled models.dev request', async (t) => {
  const { db, peer, projectRoot } = await fixture(t)
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return new Response(JSON.stringify({ anthropic: { models: {} }, openai: { models: {} } }))
  })
  const monitors = [db, peer].map((connection) =>
    createCatalogMonitor({
      projectRoot,
      sharedTasks: new SharedBackgroundTasks(connection),
    }),
  )
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => monitors.forEach((monitor) => monitor.stop()))
  for (const monitor of monitors) monitor.start()
  t.mock.timers.tick(5000)
  await Promise.all(monitors.map((monitor) => monitor.flush()))
  assert.equal(requests, 1)
})

test('a failed price fetch preserves the latest committed snapshot from another connection', async (t) => {
  const { repo } = await fixture(t)
  await repo.set('price_catalog_modelsdev', {
    status: 'ok',
    fetched_at: '2026-10-21T00:00:00.000Z',
    anthropic: { 'claude-opus-6-synthetic': { name: 'synthetic', cost: { input: 1 } } },
    openai: {},
  })
  await syncModelsDev({
    fetchImpl: async () => {
      throw new Error('synthetic network failure')
    },
  })
  const stored = await repo.get('price_catalog_modelsdev')
  assert.ok(stored.anthropic['claude-opus-6-synthetic'])
  assert.equal(stored.fetched_at, '2026-10-21T00:00:00.000Z')
})
