import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiEndpointStore } from '../../src/lib/admin/api-endpoints.mjs'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { runApiInference } from '../../src/lib/pool/api-protocol.mjs'
import { ApiScheduler } from '../../src/lib/pool/api-scheduler.mjs'

async function replicas() {
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  return { writer: new ApiEndpointStore({ db }), reader: new ApiEndpointStore({ db: other }), other }
}

async function endpoint(store) {
  return store.create({
    name: 'shared-test',
    base_url: 'https://synthetic.invalid',
    api_key_entries: [{ api_key: 'synthetic-upstream-key' }],
    models: [{ name: 'upstream-model', alias: 'public-model' }],
  })
}

// Observe the real scheduler's selection without forwarding to an upstream.
async function selection(store, scheduler, model = 'public-model') {
  let picked
  await runApiInference({
    store,
    scheduler: {
      reload: (rows) => scheduler.reload(rows),
      pick(requested) {
        picked = scheduler.pick(requested)
        return { ok: false, code: 'selection_observed', message: 'synthetic selection' }
      },
    },
    convertedBody: { model, messages: [{ role: 'user', content: 'synthetic request' }] },
  })
  return picked
}

test('API inference sees endpoint, key, model, and cooldown changes from another connection before selection', async () => {
  const { writer, reader, other } = await replicas()
  try {
    const rec = await endpoint(writer)
    const keyId = rec.api_key_entries[0].id
    const scheduler = new ApiScheduler()
    scheduler.reload(await reader.listRaw())

    await writer.update(rec.id, { disabled: true })
    assert.equal((await selection(reader, scheduler)).code, 'model_not_found', 'disabled endpoint stays unavailable')

    await writer.update(rec.id, { disabled: false })
    await writer.updateKey(keyId, { disabled: true })
    assert.equal((await selection(reader, scheduler)).code, 'api_pool_exhausted', 'disabled key stays unavailable')

    await writer.updateKey(keyId, { disabled: false })
    await writer.setKeyCooldown(keyId, new Date(Date.now() + 60_000).toISOString())
    assert.equal((await selection(reader, scheduler)).code, 'api_pool_exhausted', 'another replica cooldown applies')

    await writer.updateKey(keyId, { cooldown_until: null })
    await writer.update(rec.id, { models: [{ name: 'replacement-upstream', alias: 'replacement-model' }] })
    assert.equal((await selection(reader, scheduler)).code, 'model_not_found', 'removed model alias stays unavailable')
    assert.equal((await selection(reader, scheduler, 'replacement-model')).upstream_model, 'replacement-upstream')

    await writer.remove(rec.id)
    assert.equal((await selection(reader, scheduler, 'replacement-model')).code, 'model_not_found')
  } finally {
    await other.close()
  }
})

test('API inference rejects a shared endpoint read failure before selecting a cached endpoint', async () => {
  let selected = false
  const error = new Error('synthetic shared endpoint read failed')
  await assert.rejects(
    runApiInference({
      convertedBody: { model: 'public-model', messages: [] },
      store: {
        listRaw: async () => {
          throw error
        },
      },
      scheduler: {
        reload() {},
        pick() {
          selected = true
          return { ok: false, code: 'cached_selection', message: 'cached selection' }
        },
      },
    }),
    error,
  )
  assert.equal(selected, false)
})

test('automatic cooldown updates only extend across replicas while explicit administrator reset still clears', async () => {
  const { writer, reader, other } = await replicas()
  try {
    const rec = await endpoint(writer)
    const keyId = rec.api_key_entries[0].id
    const start = Date.now()
    const longer = new Date(start + 300_000).toISOString()
    await writer.setKeyCooldown(keyId, longer)
    await reader.setKeyCooldown(keyId, new Date(start + 30_000).toISOString())
    assert.equal((await reader.getRaw(rec.id)).api_key_entries[0].cooldown_until, longer)

    const longest = new Date(start + 900_000).toISOString()
    await Promise.all([
      writer.setKeyCooldown(keyId, longest),
      reader.setKeyCooldown(keyId, new Date(start + 60_000).toISOString()),
      writer.setKeyCooldown(keyId, new Date(start + 600_000).toISOString()),
    ])
    assert.equal((await reader.getRaw(rec.id)).api_key_entries[0].cooldown_until, longest)

    await writer.updateKey(keyId, { cooldown_until: null })
    assert.equal((await reader.getRaw(rec.id)).api_key_entries[0].cooldown_until, null)
  } finally {
    await other.close()
  }
})
