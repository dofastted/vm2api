import type { Vm } from '@/types/panel-vm'
import ClaudeColor from '@lobehub/icons/es/Claude/components/Color'
import GeminiColor from '@lobehub/icons/es/Gemini/components/Color'
import OpenAI from '@lobehub/icons/es/OpenAI/components/Mono'
import { credentialRegistrationOf } from '@/lib/cred-type'
import { tierVisual } from '@/lib/tier-visual'
import { cn } from '@/lib/utils'
import { clipLabel, isCodexVm } from '@/lib/vm-kind'
import { claudeTier } from '@/lib/vm-status'
import { ActiveVmBadge } from '@/features/vm/active-vm-badge'
import { VmRentedMark } from '@/features/vm/vm-owner-line'

export function PlatformMark({ vm }: { vm: Vm }) {
  const gpt = isCodexVm(vm)
  const Icon = vm.gemini ? GeminiColor : gpt ? OpenAI : ClaudeColor
  const label = vm.gemini ? 'Gemini' : gpt ? 'openai' : 'anthropic'
  return (
    <span
      className='inline-flex size-3.5 shrink-0 items-center justify-center'
      role='img'
      aria-label={label}
      title={label}
    >
      <Icon className='size-3.5' aria-hidden />
    </span>
  )
}

export function VmAccountIdentity({ vm }: { vm: Vm }) {
  const email = vm.email?.trim() || ''
  const registration = credentialRegistrationOf(vm)
  const crag = (vm.resolved_dataplane ?? vm.dataplane) === 'crag'
  const node = vm.node_name || vm.node_id || 'local'
  return (
    <div className='min-w-0 space-y-0.5'>
      <div className='flex min-w-0 items-center gap-1.5 text-[11px]'>
        <PlatformMark vm={vm} />
        <span
          className='truncate font-mono font-medium'
          title={vm.name ? `${vm.name} · ${vm.id}` : vm.id}
        >
          {clipLabel(vm.name || vm.id, 16)}
        </span>
      </div>
      <div className='flex min-w-0 items-center gap-1.5'>
        <div
          className='truncate text-xs font-semibold'
          title={email || undefined}
        >
          {email ? clipLabel(email) : '未绑定邮箱'}
        </div>
        <ActiveVmBadge vm={vm} />
      </div>
      <div className='flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground'>
        <span
          className={cn('rounded px-1 font-semibold', tierVisual(vm).badge)}
        >
          {vm.gemini
            ? vm.gemini.account?.plan || 'Gemini'
            : claudeTier(vm).label}
        </span>
        <span aria-hidden='true'>|</span>
        <span>
          {vm.gemini ? '宿主机' : vm.runtime_type === 'kvm' ? 'kvm' : 'vm'}
        </span>
        <span aria-hidden='true'>|</span>
        <span>{registration === 'none' ? '无凭证' : registration}</span>
        <VmRentedMark vm={vm} />
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
          {vm.gemini ? 'CRAGAnti' : crag ? 'crag' : '默认'}
        </span>
        <span className='truncate' title={node}>
          {node}
        </span>
      </div>
    </div>
  )
}
