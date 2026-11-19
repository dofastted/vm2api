import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { credEndpointOf, credTypeOf } from '@/lib/cred-type'
import { poolQuota } from '@/lib/pool-quota'
import {
  hasSlotCredential,
  slotCredentialLabel,
  slotNameLabel,
} from '@/lib/vm-kind'
import {
  accountStatus,
  accountUsable,
  credentialStatus,
  fleetGroup,
  poolStatus,
} from '@/lib/vm-status'
import { CredentialPanel } from './credential-panel'
import { VmActionsContext, type VmActions } from './vm-actions-context'
import { VmBlade } from './vm-rack-blade'
import { bladeState } from './vm-rack-model'
import { VmUnit } from './vm-rack-unit'

const vm: Vm = {
  id: 'vm-g-01',
  platform: 'antigravity',
  family: 'antigravity',
  has_token: false,
  has_refresh: false,
  schedulable: false,
  can_import_credential: true,
  availability: { key: 'none', usable: false, text: '无凭证' },
  antigravity: {
    authenticated: true,
    credential_storage: 'slot-official-client',
  },
}
const noop = () => undefined
const actions: VmActions = {
  openDetail: noop,
  openTest: noop,
  openStats: noop,
  openReauth: noop,
  openRecovery: noop,
  refreshToken: noop,
  recover: noop,
  refreshingId: null,
  recoveringId: null,
}

function render(component: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['panel', 'me'], { role: 'admin' })
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <VmActionsContext.Provider value={actions}>
        {component}
      </VmActionsContext.Provider>
    </QueryClientProvider>
  )
  client.clear()
  return html
}

describe('Antigravity binding metadata from the server', () => {
  it('shows an official client login without fabricating a gateway token', () => {
    expect(hasSlotCredential(vm)).toBe(true)
    expect(slotCredentialLabel(vm)).toBe('已登录官方客户端')
    expect(slotNameLabel({ ...vm, id: 'vm-01' })).toBe('vm-01')
    expect(credTypeOf(vm)).toBe('oauth')
    expect(credEndpointOf(vm)).toBe('oauth')
    expect(accountStatus(vm).text).toBe('已登录官方客户端')
    expect(credentialStatus(vm).cls).toBe('ok')
    expect(bladeState(vm)).toBe('official')
    expect(vm.has_token).toBe(false)
  })

  it('shows API schedule intent without inventing token or quota windows', () => {
    expect(poolStatus(vm)).toMatchObject({ key: 'off', text: 'API 调度关' })
    expect(fleetGroup(vm)).toBe('off')
    expect(accountUsable(vm)).toBe(true)
    expect(poolQuota([vm])).toMatchObject({ eligible: 0, withToken: 0 })
    expect(
      poolStatus({ ...vm, schedulable: true, status: 'running' })
    ).toMatchObject({ key: 'ok' })
  })

  it('leaves unknown and signed-out clients unbound, even with stale token flags', () => {
    for (const authenticated of [false, null, undefined]) {
      const unbound = {
        ...vm,
        has_token: true,
        has_refresh: true,
        antigravity: { authenticated },
      }
      expect(hasSlotCredential(unbound)).toBe(false)
      expect(slotCredentialLabel(unbound)).toBe('空槽')
      expect(credTypeOf(unbound)).toBe('none')
      expect(bladeState(unbound)).toBe('vacant')
    }
  })

  it('preserves existing Claude and GPT token state', () => {
    for (const platform of ['anthropic', 'openai']) {
      expect(hasSlotCredential({ platform, has_token: true })).toBe(true)
      expect(
        hasSlotCredential({
          platform,
          has_token: false,
          antigravity: { authenticated: true },
        })
      ).toBe(false)
      expect(slotCredentialLabel({ platform, has_refresh: true })).toBe(
        '已导入账号 · 邮箱未知'
      )
    }
  })

  it('renders both rack sizes as logged in without a token refresh or empty-slot callout', () => {
    for (const component of [
      <VmBlade vm={vm} size='m' now={0} />,
      <VmUnit vm={vm} now={0} />,
    ]) {
      const html = render(component)
      expect(html).toContain('已登录官方客户端')
      expect(html).not.toContain('未绑定账号')
      expect(html).not.toContain('空槽')
      expect(html).not.toContain('刷新并探测')
    }
  })

  it('leaves OAuth available on an empty account and displays bound metadata on reopening', () => {
    const empty = { ...vm, antigravity: { authenticated: false } }
    const emptyHtml = render(<CredentialPanel vm={empty} />)
    expect(emptyHtml).toContain('生成授权链接')
    expect(emptyHtml).toContain('未绑定')
    const boundHtml = render(<CredentialPanel vm={vm} />)
    expect(boundHtml).toContain('已登录官方客户端')
    expect(boundHtml).toContain('生成授权链接')
  })
})
