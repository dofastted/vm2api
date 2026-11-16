import type { ComponentProps, ReactNode } from 'react'
import type { CragLicenseStatus, Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CragHostStatus } from '@/features/vm/queries'
import { WrapSamplePage } from './index'
import { installKernelTargets, type KernelInstallation } from './queries'

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
            ],
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
}))

function render(vm: Partial<Vm> = {}) {
  state.cursor = 0
  state.buttons.length = 0
  state.confirm = undefined
  state.vms = [
    { id: 'vm-old', resolved_dataplane: 'wrap', runtime_type: 'kvm', ...vm },
  ]
  return renderToStaticMarkup(<WrapSamplePage />)
}

beforeEach(() => {
  state.installations = {}
  state.licenses = {}
  state.installLicenses = undefined
  state.role = 'admin'
  state.host = undefined
  state.hostError = false
  state.hostEnabled = false
  state.hostInterval = undefined
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

it.each(['license_required', 'license_payload_key_mismatch'])(
  'does not gate installation or recommend reissue based on the cached %s hint',
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
    expect(html).toMatch(/剩余可用槽位：(?:<!-- -->)?0/)
    expect(html).not.toContain('可用运行名额')
    expect(html).toContain('已暂停宿主机 CRAG 调用')
    expect(html).toContain('兑换槽位')
    expect(html).toContain('服役中 / 暂不可用')
    expect(html).toContain('版本 3.0.8 · 处理中 0 · 排队 0 · 就绪处理槽 0')

    state.role = 'user'
    const userHtml = render()
    expect(userHtml).not.toContain('剩余可用槽位')
    expect(userHtml).not.toContain('服役中 / 暂不可用')
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
    expect(html).toMatch(/剩余可用槽位：(?:<!-- -->)?待核对/)
    expect(html).toContain('CRAG：运行状态未知')

    state.hostError = true
    const errorHtml = render(cragVm)
    expect(errorHtml).toContain('重装 vm-old 的 CRAG 并重启')
    expect(errorHtml).toContain('CRAG：运行状态未知')
    expect(errorHtml).toMatch(/剩余可用槽位：(?:<!-- -->)?待核对/)
  })
})
