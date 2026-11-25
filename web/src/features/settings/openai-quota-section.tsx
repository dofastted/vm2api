import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { OpenAIQuotaPolicy } from '@/types/panel-vm'
import { Clock3, Gauge, Info, MessageSquare, ServerCog } from 'lucide-react'
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
  OPENAI_DEFAULTS,
  OPENAI_SESSION_STEPS,
  formatRpm,
  openaiPolicy,
  quotaDialogClass,
} from './quota-values'
import { ChipGroup, PaneSection, StepperSetting } from './scheduler-controls'

type DialogKind = 'gates' | 'concurrency' | 'rpm' | 'sessions' | 'details'

function OpenAIGates({
  policy,
  onChange,
}: {
  policy: OpenAIQuotaPolicy
  onChange: (patch: Partial<OpenAIQuotaPolicy>) => void
}) {
  return (
    <div className='space-y-4'>
      <div className='grid gap-4 sm:grid-cols-2'>
        <RatioSetting
          id='openai-5h'
          label='5h 本地闸线'
          value={policy.limit_5h}
          fallback={OPENAI_DEFAULTS.limit_5h}
          onChange={(limit_5h) => onChange({ limit_5h })}
        />
        <RatioSetting
          id='openai-7d'
          label='7d 本地闸线'
          value={policy.limit_7d}
          fallback={OPENAI_DEFAULTS.limit_7d}
          onChange={(limit_7d) => onChange({ limit_7d })}
        />
      </div>
      <p className='rounded-md border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground'>
        本地闸线只提前停止普通准入，不能解除上游硬限制；缺少或过期的用量数据显示为未知。
      </p>
    </div>
  )
}

function OpenAICapacity({
  policy,
  onChange,
}: {
  policy: OpenAIQuotaPolicy
  onChange: (patch: Partial<OpenAIQuotaPolicy>) => void
}) {
  return (
    <div className='space-y-4'>
      <StepperSetting
        id='openai-concurrency'
        label='执行并发'
        desc='每个账号的在飞请求数；OpenAI 的 0 不表示不限。'
        value={policy.max_concurrency}
        min={1}
        max={256}
        fallback={OPENAI_DEFAULTS.max_concurrency}
        onChange={(max_concurrency) => onChange({ max_concurrency })}
      />
      <ChipGroup
        label='OpenAI 并发常用值'
        value={policy.max_concurrency}
        options={withCurrent(
          CONC_STEPS.filter(([value]) => value > 0),
          policy.max_concurrency
        )}
        onChange={(max_concurrency) => onChange({ max_concurrency })}
      />
    </div>
  )
}

function OpenAIRpm({
  policy,
  onChange,
}: {
  policy: OpenAIQuotaPolicy
  onChange: (patch: Partial<OpenAIQuotaPolicy>) => void
}) {
  return (
    <div className='space-y-4'>
      <StepperSetting
        id='openai-rpm'
        label='请求速率'
        desc='每个账号每分钟启动数；0 = 不限。'
        value={policy.max_rpm}
        min={0}
        max={1000000}
        unit='RPM'
        fallback={OPENAI_DEFAULTS.max_rpm}
        onChange={(max_rpm) => onChange({ max_rpm })}
      />
      <ChipGroup
        label='OpenAI RPM 常用值'
        value={policy.max_rpm}
        options={withCurrent(RPM_STEPS, policy.max_rpm)}
        onChange={(max_rpm) => onChange({ max_rpm })}
      />
    </div>
  )
}

function OpenAISessions({
  policy,
  onChange,
}: {
  policy: OpenAIQuotaPolicy
  onChange: (patch: Partial<OpenAIQuotaPolicy>) => void
}) {
  return (
    <div className='space-y-4'>
      <StepperSetting
        id='openai-sessions'
        label='会话容量'
        desc='每个账号的活跃对话窗口；0 = 不限，空闲 5 分钟后回收。'
        value={policy.max_sessions}
        min={0}
        max={256}
        fallback={OPENAI_DEFAULTS.max_sessions}
        onChange={(max_sessions) => onChange({ max_sessions })}
      />
      <ChipGroup
        label='OpenAI 会话容量常用值'
        value={policy.max_sessions}
        options={withCurrent(OPENAI_SESSION_STEPS, policy.max_sessions)}
        onChange={(max_sessions) => onChange({ max_sessions })}
      />
      <p className='rounded-md border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground'>
        会话窗口的空闲回收仍固定为 5 分钟；这里不编辑选择策略或队列上限。
      </p>
    </div>
  )
}

