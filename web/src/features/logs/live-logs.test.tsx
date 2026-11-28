import type { InfiniteData } from '@tanstack/react-query'
import type {
  ActiveSession,
  ActiveSessionsData,
  UsageLogCursor,
  UsageLogRow,
  UsageLogsBatchResult,
} from '@/types/panel-usage-logs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActiveSessionsList, sessionInflightState } from './active-sessions-list'
import { SummaryTab } from './log-detail/summary-tab'
import {
  activeSessionsQueryOptions,
  mergeFirstUsageLogsPage,
  usageLogsBatchQueryOptions,
  usageLogsSummaryQueryOptions,
} from './queries'
import {
  LiveElapsedDuration,
  VirtualizedLogsTable,
} from './virtualized-logs-table'

const mockState = vi.hoisted(() => ({
  infiniteResult: null as null | Record<string, unknown>,
  activeSessionsResult: {
    data: undefined as ActiveSessionsData | undefined,
    isLoading: false,
  },
  lastUseQueryOptions: null as null | Record<string, unknown>,
  capturedItemKeys: [] as Array<string | number>,
  hookHarness: null as null | {
    values: unknown[]
    cursor: number
    effects: Array<() => void | (() => void)>
  },
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => {
      const harness = mockState.hookHarness
      if (!harness) {
        return actual.useState(initial as never)
      }
      const index = harness.cursor++
      if (index >= harness.values.length) {
        harness.values[index] =
          typeof initial === 'function' ? (initial as () => unknown)() : initial
      }
      return [
        harness.values[index],
        (next: unknown) => {
          harness.values[index] =
            typeof next === 'function'
              ? (next as (prev: unknown) => unknown)(harness.values[index])
              : next
        },
      ]
    },
    useEffect: (
      effect: () => void | (() => void),
      deps?: readonly unknown[]
    ) => {
      const harness = mockState.hookHarness
      if (harness) {
        harness.effects.push(effect)
        return
      }
      return actual.useEffect(effect, deps)
    },
  }
})

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children?: React.ReactNode }) => (
    <div data-slot='tooltip-content'>{children}</div>
  ),
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useInfiniteQuery: () => mockState.infiniteResult,
    useQuery: (options: Record<string, unknown>) => {
      mockState.lastUseQueryOptions = options
      return mockState.activeSessionsResult
    },
  }
})

vi.mock('@/hooks/use-virtualized-infinite-list', () => ({
  useVirtualizedInfiniteList: (opts: {
    itemCount: number
    getItemKey?: (index: number) => string | number
  }) => {
    const keys: Array<string | number> = []
    const virtualItems = Array.from({ length: opts.itemCount }, (_, index) => {
      const key = opts.getItemKey ? opts.getItemKey(index) : index
      keys.push(key)
      return { index, key, start: index * 52, size: 52 }
    })
    mockState.capturedItemKeys = keys
    return {
      parentRef: { current: null },
      rowVirtualizer: { getTotalSize: () => opts.itemCount * 52 },
      virtualItems,
      showScrollToTop: false,
      handleScroll: () => {},
      scrollToTop: () => {},
      resetScrollPosition: () => {},
    }
  },
}))

