import type { ReactNode } from 'react'
import {
  QueryClient,
  QueryClientProvider,
  type UseMutationOptions,
  type useMutation as UseMutationFn,
} from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { BackupPane } from './backup-pane'
import {
  backupActionDisabled,
  backupEngineOf,
  backupFormatBadge,
  backupRestoreDisabled,
  parseBackupFilename,
} from './backup-utils'
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

const {
  confirmDialogCalls,
  recordedMutations,
  mockApi,
  toastSuccess,
  toastError,
  mutationPendingOverride,
} = vi.hoisted(() => ({
  confirmDialogCalls: [] as Array<{
    open: boolean
    title: ReactNode
    desc: ReactNode
    confirmText?: ReactNode
    cancelBtnText?: string
    destructive?: boolean
    isLoading?: boolean
    onOpenChange: (open: boolean) => void
    handleConfirm?: () => void
  }>,
  recordedMutations: [] as Array<{
    options: UseMutationOptions<unknown, Error, unknown, unknown>
    mutateSpy: ReturnType<typeof vi.fn>
  }>,
  mockApi: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  mutationPendingOverride: { pendingIndex: null as number | null },
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...original,
    api: mockApi,
  }
})

vi.mock('sonner', () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
  },
}))

vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: (props: (typeof confirmDialogCalls)[number]) => {
    confirmDialogCalls.push(props)
    return (
      <div
        data-confirm-dialog={String(props.title)}
        data-loading={String(Boolean(props.isLoading))}
      />
    )
  },
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...original,
    useMutation: ((
      options: UseMutationOptions<unknown, Error, unknown, unknown>,
      qc?: QueryClient
    ) => {
      const idx = recordedMutations.length
      const result = (original.useMutation as typeof UseMutationFn)(options, qc)
      const mutateSpy = vi.fn(result.mutate)
      recordedMutations.push({ options, mutateSpy })
      if (mutationPendingOverride.pendingIndex === idx) {
        return { ...result, isPending: true, mutate: mutateSpy }
      }
      return { ...result, mutate: mutateSpy }
    }) as typeof UseMutationFn,
  }
})

