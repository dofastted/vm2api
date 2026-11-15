import type { Vm } from '@/types/panel-vm'
import { credentialRegistrationOf } from '@/lib/cred-type'
import { tierVisual } from '@/lib/tier-visual'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { claudeTier } from '@/lib/vm-status'
import { ActiveVmBadge } from '@/features/vm/active-vm-badge'

export function VmAccountIdentity({ vm }: { vm: Vm }) {
  const email = vm.email?.trim() || ''
  const prefix = email.split('@', 1)[0]
  const counter = /(?:^|[-_])(\d+)$/.exec(vm.id)?.[1]
  const registration = credentialRegistrationOf(vm)
  const crag = (vm.resolved_dataplane ?? vm.dataplane) === 'crag'
  const node = vm.node_name || vm.node_id || 'local'
  return (
    <div className='min-w-0 space-y-0.5'>
      <div className='flex min-w-0 items-center gap-1.5 text-[11px]'>
        <span className='shrink-0 font-medium text-muted-foreground'>
          {isCodexVm(vm) ? 'openai' : 'anthropic'}
        </span>
        <span className='shrink-0 font-mono font-medium' title={vm.name}>
          {vm.id}
        </span>
        {prefix ? (
          <span className='truncate'>
            {counter ? `${counter}·${prefix}` : prefix}
          </span>
        ) : null}
        <ActiveVmBadge vm={vm} />
      </div>
      <div className='truncate text-xs font-semibold' title={email}>
        {email || '未绑定邮箱'}
      </div>
      <div className='flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground'>
        <span
          className={cn('rounded px-1 font-semibold', tierVisual(vm).badge)}
        >
          {claudeTier(vm).label}
        </span>
        <span aria-hidden='true'>|</span>
        <span>{vm.runtime_type === 'kvm' ? 'kvm' : 'vm'}</span>
        <span aria-hidden='true'>|</span>
        <span>{registration === 'none' ? '无凭证' : registration}</span>
      </div>
      <div className='flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground'>
        <span
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none font-semibold',
            crag
              ? 'bg-orange-200 text-orange-900 dark:bg-orange-400/20 dark:text-orange-300'
              : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-300/20 dark:text-zinc-300'
          )}
          title='当前内核'
        >
          {crag ? 'crag' : '默认'}
        </span>
        <span className='truncate' title={node}>
          {node}
        </span>
      </div>
    </div>
  )
}
