import type { VmUsageStatsDay, VmUsageStatsRank } from '@/types/panel-vm'

export type ApiKeyItem = {
  id: string
  name?: string
  /** 旧字段别名。列表请用 `key_prefix` / `maskApiKeyItem()`。 */
  prefix?: string
  key_prefix?: string
  key_suffix?: string
  /**
   * 列表接口返回掩码（含 `…`）。明文只出现在 create / reveal / rotate 的一次性响应里，
   * 不得渲染到列表、title、toast、console。
   */
  key?: string
  revealable?: boolean
  status?: string
  category?: 'oauth' | 'api'
  max_concurrency?: number
  quota_requests?: number
  quota_used?: number
  quota_usd?: number
  quota_usd_used?: number
  rpm?: number
  expires_at?: string | null
  created_at?: string
  updated_at?: string
  last_used_at?: string
  requests?: number
  inflight?: number
  /** all = 全局可调度。anthropic / openai 必须带 allowed_vms。 */
  group_type?: 'all' | 'anthropic' | 'openai'
  allowed_vms?: string[]
  vm_pool_id?: string | null
  vm_pool_name?: string | null
  /** 允许的模型（按客户端请求里的名字精确匹配，不分大小写）。空 = 不限。 */
  allowed_models?: string[]
}

export type VmPool = {
  id: string
  name: string
  enabled: boolean
  vm_ids: string[]
}

export type ApiKeysPayload = {
  keys?: ApiKeyItem[]
}

export type KeyUsageStats = {
  days: number
  since: string | null
  history: VmUsageStatsDay[]
  models: VmUsageStatsRank[]
  vms: VmUsageStatsRank[]
}

export type KeyStatsPayload = {
  item?: ApiKeyItem
  usage_stats?: KeyUsageStats | null
}
