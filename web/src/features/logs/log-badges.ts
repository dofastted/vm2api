import type { RequestLogItem } from '@/types/panel-logs'
import { errorClassTone, statusTone } from '@/lib/log-tone'

export type LogBadgeTone = 'ok' | 'caution' | 'warn' | 'bad' | 'none'

export type LogBadge = {
  text: string
  tone: LogBadgeTone
}

/** A request that never reached an execution seat. Not the same as a slot with no account. */
export const UNASSIGNED_EXECUTION = '未分配执行位'

function toneOf(cls: string | undefined): LogBadgeTone {
  if (
    cls === 'ok' ||
    cls === 'caution' ||
    cls === 'warn' ||
    cls === 'bad' ||
    cls === 'none'
  ) {
    return cls
  }
  return 'none'
}

export function statusBadge(status: unknown): LogBadge {
  const tone = statusTone(status)
  return { text: tone.label || tone.text || '—', tone: toneOf(tone.cls) }
}

export function errorClassBadge(
  row: Pick<RequestLogItem, 'error_class' | 'error_label'>
): LogBadge | null {
  const tone = errorClassTone(row as Record<string, unknown>)
  if (!tone) return null
  return { text: tone.label || tone.text, tone: toneOf(tone.cls) }
}

export function rateBadge(multiplier: unknown): LogBadge | null {
  if (multiplier == null || multiplier === '') return null
  const n = Number(multiplier)
  if (!Number.isFinite(n) || n === 1) return null
  return {
    text: `x${n.toFixed(2)}`,
    tone: n > 1 ? 'caution' : 'ok',
  }
}

export function showModelRedirect(
  row: Pick<
    RequestLogItem,
    'requested_model' | 'upstream_model' | 'model_mismatch' | 'model'
  >
): boolean {
  const flag = row.model_mismatch
  if (flag === true || flag === 1) return true
  const requested = row.requested_model || ''
  const upstream = row.upstream_model || ''
  return Boolean(requested && upstream && requested !== upstream)
}

export function rowCost(
  row: Pick<RequestLogItem, 'actual_cost' | 'total_cost'>
): number | null {
  const actual = row.actual_cost
  if (actual != null && Number.isFinite(Number(actual))) return Number(actual)
  const total = row.total_cost
  if (total != null && Number.isFinite(Number(total))) return Number(total)
  return null
}
