/**
 * Slot data-plane engine + unofficial persona override.
 *
 * inference_engine: 公开仓只认 `rust` = cli-hop（kernel → Claude Code）。
 * 历史 `go` / worker 取值一律收成 rust，不再启用 Go HTTP 转发。
 * rust 下 official_cc inference 强制 cli-hop。
 * Setup Token 换票走 sessionKey/PKCE 脚本，不启 claude setup-token PTY；
 * 推理仍跟槽位 engine：配 rust 就 cli-hop。
 * persona_preset official|official_full|zero|official_303 on a VM overrides the global protocol;
 * empty inherits routing.compatibility.persona_preset.
 */
import {
  normalizePersonaPreset,
  OFFICIAL_303_PRESET,
  personaPresetFromLegacyMode,
} from '../identity/persona-template.mjs'
import { isCodexVm } from './vm-kind.mjs'

export const INFERENCE_ENGINES = Object.freeze(['rust'])
export const SLOT_PERSONA_PRESETS = Object.freeze(['official', 'official_full', 'zero', OFFICIAL_303_PRESET])
export const OFFICIAL_CC_INFERENCES = Object.freeze(['http', 'cli-hop'])
export const KERNEL_DATAPLANES = Object.freeze(['wrap', 'cc', 'crag'])
export const CONTAINER_CLI_NODE_BIN = '/home/kincli/.kin/cli-node'
export const CONTAINER_CC_NODE_BIN = '/home/kincli/.kin/cc-node'
export const CONTAINER_CRAG_CLAUDE_BIN = CONTAINER_CC_NODE_BIN
// Cluster-node slots run the self-contained image: binaries live in the image,
// not in the bind-mounted home (see cluster/slot-image.mjs).
export const REMOTE_KIN_DIR = '/opt/kin'
export const REMOTE_KERNEL_ENTRY = `${REMOTE_KIN_DIR}/kin-kernel`
export const REMOTE_CLI_NODE_BIN = `${REMOTE_KIN_DIR}/cli-node`
export const REMOTE_CC_NODE_BIN = `${REMOTE_KIN_DIR}/cc-node`

export const KERNEL_NATIVE_SLOT_COUNT = 20
export const SESSION_SLOT_MIN = 1
export const SESSION_SLOT_MAX = KERNEL_NATIVE_SLOT_COUNT
export const SESSION_IDLE_TTL_MIN = 1
export const SESSION_IDLE_TTL_MAX = 86400
export const SESSION_IDLE_TTL_DEFAULT = 600

export function normalizeSessionIdleTtlSeconds(value, fallback = SESSION_IDLE_TTL_DEFAULT) {
  const fallbackValue = Number(fallback)
  const safeFallback =
    Number.isInteger(fallbackValue) && fallbackValue >= SESSION_IDLE_TTL_MIN && fallbackValue <= SESSION_IDLE_TTL_MAX
      ? fallbackValue
      : SESSION_IDLE_TTL_DEFAULT
  if (value == null || value === '') return safeFallback
  const n = value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < SESSION_IDLE_TTL_MIN || n > SESSION_IDLE_TTL_MAX)
    return safeFallback
  return n
}

export function normalizeSessionSlots(value, fallback = SESSION_SLOT_MAX) {
  const fallbackValue = Number(fallback)
  const safeFallback =
    Number.isFinite(fallbackValue) && fallbackValue >= SESSION_SLOT_MIN && fallbackValue <= SESSION_SLOT_MAX
      ? Math.round(fallbackValue)
      : SESSION_SLOT_MAX
  if (value == null || value === '') return safeFallback
  const n = Number(value)
  if (!Number.isFinite(n)) return safeFallback
  return Math.min(SESSION_SLOT_MAX, Math.max(SESSION_SLOT_MIN, Math.round(n)))
}

export function resolveSessionSlots(vm, routing = {}) {
  return normalizeSessionSlots(vm?.policy?.sessionSlots ?? vm?.session_slots, routing?.inference?.session_slots)
}

export function normalizeInferenceEngine(value, { inherit = false } = {}) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!raw) return inherit ? '' : 'rust'
  if (
    raw === 'rust' ||
    raw === 'kernel' ||
    raw === 'kin-kernel' ||
    raw === 'go' ||
    raw === 'worker' ||
    raw === 'go-worker'
  ) {
    return 'rust'
  }
  return inherit ? '' : 'rust'
}

