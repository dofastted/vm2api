/**
 * Claude Code 2.1.310 auto-mode reminder (chunk-j0tbz6ra.js, case "auto_mode").
 * The short "still active" lines are not in that build. A client or an older
 * cli-node repeats them, and the model copies the stack into the transcript.
 */

export const OFFICIAL_AUTO_MODE_REMINDER = `## Auto Mode Active

Bias toward working without stopping for clarifying questions — when you'd normally pause to check, make the reasonable call and keep going; they'll redirect you if needed. If the user, a skill, or the shape of the task suggests they want you to ask (with AskUserQuestion or otherwise), do so. And even absent that signal, it's still fine to stop when you're genuinely blocked — unclear direction, missing input, a decision only they can make.

Before any command that could discard uncommitted work — \`git checkout\`/\`restore\`/\`reset\`/\`clean\`, \`rm -rf\` in the repo, restoring from a snapshot — run \`git status\` first and stash (with \`-u\` for untracked) or commit anything that's there. When staging or committing, review what's included (\`git status\` after a broad \`git add\`), and if you see anything suspicious that might reveal secrets — even if the filename looks innocuous — double-check the file's contents before pushing.`

const CANONICAL = `<system-reminder>\n${OFFICIAL_AUTO_MODE_REMINDER}\n</system-reminder>`
const REMINDER_BLOCK = /<system-reminder>([\s\S]*?)<\/system-reminder>/g

function isBadInner(inner) {
  const text = String(inner || '').trim()
  if (/^Auto mode still active \(reported by harness\)\.?$/.test(text)) return true
  if (/^Auto mode still active \(see full instructions earlier in conversation\)\./.test(text)) return true
  return text.startsWith('## Auto Mode Active\n\nAuto mode is active. The user chose continuous, autonomous execution.')
}

/** Keep the first official reminder. Later copies are the flood. */
function collapseDuplicateCanonical(text) {
  const parts = text.split(CANONICAL)
  if (parts.length <= 2) return text
  const rest = parts.slice(1).join('').replace(/^\n+/, '\n').replace(/\n+$/, '')
  return parts[0] + CANONICAL + rest
}

/**
 * Replace a known-bad auto-mode reminder. Assistant echoes are removed.
 * User reminders become one official reminder. Other text stays.
 */
export function repairAutoModeReminderText(text, role = 'user') {
  if (typeof text !== 'string' || (!text.includes('Auto mode') && !text.includes('## Auto Mode Active'))) return text
  const replaced = text.replace(REMINDER_BLOCK, (full, inner) => {
    if (!isBadInner(inner)) return full
    return role === 'assistant' ? '' : CANONICAL
  })
  let out = collapseDuplicateCanonical(replaced)
  if (isBadInner(out)) out = role === 'assistant' ? '' : CANONICAL
  if (role === 'assistant') {
    const rest = out.split(CANONICAL).join('').trim()
    if (!rest) return ''
  }
  return out
}

function repairBlocks(blocks, role) {
  const next = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || typeof block.text !== 'string') {
      next.push(block)
      continue
    }
    if (block.type != null && block.type !== 'text') {
      next.push(block)
      continue
    }
    const text = repairAutoModeReminderText(block.text, role)
    if (!String(text).trim()) continue
    const prev = next[next.length - 1]
    if (prev && prev.type === 'text' && prev.text === text && text === CANONICAL) continue
    next.push(text === block.text ? block : { ...block, text })
  }
  return next
}

/** Mutates message content. Empty leftovers are dropped by normalizeAnthropicMessages. */
export function repairAutoModeReminders(body) {
  if (!body || !Array.isArray(body.messages)) return body
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') continue
    const role = String(message.role || '')
      .trim()
      .toLowerCase()
    const content = message.content
    if (typeof content === 'string') {
      message.content = repairAutoModeReminderText(content, role)
      continue
    }
    if (Array.isArray(content)) message.content = repairBlocks(content, role)
  }
  return body
}
