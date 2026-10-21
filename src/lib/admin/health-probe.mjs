/**
 * Fleet Messages health snapshot + unofficial probe intercept.
 * Real probes hop a slot on an interval. Matching third-party health
 * shapes replay the cached official Messages body (standard protocol
 * shape, real upstream id) and never acquire concurrency.
 */
import { isOfficialClaudeUa } from '../identity/crs-headers.mjs'
import { isOfficialClaudeCodeTraffic } from '../identity/crs-persona.mjs'
import { vmHasClaudeCredential } from '../vm/vm-registry.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import { activeHoursOf, evaluateActiveHours } from '../pool/active-hours.mjs'
import { fromClaudeToOpenAIChat, fromClaudeToOpenAICompletions, fromClaudeToResponses } from '../protocol/convert.mjs'
import { detectInboundPlatform } from '../protocol/platform-detect.mjs'
import { backgroundTasksFor } from '../core/shared-background-tasks.mjs'
import { isKubernetesMode } from '../core/control-plane-mode.mjs'
import { getSharedRoutingState } from './shared-routing-config.mjs'

export const HEALTH_REAL_HEADER = 'x-kin-health-real'
export const HEALTH_VIA_CACHE = 'health-cache'
export const HEALTH_VIA_UNAVAILABLE = 'health_unavailable'
export const HEALTH_PROBE_UA = 'kin-health-probe/1.0'

export const DEFAULT_HEALTH_PROBE = Object.freeze({
  // Off by default. Third-party health checks then take a real seat.
  // Operators turn the cache on under 设置 → 探测.
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
  // Off: stop after the first successful slot (cache snapshot unchanged). On: probe every
  // schedulable slot each interval; first success still writes the cache snapshot.
  probe_all_slots: false,
  concurrency: 2,
  real: Object.freeze({
    model: 'claude-haiku-4-5',
    prompt: 'hello',
    max_tokens: 64,
    timeout_ms: 60_000,
    outbound_mode: 'official',
    vm_ids: Object.freeze([]),
    // GPT snapshot for chat/responses on GPT models. Empty = no Codex probe.
    openai_model: '',
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
    // new-api / sub2api chat and responses tests send no max_tokens at all.
    allow_missing_max_tokens: true,
    // sub2api account test: CC banner system + "hi" + 1024 + temperature 1.
    sub2api_account_test: true,
  }),
})

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

function normalizeCacheModels(input) {
  if (typeof input === 'string') {
    input = input.split(/[,，\n]+/)
  }
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()
  for (const raw of input) {
    const id = String(raw || '').trim()
    const key = normalizeModelId(id)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(id)
  }
  return out
}

export function cacheTtlSec(cfg = DEFAULT_HEALTH_PROBE) {
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
  if (pinned) return pinned
  return String(inbound?.model || snapshot?.model || cfg?.real?.model || 'claude-haiku-4-5').trim()
}