export function normalizeSlotPersonaPreset(value, { inherit = false } = {}) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!raw || raw === 'inherit' || raw === 'global' || raw === 'default') {
    return inherit ? '' : null
  }
  if (raw === 'official_full' || raw === 'full' || raw === 'agent_official') return 'official_full'
  if (
    raw === 'official' ||
    raw === 'official_prompt' ||
    raw === 'prompt' ||
    raw === 'agent_prompt' ||
    raw === 'cc_prompt'
  )
    return 'official'
  if (raw === 'zero' || raw === 'zero_inject' || raw === '0inject' || raw === '0-inject') return 'zero'
  if (raw === OFFICIAL_303_PRESET || raw === '303' || raw === 'official-303') return OFFICIAL_303_PRESET
  return inherit ? '' : null
}

function optionalBool(value, fallback) {
  if (value == null || value === '') return fallback
  return value === true
}

function optionalTtlMs(value, fallback = 2000) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

export function normalizeInferenceConfig(raw = {}) {
  return {
    engine: normalizeInferenceEngine(raw.engine),
    fallback_to_go: false,
    strict: raw.strict === true,
    eager_start: optionalBool(raw.eager_start, true),
    health_ttl_ms: optionalTtlMs(raw.health_ttl_ms, 2000),
    tcp_nodelay: optionalBool(raw.tcp_nodelay, true),
    session_slots: normalizeSessionSlots(raw.session_slots),
    session_idle_ttl_seconds: normalizeSessionIdleTtlSeconds(raw.session_idle_ttl_seconds),
    dataplane: normalizeKernelDataplane(raw.dataplane),
  }
}

export function resolveInferenceEngine(vm, routing = {}) {
  if (isCodexVm(vm)) return null
  const fromVm = normalizeInferenceEngine(vm?.inference_engine, { inherit: true })
  if (fromVm) return fromVm
  return normalizeInferenceEngine(routing?.inference?.engine)
}

export function normalizeKernelDataplane(value, { inherit = false } = {}) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('_', '-')
  if (!raw || raw === 'inherit' || raw === 'global' || raw === 'default' || raw === 'auto') {
    return inherit ? '' : 'wrap'
  }
  if (raw === 'wrap' || raw === 'cli-node' || raw === 'native-messages' || raw === 'nativemessages') {
    return 'wrap'
  }
  if (raw === 'cc' || raw === 'cc-node') return 'cc'
  if (raw === 'crag' || raw === 'official-cli' || raw === 'official-cc' || raw === 'claude-code') {
    return 'crag'
  }
  return inherit ? '' : 'wrap'
}

export function resolveKernelDataplane(vm, routing = {}) {
  if (isCodexVm(vm)) return null
  const fromVm = normalizeKernelDataplane(vm?.dataplane, { inherit: true })
  if (fromVm) return fromVm
  return normalizeKernelDataplane(routing?.inference?.dataplane)
}

export function parseKernelDataplanePatch(value) {
  if (value == null || value === '') return { ok: true, value: '' }
  const parsed = normalizeKernelDataplane(value, { inherit: true })
  if (!parsed) return { ok: true, value: '' }
  if (!KERNEL_DATAPLANES.includes(parsed)) {
    return { ok: false, error: 'dataplane must be wrap, cc, or crag' }
  }
  return { ok: true, value: parsed }
}

export function normalizeOfficialCcInference(value, { inherit = false } = {}) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('_', '-')
  if (!raw || raw === 'inherit' || raw === 'global' || raw === 'default') {
    return inherit ? '' : 'http'
  }
  if (raw === 'http' || raw === 'hop' || raw === 'anthropic-api' || raw === 'anthropic_api') return 'http'
  if (raw === 'cli-hop' || raw === 'clihop' || raw === 'local-cli' || raw === 'local_cli') return 'cli-hop'
  return inherit ? '' : 'http'
}

