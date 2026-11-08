import type { VmKernelHealth } from '@/types/panel-vm'

export function kernelVersionOf(health?: VmKernelHealth | null): string {
  return String(health?.worker_version || health?.version || '').trim()
}

/** wrap 进程是否在。不要用 `reachable`：那还要求 ready_slots>=1。 */
export function kernelProcessUp(health?: VmKernelHealth | null): boolean {
  if (!health) return false
  if (health.process_up != null) return !!health.process_up
  return !!health.reachable
}

/** cli-hop 现在能否接推理。`reachable === process_up && ready_slots>=1`。 */
export function kernelHopReady(health?: VmKernelHealth | null): boolean {
  return !!health?.reachable
}

export function wrapHealthLabel(
  health?: VmKernelHealth | null,
  hop = 'cli-hop'
): string {
  if (!health) return '—'
  const version = kernelVersionOf(health)
  const slots = health.ready_slots
  const processUp = kernelProcessUp(health)
  if (kernelHopReady(health)) {
    const bits = ['在线']
    if (health.provider === 'local_cli' && hop) bits.push(hop)
    if (slots != null) bits.push(`${slots} 槽就绪`)
    if (version) bits.push(version)
    return bits.join(' · ')
  }
  if (processUp) {
    const bits = ['kernel 在', 'CLI 未就绪']
    if (slots != null) bits.push(`槽 ${slots}`)
    return bits.join(' · ')
  }
  return '不可用'
}

export function wrapSyncKernelFails(
  items?: { ok?: boolean; kernel?: { ok?: boolean } }[]
): number {
  return (items || []).filter(
    (item) => item.ok && item.kernel && item.kernel.ok === false
  ).length
}
