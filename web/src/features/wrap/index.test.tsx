import type { ReactNode } from 'react'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CragHostStatus } from '@/features/vm/queries'
import { WrapSamplePage } from './index'
import type { KernelInstallation } from './queries'

const state = vi.hoisted(() => ({
  vms: [] as Vm[],
  installations: {} as Record<string, KernelInstallation>,
  role: 'admin',
  host: undefined as CragHostStatus | undefined,
  hostError: false,
  hostEnabled: false,
  hostInterval: undefined as number | false | undefined,
}))

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
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
              { id: 'crag', paid: true, ready: true, version: '3.0.8' },
            ],
            licenses: {},
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
vi.mock('@/components/confirm-dialog', () => ({ ConfirmDialog: () => null }))

function render(vm: Partial<Vm> = {}) {
  state.vms = [
    { id: 'vm-old', resolved_dataplane: 'wrap', runtime_type: 'kvm', ...vm },
  ]
  return renderToStaticMarkup(<WrapSamplePage />)
}

beforeEach(() => {
  state.installations = {}
  state.role = 'admin'
  state.host = undefined
  state.hostError = false
  state.hostEnabled = false
  state.hostInterval = undefined
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
  it('shows signed slots, runtime capacity and live details independent of the selected kernel', () => {
    state.host = {
      ready: true,
      state: 'active',
      slot_limit: 1,
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
    expect(html).toMatch(/已兑换槽位<\/dt><dd[^>]*>1<\/dd>/)
    expect(html).toMatch(/宿主机服役<\/dt><dd[^>]*>2<\/dd>/)
    expect(html).toMatch(/可用运行名额<\/dt><dd[^>]*>0<\/dd>/)
    expect(html).toMatch(/CRAG 服役 \/ 可用<\/dt><dd[^>]*>3 \/ 1<\/dd>/)
    expect(html).toContain('已暂停宿主机 CRAG 调用')
    expect(html).toContain('运行状态 1 台')
    expect(html).toContain('兑换槽位')
    expect(html).toContain('服役中 / 暂不可用')
    expect(html).toContain('版本 3.0.8 · 处理中 0 · 排队 0 · 就绪处理槽 0')

    state.role = 'user'
    const userHtml = render()
    expect(userHtml).not.toContain('宿主机服役')
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
    expect(html).toMatch(/可用运行名额<\/dt><dd[^>]*>待核对<\/dd>/)
    expect(html).toContain('CRAG：运行状态未知')

    state.hostError = true
    const errorHtml = render(cragVm)
    expect(errorHtml).toContain('重装 vm-old 的 CRAG 并重启')
    expect(errorHtml).toContain('CRAG：运行状态未知')
    expect(errorHtml).toMatch(/已兑换槽位<\/dt><dd[^>]*>待核对<\/dd>/)
  })
})
