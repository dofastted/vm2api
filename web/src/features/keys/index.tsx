import { lazy, Suspense, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { ApiKeyItem } from '@/types/panel-keys'
import { ArrowRight, Network } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { TableSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { StatusMark } from '@/components/status-mark'
import { apiEndpointsQueryOptions } from '@/features/api-endpoints/queries'
import { meQueryOptions } from '@/features/auth/queries'
import { geminiInventoryOptions } from '@/features/import/gemini-environments'
import { apiKeysQueryOptions } from '@/features/keys/queries'
import { schedulerPoolsQueryOptions } from '@/features/pools/queries'
import { usersQueryOptions } from '@/features/users/queries'
import { vmsListQueryOptions } from '@/features/vm/queries'
import {
  keyExpiryText,
  keyIsDead,
  keyModelsText,
  keyQuotaLabel,
  keyQuotaPct,
  keyStatusTone,
  maskApiKeyItem,
  plaintextFromPayload,
} from './key-format'
import { KeyLimitsDialog } from './key-limits-dialog'
import { keyLimitsPayload, type KeyLimitsDraft } from './key-payload'
import { KeyRevealDialog, type RevealedKey } from './key-reveal-dialog'

// 统计弹窗带 recharts（约 100 KB gzip），只在点开时加载。
const KeyStatsDialog = lazy(() =>
  import('./key-stats-dialog').then((m) => ({ default: m.KeyStatsDialog }))
)

export function KeysPage() {
  const qc = useQueryClient()
  const q = useQuery(apiKeysQueryOptions())
  const me = useQuery(meQueryOptions())
  const isAdmin = me.data?.role === 'admin'
  const pools = useQuery({ ...schedulerPoolsQueryOptions(), enabled: isAdmin })
  const vms = useQuery(vmsListQueryOptions())
  const vmItems = vms.data?.items || []
  const [createOpen, setCreateOpen] = useState(false)
  const [editId, setEditId] = useState('')
  const [statsId, setStatsId] = useState('')
  // 首次打开后保持挂载，关闭动画照常播放。
  const [statsOpened, setStatsOpened] = useState(false)
  if (statsId && !statsOpened) setStatsOpened(true)
  const [rotateId, setRotateId] = useState('')
  const [revealed, setRevealed] = useState<RevealedKey | null>(null)
  const [delId, setDelId] = useState('')
  const dialogOpen = createOpen || !!editId
  const channels = useQuery({
    ...apiEndpointsQueryOptions(),
    enabled: isAdmin && dialogOpen,
  })
  const users = useQuery({
    ...usersQueryOptions(),
    enabled: isAdmin && dialogOpen,
  })
  const gemini = useQuery({
    ...geminiInventoryOptions(),
    enabled: isAdmin && dialogOpen,
  })
  const keys = q.data?.keys || []
  const editing = keys.find((k) => k.id === editId) || null
  const rotating = keys.find((k) => k.id === rotateId) || null
  const refresh = () =>
    qc.invalidateQueries({ queryKey: apiKeysQueryOptions().queryKey })

  const create = useMutation({
    mutationFn: (draft: KeyLimitsDraft) => {
      const body = keyLimitsPayload(draft, 'create', { isAdmin })
      return api<unknown>('/api/panel/api-keys', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },
    onSuccess: async (data) => {
      const key = plaintextFromPayload(data)
      setCreateOpen(false)
      if (key) {
        setRevealed({ title: '已生成', name: draftName(data), key })
      } else {
        toast.success('已创建')
      }
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const edit = useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: KeyLimitsDraft }) =>
      api(`/api/panel/api-keys/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(keyLimitsPayload(draft, 'edit', { isAdmin })),
      }),
    onSuccess: async () => {
      toast.success('密钥已更新')
      setEditId('')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const toggle = useMutation({
    mutationFn: ({ id, enable }: { id: string; enable: boolean }) =>
      api(`/api/panel/api-keys/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: enable ? 'active' : 'disabled' }),
      }),
    onSuccess: async (_data, vars) => {
      toast.success(vars.enable ? '已启用' : '已停用')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const resetQuota = useMutation({
    mutationFn: (id: string) =>
      api(`/api/panel/api-keys/${encodeURIComponent(id)}/reset-quota`, {
        method: 'POST',
      }),
    onSuccess: async () => {
      toast.success('额度已清零')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const reveal = useMutation({
    mutationFn: (id: string) =>
      api<unknown>(`/api/panel/api-keys/${encodeURIComponent(id)}/reveal`, {
        method: 'POST',
      }),
    onError: (error: Error) => toast.error(error.message),
  })

  const rotate = useMutation({
    mutationFn: (id: string) =>
      api<unknown>(`/api/panel/api-keys/${encodeURIComponent(id)}/rotate`, {
        method: 'POST',
      }),
    onSuccess: async (data) => {
      const key = plaintextFromPayload(data)
      setRotateId('')
      if (key) setRevealed({ title: '已换新', name: draftName(data), key })
      else toast.success('已换新')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/panel/api-keys/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      toast.success('已删除')
      setDelId('')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  async function viewPlain(k: ApiKeyItem) {
    try {
      const data = await reveal.mutateAsync(k.id)
      const key = plaintextFromPayload(data)
      if (!key) {
        toast.error('无法还原明文 · 请换新')
        return
      }
      setRevealed({ title: '查看密钥', name: k.name, id: k.id, key })
    } catch {
      /* onError 已 toast */
    }
  }

  async function copyPlain(k: ApiKeyItem) {
    try {
      const data = await reveal.mutateAsync(k.id)
      const key = plaintextFromPayload(data)
      if (!key) {
        toast.error('无法还原明文 · 请换新')
        return
      }
      if (await copyText(key)) {
        toast.success('已复制明文密钥，请妥善保存')
        return
      }
      // The browser refused (plain HTTP without execCommand, or the click's
      // activation expired while revealing): hand the key over in the dialog,
      // whose own button is a fresh gesture.
      setRevealed({ title: '复制密钥', name: k.name, id: k.id, key })
      toast.warning('浏览器拦截了自动复制，请在弹层中点「复制」或手动选中')
    } catch {
      /* onError 已 toast */
    }
  }

  return (
    <PageHeader
      title={VIEW_TITLES.keys}
      description='发给客户端的 sk-vm- 密钥。请求走这张密钥，不要把主控密钥写进环境变量。'
      extra={<Button onClick={() => setCreateOpen(true)}>生成</Button>}
    >
      {isAdmin ? (
        <div className='mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card/70 px-4 py-3'>
          <div className='flex items-start gap-2.5'>
            <Network
              className='mt-0.5 size-4 shrink-0 text-primary'
              aria-hidden
            />
            <div>
              <div className='text-sm font-medium'>
                分组池管理已迁移至独立工作台
                {pools.data ? `（当前 ${pools.data.length} 个分组池）` : ''}
              </div>
              <p className='text-xs text-muted-foreground'>
                支持 Anthropic / OpenAI / Google / API
                全平台建池、权重等级编排、双级粘性与 Anthropic System Prompt
                隔离。在下方创建或编辑密钥可直接绑定默认池与允许池列表。
              </p>
            </div>
          </div>
          <Button asChild size='sm' variant='outline'>
            <Link to='/pools'>
              前往分组池
              <ArrowRight className='size-3.5' />
            </Link>
          </Button>
        </div>
      ) : null}
      <QueryGate
        loading={q.isLoading}
        error={q.error}
        skeleton={<TableSkeleton rows={8} columns={8} />}
      >
        {keys.length === 0 ? (
          <EmptyState
            reason='尚无密钥。协议密钥只能调 /v1。'
            actionLabel='生成'
            onAction={() => setCreateOpen(true)}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>分类</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>额度</TableHead>
                <TableHead>限制</TableHead>
                <TableHead>过期</TableHead>
                <TableHead className='text-right'></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <KeyRow
                  key={k.id}
                  item={k}
                  busy={
                    toggle.isPending ||
                    resetQuota.isPending ||
                    reveal.isPending ||
                    rotate.isPending
                  }
                  onView={() => void viewPlain(k)}
                  onCopy={() => void copyPlain(k)}
                  onRotate={() => setRotateId(k.id)}
                  onEdit={() => setEditId(k.id)}
                  onStats={() => setStatsId(k.id)}
                  onToggle={() =>
                    toggle.mutate({
                      id: k.id,
                      enable: k.status === 'disabled',
                    })
                  }
                  onReset={() => resetQuota.mutate(k.id)}
                  onDelete={() => setDelId(k.id)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </QueryGate>
      <KeyLimitsDialog
        mode='create'
        open={createOpen}
        onOpenChange={setCreateOpen}
        pending={create.isPending}
        vms={vmItems}
        vmsReady={vms.isSuccess && !vms.isFetching}
        vmsError={vms.isError}
        pools={isAdmin ? pools.data || [] : undefined}
        channels={isAdmin ? channels.data?.items || [] : undefined}
        channelsLoading={channels.isPending}
        channelsError={channels.isError}
        users={isAdmin ? users.data?.items || [] : undefined}
        geminiEnvs={isAdmin ? gemini.data?.environments || [] : undefined}
        onSubmit={(draft) => create.mutate(draft)}
      />
      <KeyLimitsDialog
        mode='edit'
        open={!!editId}
        onOpenChange={(open) => {
          if (!open) setEditId('')
        }}
        initial={editing}
        vms={vmItems}
        vmsReady={vms.isSuccess && !vms.isFetching}
        vmsError={vms.isError}
        pools={isAdmin ? pools.data || [] : undefined}
        channels={isAdmin ? channels.data?.items || [] : undefined}
        channelsLoading={channels.isPending}
        channelsError={channels.isError}
        users={isAdmin ? users.data?.items || [] : undefined}
        geminiEnvs={isAdmin ? gemini.data?.environments || [] : undefined}
        pending={edit.isPending}
        onSubmit={(draft) => {
          if (!editId) return
          edit.mutate({ id: editId, draft })
        }}
      />
      <KeyRevealDialog value={revealed} onClose={() => setRevealed(null)} />
      {statsOpened ? (
        <Suspense fallback={null}>
          <KeyStatsDialog
            item={keys.find((k) => k.id === statsId) || null}
            vms={vmItems}
            onOpenChange={(open) => {
              if (!open) setStatsId('')
            }}
          />
        </Suspense>
      ) : null}
      <ConfirmDialog
        open={!!rotateId}
        onOpenChange={() => setRotateId('')}
        title='换新密钥'
        desc={`${rotating?.name || rotateId} · 这条密钥建库时只留了哈希，明文取不回来。换新会立刻让旧值失效（客户端会收到 401），名称 / 分类 / 并发 / 额度 / 统计都保留。`}
        confirmText='换新'
        cancelBtnText='取消'
        isLoading={rotate.isPending}
        handleConfirm={() => {
          if (rotateId) rotate.mutate(rotateId)
        }}
      />
      <ConfirmDialog
        open={!!delId}
        onOpenChange={() => setDelId('')}
        title='删除密钥'
        desc='删除后立即失效，客户端再用该 key 将收到 401。'
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        isLoading={remove.isPending}
        handleConfirm={() => {
          if (delId) remove.mutate(delId)
        }}
      />
    </PageHeader>
  )
}

function draftName(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const rec = payload as Record<string, unknown>
  if (typeof rec.name === 'string') return rec.name
  const item = rec.item
  if (item && typeof item === 'object') {
    const name = (item as Record<string, unknown>).name
    if (typeof name === 'string') return name
  }
  return undefined
}

function KeyRow({
  item,
  busy,
  onView,
  onCopy,
  onRotate,
  onEdit,
  onStats,
  onToggle,
  onReset,
  onDelete,
}: {
  item: ApiKeyItem
  busy: boolean
  onView: () => void
  onCopy: () => void
  onRotate: () => void
  onEdit: () => void
  onStats: () => void
  onToggle: () => void
  onReset: () => void
  onDelete: () => void
}) {
  const active = item.status !== 'disabled'
  const expiry = keyExpiryText(item)
  const pct = keyQuotaPct(item)
  const conc = Number(item.max_concurrency || 0)
  const rpm = Number(item.rpm || 0)
  const models = keyModelsText(item)
  return (
    <TableRow className={cn(keyIsDead(item) && 'bg-destructive/10')}>
      <TableCell>
        <div className='font-medium'>{item.name || 'default'}</div>
        <div className='text-xs text-muted-foreground'>
          {scopeText(item)}
          {' · '}
          {fmtNum(item.requests || 0)} 请求
          {item.inflight ? ` · ${item.inflight} 进行中` : ''}
        </div>
      </TableCell>
      <TableCell>
        <div className='flex flex-wrap items-center gap-1'>
          <code className='font-mono text-xs'>{maskApiKeyItem(item)}</code>
          {item.revealable ? (
            <>
              <Button
                size='sm'
                variant='ghost'
                disabled={busy}
                onClick={onView}
              >
                查看
              </Button>
              <Button
                size='sm'
                variant='ghost'
                disabled={busy}
                onClick={onCopy}
              >
                复制
              </Button>
            </>
          ) : (
            <Button
              size='sm'
              variant='ghost'
              disabled={busy}
              onClick={onRotate}
            >
              换新
            </Button>
          )}
        </div>
      </TableCell>
      <TableCell>
        {item.category === 'api'
          ? 'API'
          : item.category === 'all'
            ? '全部'
            : 'OAuth'}
      </TableCell>
      <TableCell>
        <StatusMark tone={keyStatusTone(item)} />
      </TableCell>
      <TableCell className='min-w-[120px]'>
        <div className='text-xs'>{keyQuotaLabel(item)}</div>
        {pct != null ? <Progress value={pct} className='mt-1 h-1.5' /> : null}
      </TableCell>
      <TableCell className='text-xs'>
        {conc ? `${conc} 并发` : '并发不限'} · {rpm ? `RPM ${rpm}` : 'RPM 不限'}
        <div
          className={cn(!models.title && 'text-muted-foreground')}
          title={models.title}
        >
          {models.text}
        </div>
      </TableCell>
      <TableCell
        className={cn('text-xs', expiry.expired && 'text-destructive')}
      >
        {expiry.text}
      </TableCell>
      <TableCell className='space-x-1 text-right'>
        <Button size='sm' variant='ghost' disabled={busy} onClick={onStats}>
          统计
        </Button>
        <Button size='sm' variant='ghost' disabled={busy} onClick={onEdit}>
          编辑
        </Button>
        <Button size='sm' variant='ghost' disabled={busy} onClick={onToggle}>
          {active ? '停用' : '启用'}
        </Button>
        <Button size='sm' variant='ghost' disabled={busy} onClick={onReset}>
          清零
        </Button>
        <Button
          size='sm'
          variant='destructive'
          disabled={busy}
          onClick={onDelete}
        >
          删除
        </Button>
      </TableCell>
    </TableRow>
  )
}

function scopeText(item: ApiKeyItem): string {
  const defaultPool = item.default_pool_id || item.vm_pool_id
  const allowedCount = (item.allowed_pool_ids || []).length
  if (item.pool_binding_mode === 'strict_pool' || defaultPool) {
    const label =
      item.default_pool_name || item.vm_pool_name || defaultPool || '未指定'
    const extra = allowedCount > 1 ? ` +${allowedCount - 1} 池` : ''
    const modeTag =
      item.pool_binding_mode === 'strict_pool' ? '严格分组池' : '分组池'
    return `${modeTag} · ${label}${extra}`
  }
  if (item.group_type === 'gemini') return 'Gemini · CRAGAnti'
  const count = item.allowed_vms?.length || 0
  const unpinnedMulti =
    count === 0 &&
    (item.category === 'all' || item.permission_tier === 'tenant')
  if (item.group_type === 'anthropic')
    return unpinnedMulti ? 'Anthropic' : `Anthropic · ${count} 台`
  if (item.group_type === 'openai')
    return unpinnedMulti ? 'OpenAI' : `OpenAI · ${count} 台`
  return '全局'
}
