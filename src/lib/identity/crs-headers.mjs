import { applyBetaPolicyToHeader, shouldPassContext1mByPolicy } from '../protocol/model-policy.mjs'
import { CONTEXT_1M_BETA, hasClaudeCode1mSuffix } from '../protocol/context-1m.mjs'
import { OFFICIAL_CLAUDE_CLI_UA, OFFICIAL_STAINLESS } from './vm-identity.mjs'
import { isOfficialClaudeUa } from './official-claude-ua.mjs'

export { isOfficialClaudeUa, isUnofficialClaudeEntrypointUa, CLAUDE_CLI_UA_RE } from './official-claude-ua.mjs'

/**
 * Store / replay official Claude Code *protocol* headers.
 * Device headers (UA / stainless / session / accept-language) never persist
 * and never come from inbound — only VM fingerprint + defaults.
 * Never stores Authorization / x-api-key / cookies.
 *
 * context-1m-2025-08-07 (sub2api OAuth):
 *   - Official Claude Code: pass if matrix betas.pass_context_1m or fallback whitelist
 *   - Inbound trailing [1m] (e.g. claude-sonnet-5[1m]) injects the beta when allowed
 *   - Bare unofficial/mimic: never inject or replay
 *   - Other models: filter (Haiku 400; Opus/Fable use native window)
 */
import fs from 'node:fs'
import path from 'node:path'

const KEEP = [
  'user-agent',
  'anthropic-version',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
  'x-app',
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-timeout',
  'x-stainless-helper-method',
  'x-claude-code-session-id',
  'x-claude-code-request-class',
  'x-claude-code-sandy-plover',
  'x-claude-code-agent-id',
  'x-claude-code-agent-type',
  'x-claude-code-parent-agent-id',
  'x-claude-code-prev-tool-durations',
  'x-claude-code-compaction',
  'x-claude-code-context-compacted',
  'accept-language',
  'sec-fetch-mode',
]

/** Only these may be written to kin-cc-headers.json. */
const PROTOCOL_STORE = ['anthropic-version', 'anthropic-beta', 'anthropic-dangerous-direct-browser-access']

const DEVICE_HEADER_KEYS = [
  'user-agent',
  'x-app',
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-timeout',
  'x-stainless-helper-method',
  'x-claude-code-session-id',
  'x-claude-code-request-class',
  'x-claude-code-sandy-plover',
  'x-claude-code-agent-id',
  'x-claude-code-agent-type',
  'x-claude-code-parent-agent-id',
  'x-claude-code-prev-tool-durations',
  'x-claude-code-compaction',
  'x-claude-code-context-compacted',
  'accept-language',
  'sec-fetch-mode',
]
const CONDITIONAL_HEADERS = [
  'x-claude-code-request-class',
  'x-claude-code-agent-id',
  'x-claude-code-agent-type',
  'x-claude-code-parent-agent-id',
  'x-claude-code-prev-tool-durations',
  'x-claude-code-compaction',
  'x-claude-code-context-compacted',
]

const DEFAULTS = {
  'user-agent': OFFICIAL_CLAUDE_CLI_UA,
  'anthropic-version': '2023-06-01',
  'x-app': 'cli',
  'x-stainless-lang': OFFICIAL_STAINLESS.stainless_lang,
  'x-stainless-os': OFFICIAL_STAINLESS.stainless_os,
  'x-stainless-arch': OFFICIAL_STAINLESS.stainless_arch,
  'x-stainless-runtime': OFFICIAL_STAINLESS.stainless_runtime,
  'x-stainless-package-version': OFFICIAL_STAINLESS.stainless_package_version,
  'x-stainless-runtime-version': OFFICIAL_STAINLESS.stainless_runtime_version,
  'x-stainless-retry-count': '0',
  'x-stainless-timeout': '600',
  'anthropic-dangerous-direct-browser-access': 'true',
  'x-claude-code-sandy-plover': '[]',
}

/** Betas that must not be replayed for unofficial clients. */
const REPLAY_DROP_BETAS = new Set([CONTEXT_1M_BETA])

function lowerHeaders(h = {}) {
  const out = {}
  for (const [k, v] of Object.entries(h || {})) {
    if (v == null || v === '') continue
    out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v)
  }
  return out
}

