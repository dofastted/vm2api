/**
 * 滚动日志页（`/logs`）的前后端契约。
 *
 * 形状对齐 claude-code-hub 的 `UsageLogRow` / `UsageLogSummary`，字段口径按
 * vm2api 的 `usage_logs` + JOIN（users / api_keys / vms / accounts /
 * request_attempts）落地。后端：`src/lib/db/repos/usage-logs-view.mjs`，
 * 路由：`src/lib/admin/panel-routes.mjs` 的 `/api/panel/usage-logs*`。
 *
 * 响应是 camelCase；查询串沿用面板既有的 snake_case（见 `UsageLogFilters`
 * 每个字段注释里的参数名）。`/request-logs` 那条 offset + snake_case 链路
 * 仍服务于错误归集与导出，由 `types/panel-logs.ts` 描述。
 */

/** 单次上游尝试，`request_attempts` 直出，按 `attemptNumber` 升序构成供应商链。 */
export type ProviderChainItem = {
  attemptNumber: number
  vmId: string | null
  /** 槽位展示名（`vms.name`），缺失回落 vmId。 */
  vmName: string | null
  accountId: string | null
  /** 账号展示名：email → name → accountId。 */
  providerName: string | null
  model: string | null
  /** 调度原因：sticky / roundrobin / failover / … 原样透传。 */
  selectionReason: string | null
  upstreamStatus: number | null
  /** 错误归属域：client / provider / platform。 */
  errorScope: string | null
  /** 本次尝试的终态（success / exhausted / cooldown / …）。 */
  terminalState: string | null
  action: string | null
  /** 该次尝试是否已把响应提交给下游（= 最终服务方）。 */
  downstreamCommitted: boolean
  /** 调度总耗时，包含实际排队；历史记录没有拆分。 */
  waitMs: number | null
  queueWaitMs: number | null
  schedulingMs: number | null
  ttftMs: number | null
  latencyMs: number | null
  startedAt: string | null
  completedAt: string | null
}

/**
 * 费用明细，金额为官方标准价美元（未乘分组倍率）。
 * 各项来自 `input_cost / output_cost / cache_read_cost / cache_creation_cost`。
 */
export type CostBreakdown = {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheCreation: number | null
  /** 四项之和 = `usage_logs.total_cost`。 */
  baseTotal: number | null
  /** 分组倍率快照（`usage_logs.rate_multiplier`）。 */
  groupMultiplier: number | null
  /** 计价命中的模型键（`pricing_model`），`unpriced` 表示无价表。 */
  pricingModel: string | null
}

/** 本次请求生效的特殊开关，渲染成 badge / 详情「特殊设置」区。 */
export type SpecialSetting = {
  key:
    | 'stream'
    | 'tools'
    | 'debug'
    | 'mismatch'
    | 'fast'
    | 'priority'
    | 'context1m'
    | 'via'
  label: string
  /** 原始值，供 tooltip 展示（例如 via 的路由标签、service_tier 的原值）。 */
  value?: string | null
}

/** 缓存写入 TTL 口径，由 5m / 1h 写入量派生。`mixed` = 两者都写了。 */
export type CacheTtlApplied = '5m' | '1h' | 'mixed' | null

/** 发往槽位的思考强度。调用方值优先，否则模型缺省。见 `loggedReasoningEffort()`。 */
export type ReasoningEffort =
  'none' | 'minimal' | 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 滚动日志的一行。`null` = 本行该字段为空（vm2api 不产出的 hub 字段已整体删去）。 */
