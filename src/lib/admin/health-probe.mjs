/**
 * Multi-platform, multi-model health snapshot + unofficial probe intercept.
 *
 * Three independent platforms: `anthropic`, `openai`, `google` (legacy alias `gemini`).
 * Each platform owns its own enabled flag, schedule interval, cache TTL, model set
 * (`all_models` dynamic catalog mode or explicit `models` list), and per-model snapshot map.
 * Real probes are strictly serialized across models, slots, and platforms so one completes
 * before the next starts. Inbound health probes match strictly per model (after canonical
 * alias resolution) and never replay a different model's snapshot.
 */
import crypto from 'node:crypto'
import { verifyDirectClaudeCodeHeaders, verifyOfficialClaudeCode } from '../identity/official-cc-verifier.mjs'
import { vmHasClaudeCredential } from '../vm/vm-registry.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import { activeHoursOf, evaluateActiveHours } from '../pool/active-hours.mjs'
import { slotAllowsModel } from '../pool/slot-model-gate.mjs'
import { fromClaudeToOpenAIChat, fromClaudeToOpenAICompletions, fromClaudeToResponses } from '../protocol/convert.mjs'
import { isGptSeriesId } from '../protocol/gpt-ids.mjs'
import { listGptPolicyModels, resolveGptFastAlias } from '../protocol/gpt-model-policy.mjs'
import { isGeminiSeriesId, listGeminiPolicyModels } from '../protocol/gemini-model-policy.mjs'
import { listPolicyModels, resolvePolicyModelId } from '../protocol/model-policy.mjs'
import { canonicalizeDottedClaudeId } from '../protocol/models.mjs'
import { stripClaudeCode1mSuffix } from '../protocol/context-1m.mjs'
import { detectInboundPlatform } from '../protocol/platform-detect.mjs'
import { parseAntigravityModelSpec } from '../gemini/model-catalog.mjs'

export const HEALTH_REAL_HEADER = 'x-kin-health-real'
export const HEALTH_VIA_CACHE = 'health-cache'
export const HEALTH_VIA_UNAVAILABLE = 'health_unavailable'
export const HEALTH_PROBE_UA = 'kin-health-probe/1.0'
export const HEALTH_PLATFORMS = Object.freeze(['anthropic', 'openai', 'google'])

const DEFAULT_ANTHROPIC = Object.freeze({
  enabled: false,
  interval_sec: 600,
  cache_ttl_sec: 900,
  all_models: false,
  models: Object.freeze(['claude-haiku-4-5']),
  probe_all_slots: false,
  prompt: 'hello',
  max_tokens: 64,
  timeout_ms: 60_000,
  outbound_mode: 'official',
  vm_ids: Object.freeze([]),
})

const DEFAULT_OPENAI = Object.freeze({
  enabled: false,
  interval_sec: 600,
  cache_ttl_sec: 900,
  all_models: false,
  models: Object.freeze([]),
  probe_all_slots: false,
  prompt: 'hello',
  max_tokens: 64,
  timeout_ms: 60_000,
  vm_ids: Object.freeze([]),
})

const DEFAULT_GOOGLE = Object.freeze({
  enabled: false,
  interval_sec: 3600,
  cache_ttl_sec: 5400,
  all_models: false,
  models: Object.freeze([]),
  prompt: 'hello',
  timeout_ms: 60_000,
})

export const DEFAULT_HEALTH_PROBE = Object.freeze({
  // Derived compatibility flag: true when any platform is enabled.
  enabled: false,
  interval_sec: 600,
  cache_ttl_sec: 900,
  max_stale_sec: 900,
  cache_models: Object.freeze([]),
  cache_model: '',
  intercept_unofficial: true,
  // Claude Code warmup / title / suggestion / haiku ping: mock before scheduling.
  intercept_warmup: true,
  fail_closed: true,
  run_on_start: true,
  // Mirror of anthropic.probe_all_slots for legacy callers.
  probe_all_slots: false,
  concurrency: 1,
  anthropic: DEFAULT_ANTHROPIC,
  openai: DEFAULT_OPENAI,
  google: DEFAULT_GOOGLE,
  // Legacy read-only mirrors derived from the 3 platform blocks.
  real: Object.freeze({
    model: 'claude-haiku-4-5',
    prompt: 'hello',
    max_tokens: 64,
    timeout_ms: 60_000,
    outbound_mode: 'official',
    vm_ids: Object.freeze([]),
    openai_model: '',
  }),
  gemini: Object.freeze({
    enabled: false,
    interval_sec: 3600,
    cache_ttl_sec: 5400,
    all_models: false,
    models: Object.freeze([]),
    model: '',
    prompt: 'hello',
    timeout_ms: 60_000,
  }),
  match: Object.freeze({
    max_tokens: 32,
    max_prompt_chars: 16,
    prompts: Object.freeze(['hi', 'hello', 'ping', 'test', '健康']),
    require_no_system: true,
    require_no_tools: true,
    require_single_user: true,
    skip_official: true,
    ua_regex: '',
    // OpenAI Chat and Responses probes can omit the token limit.
    allow_missing_max_tokens: true,
    // Match the account-test shape: CC system banner, "hi", 1024 tokens, temperature 1.
    sub2api_account_test: true,
  }),
})