export function OpenaiQuotaSection({
  quota,
  onChange,
  saving = false,
  pending = false,
  pendingCards,
}: {
  quota: Partial<OpenAIQuotaPolicy>
  onChange: (patch: Partial<OpenAIQuotaPolicy>) => void
  saving?: boolean
  pending?: boolean
  pendingCards?: Partial<
    Record<'gates' | 'concurrency' | 'rpm' | 'sessions', boolean>
  >
}) {
  const list = useQuery(vmsListQueryOptions(5000))
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const [draft, setDraft] = useState<OpenAIQuotaPolicy>(openaiPolicy(quota))
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
    setDraft(openaiPolicy(quota))
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
      onChange({ limit_5h: draft.limit_5h, limit_7d: draft.limit_7d })
    } else if (dialog === 'concurrency') {
      onChange({ max_concurrency: draft.max_concurrency })
    } else if (dialog === 'rpm') {
      onChange({ max_rpm: draft.max_rpm })
    } else {
      onChange({ max_sessions: draft.max_sessions })
    }
    setDialog(null)
  }

  const items = (list.data?.items || []).filter((vm) => isCodexVm(vm))
  const effective = openaiPolicy(quota)
  const title =
    dialog === 'gates'
      ? '配额闸线'
      : dialog === 'concurrency'
        ? '执行并发'
        : dialog === 'rpm'
          ? '请求速率'
          : dialog === 'sessions'
            ? '会话容量'
            : '生效账号与本槽覆盖'

  return (
    <>
      <PaneSection
        icon={Gauge}
        title='调度与槽位'
        desc={`${items.length} 个 GPT 账号；闸线、并发、RPM 与会话容量只作用于 OpenAI 槽。`}
      >
        <div className='grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-4'>
          <QuotaSummary
            icon={Clock3}
            title='配额闸线'
            value={`${Math.round(effective.limit_5h * 100)}% / ${Math.round(effective.limit_7d * 100)}%`}
            desc='5h / 7d，本地软闸'
            pending={pendingCards ? !!pendingCards.gates : pending}
            buttonRef={(node) => {
              triggerRefs.current.gates = node
            }}
            disabled={saving}
            onClick={() => openDialog('gates')}
          />
          <QuotaSummary
            icon={ServerCog}
            title='执行并发'
            value={String(effective.max_concurrency)}
            desc='每个账号的在飞请求数'
            pending={pendingCards ? !!pendingCards.concurrency : pending}
            buttonRef={(node) => {
              triggerRefs.current.concurrency = node
            }}
            disabled={saving}
            onClick={() => openDialog('concurrency')}
          />
          <QuotaSummary
            icon={Gauge}
            title='请求速率'
            value={formatRpm(effective.max_rpm)}
            desc='满后排队，不切号；0 = 不限'
            pending={pendingCards ? !!pendingCards.rpm : pending}
            buttonRef={(node) => {
              triggerRefs.current.rpm = node
            }}
            disabled={saving}
            onClick={() => openDialog('rpm')}
          />
          <QuotaSummary
            icon={MessageSquare}
            title='会话容量'
            value={
              effective.max_sessions ? String(effective.max_sessions) : '不限'
            }
            desc='活跃对话窗口，5 分钟空闲回收'
            pending={pendingCards ? !!pendingCards.sessions : pending}
            buttonRef={(node) => {
              triggerRefs.current.sessions = node
            }}
            disabled={saving}
            onClick={() => openDialog('sessions')}
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

      <Dialog
        open={dialog !== null}
        onOpenChange={(next) => {
          if (!next && !saving) closeDialog()
        }}
      >
        <DialogContent
          showCloseButton={!saving}
          className={quotaDialogClass(dialog ?? '', false)}
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
              <OpenAIGates
                policy={draft}
                onChange={(patch) =>
                  setDraft((current) => ({ ...current, ...patch }))
                }
              />
            ) : null}
            {dialog === 'concurrency' ? (
              <OpenAICapacity
                policy={draft}
                onChange={(patch) =>
                  setDraft((current) => ({ ...current, ...patch }))
                }
              />
            ) : null}
            {dialog === 'rpm' ? (
              <OpenAIRpm
                policy={draft}
                onChange={(patch) =>
                  setDraft((current) => ({ ...current, ...patch }))
                }
              />
            ) : null}
            {dialog === 'sessions' ? (
              <OpenAISessions
                policy={draft}
                onChange={(patch) =>
                  setDraft((current) => ({ ...current, ...patch }))
                }
              />
            ) : null}
            {dialog === 'details' ? (
              <PlatformAccountList
                platform='openai'
                items={items}
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
    </>
  )
}
