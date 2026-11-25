export const UPLOAD_INTERVAL_DEFAULT = 600
export const UPLOAD_INTERVAL_MIN = 60
export const UPLOAD_INTERVAL_MAX = 86_400

export type IntervalUnit = 'min' | 'hour'

export const UPLOAD_INTERVAL_PRESETS: [number, string][] = [
  [300, '5 分钟'],
  [600, '10 分钟'],
  [1800, '30 分钟'],
  [3600, '1 小时'],
  [21_600, '6 小时'],
  [86_400, '24 小时'],
]

/** Mirrors gateway `telemetryUploadInterval`: whole minutes in 1 min–24 h, else 10 min. */
export function uploadIntervalOf(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.NaN
  return Number.isInteger(n) &&
    n % 60 === 0 &&
    n >= UPLOAD_INTERVAL_MIN &&
    n <= UPLOAD_INTERVAL_MAX
    ? n
    : UPLOAD_INTERVAL_DEFAULT
}

export function unitOf(seconds: number): IntervalUnit {
  return seconds >= 3600 && seconds % 3600 === 0 ? 'hour' : 'min'
}

export function isExactInUnit(seconds: number, unit: IntervalUnit): boolean {
  return unit === 'hour' ? seconds % 3600 === 0 : seconds % 60 === 0
}

export function unitBounds(unit: IntervalUnit): [number, number] {
  return unit === 'hour' ? [1, 24] : [1, 1440]
}

export function amountIn(seconds: number, unit: IntervalUnit): number {
  return unit === 'hour' ? Math.ceil(seconds / 3600) : seconds / 60
}

/** Seconds for `amount` in `unit`, clamped to that unit's range. */
export function secondsFrom(amount: number, unit: IntervalUnit): number {
  const [min, max] = unitBounds(unit)
  const n = Math.min(max, Math.max(min, Math.round(amount)))
  return n * (unit === 'hour' ? 3600 : 60)
}

export function intervalLabel(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`
  if (seconds > 3600) {
    const h = Math.floor(seconds / 3600)
    return `${h} 小时 ${(seconds % 3600) / 60} 分钟`
  }
  return `${seconds / 60} 分钟`
}
