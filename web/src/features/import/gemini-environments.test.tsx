import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { GeminiEnvironments, type GeminiInventory } from './gemini-environments'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: string }) => <a>{children}</a>,
}))

function showGemini(
  available: boolean,
  view: 'import' | 'vm' = 'import',
  kind: 'oauth' | 'api_key' = 'oauth',
  status: Partial<GeminiInventory> = {}
) {
  const client = new QueryClient()
  client.setQueryData(['panel', 'gemini-environments'], {
    available,
    payload_state: 'install_on_create',
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
  const html = showGemini(false, 'import', 'oauth', {
    host_message: '控制面无权访问 Gemini 控制 socket',
  })
  expect(html).toContain('控制面无权访问 Gemini 控制 socket')
  expect(html).toContain('systemctl status vm2api-gemini')
  expect(html).not.toContain('创建 Gemini 环境')
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
  expect(html).toContain('首次创建时自动校验并安装')
  expect(html).toContain('Gemini API Key')
  expect(html).toContain('允许的平台代理')
  expect(html).not.toContain('租户代理')
  expect(html).not.toContain('宿主直连')
  expect(html).not.toContain('fixture@example.test')
})

test('VM page renders Gemini inventory and measured data without treating the host as a VM slot', () => {
  const html = showGemini(true, 'vm')
  expect(html).toContain('Gemini 宿主环境')
  expect(html).toContain('已授权')
  expect(html).toContain('当前载荷未启用推理')
  expect(html).toContain('缺少官方逐回合结算')
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
