/**
 * Single source of truth for Antigravity model family classification, `ag-` prefixing,
 * upstream model resolution, and independent quota-group mapping.
 *
 * Public naming convention:
 *   - Google Gemini models stay unprefixed: `gemini-4-neon`, `gemini-3.1-pro-high`
 *   - Non-Gemini Antigravity-derived models (Anthropic Claude, OpenAI OSS, etc.)
 *     are exposed with the `ag-` prefix: `ag-claude-sonnet-4-6-high`, `ag-gpt-oss-120b-medium`
 *   - Native Anthropic (`claude-*`) and OpenAI (`gpt-*`) models are never hijacked on `all` keys.
 */

export const ANTIGRAVITY_PREFIX = 'ag-'
export const ANTIGRAVITY_PROVIDERS = new Set(['google', 'anthropic', 'openai'])
export const ANTIGRAVITY_QUOTA_GROUPS = new Set(['gemini', 'gemini-argon-wtu', '3p'])

const MODEL_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/

function normalizeProvider(value) {
  if (typeof value !== 'string') return null
  const lower = value.trim().toLowerCase()
  if (lower === 'google' || lower === 'model_provider_google') return 'google'
  if (lower === 'anthropic' || lower === 'claude' || lower === 'model_provider_anthropic') return 'anthropic'
  if (lower === 'openai' || lower === 'gpt' || lower === 'model_provider_openai') return 'openai'
  return null
}

function inferProviderFromSlug(rawId) {
  const lower = String(rawId || '')
    .trim()
    .toLowerCase()
  if (lower.startsWith('claude-')) return 'anthropic'
  if (/^(gpt-|o[1-9]|chatgpt|codex-)/.test(lower)) return 'openai'
  return 'google'
}

export function stripAntigravityPrefix(model) {
  const s = String(model || '').trim()
  if (!s) return ''
  return s.toLowerCase().startsWith(ANTIGRAVITY_PREFIX) ? s.slice(ANTIGRAVITY_PREFIX.length) : s
}

/**
 * Whether `model` belongs to the Antigravity routing namespace for `all`-group keys.
 * Only `gemini-*` and `ag-*` match; bare `claude-*` / `gpt-*` stay on native VM pools.
 */
export function isAntigravityRoutedModel(model) {
  if (typeof model !== 'string') return false
  const lower = model.trim().toLowerCase()
  return lower.startsWith('gemini-') || lower.startsWith(ANTIGRAVITY_PREFIX)
}

export function quotaGroupForModel(rawId, providerHint = null) {
  const base = stripAntigravityPrefix(rawId).toLowerCase()
  const provider = normalizeProvider(providerHint) || inferProviderFromSlug(base)
  if (provider !== 'google') return '3p'
  if (base.includes('argon')) return 'gemini-argon-wtu'
  return 'gemini'
}

export function classifyAntigravityModel(rawId, providerHint = null, quotaGroupHint = null) {
  const id = String(rawId || '').trim()
  const base = stripAntigravityPrefix(id)
  const provider = normalizeProvider(providerHint) || inferProviderFromSlug(base)
  const quota_group = ANTIGRAVITY_QUOTA_GROUPS.has(quotaGroupHint)
    ? quotaGroupHint
    : quotaGroupForModel(base, provider)
  const public_id =
    provider === 'google'
      ? id
      : id.toLowerCase().startsWith(ANTIGRAVITY_PREFIX)
        ? id
        : `${ANTIGRAVITY_PREFIX}${id}`
  return {
    id,
    public_id,
    provider,
    owned_by: provider,
    quota_group,
  }
}

export function publicModelId(rawId, providerHint = null) {
  return classifyAntigravityModel(rawId, providerHint).public_id
}

/**
 * Build a Map<rawModelId, { provider, quota_group }> from `environment.account.model_catalog`.
 */
export function indexAccountModelCatalog(account) {
  const map = new Map()
  const entries = account?.model_catalog
  if (!Array.isArray(entries)) return map
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' && MODEL_SLUG_RE.test(item.id) ? item.id : null
    if (!id) continue
    const provider = normalizeProvider(item.provider) || inferProviderFromSlug(id)
    const quota_group = ANTIGRAVITY_QUOTA_GROUPS.has(item.quota_group)
      ? item.quota_group
      : quotaGroupForModel(id, provider)
    map.set(id, { provider, quota_group })
  }
  return map
}

/**
 * Resolve a client-requested model ID against an account's raw discovered upstream model slugs.
 *
 * - `ag-claude-sonnet-4-6-high` -> matches raw `claude-sonnet-4-6-high` (upstream) while keeping
 *   `publicId: 'ag-claude-sonnet-4-6-high'` for client responses.
 * - `gemini-4-neon` -> matches raw `gemini-4-neon`.
 * - Bare `claude-sonnet-4-6-high` is only accepted when `allowUnprefixedNonGemini` is true
 *   (dedicated `gemini` API keys for backwards compatibility; NEVER for `all` keys).
 */
export function resolveUpstreamModel(
  requestedId,
  availableRawModels,
  { allowUnprefixedNonGemini = false, catalogIndex = null } = {},
) {
  if (typeof requestedId !== 'string' || !requestedId.trim()) return null
  const wanted = requestedId.trim()
  const wantedLower = wanted.toLowerCase()
  if (!Array.isArray(availableRawModels) || !availableRawModels.length) return null

  const rawByLower = new Map()
  const publicByLower = new Map()
  for (const raw of availableRawModels) {
    if (typeof raw !== 'string' || !raw) continue
    const metaHint = catalogIndex?.get?.(raw) || null
    const classified = classifyAntigravityModel(raw, metaHint?.provider, metaHint?.quota_group)
    rawByLower.set(raw.toLowerCase(), classified)
    publicByLower.set(classified.public_id.toLowerCase(), classified)
  }

  // 1. Canonical match against public ID (`gemini-*` or `ag-*`).
  const publicHit = publicByLower.get(wantedLower)
  if (publicHit) {
    return {
      publicId: publicHit.public_id,
      upstreamModel: publicHit.id,
      provider: publicHit.provider,
      owned_by: publicHit.owned_by,
      quotaGroup: publicHit.quota_group,
    }
  }

  // 2. Explicit `ag-` prefix stripped to match raw upstream slug (e.g. if caller sent `ag-gemini-*` or non-catalog model).
  if (wantedLower.startsWith(ANTIGRAVITY_PREFIX)) {
    const stripped = wantedLower.slice(ANTIGRAVITY_PREFIX.length)
    const rawHit = rawByLower.get(stripped)
    if (rawHit) {
      return {
        publicId: rawHit.public_id,
        upstreamModel: rawHit.id,
        provider: rawHit.provider,
        owned_by: rawHit.owned_by,
        quotaGroup: rawHit.quota_group,
      }
    }
  }

  // 3. Dedicated `gemini` key backward compatibility for bare non-Gemini slugs (e.g. `claude-sonnet-4-6-high`).
  if (allowUnprefixedNonGemini) {
    const rawHit = rawByLower.get(wantedLower)
    if (rawHit) {
      return {
        publicId: wanted,
        upstreamModel: rawHit.id,
        provider: rawHit.provider,
        owned_by: rawHit.owned_by,
        quotaGroup: rawHit.quota_group,
      }
    }
  }

  return null
}
