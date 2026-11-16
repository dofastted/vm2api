import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { copyDefaults, copyLabels } from './crag-catalog'
import { PreviewCanvas } from './crag-preview'
import {
  ancestorOrigin,
  parseDraftMessage,
  validOrigin,
} from './crag-preview-protocol'

const plan = {
  sku: 'draft-1',
  term: '1m',
  amount_minor: 100,
  slot_limit: 1,
}
const message = {
  type: 'crag-preview:draft',
  draft: { plans: [plan] },
  theme: 'light',
  edit: true,
  seq: 1,
  selected: 'draft-1',
}

describe('CRAG draft boundary', () => {
  it('accepts unfinished prices and slots without presenting a free plan', () => {
    expect(
      parseDraftMessage({
        ...message,
        draft: { plans: [{ ...plan, amount_minor: null, slot_limit: null }] },
      })
    ).not.toBeNull()
    const html = renderToStaticMarkup(
      <PreviewCanvas
        draft={{ plans: [{ ...plan, amount_minor: 0, slot_limit: 0 }] }}
        selected={null}
        onPick={vi.fn()}
      />
    )
    expect(html).toContain('未定价')
    expect(html).toContain('槽位待填写')
    expect(html).not.toContain('¥0')
  })

  it('rejects invalid theme, edit and duplicate draft ids', () => {
    expect(parseDraftMessage({ ...message, theme: 'system' })).toBeNull()
    expect(parseDraftMessage({ ...message, edit: 'true' })).toBeNull()
    expect(
      parseDraftMessage({ ...message, draft: { plans: [plan, plan] } })
    ).toBeNull()
  })

  it.each([
    null,
    [],
    'draft',
    {},
    { ...message, draft: null },
    { ...message, draft: { plans: {} } },
    { ...message, seq: -1 },
    { ...message, seq: 0.5 },
    { ...message, selected: {} },
    { ...message, theme: undefined },
    { ...message, edit: undefined },
  ])('rejects malformed envelopes: %j', (invalid) => {
    expect(parseDraftMessage(invalid)).toBeNull()
  })

  it.each([
    { sku: '' },
    { sku: 'custom' },
    { term: 'forever' },
    { name: 'a'.repeat(121) },
    { description: 'a'.repeat(501) },
    { amount_minor: -1 },
    { amount_minor: Number.MAX_SAFE_INTEGER + 1 },
    { amount_minor: '100' },
    { slot_limit: -1 },
    { slot_limit: {} },
    { remaining: -1 },
    { stock: 0.5 },
    { renewable: 'false' },
    { enabled: 0 },
    { months: 0 },
  ])('rejects invalid plan values: %j', (invalid) => {
    expect(
      parseDraftMessage({
        ...message,
        draft: { plans: [{ ...plan, ...invalid }] },
      })
    ).toBeNull()
  })

  it('bounds the catalogue and validates copy without permitting unknown keys', () => {
    const plans = Array.from({ length: 128 }, (_, index) => ({
      ...plan,
      sku: `draft-${index}`,
    }))
    expect(parseDraftMessage({ ...message, draft: { plans } })).not.toBeNull()
    expect(
      parseDraftMessage({
        ...message,
        draft: { plans: [...plans, { ...plan, sku: 'overflow' }] },
      })
    ).toBeNull()
    for (const presentation of [
      { title: {} },
      { title: 'a'.repeat(121) },
      { description: 'a'.repeat(501) },
      { unknown: 'copy' },
    ]) {
      expect(
        parseDraftMessage({ ...message, draft: { plans: [], presentation } })
      ).toBeNull()
    }
    expect(
      parseDraftMessage({
        ...message,
        seq: undefined,
        draft: { plans: [], presentation: copyDefaults, commerce: null },
      })
    ).not.toBeNull()
  })

  it('validates commerce without fabricating limits', () => {
    const commerce = {
      unit_amount_minor: 125,
      max_amount_minor: 999900,
      min_slots: 7,
      max_slots: 250,
      min_months: 3,
      max_months: 60,
    }
    expect(
      parseDraftMessage({ ...message, draft: { plans: [], commerce } })?.draft
        .commerce
    ).toEqual(commerce)
    for (const invalid of [
      {},
      { ...commerce, min_slots: 251 },
      { ...commerce, min_months: 61 },
      { ...commerce, unit_amount_minor: 0 },
      { ...commerce, custom_enabled: 'true' },
    ]) {
      expect(
        parseDraftMessage({
          ...message,
          draft: { plans: [], commerce: invalid },
        })
      ).toBeNull()
    }
    const html = renderToStaticMarkup(
      <PreviewCanvas
        draft={{ plans: [], commerce }}
        selected='custom'
        onPick={vi.fn()}
      />
    )
    expect(html).toContain('7–250 槽位')
    expect(html).toContain('3–60 个月')
  })

  it('uses the first legal ancestor, with referrer fallback only when needed', () => {
    const location = {
      ancestorOrigins: [
        'null',
        'https://admin.example',
        'https://outer.example',
      ],
    } as unknown as Location
    expect(ancestorOrigin(location, 'https://other.example/page')).toBe(
      'https://admin.example'
    )
    expect(
      ancestorOrigin({} as Location, 'https://fallback.example/page')
    ).toBe('https://fallback.example')
    expect(ancestorOrigin({} as Location, '')).toBeUndefined()
    for (const origin of ['null', '*', 'file://', 'https://admin.example/path'])
      expect(validOrigin(origin)).toBe(false)
    expect(validOrigin('http://localhost:8080')).toBe(true)
  })
})

