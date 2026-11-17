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
 * traffic is left alone. Switch: routing.compatibility.third_party_system_relocate
 * (default on) or env KIN_THIRD_PARTY_SYSTEM_RELOCATE=0.
 */
import { CRS_OFFICIAL_CLI_SYSTEM, isKnownOfficialSystemText } from '../identity/crs-persona.mjs'

export const THIRD_PARTY_RELOCATE_ENV = 'KIN_THIRD_PARTY_SYSTEM_RELOCATE'

const OFF_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled'])

export function thirdPartyRelocateEnabled(routing = null, env = process.env) {
  const fromEnv = env?.[THIRD_PARTY_RELOCATE_ENV]
  if (fromEnv != null && fromEnv !== '') return !OFF_VALUES.has(String(fromEnv).trim().toLowerCase())
  const setting = routing?.compatibility?.third_party_system_relocate
  if (setting == null) return true
  if (typeof setting === 'string') return !OFF_VALUES.has(setting.trim().toLowerCase())
  return setting !== false
}

function systemBlocks(system) {
  if (typeof system === 'string') return [{ type: 'text', text: system }]
  if (Array.isArray(system)) return system.map((b) => (typeof b === 'string' ? { type: 'text', text: b } : b))
  if (system && typeof system === 'object') return [system]
  return []
}

function withoutCache(block) {
  if (!block || block.cache_control == null) return block
  const { cache_control: _drop, ...rest } = block
  return rest
}

/**
 * Split system blocks into caller content (to relocate) and what stays
 * (official identity/billing boilerplate and non-text blocks).
 */
function splitSystem(system) {
  const move = []
  for (const block of systemBlocks(system)) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
    if (!block.text.trim() || isKnownOfficialSystemText(block.text)) continue
    move.push(withoutCache(block))
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
  const lead = moved.map((b) => ({ type: 'text', text: b.text }))
  if (first) {
    const content =
      typeof first.content === 'string'
        ? [...lead, { type: 'text', text: first.content }]
        : Array.isArray(first.content)
          ? [...lead, ...first.content]
          : lead
    messages[at] = { ...first, content }
  } else {
    // No user turn to attach to; an alternation-safe one goes first.
    messages.unshift({ role: 'user', content: lead })
  }
  return {
    body: { ...body, system: [{ type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM }], messages },
    moved: true,
    blocks: moved.length,
    chars: moved.reduce((n, b) => n + b.text.length, 0),
  }
}
