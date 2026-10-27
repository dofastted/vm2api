export type RequestLogItem = {
  request_id?: string
  id?: string
  /** 后端字段是 `ts`（ISO 字符串，请求**完成**时刻）。`request_logs` 表没有 `created_at` 列。 */
  ts?: string
  created_at?: string
  status?: number | string
  model?: string
  requested_model?: string
  upstream_model?: string
  /** 三态：0 | 1 | null（数字，不是 boolean）。null = 上游未声明模型。 */
  model_mismatch?: number | boolean | null
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
  first_token_ms?: number
  stop_reason?: string
  /** 读出时派生、不落库；非错误行为 null。 */
  error_class?: string
  error_label?: string
  error_owner?: ErrorOwner
  error_code?: string
  error_message?: string
  vm_id?: string
  duration_ms?: number
  attempt_count?: number
  account_id?: string
  upstream_status?: number | string
  protocol?: string
  stream?: boolean | number
  total_cost?: number
  actual_cost?: number
  rate_multiplier?: number
  /**
   * 客户端出示的入站 Key。**后端只截断到 240 字符，完全不掩码**，且是攻击者可控字符串。
   * 仅在 /v1 入站鉴权失败时写入。
   * 渲染前必须过 `maskPresentedKey()`；禁止放进 title= / 复制按钮 / console / toast。
   */
  api_key_presented?: string | null
  /** XFF 首段回落 socket 地址，截断 45 字符，空时为 ''。非凭证，无需掩码。 */
  ip?: string
  /** debug 模式下网关实际回给客户端的响应；body 为原始文本（SSE）或已解析 JSON。 */
  response?: DebugResponseCapture | null
  /** CLI fetch-boundary headers; absent for unsupported runtimes or old records. */
  outbound_headers?: Record<string, unknown> | null
  outbound_headers_source?: 'cli_final' | 'unavailable' | null
  worker_envelope_headers?: Record<string, unknown> | null
  [key: string]: unknown
}

export type DebugResponseCapture = {
  status: number | null
  headers: Record<string, unknown> | null
  body: unknown
  /** 实际写出的总字节数（未截断）。 */
  bytes: number
  truncated: boolean
}

export type RequestAttempt = {
  id?: number
  request_id?: string
  attempt_no?: number
  vm_id?: string | null
  account_id?: string | null
  model?: string | null
  selection_reason?: string | null
  started_at?: string
  completed_at?: string | null
  upstream_status?: number | string | null
  error_scope?: string | null
  action?: string | null
  cooldown_until?: number | null
  downstream_committed?: boolean
  status?: number | string | null
  terminal_state?: string | null
  usage?: Record<string, unknown> | null
  wait_ms?: number | null
  ttft_ms?: number | null
  latency_ms?: number | null
  [key: string]: unknown
}

/** `GET /request-logs` normal 模式响应。debug 模式不返回 total/limit/offset。 */
export type RequestLogsResponse = {
  mode?: 'normal' | 'debug'
  items?: RequestLogItem[]
  /**
   * 无 error_class 时是筛选后全表 COUNT(*)，分页可信；
   * 有 error_class 时只是「最近 scan 行内命中数」，会低估。
   */
  total?: number
  /** 钳制**前**的回声值，判断实际条数请用 items.length。 */
  limit?: number
  offset?: number
  config?: { muted_error_classes?: string[]; mode?: string }
}

export type ErrorOwner = 'client' | 'provider' | 'platform'

export type ErrorClassBucket = {
  id: string
  label: string
  owner: ErrorOwner
  count: number
}

export type ErrorCodeBucket = {
  error_class: string
  error_label: string
  error_owner: ErrorOwner
  error_code: string
  count: number
  last_ts?: string | null
  last_message?: string | null
  last_status?: number | null
  last_model?: string | null
}

/** 入站鉴权失败按 (key, ip) 分组的汇总。不受屏蔽影响，直接查 DB。 */
export type IngressHit = {
  /** 明文，与 RequestLogItem.api_key_presented 同样的掩码红线。 */
  api_key_presented: string
  ip: string
  count: number
  /** 字段名是 last_ts，不是 last_seen。 */
  last_ts?: string | null
  /** MAX(error_code)：字典序最大，**不是最近那条**。 */
  error_code?: string | null
}

/** 注意是**对象**不是数组（web/ 曾误当数组处理）。 */
export type ErrorCollection = {
  total?: number
  by_class?: ErrorClassBucket[]
  by_code?: ErrorCodeBucket[]
  recent?: RequestLogItem[]
  ingress_hits?: IngressHit[]
}

export type RequestLogDetailPayload = {
  item?: RequestLogItem
}

export type RequestLogAttemptsPayload = {
  attempts?: RequestAttempt[]
}
