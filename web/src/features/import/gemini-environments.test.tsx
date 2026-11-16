import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { GeminiEnvironments } from './gemini-environments'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: string }) => <a>{children}</a>,
}))

function showGemini(available: boolean, view: 'import' | 'vm' = 'import') {
  const client = new QueryClient()
  client.setQueryData(['panel', 'gemini-environments'], {
    available,
    payload_state: 'install_on_create',
    environments: [
      {
        id: 'gemini-one',
        name: '宿主环境',
        proxy_id: 'px-one',
        auth_state: 'authorized',
        auth_method: 'oauth',
        runtime_ready: false,
        billing_ready: false,
        kernel_version: '0.3.0-rc.1',
        models: ['gemini-3.1-pro'],
        account: {
          email: 'fixture@example.test',
          state: 'partial',
          project_id: 'fixture-project',
          plan: 'Google AI Pro',
          quotas: [{ model: 'gemini-3.1-pro', remaining_fraction: 0 }],
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
      <GeminiEnvironments view={view} />
    </QueryClientProvider>
  )
}

test('Gemini is unavailable without the separate host service', () => {
  const html = showGemini(false)
  expect(html).toContain('尚未启用 Gemini')
  expect(html).not.toContain('创建 Gemini 环境')
})

test('Gemini import displays only platform SOCKS5 and separates authorization from paid readiness', () => {
  const html = showGemini(true)
  expect(html).toContain('不创建虚拟机')
  expect(html).toContain('首次创建时自动校验并安装')
  expect(html).toContain('Gemini API Key')
  expect(html).toContain('允许的平台代理')
  expect(html).not.toContain('租户代理')
  expect(html).not.toContain('宿主直连')
  expect(html).toContain('已授权')
  expect(html).toContain('运行未就绪')
  expect(html).toContain('官方计费未核实')
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
