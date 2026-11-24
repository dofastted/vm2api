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
import { materializeAutomaticCache } from './cache-ttl.mjs'
import { isOnlyOfficialCliIdentitySystem, sanitizeSafeguardsForCrag } from './crag-whitelist.mjs'
import { normalizeImageContentBlocks } from './images.mjs'
import { needsCragProviderCompatibility } from './kernel-request.mjs'
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

function callerSystemBlocks(system) {
  const parts = []
  for (const block of systemBlocks(system)) {
    const text = textOf(block)
    if (!text) continue
    const kept = text
      .split('\n')
      .filter((line) => !BILLING_LINE.test(line.trim()))
      .join('\n')
      .trim()
    if (kept) {
      const part = { type: 'text', text: kept }
      if (block?.cache_control != null) part.cache_control = block.cache_control
      parts.push(part)
    }
  }
  return parts
}

/** Caller tail only. Drops non-text blocks, cache_control and billing lines. */
export function callerSystemTail(system) {
  return callerSystemBlocks(system)
    .map((block) => block.text)
    .join('\n\n')
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

// Unwrapped result items become top-level user blocks. CRAG takes text, image
// and document there; a ToolSearch tool_reference (or any other result-only
// block) is rejected as "unsupported native history block", so it goes to text.
const READ_ONLY_RESULT_TYPES = new Set(['text', 'image', 'document'])

function readOnlyResultBlock(item) {
  if (READ_ONLY_RESULT_TYPES.has(item?.type)) return item
  if (item?.type === 'tool_reference') return { type: 'text', text: `[tool_reference ${item.tool_name}]` }
  return { type: 'text', text: JSON.stringify(item) }
}

function readOnlySummaryResults(messages) {
  if (!Array.isArray(messages)) return messages
  const index = messages.findLastIndex((message) => message?.role === 'user')
  const message = messages[index]
  if (!Array.isArray(message?.content) || !message.content.some((block) => block?.type === 'tool_result'))
    return messages
  // A summary fork observes these results; sending their IDs as live results
  // would claim the parent's CRAG continuation, regardless of the new session ID.
  const content = message.content.flatMap((block) => {
    if (block?.type !== 'tool_result') return [block]
    const label = { type: 'text', text: `[tool result ${block.tool_use_id}${block.is_error ? ' (error)' : ''}]` }
    if (block.cache_control) label.cache_control = block.cache_control
    const result = typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : block.content || []
    return [label, ...result.map(readOnlyResultBlock)]
  })
  const out = messages.slice()
  out[index] = { ...message, content }
  // The calls those results answer must go read-only too: CRAG rejects a
  // history tool_use with no tool_result ("history tool_result set is incomplete").
  const ids = new Set(message.content.filter((block) => block?.type === 'tool_result').map((b) => b.tool_use_id))
  const callIndex = out.findLastIndex((m, i) => i < index && m?.role === 'assistant')
  const call = out[callIndex]
  if (Array.isArray(call?.content) && call.content.some((b) => b?.type === 'tool_use' && ids.has(b.id))) {
    out[callIndex] = {
      ...call,
      content: call.content.map((block) => {
        if (block?.type !== 'tool_use' || !ids.has(block.id)) return block
        const text = {
          type: 'text',
          text: `[tool call ${block.name} ${block.id}] ${JSON.stringify(block.input ?? {})}`,
        }
        if (block.cache_control) text.cache_control = block.cache_control
        return text
      }),
    }
  }
  return out
}

const SYSTEM_REMINDER_OPEN = '<system-reminder>'

function contentBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content : []
}

function reminderBlocks(message) {
  const out = []
  for (const block of contentBlocks(message?.content)) {
    const text = textOf(block)
    if (!text.trim()) continue
    const wrapped = text.trimStart().startsWith(SYSTEM_REMINDER_OPEN)
      ? text
      : `${SYSTEM_REMINDER_OPEN}\n${text}\n</system-reminder>`
    const part = { type: 'text', text: wrapped }
    if (block && typeof block === 'object' && block.cache_control != null) part.cache_control = block.cache_control
    out.push(part)
  }
  return out
}

function isEmptyText(block) {
  return block && typeof block === 'object' && block.type === 'text' && block.text === ''
}

