import type { ComponentProps, ReactNode } from 'react'
import type { CragLicenseStatus, Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import type { CragHostStatus } from '@/features/vm/queries'
import { WrapSamplePage } from './index'
import {
  installKernelTargets,
  pullKernelRelease,
  updateCragTargets,
  type KernelInstallation,
} from './queries'

type ConfirmProps = ComponentProps<
  typeof import('@/components/confirm-dialog').ConfirmDialog
>
type ButtonProps = ComponentProps<
  typeof import('@/components/ui/button').Button
>

const state = vi.hoisted(() => ({
  vms: [] as Vm[],
  installations: {} as Record<string, KernelInstallation>,
  licenses: {} as Record<string, CragLicenseStatus>,
  installLicenses: undefined as Record<string, CragLicenseStatus> | undefined,
  role: 'admin',
  host: undefined as CragHostStatus | undefined,
  hostError: false,
  hostEnabled: false,
  hostInterval: undefined as number | false | undefined,
  cragPin: undefined as { tag: string; label?: string } | null | undefined,
  values: [] as unknown[],
  cursor: 0,
  buttons: [] as ButtonProps[],
  confirm: undefined as ConfirmProps | undefined,
  invalidateQueries: vi.fn(),
}))

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = state.cursor++
    if (index >= state.values.length)
      state.values[index] = typeof initial === 'function' ? initial() : initial
    return [
      state.values[index],
      (next: unknown) => {
        state.values[index] =
          typeof next === 'function' ? next(state.values[index]) : next
      },
    ]
  },
}))
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: state.invalidateQueries }),
  useMutation: () => ({ isPending: false }),
  useQuery: ({
    queryKey,
    enabled,
    refetchInterval,
  }: {
    queryKey: string[]
    enabled?: boolean
    refetchInterval?: number | false
  }) => {
    if (queryKey[0] === 'crag-host-subscription') {
      state.hostEnabled = enabled === true
      state.hostInterval = refetchInterval
      return {
        data: state.host,
        isError: state.hostError,
        error: state.hostError ? new Error('host status unavailable') : null,
        isLoading: false,
      }
    }
    return {
      data: queryKey.includes('kernels')
        ? {
            kernels: [
              {
                id: 'crag',
                paid: true,
                ready: true,
                version: '3.0.8',
                payload_tag: 'payload-2026.11.16-crag-3.0.8',
              },
              { id: 'cli-node', paid: false, ready: true, version: '1.4.131' },
            ],
            crag_pin: state.cragPin,
            licenses: state.licenses,
            install_licenses: state.installLicenses,
            installations: state.installations,
          }
        : queryKey.includes('dashboard')
          ? { vms: state.vms }
          : { role: state.role },
      isLoading: false,
    }
  },
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
vi.mock('@/components/page-header', () => ({
  PageHeader: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
}))
vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: (props: ConfirmProps) => {
    state.confirm = props
    return props.open ? <div>{props.desc}</div> : null
  },
}))
vi.mock('@/components/ui/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/button')>()
  return {
    ...actual,
    Button: (props: ButtonProps) => {
      state.buttons.push(props)
      return <actual.Button {...props} />
    },
  }
})
vi.mock('./queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./queries')>()),
  installKernelTargets: vi.fn(),
  updateCragTargets: vi.fn(),
  pullKernelRelease: vi.fn(),
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

function render(vm: Partial<Vm> = {}, otherVms: Vm[] = []) {
  state.cursor = 0
  state.buttons.length = 0
  state.confirm = undefined
  state.vms = [
    { id: 'vm-old', resolved_dataplane: 'wrap', runtime_type: 'kvm', ...vm },
    ...otherVms,
  ]
  return renderToStaticMarkup(<WrapSamplePage />)
}

