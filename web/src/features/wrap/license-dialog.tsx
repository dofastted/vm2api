import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { activateVmCragLicense } from '@/lib/api'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { CragLicenseEditor } from '@/features/vm/crag-license-editor'
import { vmCragLicenseQueryOptions } from '@/features/vm/queries'
import { kernelCatalogQueryOptions } from './queries'

export function KernelLicenseDialog({
  vm,
  onClose,
}: {
  vm: Vm
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [registrationCode, setRegistrationCode] = useState('')
  const license = useQuery(vmCragLicenseQueryOptions(vm.id))
  const activate = useMutation({
    // Registration codes must not be retained in mutation variables.
    mutationFn: () => activateVmCragLicense(vm.id, registrationCode.trim()),
    onSuccess: async (data) => {
      setRegistrationCode('')
      qc.setQueryData(vmCragLicenseQueryOptions(vm.id).queryKey, data)
      await qc.invalidateQueries({
        queryKey: kernelCatalogQueryOptions().queryKey,
      })
      toast.success(
        data.license.valid ? 'CRAG 授权已激活' : '授权未生效，请检查状态'
      )
    },
  })

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !activate.isPending) onClose()
      }}
    >
      <DialogContent
        className='max-h-[88dvh] overflow-y-auto motion-reduce:animate-none sm:max-w-xl [&_button]:min-h-11 [&_svg]:motion-reduce:animate-none [&>section]:border-t-0 [&>section]:pt-0'
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (activate.isPending) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (activate.isPending) event.preventDefault()
        }}
      >
        <DialogTitle>{vm.name || vm.id}</DialogTitle>
        <DialogDescription className='sr-only'>
          离线通用码直接粘贴。在线设备授权需复制本槽机器码，再粘贴对应注册码。激活不会安装或启动内核。
        </DialogDescription>
        <CragLicenseEditor
          data={license.data}
          loading={license.isFetching}
          loadError={license.error}
          activationError={activate.error}
          registrationCode={registrationCode}
          activating={activate.isPending}
          onChange={(code) => {
            setRegistrationCode(code)
            activate.reset()
          }}
          onRefresh={() => {
            void license.refetch()
          }}
          onActivate={() => activate.mutate()}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  )
}