export function resolveOfficialCcInference(vm, routing = {}) {
  if (isCodexVm(vm)) return null
  if (resolveInferenceEngine(vm, routing) === 'rust') return 'cli-hop'
  const fromVm = normalizeOfficialCcInference(vm?.official_cc_inference, { inherit: true })
  if (fromVm) return fromVm
  return normalizeOfficialCcInference(routing?.official_cc?.inference)
}

export function assertCliHopAllowed(vm, routing = {}) {
  if (resolveOfficialCcInference(vm, routing) !== 'cli-hop') return { ok: true }
  if (resolveInferenceEngine(vm, routing) !== 'rust') {
    return { ok: false, error: 'official_cc.inference=cli-hop requires inference.engine=rust' }
  }
  return { ok: true }
}

export function parseOfficialCcInferencePatch(value) {
  if (value == null) return { ok: true, value: '' }
  const raw = String(value).trim().toLowerCase().replaceAll('_', '-')
  if (!raw || raw === 'inherit' || raw === 'global' || raw === 'default') {
    return { ok: true, value: '' }
  }
  if (raw === 'http' || raw === 'cli-hop') return { ok: true, value: raw }
  return { ok: false, error: 'official_cc.inference must be http, cli-hop, or empty' }
}

export function resolveSlotPersonaPreset(vm, routing = {}) {
  const compat = routing?.compatibility || {}
  // Official-only deployments keep the caller's genuine Claude Code wire body.
  // The kernel must not append the full official prompt on top of it; `zero`
  // is the only kernel layout that still keeps the caller system block.
  if (compat.official_cc_passthrough === true) return 'zero'
  const fromVm = normalizeSlotPersonaPreset(vm?.persona_preset, { inherit: true })
  if (fromVm) return fromVm
  if (compat.persona_preset != null && String(compat.persona_preset).trim() !== '') {
    return normalizePersonaPreset(compat.persona_preset)
  }
  return personaPresetFromLegacyMode(compat.persona_inject)
}

export function personaModeFromPreset(preset) {
  if (preset === 'zero') return 'zero'
  if (preset === 'official') return 'official_prompt'
  if (preset === 'official_full') return 'official_full'
  if (preset === OFFICIAL_303_PRESET) return OFFICIAL_303_PRESET
  return null
}

/** zero stays zero. Other presets stay identity; the CLI preserves a 303-shaped system there. */
export function resolveCliSystemLayout(vm, routing = {}) {
  const preset = resolveSlotPersonaPreset(vm, routing)
  if (preset === 'zero') return 'zero'
  return 'identity'
}

/** Explicit hop mode when the VM overrides global protocol. Null = inherit. */
export function slotPersonaModeOverride(vm) {
  return personaModeFromPreset(normalizeSlotPersonaPreset(vm?.persona_preset, { inherit: true }))
}

export function parseInferenceEnginePatch(value) {
  if (value == null) return { ok: true, value: '' }
  const raw = String(value).trim().toLowerCase()
  if (!raw || raw === 'inherit' || raw === 'global' || raw === 'default') {
    return { ok: true, value: '' }
  }
  if (
    raw === 'rust' ||
    raw === 'kernel' ||
    raw === 'kin-kernel' ||
    raw === 'go' ||
    raw === 'worker' ||
    raw === 'go-worker'
  ) {
    return { ok: true, value: 'rust' }
  }
  return { ok: false, error: 'inference_engine must be rust or empty' }
}

export function parseSlotPersonaPresetPatch(value) {
  if (value == null) return { ok: true, value: '' }
  const raw = String(value).trim().toLowerCase()
  if (!raw || raw === 'inherit' || raw === 'global' || raw === 'default') {
    return { ok: true, value: '' }
  }
  const preset = normalizeSlotPersonaPreset(raw)
  if (preset) return { ok: true, value: preset }
  return { ok: false, error: 'persona_preset must be official, official_full, zero, official_303, or empty' }
}

