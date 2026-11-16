import { type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { VmTable } from './vm-list-table'
import { VmSchedulingBlock, VmSchedulingEditor } from './vm-scheduling'

vi.mock('./vm-actions-context', () => ({ useVmActions: () => ({}) }))
vi.mock('./vm-action-menu', () => ({ VmActionMenu: () => null }))
vi.mock('./vm-owner-line', () => ({ VmRentedMark: () => null }))
vi.mock('./vm-perms', () => ({ useVmPerms: () => ({ admin: false }) }))
vi.mock('./use-vm-column-order', () => ({
  useVmColumnOrder: () => ({ order: ['vm', 'type'], isDefault: true }),
}))
vi.mock('@/components/ui/dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/dialog')>()),
  DialogContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

function render(over: Partial<Vm> = {}) {
  return renderToStaticMarkup(
    <VmTable vms={[{ id: 'vm-01', email: 'account@example.com', ...over }]} />
  )
}

describe('VM scheduling priority', () => {
  it.each(['anthropic', 'openai'] as const)(
    'shows and edits the same %s priority throughout the panel',
    (platform) => {
      const vm: Vm = {
        id: 'vm-01',
        platform,
        schedule_level: 8,
        schedule_level_mode: 'manual',
        weight: 42,
      }
      const list = render(vm)
      expect(list).toContain('>调度优先级</')
      expect(list).toContain(
        '>调度优先级 <span class="font-semibold tabular-nums text-blue-800 dark:text-blue-200">8</span>'
      )
      expect(list).not.toMatch(/background-color:[^";]+[^>]*>调度优先级/)
      expect(list).not.toMatch(/等级|权重/)

      const detail = renderToStaticMarkup(<VmSchedulingBlock vm={vm} />)
      expect(detail).toContain('>调度优先级</span>')
      expect(detail).toContain('>8 · 手动</span>')

      const editor = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <VmSchedulingEditor vm={vm} />
        </QueryClientProvider>
      )
      expect(editor).toContain('role="radiogroup" aria-label="调度优先级"')
      expect(editor).toMatch(/role="radio" aria-checked="true"[^>]*>8</)
    }
  )

  it('does not substitute legacy weight when priority is missing', () => {
    expect(render({ weight: 4 })).toContain(
      '>调度优先级 <span class="font-semibold tabular-nums text-muted-foreground">—</span>'
    )
  })
})

describe('VM account column kernel label', () => {
  it.each(['wrap', 'cc'] as const)(
    'renders %s as a silver standard kernel',
    (dataplane) => {
      const html = render({ resolved_dataplane: dataplane })
      expect(html).toMatch(/class="[^"]*bg-zinc-200[^"]*"[^>]*>默认<\/span>/)
      expect(html).not.toContain('>crag</span>')
      expect(html).toContain('account@example.com')
    }
  )

  it.each(['legacy', 'v2'] as const)(
    'renders CRAG %s as orange crag',
    (version) => {
      const html = render({
        resolved_dataplane: 'crag',
        resolved_crag_kernel_version: version,
      })
      expect(html).toMatch(/class="[^"]*bg-orange-200[^"]*"[^>]*>crag<\/span>/)
      expect(html).not.toContain('>默认</span>')
    }
  )

  it('uses the resolved route instead of the configured override', () => {
    expect(render({ dataplane: 'wrap', resolved_dataplane: 'crag' })).toContain(
      '>crag</span>'
    )
    expect(render({ dataplane: 'crag', resolved_dataplane: 'wrap' })).toContain(
      '>默认</span>'
    )
  })

  it('supports older responses without a resolved route', () => {
    expect(render({ dataplane: 'crag' })).toContain('>crag</span>')
    expect(render()).toContain('>默认</span>')
  })

  it('shows the platform mark, stable VM number, email and enrollment independently of the auth scheme', () => {
    const vm: Partial<Vm> = {
      has_token: true,
      auth_scheme: 'authorization_bearer',
      subscription_type: 'max',
      runtime_type: 'kvm',
      node_name: '测试集群',
    }
    const html = render(vm)
    expect(html).toContain('aria-label="anthropic"')
    for (const label of [
      'vm-01',
      'account@example.com',
      'Max',
      'kvm',
      'oauth',
      '测试集群',
    ]) {
      expect(html).toMatch(new RegExp(`>${label}</(?:span|div)>`))
    }
    expect(html).not.toContain('订阅 未知')
    expect(html).not.toContain('01·account')
    expect(
      render({
        ...vm,
        credential_mode: 'setup-token',
        oauth_registration: 'oauth',
      })
    ).toContain('>oauth</span>')
    expect(
      render({
        ...vm,
        credential_mode: 'setup-token',
        oauth_registration: 'console',
      })
    ).toContain('>console</span>')
    expect(render({ platform: 'openai', has_token: true })).toContain(
      'aria-label="openai"'
    )
    expect(render({ platform: 'openai', has_token: true })).toContain(
      '>local</span>'
    )
  })
})
