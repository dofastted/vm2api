import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import {
  GeminiAuthorizationChallenge,
  GeminiEnvironments,
  type GeminiInventory,
} from './gemini-environments'

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
  expect(asAdmin).toContain('设置 → Gemini：诊断与维护')
  expect(asAdmin).not.toContain('创建 Gemini 环境')

  const asUser = showGemini(
    false,
    'import',
    'oauth',
    { host_message: '控制面无权访问 Gemini 控制 socket' },
    'user'
  )
  expect(asUser).toContain('控制面无权访问 Gemini 控制 socket')
  expect(asUser).toContain('请联系管理员在「设置 → Gemini」诊断与维护。')
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
})

test('Gemini import only displays eligible platform SOCKS5 and leaves inventory management to VM', () => {
  const html = showGemini(true)
  expect(html).toContain('不创建虚拟机')
  expect(html).toContain('兑换当前版本的 CRAGGemini 内核')
  expect(html).toContain('Gemini API Key')
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
