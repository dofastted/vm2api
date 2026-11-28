/**
 * OpenAI / Codex usage extraction aligned with
 * codex-proxy-rs gateway-protocol `extract_usage`.
 * Does not invent zeros — missing fields stay undefined.
 *
 * Cache write is unknown unless an explicit field is present. Never derive
 * writes from uncached input or (input − cached).
 *
 * Explicit write fields, first hit wins:
 *   input_tokens_details.cache_write_tokens
 *   prompt_tokens_details.cache_write_tokens
 *   cache_write_tokens
 *   input_tokens_details.cache_creation_tokens
 *   prompt_tokens_details.cache_creation_tokens
 *   cache_creation_tokens
 * `cache_creation_input_tokens` is Anthropic disjoint and is not write evidence.
 *
 * `output_tokens` already includes reasoning. `reasoning_tokens` is a subset
 * and must never be added to output.
 */

function asU64(value) {
  if (value == null || value === '') return undefined
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isInteger(value)) {
    return value
  }
  return undefined
}

function nestedU64(obj, path) {
  let cur = obj
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = cur[key]
  }
  return asU64(cur)
}

function usageObject(body) {
  if (!body || typeof body !== 'object') return null
  if (body.usage && typeof body.usage === 'object') return body.usage
  return body
}

function hasAnthropicCacheNames(usage) {
  return (
    usage.cache_read_input_tokens != null ||
    usage.cache_read_tokens != null ||
    usage.cache_creation_input_tokens != null ||
    (usage.cache_creation && typeof usage.cache_creation === 'object')
  )
}

function explicitCacheWriteTokens(usage) {
  // Anthropic disjoint name is already-converted cache creation, not OpenAI write.
  if (usage.cache_creation_input_tokens != null) return undefined
  return (
    nestedU64(usage, ['input_tokens_details', 'cache_write_tokens']) ??
    nestedU64(usage, ['prompt_tokens_details', 'cache_write_tokens']) ??
    asU64(usage.cache_write_tokens) ??
    nestedU64(usage, ['input_tokens_details', 'cache_creation_tokens']) ??
    nestedU64(usage, ['prompt_tokens_details', 'cache_creation_tokens']) ??
    asU64(usage.cache_creation_tokens)
  )
}

function explicitCachedTokens(usage) {
  return (
    nestedU64(usage, ['input_tokens_details', 'cached_tokens']) ??
    nestedU64(usage, ['prompt_tokens_details', 'cached_tokens']) ??
    asU64(usage.cached_tokens)
  )
}

function explicitReasoningTokens(usage) {
  return (
    nestedU64(usage, ['output_tokens_details', 'reasoning_tokens']) ??
    nestedU64(usage, ['completion_tokens_details', 'reasoning_tokens']) ??
    asU64(usage.reasoning_tokens)
  )
}

/**
 * @returns {null | {
 *   input_tokens?: number,
 *   output_tokens?: number,
 *   cached_tokens?: number,
 *   cache_write_tokens?: number,
 *   reasoning_tokens?: number,
 *   total_tokens?: number,
 * }}
 */
export function extractOpenaiUsage(body) {
  const usage = usageObject(body)
  if (!usage || typeof usage !== 'object') return null

  const input_tokens = asU64(usage.input_tokens) ?? asU64(usage.prompt_tokens)
  const output_tokens = asU64(usage.output_tokens) ?? asU64(usage.completion_tokens)
  const cached_tokens = explicitCachedTokens(usage)
  const cache_write_tokens = explicitCacheWriteTokens(usage)
  const reasoning_tokens = explicitReasoningTokens(usage)

  const hasUsage =
    usage.input_tokens != null ||
    usage.output_tokens != null ||
    usage.prompt_tokens != null ||
    usage.completion_tokens != null ||
    usage.cached_tokens != null ||
    usage.cache_write_tokens != null ||
    usage.cache_creation_tokens != null ||
    usage.reasoning_tokens != null ||
    usage.input_tokens_details != null ||
    usage.prompt_tokens_details != null ||
    usage.output_tokens_details != null ||
    usage.completion_tokens_details != null ||
    cached_tokens != null ||
    cache_write_tokens != null ||
    reasoning_tokens != null

  if (!hasUsage) return null

  const total_tokens =
    asU64(usage.total_tokens) ??
    (input_tokens != null || output_tokens != null ? (input_tokens || 0) + (output_tokens || 0) : undefined)

  const out = {}
  if (input_tokens != null) out.input_tokens = input_tokens
  if (output_tokens != null) out.output_tokens = output_tokens
  if (cached_tokens != null) out.cached_tokens = cached_tokens
  if (cache_write_tokens != null) out.cache_write_tokens = cache_write_tokens
  if (reasoning_tokens != null) out.reasoning_tokens = reasoning_tokens
  if (total_tokens != null) out.total_tokens = total_tokens
  return out
}

export function openaiChatUsageFromExtract(extracted) {
  if (!extracted) return null
  if (extracted.input_tokens == null && extracted.output_tokens == null) return null
  const prompt = extracted.input_tokens || 0
  const completion = extracted.output_tokens || 0
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: extracted.total_tokens ?? prompt + completion,
  }
  if (extracted.cached_tokens != null || extracted.cache_write_tokens != null) {
    out.prompt_tokens_details = {}
    if (extracted.cached_tokens != null) out.prompt_tokens_details.cached_tokens = extracted.cached_tokens
    if (extracted.cache_write_tokens != null) {
      out.prompt_tokens_details.cache_creation_tokens = extracted.cache_write_tokens
    }
  }
  if (extracted.reasoning_tokens != null) {
    out.completion_tokens_details = { reasoning_tokens: extracted.reasoning_tokens }
  }
  return out
}

