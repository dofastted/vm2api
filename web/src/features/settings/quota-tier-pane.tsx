import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { QuotaTierKey, QuotaTierPolicy } from '@/types/panel-vm'
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  Gauge,
  HardDrive,
  Info,
  ServerCog,
} from 'lucide-react'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { vmsListQueryOptions } from '@/features/vm/queries'
import {
  CONC_STEPS,
  RPM_STEPS,
  withCurrent,
} from '@/features/vm/scheduling-steps'
import {
  PlatformAccountList,
  QuotaSummary,
  RatioSetting,
} from './quota-controls'
import {
  type Obj,
  formatRpm,
  numberOf,
  quotaDialogClass,
  recordOf,
} from './quota-values'
import {
  ChipGroup,
  PaneSection,
  SliderSetting,
  StepperSetting,
} from './scheduler-controls'

type DialogKind = 'gates' | 'concurrency' | 'rpm' | 'details'

const TIERS: { key: QuotaTierKey; label: string; hint: string }[] = [
  { key: 'default', label: '默认', hint: '未知套餐或没有凭证的账号' },
  { key: 'pro', label: 'Pro', hint: '普通 Claude 账号' },
  { key: 'max', label: 'Max', hint: 'Fable 可用的账号' },
]

const TIER_DEFAULTS: Record<
  QuotaTierKey,
  {
    max_concurrency: number
    max_rpm: number
    limit_5h: number
    limit_7d: number
  }
> = {
  default: { max_concurrency: 2, max_rpm: 0, limit_5h: 0.85, limit_7d: 0.8 },
  pro: { max_concurrency: 2, max_rpm: 0, limit_5h: 0.85, limit_7d: 0.8 },
  max: { max_concurrency: 4, max_rpm: 0, limit_5h: 0.95, limit_7d: 0.95 },
}

const REQUEST_BODY_DEFAULT_MIB = 32

function cloneTiers(
  source: Record<string, QuotaTierPolicy>
): Record<QuotaTierKey, QuotaTierPolicy> {
  return Object.fromEntries(
    TIERS.map(({ key }) => [key, { ...(source[key] || {}) }])
  ) as Record<QuotaTierKey, QuotaTierPolicy>
}

function ratioValue(
  policy: QuotaTierPolicy,
  key: 'limit_5h' | 'limit_7d',
  fallback: number
) {
  return numberOf(policy[key], fallback) * 100
}

function tierSummary(
  tiers: Record<string, QuotaTierPolicy>,
  format: (policy: QuotaTierPolicy, key: QuotaTierKey) => string
) {
  return TIERS.map(
    ({ key, label }) => `${label} ${format(tiers[key] || {}, key)}`
  ).join(' · ')
}

