import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BackupScheduleConfig } from '@/types/panel-routing'
import { toast } from 'sonner'
import { ApiError, api, panelFetch } from '@/lib/api'
import { fmtBytes, fmtExpiresAt } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SettingRow } from '@/components/setting-row'
import {
  backupConfigQueryOptions,
  backupsQueryOptions,
  routingQueryOptions,
} from '@/features/settings/queries'
import {
  backupActionDisabled,
  backupActionDisabledReason,
  backupEngineLabel,
  backupFormatBadge,
  backupRestoreDisabled,
  parseBackupFilename,
} from './backup-utils'
import { settleInt, typingInt } from './int-input'

const DEFAULT_BACKUP_CONFIG: BackupScheduleConfig = {
  enabled: true,
  interval_hours: 24,
  retention: 7,
}

const BACKUP_KIND_LABELS: Record<string, string> = {
  manual: '手动',
  scheduled: '自动',
  pre_restore: '恢复前快照',
  imported: '磁盘导入',
}

function backupKindLabel(kind?: string): string {
  if (!kind) return '—'
  return BACKUP_KIND_LABELS[kind] || kind
}

function ScheduleIntField({
  ariaLabel,
  value,
  min,
  max,
  fallback,
  disabled,
  onChange,
}: {
  ariaLabel: string
  value: number
  min: number
  max: number
  fallback: number
  disabled?: boolean
  onChange: (next: number) => void
}) {
  const [text, setText] = useState<string | null>(null)
  return (
    <Input
      className='w-28 tabular-nums'
      type='number'
      aria-label={ariaLabel}
      min={min}
      max={max}
      disabled={disabled}
      value={text ?? String(value)}
      onChange={(event) => {
        const raw = event.target.value
        setText(raw)
        const n = typingInt(raw)
        if (n !== null && n >= min && n <= max) onChange(n)
      }}
      onBlur={() => {
        if (text === null) return
        const settled = settleInt(text, min, max, fallback)
        setText(null)
        if (settled !== value) onChange(settled)
      }}
    />
  )
}

