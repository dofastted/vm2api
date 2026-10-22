/**
 * GPT image models served through `/v1/images/*` and the Responses `image_generation` tool.
 * Not chat models: SKIP_GPT keeps them out of chat routing and the GPT chat catalog. No I/O.
 */

export const IMAGE_TOOL_MODELS = Object.freeze([
  Object.freeze({
    id: 'gpt-image-2.5-flare',
    display_name: 'GPT Image 2.5 Flare',
    snapshots: Object.freeze(['gpt-image-2.5-flare-2026-09-08']),
    upstream_default: true,
    sort: 10,
  }),
  Object.freeze({
    id: 'gpt-image-2.5-sunburst',
    display_name: 'GPT Image 2.5 Sunburst',
    snapshots: Object.freeze(['gpt-image-2.5-sunburst-2026-09-08']),
    upstream_default: false,
    sort: 20,
  }),
])

const CANONICAL = new Map()
for (const model of IMAGE_TOOL_MODELS) {
  CANONICAL.set(model.id, model.id)
  for (const snapshot of model.snapshots) CANONICAL.set(snapshot, model.id)
}

/** Canonical id for a known image model or one of its snapshots; null otherwise. */
export function canonicalImageToolModel(id) {
  const raw = String(id || '').trim()
  if (!raw) return null
  const bare = raw.split('/').filter(Boolean).pop() || raw
  return CANONICAL.get(bare.toLowerCase()) || null
}

/** `tools[]` entries that ask for the hosted image generation tool. */
export function imageGenerationTools(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return tools.filter((tool) => tool && typeof tool === 'object' && tool.type === 'image_generation')
}
