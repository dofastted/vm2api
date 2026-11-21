import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ExportDialog } from './export-dialog'

vi.mock('@/components/ui/dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/dialog')>()
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>
  return { ...actual, DialogContent: Pass }
})

describe('export mute wording', () => {
  it('replaces the mute switch when an explicit error class is selected', () => {
    const explicit = renderToStaticMarkup(
      <ExportDialog
        open
        currentErrorClass='auth'
        currentSummary='当前筛选'
        onOpenChange={() => {}}
        onExport={async () => {}}
      />
    )
    expect(explicit).toContain('按所选错误类导出，不受屏蔽设置影响')
    expect(explicit).not.toContain('>包含已屏蔽的错误类<')
    const normal = renderToStaticMarkup(
      <ExportDialog
        open
        currentSummary='当前筛选'
        onOpenChange={() => {}}
        onExport={async () => {}}
      />
    )
    expect(normal).toContain('>包含已屏蔽的错误类<')
  })
})
