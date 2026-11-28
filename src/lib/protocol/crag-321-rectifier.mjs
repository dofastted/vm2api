/**
 * Claude Code 2.1.321 / CRAG structural protocol rectifier (SSOT).
 *
 * Enforces Anthropic upstream & CRAG 3.1.30+ wire invariants at the final CRAG
 * boundary — for BOTH standard/third-party traffic AND `strictPassthrough`
 * (official clients whose Claude Code version may differ from the bundled
 * 2.1.321 runtime).
 *
 * Design guarantees:
 *   1. Zero-mutation fast path: when `body` already conforms to 2.1.321 rules,
 *      returns the exact `body` reference untouched (preserving cache prefixes,
 *      continuation hashes, and official forward-compatible extension fields).
 *   2. Repair over rejection: illegal/version-skewed structures are reshaped
 *      into legal 2.1.321 equivalents instead of leaking 400s to CRAG/Anthropic.
 *   3. Pure & idempotent: never mutates caller inputs; calling twice hits the
 *      zero-mutation fast path on the second pass.
 */
import { repairCacheBreakpoints } from './cache-ttl.mjs'
import { isEmptyEffortValue } from './log-fields.mjs'
import { CONTINUE_USER_TEXT, ensureOutputConfigSchema } from './request-rectifier.mjs'
import { anthropicContentIsEmpty, messageHasTurnControls, stripIllegalContentFields } from './sanitize.mjs'

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const POSITIVE_INT_STR = /^\s*[1-9]\d*\s*$/
const LEGACY_NO_PER_MESSAGE_EFFORT_RE =
  /^claude-(?:(?:3|4)(?:[-.]|$)|(?:opus|sonnet|haiku)-4(?:[-.]|$)|(?:fable|mythos|sonnet|haiku)-5(?:-20\d{6}|$))/
const PER_MESSAGE_EFFORT_MODEL_RE =
  /^claude-(?:(?:fable|mythos)-5[-.](?:1|2)|opus-5(?:[-.]5)?|(?:sonnet|haiku)-5[-.]5)(?:-|$)/

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isToolChangeBlock(block) {
  return isPlainObject(block) && (block.type === 'tool_addition' || block.type === 'tool_removal')
}

function isLiftableSystemTextBlock(block) {
  if (typeof block === 'string') return true
  if (!isPlainObject(block)) return false
  return (
    typeof block.text === 'string' &&
    (block.type == null || block.type === 'text' || block.type === 'input_text' || block.type === 'output_text')
  )
}

function isInlineToolDefinitionBlock(block) {
  return (
    isPlainObject(block) &&
    block.type === 'tool_addition' &&
    isPlainObject(block.tool) &&
    block.tool.type === 'tool_definition' &&
    isPlainObject(block.tool.definition) &&
    typeof block.tool.definition.name === 'string' &&
    block.tool.definition.name.length > 0
  )
}

function asContentBlocks(content) {
  if (content == null) return []
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content : []
}

function modelRejectsPerMessageEffort(modelId = '', { strictPassthrough = false } = {}) {
  const id = String(modelId || '')
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/i, '')
  if (!id) return false
  if (PER_MESSAGE_EFFORT_MODEL_RE.test(id)) return false
  if (strictPassthrough) return LEGACY_NO_PER_MESSAGE_EFFORT_RE.test(id)
  return true
}

/**
 * Anthropic allows non-directive `role: "system"` immediately after a `user`
 * message or an `assistant` message ending in a server tool result
 * (`*_tool_result`, excluding client `tool_result`).
 */
export function isAssistantEndingInServerToolResult(message) {
  if (!isPlainObject(message) || message.role !== 'assistant') return false
  if (!Array.isArray(message.content) || message.content.length === 0) return false
  const last = message.content[message.content.length - 1]
  const type = typeof last?.type === 'string' ? last.type : ''
  return type !== 'tool_result' && type.endsWith('_tool_result')
}

function hasNonEmptyOutputConfig(config) {
  return isPlainObject(config) && Object.keys(config).length > 0
}

function isDirectiveOnlySystemMessage(message) {
  return (
    isPlainObject(message) &&
    message.role === 'system' &&
    anthropicContentIsEmpty(message.content) &&
    hasNonEmptyOutputConfig(message.output_config)
  )
}

