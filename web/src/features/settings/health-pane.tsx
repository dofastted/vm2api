import { type ComponentProps, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, Plus, RefreshCw, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import {
  healthProbeQueryOptions,
  runHealthProbe,
  type HealthCatalogModel,
  type HealthModelSnapshotView,
  type HealthProbePlatform,
  type HealthSnapshotView,
} from '@/features/settings/queries'
import { settleInt, typingInt } from './int-input'

type Obj = Record<string, unknown>

type HealthPaneProps = {
  title: string
  failover: Obj
  healthProbe: Obj | undefined
  compatibility: Obj
  onFailoverChange?: (next: Obj) => void
  onHealthProbeChange: (next: Obj) => void
  onCompatibilityChange: (next: Obj) => void
}

type PlatformDraft = {
  enabled: boolean
  interval_sec: number
  cache_ttl_sec: number
  all_models: boolean
  models: string[]
  probe_all_slots?: boolean
}

type PlatformMeta = {
  id: HealthProbePlatform
  name: string
  cardTitle: string
  subtitle: string
  minInterval: number
  minTtl: number
  defaultInterval: number
  defaultTtl: number
  supportsAllSlots: boolean
  allModelsDesc: string
  emptyModelsHint: string
  customPlaceholder: string
}

const PLATFORM_METAS: readonly PlatformMeta[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    cardTitle: 'Anthropic 健康缓存',
    subtitle: 'Claude 槽位 · 覆盖 /v1/messages 及映射入站的流式与非流式探测。',
    minInterval: 30,
    minTtl: 30,
    defaultInterval: 600,
    defaultTtl: 900,
    supportsAllSlots: true,
    allModelsDesc:
      '开启后自动覆盖 Anthropic 模型矩阵中全部已启用模型（排除 auto 并按别名去重），新同步模型自动生效。',
    emptyModelsHint: '未选择任何模型时，Anthropic 探测请求均直接进入调度池。',
    customPlaceholder: '如 claude-sonnet-4-6',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    cardTitle: 'OpenAI 健康缓存',
    subtitle:
      'GPT / Codex 槽位 · 覆盖 /v1/responses 与 /v1/chat/completions 探测。',
    minInterval: 30,
    minTtl: 30,
    defaultInterval: 600,
    defaultTtl: 900,
    supportsAllSlots: true,
    allModelsDesc:
      '开启后自动覆盖 OpenAI 模型矩阵中全部已启用对话模型（自动排除图像模型），新同步模型自动生效。',
    emptyModelsHint: '未选择任何模型时，OpenAI 探测请求均直接进入调度池。',
    customPlaceholder: '如 gpt-5.4',
  },
  {
    id: 'google',
    name: 'Google',
    cardTitle: 'Google 健康缓存',
    subtitle:
      'Gemini 槽位 · 覆盖 Gemini 原生、OpenAI、Anthropic 协议的 Gemini 模型探测。',
    minInterval: 60,
    minTtl: 60,
    defaultInterval: 3600,
    defaultTtl: 5400,
    supportsAllSlots: false,
    allModelsDesc:
      '开启后自动覆盖 Google 模型矩阵中已启用且当前在线槽位支持的全部 Gemini 模型（自动跳过无账号支持的模型）。',
    emptyModelsHint:
      '未勾选具体模型时，将自动选取在线槽位中的轻量 Gemini 模型进行探测。',
    customPlaceholder: '如 gemini-3-flash',
  },
] as const

function obj(value: unknown): Obj {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Obj)
    : {}
}

function normalizeModelIds(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,，\n]+/)
      : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const id = String(item ?? '').trim()
    const key = id.toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(id)
  }
  return out
}

function hasExplicitPlatformBlocks(probe: Obj): boolean {
  return (
    (probe.anthropic != null && typeof probe.anthropic === 'object') ||
    (probe.openai != null && typeof probe.openai === 'object') ||
    (probe.google != null && typeof probe.google === 'object')
  )
}

