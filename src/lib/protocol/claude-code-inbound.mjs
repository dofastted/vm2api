/**
 * Official Claude Code inbound for probe-class traffic.
 * Mimics real CLI body + stainless headers. Omits anthropic-beta so stored
 * Claude Code betas replay and kin-cc-headers.json is not overwritten.
 */
import crypto from 'node:crypto'
import { CRS_OFFICIAL_SYSTEM, DEFAULT_CLI_VERSION } from '../identity/crs-persona.mjs'
import { formatMetadataUserId } from '../identity/vm-identity.mjs'

export const CLAUDE_CLI_UA = `claude-cli/${DEFAULT_CLI_VERSION} (external, sdk-cli)`

export function claudeCodeInboundHeaders({ sessionId, accept = 'text/event-stream' } = {}) {
  const headers = {
    'user-agent': CLAUDE_CLI_UA,
    'anthropic-version': '2023-06-01',
    'x-app': 'cli',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'Linux',
    'x-stainless-arch': 'x64',
    'x-stainless-runtime': 'node',
    'x-stainless-package-version': '0.128.0',
    'x-stainless-runtime-version': 'v26.12.1',
    accept,
  }
  if (sessionId) headers['x-claude-code-session-id'] = sessionId
  return headers
}

export function claudeCodeProbeUserId(sessionId, identity = {}) {
  const sid = String(sessionId || identity.sessionId || identity.session_id || '').trim()
  const device =
    String(identity.deviceId || identity.device_id || '').trim() ||
    (sid ? crypto.createHash('sha256').update(sid).digest('hex') : '')
  return formatMetadataUserId({
    deviceId: device,
    accountUuid: identity.accountUuid || identity.account_uuid || '',
    sessionId: sid,
  })
}

export function claudeCodeInboundBody({
  model,
  messages,
  maxTokens,
  thinking = null,
  sessionId,
  deviceId,
  accountUuid,
  temperature = 1,
  stream = true,
} = {}) {
  const body = {
    model,
    max_tokens: maxTokens,
    stream: !!stream,
    temperature,
    system: CRS_OFFICIAL_SYSTEM,
    metadata: {
      user_id: claudeCodeProbeUserId(sessionId, { deviceId, accountUuid }),
    },
    messages: Array.isArray(messages) ? messages : [],
  }
  if (thinking) body.thinking = thinking
  return body
}
