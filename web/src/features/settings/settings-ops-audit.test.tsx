import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { BackupPane } from './backup-pane'
import { backupActionDisabled, parseBackupFilename } from './backup-utils'
import { NotifyPane } from './notify-pane'
import { OfficialCcSettingsPane } from './official-cc-pane'
import {
  backupConfigQueryOptions,
  backupsQueryOptions,
  notifyQueryOptions,
  routingQueryOptions,
} from './queries'
import { Socks5Pane } from './socks5-pane'
import { TelemetryPane } from './telemetry-pane'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))

vi.mock('@/components/ui/collapsible', () => ({
  Collapsible: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => (
    <button type='button'>{children}</button>
  ),
  CollapsibleContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))

function renderWithClient(
  node: ReactNode,
  seed?: (client: QueryClient) => void
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  seed?.(client)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    )
  } finally {
    client.clear()
  }
}

describe('P3-03: OfficialCcSettingsPane copy and hello placeholder', () => {
  it('adds placeholder="hello" and calibrates OAuth profile vs usage tier copy', () => {
    const html = renderToStaticMarkup(
      <OfficialCcSettingsPane config={{}} onChange={() => {}} />
    )
    expect(html).toContain('官方 Claude Code 初装')
    expect(html).toContain('placeholder="hello"')
    expect(html).toContain(
      '优先取官方 OAuth profile 等级，缺失时按完整官方 usage 推断'
    )
    expect(html).not.toContain('账号等级以完整官方 usage 为准')
  })
})

describe('P2-11 & P3-05: TelemetryPane card separation, retroactive warning, and Socks5Pane copy', () => {
  it('splits immediate slot switches from deferred global policy card and warns on retroactive opt-in', () => {
    const html = renderWithClient(
      <TelemetryPane
        interval={600}
        defaultEnabled={true}
        disableNonessentialTraffic={false}
        onIntervalChange={() => {}}
        onDefaultEnabledChange={() => {}}
        onDisableNonessentialTrafficChange={() => {}}
      />,
      (client) => {
        client.setQueryData(routingQueryOptions().queryKey, {
          telemetry: { default_enabled: false },
        })
        client.setQueryData(dashboardQueryOptions().queryKey, {
          vms: [
            {
              id: 'vm-01',
              name: 'Claude 1',
              status: 'running',
              seed_policy: { telemetry_disabled: true },
            },
          ],
        } as never)
      }
    )

    expect(html).toContain('槽位遥测开关')
    expect(html).toContain('即时生效')
    expect(html).toContain('全局遥测策略')
    expect(html).toContain('需底部保存')
    expect(html).toContain('默认开启遥测（保存时同步现有 Claude 槽）')
    expect(html).toContain('当前有 1 个现有 Claude 槽处于关闭状态')
    expect(html).not.toContain('>新建槽默认开启<')
  })

  it('notes per-node bind_limit adjustment on /proxies in Socks5Pane', () => {
    const html = renderWithClient(<Socks5Pane />)
    expect(html).toContain('bind_limit')
    expect(html).toContain('/proxies')
    expect(html).toContain('默认上限 5 台')
  })
})

describe('P2-12: NotifyPane console placeholder and email SMTP channel', () => {
  it('renders /cc placeholder, 4th email status pill, and SMTP config card', () => {
    const html = renderWithClient(
      <NotifyPane value={undefined} onChange={() => {}} />,
      (client) => {
        client.setQueryData(notifyQueryOptions().queryKey, {
          config: {} as never,
          channels: {
            email: true,
            telegram: false,
            wecom: false,
            feishu: false,
            any: true,
          },
        })
      }
    )
    expect(html).toContain('placeholder="https://panel.example.com/cc"')
    expect(html).toContain('邮件已就绪')
    expect(html).toContain('邮件通知（SMTP）')
    expect(html).toContain('aria-label="SMTP 服务器"')
    expect(html).toContain('aria-label="SMTP 端口"')
    expect(html).toContain('aria-label="邮件收件人"')
  })
})

describe('P2-14: BackupPane localized config form, item metadata, disabled actions, and filename parsing', () => {
  it('parses .tar.gz filenames from Content-Disposition and falls back safely', () => {
    expect(
      parseBackupFilename(
        'attachment; filename="kin-backup-20261125.tar.gz"',
        'bak_1'
      )
    ).toBe('kin-backup-20261125.tar.gz')
    expect(
      parseBackupFilename(
        "attachment; filename*=UTF-8''kin-backup-%E6%B5%8B%E8%AF%95.tar.gz",
        'bak_2'
      )
    ).toBe('kin-backup-测试.tar.gz')
    expect(parseBackupFilename(null, 'bak_3')).toBe('backup-bak_3.tar.gz')
    expect(
      parseBackupFilename('attachment; filename="../../etc/passwd"', 'bak_4')
    ).toBe('....etcpasswd')
  })

  it('disables download/restore on failed or missing backups and hides raw envelope fields', () => {
    expect(
      backupActionDisabled({ id: 'b1', status: 'ok', file_exists: true })
    ).toBe(false)
    expect(
      backupActionDisabled({ id: 'b2', status: 'failed', file_exists: false })
    ).toBe(true)
    expect(
      backupActionDisabled({ id: 'b3', status: 'ok', file_exists: false })
    ).toBe(true)

    const html = renderWithClient(<BackupPane />, (client) => {
      client.setQueryData(backupConfigQueryOptions().queryKey, {
        ok: true,
        config: { enabled: true, interval_hours: 12, retention: 10 },
        next_auto_at: '2026-11-26T00:00:00Z',
      })
      client.setQueryData(backupsQueryOptions().queryKey, {
        items: [
          {
            id: 'bak_ok',
            kind: 'manual',
            created_at: '2026-11-25T10:00:00Z',
            size_bytes: 2048,
            status: 'ok',
            file_exists: true,
          },
          {
            id: 'bak_fail',
            kind: 'scheduled',
            created_at: '2026-11-25T09:00:00Z',
            size_bytes: null,
            status: 'failed',
            file_exists: false,
            error: 'disk full',
          },
        ],
      })
    })

    expect(html).toContain('自动备份策略')
    expect(html).toContain('备份间隔（小时）')
    expect(html).toContain('保留份数')
    expect(html).toContain('下次自动备份')
    expect(html).not.toContain('"interval_hours":12')
    expect(html).toContain('手动')
    expect(html).toContain('自动')
    expect(html).toContain('2.0KB')
    expect(html).toContain('disk full')
    expect(html).toContain('该备份已失败，无法下载或恢复')
  })
})
