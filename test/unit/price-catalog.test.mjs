import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getModelsDevStatus,
  invalidatePriceCatalog,
  listPriceCatalog,
  resolvePrice,
  setPriceCatalogTestHooks,
  setPriceOverride,
  syncModelsDev,
  validatePrice,
} from '../../src/lib/admin/price-catalog.mjs'

function memorySettings(seed = {}) {
  const store = { ...seed }
  return {
    get(key, fallback = null) {
      return Object.hasOwn(store, key) ? store[key] : fallback
    },
    set(key, value) {
      store[key] = value
      return value
    },
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const FULL = { input: 9, output: 11, cache_read: 0.9, cache_5m: 11.25, cache_1h: 18 }

const HAIKU_55_FIXTURE = {
  anthropic: {
    id: 'anthropic',
    models: {
      'claude-haiku-5-5': {
        id: 'claude-haiku-5-5',
        name: 'Haiku 5.5',
        limit: { context: 200000 },
        cost: {
          input: 0.1,
          output: 0.5,
          cache_read: 0.01,
          cache_write: 0.125,
          context_over_200k: { input: 1, output: 5 },
          tiers: [
            {
              input: 0.5,
              output: 2.5,
              cache_read: 0.05,
              cache_write: 0.625,
              tier: { type: 'context', size: 100000 },
            },
          ],
        },
      },
    },
  },
  openai: { id: 'openai', models: {} },
}

test.beforeEach(() => {
  setPriceCatalogTestHooks({
    settings: memorySettings(),
    backgroundRefresh: false,
  })
})

test.afterEach(() => {
  setPriceCatalogTestHooks(null)
})

test('Antigravity never inherits direct vendor API prices or wildcard overrides', () => {
  assert.ok(resolvePrice('claude-sonnet-5-5'))
  assert.equal(resolvePrice('antigravity/claude-sonnet-5-5'), null)
  assert.equal(setPriceOverride('*/claude-sonnet-5-5', FULL).ok, true)
  assert.equal(resolvePrice('antigravity/claude-sonnet-5-5'), null)
})

test('layer precedence: override provider/model > provider/* > */model > models.dev > builtin', async () => {
  const id = 'claude-sonnet-5-5'
  const builtin = resolvePrice(id)
  assert.equal(builtin.source, 'builtin')
  assert.equal(builtin.price.cache_read, 0.1)

  await syncModelsDev({
    fetchImpl: async () =>
      jsonResponse({
        anthropic: {
          models: {
            [id]: { name: 'Sonnet 5.5', limit: { context: 200000 }, cost: { input: 2, output: 10, cache_read: 9 } },
          },
        },
      }),
  })
  const fromDev = resolvePrice(id)
  assert.equal(fromDev.source, 'models.dev')
  assert.equal(fromDev.price.cache_read, 9)

  assert.equal(setPriceOverride(`*/${id}`, { ...FULL, cache_read: 3 }).ok, true)
  assert.equal(resolvePrice(id).source, 'override')
  assert.equal(resolvePrice(id).price.cache_read, 3)

  assert.equal(setPriceOverride('anthropic/*', { ...FULL, cache_read: 2 }).ok, true)
  assert.equal(resolvePrice(id).price.cache_read, 2)

  assert.equal(setPriceOverride(`anthropic/${id}`, { ...FULL, cache_read: 1 }).ok, true)
  assert.equal(resolvePrice(id).price.cache_read, 1)
  assert.equal(resolvePrice(id).source, 'override')
})

test('a provider/* override on a dated id keeps the canonical model builtin fast mode', () => {
  assert.equal(setPriceOverride('anthropic/*', FULL).ok, true)
  const hit = resolvePrice('claude-opus-5-5-20261001')
  assert.equal(hit.id, 'claude-opus-5-5')
  assert.equal(hit.source, 'override')
  assert.equal(hit.price.input, FULL.input)
  assert.equal(hit.mode_sources.fast, 'builtin')
  assert.equal(hit.price.modes.fast.input, 8)
})

test('an override on the canonical id also prices its dated snapshot', async () => {
  const dated = 'claude-haiku-4-5-20251001'
  await syncModelsDev({
    fetchImpl: async () =>
      jsonResponse({ anthropic: { models: { [dated]: { cost: { input: 1, output: 5, cache_read: 0.1 } } } } }),
  })
  assert.equal(resolvePrice(dated).source, 'models.dev')
  assert.equal(setPriceOverride('anthropic/claude-haiku-4-5', FULL).ok, true)
  const hit = resolvePrice(dated)
  assert.equal(hit.source, 'override')
  assert.equal(hit.price.input, FULL.input)
})

test('partial override is rejected', () => {
  const missingRead = setPriceOverride('anthropic/claude-sonnet-5-5', { input: 1, output: 2 })
  assert.equal(missingRead.ok, false)
  assert.match(missingRead.error, /cache_read/)
  assert.equal(resolvePrice('claude-sonnet-5-5').source, 'builtin')

  const missingInput = setPriceOverride('openai/gpt-5.5', { output: 1, cache_read: 0 })
  assert.equal(missingInput.ok, false)
  assert.match(missingInput.error, /input/)
})

test('models.dev without fast fills fast from builtin', async () => {
  await syncModelsDev({
    fetchImpl: async () =>
      jsonResponse({
        anthropic: {
          models: {
            'claude-opus-5-5': {
              name: 'Opus 5.5',
              limit: { context: 200000 },
              cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
            },
          },
        },
      }),
  })
  const r = resolvePrice('claude-opus-5-5')
  assert.equal(r.source, 'models.dev')
  assert.equal(r.mode_sources.fast, 'builtin')
  assert.equal(r.price.modes.fast.input, 8)
  assert.equal(r.price.modes.fast.output, 40)
})

test('Claude missing 1h cache write fills 2× input', async () => {
  await syncModelsDev({
    fetchImpl: async () =>
      jsonResponse({
        anthropic: {
          models: {
            'claude-sonnet-5': {
              name: 'Sonnet 5',
              cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
            },
          },
        },
      }),
  })
  const r = resolvePrice('claude-sonnet-5')
  assert.equal(r.source, 'models.dev')
  assert.equal(r.price.cache_5m, 2.5)
  assert.equal(r.price.cache_1h, 4)
})

test('claude-fable-5.1 resolves to claude-fable-5-1 with $0.25 read', () => {
  const r = resolvePrice('claude-fable-5.1')
  assert.equal(r.id, 'claude-fable-5-1')
  assert.equal(r.price.cache_read, 0.25)
  assert.equal(resolvePrice('anthropic/claude-fable-5.1[1m]').id, 'claude-fable-5-1')
})

test('claude-sonnet-5-5 does not fall through to claude-sonnet-5', () => {
  const r = resolvePrice('claude-sonnet-5-5')
  assert.equal(r.id, 'claude-sonnet-5-5')
  assert.equal(r.price.cache_read, 0.1)
  assert.equal(resolvePrice('claude-sonnet-5').price.cache_read, 0.2)
})

test('models.dev fetch failure keeps builtin and status error', async () => {
  const status = await syncModelsDev({
    fetchImpl: async () => {
      throw new Error('network down')
    },
  })
  assert.equal(status.status, 'error')
  assert.match(status.error, /network down/)
  const r = resolvePrice('claude-sonnet-5-5')
  assert.equal(r.source, 'builtin')
  assert.equal(r.price.cache_read, 0.1)
  assert.equal(getModelsDevStatus().status, 'error')
})

test('gpt-5.6 builtin vs models.dev conflict sets diff', async () => {
  await syncModelsDev({
    fetchImpl: async () =>
      jsonResponse({
        openai: {
          models: {
            'gpt-5.6': {
              name: 'GPT-5.6',
              limit: { context: 400000 },
              cost: { input: 4, output: 20, cache_read: 0.4, cache_write: 5 },
            },
          },
        },
      }),
  })
  const row = listPriceCatalog().find((e) => e.platform === 'openai' && e.id === 'gpt-5.6')
  assert.ok(row)
  assert.equal(row.diff, true)
  assert.equal(row.builtin.input, 5)
  assert.equal(row.models_dev.input, 4)
  assert.equal(row.source, 'models.dev')
})

test('parses models.dev haiku-5-5 context tier', async () => {
  await syncModelsDev({ fetchImpl: async () => jsonResponse(HAIKU_55_FIXTURE) })
  const r = resolvePrice('claude-haiku-5-5')
  assert.equal(r.source, 'models.dev')
  assert.equal(r.price.cache_5m, 0.125)
  assert.equal(r.price.cache_1h, 0.2)
  assert.equal(r.price.tiers.length, 1)
  assert.equal(r.price.tiers[0].above, 100000)
  assert.equal(r.price.tiers[0].input, 0.5)
  assert.equal(r.price.tiers[0].output, 2.5)
  assert.equal(r.price.tiers[0].cache_read, 0.05)
  assert.equal(r.price.tiers[0].cache_5m, 0.625)
  assert.equal(r.price.tiers[0].cache_1h, 1)
})

test('validatePrice fills optional cache writes', () => {
  const v = validatePrice({ input: 2, output: 10, cache_read: 0.1 }, { platform: 'anthropic' })
  assert.equal(v.ok, true)
  assert.equal(v.price.cache_5m, 2.5)
  assert.equal(v.price.cache_1h, 4)
  const o = validatePrice({ input: 5, output: 30, cache_read: 0.5 }, { platform: 'openai' })
  assert.equal(o.ok, true)
  assert.equal(o.price.cache_5m, 0)
  assert.equal(o.price.cache_1h, 0)
})

test('saving an override invalidates the memoized catalog', () => {
  const before = listPriceCatalog().find((e) => e.id === 'claude-sonnet-5-5')
  assert.equal(before.override, null)
  assert.equal(setPriceOverride('anthropic/claude-sonnet-5-5', FULL).ok, true)
  const after = listPriceCatalog().find((e) => e.id === 'claude-sonnet-5-5')
  assert.equal(after.source, 'override')
  assert.equal(after.override.input, 9)
  invalidatePriceCatalog()
})

test('validatePrice accepts an optional image band and rejects a partial one', () => {
  const ok = validatePrice(
    { input: 5, output: 0, cache_read: 1.25, image: { input: 8, output: 30, cache_read: 2 } },
    { platform: 'openai' },
  )
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.price.image, { input: 8, output: 30, cache_read: 2 })
  for (const image of [{ input: 8, output: 30 }, { input: -1, output: 30, cache_read: 2 }, 'x', []]) {
    assert.equal(validatePrice({ input: 5, output: 0, cache_read: 1.25, image }, { platform: 'openai' }).ok, false)
  }
})

test('image band override wins; a text-only override keeps the builtin image band', () => {
  assert.equal(
    setPriceOverride('openai/gpt-image-2.5-flare', {
      input: 5,
      output: 0,
      cache_read: 1.25,
      image: { input: 16, output: 60, cache_read: 4 },
    }).ok,
    true,
  )
  assert.deepEqual(resolvePrice('gpt-image-2.5-flare').price.image, { input: 16, output: 60, cache_read: 4 })
  assert.equal(setPriceOverride('openai/gpt-image-2.5-sunburst', { input: 6, output: 0, cache_read: 1.5 }).ok, true)
  const sun = resolvePrice('gpt-image-2.5-sunburst').price
  assert.equal(sun.input, 6)
  assert.deepEqual(sun.image, { input: 8, output: 30, cache_read: 2 })
})