beforeEach(() => {
  vi.clearAllMocks()
  state.installations = {}
  state.licenses = {}
  state.installLicenses = undefined
  state.role = 'admin'
  state.host = undefined
  state.hostError = false
  state.hostEnabled = false
  state.hostInterval = undefined
  state.cragPin = { tag: 'payload-2026.11.21-crag-3.1.12' }
  state.values = []
  state.cursor = 0
  state.buttons = []
  state.confirm = undefined
  state.invalidateQueries.mockReset()
  vi.mocked(installKernelTargets).mockReset()
  vi.mocked(installKernelTargets).mockImplementation(async (targets) => ({
    ok: true,
    total: targets.length,
    ok_count: targets.length,
    failed_count: 0,
    items: targets.map((target) => ({
      ...target,
      ok: true,
      stopped: true,
      restarted: true,
    })),
  }))
  vi.mocked(updateCragTargets).mockReset()
  vi.mocked(updateCragTargets).mockImplementation(async (targets) => ({
    ok: true,
    total: targets.length,
    ok_count: targets.length,
    failed_count: 0,
    items: targets.map((target) => ({
      ...target,
      ok: true,
      stopped: true,
      restarted: true,
    })),
  }))
  vi.mocked(pullKernelRelease).mockReset()
  vi.mocked(pullKernelRelease).mockResolvedValue({
    kernel: {
      id: 'crag',
      name: 'CRAG',
      paid: true,
      ready: true,
      version: '3.1.12',
      updated_at: null,
    },
  })
})

async function reinstallCrag(vm: Partial<Vm>) {
  const selected: Partial<Vm> = {
    ...vm,
    resolved_dataplane: 'crag',
    resolved_crag_kernel_version: 'v2',
  }
  render(selected)
  const button = state.buttons.find(
    (entry) => entry['aria-label'] === '重装 vm-old 并重启'
  )
  expect(button).toBeDefined()
  expect(button?.disabled).toBe(false)
  button?.onClick?.({} as Parameters<NonNullable<ButtonProps['onClick']>>[0])
  render(selected)
  expect(state.confirm?.open).toBe(true)
  expect(state.confirm?.handleConfirm).toBeTypeOf('function')
  state.confirm?.handleConfirm?.()
  await vi.waitFor(() =>
    expect(state.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['panel', 'vms'],
    })
  )
}

describe('KVM reinstall confirmation', () => {
  it.each([
    { runtime_type: 'kvm' },
    { runtime: { type: 'kvm' } },
    { runtime: { type: 'qemu' } },
    { runtime: { type: 'libvirt' } },
  ] satisfies Partial<Vm>[])(
    'pins the confirmed payload for local runtime %j',
    async (vm) => {
      await reinstallCrag(vm)
      expect(installKernelTargets).toHaveBeenCalledExactlyOnceWith([
        {
          id: 'vm-old',
          kernel: 'crag',
          payload_tag: 'payload-2026.11.16-crag-3.0.8',
        },
      ])
    }
  )

  it.each(['docker', 'kvm', 'qemu', 'libvirt'])(
    'pins the confirmed payload for remote %s slots',
    async (type) => {
      await reinstallCrag({ runtime: { type }, node_id: 'node-remote' })
      expect(installKernelTargets).toHaveBeenCalledExactlyOnceWith([
        {
          id: 'vm-old',
          kernel: 'crag',
          payload_tag: 'payload-2026.11.16-crag-3.0.8',
        },
      ])
    }
  )
})

it('shows deferred CRAG reclamation after a cli-node install and refreshes the host count', async () => {
  vi.mocked(installKernelTargets).mockImplementationOnce(async (targets) => ({
    ok: true,
    total: targets.length,
    ok_count: targets.length,
    failed_count: 0,
    items: targets.map((target) => ({
      ...target,
      ok: true,
      stopped: true,
      restarted: true,
      reclaim_pending: true,
    })),
  }))
  const vm = { id: 'slot-a', resolved_dataplane: 'crag' } as const
  render(vm)
  state.values[2] = { 'slot-a': 'cli-node' }
  render(vm)
  const button = state.buttons.find(
    (entry) => entry['aria-label'] === '安装 slot-a 并重启'
  )
  expect(button?.disabled).toBe(false)
  button?.onClick?.({} as Parameters<NonNullable<ButtonProps['onClick']>>[0])
  render(vm)
  expect(state.confirm?.open).toBe(true)
  state.confirm?.handleConfirm?.()
  await vi.waitFor(() => {
    expect(state.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['crag-host-subscription'],
    })
  })
  expect(installKernelTargets).toHaveBeenCalledExactlyOnceWith([
    { id: 'slot-a', kernel: 'cli-node', expected_tag: undefined },
  ])
  expect(toast.warning).toHaveBeenCalledExactlyOnceWith(
    '1 台内核已安装并重启，1 个 CRAG 绑定待回收',
    {
      description:
        '启用槽位回收后，请重装 cli-node 完成回收，额度以服务端确认为准。',
    }
  )
  expect(toast.success).not.toHaveBeenCalled()
  expect(render(vm)).toContain('重启完成，原调度限制保留；CRAG 绑定待回收')
})

