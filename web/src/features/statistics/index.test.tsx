import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { StatisticsPage } from './index'

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import('@tanstack/react-query')
  return {
    ...actual,
    useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
      if (queryKey[0] === 'panel' && queryKey[1] === 'me') {
        return { data: { role: 'admin' }, isLoading: false, error: null }
      }
      return { data: { entries: [] }, isLoading: false, error: null }
    },
  }
})

describe('statistics VM labels', () => {
  it('names the VM leaderboard as virtual machines', () => {
    const html = renderToStaticMarkup(<StatisticsPage />)

    expect(html).toContain('虚拟机排行')
    expect(html).toContain('>虚拟机<')
    expect(html).not.toContain('供应商')
  })
})
