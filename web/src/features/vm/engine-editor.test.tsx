import type { ComponentProps, ReactNode } from 'react'
import type * as ReactModule from 'react'
import { MutationObserver, QueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VmKernelSwitchJob } from '@/lib/api'
import { ApiError, patchVm, startVmKernelSwitch } from '@/lib/api'
import { VmEngineEditor } from './engine-editor'

type Target = 'wrap' | 'v2'
type SwitchOptions = {
  mutationFn: (target: Target) => Promise<unknown>
  onMutate: (target: Target) => void
  onSuccess: (data: unknown, target: Target) => void
  onError: (error: Error) => void
  onSettled: (
    data?: unknown,
    error?: Error | null
  ) => Promise<unknown> | undefined
  retry: false
}

const mocks = vi.hoisted(() => ({
  admin: true,
  mutations: [] as unknown[],
  queries: [] as { enabled?: boolean }[],
  buttons: [] as { children?: ReactNode; disabled?: boolean }[],
  mutationState: {} as Record<string, unknown>,
  jobState: {} as Record<string, unknown>,
  effects: [] as (() => void)[],
  setQueryData: vi.fn(),
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
  loading: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactModule>()),
  useEffect: (effect: () => void) => {
    mocks.effects.push(effect)
  },
}))
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({
    invalidateQueries: mocks.invalidateQueries,
    setQueryData: mocks.setQueryData,
  }),
  useQuery: (options: { enabled?: boolean; queryKey: readonly unknown[] }) => {
    mocks.queries.push(options)
    return options.queryKey.includes('vm-kernel-switch')
      ? {
          isPending: false,
          isFetching: false,
          isError: false,
          ...mocks.jobState,
        }
      : {}
  },
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
  startVmKernelSwitch: vi.fn(),
}))
vi.mock('@/features/vm/vm-perms', () => ({
  useVmPerms: () => ({ admin: mocks.admin }),
}))
vi.mock('@/components/ui/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/button')>()
  const OriginalButton = actual.Button
  return {
    ...actual,
    Button: (props: ComponentProps<typeof OriginalButton>) => {
      mocks.buttons.push({ children: props.children, disabled: props.disabled })
      return <OriginalButton {...props} />
    },
  }
})
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
  mocks.queries.length = 0
  mocks.buttons.length = 0
  mocks.effects.length = 0
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

function job(overrides: Partial<VmKernelSwitchJob> = {}): VmKernelSwitchJob {
  return {
    id: 'job-01',
    vm_id: 'vm-01',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    status: 'running',
    started_at: '2026-11-15T00:00:00Z',
    finished_at: null,
    error: null,
    ...overrides,
  }
}

function runEffects() {
  for (const effect of mocks.effects) effect()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.admin = true
  mocks.mutationState = {}
  mocks.jobState = {}
  vi.mocked(startVmKernelSwitch).mockResolvedValue(job())
})

