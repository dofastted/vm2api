import type { InferenceEngine } from '@/types/panel-vm'

export const DEFAULT_RESOLVED_ENGINE: InferenceEngine = 'rust'

export const INFERENCE_ENGINE_OPTIONS: {
  value: InferenceEngine
  label: string
}[] = [
  { value: 'auto', label: '自动（继承 rust）' },
  { value: 'rust', label: 'Rust' },
]

export function normalizeInferenceEngine(
  value: unknown,
  fallback: InferenceEngine
): InferenceEngine {
  if (value === 'auto' || value === 'rust') return value
  if (value === 'go') return 'rust'
  return fallback
}

export function inferenceEnginePatchValue(value: InferenceEngine) {
  return value === 'auto' ? '' : 'rust'
}

/** 公开仓全局引擎固定 rust。历史 go 取值一并收掉。 */
export function normalizeGlobalClaudeEngine(_value: unknown): 'rust' {
  return 'rust'
}

/** 公开仓不再回落 Go。 */
export function isFallbackToGo(_value: unknown): boolean {
  return false
}

export function inferenceEngineLabel(
  value: InferenceEngine | null | undefined
) {
  if (value === 'go') return 'Rust'
  return (
    INFERENCE_ENGINE_OPTIONS.find((option) => option.value === value)?.label ||
    '未知'
  )
}