export function BackupPane() {
  const qc = useQueryClient()
  const list = useQuery(backupsQueryOptions())
  const cfg = useQuery(backupConfigQueryOptions())
  const [restoreId, setRestoreId] = useState('')
  const [deleteId, setDeleteId] = useState('')
  const [draft, setDraft] = useState<Partial<BackupScheduleConfig> | null>(null)

  const savedConfig: BackupScheduleConfig = {
    ...DEFAULT_BACKUP_CONFIG,
    ...(cfg.data?.config || {}),
  }
  const form: BackupScheduleConfig = {
    ...savedConfig,
    ...(draft || {}),
  }
  const configDirty =
    draft !== null &&
    (form.enabled !== savedConfig.enabled ||
      form.interval_hours !== savedConfig.interval_hours ||
      form.retention !== savedConfig.retention)

  const patchForm = (patch: Partial<BackupScheduleConfig>) =>
    setDraft((prev) => ({ ...(prev || {}), ...patch }))

  const saveConfig = useMutation({
    mutationFn: (next: BackupScheduleConfig) =>
      api('/api/panel/backups/config', {
        method: 'PUT',
        body: JSON.stringify(next),
      }),
    onSuccess: async () => {
      setDraft(null)
      toast.success('自动备份配置已保存')
      await Promise.all([
        qc.invalidateQueries({ queryKey: backupConfigQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: backupsQueryOptions().queryKey }),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const create = useMutation({
    mutationFn: () => api('/api/panel/backups', { method: 'POST', body: '{}' }),
    onSuccess: async () => {
      toast.success('已创建备份')
      await Promise.all([
        qc.invalidateQueries({ queryKey: backupsQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: backupConfigQueryOptions().queryKey }),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const restore = useMutation({
    mutationFn: (id: string) =>
      api(`/api/panel/backups/${encodeURIComponent(id)}/restore`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      }),
    onSuccess: async () => {
      toast.success('备份已恢复')
      setRestoreId('')
      await Promise.all([
        qc.invalidateQueries({ queryKey: routingQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: backupsQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: backupConfigQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: ['panel'] }),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/panel/backups/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      toast.success('备份已删除')
      setDeleteId('')
      await Promise.all([
        qc.invalidateQueries({ queryKey: backupsQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: backupConfigQueryOptions().queryKey }),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const items = list.data?.items || []
  const currentEngine = list.data?.engine

  async function download(id: string, fallbackName?: string | null) {
    const res = await panelFetch(
      `/api/panel/backups/${encodeURIComponent(id)}/download`
    )
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as {
        error?: { message?: string }
      } | null
      throw new ApiError(payload?.error?.message || '下载失败', res.status)
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = parseBackupFilename(
      res.headers.get('content-disposition'),
      id,
      fallbackName
    )
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className='space-y-3'>
      <Card>
        <CardHeader className='flex flex-row items-center justify-between gap-3'>
          <div className='space-y-1'>
            <CardTitle>自动备份策略</CardTitle>
            <p className='text-xs text-muted-foreground'>
              按计划自动备份数据库、槽位档案与配置文件；更改后点击右侧「保存配置」立即生效。
            </p>
          </div>
          <Button
            size='sm'
            disabled={!cfg.data || !configDirty || saveConfig.isPending}
            loading={saveConfig.isPending}
            onClick={() => saveConfig.mutate(form)}
          >
            保存配置
          </Button>
        </CardHeader>
        <CardContent className='divide-y'>
          <SettingRow
            label='启用自动备份'
            desc='关闭后不再按计划自动创建快照（仍可随时手动创建）'
          >
            <Switch
              checked={form.enabled}
              disabled={!cfg.data || saveConfig.isPending}
              aria-label='启用自动备份'
              onCheckedChange={(enabled) => patchForm({ enabled })}
            />
          </SettingRow>
          <SettingRow
            label='备份间隔（小时）'
            desc='1–720 小时（最多 30 天），默认 24 小时'
          >
            <ScheduleIntField
              ariaLabel='备份间隔（小时）'
              value={form.interval_hours}
              min={1}
              max={720}
              fallback={DEFAULT_BACKUP_CONFIG.interval_hours}
              disabled={!cfg.data || saveConfig.isPending}
              onChange={(interval_hours) => patchForm({ interval_hours })}
            />
          </SettingRow>
          <SettingRow
            label='保留份数'
            desc='1–100 份，默认保留最近 7 份成功备份（恢复前快照独立保留最近 3 份）'
          >
            <ScheduleIntField
              ariaLabel='保留份数'
              value={form.retention}
              min={1}
              max={100}
              fallback={DEFAULT_BACKUP_CONFIG.retention}
              disabled={!cfg.data || saveConfig.isPending}
              onChange={(retention) => patchForm({ retention })}
            />
          </SettingRow>
          <SettingRow
            label='下次自动备份'
            desc='只读；由后端根据上次成功备份时间与间隔自动计算'
          >
            <span className='font-mono text-xs text-muted-foreground tabular-nums'>
              {cfg.data?.next_auto_at
                ? fmtExpiresAt(cfg.data.next_auto_at)
                : form.enabled
                  ? '等待调度'
                  : '未启用'}
            </span>
          </SettingRow>
          {cfg.error ? (
            <p role='alert' className='pt-3 text-sm text-destructive'>
              无法读取备份配置：{(cfg.error as Error).message}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className='flex flex-row items-center justify-between gap-3'>
          <div className='space-y-1'>
            <div className='flex flex-wrap items-center gap-2'>
              <CardTitle>备份记录</CardTitle>
              {currentEngine ? (
                <Badge variant='outline' className='font-mono text-[11px]'>
                  当前数据库：{backupEngineLabel(currentEngine)}
                </Badge>
              ) : null}
            </div>
            <p className='text-xs text-muted-foreground'>
              恢复前会自动创建一份恢复前快照；恢复期间协议口返回 503。
            </p>
          </div>
          <Button
            size='sm'
            onClick={() => create.mutate()}
            disabled={create.isPending || restore.isPending || remove.isPending}
            loading={create.isPending}
          >
            创建备份
          </Button>
        </CardHeader>
        <CardContent className='space-y-4'>
          {items.length === 0 ? (
            <p className='text-sm text-muted-foreground'>
              {list.isLoading ? '读取备份记录…' : '暂无备份记录。'}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>引擎 / 格式</TableHead>
                  <TableHead>时间</TableHead>
                  <TableHead>大小</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className='text-right'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((b) => {
                  const actionDisabled = backupActionDisabled(b)
                  const actionReason = backupActionDisabledReason(b)
                  const restoreState = backupRestoreDisabled(b, currentEngine)
                  const crossEngine = !actionDisabled && restoreState.disabled
                  const formatBadge = backupFormatBadge(b)
                  const sizeValue = b.size_bytes ?? b.size
                  const statusOk = b.status === 'ok'
                  const missingFile = statusOk && b.file_exists !== true
                  return (
                    <TableRow key={b.id}>
                      <TableCell className='font-mono text-xs'>
                        {b.id}
                      </TableCell>
                      <TableCell className='text-xs'>
                        {backupKindLabel(b.kind)}
                      </TableCell>
                      <TableCell className='text-xs'>
                        {formatBadge ? (
                          <Badge
                            variant={crossEngine ? 'destructive' : 'outline'}
                            className='font-mono text-[11px]'
                          >
                            {formatBadge}
                          </Badge>
                        ) : (
                          <span className='text-muted-foreground'>—</span>
                        )}
                      </TableCell>
                      <TableCell className='text-xs tabular-nums'>
                        {fmtExpiresAt(b.created_at)}
                      </TableCell>
                      <TableCell className='font-mono text-xs tabular-nums'>
                        {sizeValue != null ? fmtBytes(sizeValue) : '—'}
                      </TableCell>
                      <TableCell className='space-y-1'>
                        <Badge
                          variant={
                            statusOk && !missingFile
                              ? 'secondary'
                              : 'destructive'
                          }
                        >
                          {!statusOk
                            ? '失败'
                            : missingFile
                              ? '文件缺失'
                              : '正常'}
                        </Badge>
                        {crossEngine && restoreState.reason ? (
                          <p className='max-w-xs text-xs text-amber-600 dark:text-amber-400'>
                            {restoreState.reason}
                          </p>
                        ) : null}
                        {b.error ? (
                          <p className='max-w-xs text-xs break-all text-destructive'>
                            {b.error}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className='space-x-1 text-right whitespace-nowrap'>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={actionDisabled}
                          title={actionReason}
                          onClick={() =>
                            download(b.id, b.file_name).catch((e: Error) =>
                              toast.error(e.message)
                            )
                          }
                        >
                          下载
                        </Button>
                        <Button
                          size='sm'
                          variant='destructive'
                          disabled={
                            restoreState.disabled ||
                            restore.isPending ||
                            remove.isPending
                          }
                          title={restoreState.reason}
                          onClick={() => setRestoreId(b.id)}
                        >
                          恢复
                        </Button>
                        <Button
                          size='sm'
                          variant='outline'
                          className='text-destructive hover:text-destructive'
                          disabled={restore.isPending || remove.isPending}
                          onClick={() => setDeleteId(b.id)}
                        >
                          删除
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
          <ConfirmDialog
            open={!!restoreId}
            onOpenChange={(open) => {
              if (!open && !restore.isPending) setRestoreId('')
            }}
            title='确认恢复备份'
            desc='恢复会覆盖当前状态，期间协议口返回 503。恢复完成后将自动刷新配置与页面数据。'
            confirmText='确认恢复'
            cancelBtnText='取消'
            destructive
            isLoading={restore.isPending}
            handleConfirm={() => {
              if (restoreId && !restore.isPending) restore.mutate(restoreId)
            }}
          />
          <ConfirmDialog
            open={!!deleteId}
            onOpenChange={(open) => {
              if (!open && !remove.isPending) setDeleteId('')
            }}
            title='确认删除备份'
            desc={`删除备份 ${deleteId} 将同时移除台账记录与磁盘归档文件（如存在），且不可撤销。`}
            confirmText='确认删除'
            cancelBtnText='取消'
            destructive
            isLoading={remove.isPending}
            handleConfirm={() => {
              if (deleteId && !remove.isPending) remove.mutate(deleteId)
            }}
          />
        </CardContent>
      </Card>
    </div>
  )
}
