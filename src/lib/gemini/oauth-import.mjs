/**
 * Normalize imported Gemini / Antigravity OAuth account documents (or bare
 * refresh tokens) into the minimal host credential forwarded to `gemini-host.py`.
 *
 * Supported formats (aligned with Antigravity2API Transfer parser):
 * 1. Bare Google OAuth refresh token text (`1//...`, single token only for direct API import)
 * 2. Antigravity Manager / Antigravity2API export array or object:
 *    `[{ email, refresh_token }]` or `{ email, refresh_token, auth_method?, wif_provider? }`
 * 3. Antigravity Tools / CPA / opencode-antigravity-auth / antigravity-claude-proxy:
 *    - Nested `token.refresh_token` / `token.refreshToken` or flat `refresh_token` / `refreshToken`
 *      (strips optional `|<project_id>` suffix)
 *    - Legacy short-lived access token only: `{ access_token, expiry_timestamp | expired | expiry | timestamp + expires_in }`
 * 4. sub2api:
 *    - Single account: `{ platform: "gemini" | "antigravity", type: "oauth", credentials: { refresh_token? | access_token, expires_at? } }`
 *    - Export bundle:  `{ accounts: [...] }` or `{ data: { accounts: [...] } }`
 * 5. Arbitrary nested JSON containers yielding exactly one unique matching account.
 *
 * Security boundary: only whitelisted OAuth credential fields (`refresh_token`,
 * optional `access_token`/`expiry_timestamp`, optional `auth_method`/`wif_provider`)
 * are forwarded to the Gemini host; account metadata and unrelated secrets are stripped.
 */

const OAUTH_ACCESS_TOKEN_RE = /^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/
const OAUTH_REFRESH_TOKEN_RE = /^1\/\/[0-9A-Za-z._~+/-]{6,2048}$/
const BARE_REFRESH_TOKEN_RE = /1\/\/[0-9A-Za-z_-]{6,2048}/g
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/
const MAX_EXPIRY_SECONDS = 253402300800
const MILLISECOND_THRESHOLD = 1_000_000_000_000
const GEMINI_PROVIDERS = new Set(['gemini', 'antigravity', 'gemini-cli'])
const SUB2API_BUNDLE_TYPES = new Set(['sub2api-data', 'sub2api-bundle'])
const ALLOWED_OAUTH_AUTH_METHODS = new Set(['consumer', 'personal_consumer', 'gcp', 'business_licensed_enterprise'])
const WIF_PROVIDER_RE = /^[A-Za-z0-9._:/-]{1,512}$/
const MAX_RECURSION_DEPTH = 16

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizedTag(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function validExpirySeconds(seconds) {
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds < MAX_EXPIRY_SECONDS ? seconds : null
}

function toSecondsFromNumeric(num) {
  if (typeof num !== 'number' || !Number.isFinite(num) || !Number.isSafeInteger(num) || num <= 0) {
    return null
  }
  const seconds = num >= MILLISECOND_THRESHOLD ? Math.floor(num / 1000) : num
  return validExpirySeconds(seconds)
}

export function parseGeminiExpirySeconds(value) {
  if (typeof value === 'number') {
    return toSecondsFromNumeric(value)
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed)
    return toSecondsFromNumeric(parsed)
  }
  if (ISO_DATETIME_RE.test(trimmed)) {
    const ms = Date.parse(trimmed)
    if (Number.isFinite(ms) && ms > 0) {
      return validExpirySeconds(Math.floor(ms / 1000))
    }
  }
  return null
}

function parseTimestampPlusExpiresIn(source) {
  if (!isRecord(source)) return null
  const tsSeconds = parseGeminiExpirySeconds(source.timestamp)
  if (tsSeconds == null) return null
  const rawExpiresIn = source.expires_in
  const expiresIn =
    typeof rawExpiresIn === 'number'
      ? rawExpiresIn
      : typeof rawExpiresIn === 'string' && /^\d+(?:\.\d+)?$/.test(rawExpiresIn.trim())
        ? Number(rawExpiresIn.trim())
        : Number.NaN
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) return null
  return validExpirySeconds(Math.floor(tsSeconds + expiresIn))
}

