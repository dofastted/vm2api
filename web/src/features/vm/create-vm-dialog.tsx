import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CreateVmForm, useCreateVmDraft } from '@/features/vm/create-vm-form'

/**
 * 槽位页的快捷创建。完整的「创建 → 出口 → 账号 → 上线」在导入页；
 * 这里只建槽，可选创建后直接开机 / 分配出口。
 */
export function CreateVmDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>创建槽位</DialogTitle>
          <DialogDescription>
            只建槽。要一路导入账号到上线，用「导入」页。
          </DialogDescription>
        </DialogHeader>
        {open ? <DialogBody onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

// 每次打开都是新草稿：关闭即卸载，不残留上次的选择。
function DialogBody({ onDone }: { onDone: () => void }) {
  const draft = useCreateVmDraft({ onCreated: onDone })
  return <CreateVmForm draft={draft} variant='dialog' onCancel={onDone} />
}