function readPlatformDraft(probe: Obj, meta: PlatformMeta): PlatformDraft {
  const explicit = hasExplicitPlatformBlocks(probe)
  const legacyEnabled = probe.enabled === true
  const real = obj(probe.real)
  const gemini = obj(probe.gemini)
  const block = obj(probe[meta.id])
  const hasBlock = probe[meta.id] != null && typeof probe[meta.id] === 'object'

  if (meta.id === 'anthropic') {
    const fallbackModels = normalizeModelIds(
      real.model ? [real.model] : ['claude-haiku-4-5']
    )
    const models =
      hasBlock && 'models' in block
        ? normalizeModelIds(block.models)
        : fallbackModels
    return {
      enabled: hasBlock
        ? block.enabled === true
        : explicit
          ? false
          : legacyEnabled,
      interval_sec: Number(
        block.interval_sec ??
          (explicit
            ? meta.defaultInterval
            : (probe.interval_sec ?? meta.defaultInterval))
      ),
      cache_ttl_sec: Number(
        block.cache_ttl_sec ??
          (explicit
            ? meta.defaultTtl
            : (probe.cache_ttl_sec ?? probe.max_stale_sec ?? meta.defaultTtl))
      ),
      all_models: block.all_models === true,
      models,
      probe_all_slots: hasBlock
        ? block.probe_all_slots === true
        : explicit
          ? false
          : probe.probe_all_slots === true,
    }
  }

  if (meta.id === 'openai') {
    const fallbackModels = normalizeModelIds(
      real.openai_model ? [real.openai_model] : []
    )
    const models =
      hasBlock && 'models' in block
        ? normalizeModelIds(block.models)
        : fallbackModels
    return {
      enabled: hasBlock
        ? block.enabled === true
        : explicit
          ? false
          : legacyEnabled && models.length > 0,
      interval_sec: Number(
        block.interval_sec ??
          (explicit
            ? meta.defaultInterval
            : (probe.interval_sec ?? meta.defaultInterval))
      ),
      cache_ttl_sec: Number(
        block.cache_ttl_sec ??
          (explicit
            ? meta.defaultTtl
            : (probe.cache_ttl_sec ?? probe.max_stale_sec ?? meta.defaultTtl))
      ),
      all_models: block.all_models === true,
      models,
      probe_all_slots: hasBlock
        ? block.probe_all_slots === true
        : explicit
          ? false
          : probe.probe_all_slots === true,
    }
  }

  const fallbackModels =
    'models' in gemini
      ? normalizeModelIds(gemini.models)
      : normalizeModelIds(gemini.model ? [gemini.model] : [])
  const models =
    hasBlock && 'models' in block
      ? normalizeModelIds(block.models)
      : fallbackModels
  return {
    enabled: hasBlock
      ? block.enabled === true
      : explicit
        ? false
        : legacyEnabled && gemini.enabled !== false,
    interval_sec: Number(
      block.interval_sec ?? gemini.interval_sec ?? meta.defaultInterval
    ),
    cache_ttl_sec: Number(
      block.cache_ttl_sec ?? gemini.cache_ttl_sec ?? meta.defaultTtl
    ),
    all_models: hasBlock
      ? block.all_models === true
      : gemini.all_models === true,
    models,
  }
}

/**
 * 输入时不限范围（否则键入「120」第一个键就被拉成 30），失焦时再限到 [min, max]。
 * 未失焦直接保存时由网关按同样范围收口。
 */
function DeferredIntInput({
  value,
  min,
  max,
  fallback,
  onCommit,
  ...props
}: Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'onBlur'> & {
  value: number
  min: number
  max: number
  fallback: number
  onCommit: (next: number) => void
}) {
  const [text, setText] = useState<string | null>(null)
  return (
    <Input
      {...props}
      type='number'
      min={min}
      max={max}
      value={text ?? String(value)}
      onChange={(event) => {
        setText(event.target.value)
        const n = typingInt(event.target.value)
        if (n !== null) onCommit(n)
      }}
      onBlur={() => {
        if (text === null) return
        const settled = settleInt(text, min, max, fallback)
        setText(null)
        if (settled !== value) onCommit(settled)
      }}
    />
  )
}