it('pauses a bulk installation when the first slot result is unconfirmed', async () => {
  vi.mocked(installKernelTargets).mockRejectedValueOnce(
    new ApiError('无法确认安装结果', 0, 'kernel_install_unconfirmed')
  )
  const otherVms: Vm[] = [
    { id: 'vm-next', resolved_dataplane: 'crag', runtime_type: 'docker' },
  ]
  render({}, otherVms)
  const button = state.buttons.find(
    (entry) => entry['aria-label'] === '把 CRAG 更新到全部槽位'
  )
  expect(button?.disabled).toBe(false)
  button?.onClick?.({} as Parameters<NonNullable<ButtonProps['onClick']>>[0])
  render({}, otherVms)
  expect(state.confirm?.open).toBe(true)
  state.confirm?.handleConfirm?.()
  await vi.waitFor(() =>
    expect(render({}, otherVms)).toContain('当前槽位结果未确认')
  )
  expect(installKernelTargets).toHaveBeenCalledExactlyOnceWith([
    {
      id: 'vm-old',
      kernel: 'crag',
      payload_tag: 'payload-2026.11.16-crag-3.0.8',
    },
  ])
  expect(toast.success).not.toHaveBeenCalled()
})

it.each(['license_required', 'license_payload_key_mismatch'])(
  'does not gate ordinary installation based on the cached %s hint',
  (code) => {
    state.licenses['vm-old'] = {
      status: 'valid',
      valid: true,
      vm_id: 'vm-old',
      scope: 'host',
    }
    // Older backends may still return the hint. The install decision belongs to the server.
    state.installLicenses = {
      'vm-old': { status: 'invalid', valid: false, vm_id: 'vm-old', code },
    }
    const html = render({ runtime_type: 'docker', resolved_dataplane: 'crag' })
    expect(html).toContain('授权有效')
    expect(html).not.toContain('确认重装时会尝试使用本机已激活的宿主订阅')
    expect(html).toContain('aria-label="安装 vm-old 并重启"')
    expect(html).not.toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="安装 vm-old 并重启"/
    )
  }
)