beforeEach(() => {
  confirmDialogCalls.length = 0
  recordedMutations.length = 0
  mockApi.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
  mutationPendingOverride.pendingIndex = null
})

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
  it('parses .tar.gz and .pgdump filenames from Content-Disposition and falls back to item file_name safely', () => {
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
      parseBackupFilename(null, 'bak_pg', 'kin-backup-20261126.pgdump')
    ).toBe('kin-backup-20261126.pgdump')
    expect(
      parseBackupFilename('', 'bak_ndjson', 'kin-backup-20261126.pg.ndjson.gz')
    ).toBe('kin-backup-20261126.pg.ndjson.gz')
    expect(
      parseBackupFilename(
        'attachment; filename="header-wins.pgdump"',
        'bak_pg',
        'fallback.pgdump'
      )
    ).toBe('header-wins.pgdump')
    expect(
      parseBackupFilename('attachment; filename="../../etc/passwd"', 'bak_4')
    ).toBe('....etcpasswd')
  })

  it('infers backup engine/format and disables cross-engine restore while keeping download enabled', () => {
    const pgDumpItem = {
      id: 'bak_pg_dump',
      status: 'ok',
      file_exists: true,
      file_name: 'kin-backup-1.tar.gz',
      includes: {
        db: true,
        engine: 'postgres' as const,
        format: 'pg_dump_custom',
      },
    }
    const pgNdjsonOrphan = {
      id: 'bak_pg_orphan',
      kind: 'imported',
      status: 'ok',
      file_exists: true,
      file_name: 'kin-backup-2.pg.ndjson.gz',
      includes: null,
    }
    const legacySqliteTar = {
      id: 'bak_sqlite_legacy',
      status: 'ok',
      file_exists: true,
      file_name: 'kin-backup-legacy.tar.gz',
      includes: { db: true, vms: 2, config: 1 },
    }
    const sqliteDbGz = {
      id: 'bak_sqlite_dbgz',
      status: 'ok',
      file_exists: true,
      file_name: 'kin-backup-3.db.gz',
      includes: null,
    }

    expect(backupEngineOf(pgDumpItem)).toBe('postgres')
    expect(backupFormatBadge(pgDumpItem)).toBe('PostgreSQL · pg_dump')
    expect(backupEngineOf(pgNdjsonOrphan)).toBe('postgres')
    expect(backupFormatBadge(pgNdjsonOrphan)).toBe('PostgreSQL · NDJSON')
    expect(backupEngineOf(legacySqliteTar)).toBe('sqlite')
    expect(backupFormatBadge(legacySqliteTar)).toBe('SQLite')
    expect(backupEngineOf(sqliteDbGz)).toBe('sqlite')
    expect(backupFormatBadge(sqliteDbGz)).toBe('SQLite · db.gz')

    // Cross-engine: SQLite backup on PostgreSQL server -> download allowed, restore disabled with Chinese reason
    expect(backupActionDisabled(legacySqliteTar)).toBe(false)
    expect(backupRestoreDisabled(legacySqliteTar, 'postgres')).toEqual({
      disabled: true,
      reason:
        '备份引擎（SQLite）与当前数据库（PostgreSQL）不一致，无法直接恢复',
    })
    // Cross-engine: PG backup on SQLite server -> download allowed, restore disabled with Chinese reason
    expect(backupActionDisabled(pgNdjsonOrphan)).toBe(false)
    expect(backupRestoreDisabled(pgNdjsonOrphan, 'sqlite')).toEqual({
      disabled: true,
      reason:
        '备份引擎（PostgreSQL）与当前数据库（SQLite）不一致，无法直接恢复',
    })
    // Matching engine -> restore enabled
    expect(backupRestoreDisabled(pgDumpItem, 'postgres')).toEqual({
      disabled: false,
    })
  })

  it('renders imported label, engine/format badges, cross-engine restore guard (keeping download enabled), and hides raw envelope fields', () => {
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
        engine: 'postgres',
        items: [
          {
            id: 'bak_ok',
            kind: 'manual',
            created_at: '2026-11-25T10:00:00Z',
            file_name: 'kin-backup-pg.tar.gz',
            size_bytes: 2048,
            status: 'ok',
            file_exists: true,
            includes: {
              db: true,
              engine: 'postgres',
              format: 'pg_dump_custom',
            },
          },
          {
            id: 'bak_imported_sqlite',
            kind: 'imported',
            created_at: '2026-11-25T09:30:00Z',
            file_name: 'kin-backup-legacy.tar.gz',
            size_bytes: 4096,
            status: 'ok',
            file_exists: true,
            includes: null,
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
    expect(html).toContain('当前数据库：PostgreSQL')
    expect(html).toContain('手动')
    expect(html).toContain('自动')
    expect(html).toContain('磁盘导入')
    expect(html).not.toContain('>imported<')
    expect(html).toContain('PostgreSQL · pg_dump')
    expect(html).toContain('SQLite')
    expect(html).toContain('2.0KB')
    expect(html).toContain('disk full')
    expect(html).toContain('该备份已失败，无法下载或恢复')

    // Inspect rows individually: matching PG row has restore enabled; cross-engine SQLite row keeps download enabled & disables restore
    const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []
    const pgRow = rows.find((r) => r.includes('bak_ok'))
    const sqliteRow = rows.find((r) => r.includes('bak_imported_sqlite'))
    expect(pgRow).toBeTruthy()
    expect(sqliteRow).toBeTruthy()
    expect(sqliteRow).toContain(
      '备份引擎（SQLite）与当前数据库（PostgreSQL）不一致，无法直接恢复'
    )

    const pgButtons = pgRow!.match(/<button[\s\S]*?<\/button>/g) || []
    const pgRestoreBtn = pgButtons.find((b) => b.includes('>恢复<'))
    expect(pgRestoreBtn).toBeTruthy()
    expect(pgRestoreBtn).not.toContain('disabled=""')

    const sqliteButtons = sqliteRow!.match(/<button[\s\S]*?<\/button>/g) || []
    const downloadBtn = sqliteButtons.find((b) => b.includes('>下载<'))
    const restoreBtn = sqliteButtons.find((b) => b.includes('>恢复<'))
    const deleteBtn = sqliteButtons.find((b) => b.includes('>删除<'))
    expect(downloadBtn).toBeTruthy()
    expect(downloadBtn).not.toContain('disabled=""')
    expect(restoreBtn).toBeTruthy()
    expect(restoreBtn).toContain('disabled=""')
    expect(restoreBtn).toContain(
      'title="备份引擎（SQLite）与当前数据库（PostgreSQL）不一致，无法直接恢复"'
    )
    expect(deleteBtn).toBeTruthy()
    expect(deleteBtn).not.toContain('disabled=""')
  })

  it('wires DELETE /api/panel/backups/:id through ConfirmDialog with isLoading lock, toast, and query invalidation', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const invalidateSpy = vi
      .spyOn(client, 'invalidateQueries')
      .mockResolvedValue()
    client.setQueryData(backupConfigQueryOptions().queryKey, {
      ok: true,
      config: { enabled: true, interval_hours: 24, retention: 7 },
    })
    client.setQueryData(backupsQueryOptions().queryKey, {
      engine: 'postgres',
      items: [
        {
          id: 'bak_del_1',
          kind: 'imported',
          status: 'ok',
          file_exists: true,
          file_name: 'kin-backup-del.pgdump',
        },
      ],
    })

    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <BackupPane />
      </QueryClientProvider>
    )

    // BackupPane mounts restore & delete ConfirmDialogs; locate the delete dialog
    const deleteDialog = confirmDialogCalls.find(
      (d) => d.title === '确认删除备份'
    )
    expect(deleteDialog).toBeDefined()
    expect(deleteDialog?.destructive).toBe(true)
    expect(deleteDialog?.confirmText).toBe('确认删除')
    expect(deleteDialog?.cancelBtnText).toBe('取消')
    expect(deleteDialog?.isLoading).toBe(false)

    // 4th useMutation in BackupPane is `remove` (saveConfig=0, create=1, restore=2, remove=3)
    const removeMutation = recordedMutations[3]
    expect(removeMutation).toBeDefined()
    mockApi.mockResolvedValueOnce({ ok: true, deleted: 'bak_del_1' })
    await removeMutation.options.mutationFn?.('bak_del_1', {} as never)
    expect(api).toHaveBeenCalledWith('/api/panel/backups/bak_del_1', {
      method: 'DELETE',
    })

    await removeMutation.options.onSuccess?.(
      { ok: true, deleted: 'bak_del_1' },
      'bak_del_1',
      undefined,
      {} as never
    )
    expect(toastSuccess).toHaveBeenCalledWith('备份已删除')
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: backupsQueryOptions().queryKey,
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: backupConfigQueryOptions().queryKey,
    })

    // Re-render with delete mutation pending: ConfirmDialog locks with isLoading=true and blocks re-entry
    confirmDialogCalls.length = 0
    recordedMutations.length = 0
    mutationPendingOverride.pendingIndex = 3
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <BackupPane />
      </QueryClientProvider>
    )
    const pendingDeleteDialog = confirmDialogCalls.find(
      (d) => d.title === '确认删除备份'
    )
    expect(pendingDeleteDialog?.isLoading).toBe(true)
    pendingDeleteDialog?.handleConfirm?.()
    expect(recordedMutations[3].mutateSpy).not.toHaveBeenCalled()

    client.clear()
  })
})
