import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ExportDialog } from './export-dialog'

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children?: unknown }) => (
    <div>{children as never}</div>
  ),
  DialogContent: ({ children }: { children?: unknown }) => (
    <div>{children as never}</div>
  ),
  DialogHeader: ({ children }: { children?: unknown }) => (
    <div>{children as never}</div>
  ),
  DialogTitle: ({ children }: { children?: unknown }) => (
    <h2>{children as never}</h2>
  ),
  DialogDescription: ({ children }: { children?: unknown }) => (
    <p>{children as never}</p>
  ),
  DialogFooter: ({ children }: { children?: unknown }) => (
    <div>{children as never}</div>
  ),
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children?: unknown }) => (
    <div>{children as never}</div>
  ),
  SelectTrigger: ({ children }: { children?: unknown }) => (
    <>{children as never}</>
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: unknown }) => (
    <>{children as never}</>
  ),
  SelectItem: ({ value, children }: { value: string; children?: unknown }) => (
    <option value={value}>{children as never}</option>
  ),
}))

describe('log export wording', () => {
  it('does not describe a capped export as complete', () => {
    const html = renderToStaticMarkup(
      <ExportDialog
        open
        onOpenChange={() => {}}
        currentSummary='当前页面筛选'
        onExport={async () => {}}
      />
    )
    expect(html).toContain('不按页面筛选')
    expect(html).toContain('包含已屏蔽的错误类，仍受时间和条数限制')
    expect(html).toContain('沿用当前筛选时间')
    expect(html).toContain('预设只替换起始时间，不改截止')
    expect(html).not.toContain('导出全量')
    expect(html).not.toContain('全部时间')
  })
})