function normalizeEffortValue(value) {
  if (value == null || isEmptyEffortValue(value)) return null
  const normalized = String(value).trim().toLowerCase()
  return VALID_EFFORTS.has(normalized) ? normalized : null
}

function outputConfigNeedsFix(config) {
  if (config === undefined) return false
  if (!isPlainObject(config)) return true
  if (Object.keys(config).length === 0) return true
  if (Object.hasOwn(config, 'effort')) {
    const normalized = normalizeEffortValue(config.effort)
    if (normalized === null || normalized !== config.effort) return true
  }
  return false
}

function sanitizeOutputConfigValue(config) {
  if (!isPlainObject(config)) return undefined
  let out = config
  if (Object.hasOwn(config, 'effort')) {
    const normalized = normalizeEffortValue(config.effort)
    if (normalized === null) {
      const { effort: _dropped, ...rest } = config
      out = rest
    } else if (normalized !== config.effort) {
      out = { ...config, effort: normalized }
    }
  }
  return Object.keys(out).length ? out : undefined
}

function thinkingNeedsFix(thinking) {
  if (!isPlainObject(thinking) || thinking.type !== 'enabled') return false
  if (Object.hasOwn(thinking, 'budgetTokens')) return true
  if (typeof thinking.budget_tokens === 'string' && POSITIVE_INT_STR.test(thinking.budget_tokens)) return true
  return false
}

function sanitizeThinkingValue(thinking) {
  if (!thinkingNeedsFix(thinking)) return thinking
  const next = { ...thinking }
  const legacy = next.budgetTokens
  delete next.budgetTokens
  let raw = next.budget_tokens ?? legacy
  if (typeof raw === 'string' && POSITIVE_INT_STR.test(raw)) {
    raw = Number(raw.trim())
  }
  if (raw !== undefined) next.budget_tokens = raw
  return next
}

function blockHasAnnotations(block, depth = 0) {
  if (!isPlainObject(block) || depth > 4) return false
  if (Object.hasOwn(block, 'annotations')) return true
  if (block.type === 'tool_result' && Array.isArray(block.content)) {
    return block.content.some((child) => blockHasAnnotations(child, depth + 1))
  }
  return false
}

function objectSchemaNeedsFill(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return false
  if (Array.isArray(node)) return node.some((item) => objectSchemaNeedsFill(item, depth + 1))
  if (String(node.type || '').toLowerCase() === 'object' && node.additionalProperties == null) return true
  if (node.properties && typeof node.properties === 'object') {
    for (const value of Object.values(node.properties)) {
      if (objectSchemaNeedsFill(value, depth + 1)) return true
    }
  }
  if (node.items && objectSchemaNeedsFill(node.items, depth + 1)) return true
  if (node.schema && objectSchemaNeedsFill(node.schema, depth + 1)) return true
  if (node.format && typeof node.format === 'object' && objectSchemaNeedsFill(node.format, depth + 1)) return true
  if (Array.isArray(node.anyOf) && node.anyOf.some((item) => objectSchemaNeedsFill(item, depth + 1))) return true
  if (Array.isArray(node.oneOf) && node.oneOf.some((item) => objectSchemaNeedsFill(item, depth + 1))) return true
  return false
}

function needsStructuralRectification(body, { strictPassthrough = false } = {}) {
  if (!isPlainObject(body)) return false
  if (thinkingNeedsFix(body.thinking)) return true
  if (body.output_config !== undefined) {
    if (outputConfigNeedsFix(body.output_config)) return true
    if (objectSchemaNeedsFill(body.output_config)) return true
  }
  if (Array.isArray(body.system) && body.system.some((block) => blockHasAnnotations(block))) return true
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false

  const rejectsPerMessageEffort = modelRejectsPerMessageEffort(body.model, { strictPassthrough })
  let sawFirstNonDirective = false

  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i]
    if (!isPlainObject(msg)) return true
    if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system') return true
    if (msg.output_config !== undefined && outputConfigNeedsFix(msg.output_config)) return true

    if (Array.isArray(msg.content)) {
      if (msg.role !== 'system' && msg.content.some(isToolChangeBlock)) return true
      if (msg.content.some((block) => blockHasAnnotations(block))) return true
    }

    if (msg.role === 'system') {
      const empty = anthropicContentIsEmpty(msg.content)
      const hasConfig = hasNonEmptyOutputConfig(msg.output_config)
      if (empty) {
        if (!hasConfig) return true
        if (!Array.isArray(msg.content)) return true
        if (rejectsPerMessageEffort && msg.output_config?.effort != null) return true
        continue
      }
      // Non-directive role: "system" cannot be first and must immediately follow
      // a `user` message or an `assistant` message ending in a server tool result.
      if (i === 0) return true
      const prev = body.messages[i - 1]
      if (prev?.role !== 'user' && !isAssistantEndingInServerToolResult(prev)) return true
      if (!sawFirstNonDirective) return true
      continue
    }

    if (!sawFirstNonDirective) {
      sawFirstNonDirective = true
      if (msg.role !== 'user') return true
    }
  }

  return !sawFirstNonDirective
}

