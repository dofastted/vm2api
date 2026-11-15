import assert from 'node:assert/strict'
import test from 'node:test'
import { createShopSupplier } from '../../src/lib/admin/crag-shop-supplier.mjs'

const plan = { sku: 'quarter', term: '3m', amount_minor: 59900, slot_limit: 10 }
const invalidReply = { code: 'shop_invalid_reply' }

test('extended UTF-8 catalogs can exceed the quote response budget', async () => {
  const plans = Array.from({ length: 128 }, (_, index) => ({
    ...plan,
    sku: `quarter-${index}`,
    name: '订'.repeat(120),
    description: '阅'.repeat(500),
  }))
  const catalog = { plans, payment_methods: ['alipay'] }
  const supplier = createShopSupplier(async () => Response.json(catalog))
  assert.ok(Buffer.byteLength(JSON.stringify(catalog)) > 64 * 1024)
  assert.deepEqual((await supplier.plans()).plans, plans)

  const largeQuote = createShopSupplier(async () =>
    Response.json({
      ...plan,
      months: 3,
      subtotal_minor: plan.amount_minor,
      discount_minor: 0,
      ignored: ' '.repeat(64 * 1024),
    }),
  )
  await assert.rejects(largeQuote.quote({ sku: plan.sku }), invalidReply)
})

test('catalog parsing still rejects bodies beyond its streaming byte limit', async () => {
  const supplier = createShopSupplier(async () =>
    Response.json({
      plans: [plan],
      payment_methods: [],
      ignored: ' '.repeat(384 * 1024),
    }),
  )
  await assert.rejects(supplier.plans(), invalidReply)
})
