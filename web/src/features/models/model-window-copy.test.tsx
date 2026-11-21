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

describe('model context window wording', () => {
  it('renders the configured window and 1M capability from the production row', () => {
    const html = renderToStaticMarkup(
      <ModelRow
        model={{
          id: 'claude',
          capabilities: { context_window: 200000, supports_1m: true },
        }}
        live={false}
        pol={{ defaults: {} }}
        pricing={null}
        open
        platform='anthropic'
        onToggleOpen={() => {}}
        onToggleEnabled={() => {}}
        onModel={() => {}}
        onParam={() => {}}
        onPass1m={() => {}}
      />
    )
    expect(html).toContain('配置的上下文窗口')
    expect(html).toMatch(/配置的上下文窗口[\s\S]*value="200000"/)
    expect(html).toContain('1M 能力')
  })
})
