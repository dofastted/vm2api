import type { Vm } from '@/types/panel-vm'

export type VmKind = 'claude' | 'codex'

function labelOf(vm: Vm | undefined, key: 'platform' | 'family' | 'kind') {
  return String(vm?.[key] || '')
    .trim()
    .toLowerCase()
}

export function vmKindOf(vm: Vm | undefined): VmKind {
  if (!vm) return 'claude'
  const platform = labelOf(vm, 'platform')
  const family = labelOf(vm, 'family')
  const kind = labelOf(vm, 'kind')
  if (
    platform === 'openai' ||
    family === 'codex' ||
    kind === 'codex' ||
    kind === 'gpt'
  ) {
    return 'codex'
  }
  if (platform === 'anthropic' || family === 'claude' || kind === 'claude') {
    return 'claude'
  }
  if (vm.codex_kernel === true) return 'codex'
  if (String(vm.inference_engine || '').trim() === 'codex') return 'codex'
  if (String(vm.runtime?.codex_kernel || '').trim() === '1') return 'codex'
  return 'claude'
}

export function isCodexVm(vm: Vm | undefined): boolean {
  return vmKindOf(vm) === 'codex'
}

export function platformLabel(vm: Vm | undefined): 'Claude' | 'GPT' {
  return isCodexVm(vm) ? 'GPT' : 'Claude'
}

export function platformLabelOf(kind: VmKind): 'Claude' | 'GPT' {
  return kind === 'codex' ? 'GPT' : 'Claude'
}

export function indexVms(vms: Vm[] | undefined | null): Map<string, Vm> {
  const map = new Map<string, Vm>()
  for (const vm of vms || []) {
    if (vm?.id) map.set(vm.id, vm)
  }
  return map
}

/** 没有槽位对象时，用模型名 / 协议猜平台。 */
export function kindFromModel(
  model?: string | null,
  protocol?: string | null
): VmKind {
  const proto = String(protocol || '')
    .trim()
    .toLowerCase()
  if (
    proto === 'openai' ||
    proto === 'codex' ||
    proto === 'gpt' ||
    proto.includes('openai')
  ) {
    return 'codex'
  }
  if (isGptCatalogId(String(model || ''), proto)) return 'codex'
  return 'claude'
}

export function slotAccountLabel(
  vm?: Vm,
  fallback?: { email?: string | null; vmId?: string | null }
): string {
  const email = String(vm?.email || fallback?.email || '').trim()
  if (email) return email
  const id = String(fallback?.vmId || vm?.id || '').trim()
  return id || '未绑定账号'
}

/** 卡片 / 表格用：本地段优先，域名过长只留尾标。完整地址走 title。 */
export function compactEmail(email: string, max = 22): string {
  const value = String(email || '').trim()
  if (!value || value.length <= max) return value
  const at = value.lastIndexOf('@')
  if (at <= 0) return `${value.slice(0, Math.max(1, max - 1))}…`
  const local = value.slice(0, at)
  const domain = value.slice(at + 1)
  const keepDomain = domain.length <= 12 ? domain : domainTail(domain, 12)
  if (local.length + 1 + keepDomain.length <= max) {
    return `${local}@${keepDomain}`
  }
  const localKeep = Math.max(3, max - keepDomain.length - 2)
  return `${local.slice(0, localKeep)}…@${keepDomain}`
}

function domainTail(domain: string, max: number): string {
  const labels = domain.split('.')
  if (labels.length >= 2) {
    const tail = labels.slice(-2).join('.')
    if (tail.length <= max) return tail
  }
  return `${domain.slice(0, Math.max(1, max - 1))}…`
}

export function isGptCatalogId(id: string, family?: string) {
  const fam = String(family || '')
    .trim()
    .toLowerCase()
  if (fam === 'codex') return true
  return /^gpt/i.test(String(id || '')) && !/^gpt-image/i.test(String(id || ''))
}

export function catalogForVm<T extends { id: string; family?: string }>(
  items: T[],
  vm: Vm | undefined
): T[] {
  const gpt = isCodexVm(vm)
  return items.filter((item) =>
    isGptCatalogId(item.id, item.family) ? gpt : !gpt
  )
}
