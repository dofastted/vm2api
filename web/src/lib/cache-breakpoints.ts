/**
 * 缓存断点配置 —— 镜像 gateway `src/lib/protocol/cache-ttl.mjs`
 * 的 DEFAULT_CACHE_TTL / DEFAULT_CACHE_BREAKPOINTS / normalize*（工作区快照 @2026-09-20）。
 *
 * 与 persona-template.ts 同样是**契约副本**：归一化规则抄错不会报错，只会让
 * 面板显示的状态和网关实际注入的断点对不上。
 *
 * 公开仓只走 rust cli-hop：wrap CLI 拥有 tools/system 断点，gateway 剥光
 * tools/system/messages 上的 cache_control，kernel 按 Claude Code 重打
 * conversation。`cache_ttl` 给出站断点定时。`enabled=false` 时只剥 last user。
 */

export type CacheTtl = '1h' | '5m'

export type MessagesBreakpointMode = 'off' | 'fill' | 'rewrite' | 'cli-hop'

export type CacheBreakpoints = {
  enabled: boolean
  preserve_client: boolean
  system_tail: boolean
  tools_tail: boolean
  messages: MessagesBreakpointMode
}

export const DEFAULT_CACHE_TTL: CacheTtl = '1h'

export const CACHE_TTL_OPTIONS: [CacheTtl, string][] = [
  ['1h', '1 小时'],
  ['5m', '5 分钟'],
]

export const DEFAULT_CACHE_BREAKPOINTS: CacheBreakpoints = {
  enabled: true,
  preserve_client: true,
  system_tail: true,
  tools_tail: true,
  messages: 'rewrite',
}

export const MESSAGES_BREAKPOINT_OPTIONS: [MessagesBreakpointMode, string][] = [
  ['fill', '补齐'],
  ['rewrite', '重打'],
  ['cli-hop', 'cli-hop'],
  ['off', '不动'],
]

export function messagesModeExplain(mode: MessagesBreakpointMode): string {
  if (mode === 'off')
    return '不碰 messages。调用方自己打的断点照旧生效，网关只管 system 和 tools。'
  if (mode === 'rewrite')
    return '先清掉调用方在 messages 里的全部断点，再打最后一条；messages≥4 时再打倒数第二个 user。'
  if (mode === 'cli-hop')
    return '剥光 messages 上的 cache_control。kernel 按 Claude Code 重打 conversation 断点。'
  return '只在 messages 一个断点都没有时补齐。已经自己打过断点的客户端保持原样。'
}

export function normalizeCacheTtl(value: unknown): CacheTtl {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (raw === '5m' || raw === '5min' || raw === '300') return '5m'
  if (
    raw === '1h' ||
    raw === '1hr' ||
    raw === '60m' ||
    raw === '3600' ||
    raw === 'hour' ||
    raw === '1hour' ||
    raw === 'default'
  )
    return '1h'
  return DEFAULT_CACHE_TTL
}

export function cacheTtlFromCompat(
  compat: Record<string, unknown> | undefined
): CacheTtl {
  return normalizeCacheTtl(compat?.cache_ttl)
}

/** 后端 `bool()`：缺字段取默认，只有显式 false / "false" 才算关。 */
function bool(value: unknown, fallback: boolean): boolean {
  if (value == null) return fallback
  return value !== false && String(value) !== 'false'
}

export function normalizeMessagesBreakpointMode(
  value: unknown
): MessagesBreakpointMode {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (['off', 'none', 'false', '0', 'disabled'].includes(raw)) return 'off'
  if (['cli-hop', 'cli', 'leftover'].includes(raw)) return 'cli-hop'
  if (['rewrite', 'replace', 'restamp', 'auto'].includes(raw)) return 'rewrite'
  if (['fill', 'true', '1'].includes(raw)) return 'fill'
  return DEFAULT_CACHE_BREAKPOINTS.messages
}

export function normalizeCacheBreakpoints(raw: unknown): CacheBreakpoints {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >
  return {
    enabled: bool(src.enabled, DEFAULT_CACHE_BREAKPOINTS.enabled),
    preserve_client: bool(
      src.preserve_client,
      DEFAULT_CACHE_BREAKPOINTS.preserve_client
    ),
    system_tail: bool(src.system_tail, DEFAULT_CACHE_BREAKPOINTS.system_tail),
    tools_tail: bool(src.tools_tail, DEFAULT_CACHE_BREAKPOINTS.tools_tail),
    messages: normalizeMessagesBreakpointMode(src.messages),
  }
}

export function cacheBreakpointsFromCompat(
  compat: Record<string, unknown> | undefined
): CacheBreakpoints {
  return normalizeCacheBreakpoints(compat?.cache_breakpoints)
}

/** `detectProxiedOfficialCcFromRouting`：默认开，只有显式 false 才关。 */
export function detectProxiedOfficialCcFromCompat(
  compat: Record<string, unknown> | undefined
): boolean {
  return compat?.detect_proxied_official_cc !== false
}
