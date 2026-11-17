/**
 * Codex/OpenAI-style tool-name remapping to native Claude Code tool names.
 * Pure protocol conversion — no CLI involvement.
 */
import { isVersionedAnthropicServerTool } from './web-search.mjs'

export const CODEX_TOOL_MAP = {
  apply_patch: 'Bash',
  applyPatch: 'Bash',
  execute_bash: 'Bash',
  executeBash: 'Bash',
  exec_bash: 'Bash',
  execBash: 'Bash',
  read_file: 'Read',
  readFile: 'Read',
  write_file: 'Write',
  writeFile: 'Write',
  search_files: 'Grep',
  searchFiles: 'Grep',
  list_files: 'Glob',
  listFiles: 'Glob',
  update_plan: 'TodoWrite',
  updatePlan: 'TodoWrite',
  read_plan: 'TodoRead',
  readPlan: 'TodoRead',
  fetch: 'WebFetch',
  web_fetch: 'WebFetch',
  webFetch: 'WebFetch',
}

function remapToolName(name) {
  if (!name) return name
  return CODEX_TOOL_MAP[name] || name
}

export function remapCodexTools(tools) {
  if (!Array.isArray(tools)) return tools
  return tools.map((t) => {
    if (!t || typeof t !== 'object' || isVersionedAnthropicServerTool(t)) return t
    if (t.name) return { ...t, name: remapToolName(t.name) }
    if (t.function?.name) {
      return { ...t, function: { ...t.function, name: remapToolName(t.function.name) } }
    }
    return t
  })
}
