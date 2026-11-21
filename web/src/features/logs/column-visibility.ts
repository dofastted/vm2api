/** 可隐藏列，顺序 = 下拉菜单顺序（hub `DEFAULT_VISIBLE_COLUMNS`）。时间/模型/状态恒显示。 */
export const LOGS_TABLE_COLUMNS = [
  { id: 'user', label: '用户' },
  { id: 'key', label: '密钥' },
  { id: 'sessionId', label: '出站 Session' },
  { id: 'ip', label: 'IP' },
  { id: 'provider', label: '虚拟机' },
  { id: 'reasoningEffort', label: '思考强度' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'cache', label: '缓存' },
  { id: 'performance', label: '性能' },
  { id: 'cost', label: '成本' },
] as const

export type LogsTableColumn = (typeof LOGS_TABLE_COLUMNS)[number]['id']

export const DEFAULT_HIDDEN_COLUMNS: LogsTableColumn[] = ['ip']

const VALID: Record<string, true> = Object.fromEntries(
  LOGS_TABLE_COLUMNS.map((col) => [col.id, true])
)

/** 按面板用户分键，同一浏览器切换账号互不串。 */
function storageKey(user: string): string {
  return `vm2api-columns:usage-logs:${user}`
}

export function readHiddenColumns(user: string): LogsTableColumn[] {
  try {
    const raw = localStorage.getItem(storageKey(user))
    if (raw == null) return DEFAULT_HIDDEN_COLUMNS
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_HIDDEN_COLUMNS
    return parsed.filter(
      (id): id is LogsTableColumn => typeof id === 'string' && VALID[id]
    )
  } catch {
    return DEFAULT_HIDDEN_COLUMNS
  }
}

export function writeHiddenColumns(
  user: string,
  hidden: readonly LogsTableColumn[]
) {
  try {
    localStorage.setItem(storageKey(user), JSON.stringify(hidden))
  } catch {
    // 隐私模式 / 配额满：本次会话内仍按内存状态生效。
  }
}
