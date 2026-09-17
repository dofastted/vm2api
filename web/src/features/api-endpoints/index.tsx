import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import type { ApiEndpoint } from '@/types/panel-api-endpoints'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { CardGridSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { EndpointDetailSheet } from '@/features/api-endpoints/endpoint-detail-sheet'
import { apiEndpointsQueryOptions } from '@/features/api-endpoints/queries'

export function ApiEndpointsPage() {
  const qc = useQueryClient()
  const q = useQuery(apiEndpointsQueryOptions())
  const items = q.data?.items || []
  const [creating, setCreating] = useState(false)
  const [editId, setEditId] = useState('')
  const [del, setDel] = useState<ApiEndpoint | null>(null)
  const editing = items.find((item) => item.id === editId) || null
  const stats = summarize(items)
  const refresh = () =>
    qc.invalidateQueries({ queryKey: apiEndpointsQueryOptions().queryKey })

  const toggle = useMutation({
    mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) =>
      api(`/api/panel/api-endpoints/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ disabled }),
      }),
    onSuccess: async (_data, vars) => {
      toast.success(vars.disabled ? '已停用' : '已启用')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <PageHeader
      title={VIEW_TITLES.api}
      extra={
        <Button
          onClick={() => {
            setEditId('')
            setCreating(true)
          }}
        >
          添加地址
        </Button>
      }
    >
      <QueryGate
        loading={q.isLoading}
        error={q.error}
        skeleton={
          <div className='space-y-4'>
            <div className='flex flex-wrap gap-4'>
              <Skeleton className='h-4 w-24' />
              <Skeleton className='h-4 w-24' />
              <Skeleton className='h-4 w-24' />
            </div>
            <CardGridSkeleton
              cards={6}
              className='grid gap-3 sm:grid-cols-2 xl:grid-cols-3'
            />
          </div>
        }
      >
        {items.length === 0 ? (
          <p className='rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground'>
            还没有直连上游地址。添加一个 base_url + key 池，协议密钥就能按
            prefix 路由过去。
          </p>
        ) : (
          <div className='space-y-4'>
            <div className='flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground'>
              <span>地址 {stats.count}</span>
              <span>
                {stats.ready}/{stats.total} key 可用
              </span>
              <span>停用 {stats.disabled}</span>
            </div>
            <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-3'>
              {items.map((endpoint) => (
                <EndpointCard
                  key={endpoint.id}
                  endpoint={endpoint}
                  busy={toggle.isPending}
                  onEdit={() => {
                    setCreating(false)
                    setEditId(endpoint.id)
                  }}
                  onToggle={() =>
                    toggle.mutate({
                      id: endpoint.id,
                      disabled: !endpoint.disabled,
                    })
                  }
                  onDelete={() => setDel(endpoint)}
                />
              ))}
            </div>
          </div>
        )}
      </QueryGate>
      <EndpointDetailSheet
        open={creating || !!editing}
        endpoint={creating ? null : editing}
        presets={q.data?.presets || []}
        onOpenChange={(open) => {
          if (open) return
          setCreating(false)
          setEditId('')
        }}
      />
      <ConfirmDialog
        open={!!del}
        onOpenChange={() => setDel(null)}
        title='删除 API 地址'
        desc={`会删掉「${del?.name || del?.id || ''}」下的全部上游 key 和模型。`}
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        handleConfirm={() => {
          if (!del) return
          api(`/api/panel/api-endpoints/${encodeURIComponent(del.id)}`, {
            method: 'DELETE',
          })
            .then(() => {
              toast.success('已删除')
              setDel(null)
              return refresh()
            })
            .catch((e: Error) => toast.error(e.message))
        }}
      />
    </PageHeader>
  )
}

function EndpointCard({
  endpoint,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  endpoint: ApiEndpoint
  busy: boolean
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  const keys = endpoint.api_key_entries || []
  const ready = keys.filter(
    (entry) => !entry.disabled && !entry.cooldown_until
  ).length
  const models = endpoint.models || []
  return (
    <Card
      className={cn(
        'h-full cursor-pointer transition-colors',
        endpoint.disabled ? 'bg-muted/60' : 'hover:bg-accent/40'
      )}
      onClick={onEdit}
    >
      <CardContent className='space-y-3'>
        <div className='flex items-start justify-between gap-2'>
          <div className='min-w-0'>
            <div className='flex items-center gap-1.5 truncate font-medium'>
              <span className='truncate'>{endpoint.name || 'api'}</span>
              <Badge variant='outline' className='shrink-0 font-normal'>
                {kindLabel(endpoint.kind)}
              </Badge>
            </div>
            <p className='truncate font-mono text-xs text-muted-foreground'>
              {endpoint.base_url || '未填地址'}
              {endpoint.prefix ? ` · prefix ${endpoint.prefix}` : ''}
            </p>
          </div>
          {endpoint.disabled ? (
            <span className='shrink-0 text-xs text-muted-foreground'>
              已停用
            </span>
          ) : null}
        </div>
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground'>
          <span>
            {ready}/{keys.length} key 可用
          </span>
          <span>{models.length} 模型</span>
          {endpoint.disable_cooling ? <span>冷却关</span> : null}
          {endpoint.priority ? <span>优先 {endpoint.priority}</span> : null}
          {endpoint.protocol !== 'openai' ? (
            <span>
              {endpoint.auth_scheme === 'authorization_bearer'
                ? 'Bearer'
                : 'x-api-key'}
            </span>
          ) : null}
        </div>
        {models.length ? (
          <div className='flex flex-wrap gap-1'>
            {models.map((model) => (
              <Badge key={`${model.name}:${model.alias}`} variant='secondary'>
                {model.alias}
              </Badge>
            ))}
          </div>
        ) : null}
        <div className='flex flex-wrap gap-1 border-t pt-2'>
          <Button
            size='sm'
            variant='ghost'
            onClick={(event) => {
              event.stopPropagation()
              onEdit()
            }}
          >
            编辑
          </Button>
          <Button
            size='sm'
            variant='ghost'
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation()
              onToggle()
            }}
          >
            {endpoint.disabled ? '启用' : '停用'}
          </Button>
          <Button
            size='sm'
            variant='destructive'
            onClick={(event) => {
              event.stopPropagation()
              onDelete()
            }}
          >
            删除
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function summarize(items: ApiEndpoint[]) {
  let ready = 0
  let total = 0
  let disabled = 0
  for (const item of items) {
    if (item.disabled) disabled += 1
    const keys = item.api_key_entries || []
    total += keys.length
    ready += keys.filter(
      (entry) => !entry.disabled && !entry.cooldown_until
    ).length
  }
  return { count: items.length, ready, total, disabled }
}

function kindLabel(kind: ApiEndpoint['kind']): string {
  if (kind === 'claude') return 'Claude 官方'
  if (kind === 'openai') return 'OpenAI 官方'
  return '自定义'
}
