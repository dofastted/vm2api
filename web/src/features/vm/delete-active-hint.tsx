import type { Vm } from '@/types/panel-vm'
import { Checkbox } from '@/components/ui/checkbox'
import { SlotIdentity } from '@/components/platform-chip'
import { planDeleteActiveVm } from '@/features/vm/active-vm'
import type { NodeGone } from '@/features/vm/delete-vm'

export function DeleteActiveVmHint({ target, vms }: { target: Vm; vms: Vm[] }) {
  const plan = planDeleteActiveVm(target, vms)
  if (plan.kind === 'normal' || plan.kind === 'sole_active') {
    return (
      <p className='mt-2 text-destructive'>
        删除槽位不可恢复：容器、家目录、凭证与代理绑定一并清除。
      </p>
    )
  }
  if (plan.kind === 'blocked') {
    return (
      <>
        <p className='mt-2 text-destructive'>
          此槽仍是全局活跃槽（active.json），且没有其它可调度、凭证有效的槽可自动接管。
        </p>
        <p className='mt-2 text-sm text-muted-foreground'>
          请先在列表或详情中使用「设为活跃」切换到其它槽位，再删除；或恢复至少一个可调度槽后再试。
        </p>
      </>
    )
  }
  return (
    <>
      <p className='mt-2 text-destructive'>
        此槽仍是全局活跃槽。确认后将先把活跃切到下方候选，再删除本槽。
      </p>
      <p className='mt-2 flex min-w-0 items-center gap-1.5 text-sm'>
        <span className='shrink-0 text-muted-foreground'>接管槽位</span>
        <SlotIdentity vm={plan.replacement} compact />
        <span className='shrink-0 font-mono text-xs text-muted-foreground'>
          · {plan.replacement.id}
        </span>
      </p>
    </>
  )
}

/** 槽所在节点不在或连不上时才出现；勾上后删除不再去节点上清理容器。 */
export function NodeGoneDeleteOption({
  gone,
  checked,
  onCheckedChange,
}: {
  gone: NodeGone | null
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  if (!gone) return null
  return (
    <div>
      <label className='flex items-center gap-2 text-sm'>
        <Checkbox
          checked={checked}
          onCheckedChange={(next) => onCheckedChange(next === true)}
        />
        节点不可达：只删除面板记录，节点上的容器不清理
      </label>
      <p className='mt-2 text-sm text-muted-foreground'>
        {gone === 'missing' ? '节点已不在集群列表里。' : '节点当前连不上。'}
        删除前服务端会再连一次节点，连得上就拒绝，请改用普通删除。
      </p>
    </div>
  )
}
