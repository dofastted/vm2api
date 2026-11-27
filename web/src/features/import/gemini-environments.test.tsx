import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import {
  GeminiAuthorizationChallenge,
  GeminiEnvironments,
  GeminiOperationError,
  type GeminiInventory,
} from './gemini-environments'
import {
  geminiProxyAddress,
  geminiProxyOptionLabel,
  isGeminiProxy,
} from './gemini-operations'
import { GeminiProxyPanel } from './gemini-proxy-panel'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: string }) => <a>{children}</a>,
}))

function showGemini(
  available: boolean,
  view: 'import' | 'vm' = 'import',
  kind: 'oauth' | 'api_key' = 'oauth',
  status: Partial<GeminiInventory> = {},
  role: 'admin' | 'user' = 'user'
) {
  const client = new QueryClient()
  client.setQueryData(['panel', 'me'], { role })
  client.setQueryData(['panel', 'gemini-environments'], {
    available,
    payload_state: 'awaiting_redemption',
    release_activated: false,
    ...status,
    environments: [
      {
        id: 'gemini-one',
        name: '宿主环境',
        proxy_id: 'px-one',
        auth_state: 'authorized',
        auth_method: kind,
        runtime_ready: false,
        billing_ready: false,
        kernel_version: '0.3.0-rc.1',
        models: ['gemini-3.1-pro'],
        account:
          kind === 'api_key'
            ? { state: 'ok', quotas: [], credits: [] }
            : {
                email: 'fixture@example.test',
                state: 'partial',
                project_id: 'fixture-project',
                plan: 'Google AI Pro',
                quotas: [{ model: 'gemini-3.1-pro', remaining_fraction: 0 }],
                quota_groups: [
                  {
                    name: 'Gemini Pro',
                    windows: [
                      {
                        id: 'gemini-5h',
                        period: '5h',
                        remaining_fraction: 0.25,
                        reset_at: '2030-01-01T05:00:00Z',
                      },
                      {
                        id: 'gemini-weekly',
                        period: 'weekly',
                        remaining_fraction: null,
                      },
                    ],
                  },
                ],
                credits: [{ type: 'AI', amount: '0' }],
              },
      },
    ],
  })
  client.setQueryData(['panel', 'gemini-egress-options'], {
    proxies: [
      {
        id: 'px-one',
        label: '允许的平台代理',
        enabled: true,
        status: 'ok',
        kind: 'socks5',
        address_family: 4,
      },
      {
        id: 'px-tenant',
        label: '租户代理',
        enabled: true,
        status: 'ok',
        kind: 'socks5',
        address_family: 4,
        owner_user_id: 'tenant',
      },
      {
        id: 'px-direct',
        label: '宿主直连',
        enabled: true,
        status: 'ok',
        kind: 'local',
      },
    ],
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GeminiEnvironments
        environmentId={view === 'vm' ? 'gemini-one' : undefined}
      />
    </QueryClientProvider>
  )
}

test('Gemini shows the socket failure without claiming the service is disabled', () => {
  // 补救手段已从「自己敲 systemctl」改成指向集中运维入口（`GeminiMaintenanceLink`），
  // 所以这里断言的是那个入口而不是旧的命令文案。两条分支都要钉住：管理员拿到可点的
  // 链接，普通用户拿到「找管理员」的说明——后者此前没有任何测试覆盖。
  const asAdmin = showGemini(
    false,
    'import',
    'oauth',
    { host_message: '控制面无权访问 Gemini 控制 socket' },
    'admin'
  )
  expect(asAdmin).toContain('控制面无权访问 Gemini 控制 socket')
  expect(asAdmin).toContain('设置 → Gemini 维护：诊断与维护')
  expect(asAdmin).not.toContain('创建 Gemini 环境')

  const asUser = showGemini(
    false,
    'import',
    'oauth',
    { host_message: '控制面无权访问 Gemini 控制 socket' },
    'user'
  )
  expect(asUser).toContain('控制面无权访问 Gemini 控制 socket')
  expect(asUser).toContain('请联系管理员在「设置 → Gemini 维护」诊断与维护。')
  expect(asUser).not.toContain('创建 Gemini 环境')
})

test('VM details distinguish missing Antigravity files from OAuth host prerequisites', () => {
  const html = showGemini(true, 'vm', 'oauth', {
    payload_state: 'not_configured',
    payload_issue: 'gemini_payload_incomplete',
    oauth_runtime_issue: 'gemini_egress_unavailable',
  })
  expect(html).toContain('Antigravity 签名载荷不完整')
  expect(html).toContain('宿主缺少可用的 kin-egress')
  expect(html).toContain('Antigravity 额度与使用分析')

  const apparmorHtml = showGemini(true, 'vm', 'oauth', {
    payload_state: 'installed',
    release_activated: true,
    oauth_runtime_issue: 'gemini_sandbox_apparmor_restricted',
  })
  expect(apparmorHtml).toContain('AppArmor 限制了非特权 user namespace')

  const sandboxHtml = showGemini(true, 'vm', 'oauth', {
    payload_state: 'installed',
    release_activated: true,
    oauth_runtime_issue: 'gemini_sandbox_unavailable',
  })
  expect(sandboxHtml).toContain('宿主机非特权沙箱（bwrap）不可用')
})

test('Gemini import only displays eligible platform SOCKS5 and leaves inventory management to VM', () => {
  const html = showGemini(true)
  expect(html).toContain('不创建虚拟机')
  expect(html).toContain('兑换当前版本的 CRAGGemini 内核')
  expect(html).toContain('Gemini API Key')
  expect(html).toContain('导入账号 JSON / Refresh Token')
  expect(html).toContain('允许的平台代理')
  expect(html).not.toContain('租户代理')
  expect(html).not.toContain('宿主直连')
  expect(html).not.toContain('fixture@example.test')
})

test('VM page renders Gemini inventory and measured data without treating the host as a VM slot', () => {
  const html = showGemini(true, 'vm')
  expect(html).toContain('Gemini 宿主环境')
  expect(html).toContain('fixture@example.test')
  expect(html).toContain('fixture-project')
  expect(html).toContain('Google AI Pro')
  expect(html).toContain('gemini-3.1-pro')
  expect(html).toContain('0%')
  expect(html).toContain('AI: 0')
  expect(html).toContain('部分数据未返回')
  expect(html).toContain('刷新数据')
  expect(html).not.toContain('创建 Gemini 环境')
})

test('VM details separate official pool utilization, absent values and unavailable local usage', () => {
  const html = showGemini(true, 'vm')
  expect(html).toContain('Antigravity 额度与使用分析')
  expect(html).toContain('Gemini Pro')
  expect(html).toContain('5 小时')
  expect(html).toContain('已用 75% · 剩余 25%')
  expect(html).toContain('每周')
  expect(html).toContain('未提供比例')
  expect(html).toContain('已用 100% · 剩余 0%')
  expect(html).toContain('本地逐回合用量尚不可用')
})

test('Gemini API key does not claim to expose Antigravity subscription quota', () => {
  const html = showGemini(true, 'vm', 'api_key')
  expect(html).toContain('Gemini API Key 不提供 Antigravity 订阅额度')
  expect(html).not.toContain('已用 0%')
})

test('CRAGGemini subscription mode renders subscription status and seat bind/release controls', () => {
  const unboundClient = new QueryClient()
  unboundClient.setQueryData(['panel', 'me'], { role: 'admin' })
  unboundClient.setQueryData(['panel', 'gemini-environments'], {
    available: true,
    payload_state: 'installed',
    payload_mode: 'crag_subscription',
    release_activated: true,
    crag_subscription: {
      configured: true,
      active: true,
      product: 'craggemini',
      host_id: 'host-1',
      sync_pending: false,
      version: 2,
      revision: 2,
      issued_at: 1_800_000_000,
      expires_at: 1_803_000_000,
      slot_limit: 2,
      used_slots: 1,
      available_slots: 1,
      reclaim_supported: true,
    },
    environments: [
      {
        id: 'gemini-unbound',
        name: '未绑席位',
        proxy_id: 'px-one',
        auth_state: 'authorized',
        auth_method: 'oauth',
        runtime_ready: false,
        billing_ready: false,
        kernel_version: '0.3.0',
        models: ['gemini-3-flash'],
        models_discovered: true,
        crag_license: {
          product: 'craggemini',
          status: 'unlicensed',
          valid: false,
          seat_required: true,
          code: 'license_required',
        },
        account: null,
      },
      {
        id: 'gemini-bound',
        name: '已绑席位',
        proxy_id: 'px-one',
        auth_state: 'authorized',
        auth_method: 'oauth',
        runtime_ready: false,
        billing_ready: false,
        kernel_version: '0.3.0',
        models: ['gemini-3-flash'],
        models_discovered: true,
        crag_license: {
          product: 'craggemini',
          status: 'valid',
          valid: true,
          seat_required: true,
          scope: 'host',
          seat: 1,
        },
        account: null,
      },
    ],
  })
  const unboundHtml = renderToStaticMarkup(
    <QueryClientProvider client={unboundClient}>
      <GeminiEnvironments environmentId='gemini-unbound' />
    </QueryClientProvider>
  )
  expect(unboundHtml).toContain('CRAGGemini 宿主订阅已激活')
  expect(unboundHtml).toContain('未绑定 CRAGGemini 订阅席位')
  expect(unboundHtml).toContain('绑定 CRAG 席位')

  const boundHtml = renderToStaticMarkup(
    <QueryClientProvider client={unboundClient}>
      <GeminiEnvironments environmentId='gemini-bound' />
    </QueryClientProvider>
  )
  expect(boundHtml).toContain('已绑定席位 #1')
  expect(boundHtml).toContain('释放 CRAG 席位')

  const syncPendingClient = new QueryClient()
  syncPendingClient.setQueryData(['panel', 'me'], { role: 'admin' })
  syncPendingClient.setQueryData(['panel', 'gemini-environments'], {
    available: true,
    payload_state: 'installed',
    payload_mode: 'crag_subscription',
    release_activated: true,
    crag_subscription: {
      configured: true,
      active: false,
      product: 'craggemini',
      host_id: 'host-1',
      sync_pending: true,
      version: 2,
      revision: 2,
      issued_at: 1_800_000_000,
      expires_at: 1_803_000_000,
      slot_limit: 2,
      used_slots: 1,
      available_slots: 0,
      reclaim_supported: true,
    },
    environments: [
      {
        id: 'gemini-mismatch',
        name: '载荷换签',
        proxy_id: 'px-one',
        auth_state: 'authorized',
        auth_method: 'oauth',
        runtime_ready: false,
        billing_ready: false,
        kernel_version: '0.4.10',
        models: ['gemini-3-flash'],
        models_discovered: true,
        crag_license: {
          product: 'craggemini',
          status: 'invalid',
          valid: false,
          seat_required: true,
          code: 'license_payload_key_mismatch',
        },
        account: null,
      },
    ],
  })
  const syncPendingHtml = renderToStaticMarkup(
    <QueryClientProvider client={syncPendingClient}>
      <GeminiEnvironments environmentId='gemini-mismatch' />
    </QueryClientProvider>
  )
  expect(syncPendingHtml).toContain('CRAGGemini 宿主订阅正在同步上次变更')
  expect(syncPendingHtml).toContain('继续同步订阅')
  expect(syncPendingHtml).toContain('CRAGGemini 许可与当前载荷版本不匹配')
  expect(syncPendingHtml).toContain('重新绑定 CRAG 席位')
  expect(syncPendingHtml).not.toContain('CRAGGemini 宿主订阅未激活')
})

test('CRAG host resource exhaustion does not offer seat rebind', () => {
  const client = new QueryClient()
  client.setQueryData(['panel', 'me'], { role: 'admin' })
  client.setQueryData(['panel', 'gemini-environments'], {
    available: true,
    payload_state: 'installed',
    payload_mode: 'crag_subscription',
    release_activated: true,
    crag_subscription: {
      configured: true,
      active: true,
      product: 'craggemini',
      host_id: 'host-1',
      sync_pending: false,
      version: 2,
      revision: 2,
      issued_at: 1_800_000_000,
      expires_at: 1_803_000_000,
      slot_limit: 2,
      used_slots: 1,
      available_slots: 1,
      reclaim_supported: true,
    },
    environments: [
      {
        id: 'gemini-emfile',
        name: 'FD 耗尽',
        proxy_id: 'px-one',
        auth_state: 'authorized',
        auth_method: 'oauth',
        runtime_ready: false,
        billing_ready: false,
        kernel_version: '0.4.10',
        models: ['gemini-3-flash'],
        models_discovered: true,
        crag_license: {
          product: 'craggemini',
          status: 'host_resource_exhausted',
          valid: false,
          seat_required: true,
          code: 'gemini_host_resource_exhausted',
        },
        account: null,
      },
    ],
  })
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GeminiEnvironments environmentId='gemini-emfile' />
    </QueryClientProvider>
  )
  expect(html).toContain('宿主机文件描述符耗尽')
  expect(html).not.toContain('重新绑定 CRAG 席位')
  expect(html).not.toContain('绑定 CRAG 席位')
})

