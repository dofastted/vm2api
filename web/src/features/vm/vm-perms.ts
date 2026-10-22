import { useQuery } from '@tanstack/react-query'
import type { PanelRole } from '@/types/panel-auth'
import { meQueryOptions } from '@/features/auth/queries'

/** VM 页面按角色能做的事，对齐后端 src/lib/admin/panel-acl.mjs。 */
export type VmPerms = {
  /** me 已返回、角色已知。 */
  known: boolean
  admin: boolean
  /** GET /api/panel/dashboard（admin、super）。 */
  dashboard: boolean
  /** 开机 / 关机 / 探测。 */
  power: boolean
  /** test-chat、定时测试。 */
  test: boolean
  /** GET /api/panel/test-models（后端目前只放行 admin）。 */
  testModels: boolean
  /** oauth/*、导入凭证、额度刷新、重置券、诊断与恢复服务。 */
  credential: boolean
  /** DELETE /vms/:id（仅管理员）。 */
  remove: boolean
}

const NONE: VmPerms = {
  known: false,
  admin: false,
  dashboard: false,
  power: false,
  test: false,
  testModels: false,
  credential: false,
  remove: false,
}

/** 角色未知（me 还没回来）时一律不放行，避免先发一批 403。 */
export function vmPermsFor(
  role: PanelRole | string | null | undefined
): VmPerms {
  if (role === 'admin') {
    return {
      known: true,
      admin: true,
      dashboard: true,
      power: true,
      test: true,
      testModels: true,
      credential: true,
      remove: true,
    }
  }
  if (role === 'user') {
    return {
      ...NONE,
      known: true,
      power: true,
      test: true,
      credential: true,
      remove: false,
    }
  }
  if (role === 'super') return { ...NONE, known: true, dashboard: true }
  return NONE
}

export function useVmPerms(): VmPerms {
  const me = useQuery(meQueryOptions())
  return vmPermsFor(me.data?.role)
}

export type VmDetailTab =
  'overview' | 'account' | 'proxy' | 'test' | 'ops' | 'seed'

export function vmDetailTabs(perms: VmPerms): VmDetailTab[] {
  const tabs: VmDetailTab[] = ['overview', 'account', 'proxy']
  if (perms.test) tabs.push('test')
  if (perms.admin) tabs.push('ops', 'seed')
  return tabs
}

/** 选中的页签当前角色看不到时回到概览。 */
export function visibleTab(tab: string, tabs: readonly string[]): string {
  return tabs.includes(tab) ? tab : 'overview'
}

/** 下拉里记住的出口已不在候选里（被绑满、切了槽）时回落到第一个候选。 */
export function pickBindTarget(
  bindId: string,
  candidates: readonly { id?: string | null }[]
): string {
  if (bindId && candidates.some((p) => p.id === bindId)) return bindId
  return candidates[0]?.id || ''
}
