import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ErrorCollectionSummary } from './error-collection-summary'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}))

describe('error collection availability wording', () => {
  it('keeps the empty message for a confirmed empty collection', () => {
    const html = renderToStaticMarkup(
      <ErrorCollectionSummary collection={{ by_class: [] }} />
    )
    expect(html).toContain('该窗口无错误')
    expect(html).not.toContain('错误统计暂不可用')
  })

  it('does not claim there are no errors when the collection is missing', () => {
    const html = renderToStaticMarkup(
      <ErrorCollectionSummary collection={undefined} />
    )
    expect(html).toContain('错误统计暂不可用')
    expect(html).not.toContain('该窗口无错误')
  })
})
