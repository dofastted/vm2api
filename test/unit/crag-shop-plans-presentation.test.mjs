import assert from 'node:assert/strict'
import test from 'node:test'
import { createShopSupplier, publicPlan } from '../../src/lib/admin/crag-shop-supplier.mjs'

const PLAN = { sku: 'quarter', term: '3m', amount_minor: 59900, slot_limit: 10 }
const COMMERCE = { unit_amount_minor: 100, max_amount_minor: 999900, max_months: 120, max_slots: 10000 }

function supplier(catalog) {
  return createShopSupplier(async (url, init) => {
    assert.equal(url, 'https://www.vm2api.org/shop/plans')
    assert.equal(init.method, 'GET')
    assert.equal(init.body, undefined)
    return Response.json(catalog)
  })
}

test('catalog projects only published metadata in supplier order, retaining disabled renewal metadata', async () => {
  const catalog = {
    revision: 12,
    plans: [
      {
        ...PLAN,
        name: '季度套餐',
        description: '第一行\n第二行',
        months: 3,
        enabled: false,
        renewable: true,
        stock: 20,
        remaining: 0,
      },
      { ...PLAN, sku: 'monthly', term: '1m', name: '<b>plain text</b>', remaining: null },
    ],
    payment_methods: ['alipay'],
    commerce: { ...COMMERCE, min_slots: 2, min_months: 3, custom_enabled: false, custom_renewable: true },
    presentation: {
      title: '订阅',
      description: '说明',
      plans_title: '套餐',
      orders_title: '历史',
      custom_title: '自选',
      unavailable_text: '停售',
      empty_plans_text: '暂无套餐',
      empty_orders_text: '暂无订单',
    },
  }
  const raw = structuredClone(catalog)
  raw.secret = 'not public'
  raw.plans[0].redemption_code = 'not public'
  raw.plans[0].activation_target = { vm_id: 'not public' }
  raw.commerce.discount = 80
  raw.presentation.html = '<script>not public</script>'
  assert.deepEqual(await supplier(raw).plans(), catalog)
})

test('legacy plans and commerce stay compatible with absent optional defaults', async () => {
  for (const catalog of [
    { plans: [PLAN], payment_methods: ['alipay'] },
    { plans: [PLAN], payment_methods: [], commerce: COMMERCE },
    { plans: [], payment_methods: ['alipay'], commerce: { ...COMMERCE, custom_enabled: false } },
  ]) {
    assert.deepEqual(await supplier(catalog).plans(), catalog)
  }
})

test('stock and revision accept zero and safe integer bounds; legacy remaining can be null', async () => {
  for (const stock of [undefined, 0, Number.MAX_SAFE_INTEGER]) {
    const catalog = { plans: [{ ...PLAN, stock, remaining: stock ?? null }], payment_methods: [], revision: 0 }
    const result = await supplier(catalog).plans()
    assert.equal(result.plans[0].stock, stock)
    assert.equal(result.plans[0].remaining, stock ?? null)
    assert.equal(result.revision, 0)
  }
})

test('catalog rejects malformed known metadata rather than reflecting arbitrary values', async () => {
  for (const fields of [
    { name: {} },
    { description: null },
    { enabled: 0 },
    { renewable: 'true' },
    { stock: null },
    { stock: -1 },
    { stock: 0.5 },
    { stock: Number.MAX_SAFE_INTEGER + 1 },
    { stock: '10' },
    { remaining: -1 },
    { remaining: '0' },
    { months: 0 },
    { months: 1.5 },
    { months: null },
  ]) {
    await assert.rejects(supplier({ plans: [{ ...PLAN, ...fields }], payment_methods: [] }).plans(), {
      code: 'shop_invalid_reply',
    })
  }
  for (const fields of [
    { revision: -1 },
    { revision: null },
    { revision: '1' },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { presentation: null },
    { presentation: [] },
    { presentation: { title: {} } },
  ]) {
    await assert.rejects(supplier({ plans: [PLAN], payment_methods: [], ...fields }).plans(), {
      code: 'shop_invalid_reply',
    })
  }
})

