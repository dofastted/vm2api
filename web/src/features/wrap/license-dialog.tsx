import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { CragLicenseEditor } from '@/features/vm/crag-license-editor'
import { vmCragLicenseQueryOptions } from '@/features/vm/queries'

export function KernelLicenseDialog({
  vm,
  onClose,
}: {
  vm: Vm
  onClose: () => void
}) {
  const license = useQuery(vmCragLicenseQueryOptions(vm.id))

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className='max-h-[88dvh] overflow-y-auto motion-reduce:animate-none sm:max-w-xl [&_button]:min-h-11 [&_svg]:motion-reduce:animate-none [&>section]:border-t-0 [&>section]:pt-0'
        showCloseButton={false}
      >
        <DialogTitle>{vm.name || vm.id}</DialogTitle>
        <DialogDescription className='sr-only'>
          查看本槽授权状态。订阅套餐只在订阅页用订阅使用券兑换。
        </DialogDescription>
        <CragLicenseEditor
          vmId={vm.id}
          data={license.data}
          loading={license.isFetching}
          loadError={license.error}
          onRefresh={() => {
            void license.refetch()
          }}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  )
}
