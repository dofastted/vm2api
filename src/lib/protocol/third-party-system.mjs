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
import { CRS_OFFICIAL_CLI_SYSTEM, isKnownOfficialSystemText } from '../identity/crs-persona.mjs'
import { claudeCodeOnlyFromRouting } from '../identity/claude-code-only.mjs'
import { findSecurityMonitorSystemBlock, isForeignOfficialSystemBlock } from '../identity/official-cc-verifier.mjs'

function isForeignSystemBlock(block, opts = {}) {
  return isForeignOfficialSystemBlock(block, opts)
}

export function hasForeignSystemBlock(system) {
  const isSecurityMonitor = findSecurityMonitorSystemBlock(system) !== null
  return systemBlocks(system).some((block) => isForeignSystemBlock(block, { isSecurityMonitor }))
}

/**
 * Third-party clients are admitted (and relocated) when claude_code_only is off.
 * V10: when `onlyForeign: true` (admitted official/hybrid client with a foreign
 * appended block), relocation MUST stay enabled even when claude_code_only is on.
 */
export function thirdPartyRelocateEnabled(routing = null, { onlyForeign = false } = {}) {
  if (onlyForeign === true) return true
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
  const isSecurityMonitor = findSecurityMonitorSystemBlock(system) !== null
  const move = []
  for (const block of systemBlocks(system)) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
    if (onlyForeign) {
      if (!isForeignSystemBlock(block, { isSecurityMonitor })) continue
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

function isSystemMessageRole(role) {
  const r = String(role || '')
    .trim()
    .toLowerCase()
  return r === 'system' || r === 'developer'
}

/**
 * V9: Extract text blocks from third-party `messages[].role === 'system' | 'developer'`
 * turns so they relocate into `messages[0]` instead of leaking on CRAG V4 or lifting
 * back into top-level `system[]` on cli-hop. Directive-only / non-text turns stay.
 */
function extractThirdPartySystemMessages(messages) {
  const moved = []
  const kept = []
  for (const msg of messages) {
    if (!msg || !isSystemMessageRole(msg.role)) {
      kept.push(msg)
      continue
    }
    const hasTurnControl = msg.output_config != null || msg.cache_control != null
    if (typeof msg.content === 'string') {
      if (msg.content.trim()) {
        moved.push({ type: 'text', text: msg.content })
        if (hasTurnControl) kept.push({ ...msg, content: [] })
      } else {
        kept.push(msg)
      }
      continue
    }
    if (Array.isArray(msg.content)) {
      const remaining = []
      let extractedAny = false
      for (const block of msg.content) {
        if (typeof block === 'string') {
          if (block.trim()) {
            moved.push({ type: 'text', text: block })
            extractedAny = true
          }
        } else if (block && block.type === 'text' && typeof block.text === 'string') {
          if (block.text.trim()) {
            moved.push(
              block.cache_control == null
                ? { type: 'text', text: block.text }
                : { type: 'text', text: block.text, cache_control: block.cache_control },
            )
            extractedAny = true
          }
        } else if (block != null) {
          remaining.push(block)
        }
      }
      if (!extractedAny) {
        kept.push(msg)
      } else if (remaining.length > 0 || hasTurnControl) {
        kept.push({ ...msg, content: remaining })
      }
      continue
    }
    kept.push(msg)
  }
  return { moved, messages: kept }
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
  const movedFromSystem = splitSystem(body.system, { onlyForeign })
  const fromMessages = onlyForeign
    ? { moved: [], messages: body.messages.slice() }
    : extractThirdPartySystemMessages(body.messages)
  const moved = [...movedFromSystem, ...fromMessages.moved]
  if (!moved.length) return none
  const messages = fromMessages.messages.slice()
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
  const nextBody = {
    ...body,
    messages,
  }
  if (movedFromSystem.length > 0) {
    nextBody.system = [{ type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM }]
  }
  return {
    body: nextBody,
    moved: true,
    blocks: moved.length,
    chars: moved.reduce((n, b) => n + b.text.length, 0),
  }
}
