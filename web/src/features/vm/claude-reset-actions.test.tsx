import type { ReactNode } from 'react'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { ClaudeResetActions } from './claude-reset-actions'

const mocks = vi.hoisted(() => ({
  mutations: [] as Array<{ mutationFn: (arg?: unknown) => Promise<unknown> }>,
}))

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: (options: {
    mutationFn: (arg?: unknown) => Promise<unknown>
  }) => {
    mocks.mutations.push(options)
    return { isPending: false, mutate: vi.fn(), variables: undefined }
  },
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
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

const snapshot = {
  eligible: true,
  available_count: 2,
  held_count: 2,
  fetched_at: '2026-11-13T07:00:00Z',
  credits: [
    {
      ref: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      kind: 'fable' as const,
      state: 'ready' as const,
      gives_back_weekly: true,
      resets_left: 1,
      expires_at: '2026-11-17T07:59:00Z',
      clears: ['five_hour', 'seven_day_overage_included'],
    },
    {
      ref: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      kind: 'full' as const,
      state: 'ready' as const,
      resets_left: 1,
      expires_at: '2026-12-10T22:00:00Z',
      clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
    },
    {
      ref: 'cccccccccccccccccccccccc',
      kind: 'weekly' as const,
      state: 'unavailable' as const,
      resets_left: 1,
      clears: ['seven_day'],
    },
  ],
}

const vm = (over: Partial<Vm> = {}) =>
  ({ id: 'Niutopia262', claude_reset_credits: snapshot, ...over }) as Vm

beforeEach(() => {
  mocks.mutations = []
})

describe('ClaudeResetActions', () => {
  it('keeps the compact buttons and shows only the total', () => {
    const html = renderToStaticMarkup(<ClaudeResetActions vm={vm()} compact />)
    expect(html).toContain('限额查询 2')
    expect(html).toContain('限额重置')
    expect(html).not.toContain('Fable 卡')
    expect(
      renderToStaticMarkup(
        <ClaudeResetActions vm={vm({ claude_reset_credits: null })} compact />
      )
    ).not.toContain('限额查询 0')
  })

  it('lists each held card with its own use button on the detail page', () => {
    const html = renderToStaticMarkup(
      <ClaudeResetActions vm={vm()} now={Date.parse('2026-11-13T07:26:00Z')} />
    )
    expect(html).toContain('Fable 卡')
    expect(html).toContain('全量卡')
    expect(html).not.toContain('每周卡')
    expect(html).toContain('清 5 小时、Fable 周额度（7 天不清）')
    expect(html).toContain('清 5 小时、7 天、Fable 周额度')
    expect(html.match(/title="使用/g)?.length).toBe(2)
    expect(html).toMatch(/重置卡 <b[^>]*>2<\/b> 张/)
  })

  it('asks for a refresh when the snapshot predates card refs', () => {
    const legacy = {
      available_count: 1,
      credits: [{ resets_left: 1, redeemable: true }],
    }
    const html = renderToStaticMarkup(
      <ClaudeResetActions vm={vm({ claude_reset_credits: legacy })} />
    )
    expect(html).toContain('点「限额查询」刷新后才能选卡')
    expect(html).not.toMatch(/title="使用/)
  })

  it('sends the chosen card when spending a reset', async () => {
    renderToStaticMarkup(<ClaudeResetActions vm={vm()} />)
    const redeem = mocks.mutations[1]
    await redeem.mutationFn(snapshot.credits[1])
    const [path, init] = vi.mocked(api).mock.calls[
      vi.mocked(api).mock.calls.length - 1
    ] as [string, RequestInit]
    expect(path).toBe('/api/panel/vms/Niutopia262/claude-reset/redeem')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      card: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    })
  })
})
