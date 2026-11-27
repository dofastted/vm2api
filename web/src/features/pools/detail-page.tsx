import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowLeft,
  KeyRound,
  Lock,
  MessageSquareText,
  Pencil,
  SearchCode,
  Server,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { TableSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { deleteSchedulerPool, updateSchedulerPool } from './api'
import { PoolExplainTab } from './explain-tab'
import { PoolKeysTab } from './keys-tab'
import { PoolMembersTab } from './members-tab'
import {
  PoolRoleBadge,
  PromptModeBadge,
  ProviderScopeBadge,
} from './pool-badges'
import { PoolFormDialog } from './pool-form-dialog'
import { poolSummaryMetrics } from './pool-rules'
import { PoolPromptTab } from './prompt-tab'
import {
  SCHEDULER_POOLS_KEY,
  schedulerPoolDetailQueryOptions,
  schedulerPoolsQueryOptions,
} from './queries'
import { PoolStickyTab } from './sticky-tab'

export function PoolDetailPage() {
  const { poolId } = useParams({ from: '/_authenticated/pools/$poolId' })
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [tab, setTab] = useState('members')
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const poolsQ = useQuery(schedulerPoolsQueryOptions())
  const detailQ = useQuery(schedulerPoolDetailQueryOptions(poolId, 8000))
  const allPools = useMemo(() => poolsQ.data || [], [poolsQ.data])
  const fallbackFromList = useMemo(
    () => allPools.find((p) => p.id === poolId),
    [allPools, poolId]
  )
  const pool = detailQ.data || fallbackFromList

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: SCHEDULER_POOLS_KEY }),
      qc.invalidateQueries({ queryKey: ['panel', 'scheduler-pools', poolId] }),
    ])
  }

  const updateMut = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      updateSchedulerPool(poolId, patch),
    onSuccess: async () => {
      toast.success('分组池信息已更新')
      setEditOpen(false)
      await invalidate()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const deleteMut = useMutation({
    mutationFn: () => deleteSchedulerPool(poolId),
    onSuccess: async () => {
      toast.success('分组池已删除')
      setDeleteOpen(false)
      await qc.invalidateQueries({ queryKey: SCHEDULER_POOLS_KEY })
      await navigate({ to: '/pools' })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const metrics = pool ? poolSummaryMetrics(pool) : null
  const hasBoundKeys =
    (metrics?.activeBoundKeysCount ?? 0) > 0 ||
    (metrics?.boundKeysCount ?? 0) > 0

  return (
    <PageHeader
      title={pool ? pool.name : `分组池 · ${poolId}`}
      description={pool?.description || undefined}
      fluid
    >
      <QueryGate
        loading={detailQ.isLoading && !pool}
        error={!pool ? detailQ.error : null}
        skeleton={<TableSkeleton rows={6} columns={4} />}
      >
        {pool ? (
          <div className='space-y-4'>
            {/* 顶部操作与身份栏 */}
            <div className='flex flex-wrap items-center gap-2 rounded-xl border bg-card px-3.5 py-2.5'>
              <Button variant='ghost' size='sm' asChild>
                <Link to='/pools'>
                  <ArrowLeft className='size-3.5' />
                  返回列表
                </Link>
              </Button>

              {allPools.length > 1 ? (
                <Select
                  value={pool.id}
                  onValueChange={(next) =>
                    navigate({
                      to: '/pools/$poolId',
                      params: { poolId: next },
                    })
                  }
                >
                  <SelectTrigger
                    className='h-8 w-52 text-xs'
                    aria-label='切换分组池'
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {allPools.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}

              <ProviderScopeBadge scope={pool.provider_scope} />
              <PoolRoleBadge role={pool.pool_role} />
              <PromptModeBadge
                providerScope={pool.provider_scope}
                mode={pool.system_prompt_mode}
              />
              {pool.exclusive_members ? (
                <Badge variant='outline' className='gap-1 text-xs'>
                  <Lock className='size-3' />
                  独占成员
                </Badge>
              ) : null}
              {(pool.plan_tags || []).map((tag) => (
                <Badge
                  key={tag}
                  variant='secondary'
                  className='font-mono text-[10px]'
                >
                  {tag}
                </Badge>
              ))}

              <div className='ms-auto flex flex-wrap items-center gap-2'>
                <div className='flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground'>
                  {pool.enabled ? '启用中' : '已停用'}
                  <Switch
                    checked={pool.enabled}
                    aria-label='启停分组池'
                    disabled={updateMut.isPending}
                    onCheckedChange={(enabled) => updateMut.mutate({ enabled })}
                  />
                </div>
                <Button
                  size='sm'
                  variant='outline'
                  className='h-8 text-xs'
                  onClick={() => setEditOpen(true)}
                >
                  <Pencil className='size-3.5' />
                  编辑基础
                </Button>
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-8 text-xs text-destructive hover:text-destructive'
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className='size-3.5' />
                  删除
                </Button>
              </div>
            </div>

            {/* 5 个聚焦 Tab */}
            <Tabs value={tab} onValueChange={setTab} className='space-y-4'>
              <TabsList className='flex h-auto w-full flex-wrap justify-start gap-1 p-1'>
                <TabsTrigger value='members' className='flex-none gap-1.5 px-3'>
                  <Server className='size-3.5' />
                  成员与权重等级
                  <Badge
                    variant='secondary'
                    className='ml-0.5 font-mono text-[10px]'
                  >
                    {metrics?.totalMembers ?? 0}
                  </Badge>
                </TabsTrigger>
                <TabsTrigger value='sticky' className='flex-none gap-1.5 px-3'>
                  <SlidersHorizontal className='size-3.5' />
                  粘性与溢出策略
                </TabsTrigger>
                <TabsTrigger value='prompt' className='flex-none gap-1.5 px-3'>
                  <MessageSquareText className='size-3.5' />
                  System Prompt 策略
                </TabsTrigger>
                <TabsTrigger value='keys' className='flex-none gap-1.5 px-3'>
                  <KeyRound className='size-3.5' />
                  绑定 API 密钥
                  <Badge
                    variant='secondary'
                    className='ml-0.5 font-mono text-[10px]'
                  >
                    {metrics?.boundKeysCount ?? 0}
                  </Badge>
                </TabsTrigger>
                <TabsTrigger value='explain' className='flex-none gap-1.5 px-3'>
                  <SearchCode className='size-3.5' />
                  决策追踪与模拟沙箱
                </TabsTrigger>
              </TabsList>

              <TabsContent value='members'>
                <PoolMembersTab pool={pool} allPools={allPools} />
              </TabsContent>
              <TabsContent value='sticky'>
                <PoolStickyTab pool={pool} allPools={allPools} />
              </TabsContent>
              <TabsContent value='prompt'>
                <PoolPromptTab pool={pool} />
              </TabsContent>
              <TabsContent value='keys'>
                <PoolKeysTab pool={pool} />
              </TabsContent>
              <TabsContent value='explain'>
                <PoolExplainTab pool={pool} />
              </TabsContent>
            </Tabs>

            <PoolFormDialog
              mode='edit'
              open={editOpen}
              onOpenChange={setEditOpen}
              initial={pool}
              pending={updateMut.isPending}
              onSubmit={(payload) => updateMut.mutate(payload)}
            />

            <ConfirmDialog
              open={deleteOpen}
              onOpenChange={setDeleteOpen}
              title={`删除分组池 · ${pool.name}`}
              desc={
                <div className='space-y-3'>
                  <p>删除后不可恢复。所有成员关联与粘性策略将被移除。</p>
                  {hasBoundKeys ? (
                    <Alert variant='destructive'>
                      <AlertTriangle className='size-4' />
                      <AlertTitle>
                        当前仍有 {metrics?.boundKeysCount} 个绑定 API 密钥（
                        {metrics?.activeBoundKeysCount} 个活跃）
                      </AlertTitle>
                      <AlertDescription>
                        存在活跃绑定密钥时后端默认拒绝删除。请先前往「绑定 API
                        密钥」页签解绑所有密钥。
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </div>
              }
              confirmText='确认删除'
              cancelBtnText='取消'
              destructive
              isLoading={deleteMut.isPending}
              handleConfirm={() => deleteMut.mutate()}
            />
          </div>
        ) : null}
      </QueryGate>
    </PageHeader>
  )
}
