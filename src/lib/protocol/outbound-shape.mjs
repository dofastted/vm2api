/**
 * Redacted outbound structure: key order, block kinds, lengths, markers. No
 * prompt text, ids or secrets leave this module. The unit tests and the real
 * wire capture check go through the same functions.
 */
import { createHash } from 'node:crypto'
import { computeClaudeCodeCch, projectClaudeCodeCchText } from '../identity/cch.mjs'
import {
  OFFICIAL_303_GUIDANCE,
  OFFICIAL_303_HARNESS,
  OFFICIAL_303_IDENTITY,
  OFFICIAL_303_MAIN_PROMPT,
  OFFICIAL_PROFILES,
  classifySystemText,
  isBillingText,
  isOfficialIdentityText,
} from '../identity/official-profiles.mjs'
import { stabilizeOfficialContextBudget } from './outbound-attempt.mjs'

function markerShape(control) {
  if (!control || typeof control !== 'object') return null
  const out = { type: control.type }
  if (control.ttl != null) out.ttl = control.ttl
  if (control.scope != null) out.scope = control.scope
  return out
}

function textKind(text, role) {
  const t = String(text || '')
  if (t.startsWith('<system-reminder>')) return 'reminder'
  if (role === 'system' && t.trimStart().startsWith('# Environment')) return 'env'
  return 'text'
}

function blockShape(block, role) {
  if (!block || typeof block !== 'object') return { type: typeof block }
  const out = { type: block.type }
  if (typeof block.text === 'string') {
    out.kind = textKind(block.text, role)
    out.len = block.text.length
  }
  const marker = markerShape(block.cache_control)
  if (marker) out.cache_control = marker
  return out
}

function systemShape(system) {
  if (system == null) return null
  if (typeof system === 'string') return [{ type: 'string', kind: classifySystemText(system), len: system.length }]
  if (!Array.isArray(system)) return [{ type: typeof system }]
  return system.map((block) => {
    const text = typeof block === 'string' ? block : String(block?.text || '')
    const out = {
      type: typeof block === 'string' ? 'string' : block?.type,
      kind: classifySystemText(text),
      len: text.length,
    }
    const marker = markerShape(block?.cache_control)
    if (marker) out.cache_control = marker
    return out
  })
}

function messageShape(message) {
  const role = message?.role
  const content = message?.content
  if (typeof content === 'string') {
    const out = { role, content: 'string', kind: textKind(content, role), len: content.length }
    const marker = markerShape(message.cache_control)
    if (marker) out.cache_control = marker
    return out
  }
  return { role, content: 'array', blocks: Array.isArray(content) ? content.map((b) => blockShape(b, role)) : [] }
}

function collectMarkers(body) {
  const out = []
  const note = (where, control) => {
    const marker = markerShape(control)
    if (marker) out.push({ where, ttl: marker.ttl ?? '5m' })
  }
  if (Array.isArray(body?.tools)) body.tools.forEach((tool, i) => note(`tools[${i}]`, tool?.cache_control))
  if (Array.isArray(body?.system)) body.system.forEach((block, i) => note(`system[${i}]`, block?.cache_control))
  if (Array.isArray(body?.messages)) {
    body.messages.forEach((message, i) => {
      note(`messages[${i}]`, message?.cache_control)
      if (Array.isArray(message?.content)) {
        message.content.forEach((block, j) => note(`messages[${i}].content[${j}]`, block?.cache_control))
      }
    })
  }
  note('top_level', body?.cache_control)
  return out
}

function billingFields(system) {
  const texts = Array.isArray(system) ? system.map((b) => String(b?.text ?? b ?? '')) : [String(system ?? '')]
  const billing = texts.find((text) => isBillingText(text))
  if (!billing) return null
  return billing
    .replace(/^\s*x-anthropic-billing-header:\s*/i, '')
    .split(';')
    .map((part) => part.trim().split('=')[0])
    .filter(Boolean)
}

export function outboundShape(body) {
  const markers = collectMarkers(body)
  return {
    top_level: Object.keys(body || {}),
    model: typeof body?.model === 'string' ? body.model : null,
    system: systemShape(body?.system),
    billing_fields: billingFields(body?.system),
    messages: Array.isArray(body?.messages) ? body.messages.map(messageShape) : null,
    tools: Array.isArray(body?.tools)
      ? { count: body.tools.length, markers: body.tools.filter((tool) => tool?.cache_control).length }
      : null,
    metadata_keys: body?.metadata && typeof body.metadata === 'object' ? Object.keys(body.metadata) : null,
    thinking: body?.thinking && typeof body.thinking === 'object' ? { ...body.thinking } : (body?.thinking ?? null),
    output_config_keys:
      body?.output_config && typeof body.output_config === 'object' ? Object.keys(body.output_config) : null,
    stream: body?.stream ?? null,
    markers: { total: markers.length, at: markers },
  }
}

