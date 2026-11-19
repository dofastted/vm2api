import type { AntigravityReasoningLevel } from '@/features/vm/antigravity-model-sync'

export const ANTIGRAVITY_REASONING_LEVELS: readonly AntigravityReasoningLevel[] =
  ['minimal', 'low', 'medium', 'high']

/** Preserve per-model settings when an administrator edits the ID list or reasoning levels. */
export function antigravityModelsFromIds(
  previous: unknown,
  text: string,
  levelOverrides?: Record<string, AntigravityReasoningLevel[]>
) {
  const models = new Map<string, string | Record<string, unknown>>()
  if (Array.isArray(previous)) {
    for (const item of previous) {
      if (typeof item === 'string') models.set(item, item)
      else if (item && typeof item === 'object' && typeof item.id === 'string')
        models.set(item.id, item)
    }
  }
  return [
    ...new Set(
      text
        .split('\n')
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ].map((id) => {
    const existing = models.get(id)
    const levels = levelOverrides?.[id]
    if (!levels) return existing || id
    const base = existing && typeof existing === 'object' ? existing : { id }
    return {
      ...base,
      levels: ANTIGRAVITY_REASONING_LEVELS.filter((level) =>
        levels.includes(level)
      ),
    }
  })
}