/**
 * Remove specific beta tokens from a comma-separated anthropic-beta header.
 * Mirrors sub2api stripBetaToken.
 */
export function stripBetaTokens(header, dropSet = REPLAY_DROP_BETAS) {
  if (!header || typeof header !== 'string') return header
  const parts = header
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && !dropSet.has(p))
  return parts.join(',')
}

/** Official: strip unless the matrix / fallback whitelist says pass. Unofficial callers should always strip. */
export function shouldStripContext1m(model = '') {
  return !shouldPassContext1mByPolicy(model)
}

export function extractClaudeCodeHeaders(reqHeaders = {}) {
  const src = lowerHeaders(reqHeaders)
  const out = {}
  for (const k of KEEP) {
    if (src[k] != null) out[k] = src[k]
  }
  return out
}
function conditionalHeaders(headers = {}) {
  const src = lowerHeaders(headers)
  const out = {}
  for (const key of CONDITIONAL_HEADERS) {
    if (src[key] != null) out[key] = src[key]
  }
  return out
}

export function protocolHeadersOnly(headers = {}) {
  const src = lowerHeaders(headers)
  const out = {}
  for (const k of PROTOCOL_STORE) {
    if (src[k] != null) out[k] = src[k]
  }
  return out
}

export function stripDeviceHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object') return {}
  const out = { ...headers }
  for (const k of DEVICE_HEADER_KEYS) delete out[k]
  return out
}

export function acceptLanguageFromLocale(locale = '') {
  const raw = String(locale || '').trim()
  if (!raw) return ''
  return raw.split('.')[0].replace(/_/g, '-')
}

function headerFile(homeDir) {
  return path.join(homeDir, '.claude', 'kin-cc-headers.json')
}