export function openaiAnthropicUsageFromExtract(extracted) {
  if (!extracted) return { input_tokens: 0, output_tokens: 0 }
  const cached = extracted.cached_tokens || 0
  const written = extracted.cache_write_tokens || 0
  const input = extracted.input_tokens || 0
  const uncached = Math.max(0, input - cached - written)
  const out = {
    input_tokens: uncached,
    output_tokens: extracted.output_tokens || 0,
  }
  if (extracted.cached_tokens != null) out.cache_read_input_tokens = cached
  if (extracted.cache_write_tokens != null) out.cache_creation_input_tokens = written
  if (extracted.reasoning_tokens != null) out.reasoning_tokens = extracted.reasoning_tokens
  return out
}

/** OpenAI wire shape: no Anthropic cache names, plus prompt/details/cached aliases. */
export function isOpenaiWireUsage(usage) {
  if (!usage || typeof usage !== 'object') return false
  if (hasAnthropicCacheNames(usage)) return false
  return (
    usage.prompt_tokens != null ||
    usage.input_tokens_details != null ||
    usage.prompt_tokens_details != null ||
    usage.output_tokens_details != null ||
    usage.completion_tokens_details != null ||
    usage.cached_tokens != null ||
    usage.cache_write_tokens != null ||
    usage.reasoning_tokens != null
  )
}

/**
 * Convert OpenAI-inclusive usage to disjoint Anthropic names exactly once.
 * Already-disjoint objects (Anthropic cache names) are returned unchanged.
 * reasoning_tokens is copied as a subset of output; it is never added to output.
 */
export function disjointOpenaiUsage(usage) {
  if (!usage || typeof usage !== 'object') return usage
  if (!isOpenaiWireUsage(usage)) {
    const reasoning = explicitReasoningTokens(usage)
    if (reasoning == null || usage.reasoning_tokens != null) return usage
    return { ...usage, reasoning_tokens: reasoning }
  }
  const extracted = extractOpenaiUsage(usage)
  if (!extracted) return usage
  const converted = openaiAnthropicUsageFromExtract(extracted)
  const out = { ...usage, ...converted }
  delete out.input_tokens_details
  delete out.prompt_tokens_details
  delete out.prompt_tokens
  delete out.completion_tokens
  delete out.cached_tokens
  delete out.cache_write_tokens
  delete out.cache_creation_tokens
  return out
}

/**
 * Incremental usage merge for SSE / trailer snapshots.
 * Last-wins for present scalars; nested objects merge the same way.
 * Never sums token fields (that would double-count cache and reasoning).
 * Null/undefined patches do not clobber an earlier value.
 */
export function mergeUsage(current, next) {
  if (!next || typeof next !== 'object') return current || null
  if (!current || typeof current !== 'object') return { ...next }
  const out = { ...current }
  for (const [key, value] of Object.entries(next)) {
    if (value == null) continue
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const prev = out[key]
      out[key] = mergeUsage(prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}, value)
    } else if (
      key === 'iterations' &&
      Array.isArray(value) &&
      value.length === 0 &&
      Array.isArray(out[key]) &&
      out[key].length > 0
    ) {
      continue
    } else {
      out[key] = value
    }
  }
  return out
}

function tokenMass(usage) {
  if (!usage || typeof usage !== 'object') return 0
  if (isOpenaiWireUsage(usage)) {
    const extracted = extractOpenaiUsage(usage)
    if (!extracted) return 0
    // Inclusive OpenAI input already contains cache; reasoning is inside output.
    return (extracted.input_tokens || 0) + (extracted.output_tokens || 0)
  }
  const disjoint = disjointOpenaiUsage(usage) || usage
  return (
    (asU64(disjoint.input_tokens) || 0) +
    (asU64(disjoint.output_tokens) || asU64(disjoint.completion_tokens) || 0) +
    (asU64(disjoint.cache_read_input_tokens) || asU64(disjoint.cache_read_tokens) || 0) +
    (asU64(disjoint.cache_creation_input_tokens) || asU64(disjoint.cache_creation_tokens) || 0)
  )
}

function detailScore(usage) {
  if (!usage || typeof usage !== 'object') return 0
  let score = 0
  if (usage.input_tokens_details) score++
  if (usage.prompt_tokens_details) score++
  if (usage.output_tokens_details) score++
  if (usage.completion_tokens_details) score++
  if (usage.cache_creation && typeof usage.cache_creation === 'object') score++
  if (Array.isArray(usage.iterations) && usage.iterations.length > 0) score++
  if (usage.cached_tokens != null || usage.cache_read_input_tokens != null || usage.cache_read_tokens != null) score++
  if (
    usage.cache_write_tokens != null ||
    usage.cache_creation_tokens != null ||
    usage.cache_creation_input_tokens != null
  ) {
    score++
  }
  if (usage.reasoning_tokens != null) score++
  return score
}

/**
 * Pick the richer of two complete snapshots. Prefer mergeUsage for incremental
 * SSE/trailer combination. Token mass does not add cache on top of inclusive
 * OpenAI input and does not add reasoning on top of output. Equal mass prefers
 * the snapshot with more cache/reasoning detail.
 */
export function preferUsage(left, right) {
  if (!right) return left || null
  if (!left) return right
  const leftMass = tokenMass(left)
  const rightMass = tokenMass(right)
  if (rightMass > leftMass) return right
  if (leftMass > rightMass) return left
  return detailScore(right) > detailScore(left) ? right : left
}

/** Reasoning is part of output, preserved as detail by protocol converters. */
export function reasoningTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  return explicitReasoningTokens(usage)
}
