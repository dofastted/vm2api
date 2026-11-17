/**
 * Third-party client system relocation.
 *
 * Anthropic rejects subscription OAuth traffic whose `system` field carries a
 * third-party agent prompt (OpenCode, Cline, ...) with a 400 "Third-party apps
 * now draw from your extra usage". The decision keys on the content of the
 * system field as a whole: renaming the product, or splitting the prompt over
 * several system blocks, does not help. The same text placed in the first user
 * message is accepted, so for non-Claude-Code callers the system prompt is
 * moved there before the persona renders its own system.
 *
 * Runs once on the caller body, ahead of every hop. Official Claude Code
 * traffic is left alone. Bound to routing.compatibility.claude_code_only
 * (面板「仅允许 Claude Code 家族请求」): off admits third-party clients and
 * relocates their system; on rejects them at the gate with 403
 * claude_code_only before any slot is picked, so nothing is relocated.
 */
import { CRS_OFFICIAL_CLI_SYSTEM, isKnownOfficialSystemText } from '../identity/crs-persona.mjs'
import { claudeCodeOnlyFromRouting } from '../identity/claude-code-only.mjs'

/** Third-party clients are admitted (and relocated) exactly when claude_code_only is off. */
export function thirdPartyRelocateEnabled(routing = null) {
  return !claudeCodeOnlyFromRouting(routing)
}

function systemBlocks(system) {
  if (typeof system === 'string') return [{ type: 'text', text: system }]
  if (Array.isArray(system)) return system.map((b) => (typeof b === 'string' ? { type: 'text', text: b } : b))
  if (system && typeof system === 'object') return [system]
  return []
}

/**
 * Split system blocks into caller content (to relocate) and what stays
 * (official identity/billing boilerplate and non-text blocks). Caller cache
 * markers move with their blocks: system precedes messages, so the breakpoint
 * count and TTL order stay as the caller (and the earlier TTL repair) left
 * them, and the relocated prefix stays cacheable across requests.
 */
function splitSystem(system) {
  const move = []
  for (const block of systemBlocks(system)) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
    if (!block.text.trim() || isKnownOfficialSystemText(block.text)) continue
    move.push(
      block.cache_control == null
        ? { type: 'text', text: block.text }
        : { type: 'text', text: block.text, cache_control: block.cache_control },
    )
  }
  return move
}

function firstUserIndex(messages) {
  return messages.findIndex((m) => m?.role === 'user')
}

/**
 * @returns {{ body: object, moved: boolean, blocks: number, chars: number }}
 */
export function relocateThirdPartySystem(body) {
  const none = { body, moved: false, blocks: 0, chars: 0 }
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || !body.messages.length) return none
  const moved = splitSystem(body.system)
  if (!moved.length) return none
  const messages = body.messages.slice()
  const at = firstUserIndex(messages)
  const first = at >= 0 ? messages[at] : null
  if (first) {
    const content =
      typeof first.content === 'string'
        ? [...moved, { type: 'text', text: first.content }]
        : Array.isArray(first.content)
          ? [...moved, ...first.content]
          : moved
    messages[at] = { ...first, content }
  } else {
    // No user turn to attach to; an alternation-safe one goes first.
    messages.unshift({ role: 'user', content: moved })
  }
  return {
    body: { ...body, system: [{ type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM }], messages },
    moved: true,
    blocks: moved.length,
    chars: moved.reduce((n, b) => n + b.text.length, 0),
  }
}
