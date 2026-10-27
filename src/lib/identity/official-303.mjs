/**
 * official_303 preset, lean models only: the single assembler of system,
 * messages and markers for the cli-hop. Shape follows the official --print capture:
 *
 *   system[0] billing (no marker)
 *   system[1] identity (no marker)
 *   system[2] harness (marker; 1h also carries scope global)
 *   system[3] guidance (marker)
 *   first user: <system-reminder> with non-official caller system, then the turn
 *   last user, and the user before it once there are 4+ messages: last non-thinking block marked
 *   trailing role=system: Environment (no marker, after the last marker)
 *
 * The caller's markers never reach the wire. Marker TTL comes from the panel.
 * Pure: the input body is not mutated.
 */
import { extractInboundEnvironmentSection, parseInboundEnvFacts } from './official-cc-system-2.1.241.mjs'
import { officialSystemEnvFromIdentity, personaTemplateVars } from './crs-persona.mjs'
import {
  OFFICIAL_303_PRESET,
  agentStandingVar,
  renderPersonaTemplate,
  resolvePersonaTemplate,
  selectedTemplateBlocks,
} from './persona-template.mjs'
import {
  OFFICIAL_PROFILES,
  buildOfficial303Environment,
  isBillingText,
  isOfficialIdentityText,
} from './official-profiles.mjs'
import { modelSupportsMidConversationSystem } from '../protocol/anthropic-policy.mjs'
import { liftMidConversationSystemMessages } from '../protocol/sanitize.mjs'
import { normalizeCacheTtl } from '../protocol/cache-ttl.mjs'
import { stabilizeOfficialContextBudget } from '../protocol/outbound-attempt.mjs'

const PROFILE = OFFICIAL_PROFILES['2.1.303']
const ENV_HEADING = /^# Environment\b/m

function systemTexts(system) {
  if (typeof system === 'string') return system.trim() ? [system] : []
  if (!Array.isArray(system)) return []
  return system
    .map((block) => (typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : ''))
    .filter((text) => text.trim())
}

/** Non-official caller system minus billing and identity sentences, in caller order. */
export function callerLeftover(system) {
  return systemTexts(system)
    .filter((text) => !isBillingText(text) && !isOfficialIdentityText(text))
    .join('\n\n')
}

function messageTexts(message) {
  const content = message?.content
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text)
}

function panelMarker(ttl, { scope = false } = {}) {
  const hour = normalizeCacheTtl(ttl) === '1h'
  return hour ? { type: 'ephemeral', ttl: '1h', ...(scope ? { scope: 'global' } : {}) } : { type: 'ephemeral' }
}

function withoutCacheControl(node) {
  if (!node || typeof node !== 'object' || !Object.hasOwn(node, 'cache_control')) return node
  const copy = { ...node }
  delete copy.cache_control
  return copy
}

function stripMessageMarkers(messages) {
  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message
    const next = withoutCacheControl(message)
    if (!Array.isArray(next.content)) return next
    return { ...next, content: next.content.map(withoutCacheControl) }
  })
}

/** Billing never carries a marker. A template scope stays only on a 1h marker. */
function systemWithPanelMarkers(blocks, ttl, budget) {
  const next = blocks.map((block) => {
    if (isBillingText(block.text) || !block.cache_control) return withoutCacheControl(block)
    return { ...block, cache_control: panelMarker(ttl, { scope: block.cache_control.scope === 'global' }) }
  })
  for (let i = next.length - 1; i >= 0; i--) {
    if (!next[i].cache_control) continue
    if (budget > 0) budget -= 1
    else next[i] = withoutCacheControl(next[i])
  }
  return next
}

function environmentEnv(facts, { identity, model }) {
  return officialSystemEnvFromIdentity(identity, model, facts, { overwrite: true })
}

/** Replace only the `# Environment` section; every other byte of the turn stays. */
function replaceEnvironmentSection(text, render) {
  const start = text.search(ENV_HEADING)
  if (start < 0) return null
  const section = extractInboundEnvironmentSection([text.slice(start)])
  if (!section) return null
  return `${text.slice(0, start)}${render(section)}${text.slice(start + section.length)}`
}

function replaceEnvironmentInMessage(message, render) {
  if (typeof message.content === 'string') {
    const text = replaceEnvironmentSection(message.content, render)
    return text == null ? null : { ...message, content: text }
  }
  if (!Array.isArray(message.content)) return null
  for (let i = 0; i < message.content.length; i++) {
    const block = message.content[i]
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const text = replaceEnvironmentSection(block.text, render)
    if (text == null) continue
    const content = message.content.slice()
    content[i] = { ...block, text }
    return { ...message, content }
  }
  return null
}

/**
 * 2.1.303 sends role=system content as a string. Node's canonical body has
 * already promoted it to one text block; fold that back. Anything richer stays.
 */
function officialSystemContent(message) {
  const content = message?.content
  if (!Array.isArray(content) || content.length !== 1) return message
  const [block] = content
  if (block?.type !== 'text' || typeof block.text !== 'string') return message
  if (Object.keys(block).some((key) => key !== 'type' && key !== 'text')) return message
  return { ...message, content: block.text }
}

function markableUser(message) {
  if (message?.role !== 'user') return false
  if (typeof message.content === 'string') return Boolean(message.content.trim())
  return Array.isArray(message.content) && message.content.some(markableBlock)
}

function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i
  }
  return -1
}