export function normalizeHealthPlatform(raw, fallback = 'anthropic') {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
  if (s === 'anthropic' || s === 'claude') return 'anthropic'
  if (s === 'openai' || s === 'gpt' || s === 'codex' || s === 'chatgpt') return 'openai'
  if (s === 'google' || s === 'gemini') return 'google'
  return fallback
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function asBool(value, fallback) {
  if (value == null) return fallback
  if (typeof value === 'boolean') return value
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  return fallback
}

function normalizePromptList(input, fallback) {
  const src = Array.isArray(input) ? input : fallback
  const out = []
  const seen = new Set()
  for (const raw of src) {
    const t = String(raw || '')
      .trim()
      .toLowerCase()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(String(raw).trim())
  }
  return out.length ? out : [...fallback]
}

function normalizeVmIds(input) {
  if (!Array.isArray(input)) return []
  return [...new Set(input.map((id) => String(id || '').trim()).filter(isValidVmId))]
}

function normalizeModelId(id) {
  return String(id || '')
    .toLowerCase()
    .split('[')[0]
    .trim()
}

function bareModelId(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  return s.split('/').filter(Boolean).pop() || s
}

function normalizeModelList(input, platform = null) {
  let src = input
  if (typeof src === 'string') {
    src = src.split(/[,，\n]+/)
  }
  if (!Array.isArray(src)) return []
  const out = []
  const seen = new Set()
  for (const raw of src) {
    const id = String(raw || '')
      .trim()
      .slice(0, 120)
    if (!id) continue
    const key = platform ? canonicalHealthModelKey(platform, id) : normalizeModelId(id)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(id)
  }
  return out
}

function normalizeCacheModels(input) {
  return normalizeModelList(input)
}

/**
 * Canonical lookup key for per-model caching and deduplication.
 * - anthropic: strips prefix/[1m], canonicalizes dotted Claude ids, resolves policy alias
 *   (e.g. `claude-haiku-4-5` & `claude-haiku-4-5-20251001` & `haiku` share one key).
 * - openai: strips prefix and resolves active `-fast` aliases to their base model.
 * - google: strips `models/`, `[1m]`, paren effort, `-latest`, `-thinking` via Antigravity spec.
 */
export function canonicalHealthModelKey(platform, rawModel) {
  const p = normalizeHealthPlatform(platform)
  const raw = String(rawModel || '').trim()
  if (!raw) return ''
  if (p === 'google') {
    const stripped = raw.replace(/^(?:google|gemini)\//i, '')
    const spec = parseAntigravityModelSpec(stripped)
    return String(spec.cleaned || bareModelId(stripped))
      .trim()
      .toLowerCase()
  }
  if (p === 'openai') {
    const bare = bareModelId(raw)
    try {
      const fast = resolveGptFastAlias(bare)
      if (fast.kind === 'fast' && fast.base) return String(fast.base).trim().toLowerCase()
    } catch {}
    return bare.toLowerCase()
  }
  const bare = canonicalizeDottedClaudeId(stripClaudeCode1mSuffix(bareModelId(raw)))
  if (!bare) return ''
  if (bare.toLowerCase() === 'auto') return 'auto'
  try {
    const resolved = resolvePolicyModelId(bare)
    if (resolved) return String(resolved).trim().toLowerCase()
  } catch {}
  return bare.toLowerCase()
}

function googleBaseModelKey(rawModel) {
  const raw = String(rawModel || '').trim()
  if (!raw) return ''
  const stripped = raw.replace(/^(?:google|gemini)\//i, '')
  const spec = parseAntigravityModelSpec(stripped)
  return String(spec.base || spec.cleaned || bareModelId(stripped))
    .trim()
    .toLowerCase()
}

export function platformConfigOf(cfg = DEFAULT_HEALTH_PROBE, platform = 'anthropic') {
  const p = normalizeHealthPlatform(platform)
  if (cfg && typeof cfg[p] === 'object' && cfg[p]) return cfg[p]
  if (p === 'google' && cfg?.gemini && typeof cfg.gemini === 'object') return cfg.gemini
  return DEFAULT_HEALTH_PROBE[p]
}

export function cacheTtlSec(cfg = DEFAULT_HEALTH_PROBE, platform = 'anthropic') {
  const p = normalizeHealthPlatform(platform)
  const pCfg = platformConfigOf(cfg, p)
  const direct = Number(pCfg?.cache_ttl_sec)
  if (Number.isFinite(direct) && direct > 0) return direct
  if (p === 'google') {
    const gemTtl = Number(cfg?.gemini?.cache_ttl_sec)
    if (Number.isFinite(gemTtl) && gemTtl > 0) return gemTtl
    return DEFAULT_GOOGLE.cache_ttl_sec
  }
  const ttl = Number(cfg?.cache_ttl_sec)
  if (Number.isFinite(ttl) && ttl > 0) return ttl
  const stale = Number(cfg?.max_stale_sec)
  if (Number.isFinite(stale) && stale > 0) return stale
  return DEFAULT_HEALTH_PROBE.cache_ttl_sec
}

export function inboundMatchesCacheModels(body = {}, cfg = DEFAULT_HEALTH_PROBE) {
  const list = cfg?.cache_models || []
  if (!list.length) return true
  const inbound = normalizeModelId(body?.model)
  if (!inbound) return false
  return list.some((id) => {
    const n = normalizeModelId(id)
    return inbound === n || inbound.startsWith(n) || n.startsWith(inbound)
  })
}

export function resolveCacheResponseModel(inbound = {}, snapshot = {}, cfg = DEFAULT_HEALTH_PROBE) {
  const pinned = String(cfg?.cache_model || '').trim()
  if (pinned && (healthPlatformOf(inbound) !== 'google' || isGeminiSeriesId(pinned))) return pinned
  return String(
    inbound?.model || snapshot?.model || cfg?.anthropic?.models?.[0] || cfg?.real?.model || 'claude-haiku-4-5',
  ).trim()
}

function hasExplicitPlatformBlocks(src) {
  return (
    (src.anthropic != null && typeof src.anthropic === 'object') ||
    (src.openai != null && typeof src.openai === 'object') ||
    (src.google != null && typeof src.google === 'object')
  )
}

function resolvePlatformModelsInput(pSrc, fallbackList, platform) {
  if (pSrc && Object.prototype.hasOwnProperty.call(pSrc, 'models')) {
    return normalizeModelList(pSrc.models, platform)
  }
  if (pSrc && typeof pSrc.model === 'string' && pSrc.model.trim()) {
    return normalizeModelList([pSrc.model], platform)
  }
  return normalizeModelList(fallbackList, platform)
}

export function normalizeHealthProbeConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const realSrc = src.real && typeof src.real === 'object' ? src.real : {}
  const geminiSrc = src.gemini && typeof src.gemini === 'object' ? src.gemini : {}
  const matchSrc = src.match && typeof src.match === 'object' ? src.match : {}
  const explicitPlatforms = hasExplicitPlatformBlocks(src)

  const legacyEnabled = asBool(src.enabled, false)
  const legacyInterval = clampInt(src.interval_sec, 30, 86400, DEFAULT_ANTHROPIC.interval_sec)
  const legacyTtlRaw = src.cache_ttl_sec ?? src.max_stale_sec
  const legacyTtlFallback = Math.max(DEFAULT_ANTHROPIC.cache_ttl_sec, legacyInterval)
  const legacyTtl = clampInt(legacyTtlRaw, 30, 172800, legacyTtlFallback)
  const legacyProbeAllSlots = asBool(src.probe_all_slots, DEFAULT_ANTHROPIC.probe_all_slots)
  const legacyPrompt =
    String(realSrc.prompt ?? DEFAULT_ANTHROPIC.prompt)
      .trim()
      .slice(0, 200) || DEFAULT_ANTHROPIC.prompt
  const legacyMaxTokens = clampInt(realSrc.max_tokens, 1, 128000, DEFAULT_ANTHROPIC.max_tokens)
  const legacyTimeoutMs = clampInt(realSrc.timeout_ms, 10_000, 180_000, DEFAULT_ANTHROPIC.timeout_ms)
  const legacyModeRaw = String(realSrc.outbound_mode || DEFAULT_ANTHROPIC.outbound_mode).toLowerCase()
  const legacyOutboundMode = legacyModeRaw === 'unofficial' ? 'unofficial' : 'official'
  const legacyVmIds = normalizeVmIds(realSrc.vm_ids)
  const legacyAnthropicModel =
    String(realSrc.model || DEFAULT_ANTHROPIC.models[0]).trim() || DEFAULT_ANTHROPIC.models[0]
  const legacyOpenaiModel = String(realSrc.openai_model || '')
    .trim()
    .slice(0, 120)
  const legacyGeminiInterval = clampInt(geminiSrc.interval_sec, 60, 86400, DEFAULT_GOOGLE.interval_sec)
  const legacyGeminiTtlFallback = Math.max(DEFAULT_GOOGLE.cache_ttl_sec, legacyGeminiInterval)
  const legacyGeminiTtl = clampInt(geminiSrc.cache_ttl_sec, 60, 172800, legacyGeminiTtlFallback)
  const legacyGeminiModels = Object.prototype.hasOwnProperty.call(geminiSrc, 'models')
    ? normalizeModelList(geminiSrc.models, 'google')
    : geminiSrc.model && String(geminiSrc.model).trim()
      ? normalizeModelList([geminiSrc.model], 'google')
      : []

  // --- Anthropic ---
  const aSrc = src.anthropic && typeof src.anthropic === 'object' ? src.anthropic : null
  const anthropicInterval = clampInt(
    aSrc?.interval_sec,
    30,
    86400,
    explicitPlatforms ? DEFAULT_ANTHROPIC.interval_sec : legacyInterval,
  )
  const anthropicTtlFallback = Math.max(
    explicitPlatforms ? DEFAULT_ANTHROPIC.cache_ttl_sec : legacyTtl,
    anthropicInterval,
  )
  const anthropicTtl = clampInt(aSrc?.cache_ttl_sec, 30, 172800, explicitPlatforms ? anthropicTtlFallback : legacyTtl)
  const anthropicModeRaw = String(aSrc?.outbound_mode || legacyOutboundMode).toLowerCase()
  const anthropic = {
    enabled: aSrc ? asBool(aSrc.enabled, false) : explicitPlatforms ? false : legacyEnabled,
    interval_sec: anthropicInterval,
    cache_ttl_sec: anthropicTtl,
    all_models: asBool(aSrc?.all_models, DEFAULT_ANTHROPIC.all_models),
    models: resolvePlatformModelsInput(
      aSrc,
      explicitPlatforms ? DEFAULT_ANTHROPIC.models : [legacyAnthropicModel],
      'anthropic',
    ),
    probe_all_slots: asBool(
      aSrc?.probe_all_slots,
      explicitPlatforms ? DEFAULT_ANTHROPIC.probe_all_slots : legacyProbeAllSlots,
    ),
    prompt:
      String(aSrc?.prompt ?? legacyPrompt)
        .trim()
        .slice(0, 200) || DEFAULT_ANTHROPIC.prompt,
    max_tokens: clampInt(aSrc?.max_tokens, 1, 128000, legacyMaxTokens),
    timeout_ms: clampInt(aSrc?.timeout_ms, 10_000, 180_000, legacyTimeoutMs),
    outbound_mode: anthropicModeRaw === 'unofficial' ? 'unofficial' : 'official',
    vm_ids:
      aSrc && Object.prototype.hasOwnProperty.call(aSrc, 'vm_ids') ? normalizeVmIds(aSrc.vm_ids) : [...legacyVmIds],
  }

  // --- OpenAI ---
  const oSrc = src.openai && typeof src.openai === 'object' ? src.openai : null
  const openaiModels = resolvePlatformModelsInput(
    oSrc,
    explicitPlatforms ? DEFAULT_OPENAI.models : legacyOpenaiModel ? [legacyOpenaiModel] : [],
    'openai',
  )
  const openaiInterval = clampInt(
    oSrc?.interval_sec,
    30,
    86400,
    explicitPlatforms ? DEFAULT_OPENAI.interval_sec : legacyInterval,
  )
  const openaiTtlFallback = Math.max(explicitPlatforms ? DEFAULT_OPENAI.cache_ttl_sec : legacyTtl, openaiInterval)
  const openaiTtl = clampInt(oSrc?.cache_ttl_sec, 30, 172800, explicitPlatforms ? openaiTtlFallback : legacyTtl)
  const openai = {
    enabled: oSrc ? asBool(oSrc.enabled, false) : explicitPlatforms ? false : legacyEnabled && openaiModels.length > 0,
    interval_sec: openaiInterval,
    cache_ttl_sec: openaiTtl,
    all_models: asBool(oSrc?.all_models, DEFAULT_OPENAI.all_models),
    models: openaiModels,
    probe_all_slots: asBool(
      oSrc?.probe_all_slots,
      explicitPlatforms ? DEFAULT_OPENAI.probe_all_slots : legacyProbeAllSlots,
    ),
    prompt:
      String(oSrc?.prompt ?? legacyPrompt)
        .trim()
        .slice(0, 200) || DEFAULT_OPENAI.prompt,
    max_tokens: clampInt(oSrc?.max_tokens, 1, 128000, legacyMaxTokens),
    timeout_ms: clampInt(oSrc?.timeout_ms, 10_000, 180_000, legacyTimeoutMs),
    vm_ids:
      oSrc && Object.prototype.hasOwnProperty.call(oSrc, 'vm_ids') ? normalizeVmIds(oSrc.vm_ids) : [...legacyVmIds],
  }

  // --- Google (legacy alias: gemini) ---
  const gSrc = src.google && typeof src.google === 'object' ? src.google : null
  const googleInterval = clampInt(
    gSrc?.interval_sec,
    60,
    86400,
    explicitPlatforms ? DEFAULT_GOOGLE.interval_sec : legacyGeminiInterval,
  )
  const googleTtlFallback = Math.max(DEFAULT_GOOGLE.cache_ttl_sec, googleInterval)
  const googleTtl = clampInt(gSrc?.cache_ttl_sec, 60, 172800, explicitPlatforms ? googleTtlFallback : legacyGeminiTtl)
  const googleModels = resolvePlatformModelsInput(
    gSrc,
    explicitPlatforms ? DEFAULT_GOOGLE.models : legacyGeminiModels,
    'google',
  )
  const google = {
    enabled: gSrc
      ? asBool(gSrc.enabled, false)
      : explicitPlatforms
        ? false
        : legacyEnabled && asBool(geminiSrc.enabled, true),
    interval_sec: googleInterval,
    cache_ttl_sec: googleTtl,
    all_models: asBool(gSrc?.all_models ?? geminiSrc.all_models, DEFAULT_GOOGLE.all_models),
    models: googleModels,
    prompt:
      String(gSrc?.prompt ?? geminiSrc.prompt ?? DEFAULT_GOOGLE.prompt)
        .trim()
        .slice(0, 200) || DEFAULT_GOOGLE.prompt,
    timeout_ms: clampInt(gSrc?.timeout_ms ?? geminiSrc.timeout_ms, 10_000, 180_000, DEFAULT_GOOGLE.timeout_ms),
  }

  const anyEnabled = anthropic.enabled || openai.enabled || google.enabled
  const topTtl = anthropic.cache_ttl_sec

  return {
    enabled: anyEnabled,
    interval_sec: anthropic.interval_sec,
    cache_ttl_sec: topTtl,
    max_stale_sec: topTtl,
    cache_models: normalizeCacheModels(src.cache_models),
    cache_model: String(src.cache_model || '')
      .trim()
      .slice(0, 120),
    intercept_unofficial: asBool(src.intercept_unofficial, true),
    intercept_warmup: asBool(src.intercept_warmup, DEFAULT_HEALTH_PROBE.intercept_warmup),
    fail_closed: asBool(src.fail_closed, true),
    run_on_start: asBool(src.run_on_start, true),
    probe_all_slots: anthropic.probe_all_slots,
    // Health probes are strictly serial (one completes before the next starts).
    concurrency: 1,
    anthropic,
    openai,
    google,
    // Legacy read-only mirrors kept in sync with the 3 platform blocks.
    real: {
      model: anthropic.models[0] || DEFAULT_ANTHROPIC.models[0],
      prompt: anthropic.prompt,
      max_tokens: anthropic.max_tokens,
      timeout_ms: anthropic.timeout_ms,
      outbound_mode: anthropic.outbound_mode,
      vm_ids: [...anthropic.vm_ids],
      openai_model: openai.models[0] || '',
    },
    gemini: {
      enabled: google.enabled,
      interval_sec: google.interval_sec,
      cache_ttl_sec: google.cache_ttl_sec,
      all_models: google.all_models,
      models: [...google.models],
      model: google.models[0] || '',
      prompt: google.prompt,
      timeout_ms: google.timeout_ms,
    },
    match: {
      max_tokens: clampInt(matchSrc.max_tokens, 1, 4096, DEFAULT_HEALTH_PROBE.match.max_tokens),
      max_prompt_chars: clampInt(matchSrc.max_prompt_chars, 1, 256, DEFAULT_HEALTH_PROBE.match.max_prompt_chars),
      prompts: normalizePromptList(matchSrc.prompts, DEFAULT_HEALTH_PROBE.match.prompts),
      require_no_system: asBool(matchSrc.require_no_system, true),
      require_no_tools: asBool(matchSrc.require_no_tools, true),
      require_single_user: asBool(matchSrc.require_single_user, true),
      skip_official: asBool(matchSrc.skip_official, true),
      allow_missing_max_tokens: asBool(matchSrc.allow_missing_max_tokens, true),
      sub2api_account_test: asBool(matchSrc.sub2api_account_test, true),
      ua_regex: String(matchSrc.ua_regex || '')
        .trim()
        .slice(0, 200),
    },
  }
}

export function isHealthRealBypass(headers = {}) {
  const raw = headers[HEALTH_REAL_HEADER] ?? headers['X-Kin-Health-Real']
  const v = String(raw || '')
    .trim()
    .toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

function headerUa(headers = {}) {
  return String(headers['user-agent'] || headers['User-Agent'] || '')
}

function blockText(block) {
  if (block == null) return ''
  if (typeof block === 'string') return block
  if (typeof block !== 'object') return ''
  if (typeof block.text === 'string') return block.text
  if (typeof block.content === 'string') return block.content
  if (Array.isArray(block.content)) return block.content.map(blockText).join('')
  if (Array.isArray(block.parts)) return block.parts.map(blockText).join('')
  return ''
}

function hasNonTextGeminiPart(parts) {
  if (!Array.isArray(parts)) return false
  return parts.some(
    (p) =>
      p &&
      typeof p === 'object' &&
      (p.inlineData != null ||
        p.inline_data != null ||
        p.fileData != null ||
        p.file_data != null ||
        p.functionCall != null ||
        p.function_call != null ||
        p.functionResponse != null ||
        p.function_response != null),
  )
}

function systemText(system) {
  if (system == null) return ''
  if (typeof system === 'string') return system.trim()
  if (Array.isArray(system)) return system.map(blockText).join('').trim()
  return blockText(system).trim()
}

function messageText(msg) {
  if (!msg || typeof msg !== 'object') return ''
  return blockText(msg).trim()
}

export function extractProbeUserText(body = {}) {
  if (!body || typeof body !== 'object') return { text: '', messages: 0, users: 0 }
  if (
    typeof body.prompt === 'string' &&
    !Array.isArray(body.messages) &&
    body.input == null &&
    !Array.isArray(body.contents)
  ) {
    return { text: body.prompt.trim(), messages: 1, users: 1 }
  }
  if (Array.isArray(body.contents) && !Array.isArray(body.messages) && body.input == null) {
    if (body.contents.some((m) => hasNonTextGeminiPart(m?.parts))) {
      return { text: '', messages: body.contents.length, users: 0 }
    }
    const users = body.contents.filter((m) => !m?.role || String(m.role).toLowerCase() === 'user')
    return {
      text: users.map(blockText).join('').trim(),
      messages: body.contents.length,
      users: users.length,
    }
  }
  if (body.input != null && !Array.isArray(body.messages)) {
    if (typeof body.input === 'string') return { text: body.input.trim(), messages: 1, users: 1 }
    if (Array.isArray(body.input)) {
      const users = body.input.filter((m) => !m?.role || m.role === 'user' || m.role === 'input')
      return {
        text: users.map(blockText).join('').trim(),
        messages: body.input.length,
        users: users.length,
      }
    }
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  const users = messages.filter((m) => String(m?.role || '').toLowerCase() === 'user')
  return {
    text: users.map(messageText).join('').trim(),
    messages: messages.length,
    users: users.length,
  }
}

export function inboundMaxTokens(body = {}) {
  const n = Number(
    body?.max_tokens ??
      body?.max_completion_tokens ??
      body?.generationConfig?.maxOutputTokens ??
      body?.generation_config?.max_output_tokens,
  )
  return Number.isFinite(n) && n > 0 ? n : 0
}

function normalizeProbeText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?。！？]+$/g, '')
    .trim()
}

const CC_BANNER = "You are Claude Code, Anthropic's official CLI for Claude."

function matchesProbePrompt(text, match) {
  if (!text || text.length > match.max_prompt_chars) return false
  const needle = normalizeProbeText(text)
  return (match.prompts || []).map((p) => normalizeProbeText(p)).includes(needle)
}

/**
 * Account-test payload: official CC banner as the whole system prompt,
 * one "hi" user turn, max_tokens 1024, temperature 1, no tools. It carries a
 * claude-cli UA, so it is matched before the official-client skip.
 */
export function isSub2apiAccountTest(body = {}) {
  if (!body || typeof body !== 'object') return false
  if (Number(body.max_tokens) !== 1024 || Number(body.temperature) !== 1) return false
  if (Array.isArray(body.tools) ? body.tools.length : body.tools) return false
  if (systemText(body.system) !== CC_BANNER) return false
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (messages.length !== 1 || String(messages[0]?.role || '').toLowerCase() !== 'user') return false
  return normalizeProbeText(messageText(messages[0])) === 'hi'
}

/**
 * @param {string} [protocol] inbound protocol; a missing max_tokens only counts
 *   for OpenAI Chat, Responses, and Gemini probes with no token limit field.
 */
export function isHealthShape(headers = {}, body = {}, cfg = DEFAULT_HEALTH_PROBE, protocol = '', opts = {}) {
  const match = cfg?.match || DEFAULT_HEALTH_PROBE.match
  if (isHealthRealBypass(headers)) return false
  if (match.sub2api_account_test !== false && protocol !== 'openai.responses' && isSub2apiAccountTest(body)) {
    return true
  }
  const verifiedOfficial =
    typeof opts?.officialTraffic === 'boolean'
      ? opts.officialTraffic
      : verifyOfficialClaudeCode(headers, body, { detectProxiedOfficialCc: false }).official
  if (verifiedOfficial) return false
  if (
    match.skip_official !== false &&
    opts?.officialTraffic !== false &&
    verifyDirectClaudeCodeHeaders(headers, { requireCodeBeta: true }).ok
  ) {
    return false
  }
  if (match.ua_regex) {
    try {
      if (!new RegExp(match.ua_regex, 'i').test(headerUa(headers))) return false
    } catch {
      return false
    }
  }
  const maxTokens = inboundMaxTokens(body)
  const geminiSide = protocol === 'google.gemini' || protocol === 'gemini'
  const openaiSide = protocol === 'openai.chat' || protocol === 'openai.responses'
  const missingOk =
    match.allow_missing_max_tokens !== false &&
    (openaiSide || geminiSide) &&
    body?.max_tokens == null &&
    body?.max_completion_tokens == null &&
    body?.max_output_tokens == null &&
    body?.generationConfig?.maxOutputTokens == null &&
    body?.generation_config?.max_output_tokens == null
  if (!missingOk && (!maxTokens || maxTokens > match.max_tokens)) return false
  // Responses tests carry a long instructions prompt; check Claude/Gemini system fields.
  if (
    match.require_no_system !== false &&
    (systemText(body?.system) || systemText(body?.systemInstruction) || systemText(body?.system_instruction))
  ) {
    return false
  }
  const tools = Array.isArray(body?.tools) ? body.tools : []
  if (match.require_no_tools !== false && tools.length) return false
  const extracted = extractProbeUserText(body)
  if (match.require_single_user !== false && (extracted.messages !== 1 || extracted.users !== 1)) return false
  return matchesProbePrompt(extracted.text, match)
}

export function sanitizeCachedMessage(body, fallback = {}) {
  const src = body && typeof body === 'object' && !body.error ? body : {}
  const content = Array.isArray(src.content) ? src.content.filter((b) => b && typeof b === 'object') : []
  const text = String(fallback.text || '').slice(0, 4000)
  const id = String(src.id || fallback.id || '').trim()
  return {
    id: id || null,
    type: 'message',
    role: 'assistant',
    model: src.model || fallback.model || null,
    content: content.length ? content : text ? [{ type: 'text', text }] : [],
    stop_reason: src.stop_reason || fallback.stop_reason || 'end_turn',
    stop_sequence: Object.prototype.hasOwnProperty.call(src, 'stop_sequence')
      ? src.stop_sequence
      : (fallback.stop_sequence ?? null),
    usage:
      src.usage && typeof src.usage === 'object'
        ? src.usage
        : fallback.usage && typeof fallback.usage === 'object'
          ? fallback.usage
          : { input_tokens: 0, output_tokens: 0 },
  }
}

export function hasCachedMessage(snapshot) {
  const id = String(snapshot?.body?.id || '').trim()
  return !!id && snapshot?.ok === true
}

export function isSnapshotValid(snapshot, cfg = DEFAULT_HEALTH_PROBE, now = Date.now(), platform = 'anthropic') {
  if (!snapshot || snapshot.ok !== true || !snapshot.at) return false
  const at = Date.parse(snapshot.at)
  if (!Number.isFinite(at)) return false
  const age = now - at
  const staleMs = cacheTtlSec(cfg, platform) * 1000
  return age >= 0 && age <= staleMs
}

export function viewSnapshot(
  snapshot,
  cfg = DEFAULT_HEALTH_PROBE,
  now = Date.now(),
  nextAt = null,
  platform = 'anthropic',
) {
  const p = normalizeHealthPlatform(platform)
  const valid = isSnapshotValid(snapshot, cfg, now, p)
  return {
    ok: !!snapshot?.ok && valid,
    at: snapshot?.at || null,
    stale: !valid,
    vm_id: snapshot?.vm_id || null,
    model: snapshot?.model || null,
    message_id: snapshot?.body?.id || null,
    text: snapshot?.text || null,
    status: snapshot?.status || 0,
    error: snapshot?.error || null,
    last_error: snapshot?.last_error || null,
    last_failed_at: snapshot?.last_failed_at || null,
    duration_ms: snapshot?.duration_ms || null,
    next_at: nextAt,
    age_ms: snapshot?.at ? Math.max(0, now - Date.parse(snapshot.at) || 0) : null,
    cache_ttl_sec: cacheTtlSec(cfg, p),
    cache_models: [...(cfg.cache_models || [])],
    cache_model: cfg.cache_model || '',
  }
}

export function healthUnavailableError(snapshot = null, requestId = null) {
  const error = {
    type: 'api_error',
    code: HEALTH_VIA_UNAVAILABLE,
    message: snapshot?.error
      ? `Health probe unavailable: ${snapshot.error}`
      : 'Health probe unavailable: no valid cached result',
  }
  if (snapshot?.at) error.probed_at = snapshot.at
  if (snapshot?.error) error.last_error = String(snapshot.error).slice(0, 300)
  if (requestId) error.request_id = requestId
  return { type: 'error', error }
}

/** Which platform owns this inbound model: `google` (Gemini series), `openai` (GPT/Codex), or `anthropic` (Claude). */
export function healthPlatformOf(body = {}, modelHint = '') {
  const rawModel = body?.model || modelHint
  if (isGeminiSeriesId(rawModel)) return 'google'
  const platform = detectInboundPlatform(rawModel)
  return platform.ok && platform.platform === 'openai' ? 'openai' : 'anthropic'
}

function modelMatchesSnapshot(platform, requestedModel, snapshot) {
  const req = String(requestedModel || '').trim()
  const snapModel = String(snapshot?.canonical_model || snapshot?.model || '').trim()
  if (!req || !snapModel) return true
  const p = normalizeHealthPlatform(platform)
  const reqKey = canonicalHealthModelKey(p, req)
  const snapKey = canonicalHealthModelKey(p, snapModel)
  if (!reqKey || !snapKey) return false
  if (reqKey === snapKey) return true
  if (p === 'google') {
    return googleBaseModelKey(req) === googleBaseModelKey(snapModel)
  }
  return false
}

export function findModelSnapshot(platform, byModel, requestedModel, cfg = DEFAULT_HEALTH_PROBE, now = Date.now()) {
  if (!byModel) return null
  const p = normalizeHealthPlatform(platform)
  const key = canonicalHealthModelKey(p, requestedModel)
  if (!key) return null

  const entries = byModel instanceof Map ? [...byModel.entries()] : Object.entries(byModel)
  const getDirect = (k) => (byModel instanceof Map ? byModel.get(k) : byModel[k]) || null

  const exact = getDirect(key)
  if (exact) return exact

  // Also check canonicalized keys if the map came from a raw object with uncanonicalized keys.
  for (const [k, snap] of entries) {
    if (canonicalHealthModelKey(p, k) === key) return snap
  }

  if (p === 'google') {
    const reqBase = googleBaseModelKey(requestedModel)
    if (!reqBase) return null
    const baseExact = getDirect(reqBase)
    if (baseExact) return baseExact
    let fallback = null
    for (const [k, snap] of entries) {
      if (googleBaseModelKey(snap?.model || k) !== reqBase) continue
      if (isSnapshotValid(snap, cfg, now, 'google') && hasCachedMessage(snap)) return snap
      if (!fallback) fallback = snap
    }
    return fallback
  }
  return null
}

export function decideHealthIntercept({
  headers = {},
  body = {},
  cfg = DEFAULT_HEALTH_PROBE,
  snapshot = null,
  snapshotsByModel = null,
  now = Date.now(),
  protocol = '',
  platform = '',
  officialTraffic = undefined,
} = {}) {
  const resolvedPlatform = normalizeHealthPlatform(platform || healthPlatformOf(body))
  const pCfg = platformConfigOf(cfg, resolvedPlatform)
  const platformEnabled = pCfg?.enabled === true
  if (!platformEnabled || !cfg?.intercept_unofficial) return { action: 'pass' }
  if (!isHealthShape(headers, body, cfg, protocol, { officialTraffic })) return { action: 'pass' }
  if (!inboundMatchesCacheModels(body, cfg)) return { action: 'pass' }

  const requestedModel = String(body?.model || '').trim()
  let targetSnap = null
  if (snapshotsByModel) {
    targetSnap = findModelSnapshot(resolvedPlatform, snapshotsByModel, requestedModel, cfg, now)
  } else if (snapshot) {
    targetSnap = modelMatchesSnapshot(resolvedPlatform, requestedModel, snapshot) ? snapshot : null
  }

  if (targetSnap && isSnapshotValid(targetSnap, cfg, now, resolvedPlatform) && hasCachedMessage(targetSnap)) {
    return { action: 'cache', snapshot: targetSnap, via: HEALTH_VIA_CACHE, platform: resolvedPlatform }
  }
  if (!cfg.fail_closed) return { action: 'pass' }
  // Only 503 when the fleet has no hop target for this model. A 401/timeout on one slot
  // or an uncached model must not fail-closed while accounts are live.
  if (targetSnap?.error === 'no_schedulable_credential') {
    return { action: 'fail', snapshot: targetSnap, via: HEALTH_VIA_UNAVAILABLE, platform: resolvedPlatform }
  }
  return { action: 'pass' }
}

export function cachedClaudeMessage(snapshot = {}, inbound = {}, cfg = DEFAULT_HEALTH_PROBE) {
  const model = resolveCacheResponseModel(inbound, snapshot, cfg)
  const src = snapshot.body && typeof snapshot.body === 'object' ? snapshot.body : null
  if (!src || !String(src.id || '').trim()) return null
  const content =
    Array.isArray(src.content) && src.content.length
      ? src.content
      : [{ type: 'text', text: String(snapshot.text || 'ok') }]
  return {
    id: String(src.id).trim(),
    type: 'message',
    role: src.role || 'assistant',
    model,
    content,
    stop_reason: src.stop_reason || 'end_turn',
    stop_sequence: Object.prototype.hasOwnProperty.call(src, 'stop_sequence') ? src.stop_sequence : null,
    usage: src.usage && typeof src.usage === 'object' ? src.usage : { input_tokens: 0, output_tokens: 0 },
  }
}

function claudeToGoogleGeminiResponse(claude) {
  const text = (claude.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text || '')
    .join('')
  const input = Number(claude.usage?.input_tokens) || 0
  const output = Number(claude.usage?.output_tokens) || 0
  const total = Number(claude.usage?.total_tokens) || input + output
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text }] },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: input,
      candidatesTokenCount: output,
      totalTokenCount: total,
    },
    modelVersion: claude.model,
  }
}

