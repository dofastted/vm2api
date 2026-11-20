import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LeaderboardCard } from './leaderboard-card'

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: () => ({ data: { entries: [] }, isLoading: false, error: null }),
  }
})

describe('leaderboard card link', () => {
  it('names the section jump without promising the complete current list', () => {
    const html = renderToStaticMarkup(
      <LeaderboardCard
        title='用户排行'
        scope='user'
        tz='Asia/Shanghai'
        onViewAll={() => {}}
      />
    )
    expect(html).toContain('>查看排行榜<')
    expect(html).not.toContain('查看全部')
  })
})
