import type { Vm } from '@/types/panel-vm'

export type VmKind = 'claude' | 'codex' | 'antigravity' | 'unknown'

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
  for (const label of [platform, family, kind]) {
    if (!label) continue
    if (label === 'antigravity') return 'antigravity'
    if (label === 'anthropic' || label === 'claude') return 'claude'
    if (['openai', 'codex', 'gpt', 'chatgpt'].includes(label)) return 'codex'
    if (label === platform) return 'unknown'
  }
  if (vm.codex_kernel === true) return 'codex'
  if (String(vm.inference_engine || '').trim() === 'codex') return 'codex'
  if (String(vm.runtime?.codex_kernel || '').trim() === '1') return 'codex'
  return 'claude'
}

export function isCodexVm(vm: Vm | undefined): boolean {
  return vmKindOf(vm) === 'codex'
}

export function isAntigravityVm(vm: Vm | undefined): boolean {
  return vmKindOf(vm) === 'antigravity'
}

export function isClaudeVm(vm: Vm | undefined): boolean {
  return vmKindOf(vm) === 'claude'
}

export function platformLabel(vm: Vm | undefined): string {
  return platformLabelOf(vmKindOf(vm))
}

export function platformLabelOf(kind: VmKind): string {
  return {
    claude: 'Claude',
    codex: 'GPT',
    antigravity: 'Antigravity',
    unknown: '未知平台',
  }[kind]
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
  const raw = String(model || '').trim()
  const proto = String(protocol || '')
    .trim()
    .toLowerCase()
  if (/^gemini-/i.test(raw) || proto === 'antigravity') return 'antigravity'
  if (
    proto === 'openai' ||
    proto === 'codex' ||
    proto === 'gpt' ||
    proto.includes('openai')
  ) {
    return 'codex'
  }
  if (isGptCatalogId(raw, proto)) return 'codex'
  return 'claude'
}

/** UI binding state only. This does not imply gateway token availability or pool eligibility. */
export function hasSlotCredential(vm?: Partial<Vm>): boolean {
  if (isAntigravityVm(vm as Vm | undefined))
    return vm?.antigravity?.authenticated === true
  return vm?.has_token === true
}

/** Account line on rack cards: credential presence is independent of the email. */
export function slotCredentialLabel(vm?: Partial<Vm>, compact = false): string {
  if (isAntigravityVm(vm as Vm | undefined) && !hasSlotCredential(vm))
    return '空槽'
  const email = String(vm?.email || '').trim()
  if (email) return compact ? email.split('@')[0] : email
  if (isAntigravityVm(vm as Vm | undefined) && hasSlotCredential(vm))
    return '已登录官方客户端'
  return vm?.has_token || vm?.has_refresh ? '已导入账号 · 邮箱未知' : '空槽'
}

export function slotAccountLabel(
  vm?: Vm,
  fallback?: {
    email?: string | null
    vmId?: string | null
    /** Shown when there is no VM at all, e.g. a request that never got an execution seat. */
    emptyLabel?: string
  }
): string {
  const email = String(vm?.email || fallback?.email || '').trim()
  if (email) return email
  const id = String(fallback?.vmId || vm?.id || '').trim()
  return id || fallback?.emptyLabel || '未绑定账号'
}

/** `vm-01` with only its creation number is unbound. A distinct display name stays visible. */
export function slotNameLabel(vm?: Partial<Vm>): string {
  const id = String(vm?.id || '').trim()
  const rawName = String(vm?.name || '').trim()
  const email = String(vm?.email || '').trim()
  const nameNum = slotNumber(rawName)
  const idNum = slotNumber(id)
  const sameNumber = nameNum != null && idNum != null && nameNum === idNum
  if (isAntigravityVm(vm as Vm | undefined) && hasSlotCredential(vm))
    return rawName || id || '已登录官方客户端'
  if (rawName && rawName !== id && !sameNumber) return rawName
  const name = rawName || id
  if (email || (name && !/^vm-\d+$/i.test(id))) return name || '未绑定账号'
  return '未绑定账号'
}

function slotNumber(value: string): number | null {
  const matched = value.match(/^vm-(\d+)$/i) || value.match(/^0*(\d+)$/)
  return matched ? Number(matched[1]) : null
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

/** 左侧名称：固定字符数，超出用省略号。完整原文放 title。 */
export const SLOT_LABEL_MAX = 10

export function clipLabel(value: string, max = SLOT_LABEL_MAX): string {
  const text = String(value || '')
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars.slice(0, max).join('')}…`
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

export function catalogForVm<
  T extends { id: string; family?: string; platform?: string },
>(items: T[], vm: Vm | undefined): T[] {
  const kind = vmKindOf(vm)
  return items.filter((item) => {
    const platform = String(item.platform || '').toLowerCase()
    const itemKind: VmKind = platform
      ? platform === 'antigravity'
        ? 'antigravity'
        : platform === 'openai'
          ? 'codex'
          : platform === 'anthropic'
            ? 'claude'
            : 'unknown'
      : /^gemini-/i.test(item.id) || item.family === 'antigravity'
        ? 'antigravity'
        : isGptCatalogId(item.id, item.family)
          ? 'codex'
          : 'claude'
    return itemKind === kind
  })
}