function extractExpirySeconds(primary, fallback = null) {
  const sources = fallback ? [primary, fallback] : [primary]
  for (const src of sources) {
    if (!isRecord(src)) continue
    for (const key of ['expiry_timestamp', 'expires_at', 'expiresAt', 'expired', 'expiry']) {
      if (src[key] !== undefined && src[key] !== null && src[key] !== '') {
        const parsed = parseGeminiExpirySeconds(src[key])
        if (parsed != null) return parsed
      }
    }
    const fromDuration = parseTimestampPlusExpiresIn(src)
    if (fromDuration != null) return fromDuration
  }
  return null
}

function extractAccessToken(primary, fallback = null) {
  const sources = fallback ? [primary, fallback] : [primary]
  for (const src of sources) {
    if (!isRecord(src)) continue
    for (const key of ['access_token', 'accessToken']) {
      if (typeof src[key] === 'string') {
        const token = src[key].trim()
        if (!token) continue
        return OAUTH_ACCESS_TOKEN_RE.test(token) ? token : null
      }
    }
  }
  return null
}

export function normalizeGeminiRefreshToken(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const pipeIndex = trimmed.indexOf('|')
  const candidate = (pipeIndex >= 0 ? trimmed.slice(0, pipeIndex) : trimmed).trim()
  return OAUTH_REFRESH_TOKEN_RE.test(candidate) ? candidate : null
}

function extractRefreshToken(primary, fallback = null) {
  const sources = fallback ? [primary, fallback] : [primary]
  for (const src of sources) {
    if (!isRecord(src)) continue
    for (const key of ['refresh_token', 'refreshToken']) {
      if (typeof src[key] === 'string') {
        const trimmed = src[key].trim()
        if (!trimmed) continue
        const normalized = normalizeGeminiRefreshToken(trimmed)
        if (normalized) return normalized
      }
    }
  }
  return null
}

function hasExplicitInvalidToken(sources) {
  for (const src of sources) {
    if (!isRecord(src)) continue
    for (const key of ['access_token', 'accessToken']) {
      if (typeof src[key] === 'string') {
        const token = src[key].trim()
        if (token && !OAUTH_ACCESS_TOKEN_RE.test(token)) return true
      }
    }
    for (const key of ['refresh_token', 'refreshToken']) {
      if (typeof src[key] === 'string') {
        const raw = src[key].trim()
        if (raw && /[\r\n\s]/.test(raw)) return true
      }
    }
  }
  return false
}

function extractOptionalAuthMeta(doc) {
  const out = {}
  const authMethod = normalizedTag(doc.auth_method ?? doc.authMethod)
  if (authMethod && ALLOWED_OAUTH_AUTH_METHODS.has(authMethod)) {
    out.auth_method = authMethod
  }
  const wifRaw = doc.wif_provider ?? doc.wifProvider ?? doc.saved_wif_provider
  if (typeof wifRaw === 'string') {
    const wif = wifRaw.trim()
    if (wif && WIF_PROVIDER_RE.test(wif)) {
      out.wif_provider = wif
    }
  }
  return out
}

function buildNormalizedCredential({ refreshToken, accessToken, expiryTimestamp, meta }) {
  if (refreshToken) {
    return {
      refresh_token: refreshToken,
      ...(accessToken && expiryTimestamp != null
        ? { access_token: accessToken, expiry_timestamp: expiryTimestamp }
        : {}),
      ...meta,
    }
  }
  if (accessToken && expiryTimestamp != null) {
    return { access_token: accessToken, expiry_timestamp: expiryTimestamp }
  }
  return null
}

