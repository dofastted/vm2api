import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ModelRow } from './model-row'

vi.mock('@/components/ui/dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/dialog')>()
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>
  return {
    ...actual,
    Dialog: actual.Dialog,
    DialogContent: Pass,
    DialogFooter: Pass,
    DialogClose: Pass,
  }
})

describe('Google Gemini model row', () => {
  it('shows default medium thinking effort, Gemini slot scope, and pricing facts', () => {
    const html = renderToStaticMarkup(
      <ModelRow
        model={{
          id: 'gemini-4-neon',
          display_name: 'Gemini 4 Neon',
          family: 'gemini',
          enabled: true,
          capabilities: { context_window: 1_000_000, supports_1m: true },
          params: { default_effort: 'medium' },
        }}
        live
        pol={{ defaults: {} }}
        pricing={{
          id: 'gemini-4-neon',
          source: 'builtin',
          effective: {
            input: 2,
            output: 12,
            cache_read: 0.2,
            cache_5m: 0,
            cache_1h: 0,
            tiers: [
              {
                above: 200_000,
                input: 4,
                output: 18,
                cache_read: 0.4,
                cache_5m: 0,
                cache_1h: 0,
              },
            ],
          },
        }}
        open
        platform='google'
        onToggleOpen={() => {}}
        onToggleEnabled={() => {}}
        onModel={() => {}}
        onParam={() => {}}
        onPass1m={() => {}}
      />
    )
    expect(html).toContain('Gemini 4 Neon')
    expect(html).toContain('缺省思考')
    expect(html).toContain('medium')
    expect(html).toContain('Gemini 槽位')
    expect(html).toContain('思考等级参数')
    expect(html).toContain('缺省思考等级')
    expect(html).toContain('内置')
    expect(html).toContain('&gt;200k')
  })
})
