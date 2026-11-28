/**
 * Anthropic-only pool-level System Prompt policy SSOT.
 *
 * Hard platform boundary (PRD v4 §4.2, Architecture v4 §6.3):
 * - OpenAI (`openai` / `codex`) and Google (`google` / `gemini`) pools and
 *   non-Anthropic nodes ALWAYS resolve to `passthrough` (zero system injection).
 * - Only `anthropic` pools and Anthropic nodes inside `mixed`/`api` pools
 *   apply explicit pool system prompt policies (`official`, `zero_inject`,
 *   `override`, `append`, `passthrough`, `inherit_global`).
 * - Internal probes / JEV / classifier calls are always exempt (`passthrough`).
 * - Precedence: explicit Anthropic pool policy (`mode !== 'inherit_global'`)
 *   strictly overrides global `routing.compatibility`.
 */
import { resolveGlobalUnifiedPreset } from '../identity/system-prompt-spec.mjs'

export const POOL_SYSTEM_PROMPT_MODES = Object.freeze([
  'official',
  'zero_inject',
  'override',
  'append',
  'passthrough',
  'inherit_global',
])

export const POOL_SYSTEM_PROMPT_PRESETS = Object.freeze(['official_full', 'official', 'official_303'])

export const POOL_CLIENT_SYSTEM_POLICIES = Object.freeze(['prepend_pool', 'append_pool', 'replace_client'])

export const POOL_PROMPT_MAX_BYTES = 64 * 1024

const PROMPT_LOCKED_PROVIDERS = new Set(['openai', 'google'])

export function normalizePoolPromptProvider(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
  if (!s) return ''
  if (s === 'anthropic' || s === 'claude' || s === 'claude_vm') return 'anthropic'
  if (s === 'openai' || s === 'codex' || s === 'codex_vm' || s === 'gpt') return 'openai'
  if (s === 'google' || s === 'gemini' || s === 'gemini_env') return 'google'
  if (s === 'api' || s === 'api_endpoint') return 'api'
  if (s === 'mixed') return 'mixed'
  return s
}

export function normalizePoolPromptMode(value, fallback = 'inherit_global') {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  return POOL_SYSTEM_PROMPT_MODES.includes(raw) ? raw : fallback
}

export function normalizePoolPromptPreset(value, fallback = 'official_full') {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  return POOL_SYSTEM_PROMPT_PRESETS.includes(raw) ? raw : fallback
}

export function normalizeClientSystemPolicy(value, fallback = 'prepend_pool') {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  return POOL_CLIENT_SYSTEM_POLICIES.includes(raw) ? raw : fallback
}

export function requestedPoolIdFromHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object') return null
  const raw = headers['x-vm2api-pool'] ?? headers['X-VM2API-Pool'] ?? ''
  const id = String(raw || '').trim()
  return id || null
}

/**
 * Global zero-inject compatibility check using unified system prompt SSOT.
 */
export function resolveGlobalZeroInject(routing = null) {
  if (!routing || typeof routing !== 'object') return false
  return resolveGlobalUnifiedPreset(routing) === 'zero'
}

/**
 * Validate UTF-8 byte length against the 64 KiB non-v3 CRAG argv limit.
 */
export function validatePoolPromptBytes(text, { nativeV3 = false, maxBytes = POOL_PROMPT_MAX_BYTES } = {}) {
  const bytes = Buffer.byteLength(String(text || ''), 'utf8')
  if (!nativeV3 && bytes > maxBytes) {
    const error = new Error(`pool system_prompt_text is ${bytes} bytes; non-v3 CRAG stops at ${maxBytes} bytes`)
    error.status = 400
    error.code = 'crag_prompt_too_large'
    error.body = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'crag_prompt_too_large',
        message: error.message,
      },
    }
    throw error
  }
  return bytes
}

