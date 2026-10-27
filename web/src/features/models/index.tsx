import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useBlocker } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { SyncStatus } from '@/types/panel-pricing'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtAgo } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import {
  modelPolicyQueryOptions,
  pricingQueryOptions,
} from '@/features/models/queries'
import { EntryStrip } from './entry-strip'
import { ImageToolSection } from './image-tool-section'
import { ModelAdvanced } from './model-advanced'
import { mappingTargets } from './model-mapping'
import { ModelMappingCard } from './model-mapping-card'
import { ModelRow } from './model-row'
import { resetConfirmText, syncConfirmText } from './page-messages'
import {
  type BetaFilter,
  type CatalogMode,
  type ModelEntry,
  type ModelParams,
  type ModelPolicy,
  type Pass1mMode,
  type PolicyDefaults,
  type PolicyPayload,
  applyPassContext1m,
  cloneJson,
  familyOptions,
  filterModels,
  hydratePolicy,
  listModelEntries,
  policyStats,
} from './policy'
import { PricingTab } from './pricing-tab'

const BETA_FILTERS: [BetaFilter, string][] = [
  ['all', '全部'],
  ['pass', '透传 1M'],
  ['strip', '剥离'],
  ['inherit', '跟随通配'],
]

export function ModelsPage() {
  const qc = useQueryClient()
  const [pageTab, setPageTab] = useState<'models' | 'pricing'>('models')
  const [catalogPlatform, setCatalogPlatform] = useState<
    'anthropic' | 'openai'
  >('anthropic')
  const q = useQuery(modelPolicyQueryOptions(catalogPlatform))
  const pricingQ = useQuery(pricingQueryOptions())
  const [draft, setDraft] = useState<ModelPolicy>(() => hydratePolicy(null))
  const [savedSnap, setSavedSnap] = useState('')
  const [qtext, setQtext] = useState('')
  const [family, setFamily] = useState('all')
  const [beta, setBeta] = useState<BetaFilter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    if (!q.data) return
    const pol = hydratePolicy(q.data.policy)
    setDraft(pol)
    setSavedSnap(JSON.stringify(pol))
  }, [q.data])

  const all = useMemo(() => listModelEntries(draft), [draft])
  const effectiveIds = useMemo(() => {
    const ids = new Set<string>()
    for (const row of q.data?.effective || []) {
      if (row.id) ids.add(row.id)
    }
    return ids
  }, [q.data?.effective])
  const visible = useMemo(
    () => filterModels(all, draft, qtext, family, beta),
    [all, draft, qtext, family, beta]
  )
  const families = useMemo(() => familyOptions(all), [all])
  const stats = policyStats(all, draft, effectiveIds)
  const dirty = JSON.stringify(draft) !== savedSnap

  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (!dirty) return
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [dirty])

  // beforeunload only covers tab close/reload — client-side route changes
  // (sidebar nav, browser back) go through the router and never fire it.
  useBlocker({
    shouldBlockFn: () => {
      if (!dirty) return false
      return !window.confirm(
        '有未保存更改。离开模型页会丢弃这些改动，确认离开？'
      )
    },
    enableBeforeUnload: false,
  })

  const save = useMutation({
    mutationFn: () =>
      api('/api/panel/model-policy', {
        method: 'PUT',
        body: JSON.stringify({ policy: draft, platform: catalogPlatform }),
      }),
    onSuccess: async () => {
      toast.success('模型策略已保存')
      await qc.invalidateQueries({
        queryKey: modelPolicyQueryOptions(catalogPlatform).queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const reset = useMutation({
    mutationFn: () =>
      api('/api/panel/model-policy/reset', {
        method: 'POST',
        body: JSON.stringify({ platform: catalogPlatform }),
      }),
    onSuccess: async () => {
      toast.success('已恢复默认')
      await qc.invalidateQueries({
        queryKey: modelPolicyQueryOptions(catalogPlatform).queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const sync = useMutation({
    mutationFn: () =>
      api<PolicyPayload>('/api/panel/model-policy/sync-worker', {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: async (data) => {
      toast.success(`已同步 Worker 目录 (${data.synced || 0})`)
      await qc.invalidateQueries({
        queryKey: modelPolicyQueryOptions('anthropic').queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const syncGpt = useMutation({
    mutationFn: () =>
      api<PolicyPayload>('/api/panel/model-policy/sync-codex', {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: async (data) => {
      toast.success(`已同步 GPT 目录 (${data.synced || 0})`)
      await qc.invalidateQueries({
        queryKey: modelPolicyQueryOptions('openai').queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  function patchModel(id: string, fn: (rec: Omit<ModelEntry, 'id'>) => void) {
    setDraft((prev) => {
      const next = cloneJson(prev)
      const rec = next.models?.[id]
      if (!rec) return prev
      fn(rec)
      return next
    })
  }

  function setParam(
    id: string,
    key: keyof ModelParams,
    value: string | number
  ) {
    patchModel(id, (rec) => {
      rec.params = rec.params || {}
      if (key === 'on_enabled') {
        rec.params.on_enabled =
          value === 'convert_to_adaptive' ? 'passthrough' : String(value)
        return
      }
      if (key === 'on_adaptive') {
        rec.params.on_adaptive = String(value)
        return
      }
      if (key === 'default_effort') {
        const effort = String(value)
        rec.params.default_effort =
          effort === 'off' ||
          effort === 'low' ||
          effort === 'medium' ||
          effort === 'high' ||
          effort === 'xhigh' ||
          effort === 'max'
            ? effort
            : ''
        return
      }
      rec.params[key] = Number(value) || 0
    })
  }

  function batch(action: 'enable' | 'disable' | 'invert') {
    setDraft((prev) => {
      const next = cloneJson(prev)
      for (const rec of Object.values(next.models || {})) {
        if (action === 'enable') rec.enabled = true
        else if (action === 'disable') rec.enabled = false
        else rec.enabled = rec.enabled === false
      }
      return next
    })
  }

  function requestExpand(id: string) {
    if (expanded && expanded !== id && dirty) {
      const ok = window.confirm(
        '有未保存更改。切换模型不会丢草稿，离开页面前请先保存。仍要切换？'
      )
      if (!ok) return
    }
    setExpanded((cur) => (cur === id ? null : id))
  }

  function setImageTool(id: string, on: boolean) {
    setDraft((prev) => {
      const next = cloneJson(prev)
      next.image_tools = { ...(next.image_tools || {}), [id]: { enabled: on } }
      return next
    })
  }

  function setPass1m(id: string, mode: Pass1mMode) {
    patchModel(id, (rec) => applyPassContext1m(rec, mode))
  }

  function patchDefaults(patch: Partial<PolicyDefaults>) {
    setDraft((prev) => {
      const next = cloneJson(prev)
      next.defaults = { ...(next.defaults || {}), ...patch }
      return next
    })
  }

  function setCatalog(mode: CatalogMode) {
    setDraft((prev) => {
      const next = cloneJson(prev)
      next.catalog_mode = mode
      return next
    })
  }

  function switchPlatform(next: 'anthropic' | 'openai') {
    if (next === catalogPlatform) return
    if (
      dirty &&
      !window.confirm('有未保存更改。切换号池会丢弃这些改动，确认切换？')
    ) {
      return
    }
    setCatalogPlatform(next)
    setQtext('')
    setFamily('all')
    setBeta('all')
    setExpanded(null)
  }

  const claudePool = catalogPlatform === 'anthropic'
  const imageTools = q.data?.image_tools || []
  // Mapping targets follow the saved policy: the server validates against it.
  const gptTargets = claudePool ? [] : mappingTargets(q.data?.models || [])
  const imageIds = imageTools.flatMap((m) => [m.id, ...m.snapshots])
  const poolHint = claudePool
    ? 'Claude 号池。同一会话只占一个 VM session 窗口，不和 GPT 混调度。'
    : 'GPT 号池。粘性独立，不占用 Claude 原生 session 槽。'

  return (
    <PageHeader
      title={VIEW_TITLES.models}
      description='对外模型目录、模型参数、覆写别名与官方计费配置。'
      fluid
      extra={
        pageTab === 'models' ? (
          <div className='flex flex-wrap gap-2'>
            {claudePool ? (
              <Button
                variant='outline'
                className='cursor-pointer'
                onClick={() => {
                  const ask = syncConfirmText(dirty, ' Worker ')
                  if (ask && !window.confirm(ask)) return
                  sync.mutate()
                }}
                disabled={sync.isPending}
              >
                {sync.isPending ? '同步中…' : '同步 Worker'}
              </Button>
            ) : (
              <Button
                variant='outline'
                className='cursor-pointer'
                onClick={() => {
                  const ask = syncConfirmText(dirty, ' GPT ')
                  if (ask && !window.confirm(ask)) return
                  syncGpt.mutate()
                }}
                disabled={syncGpt.isPending}
              >
                {syncGpt.isPending ? '同步中…' : '同步 GPT'}
              </Button>
            )}
            <Button
              variant='outline'
              className='cursor-pointer'
              onClick={() => {
                if (!window.confirm(resetConfirmText(dirty))) return
                reset.mutate()
              }}
              disabled={reset.isPending}
            >
              恢复默认
            </Button>
            <Button
              variant={dirty ? 'default' : 'outline'}
              className='cursor-pointer'
              onClick={() => save.mutate()}
              disabled={save.isPending || !dirty}
            >
              {dirty ? '保存更改' : '已保存'}
            </Button>
          </div>
        ) : undefined
      }
    >
      <Tabs
        value={pageTab}
        onValueChange={(value) => {
          if (value === 'models' || value === 'pricing') setPageTab(value)
        }}
        className='gap-4'
      >
        <TabsList aria-label='模型页分区'>
          <TabsTrigger value='models' className='cursor-pointer px-4'>
            模型
          </TabsTrigger>
          <TabsTrigger value='pricing' className='cursor-pointer px-4'>
            计费
          </TabsTrigger>
        </TabsList>
        <TabsContent value='models'>
          <EntryStrip />
          <QueryGate
            loading={q.isLoading}
            error={q.error}
            skeleton={
              <div className='space-y-3'>
                <div className='h-32 rounded-2xl bg-muted' />
                <div className='grid gap-3 md:grid-cols-2 xl:grid-cols-3'>
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className='h-44 rounded-xl bg-muted' />
                  ))}
                </div>
              </div>
            }
          >
            <div className='space-y-4'>
              <section className='rounded-2xl border border-border/70 bg-card p-4 shadow-sm'>
                <div className='grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end'>
                  <div className='min-w-0 space-y-3'>
                    <Tabs
                      value={catalogPlatform}
                      onValueChange={(value) => {
                        if (value === 'anthropic' || value === 'openai') {
                          switchPlatform(value)
                        }
                      }}
                    >
                      <TabsList aria-label='模型平台'>
                        <TabsTrigger
                          value='anthropic'
                          className='cursor-pointer px-4'
                        >
                          Anthropic
                        </TabsTrigger>
                        <TabsTrigger
                          value='openai'
                          className='cursor-pointer px-4'
                        >
                          OpenAI
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                    <div className='max-w-3xl space-y-1'>
                      <h3 className='text-xl font-semibold tracking-tight'>
                        {claudePool
                          ? 'Claude 官方模型矩阵'
                          : 'GPT / Codex 官方模型矩阵'}
                      </h3>
                      <p className='text-sm leading-6 text-muted-foreground'>
                        {poolHint}
                      </p>
                      <CatalogSyncBar
                        claude={pricingQ.data?.catalog_sync?.claude ?? null}
                        codex={pricingQ.data?.catalog_sync?.codex ?? null}
                      />
                    </div>
                  </div>
                  <div className='grid grid-cols-2 gap-2 sm:grid-cols-4 lg:w-[28rem]'>
                    <PoolStat label='配置' value={stats.configured} />
                    <PoolStat label='启用' value={stats.enabled} />
                    <PoolStat label='对外' value={stats.live} />
                    <PoolStat
                      label={claudePool ? '1M beta' : '未对外'}
                      value={
                        claudePool
                          ? stats.pass1m
                          : all.filter((m) => !effectiveIds.has(m.id)).length
                      }
                    />
                  </div>
                </div>
              </section>

              {claudePool ? null : (
                <ModelMappingCard targets={gptTargets} imageIds={imageIds} />
              )}

              {dirty ? (
                <p
                  role='status'
                  className='flex items-center gap-2 rounded-xl border border-[color:var(--status-caution)]/40 bg-[color:var(--status-caution)]/10 px-3 py-2 text-sm text-foreground'
                >
                  <AlertTriangle className='size-4 shrink-0 text-[color:var(--status-caution)]' />
                  有未保存更改。离开页面或切换平台前请先保存。
                </p>
              ) : null}

              {claudePool ? (
                <section className='rounded-2xl border border-primary/20 bg-primary/[0.035] p-4'>
                  <div className='grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center'>
                    <div className='space-y-1'>
                      <h3 className='font-semibold'>
                        Haiku 5.5 · 100K 实用模型
                      </h3>
                      <p className='text-sm leading-6 text-muted-foreground'>
                        默认策略把 claude-haiku-5-5 的上下文窗口、默认
                        max_tokens、输出上限统一收敛到 100K，避免超过官方 Haiku
                        5.5 长上下文计费阈值。
                      </p>
                    </div>
                    <Button
                      variant='outline'
                      onClick={() => {
                        setQtext('claude-haiku-5-5')
                        setFamily('all')
                        setBeta('all')
                        setExpanded('claude-haiku-5-5')
                      }}
                    >
                      打开 Haiku 5.5
                    </Button>
                  </div>
                </section>
              ) : null}

              <section className='rounded-2xl border border-border/70 bg-card p-3 shadow-sm'>
                <div className='grid gap-2 lg:grid-cols-[18rem_minmax(0,1fr)_auto] lg:items-center'>
                  <Input
                    className='w-full'
                    type='search'
                    placeholder='搜索模型 / 别名…'
                    aria-label='搜索模型'
                    value={qtext}
                    onChange={(e) => setQtext(e.target.value)}
                  />
                  <div className='flex flex-wrap gap-1.5'>
                    {families.map((f) => (
                      <Button
                        key={f}
                        size='sm'
                        className='cursor-pointer'
                        variant={family === f ? 'default' : 'outline'}
                        onClick={() => setFamily(f)}
                      >
                        {f === 'all' ? '全部' : f}
                      </Button>
                    ))}
                    {claudePool
                      ? BETA_FILTERS.map(([id, lab]) => (
                          <Button
                            key={id}
                            size='sm'
                            className='cursor-pointer'
                            variant={beta === id ? 'secondary' : 'ghost'}
                            onClick={() => setBeta(id)}
                          >
                            {lab}
                          </Button>
                        ))
                      : null}
                  </div>
                  <div className='flex flex-wrap gap-1.5 lg:justify-end'>
                    <Button
                      size='sm'
                      variant='ghost'
                      onClick={() => batch('enable')}
                    >
                      全开
                    </Button>
                    <Button
                      size='sm'
                      variant='ghost'
                      onClick={() => batch('disable')}
                    >
                      全关
                    </Button>
                    <Button
                      size='sm'
                      variant='ghost'
                      onClick={() => batch('invert')}
                    >
                      反选
                    </Button>
                  </div>
                </div>
              </section>

              {visible.length === 0 ? (
                <EmptyState
                  reason={
                    qtext || family !== 'all' || beta !== 'all'
                      ? '无匹配模型。改搜索或筛选条件。'
                      : claudePool
                        ? '暂无模型配置。可先同步 Worker 目录。'
                        : '暂无 GPT 模型。可先同步 GPT 目录。'
                  }
                />
              ) : (
                <div className='grid gap-3 md:grid-cols-2 xl:grid-cols-3'>
                  {visible.map((m) => (
                    <ModelRow
                      key={m.id}
                      model={m}
                      live={effectiveIds.has(m.id)}
                      pol={draft}
                      pricing={pricingQ.data?.policy?.[m.id]}
                      open={expanded === m.id}
                      platform={catalogPlatform}
                      onToggleOpen={() => requestExpand(m.id)}
                      onToggleEnabled={(on) =>
                        patchModel(m.id, (rec) => {
                          rec.enabled = on
                        })
                      }
                      onModel={(fn) => patchModel(m.id, fn)}
                      onParam={(key, value) => setParam(m.id, key, value)}
                      onPass1m={(mode) => setPass1m(m.id, mode)}
                    />
                  ))}
                </div>
              )}

              {claudePool ? (
                <ModelAdvanced
                  pol={draft}
                  onCatalogMode={setCatalog}
                  onDefaults={patchDefaults}
                />
              ) : (
                <ImageToolSection
                  models={imageTools}
                  enabled={draft.image_tools}
                  pricing={pricingQ.data?.policy}
                  onToggle={setImageTool}
                />
              )}
            </div>
          </QueryGate>
        </TabsContent>
        <TabsContent value='pricing'>
          <PricingTab />
        </TabsContent>
      </Tabs>
    </PageHeader>
  )
}

function PoolStat({ label, value }: { label: string; value: number }) {
  return (
    <div className='rounded-xl border border-border/70 bg-background/60 px-3 py-2'>
      <div className='text-[11px] font-medium tracking-wide text-muted-foreground'>
        {label}
      </div>
      <div className='field-count mt-1 text-lg font-semibold'>{value}</div>
    </div>
  )
}

function CatalogSyncBar({
  claude,
  codex,
}: {
  claude: SyncStatus | null
  codex: SyncStatus | null
}) {
  return (
    <div className='space-y-0.5 text-xs leading-5 text-muted-foreground'>
      <p>{formatCatalogSync('Claude', claude)}</p>
      <p>{formatCatalogSync('GPT', codex)}</p>
    </div>
  )
}

function formatCatalogSync(label: string, sync: SyncStatus | null): string {
  if (!sync) return `${label} 尚未自动同步`
  const when = fmtAgo(sync.at) || sync.at
  const added = sync.added || []
  const addedText = added.length
    ? `新增 ${added.length}：${added.slice(0, 8).join(', ')}${
        added.length > 8 ? '…' : ''
      }`
    : '无新增'
  if (sync.status === 'ok') return `${label} ${when} · 成功 · ${addedText}`
  if (sync.status === 'skipped') {
    return `${label} ${when} · 跳过${sync.error ? `：${sync.error}` : ''}`
  }
  return `${label} ${when} · 失败${sync.error ? `：${sync.error}` : ''}`
}
