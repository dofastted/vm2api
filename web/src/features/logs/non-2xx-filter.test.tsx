import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ActiveFiltersDisplay } from './filters/active-filters-display'
import { QuickFiltersBar } from './filters/quick-filters-bar'
import { StatusFilters } from './filters/status-filters'
import type { LogsFilterState } from './search'

vi.mock('@/components/ui/select', () => ({
  Select: ({ value, children }: { value?: string; children?: unknown }) => (
    <select value={value} onChange={() => {}}>
      {children as never}
    </select>
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

const filters: LogsFilterState = { excludeStatus200: true }

describe('non-2xx log filter wording', () => {
  it('names the selected non-success option by its full range', () => {
    const html = renderToStaticMarkup(
      <StatusFilters filters={filters} statusCodes={[]} onChange={() => {}} />
    )
    expect(html).toContain('value="!200"')
    expect(html).toContain('>仅非 2xx（含无状态码）</option>')
    expect(html).not.toContain('非 200')
  })
  it('uses the same name on the quick action and active chip', () => {
    const quick = renderToStaticMarkup(
      <QuickFiltersBar filters={filters} onChange={() => {}} />
    )
    const active = renderToStaticMarkup(
      <ActiveFiltersDisplay
        isAdmin={false}
        filters={filters}
        options={undefined}
        onRemove={() => {}}
        onClearAll={() => {}}
      />
    )
    expect(quick).toContain('>仅非 2xx<')
    expect(quick).not.toContain('仅错误')
    expect(active).toContain('仅非 2xx')
    expect(active).not.toContain('!200')
  })
})