/** Leading tool_result blocks must stay first in a user turn. */
function leadingToolResults(blocks) {
  let index = 0
  while (blocks[index]?.type === 'tool_result') index += 1
  return index
}

function prependAfterToolResults(blocks, extra) {
  const index = leadingToolResults(blocks)
  return [...blocks.slice(0, index), ...extra, ...blocks.slice(index)]
}

/** Moving a 1h marker behind a 5m / TTL-less one breaks Anthropic's TTL order. */
function invertsCacheTtl(moved, passed) {
  const long = moved.some((block) => block?.cache_control?.ttl === '1h')
  return long && passed.some((block) => block?.cache_control != null && block.cache_control.ttl !== '1h')
}

function hasOutputConfig(message) {
  return message?.output_config != null && typeof message.output_config === 'object'
}

/** Media has no reminder form, and `clear_at` acts where it stands. */
function foldable(message) {
  if (message?.clear_at != null) return false
  return contentBlocks(message?.content).every((block) => textOf(block) || isEmptyText(block))
}

/**
 * Claude Code adds `role: "system"` turns to the history (environment
 * updates, token counters, task notifications), usually one more per turn.
 * The CRAG worker replays history through `--resume`, and a history that
 * carries these turns is cached only up to tools + system on every request:
 * the whole conversation is written again each turn. Folding each one into
 * the adjacent user turn as a <system-reminder> keeps every earlier turn
 * byte-stable, so the previous turn's breakpoint is found again.
 *
 * A system turn joins the user turn before it; one that follows an assistant
 * turn joins the next user turn instead (after its tool_result blocks). Turns
 * with no user turn to join keep their original shape, as do turns carrying
 * media or `clear_at`, and turns whose move would invert cache TTL order.
 *
 * A folded turn's `output_config` governs the turns after it, so the last one
 * still in effect is returned as `outputConfig` for the top level.
 */
function foldSystemTurns(messages) {
  if (!Array.isArray(messages) || !messages.some((message) => message?.role === 'system'))
    return { messages, outputConfig: null }
  const out = []
  let pending = []
  let pendingSource = []
  let outputConfig = null
  const flush = () => {
    out.push(...pendingSource)
    if (pendingSource.some(hasOutputConfig)) outputConfig = null
    pending = []
    pendingSource = []
  }
  for (const message of messages) {
    if (message?.role === 'system' && !foldable(message)) {
      flush()
      out.push(message)
      if (hasOutputConfig(message)) outputConfig = null
      continue
    }
    if (message?.role === 'system') {
      const blocks = reminderBlocks(message)
      const previous = out.at(-1)
      if (!pending.length && !pendingSource.length && previous?.role === 'user') {
        if (blocks.length)
          out[out.length - 1] = {
            ...previous,
            content: [...contentBlocks(previous.content), ...blocks],
          }
        if (hasOutputConfig(message)) outputConfig = { ...outputConfig, ...message.output_config }
      } else {
        pending = pending.concat(blocks)
        pendingSource.push(message)
      }
      continue
    }
    if (pendingSource.length) {
      const content = contentBlocks(message?.content)
      if (message?.role === 'user' && !invertsCacheTtl(pending, content.slice(0, leadingToolResults(content)))) {
        out.push({
          ...message,
          content: prependAfterToolResults(content, pending),
        })
        for (const source of pendingSource)
          if (hasOutputConfig(source)) outputConfig = { ...outputConfig, ...source.output_config }
        pending = []
        pendingSource = []
      } else {
        flush()
        out.push(message)
      }
      if (hasOutputConfig(message)) outputConfig = null
      continue
    }
    if (hasOutputConfig(message)) outputConfig = null
    out.push(message)
  }
  flush()
  return { messages: out, outputConfig }
}

export function foldHistorySystemMessages(messages) {
  return foldSystemTurns(messages).messages
}

/**
 * An agent_summary fork ends with its instruction followed by token-budget
 * system turns; the summary is recognized by that instruction being the last
 * user text. Fold the shared history (so it matches the parent's prefix) but
 * leave the trailing system run where the fork sent it.
 */
