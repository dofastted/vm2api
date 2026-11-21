import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { GeneralError } from './general-error'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { go: vi.fn() } }),
}))

describe('GeneralError', () => {
  it('keeps the application error page on its status code and emoticon', () => {
    const html = renderToStaticMarkup(
      <GeneralError error={new Error('boom')} />
    )

    expect(html).toContain('<h1')
    expect(html).toContain('500')
    // The emoticon is `:')`; a literal brace here would be rendered text.
    expect(html).toContain('Something went wrong :')
    expect(html).not.toContain('{:')
  })

  it('drops the status code for a failed page chunk and hides the asset URL', () => {
    const html = renderToStaticMarkup(
      <GeneralError
        error={
          new Error(
            'Failed to fetch dynamically imported module: https://panel.example/assets/risk-DQ8f.js'
          )
        }
      />
    )

    expect(html).not.toContain('<h1')
    expect(html).toContain('This page could not finish loading')
    expect(html).not.toContain('panel.example')
  })
})
