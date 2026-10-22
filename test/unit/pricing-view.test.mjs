import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPricing } from '../../src/lib/admin/pricing-view.mjs'
import { setPriceCatalogTestHooks } from '../../src/lib/admin/price-catalog.mjs'

test('GPT image models are in policy and carry their image band', () => {
  const store = {}
  setPriceCatalogTestHooks({
    settings: { get: (k, d = null) => (k in store ? store[k] : d), set: (k, v) => (store[k] = v) },
    backgroundRefresh: false,
  })
  try {
    const view = buildPricing()
    for (const id of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
      assert.deepEqual(view.policy[id].effective.image, { input: 8, output: 30, cache_read: 2 })
      assert.equal(view.models.find((m) => m.id === id).in_policy, true)
    }
  } finally {
    setPriceCatalogTestHooks(null)
  }
})
