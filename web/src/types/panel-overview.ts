import type { HostMemoryPressure } from './panel-cluster'
import type { ErrorCollection } from './panel-logs'
import type { QuotaTierPolicy, Vm } from './panel-vm'

/** `dashboard.host`。宿主进程资源，来自 `panel-api.mjs` 的 `hostStats()`。 */
export type HostStats = {
  cpu_count?: number
  load1?: number
  load5?: number
  load15?: number
  cpu_pct?: number
  mem_total?: number
  mem_free?: number
  mem_used?: number
  mem_pct?: number
  rss?: number
  heap_used?: number
  heap_total?: number
  uptime?: number
  proc_uptime?: number
  memory_pressure?: HostMemoryPressure | null
}

/** `dashboard.billing.accounts[]` / `billing.total`/`billing.today` 的一行。 */
export type BillingAccountRow = {
  account_id?: string
  vm_id?: string
  email?: string
  today_cost?: number
  total_cost?: number
  [key: string]: unknown
}

export type BillingSnapshot = {
  source?: string
  currency?: string
  today?: { total_cost?: number; [key: string]: unknown }
  total?: { total_cost?: number; [key: string]: unknown }
  window_5h?: Record<string, unknown>
  accounts?: BillingAccountRow[]
}

/** 单个模型家族在 `by_model` 聚合后的一行（index.html `opsModelFamilyRows` 的等价物）。 */
export type OpsModelRow = {
  model?: string
  requests?: number
  errors?: number
  ttft_samples?: number
  avg_first_token_ms?: number | null
  avg_duration_ms?: number | null
}

export type LatencySummary = {
  samples?: number
  p50_ms?: number | null
  p90_ms?: number | null
  p95_ms?: number | null
  p99_ms?: number | null
  avg_ms?: number | null
  max_ms?: number | null
}

/** `GET /request-logs/stats` 的 `window`，也是 `dashboard.ops` 的回落形状。 */
export type OpsWindow = {
  requests?: number
  success?: number
  errors?: number
  sla?: number
  error_rate?: number
  status_429?: number
  status_503?: number
  status_529?: number
  stream_requests?: number
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
  /** 窗口内官方费用合计。`windowStats` 已返回，类型原先漏了。 */
  total_cost?: number
  cache_hit_rate?: number | null
  sticky?: { selections?: number; hits?: number; rate?: number | null }
  qps?: { current?: number; peak?: number; avg?: number }
  tps?: { current?: number; peak?: number; avg?: number }
  duration?: LatencySummary
  ttft?: LatencySummary
  by_model?: OpsModelRow[]
  error_collection?: ErrorCollection
  error?: string
}

/**
 * `GET /request-logs/stats` 的 `buckets[]` 一行。`bucket=hour` 时形如
 * `2026-08-30T14:00`（**UTC** 小时，strftime 直接切 ISO 字符串），展示需换回本地。
 */
export type StatsBucket = {
  bucket: string
  requests?: number
  errors?: number
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
  total_cost?: number
  avg_duration_ms?: number | null
  avg_first_token_ms?: number | null
}

/** `GET /request-logs/stats` 响应（overview 消费的子集）。 */
export type RequestLogStats = {
  buckets?: StatsBucket[]
  window?: OpsWindow
  muted_error_classes?: string[]
  totals?: Record<string, unknown>
}

export type Dashboard = {
  vms?: Vm[]
  summary?: Record<string, unknown>
  gateway_stats?: Record<string, unknown>
  health?: { base_url?: string }
  host?: HostStats
  proxy_pool?: Record<string, unknown>
  ops?: OpsWindow
  billing?: BillingSnapshot
  routing?: {
    tiers?: Record<string, QuotaTierPolicy>
    [key: string]: unknown
  }
  error?: string
}
