/**
 * 健康度只看请求：成功 ÷ (成功 + 失败)，判定与后端 SLA 口径一致。
 * 没有请求就没有健康度，不推断、不探测。
 */
export type HealthBucket = [number, number]
export type SlotState = 'ok' | 'slow' | 'down' | 'none'
export type HealthTone = 'ok' | 'caution' | 'warn' | 'bad' | 'none'

export type HealthSummary = {
  req: number
  ok: number
  err: number
  /** 0–100；无请求为 null */
  pct: number | null
  tone: HealthTone
  slots: SlotState[]
  /** 有请求的格数 */
  active: number
}

export function slotState([ok, err]: HealthBucket): SlotState {
  const n = ok + err
  if (n <= 0) return 'none'
  const rate = err / n
  if (rate <= 0.05) return 'ok'
  if (rate <= 0.3) return 'slow'
  return 'down'
}

export function healthTone(pct: number | null): HealthTone {
  if (pct == null) return 'none'
  if (pct >= 99) return 'ok'
  if (pct >= 95) return 'caution'
  if (pct >= 80) return 'warn'
  return 'bad'
}

function cleanBucket(b: unknown): HealthBucket {
  if (!Array.isArray(b)) return [0, 0]
  const ok = Number(b[0])
  const err = Number(b[1])
  return [
    Number.isFinite(ok) && ok > 0 ? ok : 0,
    Number.isFinite(err) && err > 0 ? err : 0,
  ]
}

export function healthSummary(
  raw: ReadonlyArray<unknown> | null | undefined,
  length = 48
): HealthSummary {
  const buckets = Array.isArray(raw) ? raw.map(cleanBucket) : []
  const padded: HealthBucket[] =
    buckets.length >= length
      ? buckets.slice(-length)
      : [
          ...Array.from(
            { length: length - buckets.length },
            (): HealthBucket => [0, 0]
          ),
          ...buckets,
        ]
  let ok = 0
  let err = 0
  let active = 0
  for (const [o, e] of padded) {
    ok += o
    err += e
    if (o + e > 0) active++
  }
  const req = ok + err
  const pct = req > 0 ? (ok / req) * 100 : null
  return {
    req,
    ok,
    err,
    pct,
    tone: healthTone(pct),
    slots: padded.map(slotState),
    active,
  }
}

export const SLOT_LABEL: Record<SlotState, string> = {
  ok: '错误率 ≤5%',
  slow: '错误率 5–30%',
  down: '错误率 >30%',
  none: '无请求',
}

export function fmtHealthPct(pct: number | null): string {
  if (pct == null) return '—'
  return pct >= 99.95 ? '100%' : `${pct.toFixed(1)}%`
}

export const SLOT_BG: Record<SlotState, string> = {
  ok: 'var(--status-ok-solid)',
  slow: 'var(--status-caution-solid)',
  down: 'var(--status-bad-solid)',
  none: 'var(--muted)',
}

export const HEALTH_FG: Record<HealthTone, string> = {
  ok: 'text-[color:var(--status-ok)]',
  caution: 'text-[color:var(--status-caution)]',
  warn: 'text-[color:var(--status-warn)]',
  bad: 'text-[color:var(--status-bad)]',
  none: 'text-[color:var(--text-tertiary)]',
}
