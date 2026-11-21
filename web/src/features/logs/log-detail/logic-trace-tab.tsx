import { useState } from 'react'
import type { ProviderChainItem, UsageLogRow } from '@/types/panel-usage-logs'
import {
  AlertCircle,
  Check,
  CheckCircle,
  Clock,
  Copy,
  GitBranch,
  Link2,
  RefreshCw,
  Server,
  XCircle,
} from 'lucide-react'
import { formatDuration } from '@/lib/usage-format'
import { Badge } from '@/components/ui/badge'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  chainItemName,
  chainItemStatus,
  isSuccessStatus,
  selectionReasonLabel,
  terminalStateLabel,
  type ChainItemStatus,
} from '../log-display'
import { StepCard, type StepStatus } from './step-card'

const STATUS_TO_STEP: Record<ChainItemStatus, StepStatus> = {
  success: 'success',
  failure: 'failure',
  pending: 'pending',
}

function Field({ label, value }: { label: string; value: string | null }) {
  if (value == null || value === '') return null
  return (
    <div className='flex gap-2'>
      <span className='shrink-0 text-muted-foreground'>{label}:</span>
      <span className='min-w-0 font-mono break-all'>{value}</span>
    </div>
  )
}

function AttemptDetails({ item }: { item: ProviderChainItem }) {
  return (
    <div className='space-y-2 text-xs'>
      <Field label='槽位' value={item.vmName || item.vmId} />
      {item.vmName && item.vmId ? (
        <Field label='槽位 ID' value={item.vmId} />
      ) : null}
      <Field label='账号' value={item.providerName || item.accountId} />
      <Field label='模型' value={item.model} />
      <Field
        label='选择方式'
        value={selectionReasonLabel(item.selectionReason)}
      />
      <Field
        label='上游状态'
        value={item.upstreamStatus != null ? String(item.upstreamStatus) : null}
      />
      <Field label='终态' value={terminalStateLabel(item.terminalState)} />
      <Field label='错误域' value={item.errorScope} />
      <Field label='动作' value={item.action} />
      <Field
        label='已提交下游'
        value={item.downstreamCommitted ? '是' : '否'}
      />
      <Field
        label='调度总耗时'
        value={item.waitMs != null ? formatDuration(item.waitMs) : null}
      />
      <Field
        label='调度处理'
        value={
          item.schedulingMs != null ? formatDuration(item.schedulingMs) : null
        }
      />
      <Field
        label='排队等待'
        value={
          item.queueWaitMs != null ? formatDuration(item.queueWaitMs) : null
        }
      />
      <Field
        label='首 Token'
        value={item.ttftMs != null ? formatDuration(item.ttftMs) : null}
      />
      <Field
        label='耗时'
        value={item.latencyMs != null ? formatDuration(item.latencyMs) : null}
      />
      <Field label='开始' value={item.startedAt} />
      <Field label='结束' value={item.completedAt} />
    </div>
  )
}

function attemptTitle(item: ProviderChainItem, index: number): string {
  if (index > 0) return `重试 #${item.attemptNumber}`
  return `尝试: ${chainItemName(item)}`
}

