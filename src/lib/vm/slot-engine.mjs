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
import fs from 'node:fs'
import path from 'node:path'
import {
  normalizePersonaPreset,
  OFFICIAL_303_PRESET,
  personaPresetFromLegacyMode,
} from '../identity/persona-template.mjs'
import { resolveGlobalUnifiedPreset } from '../identity/system-prompt-spec.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { isCustomOsSlot, sharedClaudeGuestPath, sharedProfilesGuestDir } from './custom-os-runtime.mjs'
import { slotHome } from './slot-identity.mjs'

export const INFERENCE_ENGINES = Object.freeze(['rust'])
export const SLOT_PERSONA_PRESETS = Object.freeze(['official', 'official_full', 'zero', OFFICIAL_303_PRESET])
export const OFFICIAL_CC_INFERENCES = Object.freeze(['http', 'cli-hop'])
export const KERNEL_DATAPLANES = Object.freeze(['wrap', 'cc', 'crag'])
export const CRAG_KERNEL_VERSIONS = Object.freeze(['v2'])
export const CONTAINER_CLI_NODE_BIN = '/home/kincli/.kin/cli-node'
export const CONTAINER_CC_NODE_BIN = '/home/kincli/.kin/cc-node'
// Image copies under /opt/kin stay for old containers. New commands and the
// CLI path use the slot-bin mount, so a kernel pull updates bytes without a
// new image. The wrapper is replaced by rename, never unlinked first.
export const REMOTE_KIN_DIR = '/opt/kin'
export const REMOTE_LIVE_DIR = '/opt/kin-live'
export const REMOTE_KERNEL_ENTRY = `${REMOTE_LIVE_DIR}/kin-kernel`
export const REMOTE_CLI_NODE_BIN = `${REMOTE_LIVE_DIR}/cli-node`
export const REMOTE_CC_NODE_BIN = `${REMOTE_LIVE_DIR}/cc-node`
export const REMOTE_CRAG_ENTRY = `${REMOTE_LIVE_DIR}/crag-kernel`
// Default fallback version when no verified CRAG manifest is present on disk.
// Active slots resolve `officialClaude.path` & `officialClaude.version` from
// their verified CRAG manifest.json so official Claude CLI upgrades require
// zero hardcoded version bumps.
export const CRAG_CLAUDE_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/
export const CRAG_CLAUDE_DIR_RE = /^claude-code-(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)$/
export const CRAG_CLAUDE_PATH_RE = /^claude-code-(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)\/claude$/
export const CRAG_CLAUDE_VERSION = '2.1.321'
export const REMOTE_CRAG_CLAUDE = `${REMOTE_LIVE_DIR}/crag-v2/claude-code-${CRAG_CLAUDE_VERSION}/claude`
export const LOCAL_CRAG_CLAUDE = `/home/kincli/.kin/crag-v2/claude-code-${CRAG_CLAUDE_VERSION}/claude`
export const CONTAINER_CRAG_V2_CLAUDE = LOCAL_CRAG_CLAUDE

export function isHeadlessBridgeCaps(caps) {
  return Array.isArray(caps) && caps.includes('headless_claude_bridge_v1')
}

/**
 * Native CRAG v3+ kernel where the official Claude CLI / Headless Bridge owns
 * outbound beta & header assembly. Recognizes both legacy 3.1.24 TUI queue
 * (`linux_tui_native_queue`) and Phase B Option 2A (`headless_claude_bridge_v1`).
 */
export function isNativeCragV3Plus(caps) {
  return (
    Array.isArray(caps) &&
    caps.includes('generation_controls_v3') &&
    (caps.includes('linux_tui_native_queue') || caps.includes('headless_claude_bridge_v1'))
  )
}