describe('explicit CRAG grant migration', () => {
  it('offers migration for the selected package and sends reissue only after explicit confirmation', async () => {
    const vm = { runtime_type: 'docker', resolved_dataplane: 'wrap' } as const
    // A partial old install can make the installed license unconfigured while
    // the candidate reports that its payload key differs from the old grant.
    state.licenses['vm-old'] = {
      status: 'unconfigured',
      valid: false,
      vm_id: 'vm-old',
      code: 'license_unconfigured',
    }
    state.installLicenses = {
      'vm-old': {
        status: 'invalid',
        valid: false,
        vm_id: 'vm-old',
        code: 'license_payload_key_mismatch',
      },
    }
    render(vm)
    state.values[2] = { 'vm-old': 'crag' }
    const html = render(vm)
    expect(html).toContain('所选发行包需要迁移现有授权')
    const migrate = state.buttons.find(
      (entry) => entry['aria-label'] === '迁移 vm-old 授权并安装 CRAG'
    )
    expect(migrate?.disabled).toBe(false)
    migrate?.onClick?.({} as never)
    render(vm)
    expect(state.confirm?.open).toBe(true)
    expect(state.confirm?.confirmText).toBe('确认迁移并安装')
    expect(state.confirm?.title).toContain('迁移 vm-old 的授权')
    expect(installKernelTargets).not.toHaveBeenCalled()
    state.confirm?.handleConfirm?.()
    await vi.waitFor(() =>
      expect(installKernelTargets).toHaveBeenCalledExactlyOnceWith([
        {
          id: 'vm-old',
          kernel: 'crag',
          payload_tag: 'payload-2026.11.16-crag-3.0.8',
          reissue: true,
        },
      ])
    )
  })

  it('offers a migration action after the server requires it, without silently retrying', async () => {
    vi.mocked(installKernelTargets).mockImplementationOnce(async (targets) => ({
      ok: false,
      total: 1,
      ok_count: 0,
      failed_count: 1,
      items: targets.map((target) => ({
        ...target,
        ok: false,
        stopped: false,
        code: 'crag_subscription_migration_required',
        error: '此槽已有宿主订阅绑定，请完成授权迁移。',
      })),
    }))
    const vm = {
      runtime_type: 'docker',
      resolved_dataplane: 'crag',
      resolved_crag_kernel_version: 'v2',
    } as const
    await reinstallCrag(vm)
    const html = render(vm)
    expect(html).toContain('此槽已有宿主订阅绑定')
    expect(html).toContain('迁移授权并安装')
    expect(installKernelTargets).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(installKernelTargets).mock.calls[0][0][0]
    ).not.toHaveProperty('reissue')
  })

  it('does not turn an unconfigured or missing license into an automatic migration', () => {
    state.licenses['vm-old'] = {
      status: 'unconfigured',
      valid: false,
      vm_id: 'vm-old',
      code: 'license_unconfigured',
    }
    state.installLicenses = {
      'vm-old': {
        status: 'unlicensed',
        valid: false,
        vm_id: 'vm-old',
        code: 'license_required',
      },
    }
    const html = render({ runtime_type: 'docker', resolved_dataplane: 'crag' })
    expect(html).not.toContain('迁移授权并安装')
    expect(installKernelTargets).not.toHaveBeenCalled()
  })

  it('disables migration for viewers and never offers it for cli-node or macOS', () => {
    state.installLicenses = {
      'vm-old': {
        status: 'invalid',
        valid: false,
        vm_id: 'vm-old',
        code: 'license_payload_key_mismatch',
      },
    }
    expect(render({ runtime_type: 'docker' })).not.toContain('迁移授权并安装')
    expect(
      render({ node_platform: 'darwin', resolved_dataplane: 'crag' })
    ).not.toContain('迁移授权并安装')
    state.role = 'user'
    render({ runtime_type: 'docker', resolved_dataplane: 'crag' })
    const migrate = state.buttons.find(
      (entry) => entry['aria-label'] === '迁移 vm-old 授权并安装 CRAG'
    )
    expect(migrate?.disabled).toBe(true)
  })
})

describe('KVM CRAG repair on the kernel page', () => {
  it('offers explicit CRAG reinstall when the current kernel is cli-node', () => {
    const html = render()
    expect(html).toContain('未记录 CRAG 版本')
    expect(html).toContain('aria-label="重装 vm-old 的 CRAG 并重启"')
    expect(html).toContain('>KVM</span>')
  })

  it('does not mistake the v2 protocol selector for an installed product version', () => {
    const html = render({
      resolved_dataplane: 'crag',
      resolved_crag_kernel_version: 'v2',
    })
    expect(html).toContain('重装 vm-old 的 CRAG 并重启')
    state.installations['vm-old'] = {
      kernel: 'crag',
      version: '2.8.17',
      installed_at: '',
    }
    expect(render()).not.toContain('重装 vm-old 的 CRAG 并重启')
  })

  it('does not use a cli-node version as CRAG evidence and recognizes legacy runtime records', () => {
    state.installations['vm-old'] = {
      kernel: 'cli-node',
      version: '1.4.086',
      installed_at: '',
    }
    expect(render({ runtime_type: null, runtime: { type: 'qemu' } })).toContain(
      '重装 vm-old 的 CRAG 并重启'
    )
    state.installations['vm-old'] = {
      kernel: 'crag',
      version: ' ',
      installed_at: '',
    }
    expect(render()).toContain('重装 vm-old 的 CRAG 并重启')
  })

  it('excludes Docker, macOS and Codex slots from KVM repair', () => {
    expect(render({ runtime_type: 'docker' })).not.toContain(
      '重装 vm-old 的 CRAG 并重启'
    )
    expect(render({ node_platform: 'darwin' })).not.toContain(
      '重装 vm-old 的 CRAG 并重启'
    )
    expect(render({ kind: 'codex' })).not.toContain(
      '重装 vm-old 的 CRAG 并重启'
    )
  })

  it('keeps the repair action disabled for non-admin users', () => {
    state.role = 'user'
    expect(render()).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="重装 vm-old 的 CRAG 并重启"/
    )
  })
})

