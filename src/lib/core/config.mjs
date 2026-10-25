import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashKey } from './security.mjs'
import { atomicWriteJson } from '../vm/vm-file.mjs'
import { loadDistillRules } from './distill-detect.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// this file lives at src/lib/core/ — the gateway root is src/
const ROOT = path.resolve(__dirname, '..', '..')
const PROJECT = path.resolve(process.env.KIN_PROJECT_ROOT || path.resolve(ROOT, '..'))

const STREAM_IDLE_TIMEOUT_MIN_MS = 30_000
const STREAM_IDLE_TIMEOUT_MAX_MS = 3_600_000

/**
 * Max silence on an upstream stream, shared by the gateway and the slot kernel.
 * Without eager_input_streaming, upstream buffers a large tool input (a long
 * Write content) and stays silent for minutes; eager_tool_streaming avoids that.
 * The panel value (routing failover.stream_idle_timeout_ms) wins over the fallback.
 */
export function streamIdleTimeoutMs(routing, fallbackMs = Number(process.env.KIN_STREAM_IDLE_TIMEOUT) || 180_000) {
  const ms = Number(routing?.failover?.stream_idle_timeout_ms)
  if (!Number.isFinite(ms) || ms <= 0) return fallbackMs
  return Math.min(STREAM_IDLE_TIMEOUT_MAX_MS, Math.max(STREAM_IDLE_TIMEOUT_MIN_MS, Math.round(ms)))
}

/** Gateway stream path: panel routing → cfg.limits → KIN_STREAM_IDLE_TIMEOUT → 180s default. */
export function resolveStreamIdleTimeoutMs(routing, cfg) {
  const limitsMs = Number(cfg?.limits?.stream_idle_timeout_ms)
  const fallback =
    Number.isFinite(limitsMs) && limitsMs > 0 ? limitsMs : Number(process.env.KIN_STREAM_IDLE_TIMEOUT) || 180_000
  return streamIdleTimeoutMs(routing, fallback)
}

/**
 * How long a Claude stream may sit in the queue before the first downstream
 * byte. Cloudflare returns 524 when the origin writes nothing for ~100s.
 * The default is under that window and after one seat wait (fallback 30s,
 * sticky 45s), so a short miss can still answer HTTP 429/529. Values above
 * 90s are capped: the first byte has to land before the proxy gives up.
 * `0` writes the first ping immediately.
 */
export const DEFAULT_QUEUE_KEEPALIVE_DELAY_MS = 60_000
export const QUEUE_KEEPALIVE_DELAY_MAX_MS = 90_000

export function queueKeepaliveDelayMs(routing, fallbackMs) {
  const envRaw = process.env.KIN_QUEUE_KEEPALIVE_DELAY
  const envMs = envRaw == null || String(envRaw).trim() === '' ? Number.NaN : Number(envRaw)
  const fallback = Number.isFinite(Number(fallbackMs))
    ? Number(fallbackMs)
    : Number.isFinite(envMs) && envMs >= 0
      ? envMs
      : DEFAULT_QUEUE_KEEPALIVE_DELAY_MS
  const raw = routing?.failover?.queue_keepalive_delay_ms
  const ms = raw == null || raw === '' ? fallback : Number(raw)
  const chosen = Number.isFinite(ms) && ms >= 0 ? ms : fallback >= 0 ? fallback : DEFAULT_QUEUE_KEEPALIVE_DELAY_MS
  return Math.min(QUEUE_KEEPALIVE_DELAY_MAX_MS, Math.round(chosen))
}

export const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024
const MAX_REQUEST_MIB_MIN = 8
const MAX_REQUEST_MIB_MAX = 128

/**
 * Bytes the slot kernel will buffer. The panel value
 * (failover.max_request_mib) is the receive size; axum rejects anything
 * larger with 413 before the CLI runs. Absent or invalid keeps fallbackBytes
 * (32 MiB, shared by ingress and the kernel).
 */