export function HealthPane(props: HealthPaneProps) {
  const {
    title,
    failover,
    healthProbe,
    compatibility,
    onHealthProbeChange,
    onCompatibilityChange,
  } = props
  const probe = obj(healthProbe)
  const minTokens = obj(compatibility.min_max_tokens)
  const setProbe = (patch: Obj) => onHealthProbeChange({ ...probe, ...patch })
  const minTokensMode = String(minTokens.mode ?? minTokens.tier ?? '').trim()
  const explicitFloor = ['floor', 'default', 'raise'].includes(minTokensMode)
  // Match the backend: an explicit mode takes precedence over legacy flags.
  const preserveCaller =
    ['不改', 'preserve', 'unchanged'].includes(minTokensMode) ||
    (!explicitFloor &&
      (minTokens.no_raise === true || minTokens.raise === false))
  const setMinTokens = (patch: Obj) =>
    onCompatibilityChange({
      ...compatibility,
      min_max_tokens: {
        enabled: true,
        value: 128,
        mode: 'floor',
        ...minTokens,
        ...patch,
      },
    })

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <p className='text-xs text-muted-foreground'>
            探测和测试请求在进入调度前就地应答，不占并发、会话席位和粘性。
          </p>
        </CardHeader>
        <CardContent className='divide-y'>
          <SettingRow
            label='拦截预热请求'
            desc='仅 Claude 模型的 /v1/messages。Claude Code 的 Warmup、标题生成、SUGGESTION MODE、haiku max_tokens=1 连通性检查直接返回模拟响应，不打上游。'
          >
            <Switch
              checked={probe.intercept_warmup === true}
              onCheckedChange={(checked) =>
                setProbe({ intercept_warmup: checked })
              }
              aria-label='拦截预热请求'
            />
          </SettingRow>
          <SettingRow
            label='thinking 合法间隔'
            desc='未写 max_tokens 时用模型目录 max_tokens_default。写了且低于此值时，「默认抬升」模式会抬到该值，「不改」模式则保留原值；当开启 thinking 且 budget_tokens 不小于 max_tokens 时补足合法间隔。关闭右侧总开关后，将同时停用缺失默认抬升与 budget_tokens 间隔补齐。'
          >
            <div className='flex flex-col items-end gap-3 sm:flex-row sm:flex-wrap sm:items-center'>
              <DeferredIntInput
                className='w-24'
                min={1}
                max={4096}
                fallback={128}
                disabled={minTokens.enabled === false}
                value={Number(minTokens.value ?? 128)}
                onCommit={(next) => setMinTokens({ value: next })}
                aria-label='thinking 合法间隔'
              />
              <div
                className='flex flex-wrap gap-2'
                role='group'
                aria-label='max_tokens 抬升模式'
              >
                <Button
                  type='button'
                  size='sm'
                  variant={preserveCaller ? 'outline' : 'default'}
                  className='min-h-11'
                  aria-pressed={!preserveCaller}
                  disabled={minTokens.enabled === false}
                  onClick={() =>
                    setMinTokens({
                      mode: 'floor',
                      no_raise: false,
                      raise: true,
                    })
                  }
                >
                  默认抬升
                </Button>
                <Button
                  type='button'
                  size='sm'
                  variant={preserveCaller ? 'default' : 'outline'}
                  className='min-h-11'
                  aria-pressed={preserveCaller}
                  disabled={minTokens.enabled === false}
                  onClick={() =>
                    setMinTokens({ mode: '不改', no_raise: true, raise: false })
                  }
                >
                  不改
                </Button>
              </div>
              <label className='flex items-center gap-2 text-xs text-muted-foreground'>
                <Switch
                  checked={minTokens.enabled !== false}
                  onCheckedChange={(checked) =>
                    setMinTokens({ enabled: checked })
                  }
                  aria-label='启用 thinking 合法间隔'
                />
                <span>启用默认抬升与间隔补齐</span>
              </label>
            </div>
          </SettingRow>
        </CardContent>
      </Card>
      <PlatformHealthCacheSection
        probe={probe}
        onProbeReplace={onHealthProbeChange}
      />
      <SignatureRepairCard failover={failover} />
    </>
  )
}