function attemptSubtitle(item: ProviderChainItem): string | null {
  const parts = [
    item.upstreamStatus != null ? `HTTP ${item.upstreamStatus}` : null,
    terminalStateLabel(item.terminalState),
    selectionReasonLabel(item.selectionReason),
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

function attemptIcon(item: ProviderChainItem, index: number) {
  if (index === 0 && item.selectionReason === 'sticky') return Link2
  if (index > 0) return RefreshCw
  const status = chainItemStatus(item)
  if (status === 'success') return CheckCircle
  if (status === 'failure') return XCircle
  return Server
}

/** 纯文本技术时间线，供复制排障。 */
function formatTimeline(row: UsageLogRow): string {
  const base = Date.parse(row.providerChain[0]?.startedAt ?? '')
  return row.providerChain
    .map((item) => {
      const offset = Number.isFinite(base)
        ? `+${Math.max(0, Date.parse(item.startedAt ?? '') - base) || 0}ms`
        : ''
      const parts = [
        `#${item.attemptNumber}`,
        offset,
        chainItemName(item),
        item.providerName ? `(${item.providerName})` : '',
        item.selectionReason ? `reason=${item.selectionReason}` : '',
        item.upstreamStatus != null ? `status=${item.upstreamStatus}` : '',
        item.terminalState ? `state=${item.terminalState}` : '',
        item.errorScope ? `scope=${item.errorScope}` : '',
        item.action ? `action=${item.action}` : '',
        item.waitMs != null ? `wait=${item.waitMs}ms` : '',
        item.ttftMs != null ? `ttft=${item.ttftMs}ms` : '',
        item.latencyMs != null ? `latency=${item.latencyMs}ms` : '',
        item.downstreamCommitted ? 'committed' : '',
      ]
      return parts.filter(Boolean).join(' ')
    })
    .join('\n')
}

function TechnicalTimeline({ row }: { row: UsageLogRow }) {
  const [copied, setCopied] = useState(false)
  const timeline = formatTimeline(row)
  return (
    <div className='mt-6 space-y-2 border-t pt-6'>
      <h4 className='flex items-center gap-2 text-sm font-semibold'>
        <Clock className='h-4 w-4 text-slate-600' />
        技术时间线
      </h4>
      <Collapsible defaultOpen>
        <CollapsibleTrigger className='text-xs text-muted-foreground hover:text-foreground'>
          技术时间线
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className='group relative mt-2 max-h-[400px] overflow-x-hidden overflow-y-auto rounded-lg border bg-muted/50 p-4'>
            <button
              type='button'
              title='复制时间线'
              className={`absolute top-2 right-2 rounded-md border bg-background/80 p-1.5 transition-opacity hover:bg-muted ${copied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
              onClick={() => {
                void navigator.clipboard.writeText(timeline).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                })
              }}
            >
              {copied ? (
                <Check className='h-3.5 w-3.5 text-emerald-600' />
              ) : (
                <Copy className='h-3.5 w-3.5' />
              )}
            </button>
            <pre className='font-mono text-xs leading-relaxed break-words whitespace-pre-wrap'>
              {timeline}
            </pre>
          </div>
          {row.durationMs != null ? (
            <div className='mt-1 text-right text-xs text-muted-foreground'>
              总耗时: {row.durationMs}ms
            </div>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

/** 「决策链」：每次上游尝试一张 StepCard（hub LogicTraceTab 的串行分支）。 */
export function LogicTraceTab({
  row,
  initialExpandedIndex,
}: {
  row: UsageLogRow
  initialExpandedIndex?: number
}) {
  const chain = row.providerChain
  const base = Date.parse(chain[0]?.startedAt ?? '')
  const sticky = chain[0]?.selectionReason === 'sticky'
  const vmCount = new Set(chain.map((item) => item.vmId).filter(Boolean)).size

  return (
    <div className='space-y-6'>
      {row.blockedBy ? (
        <div className='rounded-lg border border-orange-200 bg-orange-50 p-4 dark:border-orange-800 dark:bg-orange-950/20'>
          <div className='mb-2 flex items-center gap-2'>
            <AlertCircle className='h-4 w-4 text-orange-600' />
            <span className='text-sm font-medium'>拦截信息</span>
            <Badge
              variant='outline'
              className='border-orange-600 text-orange-600'
            >
              {row.blockedBy}
            </Badge>
          </div>
          {row.blockedReason ? (
            <pre className='rounded bg-orange-100 p-2 text-xs break-words whitespace-pre-wrap dark:bg-orange-900/50'>
              {row.blockedReason}
            </pre>
          ) : null}
        </div>
      ) : null}
      {chain.length ? (
        <>
          <div className='flex items-center justify-between'>
            <h4 className='flex items-center gap-2 text-sm font-semibold'>
              {sticky ? (
                <Link2 className='h-4 w-4 text-violet-600' />
              ) : (
                <GitBranch className='h-4 w-4 text-blue-600' />
              )}
              决策链
            </h4>
            <div className='flex items-center gap-1'>
              {sticky ? (
                <Badge
                  variant='outline'
                  className='bg-violet-50 text-[10px] text-violet-700 dark:bg-violet-950/30 dark:text-violet-300'
                >
                  粘性会话
                </Badge>
              ) : null}
              <Badge variant='outline' className='text-[10px]'>
                {vmCount} 台虚拟机
              </Badge>
            </div>
          </div>
          <div className='space-y-0'>
            {chain.map((item, index) => {
              const started = Date.parse(item.startedAt ?? '')
              return (
                <StepCard
                  key={`${item.attemptNumber}-${index}`}
                  step={index + 1}
                  icon={attemptIcon(item, index)}
                  title={attemptTitle(item, index)}
                  subtitle={attemptSubtitle(item)}
                  status={STATUS_TO_STEP[chainItemStatus(item)]}
                  offsetMs={
                    Number.isFinite(base) && Number.isFinite(started)
                      ? started - base
                      : null
                  }
                  defaultExpanded={initialExpandedIndex === index}
                  isLast={index === chain.length - 1}
                  details={<AttemptDetails item={item} />}
                />
              )
            })}
          </div>
          {row.errorMessage && !isSuccessStatus(row.statusCode) ? (
            <div className='space-y-1'>
              <div className='flex items-center gap-2 text-xs font-medium'>
                <AlertCircle className='h-4 w-4 text-rose-600' />
                错误
              </div>
              <pre className='rounded bg-rose-50 p-2 text-[10px] break-words whitespace-pre-wrap dark:bg-rose-950/20'>
                {row.errorMessage}
              </pre>
            </div>
          ) : null}
          <TechnicalTimeline row={row} />
        </>
      ) : row.blockedBy ? null : (
        <div className='py-8 text-center text-muted-foreground'>
          <GitBranch className='mx-auto mb-2 h-8 w-8 opacity-50' />
          暂无决策数据
        </div>
      )}
    </div>
  )
}
