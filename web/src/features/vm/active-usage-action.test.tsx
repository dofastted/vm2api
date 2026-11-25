import type { ReactNode } from 'react'
import type { ActiveUsageQueryResult, Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { ActiveUsageAction } from './active-usage-action'
import { describeActiveUsageOutcome } from './active-usage-model'

const mocks = vi.hoisted(() => ({
  mutations: [] as Array<{
    mutationFn: (arg?: { forceReconcile?: boolean }) => Promise<unknown>
    onSuccess?: (
      data: ActiveUsageQueryResult,
      variables?: { forceReconcile?: boolean }
    ) => Promise<void>
  }>,
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
  states: [] as unknown[],
  stateIndex: 0,
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      const idx = mocks.stateIndex++
      if (!(idx in mocks.states)) {
        mocks.states[idx] =
          typeof initial === 'function' ? (initial as () => T)() : initial
      }
      const setState = (next: T | ((prev: T) => T)) => {
        mocks.states[idx] =
          typeof next === 'function'
            ? (next as (prev: T) => T)(mocks.states[idx] as T)
            : next
      }
      return [mocks.states[idx] as T, setState] as const
    },
  }
})

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
  useMutation: (options: {
    mutationFn: (arg?: { forceReconcile?: boolean }) => Promise<unknown>
    onSuccess?: (
      data: ActiveUsageQueryResult,
      variables?: { forceReconcile?: boolean }
    ) => Promise<void>
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
  useVmPerms: () => ({ usageQuery: true }),
}))

vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: (props: {
    open: boolean
    title: ReactNode
    desc: ReactNode
    confirmText?: ReactNode
  }) =>
    props.open ? (
      <div role='alertdialog'>
        <div>{props.title}</div>
        <div>{props.desc}</div>
        <button type='button'>{props.confirmText}</button>
      </div>
    ) : null,
}))

function makeVm(over: Partial<Vm> = {}): Vm {
  return {
    id: 'vm-01',
    has_token: true,
    credential_mode: 'oauth',
    utilization_7d: 0.76,
    quota_observations: {
      official: {
        updated_at: '2026-11-25T00:00:30Z',
        '5h': null,
        '7d': {
          utilization: 0,
          status: 'allowed',
          reset: '2026-11-26T16:00:00Z',
          sampled_at: null,
          stale: false,
        },
      },
      passive: {
        '5h': null,
        '7d': {
          utilization: 0.76,
          status: 'allowed_warning',
          reset: '1795708800',
          sampled_at: '2026-11-25T00:00:00Z',
          stale: false,
        },
      },
    },
    ...over,
  }
}

function rerender(vm: Vm) {
  mocks.stateIndex = 0
  mocks.mutations = []
  return renderToStaticMarkup(<ActiveUsageAction vm={vm} />)
}

beforeEach(() => {
  mocks.mutations = []
  mocks.states = []
  mocks.stateIndex = 0
  vi.clearAllMocks()
})

