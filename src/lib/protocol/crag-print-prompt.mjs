/**
 * CRAG v2 print worker (claude-code-2.1.321) does not read kernel.json
 * persona_preset or CLAUDE_CODE_SYSTEM_LAYOUT. Bare `system` is append.
 * official_full must not resend the official four blocks. zero must be
 * crag_prompt.mode=replace. --bare is not used: it drops OAuth.
 * Print keeps builtin tools and Chrome; --tools "" / --no-chrome are TUI-only.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  isHeadlessBridgeCaps,
  normalizeCragKernelVersion,
  normalizeKernelDataplane,
  normalizeSlotPersonaPreset,
} from '../vm/slot-engine.mjs'
import { CRS_OFFICIAL_CLI_SYSTEM, renderCragCustomSystemBlocks } from '../identity/crs-persona.mjs'
import { canonicalPersonaCompat, templatePresetFor } from '../identity/persona-template.mjs'
import {
  CLI_IDENTITY,
  cragEnvFromSpec,
  isOfficialIdentityText,
  isPromptSpecV1Caps,
  normalizeUnifiedPreset,
  resolveGlobalUnifiedPreset,
  resolveSystemPromptSpec,
  sanitizePromptSpec,
} from '../identity/system-prompt-spec.mjs'
import { DEFAULT_CACHE_TTL, materializeAutomaticCache, repairCacheBreakpoints } from './cache-ttl.mjs'
import {
  cragV4TemplateCacheBreakpoints,
  isOnlyOfficialCliIdentitySystem,
  sanitizeCragEnv,
  sanitizeSafeguardsForCrag,
} from './crag-whitelist.mjs'
import { normalizeImageContentBlocks } from './images.mjs'
import { needsCragProviderCompatibility } from './kernel-request.mjs'
import { isEmptyEffortValue } from './log-fields.mjs'
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
const EMPTY_REPLACE_CAPS = Object.freeze(['prompt_replace_empty', 'prompt_replace_empty_v3'])

/**
 * Check whether the CRAG worker advertises explicit empty `replace:""` support
 * (CRAG 3.1.25+ `prompt_replace_empty` / `prompt_replace_empty_v3`).
 */
export function cragSupportsEmptyReplace(capabilities, health = null) {
  if (Array.isArray(capabilities) && capabilities.some((cap) => EMPTY_REPLACE_CAPS.includes(cap))) {
    return true
  }
  if (Array.isArray(health?.capabilities) && health.capabilities.some((cap) => EMPTY_REPLACE_CAPS.includes(cap))) {
    return true
  }
  return false
}

export function cragEmptyReplaceUnsupportedError() {
  const message =
    'CRAG worker lacks prompt_replace_empty capability and is not statically configured as zero persona; refusing to silently fall back to official prompt'
  const error = new Error(message)
  error.status = 503
  error.code = 'crag_prompt_replace_empty_unsupported'
  error.body = {
    type: 'error',
    error: {
      type: 'overloaded_error',
      code: 'crag_prompt_replace_empty_unsupported',
      message,
      details: { retryable: false },
    },
  }
  return error
}

export function normalizeCragPersonaPreset(value) {
  return normalizeUnifiedPreset(value, 'official_full')
}

/**
 * Unified SSOT preset resolver for CRAG (matches `resolveSlotPersonaPreset`):
 * slot `vm.persona_preset` > global `compatibility.persona_preset` > legacy fallback.
 */
export function resolveCragPrintPersona(vm, routing = {}) {
  const slot = normalizeSlotPersonaPreset(vm?.persona_preset, { inherit: true })
  if (slot) return normalizeUnifiedPreset(slot, 'official_full')
  return resolveGlobalUnifiedPreset(routing)
}