function normalizeSingleAccount(doc) {
  if (!isRecord(doc)) return null

  const platformTag = normalizedTag(doc.platform)
  if (platformTag && !GEMINI_PROVIDERS.has(platformTag)) return null

  // sub2api single account object: `{ platform, type, credentials: { ... } }`
  if (isRecord(doc.credentials)) {
    const accountType = normalizedTag(doc.type)
    if (accountType && accountType !== 'oauth') return null
    if (hasExplicitInvalidToken([doc.credentials, doc])) return null
    const refreshToken = extractRefreshToken(doc.credentials, doc)
    const accessToken = extractAccessToken(doc.credentials)
    const expiryTimestamp = extractExpirySeconds(doc.credentials)
    return buildNormalizedCredential({
      refreshToken,
      accessToken,
      expiryTimestamp,
      meta: extractOptionalAuthMeta(doc.credentials),
    })
  }

  // Reject explicitly non-Gemini providers (e.g. CPA claude / codex / kimi / xai)
  const typeTag = normalizedTag(doc.type)
  if (typeTag && !GEMINI_PROVIDERS.has(typeTag) && typeTag !== 'oauth') return null

  // Nested `token` shape: Antigravity Tools, official agy token, or CPA Gemini CLI
  if (isRecord(doc.token)) {
    if (hasExplicitInvalidToken([doc.token, doc])) return null
    const refreshToken = extractRefreshToken(doc.token, doc)
    const accessToken = extractAccessToken(doc.token, doc)
    const expiryTimestamp = extractExpirySeconds(doc.token, doc)
    return buildNormalizedCredential({
      refreshToken,
      accessToken,
      expiryTimestamp,
      meta: extractOptionalAuthMeta(doc),
    })
  }

  // Flat shape: `{ refresh_token }`, `{ access_token, expiry_timestamp }`, or CPA Antigravity / Gemini top-level
  if (hasExplicitInvalidToken([doc])) return null
  const refreshToken = extractRefreshToken(doc)
  const accessToken = extractAccessToken(doc)
  const expiryTimestamp = extractExpirySeconds(doc)
  return buildNormalizedCredential({
    refreshToken,
    accessToken,
    expiryTimestamp,
    meta: extractOptionalAuthMeta(doc),
  })
}

function dedupeKey(item) {
  return item.refresh_token ? `rt:${item.refresh_token}` : `at:${item.access_token}:${item.expiry_timestamp}`
}

function collectNormalizedAccounts(node, results, seen, depth = 0) {
  if (depth > MAX_RECURSION_DEPTH || node == null) return
  if (Array.isArray(node)) {
    for (const item of node) {
      collectNormalizedAccounts(item, results, seen, depth + 1)
    }
    return
  }
  if (!isRecord(node)) return

  const platformTag = normalizedTag(node.platform)
  if (platformTag && !GEMINI_PROVIDERS.has(platformTag)) return

  const typeTag = normalizedTag(node.type)
  if (typeTag && !GEMINI_PROVIDERS.has(typeTag) && typeTag !== 'oauth' && !SUB2API_BUNDLE_TYPES.has(typeTag)) {
    return
  }

  const normalized = normalizeSingleAccount(node)
  if (normalized) {
    const key = dedupeKey(normalized)
    if (!seen.has(key)) {
      seen.add(key)
      results.push(normalized)
    }
    return
  }

  // If this object is a container (e.g. `{ accounts: [...] }`, `{ data: { accounts: [...] } }`), recurse
  for (const child of Object.values(node)) {
    if (child && typeof child === 'object') {
      collectNormalizedAccounts(child, results, seen, depth + 1)
    }
  }
}

function extractBareRefreshTokensFromText(text) {
  if (typeof text !== 'string' || !text.trim()) return []
  const matches = text.match(BARE_REFRESH_TOKEN_RE) || []
  const seen = new Set()
  const tokens = []
  for (const raw of matches) {
    const normalized = normalizeGeminiRefreshToken(raw)
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized)
      tokens.push(normalized)
    }
  }
  return tokens
}

/**
 * Normalize an incoming `oauth_account` payload into minimal host credentials:
 * - `{ refresh_token, access_token?, expiry_timestamp?, auth_method?, wif_provider? }`
 * - or `{ access_token, expiry_timestamp }`
 * Returns `null` if invalid, unsupported provider, or ambiguous (e.g. multiple accounts in a bundle).
 */
export function normalizeGeminiOAuthImport(input) {
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) return null
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') {
        return normalizeGeminiOAuthImport(parsed)
      }
    } catch {
      // Fall through to bare refresh token extraction (Antigravity2API style)
    }
    const tokens = extractBareRefreshTokensFromText(trimmed)
    return tokens.length === 1 ? { refresh_token: tokens[0] } : null
  }

  if (!Array.isArray(input) && !isRecord(input)) return null

  const results = []
  const seen = new Set()
  collectNormalizedAccounts(input, results, seen)
  return results.length === 1 ? results[0] : null
}
