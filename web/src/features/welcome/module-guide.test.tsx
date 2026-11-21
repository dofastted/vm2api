import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WelcomeModuleGuide } from './module-guide'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: string }) => (
    <a href={to}>{children}</a>
  ),
}))

describe('API module guide', () => {
  it('points API to upstream channels and keeps client keys separate', () => {
    const html = renderToStaticMarkup(<WelcomeModuleGuide views={null} />)

    expect(html).toContain('href="/api"')
    expect(html).toContain('配置 Anthropic 与 OpenAI 的上游 API 渠道。')
    expect(html).toContain('客户端密钥本身在密钥页。')
    expect(html).not.toContain('href="/anthropic"')
    expect(html).not.toContain('直接调用 Anthropic Messages')
  })
})