test('Gemini authorization challenge exposes copyable link alongside open action', () => {
  const url =
    'https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&code_challenge_method=S256&state=s1&code_challenge=c1'
  const html = renderToStaticMarkup(
    <GeminiAuthorizationChallenge
      environmentId='gemini-one'
      url={url}
      code=''
      busy={false}
      onCodeChange={() => {}}
      onSubmit={() => {}}
    />
  )
  expect(html).toContain('Google 授权链接')
  expect(html).toContain('复制链接')
  expect(html).toContain('打开 Google 授权页')
  expect(html).toContain('readOnly=""')
  expect(html).toContain('accounts.google.com/o/oauth2/auth')
  expect(html).toContain('target="_blank"')
  expect(html).toContain('rel="noreferrer"')
})

test('GeminiOperationError renders remediation guidance and maintenance link for host launch failures', () => {
  const client = new QueryClient()
  client.setQueryData(['panel', 'me'], { role: 'admin' })
  const authLaunchHtml = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GeminiOperationError
        error={
          new ApiError(
            'Gemini 宿主服务在线，但 Google 授权流程未能启动，请检查宿主服务日志与绑定代理的出口连通性',
            503,
            'gemini_authorization_unavailable'
          )
        }
      />
    </QueryClientProvider>
  )
  expect(authLaunchHtml).toContain('未能拉起授权进程')
  expect(authLaunchHtml).toContain('设置 → Gemini 维护：诊断与维护')

  const apiKeyHtml = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GeminiOperationError
        error={
          new ApiError(
            'Google 未接受该 Gemini API Key，请检查密钥和项目权限',
            400,
            'gemini_api_key_rejected'
          )
        }
      />
    </QueryClientProvider>
  )
  expect(apiKeyHtml).toContain('Google AI Studio 核对 API Key 有效性')
  expect(apiKeyHtml).not.toContain('设置 → Gemini 维护：诊断与维护')
})