function foldSummarySystemTurns(messages) {
  if (!Array.isArray(messages)) return { messages, outputConfig: null }
  let end = messages.length
  while (end > 0 && messages[end - 1]?.role === 'system') end -= 1
  if (end === messages.length) return foldSystemTurns(messages)
  const head = messages.slice(0, end)
  const tail = messages.slice(end)
  const folded = foldSystemTurns(head)
  if (folded.messages === head) return { messages, outputConfig: null }
  // A trailing turn's own output_config overrides anything lifted from the head.
  const outputConfig = tail.some(hasOutputConfig) ? null : folded.outputConfig
  return { messages: [...folded.messages, ...tail], outputConfig }
}

/**
 * @param {object} body caller body, before cli-node persona injection
 * @param {{ preset?: 'official_full' | 'zero', officialPassthrough?: boolean, capabilities?: string[], agentSummary?: boolean, foldSystemMessages?: boolean }} [options]
 */
export function prepareCragPrintBody(
  body,
  {
    preset = 'official_full',
    officialPassthrough = false,
    capabilities,
    agentSummary = false,
    foldSystemMessages = true,
  } = {},
) {
  // The CRAG kernel reads block markers only and 400s on a top-level
  // cache_control. Convert it here, before any early return, so every path out
  // of this function hands the kernel the standard shape.
  const out = materializeAutomaticCache({ ...(body || {}) })
  if (out.safeguards !== undefined) {
    const sg = sanitizeSafeguardsForCrag(out.safeguards, capabilities)
    if (sg.value === undefined) delete out.safeguards
    else out.safeguards = sg.value
  }
  const nativeV3 = Array.isArray(capabilities) && capabilities.includes('generation_controls_v3')
  if (nativeV3 && Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      const content = normalizeImageContentBlocks(message?.content, { inlineOnly: true })
      return content === message?.content ? message : { ...message, content }
    })
  }
  if (agentSummary) out.messages = readOnlySummaryResults(out.messages)
  if (needsCragProviderCompatibility(out, capabilities)) {
    stripCallerPromptAlias(out)
    return out
  }
  if (foldSystemMessages) {
    const folded = agentSummary ? foldSummarySystemTurns(out.messages) : foldSystemTurns(out.messages)
    out.messages = folded.messages
    if (folded.outputConfig)
      out.output_config = {
        ...(out.output_config || {}),
        ...folded.outputConfig,
      }
  }
  const mode = preset === 'zero' ? 'replace' : 'append'
  delete out.system
  stripCallerPromptAlias(out)
  if (capabilities !== undefined && (!Array.isArray(capabilities) || !capabilities.includes(`prompt_${mode}`)))
    return out
  const textCache = nativeV3 && capabilities.includes('system_text_cache_v3')
  if (
    nativeV3 &&
    !officialPassthrough &&
    Array.isArray(body?.system) &&
    body.system.some(
      (block) =>
        typeof block !== 'string' &&
        (!block ||
          block.type !== 'text' ||
          typeof block.text !== 'string' ||
          Object.keys(block).some((key) => !['type', 'text'].includes(key) && !(textCache && key === 'cache_control'))),
    )
  ) {
    const message =
      'CRAG V3 native system prompts support text only; structured system metadata requires isolated provider execution'
    throw Object.assign(new Error(message), {
      status: 400,
      code: 'unsupported_capability',
      body: {
        type: 'error',
        error: {
          type: 'unsupported_capability',
          code: 'unsupported_capability',
          message,
          details: { retryable: false },
        },
      },
    })
  }
  const skipRelocatedPlaceholder = !officialPassthrough && isOnlyOfficialCliIdentitySystem(body?.system)
  const tail = officialPassthrough || skipRelocatedPlaceholder ? '' : callerSystemTail(body?.system)
  if (!tail) return out
  if (textCache && mode === 'append') {
    out.system = body.system
    return out
  }
  if (!nativeV3 && mode === 'replace' && Buffer.byteLength(tail, 'utf8') > CRAG_PRINT_PROMPT_MAX_BYTES) {
    throw cragPromptTooLarge(Buffer.byteLength(tail, 'utf8'))
  }
  out.crag_prompt = { mode, text: tail }
  if (textCache) {
    const blocks = callerSystemBlocks(body?.system)
    if (blocks.some((block) => block.cache_control != null)) out.crag_prompt.blocks = blocks
  }
  return out
}
