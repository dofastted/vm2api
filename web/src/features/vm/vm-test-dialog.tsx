import type { Vm } from '@/types/panel-vm'
import { credTypeOf } from '@/lib/cred-type'
import { isCodexVm } from '@/lib/vm-kind'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SlotIdentity } from '@/components/platform-chip'
import { VmTestPanel } from '@/features/vm/detail-test-tab'
import { useVmTestChat } from '@/features/vm/use-vm-test-chat'
import { VmTestSchedule } from '@/features/vm/vm-test-schedule'

function TestBody({ vm }: { vm: Vm }) {
  const chat = useVmTestChat(vm)
  return (
    <VmTestPanel
      {...chat}
      vm={vm}
      credType={credTypeOf(vm)}
      isCodex={isCodexVm(vm)}
      dataplane={vm.resolved_dataplane}
      cragKernelVersion={vm.resolved_crag_kernel_version}
      schedule={<VmTestSchedule key={vm.id} vm={vm} {...chat} />}
    />
  )
}

/** 测试链接：向该槽发一条真实对话，验证凭证、代理与内核整条链路。 */
export function VmTestDialog({
  vm,
  onOpenChange,
}: {
  vm: Vm | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={vm != null} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[88vh] flex-col gap-3 sm:max-w-xl'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2 text-base'>
            测试链接
            {vm ? <SlotIdentity vm={vm} compact /> : null}
          </DialogTitle>
          <DialogDescription>
            发一条真实对话，验证凭证、代理与内核整条链路。
          </DialogDescription>
        </DialogHeader>
        <div className='-me-3 min-h-0 flex-1 overflow-y-auto pe-3'>
          <div className='space-y-3 pb-1'>
            {vm ? <TestBody key={vm.id} vm={vm} /> : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