/**
 * Resolve the single official Claude CLI relative path (`claude-code-<semver>/claude`)
 * and version from a CRAG v2 `manifest.json`.
 * - Prefers `manifest.officialClaude.path` (strictly validated against semver regex
 *   and matching `manifest.officialClaude.version` when present).
 * - Falls back to scanning `manifest.sha256` keys for legacy manifests that omit
 *   `officialClaude`, requiring exactly one `claude-code-<semver>/claude` member.
 * Returns `null` when missing, malformed, or ambiguous.
 */
export function resolveManifestClaudePath(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null
  const official = manifest.officialClaude
  if (official != null) {
    if (typeof official !== 'object' || Array.isArray(official)) return null
    const rawPath = official.path
    if (typeof rawPath !== 'string') return null
    const match = CRAG_CLAUDE_PATH_RE.exec(rawPath)
    if (!match) return null
    const version = match[1]
    if (official.version != null) {
      if (typeof official.version !== 'string' || official.version !== version) return null
    }
    return { path: rawPath, dir: `claude-code-${version}`, version }
  }
  const shaMap = manifest.sha256
  if (!shaMap || typeof shaMap !== 'object' || Array.isArray(shaMap)) return null
  const matches = []
  for (const rel of Object.keys(shaMap)) {
    const match = CRAG_CLAUDE_PATH_RE.exec(rel)
    if (match) matches.push({ path: rel, dir: `claude-code-${match[1]}`, version: match[1] })
  }
  return matches.length === 1 ? matches[0] : null
}

export function slotCliNodeBin(vm) {
  return `${slotHome(vm)}/.kin/cli-node`
}

export function slotCcNodeBin(vm) {
  return `${slotHome(vm)}/.kin/cc-node`
}

export function slotLocalCragClaude(vm, version = CRAG_CLAUDE_VERSION) {
  return `${slotHome(vm)}/.kin/crag-v2/claude-code-${version}/claude`
}

export function cragClaudePathForHost(relPath, host = {}, vm = null) {
  const base = host?.bakedKernel ? `${REMOTE_LIVE_DIR}/crag-v2` : `${slotHome(vm)}/.kin/crag-v2`
  return `${base}/${relPath}`
}