/** Replay the cached official Messages body in the caller's protocol. No local msg_health_* ids. */
export function synthesizeProtocolResponse(protocol, inbound = {}, snapshot = {}, cfg = DEFAULT_HEALTH_PROBE) {
  const claude = cachedClaudeMessage(snapshot, inbound, cfg)
  if (!claude) return null
  if (protocol === 'google.gemini' || protocol === 'gemini') return claudeToGoogleGeminiResponse(claude)
  if (protocol === 'openai.chat') return fromClaudeToOpenAIChat(claude, claude.model)
  if (protocol === 'openai.completions') return fromClaudeToOpenAICompletions(claude, claude.model)
  if (protocol === 'openai.responses') return fromClaudeToResponses(claude, claude.model)
  return claude
}

export function formatHealthSse(protocol, inbound, snapshot, cfg = DEFAULT_HEALTH_PROBE) {
  const claude = cachedClaudeMessage(snapshot, inbound, cfg)
  if (!claude) return ''
  if (protocol === 'google.gemini' || protocol === 'gemini') {
    return `data: ${JSON.stringify(claudeToGoogleGeminiResponse(claude))}\n\n`
  }
  const lines = []
  const ev = (event, data) => {
    if (event) lines.push(`event: ${event}`)
    lines.push(`data: ${JSON.stringify(data)}`)
    lines.push('')
  }
  if (protocol === 'openai.chat') {
    const chat = fromClaudeToOpenAIChat(claude, claude.model)
    const text = chat.choices?.[0]?.message?.content || ''
    ev(null, {
      id: chat.id,
      object: 'chat.completion.chunk',
      model: chat.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    })
    // Channel tests set stream_options.include_usage and require parseable usage.
    ev(null, {
      id: chat.id,
      object: 'chat.completion.chunk',
      model: chat.model,
      choices: [{ index: 0, delta: {}, finish_reason: chat.choices?.[0]?.finish_reason || 'stop' }],
      ...(chat.usage ? { usage: chat.usage } : {}),
    })
    lines.push('data: [DONE]', '')
    return lines.join('\n')
  }
  if (protocol === 'openai.completions') {
    const cmp = fromClaudeToOpenAICompletions(claude, claude.model)
    ev(null, {
      id: cmp.id,
      object: 'text_completion',
      model: cmp.model,
      choices: [
        { text: cmp.choices?.[0]?.text || '', index: 0, finish_reason: cmp.choices?.[0]?.finish_reason || 'stop' },
      ],
    })
    lines.push('data: [DONE]', '')
    return lines.join('\n')
  }
  if (protocol === 'openai.responses') {
    const text = (claude.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('')
    // End the Responses probe stream with response.completed so clients recognize completion.
    const response = fromClaudeToResponses(claude, claude.model)
    ev('response.created', {
      type: 'response.created',
      response: { id: response.id, object: 'response', status: 'in_progress', model: response.model, output: [] },
    })
    ev('response.output_text.delta', {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      delta: text,
    })
    ev('response.completed', { type: 'response.completed', response })
    return lines.join('\n')
  }
  ev('message_start', {
    type: 'message_start',
    message: {
      id: claude.id,
      type: 'message',
      role: 'assistant',
      model: claude.model,
      content: [],
      usage: claude.usage,
    },
  })
  const blocks = Array.isArray(claude.content) ? claude.content : []
  blocks.forEach((block, index) => {
    if (block.type === 'thinking') {
      ev('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '' },
      })
      ev('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: block.thinking || '' },
      })
      if (block.signature) {
        ev('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'signature_delta', signature: block.signature },
        })
      }
    } else {
      ev('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      })
      ev('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text || '' },
      })
    }
    ev('content_block_stop', { type: 'content_block_stop', index })
  })
  ev('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: claude.stop_reason || 'end_turn', stop_sequence: claude.stop_sequence ?? null },
    usage: { output_tokens: claude.usage?.output_tokens || 0 },
  })
  ev('message_stop', { type: 'message_stop' })
  return lines.join('\n')
}