function makeLogRow(overrides: Partial<UsageLogRow> = {}): UsageLogRow {
  return {
    id: 'log_001',
    requestId: 'req_001',
    createdAt: '2026-11-28T10:00:00.000Z',
    userId: 'u-1',
    userName: 'alice',
    keyId: 'k-1',
    keyName: 'key-main',
    sessionId: 'sess-1',
    clientSessionId: null,
    inboundDeviceId: null,
    providerName: 'acct-1',
    accountId: 'acc-1',
    vmId: 'vm-1',
    vmName: 'slot-01',
    model: 'claude-sonnet-4-6',
    originalModel: 'claude-sonnet-4-6',
    actualResponseModel: null,
    modelMismatch: 0,
    endpoint: '/v1/messages',
    protocol: 'anthropic.messages',
    method: 'POST',
    statusCode: 200,
    logMode: 'normal',
    inputTokens: 1200,
    outputTokens: 340,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    cacheTtlApplied: null,
    totalTokens: 1540,
    costUsd: 0.012,
    actualCostUsd: 0.012,
    groupCostMultiplier: 1,
    costBreakdown: null,
    durationMs: 2450,
    firstByteMs: 300,
    ttftMs: 420,
    generationMs: 1900,
    stopReason: 'end_turn',
    attemptCount: 1,
    finalState: 'verified',
    via: 'go-worker-pool',
    stream: true,
    hasTools: false,
    serviceTier: null,
    upstreamServiceTier: null,
    speed: null,
    context1mApplied: null,
    reasoningEffort: null,
    errorClass: null,
    errorLabel: null,
    errorOwner: null,
    errorCode: null,
    errorMessage: null,
    jevState: null,
    blockedBy: null,
    blockedReason: null,
    userAgent: null,
    clientIp: '127.0.0.1',
    apiKeyPresented: null,
    specialSettings: [],
    providerChain: [],
    ...overrides,
  }
}

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionId: 'sess-live-1',
    oneOff: false,
    clientSessionId: null,
    userName: 'alice',
    keyName: 'key-main',
    providerName: 'acct-1',
    vmId: 'vm-1',
    vmName: 'slot-01',
    model: 'claude-sonnet-4-6',
    firstAt: '2026-11-28T10:00:00.000Z',
    lastAt: '2026-11-28T10:01:00.000Z',
    requests: 3,
    lastStatus: 200,
    lastDurationMs: 1500,
    totalTokens: 4500,
    totalCost: 0.05,
    ...overrides,
  }
}

beforeEach(() => {
  mockState.infiniteResult = null
  mockState.activeSessionsResult = { data: undefined, isLoading: false }
  mockState.lastUseQueryOptions = null
  mockState.capturedItemKeys = []
  mockState.hookHarness = null
})