/** Structure only: lengths and model ids are ignored. */
function structural(value) {
  if (Array.isArray(value)) return value.map(structural)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'len' || key === 'model') continue
    out[key] = structural(inner)
  }
  return out
}

export function diffShapes(expected, actual, path = '') {
  const a = structural(expected)
  const b = structural(actual)
  const out = []
  const walk = (x, y, at) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return
    const xObj = x && typeof x === 'object'
    const yObj = y && typeof y === 'object'
    if (!xObj || !yObj || Array.isArray(x) !== Array.isArray(y)) {
      out.push({ path: at || '.', expected: x, actual: y })
      return
    }
    if (Array.isArray(x)) {
      if (at.endsWith('top_level') || at.endsWith('billing_fields')) {
        out.push({ path: at, expected: x, actual: y })
        return
      }
      const n = Math.max(x.length, y.length)
      for (let i = 0; i < n; i++) walk(x[i], y[i], `${at}[${i}]`)
      return
    }
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[key], y[key], at ? `${at}.${key}` : key)
  }
  walk(a, b, path)
  return out
}

/**
 * Node body handed to cli-node. The boundary stays between harness and guidance
 * so the CLI can split them. It is not the Anthropic wire.
 */
export function checkOfficial303Rules(body) {
  return checkOfficial303Shape(body, { stage: 'node' })
}

/**
 * Body after cli-node splitSysPromptPrefix. Four blocks, no boundary literal.
 * Harness is system[2]; guidance is system[3].
 */
export function checkOfficial303WireRules(body) {
  return checkOfficial303Shape(body, { stage: 'wire' })
}

function checkOfficial303Shape(body, { stage }) {
  const problems = []
  const shape = outboundShape(body)
  const system = shape.system || []
  const kinds = system.map((block) => block.kind)
  const expected = stage === 'wire' ? 'billing,identity,harness,guidance' : 'billing,identity,harness,boundary,guidance'
  if (kinds.join(',') !== expected) problems.push(`system kinds ${kinds.join(',')} != ${expected}`)
  const guidanceAt = stage === 'wire' ? 3 : 4
  if (system[0]?.cache_control) problems.push('billing carries a marker')
  if (system[1]?.cache_control) problems.push('identity carries a marker')
  if (stage === 'node' && system[3]?.cache_control) problems.push('dynamic boundary carries a marker')
  if (stage === 'wire' && kinds.includes('boundary')) problems.push('dynamic boundary reached the wire')
  if (!system[2]?.cache_control || !system[guidanceAt]?.cache_control)
    problems.push('harness / guidance must carry markers')
  if (system[2]?.cache_control?.ttl === '1h' && system[2].cache_control.scope !== 'global')
    problems.push('1h harness marker must carry scope global')
  if (system[2]?.cache_control?.ttl !== '1h' && system[2]?.cache_control?.scope)
    problems.push('5m harness marker must not carry scope')
  if (shape.tools?.markers) problems.push('tools carry markers')
  const messages = shape.messages || []
  let lastUser = -1
  messages.forEach((message, i) => {
    if (message.role === 'user') lastUser = i
  })
  messages.forEach((message, i) => {
    if (message.role !== 'system') return
    const marked = message.cache_control || (message.blocks || []).some((block) => block.cache_control)
    if (marked) problems.push(`messages[${i}] role=system carries a marker`)
  })
  const userAt = messages.flatMap((message, i) => (message.role === 'user' ? [i] : []))
  const expectedUsers = messages.length >= 4 && userAt.length >= 2 ? userAt.slice(-2) : userAt.slice(-1)
  const messageMarkers = shape.markers.at.filter((m) => m.where.startsWith('messages['))
  const markedUsers = messageMarkers.map((m) => Number(/^messages\[(\d+)\]/.exec(m.where)[1]))
  if (markedUsers.join(',') !== expectedUsers.join(',')) {
    problems.push(`message markers at [${markedUsers.join(',')}], expected users [${expectedUsers.join(',')}]`)
  }
  const total = 2 + expectedUsers.length
  if (shape.markers.total !== total) problems.push(`markers ${shape.markers.total} != ${total}`)
  const ttls = new Set(shape.markers.at.map((m) => m.ttl))
  if (ttls.size > 1) problems.push(`mixed marker TTLs ${[...ttls].join(',')}`)
  const tail = messages.slice(lastUser + 1)
  if (tail.some((message) => message.role !== 'system')) problems.push('non-system message after the last user')
  // Reminders (caller system, then any panel overlay) lead the first user turn, contiguous from index 0.
  const firstUser = messages.findIndex((message) => message.role === 'user')
  messages.forEach((message, i) => {
    let head = i === firstUser
    ;(message.blocks || []).forEach((block, j) => {
      if (block.kind !== 'reminder') {
        head = false
        return
      }
      if (!head) problems.push(`reminder at messages[${i}].content[${j}] is not at the first user head`)
    })
  })
  return problems
}