test('geminiProxyOptionLabel displays IP/host, distinct exit IP, region, latency, and falls back safely', () => {
  const base = {
    enabled: true,
    status: 'ok',
    kind: 'socks5',
    address_family: 4,
  }
  expect(geminiProxyAddress({ host: '45.67.89.10', port: 1080 })).toBe(
    '45.67.89.10:1080'
  )
  expect(geminiProxyAddress({ host: '2001:db8::1', port: 1080 })).toBe(
    '[2001:db8::1]:1080'
  )
  expect(geminiProxyAddress({})).toBeNull()

  // Unlabeled direct IPv4 proxy shows IP:port instead of bare px-xxxx
  expect(
    geminiProxyOptionLabel({
      ...base,
      id: 'px-4a07ab03',
      label: null,
      host: '45.67.89.10',
      port: 1080,
    })
  ).toBe('45.67.89.10:1080 · px-4a07ab03')

  // Direct IPv4 with matching geo.ip avoids duplicating IP while showing region and latency
  expect(
    geminiProxyOptionLabel({
      ...base,
      id: 'px-4a07ab03',
      label: null,
      host: '45.67.89.10',
      port: 1080,
      geo: { ip: '45.67.89.10', country_code: 'US' },
      latency_ms: 82,
    })
  ).toBe('45.67.89.10:1080 · US · 82ms · px-4a07ab03')

  // Relay/domain proxy shows both host:port and probed exit IP
  expect(
    geminiProxyOptionLabel({
      ...base,
      id: 'px-relay',
      label: '美国住宅',
      host: 'us.relay.example',
      port: 10800,
      geo: { ip: '203.0.113.45', country_code: 'US' },
      latency_ms: 115,
    })
  ).toBe(
    '美国住宅 · us.relay.example:10800 · 出口 203.0.113.45 · US · 115ms · px-relay'
  )

  // Minimal fallback without host never emits ?:?
  expect(
    geminiProxyOptionLabel({
      ...base,
      id: 'px-bare',
    })
  ).toBe('px-bare')
})

