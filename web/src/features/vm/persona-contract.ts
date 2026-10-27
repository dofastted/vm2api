export type SlotPersonaPreset =
  'inherit' | 'official' | 'official_full' | 'zero' | 'official_303'

const SLOT_LABELS: Record<SlotPersonaPreset, string> = {
  inherit: '跟随全局',
  official: '官方提示词',
  official_full: '官方完整提示词',
  zero: '0注入',
  official_303: '官方 2.1.303（按模型）',
}

export const SLOT_PERSONA_OPTIONS: {
  value: SlotPersonaPreset
  label: string
}[] = (Object.keys(SLOT_LABELS) as SlotPersonaPreset[]).map((value) => ({
  value,
  label: SLOT_LABELS[value],
}))

export function normalizeSlotPersonaPreset(
  value: unknown,
  fallback: SlotPersonaPreset = 'inherit'
): SlotPersonaPreset {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!raw || raw === 'inherit' || raw === 'global' || raw === 'default') {
    return 'inherit'
  }
  if (raw === 'official_full' || raw === 'full' || raw === 'agent_official') {
    return 'official_full'
  }
  if (
    raw === 'official' ||
    raw === 'official_prompt' ||
    raw === 'prompt' ||
    raw === 'agent_prompt' ||
    raw === 'cc_prompt'
  ) {
    return 'official'
  }
  if (
    raw === 'zero' ||
    raw === 'zero_inject' ||
    raw === '0inject' ||
    raw === '0-inject'
  ) {
    return 'zero'
  }
  if (raw === 'official_303' || raw === '303' || raw === 'official-303') {
    return 'official_303'
  }
  return fallback
}

/** Gateway PATCH: empty string means inherit the settings-page preset. */
export function slotPersonaPatchValue(value: SlotPersonaPreset) {
  return value === 'inherit' ? '' : value
}

export function slotPersonaLabel(value: SlotPersonaPreset | null | undefined) {
  return (value && SLOT_LABELS[value]) || SLOT_LABELS.inherit
}