export function maxRequestBytes(routing, fallbackBytes = DEFAULT_MAX_REQUEST_BYTES) {
  const mib = Number(routing?.failover?.max_request_mib)
  if (!Number.isFinite(mib) || mib <= 0) return fallbackBytes
  const clamped = Math.min(MAX_REQUEST_MIB_MAX, Math.max(MAX_REQUEST_MIB_MIN, Math.round(mib)))
  return clamped * 1024 * 1024
}

/** Protocol ingress limit. A panel value cannot exceed the process ceiling. */
export function inboundBodyLimit(routing, ceilingBytes) {
  const ceiling = Number(ceilingBytes)
  const cap = Number.isFinite(ceiling) && ceiling > 0 ? ceiling : DEFAULT_MAX_REQUEST_BYTES
  return Math.min(cap, maxRequestBytes(routing))
}

/** Live routing.json. KIN_ROUTING_FILE wins; otherwise <project>/src/config/routing.json. */
export function routingConfigFile(projectRoot = PROJECT) {
  const override = String(process.env.KIN_ROUTING_FILE || '').trim()
  if (override) return override
  return path.join(projectRoot || PROJECT, 'src', 'config', 'routing.json')
}

export function readRoutingConfigFile(projectRoot = PROJECT) {
  const file = routingConfigFile(projectRoot)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Routing config '${file}' not found`, { cause: error })
    throw new Error(`Routing config '${file}' unreadable: ${error?.message || error}`, { cause: error })
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Routing config '${file}' has invalid JSON: ${error?.message || error}`, { cause: error })
  }
}

const BIND_WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]'])

/** Listen/bind addresses that must never appear in client-facing URLs. */
export function isBindWildcardHost(host) {
  const h = String(host ?? '')
    .trim()
    .toLowerCase()
  return BIND_WILDCARD_HOSTS.has(h)
}

function trimPublicBaseUrl(raw) {
  if (raw == null) return null
  const s = String(raw).trim().replace(/\/+$/, '')
  return s || null
}

/** PUBLIC_HOST only; never falls back to HOST (bind address). */
export function resolvePublicHost(env = process.env) {
  const publicHost = String(env.PUBLIC_HOST ?? '').trim()
  if (!publicHost || isBindWildcardHost(publicHost)) return null
  return publicHost
}

/**
 * Client-facing base URL for /health, /v1/meta, and panel snapshots.
 * PUBLIC_BASE_URL wins; else build from PUBLIC_HOST. Unconfigured → null.
 */
export function resolvePublicBaseUrl(env = process.env, port = Number(env.PORT || 8787)) {
  const explicit = trimPublicBaseUrl(env.PUBLIC_BASE_URL)
  if (explicit) return explicit

  const publicHost = resolvePublicHost(env)
  if (!publicHost) return null

  const scheme = String(env.PUBLIC_SCHEME || 'http').trim() || 'http'
  const needsPort = scheme !== 'https'
  return `${scheme}://${publicHost}${needsPort ? `:${port}` : ''}`
}

function readActiveVmRecord(projectRoot) {
  try {
    const active = JSON.parse(fs.readFileSync(path.join(projectRoot, 'vms', 'active.json'), 'utf8'))
    const id = active?.active_vm
    if (!id) return null
    return JSON.parse(fs.readFileSync(path.join(projectRoot, 'vms', `${id}.json`), 'utf8'))
  } catch {
    return null
  }
}

function snapshotVm(vm, project) {
  if (!vm?.id) {
    return {
      id: null,
      name: null,
      email: null,
      account_uuid: null,
      org_uuid: null,
      has_access: false,
      proxy: null,
      has_refresh: false,
      expires_at: null,
      refresh_error: null,
      max_concurrency: 2,
      claude_code_version: 'unknown',
      timezone: 'UTC',
      locale: 'en_US.UTF-8',
      kernel: null,
      seed_policy: null,
      path: null,
    }
  }
  return {
    id: vm.id,
    name: vm.name,
    email: vm.claude?.email,
    account_uuid: vm.claude?.account_uuid || vm.id,
    org_uuid: vm.claude?.org_uuid || null,
    has_access: !!(vm.claude?.has_access || vm.claude?.access_token),
    proxy: vm.proxy || null,
    has_refresh: !!(vm.claude?.has_refresh || vm.claude?.refresh_token),
    expires_at: vm.claude?.expires_at,
    refresh_error: vm.claude?.refresh_error || null,
    max_concurrency: vm.policy?.maxConcurrency || 2,
    claude_code_version: vm.claude_code_version || 'unknown',
    timezone: vm.timezone || 'UTC',
    locale: vm.locale || 'en_US.UTF-8',
    kernel: vm.kernel || null,
    seed_policy: vm.seed_policy || null,
    path: path.join(project, 'vms', `${vm.id}.json`),
  }
}