export type UsageLogRow = {
  /** `usage_logs.id`（`log_<12hex>`），游标 tiebreaker。 */
  id: string
  requestId: string | null
  /** ISO-8601，请求完成时刻。 */
  createdAt: string
  userId: string | null
  userName: string | null
  keyId: string | null
  keyName: string | null
  /**
   * 实际出站（发给上游）的会话 id。默认 `rebuild` 模式下网关按账号/绑定代次
   * 重新铸造，与客户端会话不同；027 之前及 029 之前的历史行为 null。
   */
  sessionId: string | null
  /** 客户端请求带来的会话：Claude Code `metadata.user_id` / `x-claude-code-session-id` 等。 */
  clientSessionId: string | null
  /** 入站剥离前的客户端 device id。 */
  inboundDeviceId: string | null
  /** 最终服务的账号展示名（`final_account_id` 优先）。 */
  providerName: string | null
  accountId: string | null
  vmId: string | null
  vmName: string | null
  /** 计费/生效模型。 */
  model: string | null
  /** 客户端请求的模型（重定向前，`requested_model`）。 */
  originalModel: string | null
  /** 上游回报的模型（`upstream_model`）。 */
  actualResponseModel: string | null
  /** 0 | 1 | null（null = 上游未声明模型）。 */
  modelMismatch: number | null
  /** 入站路径，例如 `/v1/messages`。 */
  endpoint: string | null
  protocol: string | null
  method: string | null
  statusCode: number | null
  logMode: 'normal' | 'debug' | null
  inputTokens: number
  outputTokens: number
  /** null = 上游未报告写入量，不等于明确写入 0。 */
  cacheCreationInputTokens: number | null
  cacheReadInputTokens: number
  cacheCreation5mInputTokens: number
  cacheCreation1hInputTokens: number
  cacheTtlApplied: CacheTtlApplied
  /** 实际总量：cache-exclusive input + output + 读 + 写，不是 input+output。 */
  totalTokens: number
  /** 官方标准价合计（`total_cost`）；null = 未计价。 */
  costUsd: number | null
  /** 乘过分组倍率后的实收（`actual_cost`）。 */
  actualCostUsd: number | null
  groupCostMultiplier: number | null
  costBreakdown: CostBreakdown | null
  durationMs: number | null
  /**
   * 首字节 / 首个协议事件（`first_byte_ms`），相对入口。
   * 历史行或未观测到上游协议事件为 `null`，不用别的时间估。
   */
  firstByteMs: number | null
  /** 首个生成内容/进度（`first_token_ms`），包括 thinking、工具名称和参数。 */
  ttftMs: number | null
  /**
   * 上游输出窗口（`generation_ms`）：首个协议事件到终止生成事件
   *（Claude `message_delta.stop_reason` / Responses `response.completed`）。
   * 含不可见推理，不含 HTTP/trailer/cleanup。历史行 / 单包窗口为 `null`，
   * 禁止用总耗时减 TTFT 估。
   */
  generationMs: number | null
  stopReason: string | null
  attemptCount: number | null
  finalState: string | null
  /** 实际走的 hop/路由标签。 */
  via: string | null
  stream: boolean | null
  hasTools: boolean | null
  /** OpenAI service tier 发出值（原样小写），计费按此档。 */
  serviceTier: string | null
  /** 上游 `response.service_tier` 回显；与 serviceTier 不同即档位被上游改写。 */
  upstreamServiceTier: string | null
  /** Anthropic speed：`fast` | `standard`。 */
  speed: string | null
  /** 长上下文（1M）计价档是否生效；null = 未计价。 */
  context1mApplied: boolean | null
  reasoningEffort: ReasoningEffort | null
  /** 读时派生，不落库。 */
  errorClass: string | null
  errorLabel: string | null
  errorOwner: 'client' | 'provider' | 'platform' | null
  errorCode: string | null
  errorMessage: string | null
  /** classifyJev 实际 POST 的 state。送审上下文，不是模型指出的命中句。 */
  jevState: string | null

  /** 平台侧拦截（distill / refusal / guard …），由 errorClass/finalState 映射。 */
  blockedBy: string | null
  blockedReason: string | null
  userAgent: string | null
  clientIp: string | null
  /**
   * 入站鉴权失败时客户端出示的 key。后端只截断不掩码，
   * 渲染前必须过 `maskPresentedKey()`；禁止进 title= / 复制 / toast。
   */
  apiKeyPresented: string | null
  specialSettings: SpecialSetting[]
  /** 列表接口按页一次性批量带出（单条 IN 查询），无尝试记录时为 `[]`。 */
  providerChain: ProviderChainItem[]
}

/** 游标：按 `(created_at DESC, id DESC)` 键集分页。 */
export type UsageLogCursor = {
  createdAt: string
  id: string
}

/** `GET /api/panel/usage-logs` 的 `data`。无 total —— 键集分页不做 COUNT。 */
export type UsageLogsBatchResult = {
  logs: UsageLogRow[]
  nextCursor: UsageLogCursor | null
  hasMore: boolean
}

/**
 * 列表 / 汇总共用的筛选条件。空值一律省略，不要下发空串。
 * 括号内为查询串参数名。分页另带 `cursor_created_at` / `cursor_id` / `limit`(≤100，默认 50)。
 */
