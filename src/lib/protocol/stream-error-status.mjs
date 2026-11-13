import { isPlanLimitMessage } from '../pool/quota-window.mjs'

const AUTH_ERROR_TEXT =
  /authentication_error|token has been revoked|oauth_revoked|invalid_grant|invalid (?:bearer|x-api-key)|OAuth token has expired/i
const PERMISSION_ERROR_TEXT = /organization does not have access to claude/i

/**
 * The kernel cli-hop answers 200 and then streams `event: error` (sub2api
 * sseStreamErrorEventError). Before any downstream byte, restore the HTTP
 * status the upstream meant so the pool classifies it like a real response.
 */
export function semanticStatusForStreamError(errorBody) {
  const type = String(errorBody?.error?.type || errorBody?.type || '')
  const code = String(errorBody?.error?.code || errorBody?.code || '')
  const message = String(errorBody?.error?.message || errorBody?.message || '')
  if (isPlanLimitMessage(message)) return 429
  const explicit = Number(errorBody?.error?.status ?? errorBody?.status)
  if (explicit >= 400 && explicit < 600) return explicit
  if (type === 'rate_limit_error') return 429
  if (type === 'overloaded_error') return 529
  if (code === 'server_is_overloaded') return 503
  if (type === 'authentication_error' || AUTH_ERROR_TEXT.test(message)) return 401
  if (type === 'permission_error' || PERMISSION_ERROR_TEXT.test(message)) return 403
  if (type === 'invalid_request_error') return 400
  return 502
}
