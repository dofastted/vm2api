import type { ComponentProps } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AntigravityCredentialContent } from './antigravity-credential-panel'
import type { AntigravityOAuthSession } from './antigravity-oauth'
import { CredentialPanel } from './credential-panel'

const now = Date.parse('2026-10-21T10:00:00.000Z')
const awaiting: AntigravityOAuthSession = {
  session_id: 'login-1',
  status: 'awaiting_code',
  authenticated: false,
  auth_url:
    'https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=abc&code_challenge=challenge',
  expires_at: '2026-10-21T10:05:00.000Z',
}
const noop = () => undefined
function render(
  props: Partial<ComponentProps<typeof AntigravityCredentialContent>> = {}
) {
  return renderToStaticMarkup(
    <AntigravityCredentialContent
      session={null}
      code=''
      now={now}
      action=''
      failure=''
      canAuthorize
      permissionKnown
      bound={false}
      email=''
      refreshing={false}
      onCodeChange={noop}
      onStart={noop}
      onComplete={noop}
      onCancel={noop}
      onRefresh={noop}
      {...props}
    />
  )
}
function button(html: string, label: string) {
  return (
    [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(([markup]) =>
      markup.includes(label)
    )?.[0] || ''
  )
}

describe('Antigravity credential UI', () => {
  it('shows the dedicated OAuth surface from the shared credential entry point', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(['panel', 'me'], { role: 'admin' })
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <CredentialPanel
          vm={{ id: 'vm-g-01', platform: 'antigravity', family: 'antigravity' }}
        />
      </QueryClientProvider>
    )
    expect(html).toContain('Antigravity OAuth')
    expect(html).toContain('生成授权链接')
    expect(html).not.toContain('纯文本测试')
    expect(html).not.toContain('平台设置')
    expect(html).not.toContain('保存平台配置')
    client.clear()
  })

  it('waits for the official client before showing a link and code input', () => {
    const html = render({
      session: { ...awaiting, status: 'starting', auth_url: null },
    })
    expect(html).toContain('正在启动官方客户端')
    expect(html).not.toContain('打开授权页')
    expect(html).not.toContain('<input')
    expect(html).toContain('取消授权')
    expect(html).toContain('刷新授权状态')
  })

  it('offers the browser URL, countdown and single-line code submission', () => {
    const html = render({ session: awaiting, code: 'authorization-code' })
    expect(html).toContain(
      `href="${awaiting.auth_url!.replace(/&/g, '&amp;')}"`
    )
    expect(html).toContain('target="_blank"')
    expect(html).toContain('剩余 5:00')
    expect(html).toContain('<input')
    expect(html).not.toContain('<textarea')
    expect(button(html, '提交授权码')).not.toContain(' disabled=""')
  })

  it('prevents empty, multi-line, verifying and expired code submissions', () => {
    expect(button(render({ session: awaiting }), '提交授权码')).toContain(
      ' disabled=""'
    )
    expect(
      button(render({ session: awaiting, code: 'first\nsecond' }), '提交授权码')
    ).toContain(' disabled=""')
    const verifying = render({
      session: { ...awaiting, status: 'verifying' },
      code: 'code',
    })
    expect(button(verifying, '提交授权码')).toContain(' disabled=""')
    const expired = render({
      session: awaiting,
      now: now + 300_000,
      code: 'code',
    })
    expect(expired).toContain('授权会话已过期')
    expect(expired).not.toContain('提交授权码')
    expect(expired).not.toContain('打开授权页')
    expect(expired).toContain('重新生成授权链接')
  })

  it('shows recovery for failure and cancellation without claiming success', () => {
    const failed = render({
      session: { ...awaiting, status: 'failed', error: '客户端登录失败' },
    })
    expect(failed).toContain('客户端登录失败')
    expect(failed).toContain('重新生成授权链接')
    expect(failed).not.toContain('OAuth 已完成')
    const cancelled = render({ session: { ...awaiting, status: 'cancelled' } })
    expect(cancelled).toContain('已取消本次授权')
    expect(cancelled).not.toContain('取消授权')
  })

  it('hides mutation controls for read-only and unknown roles', () => {
    for (const permissionKnown of [false, true]) {
      const html = render({
        canAuthorize: false,
        permissionKnown,
        bound: true,
        email: 'account@example.com',
      })
      expect(html).toContain('已登录官方客户端')
      expect(html).toContain('account@example.com')
      expect(html).not.toContain('<button')
      expect(html).not.toContain('<input')
    }
  })
})