function PlatformHealthCacheSection({
  probe,
  onProbeReplace,
}: {
  probe: Obj
  onProbeReplace: (next: Obj) => void
}) {
  const queryClient = useQueryClient()
  const status = useQuery(healthProbeQueryOptions())
  const [probingTarget, setProbingTarget] = useState<string | null>(null)
  const probeNow = useMutation({
    mutationFn: ({
      platform,
      model,
    }: {
      platform: 'all' | HealthProbePlatform
      model?: string
    }) => runHealthProbe(platform, model),
    onMutate: ({ platform, model }) => {
      setProbingTarget(model ? `${platform}:${model}` : platform)
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['panel', 'health-probe'], data)
    },
    onSettled: () => {
      setProbingTarget(null)
    },
  })

  const drafts: Record<HealthProbePlatform, PlatformDraft> = {
    anthropic: readPlatformDraft(probe, PLATFORM_METAS[0]),
    openai: readPlatformDraft(probe, PLATFORM_METAS[1]),
    google: readPlatformDraft(probe, PLATFORM_METAS[2]),
  }

  const updatePlatform = (
    platform: HealthProbePlatform,
    patch: Partial<PlatformDraft>
  ) => {
    const nextDrafts: Record<HealthProbePlatform, PlatformDraft> = {
      ...drafts,
      [platform]: { ...drafts[platform], ...patch },
    }
    const baseAnthropic = { ...obj(probe.anthropic), ...nextDrafts.anthropic }
    const baseOpenai = { ...obj(probe.openai), ...nextDrafts.openai }
    const baseGoogle = { ...obj(probe.google), ...nextDrafts.google }
    const anyEnabled =
      nextDrafts.anthropic.enabled ||
      nextDrafts.openai.enabled ||
      nextDrafts.google.enabled
    onProbeReplace({
      ...probe,
      enabled: anyEnabled,
      interval_sec: nextDrafts.anthropic.interval_sec,
      cache_ttl_sec: nextDrafts.anthropic.cache_ttl_sec,
      max_stale_sec: nextDrafts.anthropic.cache_ttl_sec,
      probe_all_slots: nextDrafts.anthropic.probe_all_slots === true,
      anthropic: baseAnthropic,
      openai: baseOpenai,
      google: baseGoogle,
      real: {
        ...obj(probe.real),
        model: nextDrafts.anthropic.models[0] || 'claude-haiku-4-5',
        openai_model: nextDrafts.openai.models[0] || '',
      },
      gemini: {
        ...obj(probe.gemini),
        enabled: nextDrafts.google.enabled,
        interval_sec: nextDrafts.google.interval_sec,
        cache_ttl_sec: nextDrafts.google.cache_ttl_sec,
        all_models: nextDrafts.google.all_models,
        models: nextDrafts.google.models,
        model: nextDrafts.google.models[0] || '',
      },
    })
  }

  const snaps = status.data?.snapshots
  const catalog = status.data?.catalog
  const enabledCount = PLATFORM_METAS.filter((m) => drafts[m.id].enabled).length

  return (
    <div className='space-y-3'>
      <Card>
        <CardHeader className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
          <div className='space-y-1'>
            <div className='flex items-center gap-2'>
              <CardTitle>多平台健康缓存探测</CardTitle>
              <Badge variant={enabledCount > 0 ? 'default' : 'secondary'}>
                已启用 {enabledCount}/3 平台
              </Badge>
            </div>
            <p className='text-xs text-muted-foreground'>
              Anthropic、OpenAI、Google
              三个平台各自独立开关、独立定时串行探测并按模型分别缓存。
              命中同模型有效缓存直接回放，未配置或探测失败的模型自动透传至真实调度池。
            </p>
          </div>
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={probeNow.isPending}
            onClick={() => probeNow.mutate({ platform: 'all' })}
          >
            <RefreshCw
              className={`mr-1.5 size-3.5 ${probingTarget === 'all' ? 'animate-spin' : ''}`}
              aria-hidden
            />
            {probingTarget === 'all' ? '探测中…' : '立即探测全部'}
          </Button>
        </CardHeader>
      </Card>

      {PLATFORM_METAS.map((meta) => {
        const snap =
          meta.id === 'google'
            ? snaps?.google || snaps?.gemini
            : snaps?.[meta.id]
        return (
          <PlatformHealthCard
            key={meta.id}
            meta={meta}
            draft={drafts[meta.id]}
            snapshot={snap}
            catalog={catalog?.[meta.id] || []}
            probingTarget={probingTarget}
            isMutating={probeNow.isPending}
            onChange={(patch) => updatePlatform(meta.id, patch)}
            onProbePlatform={() => probeNow.mutate({ platform: meta.id })}
            onProbeModel={(model) =>
              probeNow.mutate({ platform: meta.id, model })
            }
          />
        )
      })}
    </div>
  )
}

