import type { PersonaPreset } from '@/types/panel-routing'
import type { RawBlock } from '@/lib/persona-template'

const VARIABLES: Record<string, string> = {
  main_prompt_303: 'official_prompt',
  harness_303: 'official_harness',
  guidance_303: 'official_guidance',
  env_303: 'environment',
  env_instructions_303: 'env_instructions',
}

export const ANTHROPIC_MODE_META: Record<
  PersonaPreset,
  { label: string; summary: string }
> = {
  official: {
    label: '官方提示词',
    summary: '仅注入身份句，核心与环境按需开启',
  },
  official_full: {
    label: '完整官方提示词',
    summary: '身份 + 核心提示词 + 运行环境',
  },
  zero: {
    label: '0注入',
    summary: '不注入系统块，业务 system 原样透传',
  },
  custom: {
    label: '自定义',
    summary: '自由编排提示词块与变量模板',
  },
}

export const ANTHROPIC_MODE_OPTIONS: readonly {
  value: PersonaPreset
  label: string
  summary: string
}[] = [
  { value: 'official', ...ANTHROPIC_MODE_META.official },
  { value: 'official_full', ...ANTHROPIC_MODE_META.official_full },
  { value: 'zero', ...ANTHROPIC_MODE_META.zero },
  { value: 'custom', ...ANTHROPIC_MODE_META.custom },
]

export function anthropicPresetLabel(preset: PersonaPreset): string {
  return (
    ANTHROPIC_MODE_META[preset]?.label || ANTHROPIC_MODE_META.official.label
  )
}

const LABELS: Record<string, [string, string]> = {
  billing: ['计费归因', '保留请求所需的计费标识'],
  identity: [
    '身份',
    "You are Claude Code, Anthropic's official CLI for Claude.",
  ],
  harness: ['核心提示词', '工作方式、工具使用与执行规则'],
  guidance: ['行为指引', '交互规范与记忆指引'],
  dynamic_boundary: ['动态边界', '内部静态与动态分段标记，不出站'],
  caller_system: ['调用方提示词', '追加请求中的 system 内容'],
  env: ['运行环境', '工作目录、平台与终端信息'],
  env_official: ['运行环境', '工作目录、平台、终端与时区'],
  env_extra: ['模型附加句', '当前模型的补充说明'],
  env_instructions: ['长环境说明', '工具、Agent、MCP 与 Skills 环境指引'],
  env_timezone: ['槽位时区', '附加槽位时区行（Timezone）'],
  env_locale: ['槽位语言', '附加槽位语言行（Language）'],
}

export function promptBlockLabel(id: string): [string, string] {
  return LABELS[id] || ['自定义提示词', '自定义注入内容']
}

export type PromptLayerCategory =
  | 'billing'
  | 'identity'
  | 'core'
  | 'guidance'
  | 'environment'
  | 'caller'
  | 'custom'

export function promptBlockCategory(id: string): PromptLayerCategory {
  if (id === 'billing') return 'billing'
  if (id === 'identity') return 'identity'
  if (id === 'harness' || id === 'agent_standing') return 'core'
  if (id === 'guidance') return 'guidance'
  if (/^env(_|$)/.test(id)) return 'environment'
  if (id === 'caller_system') return 'caller'
  return 'custom'
}

export function sanitizeTemplateVarNote(note: string): string {
  return note
    .replace(/2\.1\.303\s*/g, '')
    .replace(/\bcli-node\b/gi, '网关')
    .replace(/\bcli-hop\b/gi, '网关')
    .replace(/\bcrag\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// Display aliases never reach the gateway; saved templates keep its canonical variables.
export function promptDisplayText(text: string): string {
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(VARIABLES, name.toLowerCase())
      ? `{{${VARIABLES[name.toLowerCase()]}}}`
      : match
  )
}

export function promptSourceText(text: string): string {
  const sources = Object.fromEntries(
    Object.entries(VARIABLES).map(([source, display]) => [display, source])
  )
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(sources, name.toLowerCase())
      ? `{{${sources[name.toLowerCase()]}}}`
      : match
  )
}

export type SplitPreviewBlock =
  | { kind: 'short'; head: string }
  | { kind: 'lines'; head: string; tail: string }
  | { kind: 'inline'; excerpt: string; full: string }

const LONG_BLOCK_CHAR_LIMIT = 240
const LONG_BLOCK_LINE_LIMIT = 4

export function splitLongPreviewBlock(text: string): SplitPreviewBlock {
  const lines = text.split('\n')
  if (
    text.length <= LONG_BLOCK_CHAR_LIMIT &&
    lines.length <= LONG_BLOCK_LINE_LIMIT
  ) {
    return { kind: 'short', head: text }
  }
  if (lines.length > LONG_BLOCK_LINE_LIMIT) {
    const head = lines.slice(0, LONG_BLOCK_LINE_LIMIT).join('\n')
    const tail = lines.slice(LONG_BLOCK_LINE_LIMIT).join('\n')
    if (tail.length === 0 && head.length <= LONG_BLOCK_CHAR_LIMIT) {
      return { kind: 'short', head: text }
    }
    if (head.length <= LONG_BLOCK_CHAR_LIMIT + 80 && tail.length > 0) {
      return { kind: 'lines', head, tail }
    }
  }
  const slice = text.slice(0, LONG_BLOCK_CHAR_LIMIT)
  const lastSpace = slice.search(/\s+\S*$/)
  const cut =
    lastSpace > Math.floor(LONG_BLOCK_CHAR_LIMIT * 0.6)
      ? lastSpace
      : LONG_BLOCK_CHAR_LIMIT
  return {
    kind: 'inline',
    excerpt: `${text.slice(0, cut).trimEnd()}…`,
    full: text,
  }
}

export function nextTabIndexForKey(
  key: string,
  currentIndex: number,
  count: number
): number | null {
  if (count <= 0) return null
  if (key === 'ArrowRight' || key === 'ArrowDown')
    return (currentIndex + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp')
    return (currentIndex - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

export function handleSlidingTabKeyDown<T extends string>(
  event: { key: string; preventDefault: () => void },
  index: number,
  items: readonly { value: T }[],
  onChange: (value: T) => void,
  focusItem: (value: T) => void
): boolean {
  const nextIdx = nextTabIndexForKey(event.key, index, items.length)
  if (nextIdx === null) return false
  event.preventDefault()
  const next = items[nextIdx]
  onChange(next.value)
  focusItem(next.value)
  return true
}

function displayNote(note: string): string {
  return sanitizeTemplateVarNote(note)
}

export function promptEditorBlocks(blocks: RawBlock[]): RawBlock[] {
  return blocks.map((block) => ({
    ...block,
    ...(typeof block.note === 'string'
      ? { note: displayNote(block.note) }
      : {}),
    text: promptDisplayText(String(block.text ?? '')),
  }))
}

export function promptSourceBlocks(
  blocks: RawBlock[],
  original: RawBlock[]
): RawBlock[] {
  return blocks.map((block, index) => {
    const previous =
      block.id == null
        ? original[index]
        : original.find((item) => item.id === block.id)
    // Presentation-only notes must not turn an unchanged preset into a saved override.
    const restoreNote =
      typeof previous?.note === 'string' &&
      block.note === displayNote(previous.note)
    return {
      ...block,
      ...(restoreNote ? { note: previous.note } : {}),
      text: promptSourceText(String(block.text ?? '')),
    }
  })
}