test('custom ranges are independently validated without imposing purchase or price policy', async () => {
  for (const fields of [
    { min_months: 0 },
    { min_slots: 0 },
    { min_months: null },
    { min_slots: null },
    { min_months: 121 },
    { min_slots: 10001 },
    { min_slots: 1.5 },
    { custom_enabled: null },
    { custom_enabled: 'false' },
    { custom_renewable: 1 },
  ]) {
    await assert.rejects(
      supplier({ plans: [PLAN], payment_methods: [], commerce: { ...COMMERCE, ...fields } }).plans(),
      {
        code: 'shop_invalid_reply',
      },
    )
  }
  const commerce = { ...COMMERCE, min_months: 120, min_slots: 10000, custom_enabled: false, custom_renewable: true }
  assert.deepEqual((await supplier({ plans: [PLAN], payment_methods: [], commerce }).plans()).commerce, commerce)
})

test('duplicate SKUs are rejected even when one plan is hidden', async () => {
  await assert.rejects(supplier({ plans: [PLAN, { ...PLAN, enabled: false }], payment_methods: [] }).plans(), {
    code: 'shop_invalid_reply',
  })
})

test('catalog-only metadata does not change the shared quote and order plan projection', () => {
  assert.deepEqual(publicPlan({ ...PLAN, name: {}, enabled: 'invalid', stock: -1, months: null }), PLAN)
})

const LAYOUT = {
  plan_columns: 3,
  card_density: 'compact',
  orders_position: 'side',
  show_monthly_price: false,
  featured_sku: 'quarter',
  featured_label: '最超值',
}

async function layoutOf(layout, rest = {}) {
  const catalog = { plans: [PLAN], payment_methods: ['alipay'], presentation: { title: '订阅', ...rest, layout } }
  const result = await supplier(catalog).plans()
  return result.presentation
}

test('published layout is forwarded instead of being stripped with the unknown keys', async () => {
  assert.deepEqual(await layoutOf(LAYOUT), { title: '订阅', layout: LAYOUT })
  for (const [key, value] of Object.entries(LAYOUT)) {
    assert.deepEqual((await layoutOf({ [key]: value })).layout, { [key]: value })
  }
  assert.deepEqual((await layoutOf({})).layout, {})
})

test('layout drops unknown keys the same way the copy whitelist does', async () => {
  const layout = await layoutOf({ plan_columns: 2, hero_video: 'https://not.public', nested: { a: 1 } })
  assert.deepEqual(layout.layout, { plan_columns: 2 })
})

test('a malformed layout field degrades to the page default without failing the catalog', async () => {
  for (const field of [
    { plan_columns: 0 },
    { plan_columns: 4 },
    { plan_columns: '2' },
    { plan_columns: 2.5 },
    { plan_columns: null },
    { card_density: 'cozy' },
    { card_density: 1 },
    { orders_position: 'above' },
    { orders_position: true },
    { show_monthly_price: 'true' },
    { show_monthly_price: 1 },
    { featured_sku: '' },
    { featured_sku: '-bad' },
    { featured_sku: 'has space' },
    { featured_sku: 42 },
    { featured_label: '' },
    { featured_label: '   ' },
    { featured_label: '推'.repeat(13) },
    { featured_label: 7 },
  ]) {
    const presentation = await layoutOf({ ...field })
    assert.deepEqual(presentation, { title: '订阅', layout: {} }, `expected ${JSON.stringify(field)} to degrade`)
  }
  // Valid siblings survive a single bad field; only that field is dropped.
  assert.deepEqual((await layoutOf({ plan_columns: 9, card_density: 'compact' })).layout, {
    card_density: 'compact',
  })
})

test('featured_label counts characters, so a 12-emoji badge is still published', async () => {
  const featured_label = '🎉'.repeat(12)
  assert.ok(featured_label.length > 12)
  assert.deepEqual((await layoutOf({ featured_label })).layout, { featured_label })
  assert.deepEqual((await layoutOf({ featured_label: '🎉'.repeat(13) })).layout, {})
})

test('a layout that is not an object is omitted rather than rejected', async () => {
  for (const layout of ['side', 3, true, null, []]) {
    assert.deepEqual(await layoutOf(layout), { title: '订阅' })
  }
})

test('catalogs without layout stay byte-identical, so legacy buyers see no change', async () => {
  const catalog = {
    plans: [PLAN],
    payment_methods: ['alipay'],
    presentation: { title: '订阅', plans_title: '套餐' },
  }
  const result = await supplier(catalog).plans()
  assert.deepEqual(result, catalog)
  assert.ok(!('layout' in result.presentation))
  assert.deepEqual(await supplier({ plans: [PLAN], payment_methods: [] }).plans(), {
    plans: [PLAN],
    payment_methods: [],
  })
})
