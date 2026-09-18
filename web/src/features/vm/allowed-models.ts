/** Keep existing allowlists usable after correcting the Fable 5.1 model id. */
export function canonicalAllowedModelId(id: string) {
  return String(id)
    .trim()
    .replace(/^claude-fable-5(?:\.1|-1)(?=-|$)/i, 'claude-fable-5-1')
}

/** Match dated aliases without treating Fable 5 and Fable 5.1 as one model. */
export function matchesAllowedModel(modelId: string, entry: string) {
  const model = canonicalAllowedModelId(modelId).toLowerCase()
  const allowed = canonicalAllowedModelId(entry).toLowerCase()
  if (model === allowed) return true
  const fable51 = /^claude-fable-5-1(?:-|$)/
  if (fable51.test(model) !== fable51.test(allowed)) return false
  return model.startsWith(`${allowed}-`) || allowed.startsWith(`${model}-`)
}

export function toggleAllowedModel(
  current: string[],
  id: string,
  checked: boolean
) {
  const target = canonicalAllowedModelId(id)
  const next = [...new Set(current.map(canonicalAllowedModelId))]
  if (checked) return next.includes(target) ? next : [...next, target]
  return next.filter((entry) => entry.toLowerCase() !== target.toLowerCase())
}
