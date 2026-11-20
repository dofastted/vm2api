export type PanelRole = 'admin' | 'super' | 'user'

export type MeResponse = {
  user: string
  role: PanelRole
  views?: string[]
  capabilities?: string[]
  vm_create_quota?: number
  version?: string
}

/** 当前账号的两步验证状态（`GET /api/panel/2fa`）。 */
export type TwoFactorStatus = {
  enabled: boolean
  /** 已生成密钥但还没用验证码确认，此时登录不拦。 */
  pending: boolean
  confirmed_at: string | null
  recovery_total: number
  recovery_remaining: number
  digits: number
  period: number
}

/** 绑定时返回给验证器 App 的数据，密钥只在这一步出现。 */
export type TwoFactorSetup = {
  secret: string
  uri: string
  digits: number
  period: number
  algorithm: string
}

/** 开启两步验证或重新生成恢复码时返回；恢复码只显示这一次。 */
export type TwoFactorCodes = TwoFactorStatus & {
  recovery_codes: string[]
}

/**
 * 登录结果：密码正确就直接拿到会话；账号开了两步验证则先拿到
 * challenge，再带验证码换会话。
 */
export type LoginOutcome =
  | { kind: 'session'; token: string; user: string }
  | { kind: 'totp'; challenge: string; expiresIn: number }