function PlatformStatusBadge({
  enabled,
  snapshot,
}: {
  enabled: boolean
  snapshot: HealthSnapshotView | undefined
}) {
  if (!enabled) {
    return <Badge variant='secondary'>已关闭</Badge>
  }
  if (snapshot?.probing) {
    return <Badge variant='outline'>探测中…</Badge>
  }
  const total = snapshot?.total_models ?? 0
  const ok = snapshot?.ok_models ?? 0
  const failed = snapshot?.failed_models ?? 0
  if (total > 0) {
    const tone =
      ok === total
        ? 'default'
        : ok > 0
          ? 'secondary'
          : failed > 0
            ? 'destructive'
            : 'secondary'
    return (
      <Badge variant={tone}>
        可用 {ok}/{total}
      </Badge>
    )
  }
  if (snapshot?.at) {
    return (
      <Badge
        variant={
          snapshot.ok ? 'default' : snapshot.error ? 'destructive' : 'secondary'
        }
      >
        {snapshot.ok ? '可用' : snapshot.error ? '失败' : '已过期'}
      </Badge>
    )
  }
  return <Badge variant='outline'>待探测</Badge>
}

function PlatformHealthCard({
  meta,
  draft,
  snapshot,
  catalog,
  probingTarget,
  isMutating,
  onChange,
  onProbePlatform,
  onProbeModel,
}: {
  meta: PlatformMeta
  draft: PlatformDraft
  snapshot: HealthSnapshotView | undefined
  catalog: HealthCatalogModel[]
  probingTarget: string | null
  isMutating: boolean
  onChange: (patch: Partial<PlatformDraft>) => void
  onProbePlatform: () => void
  onProbeModel: (model: string) => void
}) {
  const [customModel, setCustomModel] = useState('')
  const selectedLower = new Set(draft.models.map((m) => m.toLowerCase()))
  const catalogIdsLower = new Set(catalog.map((c) => c.id.toLowerCase()))
  const customOnlyModels = draft.models.filter(
    (m) => !catalogIdsLower.has(m.toLowerCase())
  )
  const effectiveAllCatalog =
    meta.id === 'google' && catalog.some((c) => c.online !== undefined)
      ? catalog.filter((c) => c.online === true)
      : catalog

  const toggleModel = (id: string, checked: boolean) => {
    const lower = id.toLowerCase()
    if (checked) {
      if (selectedLower.has(lower)) return
      onChange({ models: [...draft.models, id] })
    } else {
      onChange({
        models: draft.models.filter((m) => m.toLowerCase() !== lower),
      })
    }
  }

  const addCustomModel = () => {
    const trimmed = customModel.trim()
    if (!trimmed) return
    const next = normalizeModelIds([...draft.models, trimmed])
    onChange({ models: next })
    setCustomModel('')
  }

  const selectAllCatalog = () => {
    const ids = effectiveAllCatalog.map((m) => m.id)
    onChange({ models: normalizeModelIds([...draft.models, ...ids]) })
  }

  const modelSnaps = snapshot?.models || []
  const isThisPlatformProbing =
    probingTarget === meta.id || snapshot?.probing === true

  return (
    <Card>
      <CardHeader className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
        <div className='space-y-1'>
          <div className='flex flex-wrap items-center gap-2'>
            <CardTitle>{meta.cardTitle}</CardTitle>
            <PlatformStatusBadge enabled={draft.enabled} snapshot={snapshot} />
          </div>
          <p className='text-xs text-muted-foreground'>{meta.subtitle}</p>
        </div>
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={isMutating}
          aria-label={`立即探测 ${meta.name}`}
          onClick={onProbePlatform}
        >
          <RefreshCw
            className={`mr-1.5 size-3.5 ${isThisPlatformProbing ? 'animate-spin' : ''}`}
            aria-hidden
          />
          {isThisPlatformProbing ? '探测中…' : '立即探测'}
        </Button>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow
          label={`启用 ${meta.name} 健康缓存`}
          desc='关闭时该平台的探测请求照常进入真实调度池'
        >
          <Switch
            checked={draft.enabled}
            onCheckedChange={(checked) => onChange({ enabled: checked })}
            aria-label={`启用 ${meta.name} 健康缓存`}
          />
        </SettingRow>

        <SettingRow
          label={`${meta.name} 探测间隔`}
          desc={`秒，${meta.minInterval}–86400，默认 ${meta.defaultInterval}`}
        >
          <DeferredIntInput
            className='w-28'
            min={meta.minInterval}
            max={86400}
            fallback={meta.defaultInterval}
            value={draft.interval_sec}
            onCommit={(next) => onChange({ interval_sec: next })}
            aria-label={`${meta.name} 探测间隔`}
          />
        </SettingRow>

        <SettingRow
          label={`${meta.name} 缓存有效期`}
          desc={`秒，${meta.minTtl}–172800，默认 ${meta.defaultTtl}；过期后该模型探测请求照常进入调度`}
        >
          <DeferredIntInput
            className='w-28'
            min={meta.minTtl}
            max={172800}
            fallback={meta.defaultTtl}
            value={draft.cache_ttl_sec}
            onCommit={(next) => onChange({ cache_ttl_sec: next })}
            aria-label={`${meta.name} 缓存有效期`}
          />
        </SettingRow>

        {meta.supportsAllSlots ? (
          <SettingRow
            label={`${meta.name} 全号轮询`}
            desc='每个间隔对该平台支持对应模型的可调度槽按顺序逐槽探测（严格串行不并发）；关闭时首个成功槽即写入该模型缓存。'
          >
            <Switch
              checked={draft.probe_all_slots === true}
              onCheckedChange={(checked) =>
                onChange({ probe_all_slots: checked })
              }
              aria-label={`${meta.name} 全号轮询`}
            />
          </SettingRow>
        ) : null}

        <SettingRow label='一键支持全部模型' desc={meta.allModelsDesc}>
          <Switch
            checked={draft.all_models}
            onCheckedChange={(checked) => onChange({ all_models: checked })}
            aria-label={`${meta.name} 一键支持全部模型`}
          />
        </SettingRow>

        <div className='space-y-3 py-3.5'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <div>
              <div className='text-sm font-medium'>{meta.name} 探测模型</div>
              <p className='text-xs text-muted-foreground'>
                {draft.all_models
                  ? effectiveAllCatalog.length
                    ? `当前自动覆盖 ${effectiveAllCatalog.length} 个已启用模型（严格串行逐个探测）。`
                    : '已开启全模型模式，探测时将动态读取模型矩阵中全部已启用模型。'
                  : draft.models.length
                    ? `已选 ${draft.models.length} 个模型，未选模型探测请求将直接透传。`
                    : meta.emptyModelsHint}
              </p>
            </div>
            {!draft.all_models ? (
              <div className='flex flex-wrap gap-1.5'>
                <Button
                  type='button'
                  size='sm'
                  variant='ghost'
                  disabled={effectiveAllCatalog.length === 0}
                  onClick={selectAllCatalog}
                >
                  全选目录
                </Button>
                <Button
                  type='button'
                  size='sm'
                  variant='ghost'
                  disabled={draft.models.length === 0}
                  onClick={() => onChange({ models: [] })}
                >
                  清空
                </Button>
              </div>
            ) : null}
          </div>

          {draft.all_models ? (
            effectiveAllCatalog.length > 0 ? (
              <div className='flex flex-wrap gap-1.5'>
                {effectiveAllCatalog.map((m) => (
                  <Badge
                    key={m.id}
                    variant='secondary'
                    className='font-mono text-[11px] font-normal'
                    title={m.label !== m.id ? m.label : undefined}
                  >
                    {m.id}
                  </Badge>
                ))}
              </div>
            ) : null
          ) : (
            <div className='space-y-3'>
              {catalog.length > 0 ? (
                <div className='grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3'>
                  {catalog.map((m) => {
                    const checked = selectedLower.has(m.id.toLowerCase())
                    const inputId = `health-model-${meta.id}-${m.id}`
                    const offline = m.online === false
                    return (
                      <div
                        key={m.id}
                        className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs ${
                          checked
                            ? 'border-primary/40 bg-primary/5'
                            : 'border-border/60'
                        } ${offline ? 'opacity-65' : ''}`}
                      >
                        <Checkbox
                          id={inputId}
                          checked={checked}
                          onCheckedChange={(v) => toggleModel(m.id, v === true)}
                        />
                        <Label
                          htmlFor={inputId}
                          className='flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 font-normal'
                        >
                          <span className='truncate font-mono text-[11px]'>
                            {m.id}
                          </span>
                          {m.label && m.label !== m.id ? (
                            <span className='truncate text-[10px] text-muted-foreground'>
                              {m.label}
                              {offline ? ' · 暂无在线槽位' : ''}
                            </span>
                          ) : offline ? (
                            <span className='text-[10px] text-muted-foreground'>
                              暂无在线槽位
                            </span>
                          ) : null}
                        </Label>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className='text-xs text-muted-foreground'>
                  模型目录加载中或为空，可直接输入模型 ID
                  或先前往「模型」页同步目录。
                </p>
              )}

              {customOnlyModels.length > 0 ? (
                <div className='flex flex-wrap items-center gap-1.5'>
                  <span className='text-xs text-muted-foreground'>
                    自定义：
                  </span>
                  {customOnlyModels.map((id) => (
                    <Badge
                      key={id}
                      variant='outline'
                      className='gap-1 font-mono text-[11px] font-normal'
                    >
                      <span>{id}</span>
                      <button
                        type='button'
                        className='rounded-sm hover:text-destructive focus:ring-1 focus:ring-ring focus:outline-none'
                        aria-label={`移除模型 ${id}`}
                        onClick={() => toggleModel(id, false)}
                      >
                        <X className='size-3' aria-hidden />
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : null}

              <div className='flex max-w-md gap-2'>
                <Input
                  value={customModel}
                  placeholder={meta.customPlaceholder}
                  aria-label={`添加 ${meta.name} 探测模型`}
                  onChange={(event) => setCustomModel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addCustomModel()
                    }
                  }}
                />
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  disabled={!customModel.trim()}
                  onClick={addCustomModel}
                >
                  <Plus className='mr-1 size-3.5' aria-hidden />
                  添加
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className='space-y-2 py-3.5'>
          <div className='flex flex-wrap items-center justify-between gap-2 text-xs'>
            <span className='font-medium text-foreground'>
              {meta.name} 模型快照
            </span>
            <span className='text-muted-foreground'>
              {modelSnaps.length > 0
                ? `可用 ${snapshot?.ok_models ?? 0} · 失败 ${snapshot?.failed_models ?? 0} · 过期 ${snapshot?.stale_models ?? 0}`
                : `${meta.name}：暂无`}
            </span>
          </div>
          {modelSnaps.length > 0 ? (
            <div className='divide-y rounded-md border'>
              {modelSnaps.map((item) => (
                <ModelSnapshotRow
                  key={item.model || 'unknown'}
                  platform={meta.id}
                  item={item}
                  probing={
                    probingTarget === `${meta.id}:${item.model || ''}` ||
                    isThisPlatformProbing
                  }
                  disabled={isMutating}
                  onReprobe={() => {
                    if (item.model) onProbeModel(item.model)
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

function ModelSnapshotRow({
  platform,
  item,
  probing,
  disabled,
  onReprobe,
}: {
  platform: HealthProbePlatform
  item: HealthModelSnapshotView
  probing: boolean
  disabled: boolean
  onReprobe: () => void
}) {
  const tone = !item.at
    ? 'outline'
    : item.ok
      ? 'default'
      : item.error
        ? 'destructive'
        : 'secondary'
  const statusText = !item.at
    ? '未探测'
    : item.ok
      ? '可用'
      : item.error
        ? '失败'
        : '已过期'
  const detailErr = item.error || item.last_error || undefined

  return (
    <div className='flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs'>
      <div className='min-w-0 flex-1 space-y-0.5'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='font-mono font-medium'>{item.model || '—'}</span>
          <span className='text-muted-foreground'>{item.vm_id || '—'}</span>
          {item.duration_ms != null ? (
            <span className='text-muted-foreground'>{item.duration_ms}ms</span>
          ) : null}
        </div>
        {detailErr ? (
          <p
            className='truncate text-[11px] text-destructive'
            title={detailErr}
          >
            {detailErr}
          </p>
        ) : null}
      </div>
      <div className='flex items-center gap-2'>
        <Badge variant={tone} title={detailErr}>
          {statusText}
        </Badge>
        {item.model ? (
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='h-7 px-2 text-xs'
            disabled={disabled}
            aria-label={`重新探测 ${platform} ${item.model}`}
            onClick={onReprobe}
          >
            <RefreshCw
              className={`size-3 ${probing ? 'animate-spin' : ''}`}
              aria-hidden
            />
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function SignatureRepairCard({ failover }: { failover: Obj }) {
  // 默认值在 gateway HEAD 与工作区之间相反（!== false vs === true），
  // 所以不硬编码默认态，严格按 GET /routing 的实际值回显。
  const enabled = failover.signature_repair === true
  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between gap-3'>
        <CardTitle>签名修复</CardTitle>
        <Badge variant={enabled ? 'default' : 'secondary'}>
          {enabled ? '当前：已开启' : '当前：已关闭'}
        </Badge>
      </CardHeader>
      <CardContent className='space-y-3'>
        <div className='space-y-1 text-sm text-muted-foreground'>
          <p>
            上游因思考签名返回 400
            时，清理思考历史后重试一次；最终结果取决于重试。
          </p>
          <p>
            关闭则保留同账号的 thinking / signature
            块（缺少字段时补齐空字段），把 400 原样透传；切账号的清理和 cli-node
            自身行为不受此开关改变。 其它修复（搜索 / 预填 / 工具配对 / schema /
            自适应）不受此开关影响。
          </p>
        </div>
        <Link
          to='/settings/$tab'
          params={{ tab: 'pool' }}
          className='inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline'
        >
          前往「账号池 → 重试与切号」调整
          <ArrowRight className='size-3' aria-hidden />
        </Link>
      </CardContent>
    </Card>
  )
}
