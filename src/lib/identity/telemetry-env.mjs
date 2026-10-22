/**
 * Claude Code 2.1.296 1P env / event / GrowthBook payloads.
 * device_id is the install userID (64 hex). Betas, node_version,
 * is_running_with_bun, model, and additional_metadata are not sent.
 */
import crypto from 'node:crypto'
import { OFFICIAL_CLI_VERSION } from './vm-identity.mjs'

export const GROWTHBOOK_CLIENT_KEY = 'sdk-zAZezfDKGoZuXXKe'
export const TELEMETRY_SESSION_TTL_MS = 10 * 60 * 1000
export const EVENT_BATCH_INTERVAL_MS = 10 * 1000
export const GROWTHBOOK_INTERVAL_MS = 6 * 60 * 60 * 1000

export const DEFAULT_PROCESS_RANGES = Object.freeze({
  constrained_memory: 0,
  rss_range: [300_000_000, 500_000_000],
  heap_total_range: [40_000_000, 80_000_000],
  heap_used_range: [100_000_000, 200_000_000],
  external_range: [1_000_000, 3_000_000],
  array_buffers_range: [10_000, 50_000],
})

export const FULL_ENV_KEYS = Object.freeze([
  'platform',
  'platform_raw',
  'arch',
  'terminal',
  'shell',
  'package_managers',
  'runtimes',
  'is_ci',
  'is_claubbit',
  'is_claude_code_remote',
  'is_local_agent_mode',
  'is_conductor',
  'is_github_action',
  'is_claude_code_action',
  'is_claude_ai_auth',
  'version',
  'version_base',
  'build_time',
  'deployment_environment',
  'vcs',
  'github_event_name',
  'github_actions_runner_environment',
  'github_actions_runner_os',
  'github_action_ref',
  'wsl_version',
  'remote_environment_type',
  'claude_code_container_id',
  'claude_code_remote_session_id',
  'tags',
  'coworker_type',
  'linux_distro_id',
  'linux_distro_version',
  'linux_kernel',
])

function str(v) {
  return v == null ? '' : String(v)
}
const SHELL_NAMES = new Set([
  'zsh',
  'bash',
  'fish',
  'sh',
  'dash',
  'ash',
  'ksh',
  'tcsh',
  'csh',
  'nu',
  'nushell',
  'pwsh',
  'powershell',
  'cmd',
  'elvish',
  'xonsh',
  'ion',
])

const HEX64 = /^[0-9a-f]{64}$/

/** 2.1.293 bUn(). Empty VM shell is bash; source would say "none". */
export function telemetryShell(value) {
  const raw = str(value).trim()
  if (!raw) return 'bash'
  const base = raw
    .split(/[/\\]/)
    .pop()
    .toLowerCase()
    .replace(/\.exe$/, '')
  return SHELL_NAMES.has(base) ? base : 'other'
}

/** Official event device_id is ~/.claude.json userID, 32 bytes of hex. */
export function officialDeviceID(...values) {
  for (const value of values) {
    const id = str(value).trim().toLowerCase()
    if (HEX64.test(id)) return id
  }
  return ''
}

function versionBase(version) {
  const raw = str(version)
  if (!raw) return ''
  let n = 0
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '.') {
      n += 1
      if (n === 3) return raw.slice(0, i)
    }
  }
  return raw
}

function randomInRange(min, max) {
  const lo = Number(min) || 0
  const hi = Number(max) || lo
  if (hi <= lo) return lo
  return lo + Math.floor(Math.random() * (hi - lo))
}

export function distroVersionFromPretty(pretty) {
  const m = String(pretty || '').match(/(\d+(?:\.\d+){0,2})/)
  return m ? m[1] : ''
}

export function buildFullEnvJson(id = {}) {
  const version = str(id.cli_version || id.version || OFFICIAL_CLI_VERSION)
  const platform = str(id.platform || 'linux')
  const env = {
    platform,
    platform_raw: str(id.platform_raw || platform),
    arch: str(id.arch || 'x64'),
    terminal: str(id.terminal || 'unknown'),
    shell: telemetryShell(id.shell),
    package_managers: str(id.package_managers || ''),
    runtimes: str(id.runtimes) || 'node',
    is_ci: false,
    is_claubbit: false,
    is_claude_code_remote: false,
    is_local_agent_mode: false,
    is_conductor: false,
    is_github_action: false,
    is_claude_code_action: false,
    is_claude_ai_auth: !!(id.account_uuid || id.is_claude_ai_auth),
    version,
    version_base: str(id.version_base || versionBase(version)),
    deployment_environment: str(id.deployment_environment || (platform === 'linux' ? 'unknown-linux' : '')),
    vcs: str(id.vcs) || 'git',
    github_event_name: '',
    github_actions_runner_environment: '',
    github_actions_runner_os: '',
    github_action_ref: '',
    wsl_version: '',
    remote_environment_type: '',
    claude_code_container_id: '',
    claude_code_remote_session_id: '',
    tags: [],
    coworker_type: '',
    linux_distro_id: str(id.linux_distro_id || ''),
    linux_distro_version: str(id.linux_distro_version || ''),
    linux_kernel: str(id.linux_kernel || ''),
  }
  const buildTime = str(id.build_time).trim()
  if (buildTime) env.build_time = buildTime
  return env
}

