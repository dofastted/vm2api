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
const EFFORT_SUFFIX_RE = /-(minimal|low|medium|high|xhigh|extra-high|max)$/i
const PAREN_EFFORT_RE = /\(([^()]+)\)$/

function normalizeTierToken(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^thinking_level_/, '')
  if (!s || s === 'off' || s === 'none' || s === 'disabled' || s === '0') return ''
  if (s === 'minimal') return 'minimal'
  if (s === 'low') return 'low'
  if (s === 'medium' || s === 'med' || s === 'auto' || s === 'adaptive') return 'medium'
  if (s === 'high') return 'high'
  if (s === 'xhigh' || s === 'extra_high' || s === 'extra-high' || s === 'max') return 'xhigh'
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    if (n === 0) return ''
    if (n <= 1024) return 'minimal'
    if (n <= 4096) return 'low'
    if (n <= 12288) return 'medium'
    if (n <= 24576) return 'high'
    return 'xhigh'
  }
  return ''
}

export function parseAntigravityModelSpec(rawId) {
  const raw = String(rawId || '').trim()
  if (!raw) return { raw: '', cleaned: '', base: '', impliedEffort: '', hadDecorations: false }
  let hadDecorations = false
  let work = raw
  if (/^models\//i.test(work)) {
    work = work.replace(/^models\//i, '')
    hadDecorations = true
  }
  if (/\[1m\]$/i.test(work)) {
    work = work.replace(/\[1m\]$/i, '')
    hadDecorations = true
  }
  let parenEffort = ''
  const pm = PAREN_EFFORT_RE.exec(work)
  if (pm) {
    parenEffort = normalizeTierToken(pm[1])
    work = work.slice(0, pm.index)
    hadDecorations = true
  }
  if (/-latest$/i.test(work) && work.length > '-latest'.length) {
    work = work.replace(/-latest$/i, '')
    hadDecorations = true
  }
  if (/-thinking$/i.test(work) && work.length > '-thinking'.length) {
    work = work.replace(/-thinking$/i, '')
    hadDecorations = true
  }
  const cleaned = work
  let base = cleaned
  let suffixEffort = ''
  const sm = EFFORT_SUFFIX_RE.exec(cleaned)
  if (sm && sm.index > 0) {
    base = cleaned.slice(0, sm.index)
    suffixEffort = normalizeTierToken(sm[1])
  }
  return {
    raw,
    cleaned,
    base,
    impliedEffort: parenEffort || suffixEffort,
    hadDecorations,
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
 * Only `gemini-*` and `ag-*` match; bare `claude-*` / `gpt-*` stay on native VM pools.
 */
export function isAntigravityRoutedModel(model) {
  if (typeof model !== 'string') return false
  const lower = model
    .trim()
    .replace(/^models\//i, '')
    .toLowerCase()
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
  const quota_group = ANTIGRAVITY_QUOTA_GROUPS.has(quotaGroupHint) ? quotaGroupHint : quotaGroupForModel(base, provider)
  const public_id =
    provider === 'google' ? id : id.toLowerCase().startsWith(ANTIGRAVITY_PREFIX) ? id : `${ANTIGRAVITY_PREFIX}${id}`
  return {
    id,
    public_id,
    provider,
    owned_by: provider,
    quota_group,
  }
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
  { allowUnprefixedNonGemini = false, catalogIndex = null, requestedEffort = null, defaultEffort = null } = {},
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

  const formatHit = (hit, publicIdOverride = null) => ({
    publicId: publicIdOverride || hit.public_id,
    upstreamModel: hit.id,
    provider: hit.provider,
    owned_by: hit.owned_by,
    quotaGroup: hit.quota_group,
  })

  const spec = parseAntigravityModelSpec(wanted)
  const cleanedLower = spec.cleaned.toLowerCase()
  const baseLower = spec.base.toLowerCase()
  const isGemini = baseLower.startsWith('gemini-')
  const bareGeminiWithoutEffort = isGemini && !spec.impliedEffort
  const cleanEffort = (value) => normalizeTierToken(value)

  const tierCandidates = (prefix, eff) => {
    if (!eff) return []
    if (eff === 'xhigh') {
      return [`${prefix}-xhigh`, `${prefix}-max`, `${prefix}-high`]
    }
    if (eff === 'minimal') {
      return [`${prefix}-minimal`, `${prefix}-low`]
    }
    return [`${prefix}-${eff}`]
  }

  // 0. Explicit effort on an unsuffixed Gemini model (or `model(effort)` syntax) selects `${base}-${effort}` when available.
  const explicitEff = cleanEffort(requestedEffort)
  if ((bareGeminiWithoutEffort || spec.hadDecorations) && (explicitEff || spec.impliedEffort)) {
    const targetEff = explicitEff || spec.impliedEffort
    for (const cand of tierCandidates(baseLower, targetEff)) {
      const effortHit = publicByLower.get(cand)
      if (effortHit) return formatHit(effortHit)
    }
  }

  // 1. Canonical match against public ID (`gemini-*` or `ag-*`), including cleaned `[1m]` / `-thinking` forms.
  const publicHit =
    publicByLower.get(wantedLower) || (cleanedLower !== wantedLower ? publicByLower.get(cleanedLower) : null)
  if (publicHit) {
    return formatHit(publicHit)
  }

  // 1a. Tiered model fallback (e.g. `gemini-4-carbon-high` or `gemini-4-carbon-xhigh`):
  //     try clamped tier variants first, then fall back to untiered base (`gemini-4-carbon`) while
  //     preserving canonical tiered `publicId` so downstream thinkingConfig carries the exact tier.
  const desiredTier = explicitEff || spec.impliedEffort
  if (desiredTier && baseLower) {
    for (const cand of tierCandidates(baseLower, desiredTier)) {
      const tierHit = publicByLower.get(cand)
      if (tierHit) return formatHit(tierHit)
    }
    if (isGemini || wantedLower.startsWith(ANTIGRAVITY_PREFIX)) {
      const baseHit = publicByLower.get(baseLower)
      if (baseHit) {
        const clamped =
          desiredTier === 'xhigh' && !baseLower.includes('hydrogen') && !baseLower.includes('neon')
            ? 'high'
            : desiredTier
        const canonicalPublic = spec.impliedEffort && !spec.hadDecorations ? wanted : `${baseHit.public_id}-${clamped}`
        return formatHit(baseHit, canonicalPublic)
      }
    }
  }

  // 1b. Default effort fallback for unsuffixed Gemini models when slot exposes tiered variants (e.g. `-medium`).
  const defaultEff = bareGeminiWithoutEffort ? cleanEffort(defaultEffort) : ''
  if (defaultEff) {
    for (const cand of tierCandidates(baseLower, defaultEff)) {
      const defaultHit = publicByLower.get(cand)
      if (defaultHit) return formatHit(defaultHit)
    }
  }

  // 2. Explicit `ag-` prefix stripped to match raw upstream slug (e.g. if caller sent `ag-gemini-*` or non-catalog model).
  if (cleanedLower.startsWith(ANTIGRAVITY_PREFIX)) {
    const stripped = cleanedLower.slice(ANTIGRAVITY_PREFIX.length)
    const rawHit = rawByLower.get(stripped)
    if (rawHit) {
      return formatHit(rawHit)
    }
    const strippedBase = baseLower.startsWith(ANTIGRAVITY_PREFIX) ? baseLower.slice(ANTIGRAVITY_PREFIX.length) : ''
    if (strippedBase) {
      const baseRawHit = rawByLower.get(strippedBase)
      if (baseRawHit) {
        return formatHit(baseRawHit, spec.cleaned)
      }
    }
  }

  // 3. Dedicated `gemini` key backward compatibility for bare non-Gemini slugs (e.g. `claude-sonnet-4-6-high`).
  if (allowUnprefixedNonGemini) {
    const rawHit = rawByLower.get(cleanedLower)
    if (rawHit) {
      return formatHit(rawHit, spec.cleaned)
    }
    if (baseLower && baseLower !== cleanedLower) {
      const baseRawHit = rawByLower.get(baseLower)
      if (baseRawHit) {
        return formatHit(baseRawHit, spec.cleaned)
      }
    }
  }

  return null
}