export function loadConfig() {
  const keyFile = path.join(ROOT, 'config', 'test.key')
  const apiKey =
    process.env.VM2API_API_KEY ||
    process.env.KIN_API_KEY ||
    (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : null)
  if (!apiKey) throw new Error('VM2API_API_KEY not set')

  const vm = readActiveVmRecord(PROJECT)

  const port = Number(process.env.PORT || 8787)
  const host = process.env.HOST || '0.0.0.0'
  const publicHost = resolvePublicHost(process.env)
  const base_url = resolvePublicBaseUrl(process.env, port)

  const cfg = {
    port,
    host,
    public_host: publicHost,
    base_url,
    api_key: apiKey,
    api_key_hash: hashKey(apiKey),
    // rewrite pipeline — DEFAULT OFF (passthrough preferred)
    rewrite: {
      enabled: process.env.KIN_REWRITE === '1' || process.env.KIN_REWRITE === 'true',
      model_map: false, // aliases disabled — official Claude names only
    },
    intercept: {
      // empty rules = no-op; rules can be loaded from config/intercept-rules.json
      rules: loadInterceptRules(path.join(ROOT, 'config', 'intercept-rules.json')),
    },
    distill: loadDistillRules(path.join(ROOT, 'config', 'distill-rules.json')),
    limits: {
      max_body_bytes: Number(process.env.KIN_MAX_BODY || 128 * 1024 * 1024),
      // First-byte wait for worker HTTP headers. Matches sub2api
      // gateway.response_header_timeout (600s). Idle is stream_idle_timeout_ms.
      upstream_timeout_ms: Number(process.env.KIN_UPSTREAM_TIMEOUT || 600000),
      stream_idle_timeout_ms: streamIdleTimeoutMs(),
      stream_keepalive_ms: Number(process.env.KIN_STREAM_KEEPALIVE || 10000),
      queue_keepalive_delay_ms: queueKeepaliveDelayMs(null),
      rate_capacity: Number(process.env.KIN_RATE_CAP || 60),
      rate_refill: Number(process.env.KIN_RATE_REFILL || 1),
    },
    // Admin/status snapshot of the *active* VM only.
    // Inference must use buildExecutionContext() — never this object.
    vm: snapshotVm(vm, PROJECT),
    paths: {
      root: ROOT,
      project: PROJECT,
      captures: process.env.KIN_CAPTURES_DIR || path.join(ROOT, 'captures'),
      data: process.env.KIN_DATA_DIR || path.join(ROOT, 'data'),
    },
  }
  return cfg
}

function loadInterceptRules(file) {
  try {
    if (!fs.existsSync(file)) return []
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(data) ? data : data.rules || []
  } catch {
    return []
  }
}

export function hydrateVmCfg(cfg, vm, projectRoot = cfg.paths?.project) {
  if (!cfg) return cfg
  const root = projectRoot || path.dirname(path.dirname(cfg.vm?.path || '')) || ''
  cfg.vm = snapshotVm(vm, root)
  return cfg
}

export function reloadActiveVm(cfg) {
  const project = cfg.paths.project
  return hydrateVmCfg(cfg, readActiveVmRecord(project), project)
}

export function saveVmPatch(vmPath, patch) {
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  Object.assign(vm, patch)
  if (patch.claude_code_version) {
    vm.claude_code_version = patch.claude_code_version
    vm.claude_code_updated_at = new Date().toISOString()
  }
  atomicWriteJson(vmPath, vm, { mode: 0o600 })
  return vm
}
