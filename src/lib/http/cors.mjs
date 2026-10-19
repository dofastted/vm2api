import { resolvePublicBaseUrl } from '../core/config.mjs'

export const CORS_ALLOW_HEADERS =
  'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-session-id, x-kin-rewrite, x-panel-token, x-request-id, x-kin-debug, x-kin-log, x-kin-vm, x-kin-backend, idempotency-key'

export const CORS_ALLOW_METHODS = 'GET,POST,OPTIONS,PUT,DELETE,PATCH'

function normalizeHttpOrigin(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  try {
    const url = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.origin
  } catch {
    return ''
  }
}

/** Origins allowed to use credentialed cross-origin panel/API requests. */
export function parsePanelCorsOrigins(env = process.env) {
  const allowed = new Set()
  for (const piece of String(env.PANEL_CORS_ORIGINS || '').split(/[\s,]+/)) {
    const origin = normalizeHttpOrigin(piece)
    if (origin) allowed.add(origin)
  }
  const base = resolvePublicBaseUrl(env)
  if (base) {
    try {
      allowed.add(new URL(base).origin)
    } catch {}
  }
  return allowed
}

export function corsHeadersForRequest(req, extra = {}, env = process.env) {
  const origin = String(req?.headers?.origin || '').trim()
  const allowed = parsePanelCorsOrigins(env)
  const base = {
    'access-control-allow-headers': CORS_ALLOW_HEADERS,
    'access-control-allow-methods': CORS_ALLOW_METHODS,
    ...extra,
  }
  if (origin && allowed.has(origin)) {
    return {
      ...base,
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
    }
  }
  return {
    ...base,
    'access-control-allow-origin': '*',
  }
}