/**
 * Pure read-only check: returns true when `body` already satisfies all
 * Claude Code 2.1.321 / CRAG structural and cache_control invariants.
 */
export function isLegalCrag321Request(body, { strictPassthrough = false, countTokens = false } = {}) {
  if (!isPlainObject(body)) return false
  if (needsStructuralRectification(body, { strictPassthrough, countTokens })) return false
  const cacheChecked = repairCacheBreakpoints(body, {
    limit: 4,
    fillMissing: false,
    stripExtraFields: false,
    liftNested: false,
  })
  return cacheChecked === body
}

function appendSystemBlocks(existing, blocks) {
  if (!blocks.length) return existing
  const normalized = blocks
    .map((part) => {
      if (typeof part === 'string') return part ? { type: 'text', text: part } : null
      if (!isPlainObject(part) || typeof part.text !== 'string' || !part.text) return null
      return part.type === 'text' ? part : { ...part, type: 'text' }
    })
    .filter(Boolean)
  if (!normalized.length) return existing
  if (existing == null || existing === '') return normalized
  if (typeof existing === 'string') return [{ type: 'text', text: existing }, ...normalized]
  if (Array.isArray(existing)) return [...existing, ...normalized]
  return [existing, ...normalized]
}

function mergeTwoNonDirectiveSystems(left, right) {
  const merged = {
    ...left,
    role: 'system',
    content: [...asContentBlocks(left.content), ...asContentBlocks(right.content)],
  }
  if (left.clear_at != null || right.clear_at != null) {
    merged.clear_at =
      left.clear_at != null && right.clear_at != null
        ? Math.max(Number(left.clear_at), Number(right.clear_at))
        : (right.clear_at ?? left.clear_at)
  }
  if (hasNonEmptyOutputConfig(left.output_config) || hasNonEmptyOutputConfig(right.output_config)) {
    merged.output_config = {
      ...(left.output_config || {}),
      ...(right.output_config || {}),
    }
  }
  return merged
}

function pushNonDirectiveSystem(target, sysMsg) {
  const trailingDirectives = []
  while (target.length > 0 && isDirectiveOnlySystemMessage(target[target.length - 1])) {
    trailingDirectives.unshift(target.pop())
  }
  const prev = target[target.length - 1]
  if (prev && prev.role === 'system' && !isDirectiveOnlySystemMessage(prev)) {
    target[target.length - 1] = mergeTwoNonDirectiveSystems(prev, sysMsg)
  } else {
    target.push(sysMsg)
  }
  for (const directive of trailingDirectives) target.push(directive)
}

function lastNonDirectiveAnchor(list) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (!isDirectiveOnlySystemMessage(list[i])) return list[i]
  }
  return null
}

function canAnchorNonDirectiveSystem(anchor) {
  if (!anchor) return false
  if (anchor.role === 'user') return true
  if (isAssistantEndingInServerToolResult(anchor)) return true
  if (anchor.role === 'system' && !isDirectiveOnlySystemMessage(anchor)) return true
  return false
}

function makeContinueUserTurn() {
  return { role: 'user', content: [{ type: 'text', text: CONTINUE_USER_TEXT }] }
}

/**
 * Rectify any Anthropic / CRAG request into a legal Claude Code 2.1.321
 * wire structure. Returns the original `body` reference untouched when already
 * valid (zero-mutation fast path).
 */
