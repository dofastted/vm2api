/**
 * CRAG v2 print worker (claude-code-2.1.321) does not read kernel.json
 * persona_preset or CLAUDE_CODE_SYSTEM_LAYOUT. Bare `system` is append.
 * official_full must not resend the official four blocks. zero must be
 * crag_prompt.mode=replace. --bare is not used: it drops OAuth.
 * Print keeps builtin tools and Chrome; --tools "" / --no-chrome are TUI-only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { normalizeCragKernelVersion, normalizeKernelDataplane, normalizeSlotPersonaPreset } from '../vm/slot-engine.mjs'
/**
 * Print is the CRAG v2 worker only. A live health report wins, then an
 * explicit dataplane on the VM, then the kernel.json that worker was started
 * with. routing.inference is not a kernel: an empty or wrap slot stays on
 * cli-node even when the global default is crag v2.
 */
function namedKernel(source) {
  if (!source || typeof source !== 'object') return ''
  const variant = String(source.runtime_variant || '')
    .trim()
    .toLowerCase()
  if (variant === 'crag-v2') return 'crag-v2'
  if (variant) return 'cli-node'
  const plane = normalizeKernelDataplane(source.dataplane, { inherit: true })
  if (!plane) return ''
  const version = normalizeCragKernelVersion(source.kernel_version ?? source.crag_kernel_version, { inherit: true })
  return plane === 'crag' && version === 'v2' ? 'crag-v2' : 'cli-node'
}

export function readSlotKernelConfig(homeDir) {
  if (!homeDir) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(homeDir, '..', 'run', 'kernel.json'), 'utf8'))
  } catch {
    return null
  }
}

export function cragV2KernelActive({ vm, health, kernelConfig } = {}) {
  const live = namedKernel(health)
  if (live) return live === 'crag-v2'
  const plane = normalizeKernelDataplane(vm?.dataplane, { inherit: true })
  const version = normalizeCragKernelVersion(vm?.crag_kernel_version, { inherit: true })
  if (plane && plane !== 'crag') return false
  if (plane === 'crag' && version) return version === 'v2'
  const filed = namedKernel(kernelConfig)
  if (filed) return filed === 'crag-v2'
  return false
}

const MODEL_DIRECTIVE_CAPS = ['model_directive', 'linux_tui_pty']

/**
 * Only a worker that applies the directive inside its own CLI fetch may see
 * `crag_model`. A hop or older cluster kernel forwards the envelope body and
 * Anthropic answers `crag_model: Extra inputs are not permitted`.
 */
export function cragConsumesModelDirective(health) {
  const caps = health?.capabilities
  if (!Array.isArray(caps)) return false
  return caps.some((cap) => MODEL_DIRECTIVE_CAPS.includes(cap))
}

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

// Use literal LF boundaries: JavaScript's multiline anchors also match Unicode separators.
const cwdDeclaration = /(?:^|\n)([ \t]*<cwd>[ \t]*\r?\n([^\r\n]+)\r?\n[ \t]*<\/cwd>[ \t]*)(?:\r?\n|(?![\s\S]))/

function systemBlocks(system) {
  return typeof system === 'string' ? [system] : Array.isArray(system) ? system : []
}

export function validateCallerCwd(raw) {
  if (typeof raw !== 'string') return null
  const cwd = raw.replace(/^ +| +$/g, '')
  if (!cwd.isWellFormed() || Buffer.byteLength(cwd) > 512) return null
  if (/[<>\p{Cc}\p{Zl}\p{Zp}]/u.test(cwd) || /&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(cwd)) return null
  if (cwd.startsWith('/')) return cwd
  const drive = /^[a-z]:[\\/]/i.test(cwd)
  const unc = cwd.match(/^\\\\([^\\/]+)[\\/]([^\\/]+)/)
  if (!drive && (!unc || unc.slice(1).some((part) => ['', '.', '..'].includes(part.replace(/^ +| +$/g, '')))))
    return null
  return /["|?*:]/.test(drive ? cwd.slice(2) : cwd) ? null : cwd
}

/** Separate the declaration before normalization can lift history into system. */
export function callerCwdDeclaration(system) {
  let tags = 0
  let declaration
  let index
  const blocks = systemBlocks(system)
  for (const [i, block] of blocks.entries()) {
    const text = textOf(block)
    for (const _tag of text.matchAll(/<\/?cwd>/g)) if (++tags > 2) return null
    const match = cwdDeclaration.exec(text)
    if (match) {
      declaration = match
      index = i
    }
  }
  const cwd = tags === 2 && validateCallerCwd(declaration?.[2])
  if (!cwd) return null
  const block = blocks[index]
  const text = textOf(block)
  const start = declaration.index + Number(declaration[0].startsWith('\n'))
  const rest = text.slice(0, start) + text.slice(declaration.index + declaration[0].length)
  return { cwd, index, text, rest, source: system, block }
}

// Conversion reports the normalized counterpart of the raw block before any
// history is lifted. Intercepts can replace it; never search other blocks by value.
export function projectCallerSystem(system, declaration) {
  if (!declaration) return system
  if (typeof system === 'string') {
    return system === declaration.source && system === declaration.text ? declaration.rest : system
  }
  if (!Array.isArray(system)) return system
  const index = declaration.normalizedBlock
    ? system.indexOf(declaration.normalizedBlock)
    : system === declaration.source && system[declaration.index] === declaration.block
      ? declaration.index
      : -1
  if (index < 0 || textOf(system[index]) !== declaration.text) return system
  const out = system.slice()
  const block = out[index]
  if (!declaration.rest.trim()) out.splice(index, 1)
  else out[index] = typeof block === 'string' ? declaration.rest : { ...block, text: declaration.rest }
  return out
}

export function trackCallerSystemBlock(system, declaration) {
  if (!declaration || system !== declaration.source) return undefined
  const original = systemBlocks(system)[declaration.index]
  if (original !== declaration.block || textOf(original) !== declaration.text) return undefined
  return (block, index) => {
    if (index === declaration.index) declaration.normalizedBlock = block
  }
}

/** Caller tail only. Drops non-text blocks, cache_control and billing lines. */
export function callerSystemTail(system) {
  const parts = []
  for (const block of systemBlocks(system)) {
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
 * @param {{ preset?: 'official_full' | 'zero', officialPassthrough?: boolean, capabilities?: string[] }} [options]
 */
export function prepareCragPrintBody(
  body,
  { preset = 'official_full', officialPassthrough = false, capabilities } = {},
) {
  const out = { ...(body || {}) }
  const mode = preset === 'zero' ? 'replace' : 'append'
  delete out.system
  stripCallerPromptAlias(out)
  if (capabilities !== undefined && (!Array.isArray(capabilities) || !capabilities.includes(`prompt_${mode}`)))
    return out
  const tail = officialPassthrough ? '' : callerSystemTail(body?.system)
  if (!tail) return out
  if (mode === 'replace' && Buffer.byteLength(tail, 'utf8') > CRAG_PRINT_PROMPT_MAX_BYTES) {
    throw cragPromptTooLarge(Buffer.byteLength(tail, 'utf8'))
  }
  out.crag_prompt = { mode, text: tail }
  return out
}
