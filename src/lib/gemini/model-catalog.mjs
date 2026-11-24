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
const RAW_MODEL_MAX_LEN = 128
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/

const THINKING_SUFFIX_MAP = Object.freeze({
  none: 'none',
  off: 'none',
  disabled: 'none',
  nothinking: 'none',
  'no-thinking': 'none',
  minimal: 'minimal',
  min: 'minimal',
  low: 'low',
  medium: 'medium',
  med: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
  thinking: 'thinking',
  think: 'thinking',
})

const WRAPPED_SUFFIX_RE = /^(.*?)(?:\s*\(([a-z0-9_-]+)\)|\s*\[([a-z0-9_-]+)\]|:([a-z0-9_-]+))\s*$/i
const HYPHEN_SUFFIX_RE = /^(.+?)-(none|off|disabled|nothinking|no-thinking|minimal|min|low|medium|med|high|xhigh|max|thinking|think)$/i
const DEFAULT_VARIANT_FALLBACK_SUFFIXES = ['high', 'medium', 'low']

function slugifyModelCore(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Parse a client-supplied Gemini / Antigravity model string into canonical slug(s)
 * and an optional extracted thinking effort suffix.
 *
 * Accepts canonical slugs (`gemini-4-neon`, `gemini-3.1-pro-high`, `ag-claude-sonnet-4-6-high`),
 * `models/`-prefixed names (`models/gemini-4-neon`), display-style names (`Gemini 4 Neon (high)`,
 * `Gemini 3.1 Pro (low)`, `Gemini 2.5 Flash Thinking`), and explicit suffix forms
 * (`gemini-4-neon (high)`, `gemini-4-neon(high)`, `gemini-4-neon [high]`, `gemini-4-neon:high`).
 *
 * Preserves the `all`-key safety boundary: bare `claude-*` / `Claude Sonnet 4.6 (high)` / `gpt-*`
 * report `isGeminiFamily: false` and `isAntigravityPrefixed: false`.
 */
export function parseGeminiModelSpec(rawModel) {
  if (typeof rawModel !== 'string') {
    return {
      valid: false,
      raw: '',
      canonicalSlug: '',
      baseSlug: '',
      suffixedSlug: '',
      rawSuffix: '',
      thinkingEffort: '',
      hasExplicitThinkingSuffix: false,
      candidateSlugs: [],
      isGeminiFamily: false,
      isAntigravityPrefixed: false,
    }
  }
  const raw = rawModel.trim()
  if (!raw || raw.length > RAW_MODEL_MAX_LEN || CONTROL_CHARS_RE.test(raw)) {
    return {
      valid: false,
      raw,
      canonicalSlug: '',
      baseSlug: '',
      suffixedSlug: '',
      rawSuffix: '',
      thinkingEffort: '',
      hasExplicitThinkingSuffix: false,
      candidateSlugs: [],
      isGeminiFamily: false,
      isAntigravityPrefixed: false,
    }
  }

  let body = raw.replace(/^models\//i, '').trim()
  let rawSuffix = ''
  let thinkingEffort = ''
  let explicitWrapper = false

  const wrapped = WRAPPED_SUFFIX_RE.exec(body)
  if (wrapped) {
    const token = String(wrapped[2] || wrapped[3] || wrapped[4] || '')
      .trim()
      .toLowerCase()
    const mapped = THINKING_SUFFIX_MAP[token]
    if (mapped && wrapped[1].trim()) {
      body = wrapped[1].trim()
      rawSuffix = token
      thinkingEffort = mapped
      explicitWrapper = true
    }
  }

  const normalizedCore = slugifyModelCore(body)
  if (!normalizedCore || !MODEL_SLUG_RE.test(normalizedCore)) {
    return {
      valid: false,
      raw,
      canonicalSlug: '',
      baseSlug: '',
      suffixedSlug: '',
      rawSuffix: '',
      thinkingEffort: '',
      hasExplicitThinkingSuffix: false,
      candidateSlugs: [],
      isGeminiFamily: false,
      isAntigravityPrefixed: false,
    }
  }

  let baseSlug = normalizedCore
  if (!explicitWrapper) {
    const hyphen = HYPHEN_SUFFIX_RE.exec(normalizedCore)
    if (hyphen && MODEL_SLUG_RE.test(hyphen[1])) {
      baseSlug = hyphen[1]
      rawSuffix = hyphen[2].toLowerCase()
      thinkingEffort = THINKING_SUFFIX_MAP[rawSuffix] || ''
    }
  }

  const suffixedSlug =
    rawSuffix && MODEL_SLUG_RE.test(`${baseSlug}-${rawSuffix}`) ? `${baseSlug}-${rawSuffix}` : ''
  const effortSlug =
    thinkingEffort && thinkingEffort !== rawSuffix && MODEL_SLUG_RE.test(`${baseSlug}-${thinkingEffort}`)
      ? `${baseSlug}-${thinkingEffort}`
      : ''

  const candidateSlugs = []
  const pushCandidate = (slug) => {
    if (slug && MODEL_SLUG_RE.test(slug) && !candidateSlugs.includes(slug)) {
      candidateSlugs.push(slug)
    }
  }
  if (explicitWrapper) {
    pushCandidate(suffixedSlug)
    pushCandidate(effortSlug)
    pushCandidate(baseSlug)
  } else {
    pushCandidate(normalizedCore)
    pushCandidate(effortSlug)
    pushCandidate(baseSlug)
  }

  const canonicalSlug = candidateSlugs[0] || normalizedCore
  const isGeminiFamily = baseSlug === 'gemini' || baseSlug.startsWith('gemini-')
  const isAntigravityPrefixed = baseSlug.startsWith(ANTIGRAVITY_PREFIX)

  return {
    valid: true,
    raw,
    canonicalSlug,
    baseSlug,
    suffixedSlug,
    rawSuffix,
    thinkingEffort,
    hasExplicitThinkingSuffix: explicitWrapper,
    candidateSlugs,
    isGeminiFamily,
    isAntigravityPrefixed,
  }
}

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
 * Matches Gemini-family slugs & display names (e.g. `gemini-4-neon`, `Gemini 4 Neon (high)`,
 * `models/gemini-3.1-pro-high`) and `ag-*` prefixed models; bare `claude-*` / `gpt-*`
 * stay on native VM pools.
 */
export function isAntigravityRoutedModel(model) {
  const spec = parseGeminiModelSpec(model)
  return spec.valid && (spec.isGeminiFamily || spec.isAntigravityPrefixed)
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
  const spec = parseGeminiModelSpec(requestedId)
  if (!spec.valid) return null
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

  const lookupCandidate = (candidate, matchedSuffixInModel) => {
    // 1. Canonical match against public ID (`gemini-*` or `ag-*`).
    const publicHit = publicByLower.get(candidate)
    if (publicHit) {
      return {
        publicId: publicHit.public_id,
        upstreamModel: publicHit.id,
        provider: publicHit.provider,
        owned_by: publicHit.owned_by,
        quotaGroup: publicHit.quota_group,
        thinkingEffort: spec.thinkingEffort,
        matchedSuffixInModel,
      }
    }

    // 2. Explicit `ag-` prefix stripped to match raw upstream slug.
    if (candidate.startsWith(ANTIGRAVITY_PREFIX)) {
      const stripped = candidate.slice(ANTIGRAVITY_PREFIX.length)
      const rawHit = rawByLower.get(stripped)
      if (rawHit) {
        return {
          publicId: rawHit.public_id,
          upstreamModel: rawHit.id,
          provider: rawHit.provider,
          owned_by: rawHit.owned_by,
          quotaGroup: rawHit.quota_group,
          thinkingEffort: spec.thinkingEffort,
          matchedSuffixInModel,
        }
      }
    }

    // 3. Dedicated `gemini` key backward compatibility for bare non-Gemini slugs.
    if (allowUnprefixedNonGemini) {
      const rawHit = rawByLower.get(candidate)
      if (rawHit) {
        return {
          publicId: candidate === spec.raw.toLowerCase() ? spec.raw : candidate,
          upstreamModel: rawHit.id,
          provider: rawHit.provider,
          owned_by: rawHit.owned_by,
          quotaGroup: rawHit.quota_group,
          thinkingEffort: spec.thinkingEffort,
          matchedSuffixInModel,
        }
      }
    }

    return null
  }

  for (const candidate of spec.candidateSlugs) {
    const matchedSuffixInModel = Boolean(spec.thinkingEffort && candidate !== spec.baseSlug)
    const hit = lookupCandidate(candidate, matchedSuffixInModel)
    if (hit) return hit
  }

  // 4. If caller requested a bare base Gemini/ag model without suffix (e.g. `Gemini 3.1 Pro`)
  // and the account only advertises effort-suffixed variants (`gemini-3.1-pro-high`), fall back
  // to the highest available suffixed variant.
  if (!spec.thinkingEffort) {
    for (const suffix of DEFAULT_VARIANT_FALLBACK_SUFFIXES) {
      const hit = lookupCandidate(`${spec.baseSlug}-${suffix}`, false)
      if (hit) return hit
    }
  }

  return null
}