function readManifestJsonFromDir(dir) {
  if (!dir || typeof dir !== 'string') return null
  try {
    const file = path.join(dir, 'manifest.json')
    const st = fs.lstatSync(file)
    if (st.isSymbolicLink() || !st.isFile() || st.size > 64 * 1024) return null
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Read the active CRAG v2 `manifest.json` for a slot (installed slot tree first,
 * then `KIN_CRAG_V2_ROOT`, then active cached package pointer, then factory tree).
 */
export function activeCragManifestForSlot(projectRoot, vm = null, homeDir = '') {
  const dirs = []
  if (homeDir) dirs.push(path.join(homeDir, '.kin', 'crag-v2'))
  else if (projectRoot && vm?.id) dirs.push(path.join(projectRoot, 'vms', String(vm.id), 'cli-home', '.kin', 'crag-v2'))
  const envRoot = String(process.env.KIN_CRAG_V2_ROOT || '').trim()
  if (envRoot) dirs.push(envRoot)
  if (projectRoot) {
    const archRaw = String(vm?.runtime?.arch || vm?.node_arch || vm?.arch || '')
      .trim()
      .toLowerCase()
    const arch =
      archRaw === 'arm64' || archRaw === 'aarch64'
        ? 'arm64'
        : archRaw === 'x64' || archRaw === 'x86_64' || archRaw === 'amd64'
          ? 'amd64'
          : process.arch === 'arm64'
            ? 'arm64'
            : 'amd64'
    const base = path.join(projectRoot, 'share', 'crag', 'kernels', 'v2')
    for (const candidateArch of arch === 'amd64' ? ['amd64'] : [arch, 'amd64']) {
      try {
        const ptr = path.join(base, `current-${candidateArch}.json`)
        const st = fs.lstatSync(ptr)
        if (st.isFile() && st.size <= 4096) {
          const value = JSON.parse(fs.readFileSync(ptr, 'utf8'))
          if (new RegExp(`^packages/${candidateArch}-[a-f0-9-]{36}$`).test(value?.package)) {
            dirs.push(path.join(base, value.package))
          }
        }
      } catch {}
      dirs.push(path.join(base, candidateArch))
    }
  }
  for (const dir of dirs) {
    const manifest = readManifestJsonFromDir(dir)
    if (manifest && resolveManifestClaudePath(manifest)) return manifest
  }
  return null
}

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
  if (raw === OFFICIAL_303_PRESET || raw === '303' || raw === 'official-303') return 'official_full'
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
    // Consumed by rustHealthTimeoutMs (gateway dial budget); without this entry
    // the key is stripped on save and can never be configured from the panel.
    health_timeout_ms: optionalTtlMs(raw.health_timeout_ms, 800),
    // Consumed by rustDownReprobeMs (kernel-router.mjs); 0 turns the local-slot
    // re-probe off, so 0 must survive normalisation like any other value.
    kernel_down_reprobe_ms: Math.min(10_000, Math.round(optionalTtlMs(raw.kernel_down_reprobe_ms, 2500))),
    tcp_nodelay: optionalBool(raw.tcp_nodelay, true),
    session_slots: normalizeSessionSlots(raw.session_slots),
    prewarm_enabled: raw.prewarm_enabled === true,
    session_idle_ttl_seconds: normalizeSessionIdleTtlSeconds(raw.session_idle_ttl_seconds),
    dataplane: normalizeKernelDataplane(raw.dataplane),
    crag_kernel_version: normalizeCragKernelVersion(raw.crag_kernel_version) || 'v2',
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

/** Public id is `crag-v2`. Omitted and stored legacy both run native Claude. */
export function normalizeCragKernelVersion(value, { inherit = false } = {}) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('_', '-')
  if (!raw || raw === 'inherit' || raw === 'global' || raw === 'default' || raw === 'auto') {
    return inherit ? '' : 'v2'
  }
  if (raw === 'legacy' || raw === 'crag-legacy' || raw === 'elf' || raw === 'v2' || raw === 'crag-v2') return 'v2'
  return null
}

export function resolveCragKernelVersion(vm, routing = {}) {
  if (isCodexVm(vm)) return null
  const fromVm = normalizeCragKernelVersion(vm?.crag_kernel_version, { inherit: true })
  if (fromVm) return fromVm
  const fromRouting = normalizeCragKernelVersion(routing?.inference?.crag_kernel_version, { inherit: true })
  if (fromRouting) return fromRouting
  return 'v2'
}

/** Resolve the CLI that serves inference for this kernel; native OAuth is independent. */
export function resolveSlotClaude(vm, routing = {}, host = {}) {
  const dataplane = resolveKernelDataplane(vm, routing)
  const native = dataplane === 'crag' && resolveCragKernelVersion(vm, routing) === 'v2'
  if (native) {
    const manifest =
      host?.manifest ||
      vm?.kernel_installation?.manifest ||
      readManifestJsonFromDir(host?.cragRoot) ||
      (host?.homeDir ? readManifestJsonFromDir(path.join(host.homeDir, '.kin', 'crag-v2')) : null)
    const fromManifest = resolveManifestClaudePath(manifest)
    const relPath = fromManifest?.path || `claude-code-${CRAG_CLAUDE_VERSION}/claude`
    const version = fromManifest?.version || CRAG_CLAUDE_VERSION
    const caps =
      host?.capabilities ||
      manifest?.capabilities ||
      vm?.workerStatus?.capabilities ||
      vm?.worker_status?.capabilities ||
      vm?.runtime?.capabilities ||
      vm?.kernel_installation?.capabilities ||
      []
    const headlessBridge = isHeadlessBridgeCaps(caps)
    const customOs = isCustomOsSlot(vm, host)
    const unbundled = manifest?.officialClaude?.bundled === false
    const resolvedBin = cragClaudePathForHost(relPath, host, vm)
    if (headlessBridge) {
      if (customOs) {
        const wireProfileReadonlyDir =
          String(host?.wireProfileReadonlyDir || '').trim() || sharedProfilesGuestDir(host?.storeGuestDir)
        const explicitSharedBin = String(host?.sharedClaudeBin || '').trim()
        const useSharedBin = unbundled || Boolean(explicitSharedBin)
        const sharedBin = useSharedBin ? explicitSharedBin || sharedClaudeGuestPath(version, host?.storeGuestDir) : ''
        return {
          bin: sharedBin,
          resolvedBin: useSharedBin ? sharedBin : resolvedBin,
          relativePath: relPath,
          native: true,
          version,
          headlessBridge: true,
          customOs: true,
          sharedStore: useSharedBin,
          bundledClaude: !unbundled,
          wireProfileReadonlyDir,
        }
      }
      return {
        bin: '',
        resolvedBin,
        relativePath: relPath,
        native: true,
        version,
        headlessBridge: true,
      }
    }
    if (customOs && unbundled) {
      const sharedBin =
        String(host?.sharedClaudeBin || '').trim() || sharedClaudeGuestPath(version, host?.storeGuestDir)
      return {
        bin: sharedBin,
        native: true,
        version,
        sharedStore: true,
        bundledClaude: false,
      }
    }
    return {
      bin: resolvedBin,
      native: true,
      version,
    }
  }
  return {
    bin: dataplane === 'wrap' ? host.bins?.cli || slotCliNodeBin(vm) : host.bins?.cc || slotCcNodeBin(vm),
    native: false,
  }
}

export function parseCragKernelVersionPatch(value) {
  if (value == null || value === '') return { ok: true, value: '' }
  const parsed = normalizeCragKernelVersion(value, { inherit: true })
  if (parsed == null) return { ok: false, error: 'crag_kernel_version must be v2' }
  if (!parsed) return { ok: true, value: '' }
  return { ok: true, value: parsed }
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
  const fromVm = normalizeSlotPersonaPreset(vm?.persona_preset, { inherit: true })
  if (fromVm) return fromVm
  return resolveGlobalUnifiedPreset(routing)
}

export function personaModeFromPreset(preset) {
  if (preset === 'zero') return 'zero'
  if (preset === 'official') return 'official_prompt'
  if (preset === 'official_full') return 'official_full'
  if (preset === 'custom') return 'custom'
  if (preset === OFFICIAL_303_PRESET) return 'official_full'
  return null
}

/** Unified CLI system_layout matches resolved persona_preset (`official | official_full | zero | custom`). */
export function resolveCliSystemLayout(vm, routing = {}) {
  return resolveSlotPersonaPreset(vm, routing)
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
  const hasCragVersion = Object.prototype.hasOwnProperty.call(body, 'crag_kernel_version')
  if (!hasEngine && !hasPersona && !hasDataplane && !hasCragVersion) {
    return { ok: false, error: 'inference_engine, persona_preset, dataplane or crag_kernel_version required' }
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
  if (hasCragVersion) {
    const parsed = parseCragKernelVersionPatch(body.crag_kernel_version)
    if (!parsed.ok) return parsed
    patch.crag_kernel_version = parsed.value
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
  if (Object.hasOwn(body.inference, 'prewarm_enabled') && typeof body.inference.prewarm_enabled !== 'boolean') {
    errors.push('inference.prewarm_enabled 必须是布尔值')
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
  if (Object.prototype.hasOwnProperty.call(body.inference, 'crag_kernel_version')) {
    const parsed = parseCragKernelVersionPatch(body.inference.crag_kernel_version)
    if (!parsed.ok) errors.push(parsed.error)
    else if (!parsed.value) errors.push('inference.crag_kernel_version 必须是 v2')
  }
  return errors
}
