/**
 * CRAG v2 print worker (claude-code-2.1.317) does not read kernel.json
 * persona_preset or CLAUDE_CODE_SYSTEM_LAYOUT. Bare `system` is append.
 * official_full must not resend the official four blocks. zero must be
 * crag_prompt.mode=replace. --bare is not used: it drops OAuth.
 * Print keeps builtin tools and Chrome; --tools "" / --no-chrome are TUI-only.
 */
import { normalizeSlotPersonaPreset } from '../vm/slot-engine.mjs'

export const CRAG_PRINT_PROMPT_MAX_BYTES = 64 * 1024
const BILLING_LINE = /^x-anthropic-billing-header:/i

export function normalizeCragPersonaPreset(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('_', '-')
  if (raw === 'zero' || raw === '0' || raw === '0-inject') return 'zero'
  return 'official_full'
}

/**
 * Slot zero stays replace. Any other explicit slot preset is append-only:
 * official (identity-only), official_303 and custom templates have no print flag.
 * Empty slot inherits compatibility.crag_persona_preset, not persona_preset.
 */
export function resolveCragPrintPersona(vm, routing = {}) {
  const slot = normalizeSlotPersonaPreset(vm?.persona_preset, { inherit: true })
  if (slot === 'zero') return 'zero'
  if (slot) return 'official_full'
  return normalizeCragPersonaPreset(routing?.compatibility?.crag_persona_preset)
}

function textOf(block) {
  if (typeof block === 'string') return block
  if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') return block.text
  return ''
}

/** Caller tail only. Drops non-text blocks, cache_control and billing lines. */
export function callerSystemTail(system) {
  const list = typeof system === 'string' ? [system] : Array.isArray(system) ? system : []
  const parts = []
  for (const block of list) {
    const text = textOf(block)
    if (!text) continue
    const kept = text
      .split('\n')
      .filter((line) => !BILLING_LINE.test(line.trim()))
      .join('\n')
      .trim()
    if (kept) parts.push(kept)
  }
  return parts.join('\n\n')
}

function stripCallerPromptAlias(body) {
  delete body.crag_prompt
  if (!body.crag_options || typeof body.crag_options !== 'object' || Array.isArray(body.crag_options)) return
  const { prompt: _prompt, ...rest } = body.crag_options
  if (Object.keys(rest).length) body.crag_options = rest
  else delete body.crag_options
}

export function cragPromptTooLarge(bytes) {
  const error = new Error('prompt too large for original CLI replace mode')
  error.status = 400
  error.body = {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      code: 'crag_prompt_too_large',
      message: `zero replace is ${bytes} bytes; original CLI --system-prompt stops at ${CRAG_PRINT_PROMPT_MAX_BYTES}`,
    },
  }
  return error
}

/**
 * @param {object} body caller body, before cli-node persona injection
 * @param {{ preset?: 'official_full' | 'zero', officialPassthrough?: boolean }} [options]
 */
export function prepareCragPrintBody(body, { preset = 'official_full', officialPassthrough = false } = {}) {
  const out = { ...(body || {}) }
  const mode = preset === 'zero' ? 'replace' : 'append'
  const tail = officialPassthrough ? '' : callerSystemTail(out.system)
  delete out.system
  stripCallerPromptAlias(out)
  if (!tail) return out
  if (mode === 'replace' && Buffer.byteLength(tail, 'utf8') > CRAG_PRINT_PROMPT_MAX_BYTES) {
    throw cragPromptTooLarge(Buffer.byteLength(tail, 'utf8'))
  }
  out.crag_prompt = { mode, text: tail }
  return out
}
