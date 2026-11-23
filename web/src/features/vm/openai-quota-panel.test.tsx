import type { ReactNode } from 'react'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import {
  CODEX_CREDITS_TTL_MS,
  describeCodexCredits,
  formatCodexCreditBalance,
  formatOpenaiQuotaRefreshToast,
  type OpenaiQuotaPayload,
} from './openai-credits'
import { OpenaiQuotaActions } from './openai-quota-actions'
import { OpenaiQuotaPanel } from './openai-quota-panel'

const mocks = vi.hoisted(() => ({
  mutations: [] as Array<{
    mutationFn: (arg?: unknown) => Promise<unknown>
    onSuccess?: (data: OpenaiQuotaPayload) => Promise<void> | void
  }>,
}))

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: (options: {
    mutationFn: (arg?: unknown) => Promise<unknown>
    onSuccess?: (data: OpenaiQuotaPayload) => Promise<void> | void
  }) => {
    mocks.mutations.push(options)
    return { isPending: false, mutate: vi.fn(), variables: undefined }
  },
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/features/vm/vm-perms', () => ({
  useVmPerms: () => ({ credential: true }),
}))
vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: (props: { open: boolean; title: ReactNode }) =>
    props.open ? <div role='alertdialog'>{props.title}</div> : null,
}))

const NOW = Date.parse('2026-11-22T02:15:00Z')

function makeVm(over: Partial<Vm> = {}): Vm {
  return {
    id: 'codex-slot-01',
    platform: 'openai',
    family: 'codex',
    has_token: true,
    reset_credits: {
      available_count: 0,
      credits: [],
      fetched_at: new Date(NOW - 2 * 60_000).toISOString(),
    },
    codex_credits: {
      has_credits: true,
      unlimited: false,
      balance: '62408.90',
      fetched_at: new Date(NOW - 2 * 60_000).toISOString(),
    },
    ...over,
  }
}

beforeEach(() => {
  mocks.mutations = []
  vi.clearAllMocks()
})

describe('openai-credits formatting and state', () => {
  it('formats decimal balances with thousands separators without losing arbitrary precision', () => {
    expect(formatCodexCreditBalance('62408.90')).toBe('62,408.90')
    expect(
      formatCodexCreditBalance('987654321987654321.123456789123456789')
    ).toBe('987,654,321,987,654,321.123456789123456789')
    expect(formatCodexCreditBalance('0')).toBe('0')
    expect(formatCodexCreditBalance(null)).toBeNull()
  })

  it('distinguishes fresh spendable, stale >10m, unlimited, empty, and upstream rate-limited states', () => {
    const fresh = describeCodexCredits(makeVm(), NOW)
    expect(fresh.balanceText).toBe('62,408.90 积分')
    expect(fresh.statusKey).toBe('spendable')
    expect(fresh.statusText).toBe('可用于续跑')

    const stale = describeCodexCredits(
      makeVm({
        codex_credits: {
          has_credits: true,
          unlimited: false,
          balance: '62408.90',
          fetched_at: new Date(
            NOW - CODEX_CREDITS_TTL_MS - 60_000
          ).toISOString(),
        },
      }),
      NOW
    )
    expect(stale.balanceText).toBe('62,408.90 积分')
    expect(stale.statusKey).toBe('stale')
    expect(stale.statusText).toBe('余额待刷新')

    const unlimited = describeCodexCredits(
      makeVm({
        codex_credits: {
          has_credits: false,
          unlimited: true,
          balance: null,
          fetched_at: new Date(NOW - 30_000).toISOString(),
        },
      }),
      NOW
    )
    expect(unlimited.balanceText).toBe('无限')
    expect(unlimited.statusKey).toBe('spendable')

    const empty = describeCodexCredits(
      makeVm({
        codex_credits: {
          has_credits: false,
          unlimited: false,
          balance: '0',
          fetched_at: new Date(NOW - 30_000).toISOString(),
        },
      }),
      NOW
    )
    expect(empty.balanceText).toBe('0 积分')
    expect(empty.statusKey).toBe('empty')
    expect(empty.statusText).toBe('无可用积分')

    const rateLimited = describeCodexCredits(
      makeVm({
        restriction_reason: 'rate_limited',
        restriction_until: NOW + 60_000,
      }),
      NOW
    )
    expect(rateLimited.statusKey).toBe('rate_limited')
    expect(rateLimited.statusText).toBe('上游限流')
  })
})