const HARD_UNAVAILABLE = new Set(['stopped', 'dead', 'error', 'disabled'])

export function isHealthProbeTarget(vm, now = Date.now()) {
  if (!vm) return false
  if (vm.schedulable === false) return false
  const status = String(vm.status || '').toLowerCase()
  if (HARD_UNAVAILABLE.has(status)) return false
  const grantErr = String(vm.claude?.refresh_error || vm.refresh_error || vm.schedule_disabled_reason || '')
  if (
    /invalid_grant|refresh token not found|oauth_revoked|token has been revoked|token_revoked|invalidated oauth token/i.test(
      grantErr,
    )
  )
    return false
  const coolUntil = Number(vm.cooldown_until || vm.claude?.temp_unschedulable_until) || 0
  if (
    coolUntil > now &&
    /authentication_failed|invalid_grant|oauth_invalid_grant|oauth_revoked/i.test(
      String(vm.cooldown_reason || vm.claude?.temp_unschedulable_reason || ''),
    )
  ) {
    return false
  }
  // Off-shift slots take no real traffic, probes included (a probe is a pinned real chat).
  if (!evaluateActiveHours(activeHoursOf(vm), now, vm.timezone).active) return false
  if (vm.claude) return vmHasClaudeCredential(vm)
  return !!(vm.has_token || vm.has_refresh)
}

