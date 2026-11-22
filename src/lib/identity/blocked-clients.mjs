/**
 * routing.compatibility.blocked_clients — one switch per known third-party client.
 *
 * Some clients drive the official Claude Code CLI (Agent SDK) and append their own
 * agent prompt to its system, so they pass every Claude Code family check and the
 * third-party system relocation never runs. Anthropic still recognises the appended
 * prompt and answers 400 "Third-party apps now draw from your extra usage". A switch
 * here rejects that client at the gate, before any account is picked, independent of
 * claude_code_only. Every switch defaults off.
 *
 * Detection reads only what the client itself writes: system text and tool names.
 * Conversation messages are never inspected, so a user who merely mentions a client
 * by name is not blocked.
 */
import { makeError, ErrorType, ErrorCode } from '../core/errors.mjs'
import { eachSystemText } from './crs-persona.mjs'

// OpenClaw (github.com/openclaw/openclaw) as captured 2026-11-20 via claude-cli 2.1.281.
const OPENCLAW_SYSTEM_MARKERS = [
  /\brunning inside OpenClaw\b/i,
  /^## OpenClaw Control\b/m,
  /"schema"\s*:\s*"openclaw\.inbound_meta\./,
  /\bdocs\.openclaw\.ai\b/i,
]
const OPENCLAW_TOOL_PREFIX = 'mcp__openclaw__'

export const BLOCKABLE_CLIENTS = Object.freeze([
  Object.freeze({
    id: 'openclaw',
    label: 'OpenClaw',
    systemMarkers: OPENCLAW_SYSTEM_MARKERS,
    toolPrefixes: [OPENCLAW_TOOL_PREFIX],
  }),
])

const CLIENT_IDS = new Set(BLOCKABLE_CLIENTS.map((client) => client.id))

export function isBlockableClientId(id) {
  return CLIENT_IDS.has(id)
}

/** Ids whose switch is on. Unknown ids and non-true values are ignored. */
export function blockedClientsFromRouting(routing) {
  const map = routing?.compatibility?.blocked_clients
  if (!map || typeof map !== 'object' || Array.isArray(map)) return []
  return BLOCKABLE_CLIENTS.filter((client) => map[client.id] === true).map((client) => client.id)
}

/** Anthropic `system` plus OpenAI-shaped system/developer turns. */
function systemTexts(body) {
  const texts = [...eachSystemText(body?.system)]
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message?.role !== 'system' && message?.role !== 'developer') continue
    texts.push(...eachSystemText(message.content))
  }
  return texts
}

function toolNames(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return tools
    .map((tool) => tool?.name ?? tool?.function?.name)
    .filter((name) => typeof name === 'string')
}

/** The known client this request comes from, or null. */
export function detectBlockableClient(body = {}) {
  if (!body || typeof body !== 'object') return null
  const texts = systemTexts(body)
  const names = toolNames(body)
  for (const client of BLOCKABLE_CLIENTS) {
    if (names.some((name) => client.toolPrefixes.some((prefix) => name.startsWith(prefix)))) return client
    if (texts.some((text) => client.systemMarkers.some((re) => re.test(text)))) return client
  }
  return null
}

/** The blocked client this request comes from under the current routing, or null. */
export function blockedClientFor(body, routing) {
  const on = blockedClientsFromRouting(routing)
  if (!on.length) return null
  const client = detectBlockableClient(body)
  return client && on.includes(client.id) ? client : null
}

export function blockedClientError(client) {
  return makeError({
    type: ErrorType.PERMISSION,
    code: ErrorCode.CLIENT_BLOCKED,
    message: `当前不支持 ${client.label} 客户端调用 Claude 模型。`,
    details: { client: client.id },
    status: 403,
  })
}