export function rectifyCrag321Request(
  body,
  { strictPassthrough = false, countTokens = false, capabilities: _capabilities = null } = {},
) {
  if (!isPlainObject(body)) return body

  if (!needsStructuralRectification(body, { strictPassthrough, countTokens })) {
    return repairCacheBreakpoints(body, {
      limit: 4,
      fillMissing: false,
      stripExtraFields: false,
      liftNested: false,
    })
  }

  let out = { ...body }

  // 1. Top-level thinking & output_config & system annotations.
  if (thinkingNeedsFix(out.thinking)) {
    out.thinking = sanitizeThinkingValue(out.thinking)
  }
  if (out.output_config !== undefined) {
    const cleanConfig = sanitizeOutputConfigValue(out.output_config)
    if (cleanConfig === undefined) delete out.output_config
    else out.output_config = cleanConfig
    out = ensureOutputConfigSchema(out)
  }
  if (Array.isArray(out.system) && out.system.some((block) => blockHasAnnotations(block))) {
    out.system = stripIllegalContentFields(out.system)
  }

  if (!Array.isArray(out.messages) || out.messages.length === 0) {
    return repairCacheBreakpoints(out, {
      limit: 4,
      fillMissing: false,
      stripExtraFields: false,
      liftNested: false,
    })
  }

  const rejectsPerMessageEffort = modelRejectsPerMessageEffort(out.model, { strictPassthrough })

  // 2. Canonicalize roles, sanitize per-message output_config & annotations,
  //    and extract tool_addition/tool_removal out of non-system turns.
  const stage1 = []
  for (const rawMsg of out.messages) {
    if (!isPlainObject(rawMsg)) continue
    const rawRole = String(rawMsg.role || '')
      .trim()
      .toLowerCase()
    const role =
      rawRole === 'system' || rawRole === 'developer' ? 'system' : rawRole === 'assistant' ? 'assistant' : 'user'

    let msg = rawMsg
    const ensureCopy = () => {
      if (msg === rawMsg) msg = { ...rawMsg }
      return msg
    }
    if (msg.role !== role) ensureCopy().role = role
    if (msg.output_config !== undefined) {
      const cleanMsgCfg = sanitizeOutputConfigValue(msg.output_config)
      if (cleanMsgCfg !== msg.output_config) {
        const copy = ensureCopy()
        if (cleanMsgCfg === undefined) delete copy.output_config
        else copy.output_config = cleanMsgCfg
      }
    }
    if (Array.isArray(msg.content) && msg.content.some((block) => blockHasAnnotations(block))) {
      ensureCopy().content = stripIllegalContentFields(msg.content)
    }

    if (role !== 'system' && Array.isArray(msg.content) && msg.content.some(isToolChangeBlock)) {
      const keptBlocks = []
      const extractedToolBlocks = []
      for (const block of msg.content) {
        if (isToolChangeBlock(block)) extractedToolBlocks.push(block)
        else keptBlocks.push(block)
      }
      if (keptBlocks.length > 0 || messageHasTurnControls(msg)) {
        stage1.push({ ...msg, role, content: keptBlocks })
      }
      stage1.push({ role: 'system', content: extractedToolBlocks })
      continue
    }

    stage1.push(msg)
  }

  // 3. Drop empty system shells and model-gate empty per-message effort directives.
  const stage2 = []
  let liftedTrailingEffort = null
  for (const msg of stage1) {
    if (msg.role === 'system' && anthropicContentIsEmpty(msg.content)) {
      if (!hasNonEmptyOutputConfig(msg.output_config)) continue
      if (rejectsPerMessageEffort && msg.output_config?.effort != null) {
        liftedTrailingEffort = msg.output_config.effort
        continue
      }
      liftedTrailingEffort = null
      stage2.push(
        Array.isArray(msg.content) && msg.content.length === 0 ? msg : { ...msg, role: 'system', content: [] },
      )
      continue
    }
    if (msg.role === 'user' || msg.role === 'assistant') liftedTrailingEffort = null
    stage2.push(msg)
  }
  if (rejectsPerMessageEffort && liftedTrailingEffort) {
    out.output_config = { ...(out.output_config || {}), effort: liftedTrailingEffort }
  }

  // 4A. Partition leading system turns (before the first user/assistant turn).
  const leadingDirectives = []
  const deferredAfterFirstUser = []
  const liftedLeadingSystemBlocks = []
  const promotedTools = []
  const existingToolNames = new Set(
    Array.isArray(out.tools)
      ? out.tools.map((tool) => tool?.name).filter((name) => typeof name === 'string' && name)
      : [],
  )

  let firstNonSystemIdx = 0
  while (firstNonSystemIdx < stage2.length && stage2[firstNonSystemIdx].role === 'system') {
    const sysMsg = stage2[firstNonSystemIdx]
    firstNonSystemIdx += 1

    if (isDirectiveOnlySystemMessage(sysMsg)) {
      leadingDirectives.push(sysMsg)
      continue
    }

    const blocks = asContentBlocks(sysMsg.content)
    const deferredBlocks = []
    for (const block of blocks) {
      if (isInlineToolDefinitionBlock(block)) {
        const def = block.tool.definition
        if (!existingToolNames.has(def.name)) {
          existingToolNames.add(def.name)
          const promoted =
            block.cache_control != null && def.cache_control == null
              ? { ...def, cache_control: block.cache_control }
              : def
          promotedTools.push(promoted)
          continue
        }
        deferredBlocks.push(block)
        continue
      }
      if (sysMsg.clear_at == null && isLiftableSystemTextBlock(block)) {
        liftedLeadingSystemBlocks.push(block)
        continue
      }
      deferredBlocks.push(block)
    }

    if (deferredBlocks.length > 0) {
      const deferredMsg = { ...sysMsg, role: 'system', content: deferredBlocks }
      deferredAfterFirstUser.push(deferredMsg)
    } else if (hasNonEmptyOutputConfig(sysMsg.output_config)) {
      if (!rejectsPerMessageEffort || sysMsg.output_config?.effort == null) {
        leadingDirectives.push({ role: 'system', content: [], output_config: sysMsg.output_config })
      } else if (out.output_config?.effort == null) {
        out.output_config = { ...(out.output_config || {}), effort: sysMsg.output_config.effort }
      }
    }
  }

  if (liftedLeadingSystemBlocks.length > 0) {
    out.system = appendSystemBlocks(out.system, liftedLeadingSystemBlocks)
  }
  if (promotedTools.length > 0) {
    out.tools = Array.isArray(out.tools) ? [...out.tools, ...promotedTools] : promotedTools
  }

  const rest = stage2.slice(firstNonSystemIdx)
  if (stage2.length === 0) {
    out.messages = []
    return repairCacheBreakpoints(out, {
      limit: 4,
      fillMissing: false,
      stripExtraFields: false,
      liftNested: false,
    })
  }
  if (rest.length === 0 || rest[0].role !== 'user') {
    rest.unshift(makeContinueUserTurn())
  }
  if (deferredAfterFirstUser.length > 0) {
    rest.splice(1, 0, ...deferredAfterFirstUser)
  }

  const stage3 = [...leadingDirectives, ...rest]

  // 4B. Place mid-conversation & trailing non-directive role:"system" legally:
  //     - immediately after `user` or `assistant` ending in server tool result;
  //     - after a plain `assistant`, defer past the next `user` turn (or insert
  //       a synthetic `user("continue")` turn if trailing / followed by assistant);
  //     - merge consecutive non-directive `role:"system"` turns into one.
  const finalMessages = []
  const pendingAfterNextUser = []

  const flushPending = () => {
    while (pendingAfterNextUser.length > 0) {
      pushNonDirectiveSystem(finalMessages, pendingAfterNextUser.shift())
    }
  }

  for (const msg of stage3) {
    if (isDirectiveOnlySystemMessage(msg)) {
      finalMessages.push(msg)
      continue
    }
    if (msg.role === 'system') {
      const anchor = lastNonDirectiveAnchor(finalMessages)
      if (canAnchorNonDirectiveSystem(anchor)) {
        pushNonDirectiveSystem(finalMessages, msg)
      } else {
        pendingAfterNextUser.push(msg)
      }
      continue
    }
    if (msg.role === 'user') {
      finalMessages.push(msg)
      if (pendingAfterNextUser.length > 0) flushPending()
      continue
    }
    // msg.role === 'assistant'
    if (pendingAfterNextUser.length > 0) {
      finalMessages.push(makeContinueUserTurn())
      flushPending()
    }
    finalMessages.push(msg)
  }

  if (pendingAfterNextUser.length > 0) {
    finalMessages.push(makeContinueUserTurn())
    flushPending()
  }

  out.messages = finalMessages

  // 5. Final cache_control structural & TTL-order check after any reordering.
  return repairCacheBreakpoints(out, {
    limit: 4,
    fillMissing: false,
    stripExtraFields: false,
    liftNested: false,
  })
}