export type UsageLogFilters = {
  /** (`user_id`) user 角色由后端强制为本人，忽略下发值。 */
  userId?: string
  /** (`key_id`) */
  keyId?: string
  /** (`vm_id`) 供应商 = 槽位。 */
  vmId?: string
  /** (`account_id`) */
  accountId?: string
  /** (`session_id`) 精确匹配出站或客户端会话 id 任一。 */
  sessionId?: string
  /** (`model`) 匹配 model 或 requested_model。 */
  model?: string
  /** (`endpoint`) 精确匹配 path。 */
  endpoint?: string
  /** (`protocol`) */
  protocol?: string
  /** (`status_code`) 精确状态码。 */
  statusCode?: number
  /** (`exclude_status_200=1`) 只看非 2xx；与 statusCode 互斥，后者优先。 */
  excludeStatus200?: boolean
  /** (`model_mismatch=1`) */
  modelMismatch?: boolean
  /** (`min_attempt_count`) 只看 `attempt_count >= n`，「有重试」= 2。 */
  minAttemptCount?: number
  /** (`error_class`) */
  errorClass?: string
  /** (`exclude_error_class`，逗号分隔) 屏蔽的错误类；省略时后端套用设置里的默认屏蔽。 */
  excludeErrorClass?: string
  /** (`include_muted=1`) 不套用任何屏蔽。 */
  includeMuted?: boolean
  /** (`log_mode=debug`) 只看 debug 采样行。 */
  debugOnly?: boolean
  /** (`start_time`) ISO-8601，含。 */
  startTime?: string
  /** (`end_time`) ISO-8601，不含。 */
  endTime?: string
  /** (`q`) 在 path / error_code / error_message / request_id 上 LIKE。 */
  q?: string
}

/** `GET /api/panel/usage-logs/summary` 的 `data`。口径 = 当前筛选。 */
export type UsageLogsSummary = {
  totalRequests: number
  successRequests: number
  errorRequests: number
  /** 官方标准价合计。 */
  totalCost: number
  /** 实收合计。 */
  totalActualCost: number
  totalTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  totalCacheCreation5mTokens: number
  totalCacheCreation1hTokens: number
  /** cache_read / (input + cache_read)，0-1。 */
  cacheHitRate: number
  avgDurationMs: number | null
  avgTtftMs: number | null
}

/** `GET /api/panel/usage-logs/filter-options` 的 `data`（惰性拉取）。user 角色只含本人数据。 */
export type UsageLogFilterOptions = {
  users: { id: string; name: string }[]
  keys: { id: string; name: string; userId: string | null }[]
  vms: { id: string; name: string }[]
  accounts: { id: string; name: string }[]
  models: string[]
  protocols: string[]
  endpoints: string[]
  statusCodes: number[]
}

/** `GET /api/panel/usage-logs/session-suggestions?q=&limit=` 的 `data`：出站会话 id 前缀匹配，最新优先。 */
export type UsageLogSessionSuggestions = string[]

/** 近 N 分钟内有请求的出站会话（vm2api 只在请求完成时落库，没有「进行中」态）。 */
export type ActiveSession = {
  sessionId: string
  /** 该出站会话最近一行对应的客户端会话 id。 */
  clientSessionId: string | null
  userName: string | null
  keyName: string | null
  providerName: string | null
  vmId: string | null
  vmName: string | null
  model: string | null
  /** 该会话首/末次请求完成时刻（ISO）。 */
  firstAt: string
  lastAt: string
  requests: number
  lastStatus: number | null
  lastDurationMs: number | null
  totalTokens: number
  totalCost: number
}

/** `GET /api/panel/usage-logs/active-sessions?minutes=5&limit=50` 的 `data`。 */
export type ActiveSessionsData = {
  minutes: number
  /** 窗口内去重会话数（不受 limit 截断）。 */
  total: number
  sessions: ActiveSession[]
}

/**
 * `GET /api/panel/usage-logs/overview?tz=` 的 `data`：「今日」按 tz 自然日计。
 * 全屏页头与统计页指标卡共用。
 */
export type UsageLogsOverview = {
  /** 近 5 分钟去重会话数。 */
  activeSessions: number
  /** 近 1 分钟请求数。 */
  rpm: number
  todayRequests: number
  todayCost: number
  todayActualCost: number
  todayErrors: number
  todayTokens: number
  todayInputTokens: number
  todayOutputTokens: number
  todayCacheReadTokens: number
  todayCacheCreationTokens: number
  todayCacheCreation5mTokens: number
  todayCacheCreation1hTokens: number
  /** cache_read / (input + cache_read + cache_write)，0-1。 */
  todayCacheHitRate: number
  todayAvgDurationMs: number | null
  todayAvgTtftMs: number | null
  /** 昨日同一时刻之前的累计，用于「较昨日同期」。 */
  yesterdayRequests: number
  yesterdayCost: number
  yesterdayAvgDurationMs: number | null
}