describe('draft canvas shared presentation', () => {
  it('keeps unfinished commerce cards distinct from zero-priced published plans', () => {
    const html = renderToStaticMarkup(
      <PreviewCanvas
        draft={{
          plans: [{ ...plan, amount_minor: 0, slot_limit: 0 }],
          commerce: {
            unit_amount_minor: 100,
            max_amount_minor: 10000,
            max_slots: 10,
            max_months: 12,
            custom_enabled: false,
          },
        }}
        selected={plan.sku}
        onPick={vi.fn()}
      />
    )
    expect(html).toContain('未定价')
    expect(html).toContain('槽位待填写')
    expect(html).not.toContain('¥0')
    expect(html).toContain('rounded-xl')
    expect(html).toContain('bg-primary/5')
  })

  it('keeps sold-out plans editable and isolates the selected delisted plan', () => {
    const draft = {
      plans: [
        { ...plan, remaining: 0 },
        { ...plan, sku: 'hidden', enabled: false, name: '下架套餐' },
      ],
    }
    const buyer = renderToStaticMarkup(
      <PreviewCanvas draft={draft} selected='hidden' onPick={vi.fn()} />
    )
    expect(buyer).not.toContain('下架套餐')
    expect(buyer).toContain('disabled=""')
    const editor = renderToStaticMarkup(
      <PreviewCanvas draft={draft} selected='hidden' edit onPick={vi.fn()} />
    )
    expect(editor).toContain('已售罄')
    expect(editor).toContain('下架套餐编辑区')
    expect(editor).not.toContain('disabled=""')
    expect(editor).toContain('仅预览，不可购买')
  })

  it('renders all eight copy fields and escapes draft text', () => {
    const draft = {
      plans: [
        { ...plan, name: '<b>名称</b>', description: '<script>说明</script>' },
      ],
      presentation: { title: '<img src=x>' },
    }
    const html = renderToStaticMarkup(
      <PreviewCanvas draft={draft} selected={null} edit onPick={vi.fn()} />
    )
    for (const label of Object.values(copyLabels))
      expect(html).toContain(`编辑${label}`)
    expect(html).toContain('&lt;img src=x&gt;')
    expect(html).toContain('&lt;b&gt;名称&lt;/b&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('contenteditable')
    expect(html).not.toMatch(/<button[^>]*>创建订单<\/button>/)
  })
})
