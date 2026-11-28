import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useBlocker, useNavigate, useSearch } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { UsageLogRow } from '@/types/panel-usage-logs'
import { Activity, ChevronRight, ScanText, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/page-header'
import { StatusMark } from '@/components/status-mark'
import {
  type DetailState,
  LogDetailDialog,
} from '@/features/logs/log-detail/log-detail-dialog'
import { AccountScopeSettings } from './account-scope'
import { Panel } from './blocks'
import { DistillSettings } from './distill-settings'
import { HardRegexSettings } from './hard-regex-settings'
import { JevUsagePanel } from './jev-usage'
import {
  PREFLIGHT_RULES,
  type PreflightRule,
  type RiskView,
  riskSearch,
} from './model'
import { ModelSettings } from './model-settings'
import {
  distillQueryOptions,
  jevInterceptQueryOptions,
  refusalGuardsQueryOptions,
} from './queries'
import { RefusalSettings } from './refusal-settings'
import { RiskStatus } from './status-panel'

const PAGES = [
  { id: 'preflight', label: '前置', icon: ShieldCheck, hint: '硬规则与封禁' },
  { id: 'jev', label: 'Jev', icon: ScanText, hint: '模型与降级策略' },
  { id: 'status', label: '状态', icon: Activity, hint: '统计与日志' },
] as const

const STATE_TONE = {
  on: { key: 'on', text: '开启', cls: 'ok' },
  off: { key: 'off', text: '关闭', cls: 'off' },
  unset: { key: 'unset', text: '未配置地址', cls: 'caution' },
  loading: { key: 'loading', text: '读取中', cls: 'none' },
  error: { key: 'error', text: '读取失败', cls: 'bad' },
} as const

function ruleTone(enabled: boolean | undefined, error: boolean) {
  if (error) return STATE_TONE.error
  if (enabled === undefined) return STATE_TONE.loading
  return enabled ? STATE_TONE.on : STATE_TONE.off
}

export function RiskAuditPage() {
  const { view = 'status', rule = 'distill' } = useSearch({
    from: '/_authenticated/risk',
  })
  const navigate = useNavigate({ from: '/risk' })
  const [scopeDirty, setScopeDirty] = useState(false)
  const [ruleDirty, setRuleDirty] = useState(false)
  const [modelDirty, setModelDirty] = useState(false)
  const [routingDirty, setRoutingDirty] = useState(false)
  const [focusRule, setFocusRule] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailState | null>(null)
  const open = useCallback((row: UsageLogRow) => setDetail({ row }), [])
  const openSource = useCallback((row: UsageLogRow) => {
    setDetail({ row, tab: row.logMode === 'debug' ? 'raw' : 'summary' })
  }, [])

  useBlocker({
    enableBeforeUnload: scopeDirty || ruleDirty || modelDirty || routingDirty,
    shouldBlockFn: ({ next }) => {
      const target =
        next.routeId === '/_authenticated/risk' ? riskSearch(next.search) : null
      const leavesPage = !target || target.view !== view
      const leavesRule = leavesPage || (target?.rule ?? 'distill') !== rule
      const discardsDraft =
        (leavesPage && (scopeDirty || modelDirty || routingDirty)) ||
        (leavesRule && ruleDirty)
      if (
        discardsDraft &&
        !window.confirm('有未保存的修改。离开会丢弃这些修改，确认离开？')
      )
        return true
      if (leavesPage) {
        setScopeDirty(false)
        setModelDirty(false)
        setRoutingDirty(false)
      }
      if (leavesRule) setRuleDirty(false)
      return false
    },
  })

  const go = (next: RiskView, nextRule?: PreflightRule, source?: string) => {
    setFocusRule(source ?? null)
    void navigate({ search: { view: next, rule: nextRule }, resetScroll: true })
  }

  return (
    <PageHeader
      title={VIEW_TITLES.risk}
      description='先执行前置规则，再由 Jev 审核；在状态页查看拦截、放行和上游响应。'
    >
      <PipelineStrip
        activeView={view}
        activeRule={rule}
        onNavigate={(nextView, nextRule) => go(nextView, nextRule)}
      />
      <Tabs
        value={view}
        activationMode='manual'
        className='gap-5'
        onValueChange={(next) => {
          const page = PAGES.find((item) => item.id === next)
          if (page && page.id !== view) go(page.id)
        }}
      >
        <TabsList
          aria-label='风险审计页面'
          className='grid h-auto min-h-12 w-full grid-cols-3 border bg-muted/50 p-1 sm:min-h-14'
        >
          {PAGES.map(({ id, label, icon: Icon, hint }) => (
            <TabsTrigger
              key={id}
              value={id}
              className='h-full min-w-0 cursor-pointer gap-2 rounded-lg border border-transparent py-2 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=active]:border-select-border data-[state=active]:bg-select-surface data-[state=active]:text-foreground data-[state=active]:shadow-none motion-reduce:transition-none'
            >
              <Icon aria-hidden='true' className='size-4 shrink-0' />
              <span className='font-medium'>{label}</span>
              <span className='hidden truncate text-xs font-normal text-muted-foreground md:inline'>
                {hint}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value='preflight' className='min-w-0 space-y-4'>
          <AccountScopeSettings onDirtyChange={setScopeDirty} />
          <PreflightSettings
            rule={rule}
            onRule={(next) => go('preflight', next)}
            focusRule={focusRule}
            onDirtyChange={setRuleDirty}
          />
        </TabsContent>
        <TabsContent value='jev' className='min-w-0 space-y-4'>
          <JevSettings
            onModelDirty={setModelDirty}
            onRoutingDirty={setRoutingDirty}
          />
        </TabsContent>
        <TabsContent value='status' className='min-w-0 space-y-4'>
          <RiskStatus
            onOpen={open}
            onOpenSource={openSource}
            onLocateRule={(source) => go('preflight', 'hard-regex', source)}
          />
        </TabsContent>
      </Tabs>
      <LogDetailDialog state={detail} onClose={() => setDetail(null)} />
    </PageHeader>
  )
}

function PipelineStrip({
  activeView,
  activeRule,
  onNavigate,
}: {
  activeView: RiskView
  activeRule: PreflightRule
  onNavigate: (view: RiskView, rule?: PreflightRule) => void
}) {
  const distill = useQuery(distillQueryOptions())
  const regex = useQuery(jevInterceptQueryOptions())
  const refusal = useQuery(refusalGuardsQueryOptions())
  const jevEnabled = regex.data?.enabled
  const jevTone =
    jevEnabled && !regex.data?.base_url.trim() && !regex.isError
      ? STATE_TONE.unset
      : ruleTone(jevEnabled, regex.isError)
  const banCount =
    (refusal.data?.device_count ?? 0) + (refusal.data?.session_count ?? 0)

  const stages = [
    {
      id: 'distill',
      label: '蒸馏识别',
      tone: ruleTone(distill.data?.enabled, distill.isError),
      meta: null as string | null,
      active: activeView === 'preflight' && activeRule === 'distill',
      onClick: () => onNavigate('preflight', 'distill'),
    },
    {
      id: 'hard-regex',
      label: '硬正则',
      tone: ruleTone(regex.data?.hard_regex_enabled, regex.isError),
      meta: null as string | null,
      active: activeView === 'preflight' && activeRule === 'hard-regex',
      onClick: () => onNavigate('preflight', 'hard-regex'),
    },
    {
      id: 'refusal',
      label: '拒答与封禁',
      tone: ruleTone(refusal.data?.enabled, refusal.isError),
      meta: banCount > 0 ? `${banCount} 封禁` : null,
      active: activeView === 'preflight' && activeRule === 'refusal',
      onClick: () => onNavigate('preflight', 'refusal'),
    },
    {
      id: 'jev',
      label: 'Jev 审核模型',
      tone: jevTone,
      meta: regex.data?.model || null,
      active: activeView === 'jev',
      onClick: () => onNavigate('jev'),
    },
  ]

  return (
    <nav
      aria-label='拦截链路实时状态'
      className='mb-4 flex flex-wrap items-center gap-1.5 rounded-xl border bg-card px-3 py-2'
    >
      <span className='mr-1 text-xs font-medium text-[var(--text-tertiary)]'>
        审查链路
      </span>
      {stages.map((stage, index) => (
        <div key={stage.id} className='flex items-center gap-1.5'>
          {index > 0 ? (
            <ChevronRight
              aria-hidden='true'
              className='size-3.5 shrink-0 text-muted-foreground/60'
            />
          ) : null}
          <button
            type='button'
            onClick={stage.onClick}
            aria-current={stage.active ? 'page' : undefined}
            className={cn(
              'inline-flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              stage.active
                ? 'border-select-border bg-select-surface text-foreground'
                : 'border-transparent bg-muted/40 text-foreground hover:border-border hover:bg-muted/70'
            )}
          >
            <span className='font-medium'>{stage.label}</span>
            <StatusMark tone={stage.tone} />
            {stage.meta ? (
              <span className='hidden font-mono text-[11px] text-muted-foreground tabular-nums sm:inline'>
                {stage.meta}
              </span>
            ) : null}
          </button>
        </div>
      ))}
    </nav>
  )
}

function PreflightSettings({
  rule,
  onRule,
  focusRule,
  onDirtyChange,
}: {
  rule: PreflightRule
  onRule: (rule: PreflightRule) => void
  focusRule: string | null
  onDirtyChange: (dirty: boolean) => void
}) {
  const distill = useQuery(distillQueryOptions())
  const regex = useQuery(jevInterceptQueryOptions())
  const refusal = useQuery(refusalGuardsQueryOptions())
  const tones = {
    distill: ruleTone(distill.data?.enabled, distill.isError),
    'hard-regex': ruleTone(regex.data?.hard_regex_enabled, regex.isError),
    refusal: ruleTone(refusal.data?.enabled, refusal.isError),
  }

  return (
    <Tabs
      value={rule}
      activationMode='manual'
      className='gap-4'
      onValueChange={(next) => {
        const entry = PREFLIGHT_RULES.find((item) => item.id === next)
        if (entry && entry.id !== rule) onRule(entry.id)
      }}
    >
      <TabsList
        aria-label='前置规则'
        className='grid h-auto w-full grid-cols-3 gap-2 bg-transparent p-0'
      >
        {PREFLIGHT_RULES.map((entry) => (
          <TabsTrigger
            key={entry.id}
            value={entry.id}
            className={cn(
              'h-full min-w-0 cursor-pointer flex-col gap-1.5 rounded-lg border border-border bg-card px-2 py-2.5 transition-colors duration-150 hover:border-select-border/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none sm:flex-row sm:gap-3',
              'data-[state=active]:border-select-border data-[state=active]:bg-select-surface data-[state=active]:text-foreground data-[state=active]:shadow-none'
            )}
          >
            <span>{entry.name}</span>
            <StatusMark tone={tones[entry.id]} />
          </TabsTrigger>
        ))}
      </TabsList>
      {PREFLIGHT_RULES.map((entry) => (
        <TabsContent key={entry.id} value={entry.id} className='min-w-0'>
          <Panel title={entry.name} hint={entry.does}>
            {entry.id === 'distill' && (
              <DistillSettings onDirtyChange={onDirtyChange} />
            )}
            {entry.id === 'hard-regex' && (
              <HardRegexSettings
                focusRule={focusRule}
                onDirtyChange={onDirtyChange}
              />
            )}
            {entry.id === 'refusal' && (
              <RefusalSettings
                section='preflight'
                onDirtyChange={onDirtyChange}
              />
            )}
          </Panel>
        </TabsContent>
      ))}
    </Tabs>
  )
}

function JevSettings({
  onModelDirty,
  onRoutingDirty,
}: {
  onModelDirty: (dirty: boolean) => void
  onRoutingDirty: (dirty: boolean) => void
}) {
  const jev = useQuery(jevInterceptQueryOptions())
  const enabled = jev.data?.enabled
  const tone =
    enabled && !jev.data?.base_url.trim() && !jev.isError
      ? STATE_TONE.unset
      : ruleTone(enabled, jev.isError)

  return (
    <>
      <JevUsagePanel />
      <Panel
        title='决策模型'
        hint='只审核用户会话和可读取的内联文件文本，不发送系统提示词和工具。'
        action={<StatusMark tone={tone} />}
      >
        <ModelSettings onDirtyChange={onModelDirty} />
      </Panel>
      <Panel title='降级放行' hint='按安全分差选择模型、账号池或 API 渠道。'>
        <RefusalSettings section='jev' onDirtyChange={onRoutingDirty} />
      </Panel>
    </>
  )
}
