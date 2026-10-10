import type { PreflightCheck, PreflightCheckId } from '@/types/panel-cluster'
import type { Vm } from '@/types/panel-vm'
import { isApiError } from '@/lib/api'

/** 远端槽位上被后端 409 `remote_unsupported` 拒绝的操作统一用这句说明。 */
export const REMOTE_UNSUPPORTED_TEXT = '远端节点暂不支持'

/** `node_id` 为空 / 缺省即本机。 */
export function isRemoteVm(vm: Pick<Vm, 'node_id'> | null | undefined) {
  return !!vm?.node_id
}

export const PREFLIGHT_CHECK_LABEL: Record<PreflightCheckId, string> = {
  ssh: 'SSH',
  docker: 'Docker',
  arch: '架构',
  memory: '内存',
  disk: '磁盘',
  sudo: 'sudo',
  swap: 'Swap',
  image: '镜像',
  hostd: 'hostd',
  relay: '中继',
  kvm: 'KVM',
}

export type PreflightMark = 'ok' | 'fail' | 'warn'

/** ✓ 通过；✗ 失败的 error 级（阻断创建）；! 失败的 warn 级（只提示）。 */
export function preflightMark(check: Pick<PreflightCheck, 'ok' | 'level'>) {
  if (check.ok) return 'ok' as const
  return check.level === 'warn' ? ('warn' as const) : ('fail' as const)
}

/**
 * 409 `placement_preflight_failed` 的 `error.checks`。形状不对的条目丢弃，
 * 不是 ApiError 或没带 checks 时返回空数组。
 */
export function preflightChecksFromError(error: unknown): PreflightCheck[] {
  if (!isApiError(error) || !Array.isArray(error.checks)) return []
  return error.checks.filter(
    (c): c is PreflightCheck =>
      !!c &&
      typeof c === 'object' &&
      typeof (c as PreflightCheck).id === 'string' &&
      typeof (c as PreflightCheck).ok === 'boolean' &&
      ((c as PreflightCheck).level === 'error' ||
        (c as PreflightCheck).level === 'warn')
  )
}

/** 构建日志只留最后 `lines` 行；尾部换行不算一行。 */
export function logTail(log: string | null | undefined, lines = 20): string {
  const rows = String(log || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/, '')
    .split('\n')
  return rows.slice(-lines).join('\n')
}
