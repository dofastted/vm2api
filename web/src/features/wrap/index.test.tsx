import type { ReactNode } from 'react'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WrapSamplePage } from './index'
import type { KernelInstallation } from './queries'

const state = vi.hoisted(() => ({
  vms: [] as Vm[],
  installations: {} as Record<string, KernelInstallation>,
  role: 'admin',
}))

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ isPending: false }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey.includes('kernels')
      ? { kernels: [], licenses: {}, installations: state.installations }
      : queryKey.includes('dashboard')
        ? { vms: state.vms }
        : { role: state.role },
    isLoading: false,
  }),
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
