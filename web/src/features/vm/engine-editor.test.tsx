import type { ReactNode } from 'react'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, patchVm } from '@/lib/api'
import { VmEngineEditor } from './engine-editor'

type Target = 'wrap' | 'v2'
type SwitchOptions = {
  mutationFn: (target: Target) => Promise<unknown>
  onMutate: (target: Target) => void
  onSuccess: (data: unknown, target: Target) => void
  onError: (error: Error) => void
  onSettled: () => Promise<unknown>
}

const mocks = vi.hoisted(() => ({
  mutations: [] as unknown[],
  mutationState: {} as Record<string, unknown>,
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
  loading: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
  useQuery: () => ({}),
  useMutation: (options: unknown) => {
    const index = mocks.mutations.push(options) - 1
    return {
      isPending: false,
      isSuccess: false,
      isError: false,
      error: null,
      mutate: vi.fn(),
      ...(index === 2 ? mocks.mutationState : {}),
    }
  },
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
vi.mock('sonner', () => ({
  toast: {
    loading: mocks.loading,
    success: mocks.success,
    error: mocks.error,
  },
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  patchVm: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/features/vm/vm-perms', () => ({
  useVmPerms: () => ({ admin: true }),
}))
vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: (props: {
    open: boolean
    title: ReactNode
    desc: ReactNode
    confirmText: ReactNode
    isLoading: boolean
  }) =>
    props.open ? (
      <div role='alertdialog'>
        {props.title}
        {props.desc}
        <button disabled={props.isLoading}>{props.confirmText}</button>
      </div>
    ) : null,
}))

function render(overrides: Partial<Vm> = {}) {
  mocks.mutations.length = 0
  return renderToStaticMarkup(
    <VmEngineEditor
      id='vm-01'
      vm={{
        id: 'vm-01',
        status: 'running',
        resolved_dataplane: 'wrap',
        ...overrides,
      }}
    />
  )
}

function options() {
  return mocks.mutations[2] as SwitchOptions
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.mutationState = {}
})

describe('VM page kernel switch feedback', () => {
  it.each(['wrap', 'v2'] as const)(
    'shows persistent progress and a disabled confirmation for %s',
    (target) => {
      mocks.mutationState = { isPending: true, variables: target }
      const html = render()
      const label = target === 'v2' ? 'CRAG v2' : 'cli-node'
      expect(html).toContain(`正在切换到 ${label}`)
      expect(html).toContain('aria-busy="true"')
      expect(html).toContain('请勿重复操作')
      expect(html).toContain('刷新 VM 运行和调度状态')
      expect(html).toContain('<button disabled="">')
      expect(html).toContain('正在切换…')
      expect(html).toContain('role="status"')
    }
  )

  it('explains remote recreation without promising to keep the old container', () => {
    mocks.mutationState = { isPending: true, variables: 'v2' }
    const html = render({ node_id: 'node-jp' })
    expect(html).toContain('重建本槽容器以更换内核命令')
    expect(html).toContain('保留凭证和数据')
    expect(html).toContain('原有调度关闭设置不变')
    expect(html).not.toContain('不删容器')
    expect(html).not.toContain('不 docker rm')
    expect(html).not.toContain('切换推理内核：远端节点暂不支持')
  })

  it.each(['wrap', 'v2'] as const)(
    'keeps a completed switch to %s visible after the toast',
    (target) => {
      mocks.mutationState = { isSuccess: true, variables: target }
      const html = render()
      expect(html).toContain('内核切换完成')
      expect(html).toContain('内核重启完成')
      expect(html).not.toContain('role="alertdialog"')
    }
  )

  it('does not claim that a stopped VM restarted', () => {
    mocks.mutationState = { isSuccess: true, variables: 'v2' }
    const html = render({ status: 'stopped' })
    expect(html).toContain('VM 保持停止，下次启动生效')
    expect(html).not.toContain('内核重启完成')
  })

  it('keeps failure details and a diagnostic next step visible', () => {
    mocks.mutationState = {
      isError: true,
      variables: 'v2',
      error: new Error('节点内核未就绪'),
    }
    const html = render()
    expect(html).toContain('role="alert"')
    expect(html).toContain('内核切换未完成')
    expect(html).toContain('节点内核未就绪')
    expect(html).toContain('核对当前内核、VM 运行和调度状态')
    expect(html).toContain('恢复服务')
    expect(html).not.toContain('内核切换完成')
  })

  it('shows an actionable license error instead of raw server jargon', () => {
    mocks.mutationState = {
      isError: true,
      variables: 'v2',
      error: new ApiError('license expired', 403, 'license_expired'),
    }
    expect(render()).toContain('授权已到期')
  })

  it.each(['wrap', 'v2'] as const)(
    'replaces the loading toast with the result of switching to %s',
    (target) => {
      render()
      options().onMutate(target)
      const toastOptions = {
        id: 'vm-kernel-switch-vm-01',
        description: undefined,
      }
      expect(mocks.loading).toHaveBeenCalledWith(
        expect.stringContaining(target === 'v2' ? 'CRAG v2' : 'cli-node'),
        expect.objectContaining({ id: toastOptions.id })
      )
      options().onSuccess({}, target)
      expect(mocks.success).toHaveBeenCalledWith(
        expect.stringContaining('内核重启完成'),
        toastOptions
      )
      expect(mocks.error).not.toHaveBeenCalled()
    }
  )

  it('replaces the loading toast on failure without claiming success', () => {
    render()
    options().onMutate('v2')
    options().onError(new Error('节点连接断开'))
    expect(mocks.error).toHaveBeenCalledWith('内核切换未完成：节点连接断开', {
      id: 'vm-kernel-switch-vm-01',
      description: '请先核对当前内核、VM 运行和调度状态，再重试。',
    })
    expect(mocks.success).not.toHaveBeenCalled()
  })

  it('describes saving a stopped VM without promising a restart', () => {
    render({ status: 'stopped' })
    options().onMutate('v2')
    expect(mocks.loading).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        description: expect.stringContaining('VM 不会因此启动'),
      })
    )
    options().onSuccess({}, 'v2')
    expect(mocks.success).toHaveBeenCalledWith(
      expect.stringContaining('VM 保持停止，下次启动生效'),
      expect.any(Object)
    )
  })

  it('refreshes detail, list and dashboard after either outcome and awaits refresh', async () => {
    render()
    let finishRefresh: () => void = () => {}
    mocks.invalidateQueries.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve
        })
    )
    const settled = options().onSettled()
    expect(
      mocks.invalidateQueries.mock.calls.map(([query]) => query.queryKey)
    ).toEqual([
      ['panel', 'vm', 'vm-01'],
      ['panel', 'vms'],
      ['panel', 'dashboard'],
    ])
    let finished = false
    void settled.then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(finished).toBe(false)
    finishRefresh()
    await settled
    expect(finished).toBe(true)
  })

  it.each([
    ['v2', { dataplane: 'crag', crag_kernel_version: 'v2' }],
    ['wrap', { dataplane: 'wrap', crag_kernel_version: '' }],
  ] as const)(
    'retains the per-VM PATCH contract for %s',
    async (target, body) => {
      render()
      await options().mutationFn(target)
      expect(patchVm).toHaveBeenCalledExactlyOnceWith('vm-01', body)
    }
  )
})
