/**
 * Codex model mappings (routing `codex.model_mappings`). The panel always PUTs the whole table:
 * the server replaces it, so every row the operator keeps must be sent back.
 */

export const AUTO_REVIEW_ALIAS = 'codex-auto-review'
// Mirrors DEFAULT_CODEX_MODEL_MAPPINGS on the server. GET returns the merged default, so a row
// equal to it is left out of the PUT and keeps following the product default.
export const AUTO_REVIEW_DEFAULT = 'gpt-6-luna'

export type MappingRow = { alias: string; target: string; fixed: boolean }

export type AliasProblem =
  'empty' | 'whitespace' | 'duplicate' | 'anthropic' | 'image_tool'

export const ALIAS_PROBLEM_TEXT: Record<AliasProblem, string> = {
  empty: '别名不能为空',
  whitespace: '别名不能包含空白',
  duplicate: '别名重复',
  anthropic: 'Anthropic 模型名会劫持 Claude 请求',
  image_tool: '图像模型不能映射',
}

/** codex-auto-review first and fixed; the rest in stored order. */
export function mappingRows(
  map: Record<string, string> | null | undefined
): MappingRow[] {
  const src = map || {}
  const rows: MappingRow[] = [
    {
      alias: AUTO_REVIEW_ALIAS,
      target: src[AUTO_REVIEW_ALIAS] || AUTO_REVIEW_DEFAULT,
      fixed: true,
    },
  ]
  for (const [alias, target] of Object.entries(src)) {
    if (alias === AUTO_REVIEW_ALIAS) continue
    rows.push({ alias, target: String(target || ''), fixed: false })
  }
  return rows
}

export function rowsToMap(rows: MappingRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const alias = row.alias.trim()
    if (!alias) continue
    if (row.fixed && row.target === AUTO_REVIEW_DEFAULT) continue
    out[alias] = row.target
  }
  return out
}

export function mappingTargets(models: { id: string; enabled?: boolean }[]) {
  return models.filter((m) => m.enabled !== false).map((m) => m.id)
}

export function mappingProblem(target: string, enabled: string[]) {
  return enabled.includes(target) ? null : 'disabled'
}

/** Same rules the server applies (`validateCodexModelMappingsPatch`); the server stays authoritative. */
export function aliasProblem(
  alias: string,
  rows: MappingRow[],
  index: number,
  imageIds: string[]
): AliasProblem | null {
  if (!alias.trim()) return 'empty'
  if (/\s/.test(alias)) return 'whitespace'
  const lower = alias.toLowerCase()
  if (
    rows.some(
      (row, i) => i !== index && row.alias.trim().toLowerCase() === lower
    )
  )
    return 'duplicate'
  const bare = lower.split('/').filter(Boolean).pop() || lower
  if (
    bare.startsWith('claude-') ||
    bare.startsWith('anthropic.claude-') ||
    /^(sonnet|opus|haiku|fable)(-|$)/.test(bare)
  )
    return 'anthropic'
  if (imageIds.some((id) => id.toLowerCase() === bare)) return 'image_tool'
  return null
}