export function selectHealthProbeTargets(vms = [], cfg = DEFAULT_HEALTH_PROBE, now = Date.now(), platform = null) {
  const p = platform ? normalizeHealthPlatform(platform) : null
  const pCfg = p ? platformConfigOf(cfg, p) : null
  const vmIds = pCfg && Array.isArray(pCfg.vm_ids) ? pCfg.vm_ids : cfg.real?.vm_ids || []
  const allow = new Set(vmIds.map((id) => String(id)))
  return (vms || []).filter((vm) => {
    if (allow.size && !allow.has(vm.id)) return false
    if (p) {
      const vmPlatform =
        String(vm.platform || '').toLowerCase() === 'openai' || vm.codex_kernel ? 'openai' : 'anthropic'
      if (vmPlatform !== p) return false
    }
    return isHealthProbeTarget(vm, now)
  })
}

function vmForModelGate(vm) {
  if (!vm || typeof vm !== 'object') return vm
  if (vm.policy?.allowed_models != null || !Array.isArray(vm.allowed_models)) return vm
  return { ...vm, policy: { ...(vm.policy || {}), allowed_models: vm.allowed_models } }
}

/** Filter schedulable platform slots to those allowed to serve a specific model. */
export function selectHealthProbeTargetsForModel(
  vms = [],
  cfg = DEFAULT_HEALTH_PROBE,
  platform = 'anthropic',
  model = '',
  now = Date.now(),
  { fableRequiresMax = false } = {},
) {
  const p = normalizeHealthPlatform(platform)
  const candidates = selectHealthProbeTargets(vms, cfg, now, p)
  const targetModel = String(model || '').trim()
  if (!targetModel) return candidates
  return candidates.filter((vm) => {
    try {
      const gate = slotAllowsModel({
        vm: vmForModelGate(vm),
        account: vm._account || null,
        model: targetModel,
        fableRequiresMax,
      })
      return gate.ok !== false
    } catch {
      return true
    }
  })
}

