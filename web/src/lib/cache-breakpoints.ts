/**
 * 缓存断点配置 —— 镜像 gateway `src/lib/protocol/cache-ttl.mjs`
 * 的 DEFAULT_CACHE_BREAKPOINTS / normalizeCacheBreakpoints（工作区快照 @2026-08-30）。
 *
 * 与 persona-template.ts 同样是**契约副本**：归一化规则抄错不会报错，只会让
 * 面板显示的状态和网关实际注入的断点对不上。
 *
 * `cache_ttl` 只给已有断点重新定时；断点本身由这里的开关决定要不要造。
 * 一个完全没有 cache_control 的 body 无论 ttl 写什么都是全价。
 */

export type MessagesBreakpointMode = 'off' | 'fill' | 'rewrite'

export type CacheBreakpoints = {
  enabled: boolean
  preserve_client: boolean
  system_tail: boolean
  tools_tail: boolean
  messages: MessagesBreakpointMode
}

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
  ['off', '不动'],
]

export function messagesModeExplain(mode: MessagesBreakpointMode): string {
  if (mode === 'off')
    return '不碰 messages。调用方自己打的断点照旧生效，网关只管 system 和 tools。'
  if (mode === 'rewrite')
    return '先清掉调用方在 messages 里的全部断点，再打最后一条和上一条消息。上一轮尾断点下一轮仍是有效前缀，避免 cache_read 冻在 system。'
  return '只在 messages 一个断点都没有时补齐。已经自己打过断点的客户端保持原样。'
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
