import type { LeaderboardEntry } from '@/types/panel-statistics'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LeaderboardSection } from './leaderboard-section'

function entry(name: string): LeaderboardEntry {
  return {
    id: name,
    name,
    totalRequests: 3,
    successRequests: 2,
    errorRequests: 1,
    successRate: 2 / 3,
    totalTokens: 12,
    inputTokens: 4,
    outputTokens: 8,
    cacheReadTokens: 1,
    cacheCreationTokens: 1,
    cacheCreation5mTokens: 1,
    cacheCreation1hTokens: 0,
    cacheHitRate: 0.2,
    totalCost: 1.5,
    totalActualCost: 1.2,
    avgDurationMs: 80,
    avgTtftMs: 20,
  }
}

const boardState = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: () => boardState.current }
})

function renderBoard() {
  return renderToStaticMarkup(
    <LeaderboardSection
      scopes={['vm']}
      tz='Asia/Shanghai'
      scope='vm'
      onScopeChange={() => {}}
    />
  )
}

describe('leaderboard placeholder isolation', () => {
  it('hides the previous board while the selected query is a placeholder', () => {
    boardState.current = {
      data: { entries: [entry('旧榜虚拟机')] },
      error: null,
      isLoading: false,
      isFetching: true,
      isPlaceholderData: true,
    }
    const html = renderBoard()
    expect(html).toContain('data-slot="skeleton"')
    expect(html).not.toContain('旧榜虚拟机')
  })

  it('keeps the current board while the same key refreshes', () => {
    boardState.current = {
      data: { entries: [entry('当前虚拟机')] },
      error: null,
      isLoading: false,
      isFetching: true,
      isPlaceholderData: false,
    }
    const html = renderBoard()
    expect(html).toContain('当前虚拟机')
    expect(html).not.toContain('data-slot="skeleton"')
  })
})
