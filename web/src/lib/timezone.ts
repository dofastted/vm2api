/**
 * 时区工具。与 gateway `src/lib/core/timezone.mjs` 同一套判定：
 * 只接受 `Intl` 能解析的具名 IANA 时区，拒绝 `+09:00` 这类偏移量
 * —— 容器 `TZ` 和 persona `# Environment` 都只认具名时区。
 */
export function validTimezone(value: unknown): string {
  const zone = String(value ?? '').trim()
  if (!zone || /^[+-]/.test(zone)) return ''
  try {
    // Intl 大小写不敏感，但 Linux 的 TZ 路径区分大小写，所以回写规范化结果。
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
    }).resolvedOptions().timeZone
  } catch {
    return ''
  }
}

/** 某时区的当前时刻，用于让操作者确认选对了区。无效时区返回空串。 */
export function zoneNowLabel(zone: unknown, now: number = Date.now()): string {
  const tz = validTimezone(zone)
  if (!tz) return ''
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      hour12: false,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(now))
  } catch {
    return ''
  }
}

/** 时区来源标签：手动钉住 / 跟随代理 / 创建时自动分配。 */
export const TIMEZONE_SOURCE_LABELS: Record<string, string> = {
  manual: '手动',
  proxy_geo: '跟随代理',
  auto: '自动',
}