test('Gemini import selector and proxy panel render proxy IP and exit IP for unlabeled proxies', () => {
  const client = new QueryClient()
  client.setQueryData(['panel', 'me'], { role: 'admin' })
  client.setQueryData(['panel', 'gemini-environments'], {
    available: true,
    payload_state: 'installed',
    environments: [
      {
        id: 'gemini-ip',
        name: 'Gemini IP',
        proxy_id: 'px-4a07ab03',
        proxy_ready: true,
        auth_method: 'oauth',
        auth_state: 'authorized',
        schedulable: true,
        models_discovered: false,
        models: [],
      },
    ],
  })
  client.setQueryData(['panel', 'gemini-egress-options'], {
    proxies: [
      {
        id: 'px-4a07ab03',
        label: null,
        host: '45.67.89.10',
        port: 1080,
        geo: { ip: '203.0.113.45', country_code: 'US' },
        latency_ms: 68,
        enabled: true,
        status: 'ok',
        kind: 'socks5',
        address_family: 4,
      },
      {
        id: 'px-a49903b0',
        label: null,
        host: '198.51.100.22',
        port: 1080,
        enabled: true,
        status: 'ok',
        kind: 'socks5',
        address_family: 4,
      },
    ],
  })

  const importHtml = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GeminiEnvironments />
    </QueryClientProvider>
  )
  expect(importHtml).toContain(
    '45.67.89.10:1080 · 出口 203.0.113.45 · US · 68ms · px-4a07ab03'
  )
  expect(importHtml).toContain('198.51.100.22:1080 · px-a49903b0')

  const vmHtml = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GeminiEnvironments environmentId='gemini-ip' />
    </QueryClientProvider>
  )
  expect(vmHtml).toContain(
    '45.67.89.10:1080 · 出口 203.0.113.45 · US · 68ms · px-4a07ab03'
  )

  const proxyPanelHtml = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <GeminiProxyPanel
        environment={{
          id: 'gemini-ip',
          name: 'Gemini IP',
          proxy_id: 'px-4a07ab03',
          proxy_ready: true,
          auth_method: 'oauth',
          auth_state: 'authorized',
          runtime_ready: true,
          billing_ready: true,
          kernel_version: '0.4.7',
          created_at: null,
          updated_at: null,
          schedulable: true,
          models_discovered: false,
          models: [],
          account: null,
        }}
        active
      />
    </QueryClientProvider>
  )
  expect(proxyPanelHtml).toContain('代理地址')
  expect(proxyPanelHtml).toContain('45.67.89.10:1080')
  expect(proxyPanelHtml).toContain('出口 IP')
  expect(proxyPanelHtml).toContain('203.0.113.45')
})

test('isGeminiProxy accepts HTTP and domain proxies while rejecting local and IPv6', () => {
  expect(
    isGeminiProxy({
      id: 'px-socks4',
      enabled: true,
      kind: 'socks5',
      address_family: 4,
      status: 'ok',
    })
  ).toBe(true)
  expect(
    isGeminiProxy({
      id: 'px-http',
      enabled: true,
      kind: 'http',
      address_family: 4,
      status: 'ok',
    })
  ).toBe(true)
  expect(
    isGeminiProxy({
      id: 'px-domain',
      enabled: true,
      kind: 'socks5',
      address_family: null,
      status: 'ok',
    })
  ).toBe(true)
  expect(
    isGeminiProxy({
      id: 'px-v6',
      enabled: true,
      kind: 'socks5',
      address_family: 6,
      status: 'ok',
    })
  ).toBe(false)
  expect(
    isGeminiProxy({
      id: 'px-local',
      enabled: true,
      kind: 'local',
      address_family: null,
      status: 'ok',
    })
  ).toBe(false)
  expect(
    isGeminiProxy({
      id: 'px-fail',
      enabled: true,
      kind: 'http',
      address_family: 4,
      status: 'fail',
    })
  ).toBe(false)
})