describe('ActiveUsageAction & conflict feedback (#1776)', () => {
  it('shows success feedback and refreshes queries when active query reconciles headers', async () => {
    const html = rerender(makeVm({ utilization_7d: 0 }))
    expect(html).toContain('主动查询')
    expect(html).not.toContain('按官方校准')

    const mutation = mocks.mutations[0]
    await mutation.mutationFn(undefined)
    expect(vi.mocked(api)).toHaveBeenLastCalledWith(
      '/api/panel/vms/vm-01/usage/query',
      expect.not.objectContaining({ body: expect.anything() })
    )

    await mutation.onSuccess?.({
      vm_id: 'vm-01',
      source: 'official-cc-usage',
      reconciled: true,
      reconciled_windows: ['5h', '7d'],
      retained_windows: [],
      can_force_reconcile: false,
      settle_remaining_ms: 0,
    })
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(3)
    expect(toast.success).toHaveBeenCalledWith('已更新官方额度')
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('warns instead of claiming success during the 5-minute settle window and allows explicit force-reconcile', async () => {
    const vm = makeVm()
    rerender(vm)

    const settleResponse: ActiveUsageQueryResult = {
      vm_id: 'vm-01',
      source: 'official-cc-usage',
      reconciled: false,
      reconciled_windows: ['5h'],
      retained_windows: [
        {
          window: '7d',
          reason: 'settle_window',
          official_utilization: 0,
          retained_utilization: 0.76,
          official_updated_at: '2026-11-25T00:00:30Z',
          header_sampled_at: '2026-11-25T00:00:00Z',
          settle_remaining_ms: 270_000,
        },
      ],
      can_force_reconcile: true,
      settle_remaining_ms: 270_000,
    }

    await mocks.mutations[0].onSuccess?.(settleResponse, undefined)
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining('7D（官方 0% / 当前保留 76%）'),
      expect.objectContaining({
        action: expect.objectContaining({ label: '按官方校准' }),
      })
    )
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toContain('270 秒')

    // Re-rendering with active settle conflict shows the inline force-reconcile trigger.
    const conflictHtml = rerender(vm)
    expect(conflictHtml).toContain('按官方校准')

    // Triggering toast action opens confirmation dialog with dual-source details.
    const toastOpts = vi.mocked(toast.warning).mock.calls[0][1] as unknown as {
      action: { onClick: () => void }
    }
    toastOpts.action.onClick()
    const dialogHtml = rerender(vm)
    expect(dialogHtml).toContain('确认按官方读数校准额度窗口？')
    expect(dialogHtml).toContain('2026-11-25T00:00:30Z')
    expect(dialogHtml).toContain('2026-11-25T00:00:00Z')
    expect(dialogHtml).toContain('确认按官方校准')

    // Executing forceReconcile posts { force_reconcile: true } and clears conflict on success.
    await mocks.mutations[0].mutationFn({ forceReconcile: true })
    const [path, init] = vi.mocked(api).mock.calls[
      vi.mocked(api).mock.calls.length - 1
    ] as [string, RequestInit]
    expect(path).toBe('/api/panel/vms/vm-01/usage/query')
    expect(JSON.parse(String(init.body))).toEqual({ force_reconcile: true })

    await mocks.mutations[0].onSuccess?.(
      {
        vm_id: 'vm-01',
        source: 'official-cc-usage',
        reconciled: true,
        force_reconcile: true,
        reconciled_windows: ['7d'],
        retained_windows: [],
        can_force_reconcile: false,
        settle_remaining_ms: 0,
      },
      { forceReconcile: true }
    )
    expect(toast.success).toHaveBeenCalledWith('已按官方读数校准额度')
    expect(rerender(makeVm({ utilization_7d: 0 }))).not.toContain('按官方校准')
  })

  it('reports inflight and newer_headers retention without offering force-reconcile', async () => {
    const vm = makeVm()
    rerender(vm)

    for (const [reason, expectedCopy] of [
      ['inflight', '在途推理请求'],
      ['newer_headers', '更新的推理响应头'],
    ] as const) {
      const outcome = describeActiveUsageOutcome({
        vm_id: 'vm-01',
        source: 'official-cc-usage',
        reconciled: false,
        retained_windows: [
          {
            window: '7d',
            reason,
            official_utilization: 0,
            retained_utilization: 0.55,
            official_updated_at: '2026-11-25T00:00:30Z',
            header_sampled_at: '2026-11-25T00:00:10Z',
            settle_remaining_ms: 0,
          },
        ],
        can_force_reconcile: false,
        settle_remaining_ms: 0,
      })
      expect(outcome.kind).toBe('retained')
      expect(outcome.canForceReconcile).toBe(false)
      expect(outcome.message).toContain(expectedCopy)
    }

    await mocks.mutations[0].onSuccess?.({
      vm_id: 'vm-01',
      source: 'official-cc-usage',
      reconciled: false,
      retained_windows: [
        {
          window: '7d',
          reason: 'inflight',
          official_utilization: 0,
          retained_utilization: 0.55,
          official_updated_at: '2026-11-25T00:00:30Z',
          header_sampled_at: '2026-11-25T00:00:10Z',
          settle_remaining_ms: 0,
        },
      ],
      can_force_reconcile: false,
      settle_remaining_ms: 0,
    })
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(rerender(vm)).not.toContain('按官方校准')
  })
})