function prependReminder(messages, leftover) {
  const index = messages.findIndex((message) => message?.role === 'user')
  if (index < 0) return messages
  const message = messages[index]
  const reminder = { type: 'text', text: `<system-reminder>\n${leftover}\n</system-reminder>\n` }
  const content =
    typeof message.content === 'string'
      ? [reminder, { type: 'text', text: message.content }]
      : Array.isArray(message.content)
        ? [reminder, ...message.content]
        : [reminder]
  const next = messages.slice()
  next[index] = { ...message, content }
  return next
}

function markableBlock(block) {
  if (!block || typeof block !== 'object') return false
  if (block.type === 'thinking' || block.type === 'redacted_thinking') return false
  if (block.type === 'text' && !String(block.text || '').trim()) return false
  return true
}

function markUser(messages, index, marker) {
  const message = messages[index]
  if (typeof message.content === 'string') {
    messages[index] = { ...message, content: [{ type: 'text', text: message.content, cache_control: { ...marker } }] }
    return
  }
  const at = message.content.findLastIndex(markableBlock)
  const content = message.content.slice()
  content[at] = { ...content[at], cache_control: { ...marker } }
  messages[index] = { ...message, content }
}

/**
 * The last user writes this turn. From 4 messages on, the user before it also
 * carries a marker: it sits on the previous request's write, so a turn longer
 * than the 20-block lookback still reads it instead of only system + tools.
 */
function markLastUsers(messages, marker) {
  const users = []
  for (let i = messages.length - 1; i >= 0 && users.length < 2; i--) {
    if (markableUser(messages[i])) users.push(i)
  }
  if (users.length > 1 && messages.length < 4) users.pop()
  const next = messages.slice()
  for (const index of users) markUser(next, index, marker)
  return { messages: next, count: users.length }
}

function orderTopLevel(body) {
  const out = {}
  for (const key of PROFILE.topLevelOrder) if (Object.hasOwn(body, key)) out[key] = body[key]
  for (const key of Object.keys(body)) if (!Object.hasOwn(out, key)) out[key] = body[key]
  return out
}

/**
 * @param body cli-hop body after prepareCliHopBody(..., { outboundShape: 'lean' })
 * @param opts.callerSystem caller system before any persona rendering
 * @param opts.officialCaller official Claude Code family: its whole system is dropped (D1)
 * @param opts.compat routing.compatibility (official_303 template, standing switch)
 * @param opts.cacheTtl panel cache TTL
 * @param opts.oneM caller chose a [1m] model (model line only)
 */
export function renderOfficial303Body(
  body,
  {
    callerSystem,
    officialCaller = false,
    identity = null,
    compat = {},
    cacheTtl,
    firstUserText = '',
    sessionId = '',
    oneM = false,
    entrypoint = 'sdk-cli',
  } = {},
) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return body
  const model = String(body.model || '')
  const marker = panelMarker(cacheTtl)
  // The reminder sits before both message markers; a live token counter there would move every turn.
  const leftover = officialCaller ? '' : stabilizeOfficialContextBudget(callerLeftover(callerSystem))

  const roleSystemTexts = body.messages.filter((message) => message?.role === 'system').flatMap(messageTexts)
  const facts = parseInboundEnvFacts([...systemTexts(callerSystem), ...roleSystemTexts])
  const env = environmentEnv(facts, { identity, model })
  const requestEnvironment = buildOfficial303Environment(env, { model, oneM })

  const vars = personaTemplateVars({
    firstUserText,
    cliVersion: PROFILE.cliVersion,
    sessionId,
    env,
    agentStanding: agentStandingVar(compat, OFFICIAL_303_PRESET),
    withEnv: true,
    model,
    compat,
    preset: OFFICIAL_303_PRESET,
    entrypoint,
  })
  const template = selectedTemplateBlocks(
    resolvePersonaTemplate(OFFICIAL_303_PRESET, compat?.persona_templates),
    compat,
    OFFICIAL_303_PRESET,
  ).filter((block) => block?.id !== 'caller_system')
  let system = renderPersonaTemplate(template, vars)

  let messages = stripMessageMarkers(body.messages).map((message) =>
    message?.role === 'system' ? officialSystemContent(message) : message,
  )
  if (modelSupportsMidConversationSystem(model)) {
    let replaced = false
    messages = messages.map((message) => {
      if (message?.role !== 'system') return message
      const next = replaceEnvironmentInMessage(message, (section) => {
        // Each turn renders from its own facts so history bytes stay identical on later turns.
        const own = environmentEnv(parseInboundEnvFacts([section]), { identity, model })
        return buildOfficial303Environment(own, { model, oneM: oneM || /\(1M context\)|\[1m\]/i.test(section) })
      })
      if (!next) return message
      replaced = true
      return next
    })
    if (!replaced) {
      const at = lastUserIndex(messages)
      if (at >= 0) messages.splice(at + 1, 0, { role: 'system', content: requestEnvironment })
    }
  } else {
    // Official merges the session sections into guidance when role=system is unavailable.
    const guidance = system.findLastIndex((block) => block?.cache_control && !isBillingText(block.text))
    if (guidance >= 0) {
      system = system.map((block, i) =>
        i === guidance ? { ...block, text: `${block.text}\n\n${requestEnvironment}` } : block,
      )
    }
  }
  if (leftover) messages = prependReminder(messages, leftover)

  let out = { ...body, system, messages }
  delete out.cache_control
  // Lift before marking: merging the turns around a lifted role=system changes the user indexes.
  if (!modelSupportsMidConversationSystem(model)) out = liftMidConversationSystemMessages(out)
  const marked = markLastUsers(out.messages, marker)
  out = {
    ...out,
    system: systemWithPanelMarkers(out.system, cacheTtl, PROFILE.maxMarkers - marked.count),
    messages: marked.messages,
  }
  return orderTopLevel(out)
}
