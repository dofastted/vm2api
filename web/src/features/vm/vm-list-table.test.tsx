import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { VmTable } from './vm-list-table'

vi.mock('./vm-actions-context', () => ({ useVmActions: () => ({}) }))
vi.mock('./vm-action-menu', () => ({ VmActionMenu: () => null }))
vi.mock('./vm-owner-line', () => ({ VmOwnerLine: () => null }))
vi.mock('./use-vm-column-order', () => ({
  useVmColumnOrder: () => ({ order: ['vm'], isDefault: true }),
}))

function render(over: Partial<Vm> = {}) {
  return renderToStaticMarkup(
    <VmTable vms={[{ id: 'vm-01', email: 'account@example.com', ...over }]} />
  )
}

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

  it('shows platform, stable VM number, email and enrollment independently of the auth scheme', () => {
    const vm: Partial<Vm> = {
      has_token: true,
      auth_scheme: 'authorization_bearer',
      subscription_type: 'max',
      runtime_type: 'kvm',
      node_name: '测试集群',
    }
    const html = render(vm)
    for (const label of [
      'anthropic',
      'vm-01',
      '01·account',
      'account@example.com',
      'Max',
      'kvm',
      'oauth',
      '测试集群',
    ]) {
      expect(html).toMatch(new RegExp(`>${label}</(?:span|div)>`))
    }
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
      '>openai</span>'
    )
    expect(render({ platform: 'openai', has_token: true })).toContain(
      '>local</span>'
    )
  })
})
