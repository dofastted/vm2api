import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ErrorCollectionSummary } from './error-collection-summary'

vi.mock('@/lib/log-mute', () => ({ resolveMutedClasses: () => ['rate'] }))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}))

describe('muted error collection wording', () => {
  it('keeps the empty message when the window has no errors', () => {
    const html = renderToStaticMarkup(
      <ErrorCollectionSummary collection={{ by_class: [] }} />
    )
    expect(html).toContain('该窗口无错误')
    expect(html).not.toContain('本摘要中的错误均来自已屏蔽的错误类')
  })

  it('states that every error belongs to a muted class', () => {
    const html = renderToStaticMarkup(
      <ErrorCollectionSummary
        collection={{
          by_class: [
            { id: 'rate', label: '限流', count: 2, owner: 'provider' },
          ],
        }}
      />
    )
    expect(html).toContain('本摘要中的错误均来自已屏蔽的错误类')
    expect(html).not.toContain('可见错误已全部屏蔽')
  })
})