export function normalizeHealthProbeConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const realSrc = src.real && typeof src.real === 'object' ? src.real : {}
  const matchSrc = src.match && typeof src.match === 'object' ? src.match : {}
  const modeRaw = String(realSrc.outbound_mode || DEFAULT_HEALTH_PROBE.real.outbound_mode).toLowerCase()
  const ttl = clampInt(src.cache_ttl_sec ?? src.max_stale_sec, 30, 172800, DEFAULT_HEALTH_PROBE.cache_ttl_sec)
  return {
    enabled: asBool(src.enabled, DEFAULT_HEALTH_PROBE.enabled),
    interval_sec: clampInt(src.interval_sec, 30, 86400, DEFAULT_HEALTH_PROBE.interval_sec),
    cache_ttl_sec: ttl,
    max_stale_sec: ttl,
    cache_models: normalizeCacheModels(src.cache_models),
    cache_model: String(src.cache_model || '')
      .trim()
      .slice(0, 120),
    intercept_unofficial: asBool(src.intercept_unofficial, true),
    intercept_warmup: asBool(src.intercept_warmup, DEFAULT_HEALTH_PROBE.intercept_warmup),
    fail_closed: asBool(src.fail_closed, true),
    run_on_start: asBool(src.run_on_start, true),
    probe_all_slots: asBool(src.probe_all_slots, DEFAULT_HEALTH_PROBE.probe_all_slots),
    concurrency: clampInt(src.concurrency, 1, 8, DEFAULT_HEALTH_PROBE.concurrency),
    real: {
      model: String(realSrc.model || DEFAULT_HEALTH_PROBE.real.model).trim() || DEFAULT_HEALTH_PROBE.real.model,
      prompt:
        String(realSrc.prompt ?? DEFAULT_HEALTH_PROBE.real.prompt)
          .trim()
          .slice(0, 200) || DEFAULT_HEALTH_PROBE.real.prompt,
      max_tokens: clampInt(realSrc.max_tokens, 1, 128000, DEFAULT_HEALTH_PROBE.real.max_tokens),
      timeout_ms: clampInt(realSrc.timeout_ms, 10_000, 180_000, DEFAULT_HEALTH_PROBE.real.timeout_ms),
      outbound_mode: modeRaw === 'unofficial' ? 'unofficial' : 'official',
      vm_ids: normalizeVmIds(realSrc.vm_ids),
      openai_model: String(realSrc.openai_model || '')
        .trim()
        .slice(0, 120),
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
  return ''
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
  if (typeof body.prompt === 'string' && !Array.isArray(body.messages) && body.input == null) {
    return { text: body.prompt.trim(), messages: 1, users: 1 }
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
  const n = Number(body?.max_tokens ?? body?.max_completion_tokens)
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
 * sub2api AccountTestService payload: official CC banner as the whole system,
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
 *   for OpenAI chat / responses (new-api and sub2api send none there).
 */
export function isHealthShape(headers = {}, body = {}, cfg = DEFAULT_HEALTH_PROBE, protocol = '') {
  const match = cfg?.match || DEFAULT_HEALTH_PROBE.match
  if (isHealthRealBypass(headers)) return false
  if (match.sub2api_account_test !== false && protocol !== 'openai.responses' && isSub2apiAccountTest(body)) {
    return true
  }
  if (isOfficialClaudeCodeTraffic(headers, body)) return false
  if (match.skip_official !== false && isOfficialClaudeUa(headerUa(headers))) return false
  if (match.ua_regex) {
    try {
      if (!new RegExp(match.ua_regex, 'i').test(headerUa(headers))) return false
    } catch {
      return false
    }
  }
  const maxTokens = inboundMaxTokens(body)
  const openaiSide = protocol === 'openai.chat' || protocol === 'openai.responses'
  const missingOk =
    match.allow_missing_max_tokens !== false &&
    openaiSide &&
    body?.max_tokens == null &&
    body?.max_completion_tokens == null &&
    body?.max_output_tokens == null
  if (!missingOk && (!maxTokens || maxTokens > match.max_tokens)) return false
  // Responses tests carry a long instructions prompt; only system is checked.
  if (match.require_no_system !== false && systemText(body?.system)) return false
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

export function isSnapshotValid(snapshot, cfg = DEFAULT_HEALTH_PROBE, now = Date.now()) {
  if (!snapshot || snapshot.ok !== true || !snapshot.at) return false
  const at = Date.parse(snapshot.at)
  if (!Number.isFinite(at)) return false
  const age = now - at
  const staleMs = cacheTtlSec(cfg) * 1000
  return age >= 0 && age <= staleMs
}

export function viewSnapshot(snapshot, cfg = DEFAULT_HEALTH_PROBE, now = Date.now(), nextAt = null) {
  const valid = isSnapshotValid(snapshot, cfg, now)
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
    duration_ms: snapshot?.duration_ms || null,
    next_at: nextAt,
    age_ms: snapshot?.at ? Math.max(0, now - Date.parse(snapshot.at) || 0) : null,
    cache_ttl_sec: cacheTtlSec(cfg),
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

/** Which cached snapshot answers this inbound model: GPT models use the Codex probe. */
export function healthPlatformOf(body = {}) {
  const platform = detectInboundPlatform(body?.model)
  return platform.ok && platform.platform === 'openai' ? 'openai' : 'anthropic'
}

export function decideHealthIntercept({
  headers = {},
  body = {},
  cfg = DEFAULT_HEALTH_PROBE,
  snapshot = null,
  now = Date.now(),
  protocol = '',
} = {}) {
  if (!cfg?.enabled || !cfg.intercept_unofficial) return { action: 'pass' }
  if (!isHealthShape(headers, body, cfg, protocol)) return { action: 'pass' }
  if (!inboundMatchesCacheModels(body, cfg)) return { action: 'pass' }
  if (isSnapshotValid(snapshot, cfg, now) && hasCachedMessage(snapshot)) {
    return { action: 'cache', snapshot, via: HEALTH_VIA_CACHE }
  }
  if (!cfg.fail_closed) return { action: 'pass' }
  // Only 503 when the fleet has no hop target. A 401/timeout on one slot
  // must not fail-closed every third-party hello while other accounts are live.
  if (snapshot?.error === 'no_schedulable_credential') {
    return { action: 'fail', snapshot, via: HEALTH_VIA_UNAVAILABLE }
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

/** Replay the cached official Messages body in the caller's protocol. No local msg_health_* ids. */
export function synthesizeProtocolResponse(protocol, inbound = {}, snapshot = {}, cfg = DEFAULT_HEALTH_PROBE) {
  const claude = cachedClaudeMessage(snapshot, inbound, cfg)
  if (!claude) return null
  if (protocol === 'openai.chat') return fromClaudeToOpenAIChat(claude, claude.model)
  if (protocol === 'openai.completions') return fromClaudeToOpenAICompletions(claude, claude.model)
  if (protocol === 'openai.responses') return fromClaudeToResponses(claude, claude.model)
  return claude
}

export function formatHealthSse(protocol, inbound, snapshot, cfg = DEFAULT_HEALTH_PROBE) {
  const claude = cachedClaudeMessage(snapshot, inbound, cfg)
  if (!claude) return ''
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
    // new-api test sets stream_options.include_usage and requires parseable usage.
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
    // sub2api processOpenAIStream fails a stream that never sends response.completed.
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
  if (/invalid_grant|refresh token not found|oauth_revoked|token has been revoked/i.test(grantErr)) return false
  const coolUntil = Number(vm.cooldown_until || vm.claude?.temp_unschedulable_until) || 0
  if (
    coolUntil > Date.now() &&
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

export function selectHealthProbeTargets(vms = [], cfg = DEFAULT_HEALTH_PROBE, now = Date.now()) {
  const allow = new Set((cfg.real?.vm_ids || []).map((id) => String(id)))
  return (vms || []).filter((vm) => {
    if (allow.size && !allow.has(vm.id)) return false
    return isHealthProbeTarget(vm, now)
  })
}

export function createHealthProbeMonitor(opts = {}) {
  let config = normalizeHealthProbeConfig(opts.config)
  // anthropic: Claude slot probe (legacy single snapshot). openai: Codex slot probe.
  const snapshots = { anthropic: null, openai: null }
  let lastRunAt = 0
  let inflight = null
  let timer = null
  let generation = 0
  let unknown = false
  const sharedTasks = backgroundTasksFor(opts.sharedTasks)
  const nowFn = opts.now || (() => Date.now())

  const getConfig = () => config
  const nextAtIso = () => {
    if (!config.enabled || !lastRunAt) return null
    return new Date(lastRunAt + config.interval_sec * 1000).toISOString()
  }

  const getSnapshot = (platform = 'anthropic') =>
    viewSnapshot(snapshots[platform] || null, config, nowFn(), nextAtIso())

  const decide = (headers, body, protocol = '') => {
    const platform = healthPlatformOf(body)
    return decideHealthIntercept({
      headers,
      body,
      protocol,
      cfg: config,
      snapshot: snapshots[platform],
      now: nowFn(),
    })
  }

  const probePlatform = async (platform, real, started) => {
    const vms = typeof opts.listTargets === 'function' ? opts.listTargets() || [] : []
    const targets = selectHealthProbeTargets(vms, config, nowFn()).filter(
      (vm) => (String(vm.platform || '').toLowerCase() === 'openai' ? 'openai' : 'anthropic') === platform,
    )
    if (!targets.length) {
      // Every slot off-shift: a still-valid good reply keeps serving until it expires.
      const prev = snapshots[platform]
      if (prev?.ok && isSnapshotValid(prev, config, nowFn())) return
      snapshots[platform] = {
        ok: false,
        at: new Date(started).toISOString(),
        vm_id: null,
        model: real.model,
        text: null,
        status: 0,
        error: 'no_schedulable_credential',
        duration_ms: nowFn() - started,
      }
      return
    }
    if (typeof opts.runChat !== 'function') {
      const prev = snapshots[platform]
      if (prev?.ok && isSnapshotValid(prev, config, nowFn())) return
      snapshots[platform] = {
        ok: false,
        at: new Date(started).toISOString(),
        vm_id: targets[0]?.id || null,
        model: real.model,
        text: null,
        status: 0,
        error: 'runChat missing',
        duration_ms: nowFn() - started,
      }
      return
    }

    const writeSuccessSnapshot = (vm, result) => {
      const body = sanitizeCachedMessage(result.body, {
        text: result.text,
        model: result.model || real.model,
        stop_reason: result.stop_reason,
        usage: result.usage,
      })
      snapshots[platform] = {
        ok: true,
        at: new Date(nowFn()).toISOString(),
        vm_id: result.vm_id || vm.id,
        model: body.model || result.model || real.model,
        text: String(result.text || 'ok').slice(0, 4000),
        status: result.status || 200,
        error: null,
        duration_ms: nowFn() - started,
        body,
      }
    }

    const probeVm = async (vm) => {
      try {
        const result = await opts.runChat(vm, real)
        if (!result?.ok && result?.taskTerminal !== true && result?.taskNotStarted !== true) unknown = true
        if (result?.ok) return { ok: true, result }
        return {
          ok: false,
          error: result?.error?.message || result?.error || 'probe_failed',
        }
      } catch (e) {
        if (e?.taskTerminal !== true && e?.taskNotStarted !== true) unknown = true
        return { ok: false, error: String(e?.message || e).slice(0, 300) }
      }
    }

    let lastError = null
    if (!config.probe_all_slots) {
      for (const vm of targets) {
        const outcome = await probeVm(vm)
        if (outcome.ok) {
          writeSuccessSnapshot(vm, outcome.result)
          return
        }
        lastError = outcome.error
      }
    } else {
      let bestOkIndex = Infinity
      const limit = config.concurrency
      let cursor = 0
      const workers = Array.from({ length: Math.min(limit, targets.length) }, async () => {
        while (cursor < targets.length) {
          const index = cursor
          const vm = targets[cursor]
          cursor += 1
          const outcome = await probeVm(vm)
          if (outcome.ok) {
            if (index < bestOkIndex) {
              bestOkIndex = index
              writeSuccessSnapshot(vm, outcome.result)
            }
          } else {
            lastError = outcome.error
          }
        }
      })
      await Promise.all(workers)
      if (snapshots[platform]?.ok) return
    }
    const failedAt = new Date(nowFn()).toISOString()
    const prev = snapshots[platform]
    if (prev?.ok && isSnapshotValid(prev, config, nowFn())) {
      snapshots[platform] = {
        ...prev,
        last_error: String(lastError || 'probe_failed').slice(0, 300),
        last_failed_at: failedAt,
      }
      return
    }
    snapshots[platform] = {
      ok: false,
      at: failedAt,
      vm_id: targets[0]?.id || null,
      model: real.model,
      text: null,
      status: 0,
      error: String(lastError || 'probe_failed').slice(0, 300),
      duration_ms: nowFn() - started,
    }
  }

  const sharedSnapshot = (platform) => {
    const snapshot = snapshots[platform]
    if (!snapshot) return null
    const usage = {}
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      const value = snapshot.body?.usage?.[key]
      if (Number.isFinite(value) && value >= 0) usage[key] = value
    }
    const view = getSnapshot(platform)
    return {
      ok: snapshot.ok,
      at: view.at,
      vm_id: view.vm_id,
      model: view.model,
      message_id: view.message_id,
      text: view.text,
      status: view.status,
      error: view.error,
      duration_ms: view.duration_ms,
      usage,
      stop_reason: snapshot.body?.stop_reason || 'end_turn',
      stop_sequence: snapshot.body?.stop_sequence ?? null,
    }
  }

  const acceptSharedSnapshot = (platform, value) => {
    if (!value?.at) return
    snapshots[platform] = {
      ok: value.ok,
      at: value.at,
      vm_id: value.vm_id,
      model: value.model,
      text: value.text,
      status: value.status,
      error: value.error,
      duration_ms: value.duration_ms,
      body: value.message_id
        ? {
            id: value.message_id,
            type: 'message',
            role: 'assistant',
            model: value.model,
            content: [{ type: 'text', text: value.text || '' }],
            usage: value.usage,
            stop_reason: value.stop_reason,
            stop_sequence: value.stop_sequence,
          }
        : undefined,
    }
  }

  const runRealProbe = async ({ scheduled = false } = {}) => {
    if (inflight) return inflight
    const current = generation
    inflight = (async () => {
      if (isKubernetesMode()) {
        const routing = getSharedRoutingState(sharedTasks?.repo.db)
        if (!routing)
          throw Object.assign(new Error('shared routing unavailable'), { code: 'routing_config_unavailable' })
        await routing.refresh()
      }
      if (scheduled && (current !== generation || !config.enabled)) return getSnapshot('anthropic')
      const probe = async () => {
        if (scheduled && (current !== generation || !config.enabled))
          return { notStarted: true, value: getSnapshot('anthropic') }
        const started = nowFn()
        lastRunAt = started
        unknown = false
        await probePlatform('anthropic', config.real, started)
        if (config.real.openai_model) {
          await probePlatform('openai', { ...config.real, model: config.real.openai_model }, started)
        } else {
          snapshots.openai = null
        }
        return {
          terminal: !unknown,
          value: getSnapshot('anthropic'),
          sharedResult: { anthropic: sharedSnapshot('anthropic'), openai: sharedSnapshot('openai') },
        }
      }
      if (!sharedTasks) return (await probe()).value
      const result = await sharedTasks.run({ taskKey: 'health-probe', intervalMs: config.interval_sec * 1000 }, probe)
      if (result.ran) return result.value
      if (result.sharedResult) {
        acceptSharedSnapshot('anthropic', result.sharedResult.anthropic)
        acceptSharedSnapshot('openai', result.sharedResult.openai)
      }
      return getSnapshot('anthropic')
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  const stop = () => {
    generation++
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    return inflight ? Promise.allSettled([inflight]) : Promise.resolve()
  }

  const start = ({ immediate = false } = {}) => {
    stop()
    if (!config.enabled) return { started: false, reason: 'disabled' }
    const current = generation
    timer = setInterval(() => {
      if (current === generation) runRealProbe({ scheduled: true }).catch(() => {})
    }, config.interval_sec * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    if (immediate && config.run_on_start) {
      queueMicrotask(() => {
        if (current === generation) runRealProbe({ scheduled: true }).catch(() => {})
      })
    }
    return { started: true, interval_sec: config.interval_sec, run_on_start: config.run_on_start }
  }

  const setConfig = (next, { restart = true } = {}) => {
    config = normalizeHealthProbeConfig(next)
    if (restart) start({ immediate: false })
    return config
  }

  return {
    getConfig,
    setConfig,
    getSnapshot,
    getSnapshots: () => ({ anthropic: getSnapshot('anthropic'), openai: getSnapshot('openai') }),
    rawSnapshot: (platform = 'anthropic') => snapshots[platform] || null,
    decide,
    runRealProbe,
    start,
    flush: async () => {
      while (inflight) await inflight
    },
    stop,
  }
}
