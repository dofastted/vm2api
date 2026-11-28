import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CragCloudOrdersResponse } from '@/features/vm/queries'
import { CragCloudOrdersPanel } from './crag-cloud-orders'

const HOST_ID = 'a1'.repeat(32)

const mockResponse = vi.hoisted(() => ({
  data: undefined as CragCloudOrdersResponse | undefined,
  isError: false,
}))

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  }),
  useQuery: () => ({
    data: mockResponse.data,
    isError: mockResponse.isError,
    isFetching: false,
    refetch: vi.fn(),
  }),
}))

describe('CragCloudOrdersPanel', () => {
  it('displays full copyable host_id, bound voucher count, cloud orders and one-click locked renewal', () => {
    mockResponse.isError = false
    mockResponse.data = {
      host_id: HOST_ID,
      product: 'crag-v2',
      total: 2,
      limit: 50,
      offset: 0,
      vouchers: [
        {
          code_id: 'v-1',
          sku: 'starter-1m',
          slot_limit: 2,
          months: 1,
          active: true,
        },
        {
          code_id: 'v-2',
          sku: 'starter-1m',
          slot_limit: 2,
          months: 1,
          active: false,
        },
      ],
      orders: [
        {
          order_id: 'ord-buy-001',
          product: 'crag-v2',
          sku: 'starter-1m',
          order_kind: 'purchase',
          slot_limit: 2,
          months: 1,
          amount_minor: 2900,
          subtotal_minor: 2900,
          discount_minor: 0,
          payment_method: 'alipay',
          original_host_id: HOST_ID,
          current_host_id: HOST_ID,
          status: 'active',
          paid_at: 1700000000,
          granted_at: 1700000000,
          expires_at: 1999999999,
          created_at: 1700000000,
        },
        {
          order_id: 'ord-ren-002',
          product: 'crag-v2',
          sku: 'starter-1m',
          order_kind: 'renewal',
          slot_limit: 2,
          months: 1,
          amount_minor: 2900,
          subtotal_minor: 2900,
          discount_minor: 0,
          payment_method: 'wxpay',
          renewed_from_order_id: 'ord-buy-001',
          original_host_id: HOST_ID,
          current_host_id: HOST_ID,
          status: 'active',
          paid_at: 1700100000,
          granted_at: 1700100000,
          expires_at: 2002591999,
          created_at: 1700100000,
        },
      ],
    }

    const html = renderToStaticMarkup(
      <CragCloudOrdersPanel
        host={{ ready: true, state: 'active', host_id: HOST_ID }}
        channels={['alipay', 'wxpay']}
        busy={false}
        onRenewOrder={() => {}}
        onHostChanged={() => {}}
      />
    )

    expect(html).toContain(HOST_ID)
    expect(html).toContain('迁移宿主机 ID')
    expect(html).toContain('已绑定兑换券 1 张有效 / 共 2 张')
    expect(html).toContain('ord-buy-001')
    expect(html).toContain('新购')
    expect(html).toContain('原价续费')
    expect(html).toContain('一键原价续费 (¥29)')
    expect(html).toContain('支付宝')
    expect(html).toContain('微信支付')
  })

  it('renders CRAGGemini ledger heading and seat unit when product=craggemini', () => {
    mockResponse.isError = false
    mockResponse.data = {
      host_id: HOST_ID,
      product: 'craggemini',
      total: 1,
      limit: 50,
      offset: 0,
      vouchers: [],
      orders: [
        {
          order_id: 'ord-gem-001',
          product: 'craggemini',
          sku: 'gemini-monthly',
          order_kind: 'purchase',
          slot_limit: 10,
          months: 1,
          amount_minor: 9900,
          subtotal_minor: 9900,
          discount_minor: 0,
          payment_method: 'alipay',
          original_host_id: HOST_ID,
          current_host_id: HOST_ID,
          status: 'active',
          paid_at: 1700000000,
          granted_at: 1700000000,
          expires_at: 1999999999,
          created_at: 1700000000,
        },
      ],
    }

    const html = renderToStaticMarkup(
      <CragCloudOrdersPanel
        product='craggemini'
        hostIdOverride={HOST_ID}
        channels={['alipay']}
        busy={false}
        onRenewOrder={() => {}}
        onHostChanged={() => {}}
      />
    )

    expect(html).toContain('CRAGGemini 宿主机身份与云端历史订单')
    expect(html).toContain('10 席位')
    expect(html).toContain('ord-gem-001')
    expect(html).toContain('一键原价续费 (¥99)')
  })
})
