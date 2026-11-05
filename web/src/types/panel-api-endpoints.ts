import type { AuthScheme } from './panel-vm'

export type ApiKeyEntry = {
  id: string
  /**
   * GET 列表里恒为掩码态（如 `abcd…wxyz`），可以直接展示。
   * 只有 POST 创建 / 追加 key 的响应里这个字段才是明文，那种一次性展示场景
   * 不要把它塞进 title、console、toast body，用完即弃。
   */
  api_key: string
  key_suffix?: string
  proxy_url?: string
  proxy_id?: string
  disabled?: boolean
  cooldown_until?: number
}

export type ApiModelEntry = {
  id?: string
  name: string
  alias: string
  image?: boolean
  thinking?: { levels: string[] }
}

export type ApiEndpointPreset = {
  kind: string
  label: string
  base_url: string
  protocol: string
}

export type ApiEndpoint = {
  id: string
  name?: string
  base_url?: string
  prefix?: string
  priority?: number
  disabled?: boolean
  disable_cooling?: boolean
  kind?: 'claude' | 'openai' | 'custom'
  protocol?: 'anthropic' | 'openai'
  risk_review_enabled?: boolean
  /** 上游认证方案，后端 `endpointAuthScheme()` 计算得出，openai 协议恒为 bearer。 */
  auth_scheme?: AuthScheme
  headers?: Record<string, string>
  api_key_entries?: ApiKeyEntry[]
  models?: ApiModelEntry[]
}

export type ApiEndpointsPayload = {
  items?: ApiEndpoint[]
  presets?: ApiEndpointPreset[]
}
