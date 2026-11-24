import type { UsageLogFilters } from '@/types/panel-usage-logs'

/**
 * `/logs` 的 URL 查询串。键名沿用 hub（camelCase，`minRetry`、`statusCode=!200`），
 * 另保留站内深链在用的 `error_class` / `kind=error`（总览错误归集摘要）。
 * 全部可选：任何只带一个键的 search 对象都要能通过类型检查。
 */
export type LogsSearch = {
  userId?: string
  keyId?: string
  /** 供应商 = 槽位。 */
  vmId?: string
  sessionId?: string
  /** 毫秒时间戳，含。 */
  startTime?: number
  /** 毫秒时间戳，不含（界面上的结束秒 + 1000）。 */
  endTime?: number
  /** 精确状态码或 `!200`（= 只看非 2xx）。 */
  statusCode?: number | '!200'
  /** 筛选所有失败请求（含流式 200 失败终态）。 */
  failedOnly?: boolean
  model?: string
  /** 计费/实际模型不一致。 */
  mismatch?: boolean
  endpoint?: string
  protocol?: string
  /** 重试次数下限（= 尝试次数 - 1）。 */
  minRetry?: number
  error_class?: string
  /** 旧深链：等价于 `statusCode=!200`。 */
  kind?: 'error'
  /** 只看 debug 采样行。 */
  debug?: boolean
}

/** 筛选面板编辑的草稿形状；`kind=error` 在这里已折叠成 `excludeStatus200`。 */
export type LogsFilterState = {
  userId?: string
  keyId?: string
  vmId?: string
  sessionId?: string
  startTime?: number
  endTime?: number
  statusCode?: number
  excludeStatus200?: boolean
  failedOnly?: boolean
  model?: string
  mismatch?: boolean
  endpoint?: string
  protocol?: string
  minRetry?: number
  errorClass?: string
  debugOnly?: boolean
}

