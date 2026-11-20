import type {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SettingsPage } from './index'

type ReactQuery = {
  useQueryClient: typeof useQueryClient
  useMutation: typeof useMutation
  useQuery: typeof useQuery
}

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ tab: 'logs' }),
}))

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...((await importOriginal()) as ReactQuery),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQuery: () => ({
    data: { logging: { mode: 'normal', retain_days: 7 } },
    isLoading: false,
    error: null,
  }),
}))

vi.mock('@/features/settings/settings-nav', () => ({
  SettingsNav: () => <nav>设置导航</nav>,
}))

describe('settings log boundary', () => {
  it('describes retention settings separately from the request log page', () => {
    const html = renderToStaticMarkup(<SettingsPage />)

    expect(html).toContain(
      '设置请求日志的记录模式、保留时间和存储上限。逐条记录在日志页查看。'
    )
    expect(html).toContain('日志保留')
  })
})
