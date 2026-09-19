import type { PersonaBlock, PersonaPreset } from '@/types/panel-routing'
import {
  DEFAULT_OVERLAY_TEMPLATES,
  DEFAULT_PERSONA_TEMPLATES,
  OVERLAY_TEMPLATE_KEYS,
  PERSONA_PRESETS,
  parsePersonaTemplateLines,
  presetSeed,
  stringifyPersonaTemplate,
  templateOrFollowPreset,
  type OverlayTemplateKey,
  type RawBlock,
} from '@/lib/persona-template'

export type Compat = Record<string, unknown>
export type PersonaDrafts = Record<PersonaPreset, string>
export type OverlayDrafts = Record<OverlayTemplateKey, string>

/**
 * 内置为空的档（custom）用 official 打底，这样编辑器不会一片空白，
 * 同时预览显示的就是后端真正会回落到的模板。
 */
export function seedText<K extends string>(
  stored: unknown,
  defaults: Record<K, PersonaBlock[]>,
  key: K
): string {
  const list = (stored as Record<string, unknown> | undefined)?.[key]
  const blocks =
    Array.isArray(list) && list.length
      ? (list as RawBlock[])
      : presetSeed(defaults, key)
  return stringifyPersonaTemplate(blocks)
}

export function seedPersonaDrafts(compat: Compat): PersonaDrafts {
  const stored = compat.persona_templates
  return {
    official: seedText(stored, DEFAULT_PERSONA_TEMPLATES, 'official'),
    official_full: seedText(stored, DEFAULT_PERSONA_TEMPLATES, 'official_full'),
    zero: seedText(stored, DEFAULT_PERSONA_TEMPLATES, 'zero'),
    custom: seedText(stored, DEFAULT_PERSONA_TEMPLATES, 'custom'),
  }
}

export function seedOverlayDrafts(compat: Compat): OverlayDrafts {
  const stored = compat.overlay_templates
  return {
    official: seedText(stored, DEFAULT_OVERLAY_TEMPLATES, 'official'),
    minimal: seedText(stored, DEFAULT_OVERLAY_TEMPLATES, 'minimal'),
    custom: seedText(stored, DEFAULT_OVERLAY_TEMPLATES, 'custom'),
  }
}

export function personaTemplatesPayload(drafts: PersonaDrafts) {
  const out: Record<string, RawBlock[]> = {}
  for (const key of PERSONA_PRESETS) {
    const { blocks } = parsePersonaTemplateLines(drafts[key])
    out[key] = templateOrFollowPreset(blocks, DEFAULT_PERSONA_TEMPLATES, key)
  }
  return out
}

export function overlayTemplatesPayload(drafts: OverlayDrafts) {
  const out: Record<string, RawBlock[]> = {}
  for (const key of OVERLAY_TEMPLATE_KEYS) {
    const { blocks } = parsePersonaTemplateLines(drafts[key])
    out[key] = templateOrFollowPreset(blocks, DEFAULT_OVERLAY_TEMPLATES, key)
  }
  return out
}

export function personaDraftStoresEmpty(
  text: string,
  key: PersonaPreset
): boolean {
  const { blocks, errors } = parsePersonaTemplateLines(text)
  if (errors.length) return false
  return (
    templateOrFollowPreset(blocks, DEFAULT_PERSONA_TEMPLATES, key).length === 0
  )
}

export function personaSchemeSummary(text: string, key: PersonaPreset): string {
  const { blocks, errors } = parsePersonaTemplateLines(text)
  if (errors.length) return `${errors.length} 处 JSONL 错误，点配置修复`
  const stored = templateOrFollowPreset(blocks, DEFAULT_PERSONA_TEMPLATES, key)
  const effective = stored.length
    ? stored
    : presetSeed(DEFAULT_PERSONA_TEMPLATES, key)
  const ids = effective
    .map((block) => String(block.id ?? '-'))
    .filter(Boolean)
    .join(' / ')
  const hideN = effective.filter((block) => block.hide === true).length
  if (key === 'custom' && stored.length === 0) {
    return `空数组，保存后回落官方提示词（${ids}）`
  }
  const bits = [
    stored.length === 0 ? '跟随内置预设' : '已改模板',
    `${effective.length} 块`,
  ]
  if (ids) bits.push(ids)
  if (hideN) bits.push(`${hideN} 块遮罩 usage`)
  return bits.join(' · ')
}
