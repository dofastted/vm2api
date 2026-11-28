import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiEndpoint } from '@/types/panel-api-endpoints'
import type {
  MemberRole,
  PoolNodeType,
  SchedulerPool,
  SchedulerPoolMember,
  SchedulerPoolMemberInput,
} from '@/types/panel-pools'
import type { Vm } from '@/types/panel-vm'
import {
  AlertTriangle,
  Ban,
  Flame,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { apiEndpointsQueryOptions } from '@/features/api-endpoints/queries'
import {
  geminiInventoryOptions,
  type GeminiEnvironment,
} from '@/features/import/gemini-environments'
import { vmsListQueryOptions } from '@/features/vm/queries'
import { replacePoolMembers, unrestSchedulerNode } from './api'
import { WeightTierBadge } from './pool-badges'
import {
  analyzeMemberConflicts,
  NODE_TYPE_LABELS,
  nodeKeyOf,
} from './pool-rules'
import { SCHEDULER_POOLS_KEY } from './queries'

type CandidateNode = {
  node_type: PoolNodeType
  node_id: string
  node_key: string
  name: string
  email?: string | null
  plan_tier?: string | null
  runtime_kind: 'crag' | 'cli-node' | 'codex' | 'gemini' | 'api'
  dataplane?: string | null
  protocol?: string | null
  weight_tier_mode: 'manual' | 'auto'
  base_weight_tier: number
  base_sub_weight: number
  inflight: number
  max_concurrency: number
  quota_5h_pct: number | null
  quota_7d_pct: number | null
  healthy: boolean
  cooldown_until_ms: number | null
  cooldown_reason: string | null
}

function buildCandidates(
  vms: Vm[],
  geminiEnvs: GeminiEnvironment[],
  endpoints: ApiEndpoint[]
): CandidateNode[] {
  const out: CandidateNode[] = []
  for (const vm of vms) {
    const codex = isCodexVm(vm)
    const node_type: PoolNodeType = codex ? 'codex_vm' : 'claude_vm'
    const dataplane = vm.resolved_dataplane ?? vm.dataplane ?? null
    const runtime_kind = codex
      ? 'codex'
      : dataplane === 'crag'
        ? 'crag'
        : 'cli-node'
    const lvl = Number(vm.schedule_level)
    const u5 =
      vm.utilization_5h != null
        ? Math.round(
            Number(vm.utilization_5h) <= 1
              ? Number(vm.utilization_5h) * 100
              : Number(vm.utilization_5h)
          )
        : null
    const u7 =
      vm.utilization_7d != null
        ? Math.round(
            Number(vm.utilization_7d) <= 1
              ? Number(vm.utilization_7d) * 100
              : Number(vm.utilization_7d)
          )
        : null
    out.push({
      node_type,
      node_id: vm.id,
      node_key: nodeKeyOf(node_type, vm.id),
      name: vm.name || vm.id,
      email: vm.email || null,
      plan_tier:
        vm.subscription_type || vm.plan_type || vm.account_tier || null,
      runtime_kind,
      dataplane,
      protocol: codex ? 'openai' : 'anthropic',
      weight_tier_mode: vm.schedule_level_mode === 'manual' ? 'manual' : 'auto',
      base_weight_tier:
        Number.isInteger(lvl) && lvl >= 1 && lvl <= 10 ? lvl : 5,
      base_sub_weight: Number(vm.weight) > 0 ? Number(vm.weight) : 10,
      inflight: Number(vm.inflight) || 0,
      max_concurrency: Number(vm.max_concurrency) || 0,
      quota_5h_pct: u5,
      quota_7d_pct: u7,
      healthy:
        vm.schedulable !== false &&
        vm.schedule_state !== 'unschedulable' &&
        vm.schedule_state !== 'off',
      cooldown_until_ms: vm.cooldown_until ?? vm.restriction_until ?? null,
      cooldown_reason: vm.cooldown_reason ?? vm.restriction_text ?? null,
    })
  }
  for (const env of geminiEnvs) {
    const lvl = Number(env.schedule_level)
    out.push({
      node_type: 'gemini_env',
      node_id: env.id,
      node_key: nodeKeyOf('gemini_env', env.id),
      name: env.name || env.id,
      email: env.account?.email || null,
      plan_tier: env.account?.plan || 'gemini',
      runtime_kind: 'gemini',
      protocol: 'gemini',
      weight_tier_mode:
        env.schedule_level_mode === 'manual' ? 'manual' : 'auto',
      base_weight_tier:
        Number.isInteger(lvl) && lvl >= 1 && lvl <= 10 ? lvl : 5,
      base_sub_weight: 10,
      inflight: Number(env.inflight ?? env.active_slots) || 0,
      max_concurrency: Number(env.max_concurrency) || 20,
      quota_5h_pct: null,
      quota_7d_pct: null,
      healthy:
        env.auth_state === 'authorized' &&
        env.schedulable !== false &&
        !env.unschedulable,
      cooldown_until_ms: env.restriction?.until ?? null,
      cooldown_reason: env.restriction?.text ?? null,
    })
  }
  for (const ep of endpoints) {
    const prio = Number(ep.priority)
    out.push({
      node_type: 'api_endpoint',
      node_id: ep.id,
      node_key: nodeKeyOf('api_endpoint', ep.id),
      name: ep.name || ep.id,
      email: ep.base_url || null,
      plan_tier: ep.protocol || ep.kind || 'api',
      runtime_kind: 'api',
      protocol: ep.protocol || null,
      weight_tier_mode: 'manual',
      base_weight_tier:
        Number.isInteger(prio) && prio >= 1 && prio <= 10 ? prio : 5,
      base_sub_weight: 10,
      inflight: 0,
      max_concurrency: 0,
      quota_5h_pct: null,
      quota_7d_pct: null,
      healthy: !ep.disabled,
      cooldown_until_ms: null,
      cooldown_reason: null,
    })
  }
  return out
}

function toMemberInputs(
  members: SchedulerPoolMember[]
): SchedulerPoolMemberInput[] {
  return members.map((m, index) => ({
    node_type: m.node_type,
    node_id: m.node_id,
    enabled: m.enabled !== false,
    member_role: m.member_role === 'standby' ? 'standby' : 'active',
    weight_tier_override: m.weight_tier_override ?? null,
    sub_weight_override: m.sub_weight_override ?? null,
    member_order: Number.isFinite(m.member_order) ? m.member_order : index,
  }))
}

export function PoolMembersTab({
  pool,
  allPools,
}: {
  pool: SchedulerPool
  allPools: SchedulerPool[]
}) {
  const qc = useQueryClient()
  const vmsQ = useQuery(vmsListQueryOptions())
  const geminiQ = useQuery(geminiInventoryOptions())
  const endpointsQ = useQuery(apiEndpointsQueryOptions())

  const candidates = useMemo(
    () =>
      buildCandidates(
        vmsQ.data?.items || [],
        geminiQ.data?.environments || [],
        endpointsQ.data?.items || []
      ),
    [vmsQ.data?.items, geminiQ.data?.environments, endpointsQ.data?.items]
  )
  const candidateMap = useMemo(
    () => new Map(candidates.map((c) => [c.node_key, c])),
    [candidates]
  )

  const [draft, setDraft] = useState<SchedulerPoolMember[]>(
    () => pool.members || []
  )
  const [dirty, setDirty] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  useEffect(() => {
    setDraft(pool.members || [])
    setDirty(false)
  }, [pool.id, pool.members])

  const saveMut = useMutation({
    mutationFn: (members: SchedulerPoolMemberInput[]) =>
      replacePoolMembers(pool.id, members),
    onSuccess: async () => {
      toast.success('成员与权重编排已保存')
      setDirty(false)
      await Promise.all([
        qc.invalidateQueries({ queryKey: SCHEDULER_POOLS_KEY }),
        qc.invalidateQueries({
          queryKey: ['panel', 'scheduler-pools', pool.id],
        }),
      ])
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const unrestMut = useMutation({
    mutationFn: (nodeKey: string) => unrestSchedulerNode(nodeKey),
    onSuccess: async (res, nodeKey) => {
      toast.success(
        `已解除 ${nodeKey} 冷却与 429 下沉${res.woke_waiters ? `，唤醒 ${res.woke_waiters} 个排队请求` : ''}`
      )
      await qc.invalidateQueries({
        queryKey: ['panel', 'scheduler-pools', pool.id],
      })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // 合并实时候选元数据并计算有效等级
  const enriched = useMemo(() => {
    return draft.map((m) => {
      const key = m.node_key || nodeKeyOf(m.node_type, m.node_id)
      const c = candidateMap.get(key)
      const baseTier = m.base_weight_tier ?? c?.base_weight_tier ?? 5
      const effectiveTier =
        m.weight_tier_override ?? m.effective_weight_tier ?? baseTier
      const mode =
        m.weight_tier_override != null
          ? 'manual'
          : (m.weight_tier_mode ?? c?.weight_tier_mode ?? 'auto')
      const conflict = analyzeMemberConflicts({
        targetPool: pool,
        candidate: {
          node_type: m.node_type,
          node_id: m.node_id,
          runtime_kind: m.runtime_kind ?? c?.runtime_kind,
          dataplane: m.dataplane ?? c?.dataplane,
        },
        allPools,
      })
      return {
        member: m,
        key,
        candidate: c,
        effectiveTier,
        weightMode: mode,
        effectiveSubWeight:
          m.sub_weight_override ??
          m.effective_sub_weight ??
          c?.base_sub_weight ??
          10,
        inflight: m.inflight ?? c?.inflight ?? 0,
        maxConcurrency: m.max_concurrency ?? c?.max_concurrency ?? 0,
        quota5h: m.quota_util_5h_pct ?? c?.quota_5h_pct ?? null,
        quota7d: m.quota_util_7d_pct ?? c?.quota_7d_pct ?? null,
        sinkSeq: Number(m.sink_seq) || 0,
        cooldownUntil: m.cooldown_until_ms ?? c?.cooldown_until_ms ?? null,
        cooldownReason: m.cooldown_reason ?? c?.cooldown_reason ?? null,
        healthy: m.healthy ?? c?.healthy ?? true,
        conflict,
      }
    })
  }, [draft, candidateMap, pool, allPools])

  // 按 member_role (active > standby) + effective_weight_tier 降序分层
  const tierGroups = useMemo(() => {
    const groups = new Map<
      string,
      { role: MemberRole; tier: number; items: typeof enriched }
    >()
    const sorted = [...enriched].sort((a, b) => {
      const ra = a.member.member_role === 'standby' ? 1 : 0
      const rb = b.member.member_role === 'standby' ? 1 : 0
      if (ra !== rb) return ra - rb
      if (b.effectiveTier !== a.effectiveTier)
        return b.effectiveTier - a.effectiveTier
      return (a.member.member_order ?? 0) - (b.member.member_order ?? 0)
    })
    for (const item of sorted) {
      const role: MemberRole =
        item.member.member_role === 'standby' ? 'standby' : 'active'
      const gk = `${role}:${item.effectiveTier}`
      const g = groups.get(gk)
      if (g) g.items.push(item)
      else groups.set(gk, { role, tier: item.effectiveTier, items: [item] })
    }
    return [...groups.values()]
  }, [enriched])

  // 检测混用 auto 与 manual=5（PRD §4.2 混排标尺提示）
  const hasMixedAutoAndManual5 = useMemo(() => {
    const hasAuto = enriched.some(
      (i) => i.member.weight_tier_override == null && i.weightMode !== 'manual'
    )
    const hasManual5 = enriched.some(
      (i) => i.weightMode === 'manual' && i.effectiveTier === 5
    )
    return hasAuto && hasManual5
  }, [enriched])

  const hasCragCrossPromptWarning = useMemo(
    () => enriched.some((i) => i.conflict.level === 'warning'),
    [enriched]
  )

  const updateMember = (
    nodeKey: string,
    patch: Partial<SchedulerPoolMember>
  ) => {
    setDraft((prev) =>
      prev.map((m) =>
        (m.node_key || nodeKeyOf(m.node_type, m.node_id)) === nodeKey
          ? { ...m, ...patch }
          : m
      )
    )
    setDirty(true)
  }

  const removeMember = (nodeKey: string) => {
    setDraft((prev) =>
      prev.filter(
        (m) => (m.node_key || nodeKeyOf(m.node_type, m.node_id)) !== nodeKey
      )
    )
    setDirty(true)
  }

  const existingKeys = useMemo(
    () =>
      new Set(
        draft.map((m) => m.node_key || nodeKeyOf(m.node_type, m.node_id))
      ),
    [draft]
  )

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div>
          <h3 className='text-sm font-semibold'>成员与权重等级编排</h3>
          <p className='text-xs text-muted-foreground'>
            按有效权重等级（1–10，数值越高越优先）严格分层调度；仅高权重层无可用容量时才落入下一层。
          </p>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <Button size='sm' variant='outline' onClick={() => setAddOpen(true)}>
            <Plus className='size-3.5' />
            添加成员节点
          </Button>
          {dirty ? (
            <>
              <Button
                size='sm'
                variant='ghost'
                disabled={saveMut.isPending}
                onClick={() => {
                  setDraft(pool.members || [])
                  setDirty(false)
                }}
              >
                撤销
              </Button>
              <Button
                size='sm'
                loading={saveMut.isPending}
                onClick={() => saveMut.mutate(toMemberInputs(draft))}
              >
                <Save className='size-3.5' />
                保存编排
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {hasMixedAutoAndManual5 ? (
        <Alert>
          <AlertTriangle className='size-4' />
          <AlertTitle>池内混排了自动档（auto）与手动 5 级节点</AlertTitle>
          <AlertDescription>
            自动 7D 重置档范围为 1–7（新周期=1、临期=7），与手动 5
            级节点按最终有效等级统一比较；如需固定高优或低优，请为对应成员显式设置池级权重等级覆盖。
          </AlertDescription>
        </Alert>
      ) : null}

      {hasCragCrossPromptWarning ? (
        <Alert className='border-amber-500/50 bg-amber-500/10 text-amber-900 dark:text-amber-200'>
          <AlertTriangle className='size-4' />
          <AlertTitle>
            Anthropic CRAG VM 跨不同 System Prompt 池复用风控提示（D1）
          </AlertTitle>
          <AlertDescription className='text-amber-800 dark:text-amber-200/90'>
            下方带有橙色警示徽章的 CRAG VM 同时加入了不同 System Prompt
            模式的启用池。系统按 D1
            规范允许复用，请留意同一上游账号交替收到官方提示词与 0
            注入请求的风控影响。
          </AlertDescription>
        </Alert>
      ) : null}

      {tierGroups.length === 0 ? (
        <div className='rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground'>
          该分组池暂无成员节点。点击右上角「添加成员节点」跨 Claude VM / Gemini
          邮箱 / Codex VM / API 渠道勾选加入。
        </div>
      ) : (
        <div className='space-y-4'>
          {tierGroups.map((group) => (
            <section
              key={`${group.role}:${group.tier}`}
              className='overflow-hidden rounded-xl border bg-card'
            >
              <div className='flex items-center justify-between border-b bg-muted/40 px-4 py-2'>
                <div className='flex items-center gap-2'>
                  <Badge
                    variant={group.role === 'active' ? 'default' : 'secondary'}
                    className='font-mono text-xs'
                  >
                    Tier {group.tier}
                  </Badge>
                  <span className='text-xs font-medium'>
                    {group.role === 'active'
                      ? '活跃主力层（Active）'
                      : '备用层（Standby · 仅主力层耗尽后启用）'}
                  </span>
                </div>
                <span className='text-xs text-muted-foreground tabular-nums'>
                  {group.items.length} 个节点
                </span>
              </div>

              <div className='divide-y'>
                {group.items.map((row) => {
                  const isCooling =
                    row.cooldownUntil != null && row.cooldownUntil > Date.now()
                  const needsUnrest =
                    isCooling || row.sinkSeq > 0 || !row.healthy
                  return (
                    <div
                      key={row.key}
                      className={cn(
                        'flex flex-wrap items-center gap-3 px-4 py-3 text-sm',
                        !row.member.enabled && 'opacity-60'
                      )}
                    >
                      <div className='min-w-[200px] flex-1 space-y-1'>
                        <div className='flex flex-wrap items-center gap-1.5'>
                          <span className='font-medium'>
                            {row.member.name ||
                              row.candidate?.name ||
                              row.member.node_id}
                          </span>
                          <Badge variant='outline' className='text-[10px]'>
                            {NODE_TYPE_LABELS[row.member.node_type] ||
                              row.member.node_type}
                          </Badge>
                          <WeightTierBadge
                            tier={row.effectiveTier}
                            mode={row.weightMode}
                            override={row.member.weight_tier_override != null}
                          />
                          {row.sinkSeq > 0 ? (
                            <Badge
                              variant='outline'
                              className='border-amber-500/50 bg-amber-500/15 text-[10px] text-amber-800 dark:text-amber-200'
                            >
                              <Flame className='size-3' />
                              429 下沉 #{row.sinkSeq}
                            </Badge>
                          ) : null}
                          {isCooling ? (
                            <Badge
                              variant='destructive'
                              className='text-[10px]'
                              title={row.cooldownReason || undefined}
                            >
                              冷却中
                            </Badge>
                          ) : null}
                          {row.conflict.level === 'warning' ? (
                            <Badge
                              variant='outline'
                              className='border-amber-500/60 bg-amber-500/15 text-[10px] text-amber-800 dark:text-amber-200'
                              title={row.conflict.message}
                            >
                              <AlertTriangle className='size-3' />跨 Prompt
                              池复用
                            </Badge>
                          ) : null}
                        </div>
                        <div className='flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground tabular-nums'>
                          <span>{row.key}</span>
                          {row.member.email || row.candidate?.email ? (
                            <span className='truncate'>
                              {row.member.email || row.candidate?.email}
                            </span>
                          ) : null}
                          <span>
                            并发 {row.inflight}/{row.maxConcurrency || '—'}
                          </span>
                          {row.quota5h != null ? (
                            <span>5H {row.quota5h}%</span>
                          ) : null}
                          {row.quota7d != null ? (
                            <span>7D {row.quota7d}%</span>
                          ) : null}
                        </div>
                      </div>

                      {/* 行内编辑：权重等级覆盖 / sub_weight / active-standby / enabled */}
                      <div className='flex flex-wrap items-center gap-2'>
                        <Select
                          value={
                            row.member.weight_tier_override == null
                              ? 'inherit'
                              : String(row.member.weight_tier_override)
                          }
                          onValueChange={(v) =>
                            updateMember(row.key, {
                              weight_tier_override:
                                v === 'inherit' ? null : Number(v),
                            })
                          }
                        >
                          <SelectTrigger
                            className='h-8 w-28 text-xs'
                            aria-label='权重等级覆盖'
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value='inherit'>跟随节点</SelectItem>
                            {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => (
                              <SelectItem key={n} value={String(n)}>
                                覆盖 T{n}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <div className='flex items-center gap-1'>
                          <span className='text-[11px] text-muted-foreground'>
                            同级权重
                          </span>
                          <Input
                            type='number'
                            min={1}
                            max={1000}
                            placeholder={String(row.effectiveSubWeight)}
                            aria-label='同级子权重'
                            value={row.member.sub_weight_override ?? ''}
                            onChange={(e) => {
                              const raw = e.target.value.trim()
                              updateMember(row.key, {
                                sub_weight_override: raw
                                  ? Math.min(1000, Math.max(1, Number(raw)))
                                  : null,
                              })
                            }}
                            className='h-8 w-20 font-mono text-xs tabular-nums'
                          />
                        </div>

                        <Select
                          value={
                            row.member.member_role === 'standby'
                              ? 'standby'
                              : 'active'
                          }
                          onValueChange={(v) =>
                            updateMember(row.key, {
                              member_role: v as MemberRole,
                            })
                          }
                        >
                          <SelectTrigger
                            className='h-8 w-24 text-xs'
                            aria-label='成员角色'
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value='active'>主力 Active</SelectItem>
                            <SelectItem value='standby'>
                              备用 Standby
                            </SelectItem>
                          </SelectContent>
                        </Select>

                        <Switch
                          checked={row.member.enabled !== false}
                          aria-label={`启停成员 ${row.key}`}
                          onCheckedChange={(enabled) =>
                            updateMember(row.key, { enabled })
                          }
                        />

                        <Button
                          type='button'
                          size='sm'
                          variant={needsUnrest ? 'outline' : 'ghost'}
                          className='h-8 gap-1 px-2 text-xs'
                          disabled={unrestMut.isPending}
                          title='人工解除冷却、清除 429 下沉并唤醒等待队列'
                          onClick={() => unrestMut.mutate(row.key)}
                        >
                          <RotateCcw className='size-3.5' />
                          解除冷却
                        </Button>

                        <Button
                          type='button'
                          size='sm'
                          variant='ghost'
                          className='h-8 px-2 text-destructive hover:text-destructive'
                          aria-label={`移除成员 ${row.key}`}
                          onClick={() => removeMember(row.key)}
                        >
                          <Trash2 className='size-3.5' />
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      <AddMembersDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        pool={pool}
        allPools={allPools}
        candidates={candidates}
        existingKeys={existingKeys}
        onAdd={(picked) => {
          const next = [...draft]
          for (const c of picked) {
            if (existingKeys.has(c.node_key)) continue
            next.push({
              node_type: c.node_type,
              node_id: c.node_id,
              node_key: c.node_key,
              name: c.name,
              email: c.email,
              runtime_kind: c.runtime_kind,
              dataplane: c.dataplane,
              weight_tier_mode: c.weight_tier_mode,
              base_weight_tier: c.base_weight_tier,
              effective_weight_tier: c.base_weight_tier,
              enabled: true,
              member_role: 'active',
              weight_tier_override: null,
              sub_weight_override: null,
              member_order: next.length,
            })
          }
          setDraft(next)
          setDirty(true)
          setAddOpen(false)
        }}
      />
    </div>
  )
}

function AddMembersDialog({
  open,
  onOpenChange,
  pool,
  allPools,
  candidates,
  existingKeys,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pool: SchedulerPool
  allPools: SchedulerPool[]
  candidates: CandidateNode[]
  existingKeys: Set<string>
  onAdd: (picked: CandidateNode[]) => void
}) {
  const [typeFilter, setTypeFilter] = useState<'all' | PoolNodeType>('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!open) return
    setSearch('')
    setSelected(new Set())
    setTypeFilter(
      pool.provider_scope === 'anthropic'
        ? 'claude_vm'
        : pool.provider_scope === 'openai'
          ? 'codex_vm'
          : pool.provider_scope === 'google'
            ? 'gemini_env'
            : pool.provider_scope === 'api'
              ? 'api_endpoint'
              : 'all'
    )
  }, [open, pool.provider_scope])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return candidates
      .filter((c) => !existingKeys.has(c.node_key))
      .filter((c) => typeFilter === 'all' || c.node_type === typeFilter)
      .filter((c) => {
        if (!q) return true
        return [c.name, c.node_id, c.email, c.plan_tier, c.node_key]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(q)
      })
      .map((c) => ({
        node: c,
        conflict: analyzeMemberConflicts({
          targetPool: pool,
          candidate: c,
          allPools,
        }),
      }))
  }, [candidates, existingKeys, typeFilter, search, pool, allPools])

  const selectedWarnings = useMemo(
    () =>
      filtered.filter(
        (item) =>
          selected.has(item.node.node_key) && item.conflict.level === 'warning'
      ),
    [filtered, selected]
  )

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[88dvh] flex-col overflow-hidden sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>添加成员节点到「{pool.name}」</DialogTitle>
          <DialogDescription>
            支持跨 Claude VM、Codex VM、Gemini 邮箱与 API
            渠道搜索勾选。Anthropic CRAG VM 跨不同 Prompt
            池允许复用但会触发风控警告（D1）；旧 cli-node 或独占池冲突将被拦截。
          </DialogDescription>
        </DialogHeader>

        <div className='flex flex-wrap items-center gap-2'>
          {(
            [
              ['all', '全部节点'],
              ['claude_vm', 'Claude VM'],
              ['gemini_env', 'Gemini 邮箱'],
              ['codex_vm', 'Codex VM'],
              ['api_endpoint', 'API 渠道'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type='button'
              onClick={() => setTypeFilter(key)}
              className={cn(
                'cursor-pointer rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                typeFilter === key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className='relative'>
          <Search className='pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground' />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='搜索节点 ID / 名称 / 邮箱 / 套餐…'
            className='h-8 pl-8 text-xs'
          />
        </div>

        {selectedWarnings.length > 0 ? (
          <Alert className='border-amber-500/60 bg-amber-500/10 text-amber-900 dark:text-amber-200'>
            <AlertTriangle className='size-4' />
            <AlertTitle>
              已勾选 {selectedWarnings.length} 台跨不同 Prompt 模式的 Anthropic
              CRAG VM
            </AlertTitle>
            <AlertDescription className='text-xs text-amber-800 dark:text-amber-200/90'>
              按 D1 规范允许添加到本池，但同一 CRAG
              账号在不同池间切换提示词可能带来上游风控风险。
            </AlertDescription>
          </Alert>
        ) : null}

        <div className='min-h-0 flex-1 space-y-1.5 overflow-y-auto rounded-lg border p-2'>
          {filtered.length === 0 ? (
            <p className='py-6 text-center text-xs text-muted-foreground'>
              没有可添加的候选节点
            </p>
          ) : (
            filtered.map(({ node, conflict }) => {
              const blocked = conflict.level === 'blocked'
              const warn = conflict.level === 'warning'
              const checked = selected.has(node.node_key)
              return (
                <label
                  key={node.node_key}
                  className={cn(
                    'flex items-start gap-2.5 rounded-lg border p-2.5 text-xs transition-colors',
                    blocked
                      ? 'cursor-not-allowed border-destructive/30 bg-destructive/5 opacity-70'
                      : warn
                        ? 'cursor-pointer border-amber-500/40 bg-amber-500/5 hover:bg-amber-500/10'
                        : checked
                          ? 'cursor-pointer border-primary/50 bg-primary/5'
                          : 'cursor-pointer border-transparent hover:bg-muted/50'
                  )}
                >
                  <Checkbox
                    checked={checked}
                    disabled={blocked}
                    onCheckedChange={() => !blocked && toggle(node.node_key)}
                    className='mt-0.5'
                  />
                  <div className='min-w-0 flex-1 space-y-1'>
                    <div className='flex flex-wrap items-center gap-1.5'>
                      <span className='font-medium'>{node.name}</span>
                      <Badge variant='outline' className='text-[10px]'>
                        {NODE_TYPE_LABELS[node.node_type]}
                      </Badge>
                      <WeightTierBadge
                        tier={node.base_weight_tier}
                        mode={node.weight_tier_mode}
                      />
                      {node.plan_tier ? (
                        <span className='rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground'>
                          {node.plan_tier}
                        </span>
                      ) : null}
                      {warn ? (
                        <Badge
                          variant='outline'
                          className='border-amber-500/60 bg-amber-500/15 text-[10px] text-amber-800 dark:text-amber-200'
                        >
                          <AlertTriangle className='size-3' />跨 Prompt
                          池警告（允许）
                        </Badge>
                      ) : null}
                      {blocked ? (
                        <Badge variant='destructive' className='text-[10px]'>
                          <Ban className='size-3' />
                          已拦截
                        </Badge>
                      ) : null}
                    </div>
                    <div className='font-mono text-[11px] text-muted-foreground'>
                      {node.node_key}
                      {node.email ? ` · ${node.email}` : ''}
                    </div>
                    {conflict.level !== 'ok' ? (
                      <p
                        className={cn(
                          'text-[11px] leading-4',
                          blocked
                            ? 'text-destructive'
                            : 'text-amber-700 dark:text-amber-300'
                        )}
                      >
                        {conflict.message}
                      </p>
                    ) : null}
                  </div>
                </label>
              )
            })
          )}
        </div>

        <DialogFooter>
          <Button
            type='button'
            variant='outline'
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type='button'
            disabled={selected.size === 0}
            onClick={() =>
              onAdd(
                filtered
                  .filter((item) => selected.has(item.node.node_key))
                  .map((item) => item.node)
              )
            }
          >
            加入已选 ({selected.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
