import type { PanelRole } from './panel-auth'

export type PanelUser = {
  id: string
  username: string
  role: PanelRole
  enabled: boolean
  vm_create_quota?: number
  /** 该用户所有 Key 的在途请求合计上限；管理员不受限。 */
  concurrency?: number
  /** 该账号是否已开启两步验证（只读，管理员可重置）。 */
  two_factor?: boolean
  created_at?: string
  last_login_at?: string
}

export type PanelUsersPayload = {
  items?: PanelUser[]
}
