/**
 * Third-party client system relocation.
 *
 * Anthropic rejects subscription OAuth traffic whose `system` field carries a
 * third-party agent prompt (OpenCode, Cline, ...) with a 400 "Third-party apps
 * now draw from your extra usage". The decision keys on the content of the
 * system field as a whole: renaming the product, or splitting the prompt over
 * several system blocks, does not help. Relocate caller blocks to the first
 * user turn before the persona renders its own system.
 *
 * Runs once on the caller body, ahead of every hop. Official-looking blocks
 * are not relocated, but an official CLI identity does not exempt other blocks.
 * Bound to routing.compatibility.claude_code_only (面板「仅允许 Claude Code 家族请求」): off admits third-party clients and
 * relocates their system; on rejects them at the gate with 403
 * claude_code_only before any slot is picked, so nothing is relocated.
 */
import {
  CRS_OFFICIAL_CLI_SYSTEM,
  hasEnvironmentSection,
  hasOfficialClaudeChildPrompt,
  hasOfficialClaudeEntrypoint,
  hasOfficialClaudeLine,
  isKnownOfficialSystemText,
  isOfficialClaudeSecurityMonitorPrompt,
  looksLikeAgentPrompt,
} from '../identity/crs-persona.mjs'
import { claudeCodeOnlyFromRouting } from '../identity/claude-code-only.mjs'
import { classifySystemText } from '../identity/official-profiles.mjs'

function isForeignSystemBlock(block) {
  const text = block?.text
  if (block?.type !== 'text' || typeof text !== 'string' || !text.trim()) return false
  // Agent prompts evolve independently of the identity and Environment blocks.
  // The wire profile also has standalone harness, boundary and guidance blocks.
  // Do not split an official-looking block: a suffix can be a new official section.
  return !(
    looksLikeAgentPrompt(text) ||
    isKnownOfficialSystemText(text) ||
    classifySystemText(text) !== 'other' ||
    /^[ \t]*x-anthropic-billing-header:/im.test(text) ||
    hasOfficialClaudeEntrypoint(text) ||
    hasOfficialClaudeLine(text) ||
    hasEnvironmentSection(text) ||
    hasOfficialClaudeChildPrompt(text) ||
    isOfficialClaudeSecurityMonitorPrompt(text)
  )
}

export function hasForeignSystemBlock(system) {
  return systemBlocks(system).some(isForeignSystemBlock)
}

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
 * Collect the blocks that must leave `system`. Cache markers move with the
 * relocated blocks so their TTL order is preserved ahead of the original user
 * content.
 *
 * The predicate depends on *why* relocation runs, because the two callers ask
 * different questions:
 *
 * - A third-party caller (`!officialTraffic`) needs the greedy predicate:
 *   anything that is not known-official boilerplate is exactly what the
 *   upstream 400s on. A third-party agent prompt routinely carries a
 *   `# Environment` section or the official agent wording, and treating those
 *   as official here would leave them in `system` and reintroduce that 400.
 * - Official traffic that the gate opened on (`onlyForeign`) needs the narrow
 *   predicate: only the positively foreign blocks go. The real official wire
 *   envelope has standalone harness, boundary and guidance blocks that
 *   `KNOWN_OFFICIAL_SYSTEM_TEXTS` does not list, so the greedy predicate would
 *   strip the official envelope while removing the appended block.
 */
function splitSystem(system, { onlyForeign = false } = {}) {
  const move = []
  for (const block of systemBlocks(system)) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
    if (onlyForeign) {
      if (!isForeignSystemBlock(block)) continue
    } else if (!block.text.trim() || isKnownOfficialSystemText(block.text)) continue
    move.push(
      block.cache_control == null
        ? { type: 'text', text: block.text }
        : {
            type: 'text',
            text: block.text,
            cache_control: block.cache_control,
          },
    )
  }
  return move
}

function firstUserIndex(messages) {
  return messages.findIndex((m) => m?.role === 'user')
}

/**
 * @param {object} body caller body
 * @param {{ onlyForeign?: boolean }} [opts] `onlyForeign` when the caller is
 *   official traffic the gate opened on: move only the positively foreign
 *   blocks and leave the official envelope in `system`. See splitSystem.
 * @returns {{ body: object, moved: boolean, blocks: number, chars: number }}
 */
export function relocateThirdPartySystem(body, { onlyForeign = false } = {}) {
  const none = { body, moved: false, blocks: 0, chars: 0 }
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || !body.messages.length) return none
  const moved = splitSystem(body.system, { onlyForeign })
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
    body: {
      ...body,
      system: [{ type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM }],
      messages,
    },
    moved: true,
    blocks: moved.length,
    chars: moved.reduce((n, b) => n + b.text.length, 0),
  }
}
