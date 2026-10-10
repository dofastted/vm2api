import type { Vm } from '@/types/panel-vm'
import { Box, Cpu } from 'lucide-react'
import { cn } from '@/lib/utils'
import { runtimeTypeLabel, runtimeTypeOf } from '@/features/vm/machine-spec'

/**
 * 槽位形态：容器 (Docker) / 虚拟机 (KVM)。旧槽没有 runtime_type 时按容器。
 */
export function RuntimeChip({
  vm,
  className,
}: {
  vm: Pick<Vm, 'runtime_type'>
  className?: string
}) {
  const type = runtimeTypeOf(vm)
  const kvm = type === 'kvm'
  const label = runtimeTypeLabel(type)
  const Icon = kvm ? Cpu : Box
  return (
    <span
      className={cn(
        'inline-flex max-w-[10rem] shrink-0 items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-[10px] leading-none font-semibold tracking-[0.03em]',
        kvm
          ? 'border-primary/40 text-foreground'
          : 'border-border/70 text-muted-foreground',
        className
      )}
      title={kvm ? 'KVM 虚拟机' : 'Docker 容器'}
    >
      <Icon className='size-2.5 shrink-0' aria-hidden='true' />
      <span className='truncate'>{label}</span>
    </span>
  )
}