describe('OpenaiQuotaPanel and OpenaiQuotaActions', () => {
  it('renders fresh positive credits separately from 0 reset vouchers with clarified button labels', () => {
    const panelHtml = renderToStaticMarkup(
      <OpenaiQuotaPanel vm={makeVm()} u5={100} u7={16} now={NOW} />
    )
    expect(panelHtml).toContain('Codex 积分余额')
    expect(panelHtml).toContain('62,408.90 积分')
    expect(panelHtml).toContain('可用于续跑')
    expect(panelHtml).toContain('2 分钟前')
    expect(panelHtml).toContain('重置券')
    expect(panelHtml).toContain('0 张')
    expect(panelHtml).toContain('刷新额度和积分')
    expect(panelHtml).toContain('使用重置券')
    expect(panelHtml).not.toContain('查询重置券')

    const actionsHtml = renderToStaticMarkup(
      <OpenaiQuotaActions vm={makeVm()} compact now={NOW} />
    )
    expect(actionsHtml).toContain('62,408.90 积分')
    expect(actionsHtml).toContain('可用于续跑（2 分钟前）')
    expect(actionsHtml).toContain('重置券 0 张')
    expect(actionsHtml).toContain('刷新额度和积分')
    expect(actionsHtml).toContain('使用重置券')
    expect(actionsHtml).not.toContain('券查询')
  })

  it('preserves last known positive balance (never 0) and marks 余额待刷新 when >10m stale', () => {
    const staleVm = makeVm({
      codex_credits: {
        has_credits: true,
        unlimited: false,
        balance: '62408.90',
        fetched_at: new Date(NOW - 25 * 60_000).toISOString(),
      },
    })
    const panelHtml = renderToStaticMarkup(
      <OpenaiQuotaPanel vm={staleVm} u5={100} u7={16} now={NOW} />
    )
    expect(panelHtml).toContain('62,408.90 积分')
    expect(panelHtml).toContain('余额待刷新（上次查询余额，待刷新）')
    expect(panelHtml).toContain('25 分钟前')
    expect(panelHtml).not.toContain('>0 积分<')

    const actionsHtml = renderToStaticMarkup(
      <OpenaiQuotaActions vm={staleVm} compact now={NOW} />
    )
    expect(actionsHtml).toContain('62,408.90 积分')
    expect(actionsHtml).toContain('余额待刷新（25 分钟前）')
  })

  it('renders unlimited credits and toasts refreshed quota, credits, and reset vouchers together', async () => {
    const unlimitedVm = makeVm({
      codex_credits: {
        has_credits: false,
        unlimited: true,
        balance: null,
        fetched_at: new Date(NOW - 10_000).toISOString(),
      },
    })
    const panelHtml = renderToStaticMarkup(
      <OpenaiQuotaPanel vm={unlimitedVm} u5={100} u7={16} now={NOW} />
    )
    expect(panelHtml).toContain('无限')
    expect(panelHtml).toContain('可用于续跑')

    const refreshMutation = mocks.mutations[0]
    await refreshMutation.mutationFn()
    expect(api).toHaveBeenCalledWith(
      '/api/panel/vms/codex-slot-01/openai-quota/refresh',
      { method: 'POST' }
    )

    await refreshMutation.onSuccess?.({
      quota: { utilization_5h: 1, utilization_7d: 0.16 },
      credits: {
        has_credits: true,
        unlimited: false,
        balance: '62408.90',
        fetched_at: new Date(NOW).toISOString(),
      },
      reset_credits: { available_count: 0, credits: [] },
    })
    expect(toast.success).toHaveBeenCalledWith(
      '已刷新额度（5h 100% / 7d 16%） · Codex 积分 62,408.90 积分 · 重置券 0 张'
    )

    expect(
      formatOpenaiQuotaRefreshToast({
        credits: { has_credits: false, unlimited: true, balance: null },
        reset_credits: { available_count: 2 },
      })
    ).toBe('已刷新额度和积分 · Codex 积分 无限 · 重置券 2 张')

    mocks.mutations = []
    vi.mocked(toast.success).mockClear()
    renderToStaticMarkup(<OpenaiQuotaActions vm={makeVm()} now={NOW} />)
    await mocks.mutations[0].onSuccess?.({
      quota: { utilization_5h: 1, utilization_7d: 0.16 },
      credits: {
        has_credits: true,
        unlimited: false,
        balance: '62408.90',
        fetched_at: new Date(NOW).toISOString(),
      },
      reset_credits: { available_count: 0, credits: [] },
    })
    expect(toast.success).toHaveBeenCalledWith(
      '已刷新额度（5h 100% / 7d 16%） · Codex 积分 62,408.90 积分 · 重置券 0 张'
    )
  })
})
