/**
 * Normalize imported Gemini / Antigravity OAuth account documents into the
 * minimal host credential `{ access_token, expiry_timestamp }` (Unix seconds).
 *
 * Supported formats:
 * 1. Normalized payload: `{ access_token, expiry_timestamp }`
 * 2. Antigravity Tools:  `{ token: { access_token, expiry_timestamp } }`
 * 3. CLIProxyAPI (CPA):
 *    - Antigravity auth file: `{ type: "antigravity", access_token, expired | timestamp + expires_in }`
 *    - Gemini CLI auth file:  `{ type: "gemini", token: { access_token, expiry } }`
 * 4. sub2api:
 *    - Single account: `{ platform: "gemini" | "antigravity", type: "oauth", credentials: { access_token, expires_at } }`
 *    - Export bundle:  `{ accounts: [...] }` (or `{ data: { accounts: [...] } }`) containing a single matching OAuth account
 *
 * Security boundary: secrets other than `access_token` (e.g. `refresh_token`)
 * and metadata snapshots are never forwarded to the Gemini host.
 */

const OAUTH_ACCESS_TOKEN_RE = /^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/
const MAX_EXPIRY_SECONDS = 253402300800
const MILLISECOND_THRESHOLD = 1_000_000_000_000
const GEMINI_PROVIDERS = new Set(['gemini', 'antigravity', 'gemini-cli'])
const SUB2API_BUNDLE_TYPES = new Set(['sub2api-data', 'sub2api-bundle'])

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
        if (token && OAUTH_ACCESS_TOKEN_RE.test(token)) return token
        if (token) return null
      }
    }
  }
  return null
}

function normalizeSingleAccount(doc) {
  if (!isRecord(doc)) return null

  // sub2api single account object: `{ platform, type, credentials: { ... } }`
  if (isRecord(doc.credentials)) {
    const platform = normalizedTag(doc.platform)
    if (platform && !GEMINI_PROVIDERS.has(platform)) return null
    const accountType = normalizedTag(doc.type)
    if (accountType && accountType !== 'oauth') return null
    const accessToken = extractAccessToken(doc.credentials)
    const expiryTimestamp = extractExpirySeconds(doc.credentials)
    if (!accessToken || expiryTimestamp == null) return null
    return { access_token: accessToken, expiry_timestamp: expiryTimestamp }
  }

  // Reject explicitly non-Gemini providers (e.g. CPA claude / codex / kimi / xai)
  const typeTag = normalizedTag(doc.type)
  if (typeTag && !GEMINI_PROVIDERS.has(typeTag)) return null
  const platformTag = normalizedTag(doc.platform)
  if (platformTag && !GEMINI_PROVIDERS.has(platformTag)) return null

  // Nested `token` shape: Antigravity Tools or CPA Gemini CLI (`token.expiry` RFC3339)
  if (isRecord(doc.token)) {
    const accessToken = extractAccessToken(doc.token, doc)
    const expiryTimestamp = extractExpirySeconds(doc.token, doc)
    if (!accessToken || expiryTimestamp == null) return null
    return { access_token: accessToken, expiry_timestamp: expiryTimestamp }
  }

  // Flat shape: normalized `{ access_token, expiry_timestamp }` or CPA Antigravity / Gemini top-level
  const accessToken = extractAccessToken(doc)
  const expiryTimestamp = extractExpirySeconds(doc)
  if (!accessToken || expiryTimestamp == null) return null
  return { access_token: accessToken, expiry_timestamp: expiryTimestamp }
}

/**
 * Normalize an incoming `oauth_account` payload into `{ access_token, expiry_timestamp }`.
 * Returns `null` if invalid, unsupported provider, or ambiguous (e.g. multiple accounts in a bundle).
 */
export function normalizeGeminiOAuthImport(input) {
  if (!isRecord(input)) return null

  const bundle = isRecord(input.data) && Array.isArray(input.data.accounts) ? input.data : input
  if (Array.isArray(bundle.accounts)) {
    const bundleType = normalizedTag(bundle.type)
    if (bundleType && !SUB2API_BUNDLE_TYPES.has(bundleType)) return null
    const matched = []
    for (const item of bundle.accounts) {
      if (!isRecord(item)) continue
      const platform = normalizedTag(item.platform)
      if (!GEMINI_PROVIDERS.has(platform)) continue
      const normalized = normalizeSingleAccount(item)
      if (normalized) matched.push(normalized)
    }
    return matched.length === 1 ? matched[0] : null
  }

  return normalizeSingleAccount(input)
}
