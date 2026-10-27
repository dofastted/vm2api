import { createContext, useContext } from 'react'
import type { Vm } from '@/types/panel-vm'

/** 列表页所有行 / 卡片共用的槽位操作；由 VmActionsProvider 提供。 */
export type VmActions = {
  openDetail: (vm: Vm) => void
  openTest: (vm: Vm) => void
  openStats: (vm: Vm) => void
  openReauth: (vm: Vm) => void
  openRecovery: (vm: Vm) => void
  refreshToken: (vm: Vm) => void
  recover: (vm: Vm) => void
  /** 正在刷新令牌 / 恢复状态的槽位 id，用于禁用重复点击。 */
  refreshingId: string | null
  recoveringId: string | null
  /** 未提供时菜单不渲染对应项。 */
  reset?: (vm: Vm) => void
  remove?: (vm: Vm) => void
  /** 设为全局活跃槽（`POST …/activate`）。 */
  activate?: (vm: Vm) => void
  activatingId?: string | null
  /** admin：打开分配租户对话框 / 收回确认。 */
  openAssignOwner?: (vm: Vm) => void
  reclaimOwner?: (vm: Vm) => void
  ownerBusyId?: string | null
}

export const VmActionsContext = createContext<VmActions | null>(null)

export function useVmActions(): VmActions {
  const ctx = useContext(VmActionsContext)
  if (!ctx) throw new Error('useVmActions 必须在 VmActionsProvider 内使用')
  return ctx
}