/**
 * Resolve the effective System Prompt policy for a request/attempt.
 *
 * Returns `{ mode, preset, cragPreset, cliPreset, apiBodyPolicy, text,
 * clientSystemPolicy, source, poolId, isZeroInject, applies }`.
 */
export function resolvePoolSystemPromptPolicy(
  effectivePool = null,
  routing = {},
  { nodeProvider = null, isInternalCall = false } = {},
) {
  if (isInternalCall === true) {
    return Object.freeze({
      mode: 'passthrough',
      preset: null,
      cragPreset: null,
      cliPreset: null,
      apiBodyPolicy: null,
      text: '',
      clientSystemPolicy: 'prepend_pool',
      source: 'internal_exempt',
      poolId: effectivePool?.id || null,
      isZeroInject: false,
      applies: false,
    })
  }

  const poolProvider = normalizePoolPromptProvider(effectivePool?.provider_scope)
  const targetProvider = normalizePoolPromptProvider(nodeProvider)

  if (PROMPT_LOCKED_PROVIDERS.has(poolProvider)) {
    return Object.freeze({
      mode: 'passthrough',
      preset: null,
      cragPreset: null,
      cliPreset: null,
      apiBodyPolicy: null,
      text: '',
      clientSystemPolicy: 'prepend_pool',
      source: 'provider_exempt',
      poolId: effectivePool?.id || null,
      isZeroInject: false,
      applies: false,
    })
  }

  if (targetProvider && targetProvider !== 'anthropic') {
    return Object.freeze({
      mode: 'passthrough',
      preset: null,
      cragPreset: null,
      cliPreset: null,
      apiBodyPolicy: null,
      text: '',
      clientSystemPolicy: 'prepend_pool',
      source: 'provider_exempt',
      poolId: effectivePool?.id || null,
      isZeroInject: false,
      applies: false,
    })
  }

  const globalPreset = resolveGlobalUnifiedPreset(routing)
  const globalZero = globalPreset === 'zero'
  const globalCragPreset = globalPreset

  if (!effectivePool || typeof effectivePool !== 'object') {
    return Object.freeze({
      mode: 'inherit_global',
      preset: null,
      cragPreset: globalCragPreset,
      cliPreset: null,
      apiBodyPolicy: null,
      text: '',
      clientSystemPolicy: 'prepend_pool',
      source: 'global',
      poolId: null,
      isZeroInject: globalZero,
      applies: false,
    })
  }

  const mode = normalizePoolPromptMode(effectivePool.system_prompt_mode, 'inherit_global')
  if (mode === 'inherit_global') {
    return Object.freeze({
      mode: 'inherit_global',
      preset: null,
      cragPreset: globalCragPreset,
      cliPreset: null,
      apiBodyPolicy: null,
      text: '',
      clientSystemPolicy: 'prepend_pool',
      source: 'inherit_global',
      poolId: effectivePool.id || null,
      isZeroInject: globalZero,
      applies: false,
    })
  }

  const preset = normalizePoolPromptPreset(effectivePool.system_prompt_preset, 'official_full')
  const canonicalPreset = preset === 'official' ? 'official' : 'official_full'
  const text = typeof effectivePool.system_prompt_text === 'string' ? effectivePool.system_prompt_text : ''
  const clientSystemPolicy = normalizeClientSystemPolicy(effectivePool.client_system_policy, 'prepend_pool')

  if (mode === 'official') {
    return Object.freeze({
      mode: 'official',
      preset: canonicalPreset,
      cragPreset: canonicalPreset,
      cliPreset: canonicalPreset,
      apiBodyPolicy: 'persona',
      text: '',
      clientSystemPolicy: 'prepend_pool',
      source: 'pool',
      poolId: effectivePool.id || null,
      isZeroInject: false,
      applies: true,
    })
  }

  if (mode === 'zero_inject') {
    return Object.freeze({
      mode: 'zero_inject',
      preset: 'zero',
      cragPreset: 'zero',
      cliPreset: 'zero',
      apiBodyPolicy: 'caller',
      text: '',
      clientSystemPolicy: 'prepend_pool',
      source: 'pool',
      poolId: effectivePool.id || null,
      isZeroInject: true,
      applies: true,
    })
  }

  if (mode === 'override') {
    return Object.freeze({
      mode: 'override',
      preset: 'zero',
      cragPreset: 'zero',
      cliPreset: 'zero',
      apiBodyPolicy: 'caller',
      text,
      clientSystemPolicy,
      source: 'pool',
      poolId: effectivePool.id || null,
      isZeroInject: false,
      applies: true,
    })
  }

  if (mode === 'append') {
    return Object.freeze({
      mode: 'append',
      preset: canonicalPreset,
      cragPreset: canonicalPreset,
      cliPreset: canonicalPreset,
      apiBodyPolicy: 'persona',
      text,
      clientSystemPolicy: 'append_pool',
      source: 'pool',
      poolId: effectivePool.id || null,
      isZeroInject: false,
      applies: true,
    })
  }

  // `passthrough`
  return Object.freeze({
    mode: 'passthrough',
    preset: null,
    cragPreset: null,
    cliPreset: 'none',
    apiBodyPolicy: 'caller',
    text: '',
    clientSystemPolicy: 'prepend_pool',
    source: 'pool',
    poolId: effectivePool.id || null,
    isZeroInject: false,
    applies: true,
  })
}