export function parseSlotEnginePolicyPatch(body = {}) {
  const hasEngine = Object.prototype.hasOwnProperty.call(body, 'inference_engine')
  const hasPersona = Object.prototype.hasOwnProperty.call(body, 'persona_preset')
  const hasDataplane = Object.prototype.hasOwnProperty.call(body, 'dataplane')
  if (!hasEngine && !hasPersona && !hasDataplane) {
    return { ok: false, error: 'inference_engine, persona_preset or dataplane required' }
  }
  const patch = {}
  if (hasEngine) {
    const parsed = parseInferenceEnginePatch(body.inference_engine)
    if (!parsed.ok) return parsed
    patch.inference_engine = parsed.value
  }
  if (hasPersona) {
    const parsed = parseSlotPersonaPresetPatch(body.persona_preset)
    if (!parsed.ok) return parsed
    patch.persona_preset = parsed.value
  }
  if (hasDataplane) {
    const parsed = parseKernelDataplanePatch(body.dataplane)
    if (!parsed.ok) return parsed
    patch.dataplane = parsed.value
  }
  return { ok: true, patch }
}

export function parseSlotPolicyTargets(body = {}) {
  if (body.all === true) return { ok: true, all: true, ids: [] }
  if (!Array.isArray(body.ids)) {
    return { ok: false, error: 'ids or all required' }
  }
  const ids = [...new Set(body.ids.map((id) => String(id || '').trim()).filter(Boolean))]
  if (!ids.length) return { ok: false, error: 'ids required' }
  return { ok: true, all: false, ids }
}

export function validateInferenceRoutingPatch(body = {}) {
  if (!body || typeof body !== 'object' || body.inference == null) return []
  if (typeof body.inference !== 'object' || Array.isArray(body.inference)) {
    return ['inference 必须是对象']
  }
  const errors = []
  if (Object.prototype.hasOwnProperty.call(body.inference, 'engine')) {
    const parsed = parseInferenceEnginePatch(body.inference.engine)
    if (!parsed.ok) errors.push(parsed.error)
    else if (!parsed.value) errors.push('inference.engine 必须是 rust')
  }
  if (
    Object.prototype.hasOwnProperty.call(body.inference, 'fallback_to_go') &&
    typeof body.inference.fallback_to_go !== 'boolean'
  ) {
    errors.push('inference.fallback_to_go 必须是布尔值')
  }
  if (Object.prototype.hasOwnProperty.call(body.inference, 'strict') && typeof body.inference.strict !== 'boolean') {
    errors.push('inference.strict 必须是布尔值')
  }
  if (
    Object.prototype.hasOwnProperty.call(body.inference, 'eager_start') &&
    typeof body.inference.eager_start !== 'boolean'
  ) {
    errors.push('inference.eager_start 必须是布尔值')
  }
  if (
    Object.prototype.hasOwnProperty.call(body.inference, 'tcp_nodelay') &&
    typeof body.inference.tcp_nodelay !== 'boolean'
  ) {
    errors.push('inference.tcp_nodelay 必须是布尔值')
  }
  if (Object.prototype.hasOwnProperty.call(body.inference, 'session_slots')) {
    const n = Number(body.inference.session_slots)
    if (!Number.isInteger(n) || n < SESSION_SLOT_MIN || n > SESSION_SLOT_MAX) {
      errors.push(`inference.session_slots 必须是 ${SESSION_SLOT_MIN}–${SESSION_SLOT_MAX} 的整数`)
    }
  }
  if (Object.prototype.hasOwnProperty.call(body.inference, 'session_idle_ttl_seconds')) {
    const n = body.inference.session_idle_ttl_seconds
    if (typeof n !== 'number' || !Number.isInteger(n) || n < SESSION_IDLE_TTL_MIN || n > SESSION_IDLE_TTL_MAX) {
      errors.push(`inference.session_idle_ttl_seconds 必须是 ${SESSION_IDLE_TTL_MIN}–${SESSION_IDLE_TTL_MAX} 的整数`)
    }
  }
  if (Object.prototype.hasOwnProperty.call(body.inference, 'health_ttl_ms')) {
    const n = Number(body.inference.health_ttl_ms)
    if (!Number.isFinite(n) || n < 0) errors.push('inference.health_ttl_ms 必须是 >= 0 的数字')
  }
  if (Object.prototype.hasOwnProperty.call(body.inference, 'dataplane')) {
    const parsed = parseKernelDataplanePatch(body.inference.dataplane)
    if (!parsed.ok) errors.push(parsed.error)
    else if (!parsed.value) errors.push('inference.dataplane 必须是 wrap、cc 或 crag')
  }
  return errors
}
