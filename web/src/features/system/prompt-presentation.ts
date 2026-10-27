import type { RawBlock } from '@/lib/persona-template'

const VARIABLES: Record<string, string> = {
  main_prompt_303: 'official_prompt',
  harness_303: 'official_harness',
  guidance_303: 'official_guidance',
  env_303: 'environment',
}

const LABELS: Record<string, [string, string]> = {
  billing: ['计费归因', '保留请求所需的计费标识'],
  identity: [
    '身份',
    "You are Claude Code, Anthropic's official CLI for Claude.",
  ],
  harness: ['核心提示词', '工作方式、工具使用与执行规则'],
  guidance: ['行为指引', '交互规范与记忆指引'],
  dynamic_boundary: ['动态边界', '仅供 cli-hop 拆分，不出站'],
  caller_system: ['调用方提示词', '追加请求中的 system 内容'],
  env: ['运行环境', '工作目录、平台与终端信息'],
  env_official: ['运行环境', '工作目录、平台、终端与时区'],
  env_extra: ['模型附加句', '当前模型的补充说明'],
}

export function promptBlockLabel(id: string): [string, string] {
  return LABELS[id] || ['自定义提示词', '自定义注入内容']
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

function displayNote(note: string): string {
  return note.replace(/2\.1\.303\s*/g, '').trim()
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
