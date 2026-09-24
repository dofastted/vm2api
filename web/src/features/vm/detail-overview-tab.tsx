import type { Dashboard } from '@/types/panel-overview'
import type {
  Vm,
  VmBillingModelRow,
  VmKernelSnapshot,
  VmProxySnap,
} from '@/types/panel-vm'
import type {
  ConcurrencyInfo,
  RpmInfo,
  SessionCapacity,
  VmCostSummary,
  WeeklySplitSummary,
} from '@/lib/fable-status'
import { isCodexVm } from '@/lib/vm-kind'
import { TabsContent } from '@/components/ui/tabs'
import { VmCostByModel } from '@/features/vm/detail-cost-by-model'
import { VmStatusBoard } from '@/features/vm/detail-status-board'
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
  sess: SessionCapacity | null
  conc: ConcurrencyInfo
  rpm: RpmInfo | null
  costByModel?: VmBillingModelRow[]
}

export function VmOverviewTab(props: VmOverviewTabProps) {
  const { vm, kernel, costByModel, ...board } = props
  return (
    <TabsContent value='overview' className='space-y-3 pt-3'>
      <VmStatusBoard vm={vm} kernel={kernel} {...board} />
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
