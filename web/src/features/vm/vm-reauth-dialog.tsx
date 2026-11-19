import { useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { isAntigravityVm } from '@/lib/vm-kind'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SlotIdentity } from '@/components/platform-chip'
import { CredentialPanel } from '@/features/vm/credential-panel'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'

/** 重新授权：复用导入凭证面板（授权链接 / 粘贴 code / 直接写入）。 */
export function VmReauthDialog({
  vm,
  onOpenChange,
}: {
  vm: Vm | null
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  return (
    <Dialog open={vm != null} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[88vh] flex-col gap-3 sm:max-w-xl'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2 text-base'>
            重新授权
            {vm ? <SlotIdentity vm={vm} compact /> : null}
          </DialogTitle>
          <DialogDescription>
            {vm && isAntigravityVm(vm)
              ? '完成官方 Antigravity OAuth 登录，将账号绑定到当前槽位。'
              : '生成授权链接换取新凭证，写入后覆盖当前槽位的令牌。'}
          </DialogDescription>
        </DialogHeader>
        <div className='-me-3 min-h-0 flex-1 overflow-y-auto pe-3'>
          {vm ? (
            <CredentialPanel
              key={vm.id}
              vm={vm}
              showConvert={false}
              onCommitted={async (_data, vmId, what) => {
                toast.success(what)
                onOpenChange(false)
                await Promise.all([
                  qc.invalidateQueries({
                    queryKey: vmQueryOptions(vmId).queryKey,
                  }),
                  qc.invalidateQueries({
                    queryKey: vmsListQueryOptions().queryKey,
                  }),
                ])
              }}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