describe('CRAG runtime on the kernel page', () => {
  it('shows one remaining capacity and per-slot health independent of the selected kernel', () => {
    state.host = {
      ready: true,
      state: 'active',
      slot_limit: 1,
      available_seats: 0,
      runtime: {
        running_vms: 3,
        ready_vms: 1,
        unknown_vms: 1,
        host_running_vms: 2,
        host_unknown_vms: 0,
        host_runtime_available: 0,
        host_over_limit: true,
        checked_at: '2026-11-16T00:00:00.000Z',
        vms: {
          'vm-old': {
            state: 'running',
            ready: false,
            quota_blocked: true,
            scope: 'host',
            version: '3.0.8',
            active_requests: 0,
            queued: 0,
            ready_slots: 0,
          },
        },
      },
    }
    const html = render({ status: 'stopped' })
    expect(state.hostEnabled).toBe(true)
    expect(state.hostInterval).toBe(10_000)
    expect(html).toMatch(/使用中的槽位<\/span><span[^>]*>2<\/span>/)
    expect(html).not.toContain('可用运行名额')
    // 超额现在拆成「徽章=状态」+「文字=后果」两段，不再是一句连续文案。
    expect(html).toContain('宿主订阅超额')
    expect(html).toContain('仅超额槽暂停调度')
    expect(html).toContain('兑换槽位')
    expect(html).toContain('超出订阅额度 / 暂停调度')
    expect(html).toContain('版本 3.0.8 · 处理中 0 · 排队 0 · 就绪处理槽 0')

    state.role = 'user'
    const userHtml = render()
    expect(userHtml).not.toContain('使用中的槽位')
    expect(userHtml).not.toContain('超出订阅额度 / 暂停调度')
    expect(userHtml).not.toContain('兑换槽位')
    expect(state.hostEnabled).toBe(false)
    expect(state.hostInterval).toBe(false)
  })

  it('keeps unknown runtime distinct from zero without blocking the page on query errors', () => {
    state.host = { ready: false, state: 'active', slot_limit: 2 }
    const cragVm = {
      resolved_dataplane: 'crag',
      resolved_crag_kernel_version: 'v2',
      status: 'running',
    } as const
    const html = render(cragVm)
    expect(html).toMatch(/使用中的槽位<\/span><span[^>]*>待核对<\/span>/)
    expect(html).toContain('CRAG：运行状态未知')

    state.hostError = true
    const errorHtml = render(cragVm)
    expect(errorHtml).toContain('重装 vm-old 的 CRAG 并重启')
    expect(errorHtml).toContain('CRAG：运行状态未知')
    expect(errorHtml).toMatch(/使用中的槽位<\/span><span[^>]*>待核对<\/span>/)
  })
})

