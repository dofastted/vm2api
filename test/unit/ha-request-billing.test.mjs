import test from 'node:test'
import assert from 'node:assert/strict'
import {
  haBillingFixture,
  billingRequest,
  syntheticBillingSnapshot,
  syntheticUsageReceipt,
} from '../fixtures/ha-billing.mjs'
import { calculateCost } from '../../src/lib/admin/pricing.mjs'
import { setPriceCatalogTestHooks, invalidatePriceCatalog } from '../../src/lib/admin/price-catalog.mjs'

test('HA job binding persists price, group, cache TTL and speed before returning permission to dispatch', async (t) => {
  const f = await haBillingFixture(t)
  const snapshot = syntheticBillingSnapshot()
  await billingRequest(
    f,
    async (data) => {
      const row = (
        await f.peer.pool.query('SELECT billing_snapshot FROM execution_jobs WHERE request_id=$1', [data.commandIds[0]])
      ).rows[0]
      assert.deepEqual(row.billing_snapshot, snapshot)
      snapshot.rate_multiplier = 100
      assert.equal(
        (
          await f.peer.pool.query('SELECT billing_snapshot FROM execution_jobs WHERE request_id=$1', [
            data.commandIds[0],
          ])
        ).rows[0].billing_snapshot.rate_multiplier,
        2,
      )
    },
    { snapshot },
  )
})

test('frozen price snapshots keep original rates after another Pod changes overrides', async () => {
  const { captureHaBillingSnapshot, priceHaReceipt } = await import('../../src/lib/core/ha-request-billing.mjs')
  const values = {
    model_price_overrides: {
      'anthropic/claude-sonnet-4-5': {
        input: 3,
        output: 15,
        cache_read: 0.3,
        cache_5m: 3.75,
        cache_1h: 6,
        updated_at: 'before',
      },
    },
  }
  setPriceCatalogTestHooks({ settings: { get: (key, fallback) => values[key] ?? fallback }, backgroundRefresh: false })
  try {
    const snapshot = captureHaBillingSnapshot({
      model: 'claude-sonnet-4-5',
      rateMultiplier: 2,
      cacheTtl: '1h',
      requestedSpeed: null,
    })
    const receipt = syntheticUsageReceipt()
    const expected = calculateCost({ ...receipt.usage, cache_ttl: '1h' }, receipt.model)
    values.model_price_overrides['anthropic/claude-sonnet-4-5'].input = 900
    invalidatePriceCatalog()
    const actual = priceHaReceipt(receipt, snapshot)
    assert.equal(actual.known, true)
    assert.equal(actual.pricing.total_cost, expected.total_cost)
    assert.equal(actual.actualCost, expected.total_cost * 2)
  } finally {
    setPriceCatalogTestHooks(null)
  }
})

for (const absent of ['usage', 'price', 'different-model']) {
  test(`HA ${absent} stays unpriced without substituting zero or request model`, async () => {
    const { priceHaReceipt } = await import('../../src/lib/core/ha-request-billing.mjs')
    const snapshot = syntheticBillingSnapshot()
    const receipt = syntheticUsageReceipt()
    if (absent === 'usage') {
      receipt.usage_complete = false
      delete receipt.usage.output_tokens
    }
    if (absent === 'price') snapshot.resolved = null
    if (absent === 'different-model') receipt.model = 'claude-opus-4-6'
    assert.equal(priceHaReceipt(receipt, snapshot).known, false)
  })
}