function explicitSlotTemplatePreset(vm) {
  const raw = String(vm?.persona_preset ?? '')
    .trim()
    .toLowerCase()
  if (!raw || raw === 'inherit' || raw === 'global' || raw === 'default') return ''
  if (raw === 'custom' || raw === 'diy' || raw === 'manual') return 'custom'
  const slot = normalizeSlotPersonaPreset(vm?.persona_preset, { inherit: true })
  return slot ? templatePresetFor(slot) : ''
}

/**
 * Resolve an explicit panel custom template override for `headless_claude_bridge_v1`.
 * Returns `{ preset, blocks }` only when a non-empty `persona_templates[key]` is
 * configured for the active slot/routing preset; returns `null` to use unified
 * preset compilation (`official`, `official_full`, `zero`).
 */
export function resolveCragCustomTemplate(vm, routing = {}, preset = null) {
  if (!routing || typeof routing !== 'object') return null
  const compat = canonicalPersonaCompat(routing?.compatibility || {})
  const templates = compat?.persona_templates
  if (!templates || typeof templates !== 'object' || Array.isArray(templates)) return null
  const has = (key) => Array.isArray(templates[key]) && templates[key].length > 0
  const slotPreset = explicitSlotTemplatePreset(vm)
  if (slotPreset) {
    return has(slotPreset) ? { preset: slotPreset, blocks: templates[slotPreset] } : null
  }
  if (preset != null) {
    const explicit = normalizeUnifiedPreset(preset, 'official_full')
    if (has(explicit)) return { preset: explicit, blocks: templates[explicit] }
  }
  const globalPreset = resolveGlobalUnifiedPreset(routing)
  return has(globalPreset) ? { preset: globalPreset, blocks: templates[globalPreset] } : null
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

function stripBillingAndOfficialIdentityForZero(system) {
  if (system == null) return undefined
  if (typeof system === 'string') {
    const cleaned = system
      .split('\n')
      .filter((line) => !BILLING_LINE.test(line.trim()))
      .join('\n')
    if (!cleaned.trim() || isOfficialIdentityText(cleaned)) return undefined
    return cleaned
  }
  if (!Array.isArray(system)) return system
  const kept = []
  for (const block of system) {
    if (typeof block === 'string') {
      const cleaned = block
        .split('\n')
        .filter((line) => !BILLING_LINE.test(line.trim()))
        .join('\n')
      if (!cleaned.trim() || isOfficialIdentityText(cleaned)) continue
      kept.push(cleaned)
      continue
    }
    if (block && typeof block === 'object' && typeof block.text === 'string') {
      const cleaned = block.text
        .split('\n')
        .filter((line) => !BILLING_LINE.test(line.trim()))
        .join('\n')
      if (!cleaned.trim() || isOfficialIdentityText(cleaned)) continue
      kept.push(cleaned === block.text ? block : { ...block, text: cleaned })
      continue
    }
    if (block != null) kept.push(block)
  }
  return kept.length ? kept : undefined
}

function stripCallerPromptAlias(body) {
  delete body.crag_prompt
  delete body.crag_prompt_spec
  delete body.prompt_spec
  delete body.crag_persona_preset
  delete body.crag_prompt_version
  delete body.crag_env
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

function hasCacheControl(message) {
  if (message?.cache_control != null) return true
  return contentBlocks(message?.content).some((block) => block?.cache_control != null)
}

function hasOutputConfig(message) {
  return message?.output_config != null && typeof message.output_config === 'object'
}

function mergeFoldedOutputConfig(base, next) {
  if (!next || typeof next !== 'object') return base
  const merged = { ...(base || {}), ...next }
  if (Object.prototype.hasOwnProperty.call(next, 'effort') && isEmptyEffortValue(next.effort)) {
    if (base && Object.prototype.hasOwnProperty.call(base, 'effort')) merged.effort = base.effort
    else delete merged.effort
  }
  return Object.keys(merged).length ? merged : base
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
        if (hasOutputConfig(message)) outputConfig = mergeFoldedOutputConfig(outputConfig, message.output_config)
      } else {
        pending = pending.concat(blocks)
        pendingSource.push(message)
      }
      continue
    }
    if (pendingSource.length) {
      const content = contentBlocks(message?.content)
      const toolResults = leadingToolResults(content)
      // A post-assistant system turn carrying cache_control was emitted as a trailing
      // system turn on the previous request; folding it forward into a subsequent plain
      // user turn would mutate that cached message's role from system -> user (#2007).
      const keepsCachedPrefix = toolResults === 0 && pendingSource.some(hasCacheControl)
      if (message?.role === 'user' && !keepsCachedPrefix && !invertsCacheTtl(pending, content.slice(0, toolResults))) {
        out.push({
          ...message,
          content: prependAfterToolResults(content, pending),
        })
        for (const source of pendingSource)
          if (hasOutputConfig(source)) outputConfig = mergeFoldedOutputConfig(outputConfig, source.output_config)
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

function applyPoolSystemForCrag(callerSystem, promptPolicy, officialPassthrough) {
  if (!promptPolicy?.applies) return callerSystem
  const poolText = typeof promptPolicy.text === 'string' ? promptPolicy.text : ''
  const poolBlocks = poolText ? [{ type: 'text', text: poolText }] : []
  if (promptPolicy.mode === 'append') {
    const baseCaller = !officialPassthrough && isOnlyOfficialCliIdentitySystem(callerSystem) ? undefined : callerSystem
    if (!poolBlocks.length) return baseCaller
    if (officialPassthrough) return poolBlocks
    const clientBlocks = systemBlocks(baseCaller)
      .map((b) =>
        typeof b === 'string' ? (b ? { type: 'text', text: b } : null) : b && typeof b === 'object' ? { ...b } : null,
      )
      .filter(Boolean)
    return [...clientBlocks, ...poolBlocks]
  }
  if (promptPolicy.mode === 'override') {
    const policy = String(promptPolicy.clientSystemPolicy || 'prepend_pool')
      .trim()
      .toLowerCase()
    if (policy === 'replace_client') return poolBlocks
    const clientBlocks = systemBlocks(callerSystem)
      .map((b) =>
        typeof b === 'string' ? (b ? { type: 'text', text: b } : null) : b && typeof b === 'object' ? { ...b } : null,
      )
      .filter(Boolean)
    if (policy === 'append_pool') return [...clientBlocks, ...poolBlocks]
    return [...poolBlocks, ...clientBlocks]
  }
  return callerSystem
}

function toSpecCustomBlocks(action, blocks) {
  return {
    action,
    blocks: (Array.isArray(blocks) ? blocks : [])
      .filter((b) => b && typeof b === 'object' && typeof b.text === 'string')
      .map((b) => ({
        type: 'text',
        text: b.text,
        cache_control: b.cache_control && typeof b.cache_control === 'object' ? { ...b.cache_control } : null,
      })),
  }
}

function budgetLegacyCragV4OfficialTemplateCache(
  body,
  capabilities,
  health = null,
  { routing = null, cacheTtl = null } = {},
) {
  const reserved = cragV4TemplateCacheBreakpoints(body, capabilities, health)
  if (reserved <= 0) return body
  const totalLimit = Number(routing?.compatibility?.cache_control_limit) || 4
  return repairCacheBreakpoints(body, {
    limit: Math.max(0, totalLimit - reserved),
    fallbackTtl: cacheTtl || body?.cache_ttl || DEFAULT_CACHE_TTL,
    fillMissing: false,
  })
}

/**
 * @param {object} body caller body, before cli-node persona injection
 * @param {{ preset?: 'official' | 'official_full' | 'zero' | 'custom', promptSpec?: object | null, officialPassthrough?: boolean, capabilities?: string[], health?: object | null, promptPolicy?: object | null, agentSummary?: boolean, foldSystemMessages?: boolean }} [options]
 */
export function prepareCragPrintBody(
  body,
  {
    preset = 'official_full',
    promptSpec = null,
    officialPassthrough = false,
    strictPassthrough = false,
    capabilities,
    health = null,
    promptPolicy = null,
    agentSummary = false,
    foldSystemMessages = true,
    routing = null,
    vm = null,
    identity = null,
    sessionId = '',
    entrypoint = 'cli',
    cacheTtl = null,
  } = {},
) {
  if (strictPassthrough) {
    const out = { ...(body || {}) }
    stripCallerPromptAlias(out)
    if (isHeadlessBridgeCaps(capabilities) && isPromptSpecV1Caps(capabilities, health)) {
      const cleanSpec =
        sanitizePromptSpec(promptSpec) ||
        resolveSystemPromptSpec({
          routing: routing || {},
          slot: vm,
          poolPolicy: promptPolicy?.applies ? promptPolicy : null,
          identity,
          officialPassthrough: true,
          strictPassthrough: true,
          relocateCallerSystem: false,
        })
      if (cleanSpec) out.crag_prompt_spec = { ...cleanSpec, passthrough: true }
    }
    return out
  }
  // The CRAG kernel reads block markers only and 400s on a top-level
  // cache_control. Convert it here, before any early return, so every path out
  // of this function hands the kernel the standard shape.
  const out = body?.cache_control != null ? materializeAutomaticCache({ ...(body || {}) }) : { ...(body || {}) }
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
  const poolApplied = Boolean(promptPolicy?.applies)
  const headlessBridge = isHeadlessBridgeCaps(capabilities)
  const promptSpecV1 = isPromptSpecV1Caps(capabilities, health)
  const effectivePreset = normalizeCragPersonaPreset(preset)
  if (headlessBridge) {
    // Still enforce fail-closed provider-managed tool capability checks.
    const providerCompat = needsCragProviderCompatibility(out, capabilities)
    stripCallerPromptAlias(out)
    const spec =
      sanitizePromptSpec(promptSpec) ||
      resolveSystemPromptSpec({
        routing: routing || {},
        slot: vm,
        poolPolicy: poolApplied ? promptPolicy : null,
        identity,
        officialPassthrough,
        strictPassthrough: false,
        modeOverride: poolApplied ? null : effectivePreset,
      })
    const attachSpecEnv = (targetSpec) => {
      const env = sanitizeCragEnv(cragEnvFromSpec(targetSpec))
      if (env) out.crag_env = env
    }
    const attachPromptSpec = (targetSpec) => {
      if (!promptSpecV1) return
      const clean = sanitizePromptSpec(targetSpec)
      if (clean) out.crag_prompt_spec = clean
    }

    // Explicit pool prompt policy takes precedence over legacy persona presets.
    if (poolApplied && promptPolicy.mode !== 'official') {
      if (promptPolicy.mode === 'passthrough') {
        attachPromptSpec({ ...spec, passthrough: true })
        return out
      }
      if (promptPolicy.mode === 'zero_inject') {
        const cleanedZeroSystem = stripBillingAndOfficialIdentityForZero(out.system)
        if (cleanedZeroSystem === undefined) delete out.system
        else out.system = cleanedZeroSystem
        out.crag_persona_preset = 'zero'
        out.crag_prompt_version = CLI_IDENTITY
        attachPromptSpec(spec)
        return out
      }
      if (promptPolicy.mode === 'override') {
        const cleanedCallerSystem = stripBillingAndOfficialIdentityForZero(body?.system)
        const poolBlocks = applyPoolSystemForCrag(cleanedCallerSystem, promptPolicy, false)
        const normalizedBlocks = Array.isArray(poolBlocks) ? poolBlocks : []
        if (providerCompat) {
          if (normalizedBlocks.length) out.system = normalizedBlocks
          else delete out.system
        } else {
          delete out.system
          out.crag_prompt = normalizedBlocks.length
            ? { mode: 'replace', blocks: normalizedBlocks }
            : { mode: 'replace', text: '' }
        }
        // CRAG 3.1.26+ runtime requires zero persona so the official template is not prepended.
        out.crag_persona_preset = 'zero'
        out.crag_prompt_version = CLI_IDENTITY
        attachPromptSpec({ ...spec, custom_blocks: toSpecCustomBlocks('replace', normalizedBlocks) })
        return out
      }
      if (promptPolicy.mode === 'append') {
        if (officialPassthrough) {
          const appendedBlocks = applyPoolSystemForCrag(body?.system, promptPolicy, true)
          if (Array.isArray(appendedBlocks) && appendedBlocks.length) {
            out.system = appendedBlocks
          }
          attachPromptSpec({ ...spec, passthrough: true })
          return out
        }
        const customTemplate = resolveCragCustomTemplate(vm, routing, spec.mode)
        if (customTemplate) {
          const appendedBlocks = applyPoolSystemForCrag(body?.system, promptPolicy, false)
          if (Array.isArray(appendedBlocks) && appendedBlocks.length) {
            out.system = appendedBlocks
          } else if (isOnlyOfficialCliIdentitySystem(out.system)) {
            delete out.system
          }
          const {
            blocks,
            promptVersion,
            messages: renderedMessages,
          } = renderCragCustomSystemBlocks(out, {
            preset: customTemplate.preset,
            routing,
            identity,
            sessionId,
            entrypoint,
            cacheTtl,
          })
          if (Array.isArray(renderedMessages)) out.messages = renderedMessages
          if (providerCompat) {
            if (blocks.length) out.system = blocks
            else delete out.system
          } else {
            delete out.system
            out.crag_prompt = { mode: 'replace', blocks }
          }
          if (promptVersion) out.crag_prompt_version = promptVersion
          attachPromptSpec({ ...spec, custom_blocks: toSpecCustomBlocks('replace', blocks) })
          return out
        }
        if (promptSpecV1) {
          // CRAG V4 prompt_spec_v1: keep out.system free of promptPolicy.text (still stripping
          // relocated [CLI_IDENTITY] placeholder) and let crag_prompt_spec.custom_blocks carry it once.
          if (isOnlyOfficialCliIdentitySystem(out.system)) delete out.system
          const appendCustom =
            spec.custom_blocks ||
            (typeof promptPolicy.text === 'string' && promptPolicy.text
              ? toSpecCustomBlocks('append', [{ type: 'text', text: promptPolicy.text }])
              : null)
          const finalSpec = { ...spec, custom_blocks: appendCustom }
          out.crag_persona_preset = spec.mode === 'official' ? 'official' : 'official_full'
          attachPromptSpec(finalSpec)
          attachSpecEnv(finalSpec)
          return out
        }
        if (spec.mode === 'official') {
          // Legacy CRAG fallback without prompt_spec_v1: render Mode 1 minimal blocks from pre-pool
          // body (without promptPolicy.text mixed into out.system), then append promptPolicy.text once.
          if (isOnlyOfficialCliIdentitySystem(out.system)) delete out.system
          const { blocks, messages: renderedMessages } = renderCragCustomSystemBlocks(out, {
            preset: 'official',
            routing,
            identity,
            sessionId,
            entrypoint,
            cacheTtl,
          })
          if (Array.isArray(renderedMessages)) out.messages = renderedMessages
          const finalBlocks =
            typeof promptPolicy.text === 'string' && promptPolicy.text
              ? [...blocks, { type: 'text', text: promptPolicy.text }]
              : blocks
          if (providerCompat) {
            if (finalBlocks.length) out.system = finalBlocks
            else delete out.system
          } else {
            delete out.system
            out.crag_prompt = { mode: 'replace', blocks: finalBlocks }
          }
          attachSpecEnv(spec)
          return out
        }
        // Legacy CRAG (headless_claude_bridge_v1 without prompt_spec_v1) official_full:
        // pass appendedBlocks via out.system since legacy CRAG does not read crag_prompt_spec.
        const appendedBlocks = applyPoolSystemForCrag(body?.system, promptPolicy, false)
        if (Array.isArray(appendedBlocks) && appendedBlocks.length) {
          out.system = appendedBlocks
        } else if (isOnlyOfficialCliIdentitySystem(out.system)) {
          delete out.system
        }
        out.crag_persona_preset = 'official_full'
        attachSpecEnv(spec)
        return budgetLegacyCragV4OfficialTemplateCache(out, capabilities, health, { routing, cacheTtl })
      }
    }
    // Priority 1: Native CC passthrough never touches system[] or injects persona/prompt/env controls.
    // Headless bridge also never folds mid-conversation role:"system" turns.
    if (officialPassthrough || spec.passthrough) {
      attachPromptSpec({ ...spec, passthrough: true })
      return out
    }
    // Priority 2: Explicit panel custom template override or Mode `custom` -> direct replace blocks.
    const customTemplate = resolveCragCustomTemplate(vm, routing, spec.mode)
    if (customTemplate || spec.mode === 'custom') {
      const targetPreset = customTemplate ? customTemplate.preset : 'custom'
      const {
        blocks,
        promptVersion,
        messages: renderedMessages,
      } = renderCragCustomSystemBlocks(out, {
        preset: targetPreset,
        routing,
        identity,
        sessionId,
        entrypoint,
        cacheTtl,
      })
      if (Array.isArray(renderedMessages)) out.messages = renderedMessages
      if (providerCompat) {
        if (blocks.length) out.system = blocks
        else delete out.system
      } else {
        delete out.system
        out.crag_prompt = { mode: 'replace', blocks }
      }
      if (promptVersion) out.crag_prompt_version = promptVersion
      if (promptSpecV1 && spec.mode === 'custom') out.crag_persona_preset = 'custom'
      attachPromptSpec({ ...spec, custom_blocks: toSpecCustomBlocks('replace', blocks) })
      return out
    }
    // Priority 3: Mode 3 (`zero`, no custom template) -> 0-inject with prompt_version = CLI_IDENTITY.
    // Strip billing lines and all official identity blocks while preserving caller business system verbatim.
    if (spec.mode === 'zero') {
      const cleanedZeroSystem = stripBillingAndOfficialIdentityForZero(out.system)
      if (cleanedZeroSystem === undefined) delete out.system
      else out.system = cleanedZeroSystem
      out.crag_persona_preset = 'zero'
      out.crag_prompt_version = CLI_IDENTITY
      attachPromptSpec(spec)
      return out
    }
    // Priority 4: Mode 1 (`official` — identity-only by default, toggles for core/guidance/env).
    if (spec.mode === 'official') {
      if (promptSpecV1) {
        if (isOnlyOfficialCliIdentitySystem(out.system)) delete out.system
        out.crag_persona_preset = 'official'
        attachPromptSpec(spec)
        attachSpecEnv(spec)
        return out
      }
      // Legacy CRAG V4 fallback (no prompt_spec_v1): compile Mode 1 blocks directly via crag_prompt replace.
      const { blocks, messages: renderedMessages } = renderCragCustomSystemBlocks(out, {
        preset: 'official',
        routing,
        identity,
        sessionId,
        entrypoint,
        cacheTtl,
      })
      if (Array.isArray(renderedMessages)) out.messages = renderedMessages
      if (providerCompat) {
        if (blocks.length) out.system = blocks
        else delete out.system
      } else {
        delete out.system
        out.crag_prompt = { mode: 'replace', blocks }
      }
      attachSpecEnv(spec)
      return out
    }
    // Priority 5: Mode 2 (`official_full`, no custom template) -> CRAG prepends probed official template.
    // Strip the 1-line placeholder left by relocateThirdPartySystem so CRAG V4 wire.rs
    // (`!caller_starts_with_official_identity`) actually prepends tui_system_template.
    if (isOnlyOfficialCliIdentitySystem(out.system)) delete out.system
    out.crag_persona_preset = 'official_full'
    attachPromptSpec(spec)
    attachSpecEnv(spec)
    return budgetLegacyCragV4OfficialTemplateCache(out, capabilities, health, { routing, cacheTtl })
  }
  if (needsCragProviderCompatibility(out, capabilities)) {
    if (poolApplied && (promptPolicy.mode === 'override' || promptPolicy.mode === 'append')) {
      out.system = applyPoolSystemForCrag(body?.system, promptPolicy, officialPassthrough)
    }
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
  if (poolApplied && promptPolicy.mode === 'passthrough') {
    stripCallerPromptAlias(out)
    return out
  }
  const mode = poolApplied
    ? promptPolicy.mode === 'zero_inject' || promptPolicy.mode === 'override'
      ? 'replace'
      : 'append'
    : preset === 'zero'
      ? 'replace'
      : 'append'
  const effectiveOfficialPassthrough = poolApplied
    ? promptPolicy.mode === 'official'
      ? officialPassthrough
      : false
    : officialPassthrough
  const effectiveSystem = poolApplied
    ? applyPoolSystemForCrag(body?.system, promptPolicy, officialPassthrough)
    : body?.system
  const healthPreset = String(health?.persona_preset || '')
    .trim()
    .toLowerCase()
  const staticZeroHealth = healthPreset === 'zero'
  const staticNonZeroHealth = Boolean(healthPreset && healthPreset !== 'zero')

  delete out.system
  stripCallerPromptAlias(out)
  if (capabilities !== undefined && (!Array.isArray(capabilities) || !capabilities.includes(`prompt_${mode}`))) {
    if (mode === 'replace' && poolApplied && !staticZeroHealth) {
      throw cragEmptyReplaceUnsupportedError()
    }
    return out
  }
  const textCache = nativeV3 && capabilities.includes('system_text_cache_v3')
  if (
    nativeV3 &&
    !effectiveOfficialPassthrough &&
    Array.isArray(effectiveSystem) &&
    effectiveSystem.some(
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
  const skipRelocatedPlaceholder =
    !effectiveOfficialPassthrough &&
    (!poolApplied || promptPolicy.mode === 'official' || promptPolicy.mode === 'append') &&
    isOnlyOfficialCliIdentitySystem(effectiveSystem)
  const tail = effectiveOfficialPassthrough || skipRelocatedPlaceholder ? '' : callerSystemTail(effectiveSystem)
  if (!tail) {
    if (!effectiveOfficialPassthrough && mode === 'replace') {
      if (cragSupportsEmptyReplace(capabilities, health)) {
        out.crag_prompt = { mode: 'replace', text: '' }
        return out
      }
      if (skipRelocatedPlaceholder || staticZeroHealth) {
        return out
      }
      // Fail-Closed whenever an explicit pool policy requires zero/replace OR
      // worker health advertises a non-zero static persona, so we never
      // silently fall back to the official prompt.
      if (poolApplied || staticNonZeroHealth) {
        throw cragEmptyReplaceUnsupportedError()
      }
    }
    return out
  }
  if (!nativeV3 && poolApplied && (promptPolicy.mode === 'override' || promptPolicy.mode === 'append')) {
    const poolBytes = Buffer.byteLength(String(promptPolicy.text || ''), 'utf8')
    if (poolBytes > CRAG_PRINT_PROMPT_MAX_BYTES) throw cragPromptTooLarge(poolBytes)
  }
  if (textCache && mode === 'append') {
    out.system = effectiveSystem
    return out
  }
  if (!nativeV3 && mode === 'replace' && Buffer.byteLength(tail, 'utf8') > CRAG_PRINT_PROMPT_MAX_BYTES) {
    throw cragPromptTooLarge(Buffer.byteLength(tail, 'utf8'))
  }
  out.crag_prompt = { mode, text: tail }
  if (textCache) {
    const blocks = callerSystemBlocks(effectiveSystem)
    if (blocks.some((block) => block.cache_control != null)) out.crag_prompt.blocks = blocks
  }
  return out
}