function extractOnlineGeminiModelIds(catalog = null) {
  const out = []
  const seen = new Set()
  const push = (raw) => {
    const id = String(typeof raw === 'string' ? raw : raw?.id || '').trim()
    if (!id || !isGeminiSeriesId(id)) return
    const key = canonicalHealthModelKey('google', id)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(id)
  }
  for (const m of Array.isArray(catalog?.models) ? catalog.models : []) push(m)
  for (const acc of Array.isArray(catalog?.accounts) ? catalog.accounts : []) {
    for (const m of Array.isArray(acc?.models) ? acc.models : []) push(m)
  }
  return out
}

export function selectGeminiProbeModel(catalog = null, cfg = DEFAULT_HEALTH_PROBE) {
  const googleCfg = platformConfigOf(cfg, 'google')
  const configured = String(googleCfg?.models?.[0] || cfg?.gemini?.model || '').trim()
  if (configured) return configured
  const ids = extractOnlineGeminiModelIds(catalog)
  if (!ids.length) return null
  return ids.find((id) => /flash[-._]?lite/i.test(id)) || ids.find((id) => /flash/i.test(id)) || ids[0]
}

/**
 * List enabled catalog models for one platform (SSOT for UI picker and `all_models` resolution).
 * - anthropic: enabled Claude policy models excluding `auto` and GPT ids, deduplicated by canonical key.
 * - openai: enabled GPT policy chat models (naturally excludes image_tools).
 * - google: enabled Gemini policy models; when `geminiCatalog` carries live discovered models,
 *   annotates `online` and maps each base model to the best live callable id.
 */
export function listPlatformCatalogModels(platform, { geminiCatalog = null, listPlatformModels = null } = {}) {
  const p = normalizeHealthPlatform(platform)
  const custom = typeof listPlatformModels === 'function' ? listPlatformModels(p) : null

  if (p === 'anthropic') {
    const rawList = Array.isArray(custom)
      ? custom
      : (() => {
          try {
            return listPolicyModels()
          } catch {
            return []
          }
        })()
    const out = []
    const seen = new Set()
    for (const item of rawList) {
      const id = String(typeof item === 'string' ? item : item?.id || '').trim()
      if (!id || id.toLowerCase() === 'auto') continue
      if (typeof item === 'object' && item?.enabled === false) continue
      if (isGptSeriesId(id) || String(item?.family || '').toLowerCase() === 'codex') continue
      const key = canonicalHealthModelKey('anthropic', id)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push({
        id,
        label: (typeof item === 'object' && (item?.display_name || item?.label)) || id,
        family: (typeof item === 'object' && item?.family) || '',
      })
    }
    return out
  }

  if (p === 'openai') {
    const rawList = Array.isArray(custom)
      ? custom
      : (() => {
          try {
            return listGptPolicyModels()
          } catch {
            return []
          }
        })()
    const out = []
    const seen = new Set()
    for (const item of rawList) {
      const id = String(typeof item === 'string' ? item : item?.id || '').trim()
      if (!id) continue
      if (typeof item === 'object' && item?.enabled === false) continue
      const key = canonicalHealthModelKey('openai', id)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push({
        id,
        label: (typeof item === 'object' && (item?.display_name || item?.label)) || id,
        family: (typeof item === 'object' && item?.family) || 'codex',
      })
    }
    return out
  }

  // Google / Gemini
  const rawList = Array.isArray(custom)
    ? custom
    : (() => {
        try {
          return listGeminiPolicyModels()
        } catch {
          return []
        }
      })()
  const onlineIds = extractOnlineGeminiModelIds(geminiCatalog)
  const hasOnlineCatalog = onlineIds.length > 0
  const onlineByExact = new Map()
  const onlineByBase = new Map()
  for (const oid of onlineIds) {
    const exactKey = canonicalHealthModelKey('google', oid)
    const baseKey = googleBaseModelKey(oid)
    if (exactKey && !onlineByExact.has(exactKey)) onlineByExact.set(exactKey, oid)
    if (baseKey && !onlineByBase.has(baseKey)) onlineByBase.set(baseKey, oid)
  }

  const out = []
  const seen = new Set()
  for (const item of rawList) {
    const id = String(typeof item === 'string' ? item : item?.id || '').trim()
    if (!id || !isGeminiSeriesId(id)) continue
    if (typeof item === 'object' && item?.enabled === false) continue
    const key = canonicalHealthModelKey('google', id)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const baseKey = googleBaseModelKey(id)
    const matchedOnline = onlineByExact.get(key) || onlineByBase.get(baseKey) || null
    out.push({
      id,
      label: (typeof item === 'object' && (item?.display_name || item?.label)) || id,
      family: 'gemini',
      ...(hasOnlineCatalog ? { online: Boolean(matchedOnline), probe_id: matchedOnline || id } : {}),
    })
  }
  return out
}

/**
 * Resolve the concrete ordered list of model ids to probe for one platform.
 */
export function resolvePlatformProbeModels(
  platform,
  cfg = DEFAULT_HEALTH_PROBE,
  { geminiCatalog = null, listPlatformModels = null } = {},
) {
  const p = normalizeHealthPlatform(platform)
  const pCfg = platformConfigOf(cfg, p)

  if (pCfg?.all_models === true) {
    const catalog = listPlatformCatalogModels(p, { geminiCatalog, listPlatformModels })
    if (p === 'google') {
      const onlineIds = extractOnlineGeminiModelIds(geminiCatalog)
      if (onlineIds.length > 0) {
        const intersected = []
        const seenBase = new Set()
        for (const item of catalog) {
          if (item.online !== true) continue
          const probeId = item.probe_id || item.id
          const baseKey = googleBaseModelKey(probeId)
          if (!baseKey || seenBase.has(baseKey)) continue
          seenBase.add(baseKey)
          intersected.push(probeId)
        }
        return intersected
      }
    }
    return catalog.map((item) => item.id)
  }

  const configured = normalizeModelList(pCfg?.models || [], p)
  if (configured.length) return configured

  if (p === 'google') {
    const auto = selectGeminiProbeModel(geminiCatalog, cfg)
    if (auto) return [auto]
    return geminiCatalog ? [] : ['gemini-2.5-flash']
  }

  return []
}

function summarizePlatformView(platform, state, cfg, now, nextAt) {
  const p = normalizeHealthPlatform(platform)
  const pCfg = platformConfigOf(cfg, p)
  const ttlSec = cacheTtlSec(cfg, p)

  const orderedKeys = []
  const seen = new Set()
  for (const model of state.plannedModels || []) {
    const key = canonicalHealthModelKey(p, model)
    if (key && !seen.has(key)) {
      seen.add(key)
      orderedKeys.push({ key, model })
    }
  }
  for (const [key, snap] of state.byModel.entries()) {
    if (!seen.has(key)) {
      seen.add(key)
      orderedKeys.push({ key, model: snap?.model || key })
    }
  }

  const models = orderedKeys.map(({ key, model }) => {
    const snap = state.byModel.get(key) || null
    const view = viewSnapshot(snap, cfg, now, nextAt, p)
    return {
      ...view,
      model: snap?.model || model,
    }
  })

  const okList = models.filter((m) => m.ok)
  const failedList = models.filter((m) => !m.ok && m.at && m.error)
  const staleList = models.filter((m) => !m.ok && m.at && !m.error)
  // Pick a representative snapshot for legacy single-snapshot callers: first valid, else first with timestamp.
  const repRaw =
    [...state.byModel.values()].find((s) => isSnapshotValid(s, cfg, now, p)) ||
    [...state.byModel.values()].find((s) => s?.at) ||
    null
  const baseView = viewSnapshot(repRaw, cfg, now, nextAt, p)

  return {
    ...baseView,
    platform: p,
    enabled: pCfg?.enabled === true,
    all_models: pCfg?.all_models === true,
    probing: state.probing === true,
    cache_ttl_sec: ttlSec,
    next_at: nextAt,
    total_models: models.length,
    ok_models: okList.length,
    failed_models: failedList.length,
    stale_models: staleList.length,
    models,
  }
}

