import { CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * 未保存更改的浮动操作条。设置页的保存不再挂在页头 ——
 * 草稿一旦偏离服务端快照，操作条从底部滑入；保存成功、
 * 放弃或草稿改回原值后随 dirty 消失直接卸载（退出不做动画）。
 *
 * blockedReason 非空时保存被拦（persona 模板校验失败），
 * 原因直接写在条上，不藏在点击后的 toast 里。
 */
export function SaveBar({
  blockedReason,
  summary,
  saving,
  onSave,
  onDiscard,
}: {
  blockedReason?: string
  summary?: string
  saving: boolean
  onSave: () => void
  onDiscard: () => void
}) {
  return (
    <div className='pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4'>
      <div
        role='status'
        className='animate-save-bar-in pointer-events-auto flex max-w-full items-center gap-3 rounded-xl border bg-popover px-4 py-2 shadow-lg'
      >
        {blockedReason ? (
          <span className='flex min-w-0 items-center gap-1.5 text-sm text-destructive'>
            <CircleAlert className='size-4 shrink-0' aria-hidden />
            <span className='truncate'>{blockedReason}</span>
          </span>
        ) : (
          <span className='truncate text-sm text-muted-foreground'>
            {summary || '有未保存的更改'}
          </span>
        )}
        <div className='flex shrink-0 items-center gap-2'>
          <Button
            size='sm'
            variant='ghost'
            onClick={onDiscard}
            disabled={saving}
          >
            放弃
          </Button>
          <Button
            size='sm'
            onClick={onSave}
            disabled={saving || !!blockedReason}
            loading={saving}
          >
            保存
          </Button>
        </div>
      </div>
    </div>
  )
}
