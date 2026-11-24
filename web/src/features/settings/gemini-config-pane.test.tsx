import type {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { GeminiConfigPane } from './gemini-config-pane'
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_TABS,
  settingsTabId,
} from './navigation'

type ReactQuery = {
  useQueryClient: typeof useQueryClient
  useMutation: typeof useMutation
  useQuery: typeof useQuery
}

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    className,
  }: {
    children: React.ReactNode
    className?: string
  }) => <a className={className}>{children}</a>,
}))

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...((await importOriginal()) as ReactQuery),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQuery: () => ({
    data: {
      available: true,
      mode: 'sharded',
      accounts_per_daemon: 50,
      daemon_fault_isolation: true,
      planned_shards: 2,
      authorized_oauth_accounts: 55,
      total_accounts: 55,
      total_active_slots: 6,
      total_idle_slots: 12,
      shm_ring_stats: {
        requests_total: 120,
        responses_total: 480,
        request_bytes_total: 2 * 1024 * 1024,
        response_bytes_total: 8 * 1024 * 1024,
        crc_errors_total: 0,
        backpressure_waits_total: 1,
      },
      shards: [
        {
          shard_id: 'shard-0',
          kind: 'shard',
          alive: true,
          ready: true,
          pid: 12345,
          capacity: 50,
          account_count: 50,
          account_ids: [],
          active_slots: 5,
          idle_slots: 10,
          total_slots: 15,
          circuit_open_accounts: 0,
          shm_enabled: true,
          shm_ring_stats: null,
          fault_isolated: false,
          restart_count: 0,
        },
      ],
    },
    isFetching: false,
    refetch: vi.fn(),
  }),
}))

describe('settings Gemini entry & scheduling config pane', () => {
  it('registers Gemini scheduling tab under 调度 while keeping Gemini 维护 under 运维', () => {
    expect(settingsTabId('gemini-config')).toBe('gemini-config')
    expect(settingsTabId('gemini')).toBe('gemini')
    const scheduling = SETTINGS_NAV_GROUPS.find((g) => g.label === '调度')
    const ops = SETTINGS_NAV_GROUPS.find((g) => g.label === '运维')
    expect(scheduling?.items.some((item) => item.id === 'gemini-config')).toBe(
      true
    )
    expect(ops?.items.some((item) => item.id === 'gemini')).toBe(true)
    expect(
      SETTINGS_TABS.find(([id]) => id === 'gemini-config')?.[1]
    ).toBe('Gemini')
    expect(SETTINGS_TABS.find(([id]) => id === 'gemini')?.[1]).toBe(
      'Gemini 维护'
    )
  })

  it('renders live sharded CRAGGemini daemon status, SHM ring controls, and scheduling options', () => {
    const html = renderToStaticMarkup(
      <GeminiConfigPane
        value={{
          enabled: true,
          pool: { strategy: 'balanced', accounts_per_daemon: 50 },
          sticky: { enabled: true, ttl_seconds: 3600 },
          shm: { require_shm: true, request_mb: 4, response_mb: 16 },
        }}
        onChange={vi.fn()}
      />
    )

    expect(html).toContain('CRAGGemini 守护进程与共享内存')
    expect(html).toContain('分片接管 · 50/进程')
    expect(html).toContain('shard-0')
    expect(html).toContain('入口与协议准入')
    expect(html).toContain('调度策略与粘性会话')
    expect(html).toContain('单 CRAGGemini 多账号接管与并发')
    expect(html).toContain('单账号默认会话上限')
    expect(html).toContain('资格警告定时探测间隔')
    expect(html).toContain('共享内存传输（AGYSHM02）')
    expect(html).toContain('故障切号与熔断保护')
    expect(html).toContain('50 (推荐)')
  })
})