function TierTabs({
  tier,
  onTier,
}: {
  tier: QuotaTierKey
  onTier: (next: QuotaTierKey) => void
}) {
  return (
    <div className='space-y-2'>
      <div className='text-xs font-medium'>Claude 账号层级</div>
      <div
        className='flex flex-wrap gap-2'
        role='tablist'
        aria-label='Claude 账号层级'
      >
        {TIERS.map((item) => (
          <Button
            key={item.key}
            type='button'
            size='sm'
            variant={item.key === tier ? 'default' : 'outline'}
            role='tab'
            aria-selected={item.key === tier}
            className='min-h-11'
            onClick={() => onTier(item.key)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <p className='text-xs text-muted-foreground'>
        {TIERS.find((item) => item.key === tier)?.hint}
      </p>
    </div>
  )
}

function ClaudeGates({
  tier,
  tiers,
  quota,
  weeklyExpanded,
  onTier,
  onTierChange,
  onQuotaChange,
  onWeeklyExpanded,
}: {
  tier: QuotaTierKey
  tiers: Record<QuotaTierKey, QuotaTierPolicy>
  quota: Obj
  weeklyExpanded: boolean
  onTier: (next: QuotaTierKey) => void
  onTierChange: (patch: QuotaTierPolicy) => void
  onQuotaChange: (patch: Obj) => void
  onWeeklyExpanded: (next: boolean) => void
}) {
  const policy = tiers[tier] || {}
  const fallback = TIER_DEFAULTS[tier]
  const weekly = recordOf(quota.weekly_split)
  return (
    <div className='space-y-4'>
      <TierTabs tier={tier} onTier={onTier} />
      <div className='grid gap-4 sm:grid-cols-2'>
        <RatioSetting
          id={`claude-${tier}-5h`}
          label='5h 闸线'
          value={numberOf(policy.limit_5h, fallback.limit_5h)}
          fallback={fallback.limit_5h}
          onChange={(value) => onTierChange({ limit_5h: value })}
        />
        <RatioSetting
          id={`claude-${tier}-7d`}
          label='7d 闸线'
          value={numberOf(policy.limit_7d, fallback.limit_7d)}
          fallback={fallback.limit_7d}
          onChange={(value) => onTierChange({ limit_7d: value })}
        />
      </div>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='flex items-center justify-between gap-4 rounded-lg border p-3'>
          <Label>5h 闸生效</Label>
          <Switch
            checked={quota.block_on_5h !== false}
            onCheckedChange={(block_on_5h) => onQuotaChange({ block_on_5h })}
          />
        </div>
        <div className='flex items-center justify-between gap-4 rounded-lg border p-3'>
          <Label>7d 闸生效</Label>
          <Switch
            checked={quota.block_on_7d !== false}
            onCheckedChange={(block_on_7d) => onQuotaChange({ block_on_7d })}
          />
        </div>
      </div>
      <div className='space-y-3 rounded-lg border p-3'>
        <SliderSetting
          id='claude-gate-overshoot'
          label='闸线超出量'
          desc='已入座的会话可以越过闸线继续跑这么多，再让出这台 VM；从「闸线 − 临界带宽」起就不再优先给新会话开席位，且同一账号一次只跑一个请求（读数滞后于在飞请求）。0 表示到闸线即切。'
          value={Math.round(numberOf(quota.gate_overshoot, 0.05) * 100)}
          min={0}
          max={10}
          step={1}
          format={(value) => `${value}%`}
          fallback={5}
          presets={[0, 3, 5]}
          onChange={(value) => onQuotaChange({ gate_overshoot: value / 100 })}
        />
      </div>
      <div className='space-y-3 rounded-lg border p-3'>
        <div className='flex items-center justify-between gap-4'>
          <div>
            <Label>临界区大额冷请求保护</Label>
            <p className='text-xs text-muted-foreground'>
              用量进入闸线下最后几个百分点时，评估本请求规模。缓存命中与最终输出无法精确预知，这是尽力保护，不保证绝对不超过闸线，也不会截短上下文或下调
              max_tokens。
            </p>
          </div>
          <Switch
            checked={quota.guard_large_cold !== false}
            onCheckedChange={(guard_large_cold) =>
              onQuotaChange({ guard_large_cold })
            }
          />
        </div>
        <SliderSetting
          id='claude-critical-band'
          label='临界带宽'
          desc='闸线下这一段与超出量一起构成临近闸线区：一次只跑一个请求，并按单笔冷缓存风险判断。'
          value={Math.round(numberOf(quota.critical_band, 0.05) * 100)}
          min={1}
          max={15}
          step={1}
          format={(value) => `${value}%`}
          fallback={5}
          presets={[3, 5, 10]}
          onChange={(value) => onQuotaChange({ critical_band: value / 100 })}
        />
        <StepperSetting
          id='claude-large-cold-tokens'
          label='大额冷缓存阈值'
          desc='预估未命中缓存的输入 token 达到此值视为大额。冷请求算整段 prompt，已确认热前缀只算最后一条 user，不含 max_tokens。默认 10 万：高于普通一轮，低于现场 50 万缓存写入样本。'
          value={Math.round(
            numberOf(quota.large_cold_uncached_tokens, 100000) / 1000
          )}
          min={20}
          max={500}
          step={10}
          unit='k'
          fallback={100}
          onChange={(value) =>
            onQuotaChange({
              large_cold_uncached_tokens: Math.round(value) * 1000,
            })
          }
        />
      </div>
      <div className='rounded-lg border'>
        <button
          type='button'
          className='flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left'
          aria-expanded={weeklyExpanded}
          onClick={() => onWeeklyExpanded(!weeklyExpanded)}
        >
          <span>
            <span className='block text-sm font-medium'>实验：周仓拆分</span>
            <span className='block text-xs text-muted-foreground'>
              保留当前固定份额行为，仅 Claude 可用。
            </span>
          </span>
          {weeklyExpanded ? (
            <ChevronDown className='size-4 shrink-0' aria-hidden />
          ) : (
            <ChevronRight className='size-4 shrink-0' aria-hidden />
          )}
        </button>
        {weeklyExpanded ? (
          <div className='space-y-3 border-t px-3 py-3'>
            <div className='flex items-center justify-between gap-4'>
              <div>
                <Label>启用周仓拆分</Label>
                <p className='text-xs text-muted-foreground'>
                  7d 余量按固定比例留给 Max/Fable。
                </p>
              </div>
              <Switch
                checked={weekly.enabled === true}
                onCheckedChange={(enabled) =>
                  onQuotaChange({
                    weekly_split: { ...weekly, enabled },
                  })
                }
              />
            </div>
            <SliderSetting
              id='claude-weekly-fable-share'
              label='Fable 份额'
              value={numberOf(weekly.fable_share, 0.5) * 100}
              min={0}
              max={100}
              step={5}
              format={(value) => `${value}%`}
              fallback={50}
              presets={[25, 50, 75]}
              onChange={(value) =>
                onQuotaChange({
                  weekly_split: { ...weekly, fable_share: value / 100 },
                })
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ClaudeConcurrency({
  tier,
  tiers,
  onTier,
  onChange,
}: {
  tier: QuotaTierKey
  tiers: Record<QuotaTierKey, QuotaTierPolicy>
  onTier: (next: QuotaTierKey) => void
  onChange: (patch: QuotaTierPolicy) => void
}) {
  const policy = tiers[tier] || {}
  const value = numberOf(
    policy.max_concurrency,
    TIER_DEFAULTS[tier].max_concurrency
  )
  return (
    <div className='space-y-4'>
      <TierTabs tier={tier} onTier={onTier} />
      <StepperSetting
        id={`claude-${tier}-concurrency`}
        label='执行并发'
        desc='每个账号的在飞请求数；Claude 分档至少保留 1 个。'
        value={value}
        min={1}
        max={256}
        fallback={TIER_DEFAULTS[tier].max_concurrency}
        onChange={(max_concurrency) => onChange({ max_concurrency })}
      />
      <ChipGroup
        label='Claude 执行并发常用值'
        value={value}
        options={withCurrent(
          CONC_STEPS.filter(([next]) => next > 0),
          value
        )}
        onChange={(max_concurrency) => onChange({ max_concurrency })}
      />
    </div>
  )
}

function ClaudeRpm({
  tier,
  tiers,
  onTier,
  onChange,
}: {
  tier: QuotaTierKey
  tiers: Record<QuotaTierKey, QuotaTierPolicy>
  onTier: (next: QuotaTierKey) => void
  onChange: (patch: QuotaTierPolicy) => void
}) {
  const policy = tiers[tier] || {}
  const value = numberOf(policy.max_rpm, TIER_DEFAULTS[tier].max_rpm)
  return (
    <div className='space-y-4'>
      <TierTabs tier={tier} onTier={onTier} />
      <StepperSetting
        id={`claude-${tier}-rpm`}
        label='请求速率'
        desc='每个账号每分钟启动数；0 = 不限。'
        value={value}
        min={0}
        max={1000000}
        unit='RPM'
        fallback={TIER_DEFAULTS[tier].max_rpm}
        onChange={(max_rpm) => onChange({ max_rpm })}
      />
      <ChipGroup
        label='Claude RPM 常用值'
        value={value}
        options={withCurrent(RPM_STEPS, value)}
        onChange={(max_rpm) => onChange({ max_rpm })}
      />
    </div>
  )
}

export function QuotaTierPane({
  tiers,
  quota,
  failover,
  onChange,
  onQuotaChange,
  onFailoverChange,
  saving = false,
  pending = false,
}: {
  tiers: Record<string, QuotaTierPolicy>
  quota: Obj
  failover: Obj
  onChange: (tier: QuotaTierKey, patch: QuotaTierPolicy) => void
  onQuotaChange: (patch: Obj) => void
  onFailoverChange: (patch: Obj) => void
  saving?: boolean
  pending?: boolean
}) {
  const list = useQuery(vmsListQueryOptions(5000))
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const [tier, setTier] = useState<QuotaTierKey>('default')
  const [draftTiers, setDraftTiers] = useState<
    Record<QuotaTierKey, QuotaTierPolicy>
  >(cloneTiers(tiers))
  const [draftQuota, setDraftQuota] = useState<Obj>({ ...quota })
  const [weeklyExpanded, setWeeklyExpanded] = useState(false)
  const triggerRefs = useRef<
    Partial<Record<DialogKind, HTMLButtonElement | null>>
  >({})
  const previousDialog = useRef<DialogKind | null>(null)

  useEffect(() => {
    if (previousDialog.current && !dialog) {
      triggerRefs.current[previousDialog.current]?.focus()
    }
    previousDialog.current = dialog
  }, [dialog])

  const openDialog = (kind: DialogKind) => {
    if (saving) return
    setDraftTiers(cloneTiers(tiers))
    setDraftQuota({ ...quota })
    setTier('default')
    setWeeklyExpanded(false)
    setDialog(kind)
  }
  const closeDialog = () => {
    if (!saving) setDialog(null)
  }
  const apply = () => {
    if (!dialog || saving) return
    if (dialog === 'details') {
      closeDialog()
      return
    }
    if (dialog === 'gates') {
      TIERS.forEach(({ key }) => {
        const policy = draftTiers[key] || {}
        onChange(key, {
          limit_5h: numberOf(policy.limit_5h, TIER_DEFAULTS[key].limit_5h),
          limit_7d: numberOf(policy.limit_7d, TIER_DEFAULTS[key].limit_7d),
        })
      })
      const weekly = recordOf(draftQuota.weekly_split)
      onQuotaChange({
        block_on_5h: draftQuota.block_on_5h !== false,
        block_on_7d: draftQuota.block_on_7d !== false,
        guard_large_cold: draftQuota.guard_large_cold !== false,
        critical_band: Math.min(
          0.15,
          Math.max(0.01, numberOf(draftQuota.critical_band, 0.05))
        ),
        gate_overshoot: Math.min(
          0.1,
          Math.max(0, numberOf(draftQuota.gate_overshoot, 0.05))
        ),
        large_cold_uncached_tokens: Math.min(
          500000,
          Math.max(
            20000,
            Math.round(numberOf(draftQuota.large_cold_uncached_tokens, 100000))
          )
        ),
        weekly_split: {
          ...weekly,
          enabled: weekly.enabled === true,
          fable_share: numberOf(weekly.fable_share, 0.5),
        },
      })
    } else if (dialog === 'concurrency') {
      TIERS.forEach(({ key }) => {
        const policy = draftTiers[key] || {}
        onChange(key, {
          max_concurrency: numberOf(
            policy.max_concurrency,
            TIER_DEFAULTS[key].max_concurrency
          ),
        })
      })
    } else if (dialog === 'rpm') {
      TIERS.forEach(({ key }) => {
        const policy = draftTiers[key] || {}
        onChange(key, {
          max_rpm: numberOf(policy.max_rpm, TIER_DEFAULTS[key].max_rpm),
        })
      })
    }
    setDialog(null)
  }

  const claudeItems = (list.data?.items || []).filter((vm) => !isCodexVm(vm))
  const title =
    dialog === 'gates'
      ? '配额闸线'
      : dialog === 'concurrency'
        ? '执行并发'
        : dialog === 'rpm'
          ? '请求速率'
          : '生效账号与本槽覆盖'

  return (
    <div className='space-y-4'>
      <PaneSection
        icon={Gauge}
        title='Claude 配额'
        desc={`${claudeItems.length} 个账号。GPT 配额在 OpenAI 页。`}
      >
        <div className='grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3'>
          <QuotaSummary
            icon={Clock3}
            title='配额闸线'
            value={tierSummary(tiers, (policy, key) => {
              const fallback = TIER_DEFAULTS[key]
              return `${Math.round(ratioValue(policy, 'limit_5h', fallback.limit_5h))}% / ${Math.round(ratioValue(policy, 'limit_7d', fallback.limit_7d))}%`
            })}
            desc='5h / 7d，本地软闸'
            pending={pending}
            buttonRef={(node) => {
              triggerRefs.current.gates = node
            }}
            disabled={saving}
            onClick={() => openDialog('gates')}
          />
          <QuotaSummary
            icon={ServerCog}
            title='执行并发'
            value={tierSummary(
              tiers,
              (policy, key) =>
                `${numberOf(policy.max_concurrency, TIER_DEFAULTS[key].max_concurrency)}`
            )}
            desc='每个账号的在飞请求数'
            pending={pending}
            buttonRef={(node) => {
              triggerRefs.current.concurrency = node
            }}
            disabled={saving}
            onClick={() => openDialog('concurrency')}
          />
          <QuotaSummary
            icon={Gauge}
            title='请求速率'
            value={tierSummary(tiers, (policy, key) =>
              formatRpm(numberOf(policy.max_rpm, TIER_DEFAULTS[key].max_rpm))
            )}
            desc='满后排队，不切号；0 = 不限'
            pending={pending}
            buttonRef={(node) => {
              triggerRefs.current.rpm = node
            }}
            disabled={saving}
            onClick={() => openDialog('rpm')}
          />
        </div>
        <Button
          ref={(node) => {
            triggerRefs.current.details = node
          }}
          type='button'
          variant='ghost'
          disabled={saving}
          className='mt-3 h-auto min-h-11 w-full items-start justify-start gap-2 px-2 py-3 text-left whitespace-normal'
          onClick={() => openDialog('details')}
        >
          <Info className='size-4 text-muted-foreground' aria-hidden />
          <span className='min-w-0 flex-1'>
            <span className='block text-sm font-medium'>
              生效账号与本槽覆盖
            </span>
            <span className='block text-xs font-normal text-muted-foreground'>
              查看来源、运行状态，并进入单槽 VM 调度；这里不复制逐槽编辑器。
            </span>
          </span>
        </Button>
      </PaneSection>

      <PaneSection
        icon={HardDrive}
        title='请求体上限'
        desc='入站请求正文的最大大小，图片和工具写入的大文件都算在内。Claude 与 GPT 共用。超过返回 413。保存后各槽 kernel 在没有请求时重启。不能超过 KIN_MAX_BODY。'
      >
        <fieldset disabled={saving} className='min-w-0 border-0 p-0'>
          <SliderSetting
            id='quota-max-request'
            label='允许的最大请求体'
            value={numberOf(failover.max_request_mib, REQUEST_BODY_DEFAULT_MIB)}
            min={8}
            max={128}
            step={8}
            format={(value) => `${value} MiB`}
            fallback={REQUEST_BODY_DEFAULT_MIB}
            presets={[32, 64, 128]}
            onChange={(value) =>
              onFailoverChange({
                max_request_mib: Math.min(128, Math.max(8, Math.round(value))),
              })
            }
          />
        </fieldset>
      </PaneSection>

      <Dialog
        open={dialog !== null}
        onOpenChange={(next) => {
          if (!next && !saving) closeDialog()
        }}
      >
        <DialogContent
          showCloseButton={!saving}
          className={quotaDialogClass(dialog ?? '', dialog === 'gates')}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              应用到草稿后，全局保存才会生效；运行中的账号状态始终来自实时 VM
              数据。
            </DialogDescription>
          </DialogHeader>
          <fieldset
            disabled={saving}
            className='min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto pr-1'
          >
            {dialog === 'gates' ? (
              <ClaudeGates
                tier={tier}
                tiers={draftTiers}
                quota={draftQuota}
                weeklyExpanded={weeklyExpanded}
                onTier={setTier}
                onTierChange={(patch) =>
                  setDraftTiers((current) => ({
                    ...current,
                    [tier]: { ...current[tier], ...patch },
                  }))
                }
                onQuotaChange={(patch) =>
                  setDraftQuota((current) => ({
                    ...current,
                    ...patch,
                  }))
                }
                onWeeklyExpanded={setWeeklyExpanded}
              />
            ) : null}
            {dialog === 'concurrency' ? (
              <ClaudeConcurrency
                tier={tier}
                tiers={draftTiers}
                onTier={setTier}
                onChange={(patch) =>
                  setDraftTiers((current) => ({
                    ...current,
                    [tier]: { ...current[tier], ...patch },
                  }))
                }
              />
            ) : null}
            {dialog === 'rpm' ? (
              <ClaudeRpm
                tier={tier}
                tiers={draftTiers}
                onTier={setTier}
                onChange={(patch) =>
                  setDraftTiers((current) => ({
                    ...current,
                    [tier]: { ...current[tier], ...patch },
                  }))
                }
              />
            ) : null}
            {dialog === 'details' ? (
              <PlatformAccountList
                platform='claude'
                items={claudeItems}
                loading={list.isLoading}
                error={list.error}
              />
            ) : null}
          </fieldset>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              disabled={saving}
              className='min-h-11'
              onClick={closeDialog}
            >
              {dialog === 'details' ? '关闭' : '取消'}
            </Button>
            {dialog !== 'details' ? (
              <Button
                type='button'
                disabled={saving}
                className='min-h-11'
                onClick={apply}
              >
                应用到草稿
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