afterEach(() => {
  mockState.hookHarness = null
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('in-flight log row rendering and stable key transitions', () => {
  it('renders spinner, live phase label, active attempt node, attempt count, elapsed duration, and TTFT', () => {
    const startedAt = Date.now() - 3200
    const liveRow = makeLogRow({
      id: '0',
      requestId: 'req_live_42',
      statusCode: null,
      durationMs: null,
      ttftMs: null,
      costUsd: null,
      actualCostUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      vmId: null,
      vmName: null,
      providerName: null,
      in_flight: true,
      _live: {
        phase: 'streaming',
        attempt_count: 2,
        started_at: startedAt,
        ttft_ms: 480,
        vm_id: 'vm-live-2',
        active_provider: 'slot-live-02',
      },
    })
    mockState.infiniteResult = {
      data: { pages: [{ logs: [liveRow], nextCursor: null, hasMore: false }] },
      error: null,
      isLoading: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: () => {},
    }

    const html = renderToStaticMarkup(
      <VirtualizedLogsTable
        filters={{}}
        autoRefreshEnabled
        onOpenDetail={() => {}}
      />
    )

    expect(html).toContain('data-in-flight="true"')
    expect(html).toContain('data-live-phase="streaming"')
    expect(html).toContain('data-live-elapsed="true"')
    expect(html).toContain('animate-spin')
    expect(html).toContain('输出中')
    expect(html).toContain('slot-live-02')
    expect(html).toContain('第2次')
    expect(html).toContain('TTFT 480ms')
    expect(mockState.capturedItemKeys).toEqual(['req:req_live_42'])
  })

  it('mounts LiveElapsedDuration and ticks elapsed time even when backend returns non-null durationMs', () => {
    vi.useFakeTimers()
    const baseNow = new Date('2026-11-28T10:00:10.000Z').getTime()
    vi.setSystemTime(baseNow)
    vi.stubGlobal('window', {
      setInterval: (...args: Parameters<typeof setInterval>) =>
        globalThis.setInterval(...args),
      clearInterval: (id: ReturnType<typeof setInterval>) =>
        globalThis.clearInterval(id),
    })

    const liveRow = makeLogRow({
      id: 'live_req_backend_dur',
      requestId: 'req_backend_dur',
      statusCode: null,
      // 后端 usage-logs-view.mjs:765 对 in-flight 行始终返回当前计算后的 durationMs。
      durationMs: 1200,
      ttftMs: 420,
      costUsd: null,
      actualCostUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      in_flight: true,
      _live: {
        phase: 'streaming',
        attempt_count: 1,
        started_at: baseNow - 1200,
        ttft_ms: 420,
        vm_id: 'vm-live-1',
        active_provider: 'slot-live-01',
      },
    })
    mockState.infiniteResult = {
      data: { pages: [{ logs: [liveRow], nextCursor: null, hasMore: false }] },
      error: null,
      isLoading: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: () => {},
    }

    const harness = {
      values: [] as unknown[],
      cursor: 0,
      effects: [] as Array<() => void | (() => void)>,
    }
    mockState.hookHarness = harness

    const renderTable = () => {
      harness.cursor = 0
      return renderToStaticMarkup(
        <VirtualizedLogsTable
          filters={{}}
          autoRefreshEnabled
          onOpenDetail={() => {}}
        />
      )
    }

    const initialHtml = renderTable()
    // 表格单元格与 Tooltip 两处均应挂载 LiveElapsedDuration，不被非空 durationMs 门控拦截。
    expect(initialHtml.match(/data-live-elapsed="true"/g)).toHaveLength(2)
    expect(
      initialHtml.match(/data-live-elapsed="true"[^>]*>1\.20s<\/span>/g)
    ).toHaveLength(2)

    const cleanups = harness.effects
      .map((effect) => effect())
      .filter((cleanup): cleanup is () => void => typeof cleanup === 'function')

    // 即使后端快照 row.durationMs 仍停留在 1200，每秒心跳也应持续递增展示耗时。
    vi.advanceTimersByTime(1000)
    const afterOneSecondHtml = renderTable()
    expect(
      afterOneSecondHtml.match(/data-live-elapsed="true"[^>]*>2\.20s<\/span>/g)
    ).toHaveLength(2)
    expect(afterOneSecondHtml).not.toContain('>1.20s</span>')

    vi.advanceTimersByTime(2000)
    const afterThreeSecondsHtml = renderTable()
    expect(
      afterThreeSecondsHtml.match(
        /data-live-elapsed="true"[^>]*>4\.20s<\/span>/g
      )
    ).toHaveLength(2)

    // 卸载清理后共享 1s 心跳定时器应停止，不再推进状态。
    for (const cleanup of cleanups) cleanup()
    vi.advanceTimersByTime(3000)
    const afterCleanupHtml = renderTable()
    expect(
      afterCleanupHtml.match(/data-live-elapsed="true"[^>]*>4\.20s<\/span>/g)
    ).toHaveLength(2)
  })

  it('falls back to row.durationMs when in-flight row lacks startedAtMs and avoids mounting live ticker', () => {
    const liveRowWithoutStart = makeLogRow({
      id: 'live_no_start',
      requestId: 'req_no_start',
      createdAt: '',
      statusCode: null,
      durationMs: 1200,
      in_flight: true,
      _live: { phase: 'routing' },
    })
    mockState.infiniteResult = {
      data: {
        pages: [
          { logs: [liveRowWithoutStart], nextCursor: null, hasMore: false },
        ],
      },
      error: null,
      isLoading: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: () => {},
    }

    const html = renderToStaticMarkup(
      <VirtualizedLogsTable
        filters={{}}
        autoRefreshEnabled
        onOpenDetail={() => {}}
      />
    )

    expect(html).toContain('data-in-flight="true"')
    expect(html).not.toContain('data-live-elapsed="true"')
    expect(html).toContain('1.20s')

    // LiveElapsedDuration 本身在无 startedAtMs 时亦回退显示 fallbackDurationMs 且不订阅定时器。
    const setIntervalSpy = vi.fn()
    vi.stubGlobal('window', {
      setInterval: setIntervalSpy,
      clearInterval: vi.fn(),
    })
    const harness = {
      values: [] as unknown[],
      cursor: 0,
      effects: [] as Array<() => void | (() => void)>,
    }
    mockState.hookHarness = harness
    const fallbackHtml = renderToStaticMarkup(
      <LiveElapsedDuration startedAtMs={null} fallbackDurationMs={1200} />
    )
    expect(fallbackHtml).toBe('<span>1.20s</span>')
    for (const effect of harness.effects) effect()
    expect(setIntervalSpy).not.toHaveBeenCalled()

    harness.cursor = 0
    expect(
      renderToStaticMarkup(<LiveElapsedDuration startedAtMs={null} />)
    ).toBe('<span>-</span>')
  })

  it('supports statusCode==null && _live fallback and distinct phase labels (routing/retrying/finalizing)', () => {
    const rows = [
      makeLogRow({
        id: 'tmp-1',
        requestId: 'req_routing',
        statusCode: null,
        durationMs: null,
        in_flight: undefined,
        _live: { phase: 'routing', started_at: Date.now() - 500 },
      }),
      makeLogRow({
        id: 'tmp-2',
        requestId: 'req_retrying',
        statusCode: null,
        durationMs: null,
        in_flight: true,
        _live: {
          phase: 'retrying',
          attempt_count: 3,
          started_at: Date.now() - 1500,
          vm_id: 'vm-retry-3',
        },
      }),
      makeLogRow({
        id: 'tmp-3',
        requestId: 'req_finalizing',
        statusCode: null,
        durationMs: null,
        in_flight: true,
        _live: { phase: 'finalizing', started_at: Date.now() - 2500 },
      }),
    ]
    mockState.infiniteResult = {
      data: { pages: [{ logs: rows, nextCursor: null, hasMore: false }] },
      error: null,
      isLoading: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: () => {},
    }

    const html = renderToStaticMarkup(
      <VirtualizedLogsTable
        filters={{}}
        autoRefreshEnabled
        onOpenDetail={() => {}}
      />
    )

    expect(html).toContain('路由中')
    expect(html).toContain('重试中')
    expect(html).toContain('vm-retry-3')
    expect(html).toContain('第3次')
    expect(html).toContain('收尾中')
    expect(mockState.capturedItemKeys).toEqual([
      'req:req_routing',
      'req:req_retrying',
      'req:req_finalizing',
    ])
  })

  it('preserves identical virtual item key when a row switches from Redis temp id to PG finalized id', () => {
    const inFlightRow = makeLogRow({
      id: 'live_req_switch_1',
      requestId: 'req_switch_1',
      statusCode: null,
      durationMs: 1000,
      in_flight: true,
      _live: { phase: 'streaming', started_at: Date.now() - 1000 },
    })
    mockState.infiniteResult = {
      data: {
        pages: [{ logs: [inFlightRow], nextCursor: null, hasMore: false }],
      },
      error: null,
      isLoading: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: () => {},
    }
    const inFlightHtml = renderToStaticMarkup(
      <VirtualizedLogsTable
        filters={{}}
        autoRefreshEnabled
        onOpenDetail={() => {}}
      />
    )
    const keyBefore = mockState.capturedItemKeys[0]
    expect(inFlightHtml).toContain('data-in-flight="true"')
    expect(inFlightHtml).toContain('data-live-elapsed="true"')

    const persistedRow = makeLogRow({
      id: 'log_998877665544',
      requestId: 'req_switch_1',
      statusCode: 200,
      durationMs: 1850,
      in_flight: false,
      _live: null,
    })
    mockState.infiniteResult = {
      data: {
        pages: [{ logs: [persistedRow], nextCursor: null, hasMore: false }],
      },
      error: null,
      isLoading: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: () => {},
    }
    const finalizedHtml = renderToStaticMarkup(
      <VirtualizedLogsTable
        filters={{}}
        autoRefreshEnabled
        onOpenDetail={() => {}}
      />
    )
    const keyAfter = mockState.capturedItemKeys[0]

    expect(keyBefore).toBe('req:req_switch_1')
    expect(keyAfter).toBe(keyBefore)
    expect(finalizedHtml).not.toContain('data-in-flight="true"')
    expect(finalizedHtml).not.toContain('data-live-elapsed="true"')
    expect(finalizedHtml).toContain('>200<')
    expect(finalizedHtml).toContain('1.85s')
  })

  it('renders SummaryTab in-flight banner instead of failure state when inspecting an active row', () => {
    const html = renderToStaticMarkup(
      <SummaryTab
        row={makeLogRow({
          id: '0',
          requestId: 'req_inspect_live',
          statusCode: null,
          durationMs: null,
          in_flight: true,
          _live: { phase: 'retrying', attempt_count: 2 },
        })}
        scrollToRedirect={false}
      />
    )
    expect(html).toContain('重试中')
    expect(html).toContain('进行中')
    expect(html).not.toContain('请求失败')
  })
})

describe('polling guards, multi-page anti-amplification, and summary decoupling', () => {
  it('enforces background pause, idle fetchStatus guard, and stops native multi-page cascade refetch', () => {
    let pollAllowed = true
    const opts = usageLogsBatchQueryOptions({
      filters: {},
      pollMs: 5000,
      shouldPoll: () => pollAllowed,
    })
    expect(opts.refetchIntervalInBackground).toBe(false)
    expect(opts.refetchOnWindowFocus).toBe(false)

    const intervalFn = opts.refetchInterval as (query: {
      state: { fetchStatus: string; data?: { pages: unknown[] } }
    }) => number | false

    // Single page + idle + poll allowed -> polls at 5000ms
    expect(
      intervalFn({ state: { fetchStatus: 'idle', data: { pages: [{}] } } })
    ).toBe(5000)

    // Overlapping fetch in progress -> pauses
    expect(
      intervalFn({ state: { fetchStatus: 'fetching', data: { pages: [{}] } } })
    ).toBe(false)

    // Multi-page loaded -> disables native infinite cascade refetch (handled by head-only merge)
    expect(
      intervalFn({
        state: { fetchStatus: 'idle', data: { pages: [{}, {}, {}] } },
      })
    ).toBe(false)

    // Auto-refresh off or scrolled >500px -> pauses
    pollAllowed = false
    expect(
      intervalFn({ state: { fetchStatus: 'idle', data: { pages: [{}] } } })
    ).toBe(false)
  })

  it('merges refreshed page 0 into multi-page cache without dropping bridged rows or retaining vanished in-flight rows', () => {
    const r3Live = makeLogRow({
      id: 'live_3',
      requestId: 'req_3',
      statusCode: null,
      in_flight: true,
      _live: { phase: 'streaming' },
    })
    const rVanishedLive = makeLogRow({
      id: 'live_vanished',
      requestId: 'req_vanished',
      statusCode: null,
      in_flight: true,
      _live: { phase: 'routing' },
    })
    const r2 = makeLogRow({ id: 'log_2', requestId: 'req_2' })
    const r1 = makeLogRow({ id: 'log_1', requestId: 'req_1' })
    const r0 = makeLogRow({ id: 'log_0', requestId: 'req_0' })

    const prev: InfiniteData<UsageLogsBatchResult, UsageLogCursor | null> = {
      pages: [
        {
          logs: [rVanishedLive, r3Live, r2, r1],
          nextCursor: { createdAt: r1.createdAt, id: r1.id },
          hasMore: true,
        },
        {
          logs: [r0],
          nextCursor: null,
          hasMore: false,
        },
      ],
      pageParams: [null, { createdAt: r1.createdAt, id: r1.id }],
    }

    const r4New = makeLogRow({
      id: 'live_4',
      requestId: 'req_4',
      statusCode: null,
      in_flight: true,
      _live: { phase: 'routing' },
    })
    const r3Finalized = makeLogRow({
      id: 'log_3',
      requestId: 'req_3',
      statusCode: 200,
      in_flight: false,
    })

    const merged = mergeFirstUsageLogsPage(prev, {
      logs: [r4New, r3Finalized, r2],
      nextCursor: { createdAt: r2.createdAt, id: r2.id },
      hasMore: true,
    })

    // Page 1 preserved untouched; page 0 has new live row + finalized req_3 + overlapping r2 + bridged r1, without vanished in-flight row
    expect(merged.pages).toHaveLength(2)
    expect(merged.pages[0].logs.map((r) => r.requestId)).toEqual([
      'req_4',
      'req_3',
      'req_2',
      'req_1',
    ])
    expect(merged.pages[0].logs[1].id).toBe('log_3')
    expect(merged.pages[0].logs[1].in_flight).toBe(false)
    expect(merged.pages[1].logs.map((r) => r.requestId)).toEqual(['req_0'])
  })

  it('resets disconnected multi-page cache when fresh page 0 no longer overlaps, and preserves empty filtered scan chunks', () => {
    const oldRow = makeLogRow({ id: 'log_old_1', requestId: 'req_old_1' })
    const page2Row = makeLogRow({ id: 'log_old_2', requestId: 'req_old_2' })
    const prev: InfiniteData<UsageLogsBatchResult, UsageLogCursor | null> = {
      pages: [
        {
          logs: [oldRow],
          nextCursor: { createdAt: oldRow.createdAt, id: oldRow.id },
          hasMore: true,
        },
        { logs: [page2Row], nextCursor: null, hasMore: false },
      ],
      pageParams: [null, { createdAt: oldRow.createdAt, id: oldRow.id }],
    }

    // Empty filtered scan chunk with hasMore=true preserves existing pages
    const preserved = mergeFirstUsageLogsPage(prev, {
      logs: [],
      nextCursor: { createdAt: oldRow.createdAt, id: oldRow.id },
      hasMore: true,
    })
    expect(preserved).toBe(prev)

    // Completely newer page with zero overlap resets cleanly to page 0
    const brandNew = makeLogRow({ id: 'log_new_1', requestId: 'req_new_1' })
    const reset = mergeFirstUsageLogsPage(prev, {
      logs: [brandNew],
      nextCursor: { createdAt: brandNew.createdAt, id: brandNew.id },
      hasMore: true,
    })
    expect(reset.pages).toHaveLength(1)
    expect(reset.pages[0].logs.map((r) => r.requestId)).toEqual(['req_new_1'])
  })

  it('keeps summary statistics query decoupled from 5s list polling', () => {
    const summaryOpts = usageLogsSummaryQueryOptions({ model: 'claude' })
    expect(summaryOpts.refetchInterval).toBe(false)
    expect(summaryOpts.refetchOnWindowFocus).toBe(false)
  })
})

describe('ActiveSessionsList auto-refresh control and in_progress rendering', () => {
  it('stops polling when autoRefreshEnabled is false and guards idle/background when true', () => {
    const disabledOpts = activeSessionsQueryOptions(false)
    expect(disabledOpts.refetchInterval).toBe(false)
    expect(disabledOpts.refetchIntervalInBackground).toBe(false)

    const enabledOpts = activeSessionsQueryOptions(true)
    expect(enabledOpts.refetchIntervalInBackground).toBe(false)
    const intervalFn = enabledOpts.refetchInterval as (query: {
      state: { fetchStatus: string }
    }) => number | false
    expect(intervalFn({ state: { fetchStatus: 'idle' } })).toBe(5000)
    expect(intervalFn({ state: { fetchStatus: 'fetching' } })).toBe(false)
  })

  it('passes autoRefreshEnabled=false to useQuery when disabled on ActiveSessionsList', () => {
    mockState.activeSessionsResult = {
      data: { minutes: 5, total: 0, oneOffTotal: 0, sessions: [] },
      isLoading: false,
    }
    renderToStaticMarkup(
      <ActiveSessionsList
        autoRefreshEnabled={false}
        onSelectSession={() => {}}
      />
    )
    expect(mockState.lastUseQueryOptions?.refetchInterval).toBe(false)
  })

  it('renders in_progress badge with inflight_count and distinguishes completed sessions', () => {
    expect(
      sessionInflightState(
        makeSession({ in_progress: true, inflight_count: 3 })
      )
    ).toEqual({ inProgress: true, inflightCount: 3 })
    expect(
      sessionInflightState(makeSession({ inflight_count: 1 }))
    ).toEqual({ inProgress: true, inflightCount: 1 })
    expect(
      sessionInflightState(
        makeSession({ in_progress: false, inflight_count: 0 })
      )
    ).toEqual({ inProgress: false, inflightCount: 0 })

    mockState.activeSessionsResult = {
      data: {
        minutes: 5,
        total: 3,
        oneOffTotal: 0,
        sessions: [
          makeSession({
            sessionId: 'sess-concurrent',
            userName: 'bob',
            in_progress: true,
            inflight_count: 2,
          }),
          makeSession({
            sessionId: 'sess-single',
            userName: 'carol',
            in_progress: true,
            inflight_count: 1,
          }),
          makeSession({
            sessionId: 'sess-done',
            userName: 'dave',
            in_progress: false,
            inflight_count: 0,
            lastStatus: 200,
          }),
        ],
      },
      isLoading: false,
    }

    const html = renderToStaticMarkup(
      <ActiveSessionsList autoRefreshEnabled onSelectSession={() => {}} />
    )

    expect(typeof mockState.lastUseQueryOptions?.refetchInterval).toBe(
      'function'
    )
    expect(html).toContain('2 进行中')
    expect(html).toContain('进行中 ×2')
    expect(html).toContain('data-slot="session-in-progress"')
    expect(html).toContain('animate-spin')
    expect(html).toContain('bob')
    expect(html).toContain('carol')
    expect(html).toContain('dave')
  })
})