describe('VM page kernel switch feedback', () => {
  it.each([undefined, 'node-jp'])(
    'enables KVM switching and license queries with node_id=%s',
    (node_id) => {
      const vm = { runtime_type: 'kvm' as const, node_id }
      const html = render(vm)
      expect(mocks.buttons).toContainEqual({
        children: '本槽切到 CRAG v2',
        disabled: false,
      })
      expect(mocks.buttons).toContainEqual({
        children: 'CRAG 授权 / 续期',
        disabled: false,
      })
      expect(html).not.toContain('KVM 槽不运行 CRAG v2')
      expect(mocks.queries).toContainEqual(
        expect.objectContaining({
          queryKey: ['panel', 'vm', 'vm-01', 'crag-license'],
          enabled: true,
        })
      )
      expect(mocks.queries).toContainEqual(
        expect.objectContaining({
          queryKey: ['panel', 'vm-kernel-switch', 'vm-01'],
          enabled: !!node_id,
        })
      )

      render({
        ...vm,
        resolved_dataplane: 'crag',
        resolved_crag_kernel_version: 'v2',
      })
      expect(mocks.buttons).toContainEqual({
        children: '本槽切回 cli-node',
        disabled: false,
      })
    }
  )

  it('keeps native macOS switching and license controls unavailable', () => {
    const html = render({ node_id: 'node-mac', node_platform: 'darwin' })
    expect(mocks.buttons).toContainEqual({
      children: '本槽切到 CRAG v2',
      disabled: true,
    })
    expect(html).not.toContain('CRAG 授权 / 续期')
    expect(html).toContain('macOS 原生节点不运行 CRAG v2')
    expect(mocks.queries).toHaveLength(2)
    expect(mocks.queries.every((query) => query.enabled === false)).toBe(true)
  })

  it('does not expose Claude kernel or license controls for Codex KVM slots', () => {
    const html = render({ runtime_type: 'kvm', family: 'codex' })
    expect(html).not.toContain('本槽切到 CRAG v2')
    expect(html).not.toContain('本槽切回 cli-node')
    expect(html).not.toContain('CRAG 授权 / 续期')
    expect(mocks.queries).toEqual([])
  })

  it('does not describe remote KVM switching as replacing a Docker container', () => {
    mocks.mutationState = { isPending: true, variables: 'v2' }
    const html = render({ runtime_type: 'kvm', node_id: 'node-kvm' })
    expect(html).toContain('切换并重启本槽内核')
    expect(html).toContain('原有调度关闭设置不变')
    expect(html).not.toContain('重建本槽容器以更换内核命令')
  })

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

  it.each<Partial<Vm>>([
    { runtime_type: 'kvm' },
    { runtime: { type: 'qemu' } },
    { node_id: 'node-kvm', runtime: { type: 'kvm' } },
  ])('allows CRAG selection and licensing on KVM placement %j', (placement) => {
    const html = render(placement)
    const button = html.match(
      /<button\b([^>]*)>(?:(?!<\/button>)[\s\S])*?本槽切到 CRAG v2(?:(?!<\/button>)[\s\S])*?<\/button>/
    )
    expect(button).not.toBeNull()
    expect(button?.[1]).not.toContain(' disabled=""')
    expect(html).toContain('CRAG 授权 / 续期')
    mocks.mutationState = { isPending: true, variables: 'v2' }
    const pending = render(placement)
    expect(pending).toContain('保留 KVM 虚拟机和磁盘')
    expect(pending).not.toContain('重建本槽容器以更换内核命令')
  })

  it('keeps CRAG selection unavailable on native macOS nodes', () => {
    const html = render({ node_platform: 'darwin' })
    const button = html.match(
      /<button\b([^>]*)>(?:(?!<\/button>)[\s\S])*?本槽切到 CRAG v2(?:(?!<\/button>)[\s\S])*?<\/button>/
    )
    expect(button?.[1]).toContain(' disabled=""')
    expect(html).not.toContain('CRAG 授权 / 续期')
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
    if (!settled) throw new Error('Expected the VM refresh to be awaited')
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

  it('does not treat an accepted remote job as success while the policy already matches', async () => {
    mocks.mutationState = { isSuccess: true, variables: 'v2' }
    const running = job()
    mocks.jobState = { data: running }
    const html = render({
      node_id: 'node-docker',
      resolved_dataplane: 'crag',
      resolved_crag_kernel_version: 'v2',
    })
    options().onSuccess(running, 'v2')
    await options().onSettled(running, null)
    runEffects()
    expect(html).toContain('正在切换到 CRAG v2')
    expect(html).not.toContain('内核切换完成')
    expect(html).toContain('aria-busy="true"')
    expect(mocks.buttons.every((button) => button.disabled)).toBe(true)
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.invalidateQueries).not.toHaveBeenCalled()
  })

  it.each(['wrap', 'v2'] as const)(
    'reattaches to a running %s job on reopen without submitting another switch',
    (target) => {
      mocks.jobState = {
        data: job({
          dataplane: target === 'v2' ? 'crag' : 'wrap',
          crag_kernel_version: target === 'v2' ? 'v2' : '',
        }),
      }
      const html = render({
        node_id: 'node-kvm',
        runtime_type: 'kvm',
        resolved_dataplane: 'crag',
        resolved_crag_kernel_version: 'v2',
      })
      runEffects()
      const label = target === 'v2' ? 'CRAG v2' : 'cli-node'
      expect(html).toContain(`正在切换到 ${label}`)
      expect(html).toContain('可重新打开查看进度')
      expect(html).not.toContain('内核切换完成')
      expect(html).not.toContain('role="alertdialog"')
      expect(mocks.buttons.every((button) => button.disabled)).toBe(true)
      expect(mocks.loading).toHaveBeenCalledWith(
        `正在切换到 ${label}…`,
        expect.objectContaining({ id: 'vm-kernel-switch-vm-01' })
      )
      expect(startVmKernelSwitch).not.toHaveBeenCalled()
      expect(patchVm).not.toHaveBeenCalled()
    }
  )

  it('does not query or expose kernel switching for non-admin users', () => {
    mocks.admin = false
    const html = render({ node_id: 'node-docker' })
    expect(html).not.toContain('本槽切到 CRAG v2')
    expect(html).not.toContain('本槽切回 cli-node')
    expect(mocks.queries).toEqual([])
    expect(startVmKernelSwitch).not.toHaveBeenCalled()
  })

  it('waits for the initial remote job lookup before enabling a new switch', () => {
    mocks.jobState = { isPending: true, isFetching: true }
    const html = render({ node_id: 'node-docker' })
    expect(html).toContain('正在核对本槽是否有未完成的内核切换')
    expect(mocks.buttons.every((button) => button.disabled)).toBe(true)
    expect(html).not.toContain('内核切换完成')
  })

  it('shows success and refreshes real VM state only for a succeeded remote job', () => {
    mocks.jobState = { data: job({ status: 'succeeded' }) }
    const html = render({ node_id: 'node-docker' })
    runEffects()
    expect(html).toContain('内核切换完成')
    expect(html).not.toContain('正在切换到 CRAG v2')
    expect(mocks.success).toHaveBeenCalledWith(
      expect.stringContaining('内核重启完成'),
      expect.objectContaining({ id: 'vm-kernel-switch-vm-01' })
    )
    expect(
      mocks.invalidateQueries.mock.calls.map(([query]) => query.queryKey)
    ).toEqual([
      ['panel', 'vm', 'vm-01'],
      ['panel', 'vms'],
      ['panel', 'dashboard'],
    ])
  })

  it('reports a stopped remote slot as configured without claiming it started', () => {
    mocks.jobState = { data: job({ status: 'succeeded' }) }
    const html = render({
      node_id: 'node-docker',
      status: 'stopped',
      schedulable: false,
    })
    runEffects()
    expect(html).toContain('VM 保持停止，下次启动生效')
    expect(html).not.toContain('内核重启完成')
    expect(mocks.success).toHaveBeenCalledWith(
      expect.stringContaining('VM 保持停止，下次启动生效'),
      expect.any(Object)
    )
    expect(startVmKernelSwitch).not.toHaveBeenCalled()
  })

  it('shows the final remote failure and refreshes without claiming success', () => {
    mocks.mutationState = { isSuccess: true, variables: 'v2' }
    mocks.jobState = {
      data: job({
        status: 'failed',
        error: { code: 'runtime_start_failed', message: '节点内核未就绪' },
      }),
    }
    const html = render({ node_id: 'node-docker' })
    runEffects()
    expect(html).toContain('内核切换未完成')
    expect(html).toContain('节点内核未就绪')
    expect(html).not.toContain('内核切换完成')
    expect(html).not.toContain('aria-busy="true"')
    expect(mocks.error).toHaveBeenCalledWith(
      '内核切换未完成：节点内核未就绪',
      expect.objectContaining({ id: 'vm-kernel-switch-vm-01' })
    )
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(3)
  })

  it.each(['请求连接断开', '切换任务记录已丢失，操作可能已中断'])(
    'stops waiting and requires an explicit state check after %s',
    (message) => {
      mocks.jobState = {
        data: job(),
        isError: true,
        error: new Error(message),
        errorUpdatedAt: 1,
      }
      const html = render({ node_id: 'node-docker' })
      runEffects()
      expect(html).toContain('内核切换未完成')
      expect(html).toContain(message)
      expect(html).toContain('核对切换状态')
      expect(html).not.toContain('aria-busy="true"')
      expect(html).not.toContain('内核切换完成')
      expect(
        mocks.buttons
          .filter((button) => button.children !== '核对切换状态')
          .every((button) => button.disabled)
      ).toBe(true)
      expect(mocks.invalidateQueries).toHaveBeenCalledTimes(3)
      expect(startVmKernelSwitch).not.toHaveBeenCalled()
      expect(mocks.success).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, 'node-docker'])(
    'allows the same CRAG policy to be retried only for a running runtime failure (%s)',
    (node_id) => {
      const failedVm: Partial<Vm> = {
        node_id,
        resolved_dataplane: 'crag',
        resolved_crag_kernel_version: 'v2',
        unschedulable_reason: 'runtime_start_failed',
      }
      render(failedVm)
      expect(mocks.buttons).toContainEqual({
        children: '本槽切到 CRAG v2',
        disabled: false,
      })
      render({ ...failedVm, status: 'stopped' })
      expect(mocks.buttons).toContainEqual({
        children: '本槽切到 CRAG v2',
        disabled: true,
      })
      render({ ...failedVm, unschedulable_reason: 'proxy_unavailable' })
      expect(mocks.buttons).toContainEqual({
        children: '本槽切到 CRAG v2',
        disabled: true,
      })
    }
  )

  it.each([
    ['v2', { dataplane: 'crag', crag_kernel_version: 'v2' }],
    ['wrap', { dataplane: 'wrap', crag_kernel_version: '' }],
  ] as const)(
    'uses the async remote endpoint for %s without changing scheduling',
    async (target, body) => {
      render({ node_id: 'node-docker', schedulable: false })
      await options().mutationFn(target)
      expect(startVmKernelSwitch).toHaveBeenCalledExactlyOnceWith('vm-01', body)
      expect(patchVm).not.toHaveBeenCalled()
    }
  )

  it('never automatically retries a disconnected POST even with a retrying query client', async () => {
    vi.mocked(startVmKernelSwitch).mockRejectedValueOnce(
      new Error('节点连接断开')
    )
    render({ node_id: 'node-docker' })
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: 3 } },
    })
    const mutation = new MutationObserver<unknown, Error, Target>(
      client,
      options()
    )
    try {
      await expect(mutation.mutate('v2')).rejects.toThrow('节点连接断开')
      expect(startVmKernelSwitch).toHaveBeenCalledTimes(1)
      expect(mocks.success).not.toHaveBeenCalled()
      expect(mocks.error).toHaveBeenCalledWith(
        '内核切换未完成：节点连接断开',
        expect.objectContaining({ id: 'vm-kernel-switch-vm-01' })
      )
      expect(mocks.invalidateQueries).toHaveBeenCalledTimes(3)
    } finally {
      client.clear()
    }
  })
})