describe('one-click CRAG upgrade to the pinned payload', () => {
  const cragVm = {
    id: 'slot-a',
    resolved_dataplane: 'crag',
    resolved_crag_kernel_version: 'v2',
    status: 'running',
  } as const
  const pin = 'payload-2026.11.21-crag-3.1.12'
  const upgradeButton = () =>
    state.buttons.find((entry) =>
      String(entry['aria-label'] || '').startsWith(
        '把全部 CRAG 槽位升级到锁定版本'
      )
    )

  it('is absent when the deployment pins nothing', () => {
    state.cragPin = null
    render(cragVm)
    expect(upgradeButton()).toBeUndefined()
  })

  it('names the pinned version, not the payload date', () => {
    // A payload tag reads payload-<date>-crag-<version>; showing 2026.11.21 as
    // the version is what a naive match produces.
    const html = render(cragVm)
    expect(html).toContain('升级到锁定版本 3.1.12')
    expect(html).not.toContain('升级到锁定版本 2026.11.21')
    expect(upgradeButton()?.['aria-label']).toBe(
      `把全部 CRAG 槽位升级到锁定版本 ${pin}`
    )
  })

  it('upgrades only the slots that are not already on the pin', async () => {
    state.installations = {
      'slot-b': {
        kernel: 'crag',
        version: '3.1.12',
        installed_at: 'x',
        payload_tag: pin,
      },
    }
    const others = [
      { ...cragVm, id: 'slot-b' },
      { ...cragVm, id: 'slot-c' },
    ] as Vm[]
    render(cragVm, others)
    const button = upgradeButton()
    expect(button?.disabled).toBe(false)
    button?.onClick?.({} as Parameters<NonNullable<ButtonProps['onClick']>>[0])
    render(cragVm, others)
    expect(state.confirm?.open).toBe(true)
    // slot-b is already pinned, so it is never stopped.
    expect(String(state.confirm?.title)).toContain('2 个 CRAG 槽位')
    state.confirm?.handleConfirm?.()
    await vi.waitFor(() => expect(updateCragTargets).toHaveBeenCalledTimes(2))
    expect(vi.mocked(updateCragTargets).mock.calls.flat(2)).toEqual([
      { id: 'slot-a', kernel: 'crag', payload_tag: pin },
      { id: 'slot-c', kernel: 'crag', payload_tag: pin },
    ])
    expect(installKernelTargets).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith(
      '2 个 CRAG 槽位已升级到锁定版本并重启'
    )
  })

  it('pulls the pinned payload before the first slot stops', async () => {
    render(cragVm)
    upgradeButton()?.onClick?.(
      {} as Parameters<NonNullable<ButtonProps['onClick']>>[0]
    )
    render(cragVm)
    state.confirm?.handleConfirm?.()
    await vi.waitFor(() => expect(updateCragTargets).toHaveBeenCalled())
    expect(pullKernelRelease).toHaveBeenCalledExactlyOnceWith({
      kernel: 'crag',
      latest: false,
    })
  })

  it('leaves every slot untouched when the pinned payload cannot be pulled', async () => {
    vi.mocked(pullKernelRelease).mockRejectedValueOnce(
      new Error('发布源没有该载荷')
    )
    render(cragVm)
    upgradeButton()?.onClick?.(
      {} as Parameters<NonNullable<ButtonProps['onClick']>>[0]
    )
    render(cragVm)
    state.confirm?.handleConfirm?.()
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(updateCragTargets).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('发布源没有该载荷', {
      description: '槽位未改动，请确认发布源后重试。',
    })
  })

  it('reports an already current fleet instead of restarting it', () => {
    state.installations = {
      'slot-a': {
        kernel: 'crag',
        version: '3.1.12',
        installed_at: 'x',
        payload_tag: pin,
      },
    }
    render(cragVm)
    upgradeButton()?.onClick?.(
      {} as Parameters<NonNullable<ButtonProps['onClick']>>[0]
    )
    render(cragVm)
    expect(state.confirm?.open).toBe(false)
    expect(updateCragTargets).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith(
      `1 个 CRAG 槽位已是锁定版本 3.1.12，无需升级`
    )
  })

  it('refuses a fleet that runs no CRAG slot', () => {
    render({ id: 'slot-a', resolved_dataplane: 'wrap' })
    upgradeButton()?.onClick?.(
      {} as Parameters<NonNullable<ButtonProps['onClick']>>[0]
    )
    render({ id: 'slot-a', resolved_dataplane: 'wrap' })
    expect(state.confirm?.open).toBe(false)
    expect(toast.error).toHaveBeenCalledWith('没有正在运行 CRAG 的槽位')
  })
})
