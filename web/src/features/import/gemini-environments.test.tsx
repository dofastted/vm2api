import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { GeminiEnvironments } from './gemini-environments'

function showGemini(available: boolean) {
  const client = new QueryClient()
  client.setQueryData(['panel', 'gemini-environments'], {
    available,
    environments: [
      {
        id: 'gemini-one',
        name: '宿主环境',
        proxy_id: 'px-one',
        auth_state: 'authorized',
        runtime_ready: false,
        billing_ready: false,
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
      <GeminiEnvironments />
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
  expect(html).toContain('允许的平台代理')
  expect(html).not.toContain('租户代理')
  expect(html).not.toContain('宿主直连')
  expect(html).toContain('已授权')
  expect(html).toContain('运行未就绪')
  expect(html).toContain('官方计费未核实')
})
