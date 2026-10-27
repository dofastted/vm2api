import type { Dashboard } from '@/types/panel-overview'
import type {
  Vm,
  VmBillingModelRow,
  VmDetailPayload,
  VmKernelSnapshot,
  VmProxySnap,
} from '@/types/panel-vm'
import type {
  ConcurrencyInfo,
  RpmInfo,
  VmCostSummary,
  WeeklySplitSummary,
} from '@/lib/fable-status'
import { fmtNum, fmtUsd } from '@/lib/format'
import { isCodexVm } from '@/lib/vm-kind'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TabsContent } from '@/components/ui/tabs'
import { VmCostByModel } from '@/features/vm/detail-cost-by-model'
import { VmStatusBoard } from '@/features/vm/detail-status-board'
import type { VmTodayCounts } from '@/features/vm/detail-today'
import { VmEngineEditor } from '@/features/vm/engine-editor'
import { VmPersonaEditor } from '@/features/vm/persona-editor'

type VmOverviewTabProps = {
  vm: Vm
  kernel?: VmKernelSnapshot | null
  acc: Record<string, unknown>
  proxy: VmProxySnap
  dash: { data: Dashboard | undefined }
  u5: number
  u7: number
  tierKey: string
  now: number
  cost: VmCostSummary
  split: WeeklySplitSummary | null
  conc: ConcurrencyInfo
  rpm: RpmInfo | null
  today: VmTodayCounts
  costByModel?: VmBillingModelRow[]
  billing?: VmDetailPayload['billing']
}

export function periodOf(
  billing: Record<string, unknown> | null | undefined,
  key: string
) {
  const row = billing?.[key]
  if (!row || typeof row !== 'object') return null
  const src = row as Record<string, unknown>
  return {
    requests: Number(src.requests) || 0,
    input: Number(src.input_tokens) || 0,
    output: Number(src.output_tokens) || 0,
    read: Number(src.cache_read_tokens) || 0,
    write: Number(src.cache_creation_tokens) || 0,
    cost: Number(src.total_cost) || 0,
  }
}

function OpenaiWindowStats({
  billing,
}: {
  billing?: Record<string, unknown> | null
}) {
  const windows = [
    ['5h', periodOf(billing, 'window_5h')],
    ['7d', periodOf(billing, 'window_7d')],
    ['今日', periodOf(billing, 'today')],
  ] as const
  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>计费窗口</CardTitle>
        <p className='text-xs text-muted-foreground'>
          官方价 · 5 小时、7 天和今日
        </p>
      </CardHeader>
      <CardContent className='grid gap-3 sm:grid-cols-3'>
        {windows.map(([label, row]) => (
          <div key={label} className='rounded-md border px-3 py-2'>
            <div className='text-xs text-muted-foreground'>{label}</div>
            <div className='mt-1 text-lg font-semibold tabular-nums'>
              {fmtUsd(row?.cost || 0, 2)}
            </div>
            <div className='mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground tabular-nums'>
              <div>{fmtNum(row?.requests || 0)} req</div>
              <div>
                入 {fmtNum(row?.input || 0)} · 出 {fmtNum(row?.output || 0)}
              </div>
              <div>
                缓存 {fmtNum(row?.read || 0)} / {fmtNum(row?.write || 0)}
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

export function VmOverviewTab(props: VmOverviewTabProps) {
  const { vm, kernel, costByModel, billing, ...board } = props
  return (
    <TabsContent value='overview' className='space-y-3 pt-3'>
      <VmStatusBoard vm={vm} kernel={kernel} billing={billing} {...board} />
      {isCodexVm(vm) ? <OpenaiWindowStats billing={billing} /> : null}
      <VmCostByModel rows={costByModel} />
      {isCodexVm(vm) ? null : (
        <div className='grid gap-3 lg:grid-cols-2'>
          <VmEngineEditor id={vm.id} vm={vm} kernel={kernel} />
          <VmPersonaEditor id={vm.id} vm={vm} />
        </div>
      )}
    </TabsContent>
  )
}