/**
 * Step [2] pre-evaluation helper used by JEV `detectDistill` and
 * `/v1/messages/count_tokens` before slot admission.
 */
export function isPoolZeroInjectMode(effectivePool = null, routing = {}, options = {}) {
  return resolvePoolSystemPromptPolicy(effectivePool, routing, options).isZeroInject === true
}

function toSystemBlocks(system) {
  if (system == null || system === '') return []
  if (typeof system === 'string') return [{ type: 'text', text: system }]
  if (!Array.isArray(system)) return []
  return system
    .map((block) => {
      if (typeof block === 'string') return block ? { type: 'text', text: block } : null
      if (block && typeof block === 'object') return { ...block }
      return null
    })
    .filter(Boolean)
}

/**
 * Non-mutating merge of caller `system` with pool `override` or `append` text.
 * - `append`: ALWAYS appends pool text at the tail to preserve Prompt Cache prefix.
 * - `override`: respects `clientSystemPolicy` (`prepend_pool` | `append_pool` | `replace_client`).
 */
export function applyPoolSystemToBlocks(callerSystem, policy) {
  if (!policy || !policy.applies) return callerSystem
  const poolText = typeof policy.text === 'string' ? policy.text : ''
  const poolBlocks = poolText ? [{ type: 'text', text: poolText }] : []

  if (policy.mode === 'append') {
    if (!poolBlocks.length) return callerSystem
    const clientBlocks = toSystemBlocks(callerSystem)
    return [...clientBlocks, ...poolBlocks]
  }

  if (policy.mode === 'override') {
    const clientBlocks = toSystemBlocks(callerSystem)
    const mergePolicy = normalizeClientSystemPolicy(policy.clientSystemPolicy, 'prepend_pool')
    if (mergePolicy === 'replace_client') return poolBlocks
    if (mergePolicy === 'append_pool') return [...clientBlocks, ...poolBlocks]
    return [...poolBlocks, ...clientBlocks]
  }

  return callerSystem
}

/**
 * Non-mutating Anthropic request body transform for `cli-node`, HTTP OAuth,
 * and Anthropic API Direct execution paths.
 */
export function applyPoolPromptToAnthropicBody(body, policy) {
  if (!body || typeof body !== 'object' || !policy || !policy.applies) return body
  if (policy.mode !== 'override' && policy.mode !== 'append') return body
  const merged = applyPoolSystemToBlocks(body.system, policy)
  const next = { ...body }
  if (Array.isArray(merged) && merged.length === 0) {
    delete next.system
  } else if (merged != null) {
    next.system = merged
  }
  return next
}