export function buildProcessJson(proc = DEFAULT_PROCESS_RANGES, uptimeSecs = 0) {
  const ranges = { ...DEFAULT_PROCESS_RANGES, ...(proc || {}) }
  return {
    uptime: Number(uptimeSecs) || 0,
    rss: randomInRange(ranges.rss_range?.[0], ranges.rss_range?.[1]),
    heapTotal: randomInRange(ranges.heap_total_range?.[0], ranges.heap_total_range?.[1]),
    heapUsed: randomInRange(ranges.heap_used_range?.[0], ranges.heap_used_range?.[1]),
    external: randomInRange(ranges.external_range?.[0], ranges.external_range?.[1]),
    arrayBuffers: randomInRange(ranges.array_buffers_range?.[0], ranges.array_buffers_range?.[1]),
    constrainedMemory: Number(ranges.constrained_memory) || 0,
    cpuUsage: {
      user: randomInRange(50_000, 500_000),
      system: randomInRange(15_000, 150_000),
    },
    cpuPercent: 0.5 + Math.random() * 4.5,
  }
}

export function encodeProcessB64(proc, uptimeSecs) {
  return Buffer.from(JSON.stringify(buildProcessJson(proc, uptimeSecs))).toString('base64')
}

function newId() {
  return crypto.randomUUID()
}

function jsIso(date = new Date()) {
  return new Date(date).toISOString()
}

function authBlock(id = {}) {
  const auth = {}
  if (id.account_uuid) auth.account_uuid = id.account_uuid
  if (id.org_uuid || id.organization_uuid) auth.organization_uuid = id.org_uuid || id.organization_uuid
  return auth
}

export function buildEventData(id = {}, opts = {}) {
  const eventName = opts.event_name || 'tengu_api_success'
  const auth = authBlock(id)
  const data = {
    event_id: newId(),
    event_name: eventName,
    client_timestamp: jsIso(opts.now),
    session_id: str(id.session_id || newId()),
    user_type: 'external',
    is_interactive: eventName !== 'tengu_init',
    client_type: 'cli',
    entrypoint: str(id.entrypoint || 'cli'),
    env: buildFullEnvJson(id),
  }
  const device = officialDeviceID(id.user_id, id.device_id)
  if (device) data.device_id = device
  if (id.email) data.email = id.email
  if (Object.keys(auth).length) data.auth = auth
  if (eventName !== 'tengu_init') {
    data.process = encodeProcessB64(id.process || DEFAULT_PROCESS_RANGES, opts.uptime_secs || 0)
  }
  return data
}

export function buildEventBatch(id = {}, opts = {}) {
  return {
    events: [
      {
        event_type: 'ClaudeCodeInternalEvent',
        event_data: buildEventData(id, opts),
      },
    ],
  }
}

export function buildGrowthbookEval(id = {}) {
  const device = officialDeviceID(id.user_id, id.device_id) || str(id.user_id || id.device_id)
  const attrs = {
    id: device,
    sessionId: str(id.session_id || newId()),
    deviceID: device,
    platform: str(id.platform || 'linux'),
    appVersion: str(id.cli_version || id.version || OFFICIAL_CLI_VERSION),
    userType: 'external',
    entrypoint: str(id.entrypoint || 'cli'),
  }
  if (id.email) attrs.email = id.email
  if (id.account_uuid) attrs.accountUUID = id.account_uuid
  if (id.org_uuid || id.organization_uuid) attrs.organizationUUID = id.org_uuid || id.organization_uuid
  if (id.subscription_type) attrs.subscriptionType = id.subscription_type
  return { attributes: attrs, forcedVariations: {}, forcedFeatures: [], url: '' }
}

export function telemetryCodeUa(version = OFFICIAL_CLI_VERSION) {
  return `claude-code/${version}`
}