function str(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function int(value: unknown): number | undefined {
  const n =
    typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

function flag(value: unknown): boolean | undefined {
  return value === true || value === 'true' || value === '1' || value === 1
    ? true
    : undefined
}

export function validateLogsSearch(
  search: Record<string, unknown>
): LogsSearch {
  const rawStatus = search.statusCode
  const statusCode =
    rawStatus === '!200'
      ? '!200'
      : rawStatus == null
        ? undefined
        : int(rawStatus)
  const minRetry = search.minRetry == null ? undefined : int(search.minRetry)
  return {
    userId: str(search.userId),
    keyId: str(search.keyId),
    vmId: str(search.vmId),
    sessionId: str(search.sessionId),
    startTime: search.startTime == null ? undefined : int(search.startTime),
    endTime: search.endTime == null ? undefined : int(search.endTime),
    statusCode,
    failedOnly: flag(search.failedOnly),
    model: str(search.model),
    mismatch: flag(search.mismatch),
    endpoint: str(search.endpoint),
    protocol: str(search.protocol),
    minRetry: minRetry != null && minRetry >= 0 ? minRetry : undefined,
    error_class: str(search.error_class),
    kind: search.kind === 'error' ? 'error' : undefined,
    debug: flag(search.debug),
  }
}

export function searchToFilters(search: LogsSearch): LogsFilterState {
  const exclude = search.statusCode === '!200' || search.kind === 'error'
  return {
    userId: search.userId,
    keyId: search.keyId,
    vmId: search.vmId,
    sessionId: search.sessionId,
    startTime: search.startTime,
    endTime: search.endTime,
    statusCode:
      typeof search.statusCode === 'number' ? search.statusCode : undefined,
    excludeStatus200: exclude || undefined,
    failedOnly: search.failedOnly,
    model: search.model,
    mismatch: search.mismatch,
    endpoint: search.endpoint,
    protocol: search.protocol,
    minRetry: search.minRetry,
    errorClass: search.error_class,
    debugOnly: search.debug,
  }
}

/** 草稿 → URL。`kind` 不再写回，统一由 `statusCode=!200` 表达。 */
export function filtersToSearch(filters: LogsFilterState): LogsSearch {
  const out: LogsSearch = {}
  if (filters.userId) out.userId = filters.userId
  if (filters.keyId) out.keyId = filters.keyId
  if (filters.vmId) out.vmId = filters.vmId
  if (filters.sessionId?.trim()) out.sessionId = filters.sessionId.trim()
  if (filters.startTime != null) out.startTime = filters.startTime
  if (filters.endTime != null) out.endTime = filters.endTime
  if (filters.excludeStatus200) out.statusCode = '!200'
  else if (filters.statusCode != null) out.statusCode = filters.statusCode
  if (filters.failedOnly) out.failedOnly = true
  if (filters.model) out.model = filters.model
  if (filters.mismatch) out.mismatch = true
  if (filters.endpoint) out.endpoint = filters.endpoint
  if (filters.protocol) out.protocol = filters.protocol
  if (filters.minRetry != null) out.minRetry = filters.minRetry
  if (filters.errorClass) out.error_class = filters.errorClass
  if (filters.debugOnly) out.debug = true
  return out
}

/**
 * 页面筛选 → 后端契约（`UsageLogFilters`）。`muted` 只在未钻取错误类时下发，
 * 后端在 `error_class` 存在时本就忽略屏蔽。
 */
export function filtersToApi(
  filters: LogsFilterState,
  muted: readonly string[]
): UsageLogFilters {
  const out: UsageLogFilters = {}
  if (filters.userId) out.userId = filters.userId
  if (filters.keyId) out.keyId = filters.keyId
  if (filters.vmId) out.vmId = filters.vmId
  if (filters.sessionId) out.sessionId = filters.sessionId
  if (filters.model) out.model = filters.model
  if (filters.endpoint) out.endpoint = filters.endpoint
  if (filters.protocol) out.protocol = filters.protocol
  if (filters.statusCode != null) out.statusCode = filters.statusCode
  else if (filters.excludeStatus200) out.excludeStatus200 = true
  if (filters.failedOnly) out.failedOnly = true
  if (filters.mismatch) out.modelMismatch = true
  if (filters.minRetry != null && filters.minRetry > 0)
    out.minAttemptCount = filters.minRetry + 1
  if (filters.errorClass) out.errorClass = filters.errorClass
  else if (muted.length) out.excludeErrorClass = muted.join(',')
  if (filters.debugOnly) out.debugOnly = true
  if (filters.startTime != null)
    out.startTime = new Date(filters.startTime).toISOString()
  if (filters.endTime != null)
    out.endTime = new Date(filters.endTime).toISOString()
  return out
}

/** `UsageLogFilters` → snake_case 查询串（参数名见契约字段注释）。 */
export function usageLogFiltersQuery(
  filters: UsageLogFilters
): URLSearchParams {
  const qs = new URLSearchParams()
  const set = (key: string, value: string | number | undefined) => {
    if (value !== undefined && value !== '') qs.set(key, String(value))
  }
  set('user_id', filters.userId)
  set('key_id', filters.keyId)
  set('vm_id', filters.vmId)
  set('account_id', filters.accountId)
  set('session_id', filters.sessionId)
  set('model', filters.model)
  set('endpoint', filters.endpoint)
  set('protocol', filters.protocol)
  set('status_code', filters.statusCode)
  if (filters.excludeStatus200) qs.set('exclude_status_200', '1')
  if (filters.failedOnly) qs.set('failed_only', '1')
  if (filters.modelMismatch) qs.set('model_mismatch', '1')
  set('min_attempt_count', filters.minAttemptCount)
  set('error_class', filters.errorClass)
  set('exclude_error_class', filters.excludeErrorClass)
  if (filters.includeMuted) qs.set('include_muted', '1')
  if (filters.debugOnly) qs.set('log_mode', 'debug')
  set('start_time', filters.startTime)
  set('end_time', filters.endTime)
  set('q', filters.q)
  return qs
}

/** 工具栏徽标计数，口径同 hub（时间范围算一项，状态码/非 200 算一项）。 */
export function activeFilterCount(filters: LogsFilterState): number {
  let count = 0
  if (filters.startTime != null || filters.endTime != null) count++
  if (filters.userId) count++
  if (filters.keyId) count++
  if (filters.vmId) count++
  if (filters.sessionId) count++
  if (filters.statusCode != null || filters.excludeStatus200) count++
  if (filters.failedOnly) count++
  if (filters.model) count++
  if (filters.mismatch) count++
  if (filters.endpoint) count++
  if (filters.protocol) count++
  if (filters.minRetry != null && filters.minRetry > 0) count++
  if (filters.errorClass) count++
  if (filters.debugOnly) count++
  return count
}