/** Differences the profile allows against the API-key skeleton (billing slot, TTL value, conditional fields). */
export function isAllowedSkeletonDiff(diff) {
  const at = diff.path
  if (at === 'system' || at.startsWith('system[')) return true
  if (at === 'billing_fields') return true
  if (at.startsWith('markers')) return true
  if (at === 'messages' || at.startsWith('messages[')) return true
  if (at === 'top_level') {
    const allowed = new Set(['context_management', 'temperature', 'tool_choice', 'kin_outbound_shape'])
    const strip = (keys) => (Array.isArray(keys) ? keys.filter((key) => !allowed.has(key)).sort() : keys)
    return JSON.stringify(strip(diff.expected)) === JSON.stringify(strip(diff.actual))
  }
  if (at === 'tools.count') return true
  if (at.startsWith('thinking') || at.startsWith('output_config_keys')) return true
  return false
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function billingText(system) {
  const texts = Array.isArray(system) ? system.map((b) => String(b?.text ?? b ?? '')) : [String(system ?? '')]
  return texts.find((text) => isBillingText(text)) || ''
}

/**
 * Rules on the bytes the CLI finally sends (`wire = { raw, body, headers }`). Problems are
 * `{ id, ...details }`; details are keys, indexes and versions only. `blocking: false` marks
 * notes that go into the report without failing the capture.
 */
export function checkOfficial303Wire(wire, { profile = OFFICIAL_PROFILES['2.1.303'] } = {}) {
  const problems = []
  const body = wire?.body || {}
  const keys = Object.keys(body)
  if (keys.includes('kin_outbound_shape')) problems.push({ id: 'wire.kin_outbound_shape' })
  const order = profile.topLevelOrder
  const actual = keys.filter((key) => order.includes(key))
  const expected = order.filter((key) => keys.includes(key))
  if (actual.join(',') !== expected.join(',')) problems.push({ id: 'wire.top_level_order', expected, actual })
  keys.forEach((key, index) => {
    if (!order.includes(key) && key !== 'kin_outbound_shape')
      problems.push({ id: 'wire.extra_key', key, index, blocking: false })
  })
  const billing = billingText(body.system)
  if (!billing) problems.push({ id: 'wire.billing_missing' })
  else {
    const version = /\bcc_version=([^;\s]+)/.exec(billing)?.[1] || ''
    if (!version.startsWith(`${profile.cliVersion}.`)) problems.push({ id: 'wire.billing_version', version })
  }
  const ua = String(wire?.headers?.['user-agent'] || '')
  if (!new RegExp(`^claude-cli/${escapeRegExp(profile.cliVersion)} `).test(ua))
    problems.push({ id: 'wire.user_agent', ua: /^claude-cli\/[^\s]+/.exec(ua)?.[0] || '' })
  const messages = Array.isArray(body.messages) ? body.messages : []
  let lastUser = -1
  messages.forEach((message, i) => {
    if (message?.role === 'user') lastUser = i
  })
  messages.forEach((message, index) => {
    if (index > lastUser && message?.role === 'system' && typeof message.content !== 'string')
      problems.push({ id: 'wire.tail_system_not_string', index })
  })
  if (billing) {
    const cch = /\bcch=([0-9a-f]{5});/.exec(billing)?.[1]
    let expectedCch = null
    try {
      expectedCch = computeClaudeCodeCch(Buffer.from(projectClaudeCodeCchText(wire.raw), 'utf8'))
    } catch {}
    if (!cch || cch === '00000' || cch !== expectedCch)
      problems.push({ id: 'wire.cch', sealed: Boolean(cch && cch !== '00000') })
  }
  const length = Buffer.byteLength(String(wire?.raw ?? ''))
  if (length !== Number(wire?.headers?.['content-length']))
    problems.push({ id: 'wire.content_length', bytes: length, header: wire?.headers?.['content-length'] ?? null })
  return problems
}

function partTexts(content) {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content
    .filter((part) => typeof part?.text === 'string' && ['text', 'input_text'].includes(part.type))
    .map((part) => part.text)
}

/** Caller system text as the inbound protocol carries it. */
function callerSystemTexts(inbound, protocol) {
  if (protocol === 'openai.chat') {
    return (inbound?.messages || [])
      .filter((message) => message?.role === 'system' || message?.role === 'developer')
      .flatMap((message) => partTexts(message.content))
  }
  if (protocol === 'openai.responses') {
    const input = Array.isArray(inbound?.input) ? inbound.input : []
    return [
      ...(typeof inbound?.instructions === 'string' ? [inbound.instructions] : []),
      ...input
        .filter((item) => item?.role === 'system' || item?.role === 'developer')
        .flatMap((item) => partTexts(item.content)),
    ]
  }
  const system = inbound?.system
  if (typeof system === 'string') return [system]
  return Array.isArray(system)
    ? system.map((block) => (typeof block === 'string' ? block : String(block?.text || '')))
    : []
}

/** Every text slot of an outbound body with its path. */
function outboundTexts(body) {
  const out = []
  if (typeof body?.system === 'string') out.push({ at: 'system', text: body.system })
  else if (Array.isArray(body?.system))
    body.system.forEach((block, i) => out.push({ at: `system[${i}]`, text: String(block?.text ?? block ?? '') }))
  ;(Array.isArray(body?.messages) ? body.messages : []).forEach((message, i) => {
    if (typeof message?.content === 'string') return out.push({ at: `messages[${i}]`, text: message.content })
    ;(Array.isArray(message?.content) ? message.content : []).forEach((block, j) => {
      if (typeof block?.text === 'string') out.push({ at: `messages[${i}].content[${j}]`, text: block.text })
      if (Array.isArray(block?.content))
        block.content.forEach((inner, k) => {
          if (typeof inner?.text === 'string')
            out.push({ at: `messages[${i}].content[${j}].content[${k}]`, text: inner.text })
        })
      else if (typeof block?.content === 'string')
        out.push({ at: `messages[${i}].content[${j}].content`, text: block.content })
    })
  })
  return out
}

const sha12 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12)