export function createHealthProbeMonitor(opts = {}) {
  let config = normalizeHealthProbeConfig(opts.config)
  const nowFn = opts.now || (() => Date.now())
  const fableRequiresMaxFn = () =>
    typeof opts.getFableRequiresMax === 'function' ? opts.getFableRequiresMax() === true : false

  const states = {
    anthropic: { byModel: new Map(), plannedModels: [], lastRunAt: 0, inflight: null, timer: null, probing: false },
    openai: { byModel: new Map(), plannedModels: [], lastRunAt: 0, inflight: null, timer: null, probing: false },
    google: { byModel: new Map(), plannedModels: [], lastRunAt: 0, inflight: null, timer: null, probing: false },
  }
  let fleetInflight = null
  let allInflight = null
  let serialChain = Promise.resolve()

  // Serialize all real health probes (across models, slots, platforms, and timers).
  const enqueueSerial = (fn) => {
    const run = serialChain.then(fn, fn)
    serialChain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  const getConfig = () => config

  const nextAtIso = (platform) => {
    const p = normalizeHealthPlatform(platform)
    const pCfg = platformConfigOf(config, p)
    const st = states[p]
    if (!pCfg?.enabled || !st.lastRunAt) return null
    return new Date(st.lastRunAt + pCfg.interval_sec * 1000).toISOString()
  }

  const getSnapshot = (platform = 'anthropic', model = '') => {
    const p = normalizeHealthPlatform(platform)
    const now = nowFn()
    const nextAt = nextAtIso(p)
    if (model) {
      const snap = findModelSnapshot(p, states[p].byModel, model, config, now)
      return viewSnapshot(snap, config, now, nextAt, p)
    }
    return summarizePlatformView(p, states[p], config, now, nextAt)
  }

  const getSnapshots = () => {
    const anthropic = getSnapshot('anthropic')
    const openai = getSnapshot('openai')
    const google = getSnapshot('google')
    return {
      anthropic,
      openai,
      google,
      gemini: google,
    }
  }

  const rawSnapshot = (platform = 'anthropic', model = '') => {
    const p = normalizeHealthPlatform(platform)
    const map = states[p].byModel
    if (model) return findModelSnapshot(p, map, model, config, nowFn())
    const now = nowFn()
    return [...map.values()].find((s) => isSnapshotValid(s, config, now, p)) || [...map.values()][0] || null
  }

  const rawSnapshots = (platform = 'anthropic') => {
    const p = normalizeHealthPlatform(platform)
    return Object.fromEntries(states[p].byModel.entries())
  }

  const listAllTargets = () => (typeof opts.listTargets === 'function' ? opts.listTargets() || [] : [])

  const decide = (headers, body, protocol = '', decideOpts = {}) => {
    const modelHint = String(decideOpts?.model || '').trim()
    const effectiveBody =
      modelHint && (!body || typeof body !== 'object' || !body.model)
        ? { ...(body && typeof body === 'object' ? body : {}), model: modelHint }
        : body
    const platform = normalizeHealthPlatform(healthPlatformOf(effectiveBody, modelHint))
    const now = nowFn()
    const decision = decideHealthIntercept({
      headers,
      body: effectiveBody,
      protocol,
      cfg: config,
      snapshotsByModel: states[platform].byModel,
      now,
      platform,
      officialTraffic: decideOpts?.officialTraffic,
    })
    if (decision.action === 'fail') {
      if (platform === 'google') return { action: 'pass' }
      const requestedModel = String(effectiveBody?.model || '').trim()
      const liveTargets = selectHealthProbeTargetsForModel(listAllTargets(), config, platform, requestedModel, now, {
        fableRequiresMax: fableRequiresMaxFn(),
      })
      if (liveTargets.length) return { action: 'pass' }
    }
    return decision
  }

  const pruneUnmanagedSnapshots = (platform, plannedModels) => {
    const p = normalizeHealthPlatform(platform)
    const keepKeys = new Set(plannedModels.map((m) => canonicalHealthModelKey(p, m)).filter(Boolean))
    for (const key of [...states[p].byModel.keys()]) {
      if (!keepKeys.has(key)) states[p].byModel.delete(key)
    }
  }

  const recordFailedModelSnapshot = (platform, model, started, { vmId = null, status = 0, error = 'probe_failed' }) => {
    const p = normalizeHealthPlatform(platform)
    const key = canonicalHealthModelKey(p, model)
    if (!key) return
    const now = nowFn()
    const failedAt = new Date(now).toISOString()
    const errMsg = String(error || 'probe_failed').slice(0, 300)
    const prev = states[p].byModel.get(key)
    if (prev?.ok && isSnapshotValid(prev, config, now, p)) {
      states[p].byModel.set(key, { ...prev, last_error: errMsg, last_failed_at: failedAt })
      return
    }
    states[p].byModel.set(key, {
      ok: false,
      at: failedAt,
      vm_id: vmId,
      model,
      canonical_model: key,
      text: null,
      status,
      error: errMsg,
      duration_ms: Math.max(0, now - started),
    })
  }

  const probeSingleVmModel = async (platform, model, pCfg, started) => {
    const p = normalizeHealthPlatform(platform)
    const key = canonicalHealthModelKey(p, model)
    if (!key) return
    const allVms = listAllTargets()
    const targets = selectHealthProbeTargetsForModel(allVms, config, p, model, nowFn(), {
      fableRequiresMax: fableRequiresMaxFn(),
    })
    if (!targets.length) {
      recordFailedModelSnapshot(p, model, started, { error: 'no_schedulable_credential' })
      return
    }
    if (typeof opts.runChat !== 'function') {
      recordFailedModelSnapshot(p, model, started, { vmId: targets[0]?.id || null, error: 'runChat missing' })
      return
    }

    const realReq = {
      model,
      prompt: pCfg.prompt || DEFAULT_ANTHROPIC.prompt,
      max_tokens: pCfg.max_tokens || DEFAULT_ANTHROPIC.max_tokens,
      timeout_ms: pCfg.timeout_ms || DEFAULT_ANTHROPIC.timeout_ms,
      outbound_mode: pCfg.outbound_mode || 'official',
      vm_ids: [...(pCfg.vm_ids || [])],
    }

    const writeSuccessSnapshot = (vm, result) => {
      const now = nowFn()
      const body = sanitizeCachedMessage(result.body, {
        text: result.text,
        model: result.model || model,
        stop_reason: result.stop_reason,
        usage: result.usage,
      })
      states[p].byModel.set(key, {
        ok: true,
        at: new Date(now).toISOString(),
        vm_id: result.vm_id || vm.id,
        model: body.model || result.model || model,
        canonical_model: key,
        text: String(result.text || 'ok').slice(0, 4000),
        status: result.status || 200,
        error: null,
        duration_ms: Math.max(0, now - started),
        body,
      })
    }

    const probeVm = async (vm) => {
      try {
        const result = await opts.runChat(vm, realReq)
        if (result?.ok) return { ok: true, result }
        return {
          ok: false,
          status: result?.status || 0,
          error: result?.error?.message || result?.error || 'probe_failed',
        }
      } catch (e) {
        return { ok: false, status: 0, error: String(e?.message || e).slice(0, 300) }
      }
    }

    let lastError = null
    let lastStatus = 0
    let wroteThisRun = false
    for (const vm of targets) {
      const outcome = await probeVm(vm)
      if (outcome.ok) {
        if (!wroteThisRun) {
          wroteThisRun = true
          writeSuccessSnapshot(vm, outcome.result)
        }
        if (!pCfg.probe_all_slots) return
      } else {
        lastError = outcome.error
        lastStatus = outcome.status || 0
      }
    }
    if (wroteThisRun) return
    recordFailedModelSnapshot(p, model, started, {
      vmId: targets[0]?.id || null,
      status: lastStatus,
      error: lastError || 'probe_failed',
    })
  }

  const probeVmPlatform = async (platform, { singleModel = '', fallbackDefault = false } = {}) => {
    const p = normalizeHealthPlatform(platform)
    const pCfg = platformConfigOf(config, p)
    const models = singleModel
      ? [singleModel]
      : resolvePlatformProbeModels(p, config, { listPlatformModels: opts.listPlatformModels })
    const effectiveModels =
      models.length || !fallbackDefault ? models : p === 'anthropic' ? [...DEFAULT_ANTHROPIC.models] : []

    if (!singleModel) {
      states[p].plannedModels = [...effectiveModels]
      pruneUnmanagedSnapshots(p, effectiveModels)
    }
    if (!effectiveModels.length) return

    for (const model of effectiveModels) {
      const modelStarted = nowFn()
      await probeSingleVmModel(p, model, pCfg, modelStarted)
    }
  }

  const googleAccountSupportsModel = (accounts, model) => {
    if (!Array.isArray(accounts) || !accounts.length) return false
    const withModels = accounts.filter((a) => Array.isArray(a?.models) && a.models.length > 0)
    if (!withModels.length) return true
    const targetExact = canonicalHealthModelKey('google', model)
    const targetBase = googleBaseModelKey(model)
    return withModels.some((a) =>
      a.models.some((m) => {
        const mExact = canonicalHealthModelKey('google', m)
        return mExact === targetExact || googleBaseModelKey(m) === targetBase
      }),
    )
  }

  const probeSingleGoogleModel = async (model, pCfg, started) => {
    const key = canonicalHealthModelKey('google', model)
    if (!key) return
    try {
      const result = await opts.runGeminiProbe({
        model,
        prompt: pCfg.prompt || DEFAULT_GOOGLE.prompt,
        timeout_ms: pCfg.timeout_ms || DEFAULT_GOOGLE.timeout_ms,
      })
      if (result?.ok) {
        const now = nowFn()
        const fallbackId = `gem_probe_${crypto.randomBytes(8).toString('hex')}`
        const body = sanitizeCachedMessage(result.body, {
          id: result.id || fallbackId,
          text: result.text || 'ok',
          model: result.model || model,
          stop_reason: result.stop_reason || 'end_turn',
          usage: result.usage,
        })
        states.google.byModel.set(key, {
          ok: true,
          at: new Date(now).toISOString(),
          vm_id: result.vm_id || (result.account_id ? `gemini:${result.account_id}` : 'gemini'),
          model: body.model || result.model || model,
          canonical_model: key,
          text: String(result.text || 'ok').slice(0, 4000),
          status: result.status || 200,
          error: null,
          duration_ms: Math.max(0, now - started),
          body,
        })
        return
      }
      recordFailedModelSnapshot('google', model, started, {
        vmId: result?.vm_id || (result?.account_id ? `gemini:${result.account_id}` : null),
        status: result?.status || 0,
        error: result?.error?.message || result?.error || 'probe_failed',
      })
    } catch (e) {
      recordFailedModelSnapshot('google', model, started, {
        error: e?.message || e || 'probe_failed',
      })
    }
  }

  const probeGooglePlatform = async ({ singleModel = '' } = {}) => {
    if (typeof opts.runGeminiProbe !== 'function') return
    const pCfg = config.google

    let catalog = null
    if (typeof opts.listGeminiTargets === 'function') {
      try {
        catalog = await opts.listGeminiTargets()
      } catch (e) {
        const errMsg = String(e?.message || e || 'gemini_catalog_failed').slice(0, 300)
        const fallbackModels = singleModel
          ? [singleModel]
          : resolvePlatformProbeModels('google', config, { listPlatformModels: opts.listPlatformModels })
        const modelsToMark = fallbackModels.length ? fallbackModels : [pCfg.models[0] || 'gemini-2.5-flash']
        if (!singleModel) states.google.plannedModels = [...modelsToMark]
        for (const m of modelsToMark) {
          recordFailedModelSnapshot('google', m, nowFn(), { error: errMsg })
        }
        return
      }
      const accounts = Array.isArray(catalog?.accounts) ? catalog.accounts : []
      if (!accounts.length) {
        const modelsToMark = singleModel
          ? [singleModel]
          : resolvePlatformProbeModels('google', config, {
              geminiCatalog: catalog,
              listPlatformModels: opts.listPlatformModels,
            })
        const markList = modelsToMark.length ? modelsToMark : pCfg.models.length ? pCfg.models : ['gemini']
        if (!singleModel) {
          states.google.plannedModels = modelsToMark.length ? [...modelsToMark] : []
          pruneUnmanagedSnapshots('google', markList)
        }
        for (const m of markList) {
          recordFailedModelSnapshot('google', m, nowFn(), { error: 'no_schedulable_credential' })
        }
        return
      }
    }

    const models = singleModel
      ? [singleModel]
      : resolvePlatformProbeModels('google', config, {
          geminiCatalog: catalog,
          listPlatformModels: opts.listPlatformModels,
        })
    if (!singleModel) {
      states.google.plannedModels = [...models]
      pruneUnmanagedSnapshots('google', models)
    }
    if (!models.length) {
      if (!singleModel) {
        recordFailedModelSnapshot('google', 'gemini', nowFn(), { error: 'no_schedulable_credential' })
      }
      return
    }

    const accounts = Array.isArray(catalog?.accounts) ? catalog.accounts : null
    for (const model of models) {
      const modelStarted = nowFn()
      if (accounts && !googleAccountSupportsModel(accounts, model)) {
        recordFailedModelSnapshot('google', model, modelStarted, { error: 'no_schedulable_credential' })
        continue
      }
      await probeSingleGoogleModel(model, pCfg, modelStarted)
    }
  }

  const runPlatformProbe = async (platform, { model = '', fallbackDefault = false } = {}) => {
    const p = normalizeHealthPlatform(platform)
    const st = states[p]
    const singleModel = String(model || '').trim()
    if (!singleModel && st.inflight) return st.inflight
    const run = enqueueSerial(async () => {
      st.probing = true
      if (!singleModel) st.lastRunAt = nowFn()
      try {
        if (p === 'google') {
          await probeGooglePlatform({ singleModel })
        } else {
          await probeVmPlatform(p, { singleModel, fallbackDefault })
        }
        return singleModel ? getSnapshot(p, singleModel) : getSnapshot(p)
      } finally {
        st.probing = false
      }
    })
    if (!singleModel) {
      st.inflight = run.finally(() => {
        st.inflight = null
      })
      return st.inflight
    }
    return run
  }

  const runFleetProbe = async () => {
    if (fleetInflight) return fleetInflight
    fleetInflight = (async () => {
      const anyFleet = config.anthropic.enabled || config.openai.enabled
      if (config.anthropic.enabled || !anyFleet) {
        await runPlatformProbe('anthropic', { fallbackDefault: !anyFleet })
      }
      if (config.openai.enabled) {
        await runPlatformProbe('openai')
      }
      return getSnapshot('anthropic')
    })().finally(() => {
      fleetInflight = null
    })
    return fleetInflight
  }

  const runGeminiRealProbe = async ({ model = '' } = {}) => runPlatformProbe('google', { model })

  const runRealProbe = async ({ platform = 'all', model = '' } = {}) => {
    const rawPlatform = String(platform || 'all')
      .trim()
      .toLowerCase()
    if (rawPlatform === 'anthropic' || rawPlatform === 'claude') {
      return runPlatformProbe('anthropic', { model, fallbackDefault: !model && config.anthropic.models.length === 0 })
    }
    if (rawPlatform === 'openai' || rawPlatform === 'gpt' || rawPlatform === 'codex') {
      return runPlatformProbe('openai', { model })
    }
    if (rawPlatform === 'google' || rawPlatform === 'gemini') {
      return runPlatformProbe('google', { model })
    }
    if (rawPlatform === 'fleet') {
      return runFleetProbe()
    }
    if (allInflight) return allInflight
    allInflight = (async () => {
      const anyEnabled = config.anthropic.enabled || config.openai.enabled || config.google.enabled
      if (!anyEnabled) {
        // Legacy manual probe fallback when no platform is enabled yet.
        await runPlatformProbe('anthropic', { fallbackDefault: true })
        return getSnapshot('anthropic')
      }
      if (config.anthropic.enabled) {
        await runPlatformProbe('anthropic')
      }
      if (config.openai.enabled) {
        await runPlatformProbe('openai')
      }
      if (config.google.enabled && typeof opts.runGeminiProbe === 'function') {
        await runPlatformProbe('google')
      }
      return getSnapshot('anthropic')
    })().finally(() => {
      allInflight = null
    })
    return allInflight
  }

  const stop = () => {
    for (const p of HEALTH_PLATFORMS) {
      if (states[p].timer) {
        clearInterval(states[p].timer)
        states[p].timer = null
      }
    }
  }

  const start = ({ immediate = false, immediatePlatforms = null } = {}) => {
    stop()
    let startedAny = false
    for (const p of HEALTH_PLATFORMS) {
      const pCfg = platformConfigOf(config, p)
      if (!pCfg?.enabled) continue
      if (p === 'google' && typeof opts.runGeminiProbe !== 'function') continue
      startedAny = true
      states[p].timer = setInterval(() => {
        runPlatformProbe(p).catch(() => {})
      }, pCfg.interval_sec * 1000)
      if (typeof states[p].timer.unref === 'function') states[p].timer.unref()
      const triggerNow = immediatePlatforms ? Boolean(immediatePlatforms[p]) : Boolean(immediate)
      if (triggerNow && config.run_on_start) {
        queueMicrotask(() => {
          runPlatformProbe(p).catch(() => {})
        })
      }
    }
    if (!startedAny) return { started: false, reason: 'disabled' }
    return {
      started: true,
      interval_sec: config.anthropic.interval_sec,
      openai_interval_sec: config.openai.interval_sec,
      google_interval_sec: config.google.interval_sec,
      gemini_interval_sec: config.google.interval_sec,
      run_on_start: config.run_on_start,
    }
  }

  const setConfig = (next, { restart = true } = {}) => {
    const prevEnabled = {
      anthropic: config.anthropic.enabled,
      openai: config.openai.enabled,
      google: config.google.enabled,
    }
    config = normalizeHealthProbeConfig(next)
    const immediatePlatforms = {}
    for (const p of HEALTH_PLATFORMS) {
      const pCfg = config[p]
      if (!pCfg.enabled) {
        states[p].byModel.clear()
        states[p].plannedModels = []
        immediatePlatforms[p] = false
        continue
      }
      if (!pCfg.all_models && pCfg.models.length > 0) {
        pruneUnmanagedSnapshots(p, pCfg.models)
      }
      immediatePlatforms[p] = !prevEnabled[p] && pCfg.enabled
    }
    if (restart) {
      start({ immediate: false, immediatePlatforms })
    }
    return config
  }

  return {
    getConfig,
    setConfig,
    getSnapshot,
    getSnapshots,
    rawSnapshot,
    rawSnapshots,
    decide,
    runRealProbe,
    runPlatformProbe,
    runGeminiRealProbe,
    start,
    stop,
  }
}
