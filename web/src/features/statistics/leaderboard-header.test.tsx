import type { LeaderboardEntry } from '@/types/panel-statistics'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LeaderboardSection } from './leaderboard-section'

const boardState = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: () => boardState.current }
})

function entry(name: string): LeaderboardEntry {
  return {
    id: name,
    name,
    totalRequests: 1,
    successRequests: 1,
    errorRequests: 0,
    successRate: 1,
    totalTokens: 1,
    inputTokens: 1,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    cacheHitRate: 0,
    totalCost: 1,
    totalActualCost: 1,
    avgDurationMs: 10,
    avgTtftMs: 5,
  }
}

function renderBoard(scopeLabels?: { vm: string }) {
  boardState.current = {
    data: { entries: [entry('alpha')] },
    error: null,
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
  }
  return renderToStaticMarkup(
    <LeaderboardSection
      scopes={['vm']}
      tz='Asia/Shanghai'
      scope='vm'
      onScopeChange={() => {}}
      scopeLabels={scopeLabels}
    />
  )
}

describe('leaderboard scope header', () => {
  it('uses the tenant scope label in the table header', () => {
    const html = renderBoard({ vm: '可用 VM' })
    expect(html).toContain('可用 VM')
    expect(html).not.toContain('虚拟机')
  })

  it('keeps the admin virtual machine header by default', () => {
    const html = renderBoard()
    expect(html).toContain('虚拟机')
    expect(html).not.toContain('可用 VM')
  })
})