function readHeaderFile(homeDir) {
  if (!homeDir) return null
  try {
    const data = JSON.parse(fs.readFileSync(headerFile(homeDir), 'utf8'))
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

function writeHeaderFile(homeDir, headers, extra = {}) {
  fs.mkdirSync(path.dirname(headerFile(homeDir)), { recursive: true })
  fs.writeFileSync(
    headerFile(homeDir),
    JSON.stringify(
      {
        headers,
        updated_at: extra.updated_at || new Date().toISOString(),
        ...extra,
      },
      null,
      2,
    ),
  )
}

function headersEqual(a = {}, b = {}) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function storeAccountHeaders(homeDir, reqHeaders = {}) {
  if (!homeDir) return { stored: false }
  const extracted = extractClaudeCodeHeaders(reqHeaders)
  if (!isOfficialClaudeUa(extracted['user-agent'] || '')) return { stored: false }
  // Real Claude Code always sends anthropic-beta. Probe/mimic official UA
  // omits it so stored CLI betas are not wiped by a short header set.
  const protocol = protocolHeadersOnly(extracted)
  if (!protocol['anthropic-beta']) return { stored: false }
  try {
    const data = readHeaderFile(homeDir)
    const raw = data?.headers && typeof data.headers === 'object' ? data.headers : {}
    const prev = stripDeviceHeaders(raw)
    const next = { ...prev, ...protocol }
    const dirty = !headersEqual(raw, prev)
    if (!dirty && headersEqual(prev, next)) return { stored: true, wrote: false }
    writeHeaderFile(homeDir, next)
    return { stored: true, wrote: true }
  } catch {
    return { stored: false }
  }
}

export function loadStoredHeaders(homeDir) {
  const data = readHeaderFile(homeDir)
  const raw = data?.headers && typeof data.headers === 'object' ? data.headers : null
  if (!raw) return null
  const cleaned = stripDeviceHeaders(raw)
  if (!headersEqual(raw, cleaned)) {
    try {
      writeHeaderFile(homeDir, cleaned, { sanitized_at: new Date().toISOString() })
    } catch {
      /* keep memory view */
    }
  }
  return Object.keys(cleaned).length ? cleaned : null
}

function applyReplayBetaPolicy(headers, model = '', isOfficial = false, want1m = false) {
  if (!headers || typeof headers !== 'object') return headers
  const beta = headers['anthropic-beta'] || ''
  const optIn1m = want1m === true || hasClaudeCode1mSuffix(model)
  let cleaned
  try {
    cleaned = applyBetaPolicyToHeader(beta, model, { isOfficial, want1m: optIn1m })
  } catch {
    const drop1m = (!isOfficial && !optIn1m) || !shouldPassContext1mByPolicy(model)
    cleaned = drop1m ? stripBetaTokens(beta) : beta
  }
  if (cleaned === beta) return headers
  const next = { ...headers }
  if (cleaned) next['anthropic-beta'] = cleaned
  else delete next['anthropic-beta']
  return next
}

function vmStainlessHeaders(identity = {}) {
  const fp = identity.fingerprint || {}
  return {
    'user-agent': identity.userAgent || DEFAULTS['user-agent'],
    'x-app': fp.x_app || 'cli',
    'x-stainless-lang': OFFICIAL_STAINLESS.stainless_lang,
    'x-stainless-os': OFFICIAL_STAINLESS.stainless_os,
    'x-stainless-arch': OFFICIAL_STAINLESS.stainless_arch,
    'x-stainless-runtime': OFFICIAL_STAINLESS.stainless_runtime,
    'x-stainless-runtime-version': OFFICIAL_STAINLESS.stainless_runtime_version,
    'x-stainless-package-version': OFFICIAL_STAINLESS.stainless_package_version,
    'x-stainless-retry-count': DEFAULTS['x-stainless-retry-count'],
    'x-stainless-timeout': DEFAULTS['x-stainless-timeout'],
  }
}

function slotDeviceHeaders(identity = {}) {
  const fp = identity.fingerprint || {}
  const session = identity.callerSessionId || ''
  const lang = acceptLanguageFromLocale(fp.locale || identity.locale)
  return {
    ...vmStainlessHeaders(identity),
    ...(session ? { 'x-claude-code-session-id': session } : {}),
    ...(lang ? { 'accept-language': lang } : {}),
  }
}

/** VM characteristics are the only fingerprint. Official inbound may pass protocol betas. */
export function resolveVmCharacteristicHeaders(identity = {}, reqHeaders = {}, homeDir = '', model = '', opts = {}) {
  const incoming = extractClaudeCodeHeaders(reqHeaders)
  const official = isOfficialClaudeUa(incoming['user-agent'] || '')
  if (official) storeAccountHeaders(homeDir, reqHeaders)
  const stored = loadStoredHeaders(homeDir) || {}
  const device = slotDeviceHeaders(identity)
  const want1m = opts.want1m === true || hasClaudeCode1mSuffix(model)
  if (official) {
    const protocol = protocolHeadersOnly(incoming)
    const base = {
      ...DEFAULTS,
      ...stored,
      ...protocol,
      ...device,
      ...conditionalHeaders(incoming),
    }
    return applyReplayBetaPolicy(base, model, true, want1m)
  }
  // Unofficial: ignore inbound protocol / UA. Stored CLI betas fill gaps; VM fingerprint wins.
  const base = {
    ...DEFAULTS,
    ...stored,
    ...device,
    'anthropic-dangerous-direct-browser-access': 'true',
  }
  return applyReplayBetaPolicy(base, model, false, want1m)
}

/**
 * Protocol betas: official empty → DefaultBetaHeader; unofficial → FullClaudeCodeMimicryBetas.
 * VM identity overwrites UA / stainless / session. Stored file keeps protocol only.
 * Official inbound omitted anthropic-beta so probes do not wipe stored CLI betas.
 */
export function resolveCrsHeaders(reqHeaders = {}, homeDir = '', identity = null, model = '', opts = {}) {
  const want1m = opts.want1m === true || hasClaudeCode1mSuffix(model)
  if (identity) return resolveVmCharacteristicHeaders(identity, reqHeaders, homeDir, model, { want1m })
  const incoming = extractClaudeCodeHeaders(reqHeaders)
  if (isOfficialClaudeUa(incoming['user-agent'] || '')) {
    storeAccountHeaders(homeDir, reqHeaders)
    return applyReplayBetaPolicy({ ...DEFAULTS, ...protocolHeadersOnly(incoming) }, model, true, want1m)
  }
  const stored = loadStoredHeaders(homeDir) || {}
  const merged = { ...DEFAULTS, ...stored }
  return applyReplayBetaPolicy(merged, model, false, want1m)
}