/**
 * Where the caller's system text ended up on a lean 303 body. Official callers: none of it
 * (profile-owned paragraphs excepted). Others: only in the first user's leading reminder.
 * Reports paragraph hashes and paths, never text.
 */
export function checkCallerPlacement(outBody, inbound, { officialCaller, protocol = 'anthropic.messages' } = {}) {
  const problems = []
  for (const key of ['temperature', 'context_management']) {
    if (Object.hasOwn(outBody || {}, key) && !Object.hasOwn(inbound || {}, key))
      problems.push({ id: `caller.${key}_added` })
  }
  let skipped = 0
  const paragraphs = []
  for (const text of callerSystemTexts(inbound, protocol)) {
    // The reminder carries the stabilized `<total_tokens>` counter, not the caller's live one.
    for (const para of stabilizeOfficialContextBudget(text)
      .split(/\n{2,}/)
      .map((part) => part.trim())) {
      if (para.length < 40) continue
      if (isBillingText(para) || isOfficialIdentityText(para)) continue
      if (
        OFFICIAL_303_MAIN_PROMPT.includes(para) ||
        OFFICIAL_303_HARNESS.includes(para) ||
        OFFICIAL_303_GUIDANCE.includes(para) ||
        OFFICIAL_303_IDENTITY.includes(para)
      ) {
        skipped++
        continue
      }
      paragraphs.push(para)
    }
  }
  const slots = outboundTexts(outBody)
  const firstUser = (outBody?.messages || []).findIndex((message) => message?.role === 'user')
  const allowedAt = `messages[${firstUser}].content[0]`
  for (const para of paragraphs) {
    const hits = slots.filter((slot) => slot.text.includes(para)).map((slot) => slot.at)
    const detail = { para_sha: sha12(para), para_len: para.length }
    if (officialCaller) {
      for (const at of hits) problems.push({ id: 'caller.official_system_leak', ...detail, at })
      continue
    }
    const reminder = slots.find((slot) => slot.at === allowedAt && slot.text.startsWith('<system-reminder>'))
    if (!reminder?.text.includes(para)) problems.push({ id: 'caller.system_missing', ...detail })
    for (const at of hits) if (at !== allowedAt) problems.push({ id: 'caller.system_leak', ...detail, at })
  }
  if (skipped) problems.push({ id: 'caller.skipped', count: skipped, blocking: false })
  return problems
}
