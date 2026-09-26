/**
 * Required post-OAuth workflow: wipe first-use Claude Code files, start
 * official CLI with the imported credential, complete one hello turn, then
 * keep Claude Code resident (do not exit). Slot /usage and seed follow.
 * Credential ownership stays with Go; inference follows the slot engine.
 * Successful hello then aligns seed + official identity and reloads the slot
 * through the engine-aware lifecycle so both Go credentials and Rust inference
 * are healthy before the resident CLI starts.
 * Node restart still kills the detached host python; listen() restores
 * already-initialized residents without another hello.
 *
 * Official CC egresses via a local HTTP CONNECT bridge → slot SOCKS5.
 * Node never dials Anthropic.
 * After hello, quota is CLI /usage inside the slot (one try, then two retries).
 * Account tier comes from GET /api/oauth/profile via kin-worker oauth.
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseVmIndex,
  containerName,
  officialCcUidGid,
  syncWorkerTelemetry,
  isSlotProxyDesynced,
  SLOT_MEMORY,
} from '../vm/vm-runtime.mjs'
import { reloadSlotReady } from '../vm/slot-runtime.mjs'
import {
  hasAccessPresence,
  hasRefreshPresence,
  needsRefresh,
  readWorkerCredentialFile,
  ensureOfficialCredentialLink,
} from './oauth-credentials.mjs'
import { canOfficialCc, credentialModeOfVm } from './credential-mode.mjs'
import { ensureWorkerCredential } from '../transport/go-worker-client.mjs'
import { inferTierFromOfficialStats, parseOfficialCcStats, tierFromOauthProfile } from './official-cc-stats.mjs'
import { defaultSeedPolicy } from '../protocol/seed-policy.mjs'
import { loadVmIdentity, persistVmSettings } from '../identity/vm-identity.mjs'
import { applyOfficialFingerprintToVm, readOfficialCcIdentity } from '../identity/official-fingerprint.mjs'
import { writeSlotSeedFiles, inferProjectRootFromCliHome } from '../vm/slot-seed.mjs'
import { touchTelemetrySession } from '../vm/worker-telemetry.mjs'
import { atomicWriteJson, listVmRecordFiles } from '../vm/vm-file.mjs'
import { normalizeOfficialCcInference, resolveOfficialCcInference } from '../vm/slot-engine.mjs'

export { officialCcUidGid } from '../vm/vm-runtime.mjs'
export const DEFAULT_HELLO_PROMPT = 'hello'
/** `/stats` and `/cost` are aliases of `/usage` since Claude Code 2.1.28x. */
export const DEFAULT_USAGE_PROMPT = '/usage'
export const DEFAULT_PLAN_PROMPT = DEFAULT_HELLO_PROMPT
/** `/usage` in the slot is retried at most this many times after the first try. */
export const OFFICIAL_USAGE_RETRIES = 2
export const OFFICIAL_USAGE_RETRY_DELAY_MS = 3000

export const DEFAULT_OFFICIAL_CC_CONFIG = Object.freeze({
  enabled: true,
  wipe: true,
  apply_seed: true,
  reconcile_fingerprint: true,
  sync_telemetry: true,
  hello_prompt: DEFAULT_HELLO_PROMPT,
  timeout_ms: 4 * 60 * 1000,
  memory: '500m',
  resident: false,
  inference: 'cli-hop',
})

export function normalizeOfficialCcConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const timeout = Number(src.timeout_ms)
  const mem = String(src.memory || DEFAULT_OFFICIAL_CC_CONFIG.memory)
    .trim()
    .toLowerCase()
  const hello = String(src.hello_prompt ?? DEFAULT_HELLO_PROMPT)
    .trim()
    .slice(0, 200)
  return {
    enabled: src.enabled !== false,
    wipe: src.wipe !== false,
    apply_seed: src.apply_seed !== false,
    reconcile_fingerprint: src.reconcile_fingerprint !== false,
    sync_telemetry: src.sync_telemetry !== false,
    hello_prompt: hello || DEFAULT_HELLO_PROMPT,
    timeout_ms:
      Number.isFinite(timeout) && timeout >= 30_000 && timeout <= 15 * 60 * 1000
        ? Math.round(timeout)
        : DEFAULT_OFFICIAL_CC_CONFIG.timeout_ms,
    memory: /^(250m|500m|512m|1g|2g|4g|8g)$/.test(mem) ? mem : DEFAULT_OFFICIAL_CC_CONFIG.memory,
    resident: src.resident === true,
    inference:
      src.inference == null || src.inference === ''
        ? DEFAULT_OFFICIAL_CC_CONFIG.inference
        : normalizeOfficialCcInference(src.inference),
  }
}

function loadRoutingDocument(routingFile) {
  if (!routingFile) return {}
  try {
    return JSON.parse(fs.readFileSync(routingFile, 'utf8'))
  } catch {
    return {}
  }
}

function readVmDocument(projectRoot, vmId) {
  if (!projectRoot || !vmId) return {}
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, 'vms', `${vmId}.json`), 'utf8'))
  } catch {
    return {}
  }
}

export function loadOfficialCcConfig(routingFile) {
  const doc = loadRoutingDocument(routingFile)
  return normalizeOfficialCcConfig(doc.official_cc || doc.official_cc_init)
}

export function applyOfficialCcConfig(opts = {}, config = null) {
  const cfg = normalizeOfficialCcConfig(config)
  return {
    ...opts,
    prompt: opts.prompt || cfg.hello_prompt,
    applySeed: opts.applySeed !== undefined ? opts.applySeed : cfg.apply_seed,
    timeoutMs: opts.timeoutMs || cfg.timeout_ms,
    wipe: opts.wipe !== undefined ? opts.wipe : cfg.wipe,
    reconcileFingerprint:
      opts.reconcileFingerprint !== undefined ? opts.reconcileFingerprint : cfg.reconcile_fingerprint,
    syncTelemetry: opts.syncTelemetry !== undefined ? opts.syncTelemetry : cfg.sync_telemetry,
    memory: opts.memory || cfg.memory,
    resident: opts.resident !== undefined ? opts.resident : cfg.resident,
    runTurn: opts.runTurn,
    slotOauth: opts.slotOauth,
    retryDelayMs: opts.retryDelayMs,
  }
}

export function officialCcQuotaSucceeded(usage) {
  if (!usage || typeof usage !== 'object') return false
  if (usage.ok) return true
  return !!(usage.five_hour || usage.seven_day || usage.seven_day_oi || usage.extra_usage || usage.account_tier)
}

export function latestOfficialClaudeVersion(homeDir) {
  const versionsDir = path.join(homeDir, '.local', 'share', 'claude', 'versions')
  if (!fs.existsSync(versionsDir)) return null
  const vers = fs
    .readdirSync(versionsDir)
    .filter((name) => {
      try {
        return fs.statSync(path.join(versionsDir, name)).isFile()
      } catch {
        return false
      }
    })
    .sort()
  return vers[vers.length - 1] || null
}

export function slotIdleMemory() {
  return SLOT_MEMORY
}

export function sameMemoryLimit(a, b) {
  return (
    String(a || '')
      .trim()
      .toLowerCase() ===
    String(b || '')
      .trim()
      .toLowerCase()
  )
}

export function formatMemoryLimit(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return null
  const gi = 1024 ** 3
  const mi = 1024 ** 2
  if (n % gi === 0) return `${n / gi}g`
  if (n % mi === 0) return `${n / mi}m`
  return `${Math.max(1, Math.round(n / mi))}m`
}

export function chooseIdleMemory(current, initMemory, fallback = slotIdleMemory()) {
  if (current && !sameMemoryLimit(current, initMemory)) return current
  return fallback
}

export function inspectContainerMemory(vmId) {
  const r = sh(['docker', 'inspect', '-f', '{{.HostConfig.Memory}}', containerName(vmId)], { timeout: 10_000 })
  if (!r.ok) return null
  return formatMemoryLimit(String(r.stdout || '').trim())
}

export function applyContainerMemory(vmId, memory) {
  const mem = String(memory || slotIdleMemory())
    .trim()
    .toLowerCase()
  return sh(['docker', 'update', '--memory', mem, '--memory-swap', mem, containerName(vmId)], { timeout: 15_000 })
}

/** Kill leftover CLI. Do not call after a successful resident hello. */
export function stopOfficialCcLeftovers(vmId) {
  return sh(['docker', 'exec', '-u', '0', containerName(vmId), 'pkill', '-f', '/home/kincli/.local/bin/claude'], {
    timeout: 10_000,
  })
}

export function officialCcRunDir(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', vmId, 'run')
}

export function officialCcPidPath(projectRoot, vmId, name) {
  return path.join(officialCcRunDir(projectRoot, vmId), `official-cc-${name}.pid`)
}

function readHostPid(pidFile) {
  try {
    const n = Number(String(fs.readFileSync(pidFile, 'utf8')).trim())
    if (Number.isFinite(n) && n > 1) return n
  } catch {}
  return null
}

function hostPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function stopHostPidFile(pidFile) {
  const pid = readHostPid(pidFile)
  if (pid && hostPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  try {
    fs.unlinkSync(pidFile)
  } catch {}
  return { pid }
}

export function stopOfficialCcResident(vmId, projectRoot) {
  if (projectRoot && vmId) {
    stopHostPidFile(officialCcPidPath(projectRoot, vmId, 'resident'))
    stopHostPidFile(officialCcPidPath(projectRoot, vmId, 'bridge'))
  }
  return stopOfficialCcLeftovers(vmId)
}

export function inspectOfficialCcResident(vmId) {
  const r = sh(
    [
      'docker',
      'exec',
      containerName(vmId),
      'sh',
      '-lc',
      "ps -eo pid,args | awk '/\\/home\\/kincli\\/\\.local\\/bin\\/claude/ && $0 !~ /awk/ {print; exit}'",
    ],
    { timeout: 8_000 },
  )
  const line = String(r.stdout || '').trim()
  const pid = Number(String(line).split(/\s+/)[0])
  return {
    running: Number.isFinite(pid) && pid > 1,
    pid: Number.isFinite(pid) && pid > 1 ? pid : null,
  }
}

export function persistSlotRuntimeMemory(projectRoot, vmId, memory) {
  if (!projectRoot || !vmId || !memory) return false
  const vmPath = path.join(projectRoot, 'vms', `${vmId}.json`)
  try {
    const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    vm.runtime = { ...(vm.runtime || {}), memory: String(memory) }
    vm.updated_at = new Date().toISOString()
    atomicWriteJson(vmPath, vm, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

export function restoreSlotMemoryAfterOfficialCc(vmId, idleMemory, { keepCli = false } = {}) {
  if (!keepCli) stopOfficialCcLeftovers(vmId)
  return applyContainerMemory(vmId, idleMemory || slotIdleMemory())
}

export function buildOfficialCcResidentDockerArgs({ vmId, uid, gid, timezone = 'UTC', locale = 'en_US.UTF-8' }) {
  return [
    'exec',
    '-d',
    '-t',
    '-u',
    `${uid}:${gid}`,
    '-e',
    'HOME=/home/kincli',
    '-e',
    'TMPDIR=/home/kincli/.cache/tmp',
    '-e',
    `TZ=${timezone}`,
    '-e',
    `LANG=${locale}`,
    '-e',
    `LC_ALL=${locale}`,
    '-e',
    'PATH=/home/kincli/.local/bin:/usr/bin:/bin',
    '-e',
    'CLAUDE_CODE_USE_BEDROCK=0',
    '-e',
    'CLAUDE_CODE_USE_VERTEX=0',
    '-e',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0',
    '-e',
    'DISABLE_TELEMETRY=1',
    '-e',
    'DO_NOT_TRACK=1',
    '-e',
    'ANTHROPIC_BASE_URL=',
    '-e',
    'ANTHROPIC_API_KEY=',
    '-e',
    'ANTHROPIC_AUTH_TOKEN=',
    '-w',
    '/home/kincli',
    containerName(vmId),
    '/home/kincli/.local/bin/claude',
  ]
}

export function startOfficialCcResidentProcess({ vmId, projectRoot, uid, gid, timezone, locale }) {
  const script = path.join(scriptsDir(), 'official-cc-resident.py')
  const runDir = officialCcRunDir(projectRoot, vmId)
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const pidFile = officialCcPidPath(projectRoot, vmId, 'resident')
  const child = spawn('python3', [script], {
    env: {
      ...process.env,
      KIN_CONTAINER: containerName(vmId),
      KIN_UID: String(uid),
      KIN_GID: String(gid),
      TZ: timezone || 'UTC',
      LANG: locale || 'en_US.UTF-8',
      LC_ALL: locale || 'en_US.UTF-8',
    },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  fs.writeFileSync(pidFile, String(child.pid) + '\n', { mode: 0o600 })
  return { ok: true, host_pid: child.pid }
}

export async function keepOfficialCcResidentAfterHello({ vmId, projectRoot, uid, gid, timezone, locale, idleMemory }) {
  restoreSlotMemoryAfterOfficialCc(vmId, idleMemory, { keepCli: true })
  persistSlotRuntimeMemory(projectRoot, vmId, idleMemory)
  const started = startOfficialCcResidentProcess({
    vmId,
    projectRoot,
    uid,
    gid,
    timezone,
    locale,
  })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const live = inspectOfficialCcResident(vmId)
  return {
    ok: live.running === true,
    host_pid: started.host_pid,
    guest_pid: live.pid,
    error: live.running ? null : 'resident claude failed to stay running',
  }
}

export function listOfficialCcVmIds(projectRoot) {
  const dir = path.join(projectRoot, 'vms')
  if (!fs.existsSync(dir)) return []
  return listVmRecordFiles(dir).map((name) => name.slice(0, -5))
}

/** Already-initialized slots whose official CLI died with the Node process. */
export function officialCcShouldRestoreResident(projectRoot, vmId, { config = null, status = null, live = null } = {}) {
  if (process.env.KIN_CRS_MOCK === '1') return { restore: false, reason: 'mock' }
  const cfg = normalizeOfficialCcConfig(config)
  const vm = readVmDocument(projectRoot, vmId)
  if (resolveOfficialCcInference(vm, { official_cc: cfg }) === 'cli-hop') {
    return { restore: false, reason: 'cli-hop' }
  }
  if (cfg.resident === false) return { restore: false, reason: 'disabled' }
  if (!projectRoot || !vmId) return { restore: false, reason: 'missing_slot' }
  const homeDir = officialCcHome(projectRoot, vmId)
  const st = status || readOfficialCcStatus(homeDir)
  if (st?.status === 'running') return { restore: false, reason: 'init_running' }
  const skip = officialCcShouldSkipAutoInit(projectRoot, vmId, { status: st })
  if (!skip.skip) return { restore: false, reason: skip.reason }
  const home = summarizeOfficialCcHome(homeDir)
  if (!home.has_claude_bin) return { restore: false, reason: 'no_cli' }
  if (live?.running) return { restore: false, reason: 'already_running' }
  return { restore: true, reason: 'dead_after_init' }
}

export async function restoreOfficialCcResident(
  projectRoot,
  vmId,
  {
    config = null,
    status = null,
    inspect = inspectOfficialCcResident,
    startResident = keepOfficialCcResidentAfterHello,
  } = {},
) {
  const live = typeof inspect === 'function' ? inspect(vmId) : inspect
  const decision = officialCcShouldRestoreResident(projectRoot, vmId, { config, status, live })
  if (!decision.restore) return { ...decision, ok: decision.reason === 'already_running' }
  const vmPath = path.join(projectRoot, 'vms', `${vmId}.json`)
  let vm = {}
  try {
    vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  } catch {}
  const { uid, gid } = officialCcUidGid(vmId)
  const started = await startResident({
    vmId,
    projectRoot,
    uid,
    gid,
    timezone: vm.timezone || vm.fingerprint?.timezone || 'UTC',
    locale: vm.locale || vm.fingerprint?.locale || 'en_US.UTF-8',
    idleMemory: slotIdleMemory(),
  })
  const homeDir = officialCcHome(projectRoot, vmId)
  const prev = readOfficialCcStatus(homeDir) || {}
  writeOfficialCcStatus(homeDir, {
    ...prev,
    resident: true,
    resident_ok: started?.ok === true,
    resident_pid: started?.guest_pid,
    bridge_port: started?.bridge_port,
    step: prev.step || 'done',
    error: started?.ok ? prev.error || null : started?.error || 'resident restore failed',
  })
  return {
    restore: true,
    reason: 'started',
    ok: started?.ok === true,
    host_pid: started?.host_pid || null,
    guest_pid: started?.guest_pid || null,
    error: started?.ok ? null : started?.error || 'resident restore failed',
  }
}

export async function restoreOfficialCcResidents(projectRoot, opts = {}) {
  const ids = Array.isArray(opts.vmIds) ? opts.vmIds : listOfficialCcVmIds(projectRoot)
  const results = []
  for (const vmId of ids) {
    try {
      results.push({ vmId, ...(await restoreOfficialCcResident(projectRoot, vmId, opts)) })
    } catch (error) {
      results.push({
        vmId,
        restore: false,
        reason: 'error',
        ok: false,
        error: String(error?.message || error).slice(0, 200),
      })
    }
  }
  return {
    checked: results.length,
    restored: results.filter((row) => row.reason === 'started' && row.ok).length,
    failed: results.filter((row) => (row.reason === 'started' && !row.ok) || row.reason === 'error').length,
    already_running: results.filter((row) => row.reason === 'already_running').length,
    skipped: results.filter((row) => !row.restore && row.reason !== 'already_running' && row.reason !== 'error').length,
    results,
  }
}

export const FIRST_USE_WIPE_RELATIVE = Object.freeze([
  '.claude.json',
  '.claude.json.bak-pre-official',
  '.claude/.claude.json',
  '.claude/.credentials.json',
  '.claude/.last-cleanup',
  '.claude/projects',
  '.claude/sessions',
  '.claude/backups',
  '.claude/plugins',
  '.claude/file-history',
  '.claude/todos',
  '.claude/statsig',
  '.claude/debug',
  '.claude/shell-snapshots',
  '.claude/plans',
  '.claude/ide',
  '.claude/history.jsonl',
  '.claude/kin-cc-headers.json',
  '.claude/kin-official-plan.json',
  '.claude/kin-official-plan.err',
  '.claude/kin-official-hello.json',
  '.claude/kin-official-hello.err',
  '.claude/kin-official-stats.json',
  '.claude/kin-official-stats.err',
])

const KEEP_CREDENTIAL_NAMES = new Set(['credentials.json', 'credentials.json.lock'])

const BOOTSTRAP_NAME = 'kin-official-bootstrap.json'
const running = new Map()

function scriptsDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts')
}

export function officialCcHome(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', vmId, 'cli-home')
}

export function officialCcBin(homeDir) {
  return path.join(homeDir, '.local', 'bin', 'claude')
}

/** install.sh may write an absolute /home/kincli/... link that is dangling on the host. */
export function repairOfficialClaudeBinLink(homeDir) {
  const bin = officialCcBin(homeDir)
  const ver = latestOfficialClaudeVersion(homeDir)
  const wanted = ver ? path.join('..', 'share', 'claude', 'versions', ver) : null
  let st = null
  try {
    st = fs.lstatSync(bin)
  } catch {}
  if (st?.isFile()) return { ok: true, path: bin, repaired: false, kind: 'file' }
  if (st?.isSymbolicLink()) {
    const dest = String(fs.readlinkSync(bin) || '').replace(/\\/g, '/')
    const resolved = path.resolve(path.dirname(bin), dest)
    const destOk = fs.existsSync(resolved) && fs.statSync(resolved).isFile()
    const absGuest = dest.startsWith('/home/kincli/')
    const matchesWanted = wanted && dest === wanted.replace(/\\/g, '/')
    if (destOk && !absGuest && matchesWanted) {
      return { ok: true, path: bin, repaired: false, version: ver, kind: 'symlink' }
    }
    if (destOk && !absGuest && !wanted) {
      return { ok: true, path: bin, repaired: false, kind: 'symlink' }
    }
    try {
      fs.unlinkSync(bin)
    } catch {}
  } else if (st && !st.isFile()) {
    try {
      fs.unlinkSync(bin)
    } catch {}
  }
  if (wanted) {
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.symlinkSync(wanted, bin)
    return { ok: true, path: bin, repaired: true, version: ver, kind: 'symlink' }
  }
  return { ok: false, path: bin }
}

export function repairProjectOfficialClaudeBins(projectRoot) {
  const vmsDir = path.join(projectRoot, 'vms')
  const items = []
  let names = []
  try {
    names = fs.readdirSync(vmsDir)
  } catch {
    return items
  }
  for (const name of names) {
    // Slot home dirs are named after the slot id; skip json records and dotfiles.
    if (name.startsWith('.') || name.endsWith('.json')) continue
    const home = officialCcHome(projectRoot, name)
    if (!fs.existsSync(home)) continue
    items.push({ vm_id: name, ...repairOfficialClaudeBinLink(home) })
  }
  return items
}

export function sanitizeOfficialCcInstallError(raw = '') {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const useful = lines.filter((line) => !/^% Total|^Dload |^[\s0-9]*$/.test(line) && !/^-+$/.test(line))
  const last = useful[useful.length - 1] || lines[lines.length - 1] || 'official claude binary missing after install'
  return last.replace(/\s+/g, ' ').slice(0, 240)
}

export function officialCcStatusPath(homeDir) {
  return path.join(homeDir, '.claude', BOOTSTRAP_NAME)
}

export function dockerGatewayIp(vmId) {
  try {
    const out = execFileSync(
      'docker',
      ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}', containerName(vmId)],
      { encoding: 'utf8', timeout: 5_000 },
    )
    const ip = String(out || '')
      .trim()
      .split(/\s+/)[0]
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return ip
  } catch {}
  return '172.17.0.1'
}

export function readOfficialCcStatus(homeDir) {
  try {
    return JSON.parse(fs.readFileSync(officialCcStatusPath(homeDir), 'utf8'))
  } catch {
    return null
  }
}

export function writeOfficialCcStatus(homeDir, status) {
  const dir = path.join(homeDir, '.claude')
  fs.mkdirSync(dir, { recursive: true })
  const safe = {
    status: status.status || 'unknown',
    vm_id: status.vm_id || null,
    started_at: status.started_at || null,
    finished_at: status.finished_at || null,
    claude_version: status.claude_version || null,
    exit_code: status.exit_code ?? null,
    hello_ok: !!status.hello_ok,
    usage_ok: !!status.usage_ok,
    usage_source: status.usage_source || null,
    usage_via: status.usage_via || null,
    stats_ok: !!(status.stats_ok || status.usage_ok),
    plan_ok: !!(status.hello_ok || status.plan_ok),
    wiped: !!status.wiped,
    step: status.step || null,
    official_login: !!status.official_login,
    account_tier: status.account_tier || null,
    has_oauth_account: !!status.has_oauth_account,
    has_user_id: !!status.has_user_id,
    has_machine_id: !!status.has_machine_id,
    telemetry_wrote: !!status.telemetry_wrote,
    telemetry_enabled: !!status.telemetry_enabled,
    telemetry_official: !!status.telemetry_official,
    identity_wrote: !!status.identity_wrote,
    sidecar_reloaded: !!status.sidecar_reloaded,
    seed_aligned: !!status.seed_aligned,
    telemetry_touched: !!status.telemetry_touched,
    memory_init: status.memory_init || null,
    memory_idle: status.memory_idle || null,
    memory_restored: status.memory_restored === true,
    resident: status.resident === true,
    resident_ok: status.resident_ok === true,
    resident_pid: Number.isFinite(Number(status.resident_pid)) ? Number(status.resident_pid) : null,
    bridge_port: Number.isFinite(Number(status.bridge_port)) ? Number(status.bridge_port) : null,
    error: status.error ? String(status.error).slice(0, 300) : null,
    force: !!status.force,
  }
  fs.writeFileSync(officialCcStatusPath(homeDir), JSON.stringify(safe, null, 2) + '\n', { mode: 0o600 })
  return safe
}

export function summarizeOfficialCcHome(homeDir) {
  const identity = readOfficialCcIdentity(homeDir)
  let doc = {}
  for (const file of [path.join(homeDir, '.claude', '.claude.json'), path.join(homeDir, '.claude.json')]) {
    try {
      const candidate = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (candidate?.machineID && candidate?.userID) {
        doc = candidate
        break
      }
    } catch {}
  }
  return {
    has_oauth_account: !!identity.account_uuid,
    has_user_id: !!identity.user_id,
    has_machine_id: !!identity.machine_id,
    has_completed_onboarding: !!doc.hasCompletedOnboarding,
    has_claude_bin: fs.existsSync(officialCcBin(homeDir)),
  }
}

/** Used by resident restore: a completed first-time bootstrap can keep the
 *  resident CLI without another hello. Ticket import does not use this gate —
 *  successful exchange always re-inits when official_cc.enabled (force:true).
 */
export function officialCcShouldSkipAutoInit(projectRoot, vmId, { incoming = {}, status = null } = {}) {
  if (!projectRoot || !vmId) return { skip: false, reason: 'missing_slot' }
  const homeDir = officialCcHome(projectRoot, vmId)
  const st = status || readOfficialCcStatus(homeDir)
  const home = summarizeOfficialCcHome(homeDir)
  const official = readOfficialCcIdentity(homeDir)
  if (!st || st.status !== 'ok') return { skip: false, reason: 'init_incomplete' }
  const helloDone = !!(st.hello_ok || st.official_login || st.plan_ok)
  if (!helloDone && (!home.has_user_id || !home.has_machine_id)) {
    return { skip: false, reason: 'init_incomplete' }
  }
  if (!home.has_user_id || !home.has_machine_id) {
    return { skip: false, reason: 'missing_official_ids' }
  }
  const incomingAccount = incoming.account_uuid || incoming.accountUuid || null
  const incomingEmail = incoming.email || incoming.email_address || incoming.emailAddress || null
  const officialAccount = official.account_uuid || null
  const officialEmail = official.email || null
  if (incomingAccount && officialAccount && incomingAccount !== officialAccount) {
    return { skip: false, reason: 'account_changed' }
  }
  if (incomingEmail && officialEmail && String(incomingEmail).toLowerCase() !== String(officialEmail).toLowerCase()) {
    return { skip: false, reason: 'account_changed' }
  }
  return { skip: true, reason: 'already_initialized' }
}

export function wipeOfficialFirstUseHome(homeDir, { uid, gid } = {}) {
  if (!homeDir) return { wiped: false, error: 'homeDir required' }
  fs.mkdirSync(homeDir, { recursive: true })
  for (const rel of FIRST_USE_WIPE_RELATIVE) {
    const target = path.join(homeDir, rel)
    try {
      fs.rmSync(target, { recursive: true, force: true })
    } catch {}
  }
  const claudeDir = path.join(homeDir, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  for (const name of fs.readdirSync(claudeDir)) {
    if (KEEP_CREDENTIAL_NAMES.has(name)) continue
    if (
      name.startsWith('kin-official-') ||
      name === 'settings.json' ||
      name === 'kin-seed.json' ||
      name === 'kin-identity.json'
    ) {
      try {
        fs.rmSync(path.join(claudeDir, name), { recursive: true, force: true })
      } catch {}
    }
  }
  if (uid != null && gid != null) {
    try {
      fs.chownSync(homeDir, uid, gid)
    } catch {}
    try {
      fs.chownSync(claudeDir, uid, gid)
    } catch {}
    for (const name of KEEP_CREDENTIAL_NAMES) {
      try {
        fs.chownSync(path.join(claudeDir, name), uid, gid)
      } catch {}
    }
  }
  return { wiped: true, kept_credentials: fs.existsSync(path.join(claudeDir, 'credentials.json')) }
}

/**
 * Official CLI reads ~/.claude/.credentials.json. One store: symlink
 * that name onto host-owned credentials.json so wrap cannot copy RT.
 */
export function materializeOfficialClaudeCredentials(homeDir, { uid, gid } = {}) {
  return ensureOfficialCredentialLink(homeDir, { uid, gid })
}

export function prepareClaudeJsonForOfficialInit(homeDir, opts = {}) {
  const { uid, gid } = opts
  const wiped = wipeOfficialFirstUseHome(homeDir, { uid, gid })
  const login = materializeOfficialClaudeCredentials(homeDir, { uid, gid })
  return { ...wiped, official_login: !!login.wrote, official_login_error: login.error || null }
}

export function officialCcShouldForceRefresh(homeDir, vm = {}) {
  const cred = readWorkerCredentialFile(homeDir)
  if (cred?.expires_at) return needsRefresh(cred.expires_at)
  if (vm?.claude?.expires_at) return needsRefresh(vm.claude.expires_at)
  return false
}

export function applySeedAfterOfficialInit(homeDir, vm = {}, seedPolicy = null, projectRoot = null) {
  const seed = defaultSeedPolicy(seedPolicy || vm.seed_policy || {})
  const root = projectRoot || inferProjectRootFromCliHome(homeDir)
  if (root && vm.id) {
    return writeSlotSeedFiles(root, { ...vm, seed_policy: seed }, seed)
  }
  return { wrote: false, seed_policy: seed }
}

function sh(argv, opts = {}) {
  try {
    const out = execFileSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      timeout: opts.timeout ?? 90_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env || process.env,
    })
    return { ok: true, stdout: String(out || '').trim(), stderr: '' }
  } catch (e) {
    return {
      ok: false,
      stdout: String(e.stdout || '').trim(),
      stderr: String(e.stderr || e.message || '').trim(),
      code: e.status,
    }
  }
}

function waitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {}
      resolve({ timed_out: true, code: null })
    }, timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ timed_out: false, code })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ timed_out: false, code: null, error: String(error.message || error).slice(0, 200) })
    })
  })
}

function spawnCaptured(argv, { timeoutMs = 90_000, env = process.env } = {}) {
  const child = spawn(argv[0], argv.slice(1), {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  return waitExit(child, timeoutMs).then((done) => ({
    ok: !done.timed_out && done.code === 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    code: done.code,
    timed_out: !!done.timed_out,
    error: done.error || null,
  }))
}

export async function ensureOfficialClaudeBinary(homeDir, { uid, gid, container, timeoutMs = 180_000 } = {}) {
  const bin = officialCcBin(homeDir)
  const repaired = repairOfficialClaudeBinLink(homeDir)
  if (fs.existsSync(bin)) {
    const ver = await spawnCaptured([bin, '--version'], { timeoutMs: 15_000 })
    return { ok: true, path: bin, version: ver.stdout || null, installed: false, repaired: !!repaired.repaired }
  }
  fs.mkdirSync(path.join(homeDir, '.local', 'bin'), { recursive: true })
  fs.mkdirSync(path.join(homeDir, '.cache', 'tmp'), { recursive: true })
  try {
    fs.chownSync(path.join(homeDir, '.local'), uid, gid)
    fs.chownSync(path.join(homeDir, '.local', 'bin'), uid, gid)
    fs.chownSync(path.join(homeDir, '.cache'), uid, gid)
    fs.chownSync(path.join(homeDir, '.cache', 'tmp'), uid, gid)
  } catch {}
  const install = 'mkdir -p "$HOME/.local/bin" "$TMPDIR" && curl -fsSL https://claude.ai/install.sh | bash'
  let r = { ok: false }
  if (container) {
    r = await spawnCaptured(
      [
        'docker',
        'exec',
        '-u',
        `${uid}:${gid}`,
        '-e',
        'HOME=/home/kincli',
        '-e',
        'TMPDIR=/home/kincli/.cache/tmp',
        '-e',
        'PATH=/home/kincli/.local/bin:/usr/bin:/bin',
        container,
        'bash',
        '-lc',
        install,
      ],
      { timeoutMs },
    )
    await spawnCaptured(
      [
        'docker',
        'exec',
        '-u',
        `${uid}:${gid}`,
        '-e',
        'HOME=/home/kincli',
        container,
        'bash',
        '-lc',
        'ver=$(ls -1 "$HOME/.local/share/claude/versions" 2>/dev/null | tail -1); [ -n "$ver" ] && ln -sfn "../share/claude/versions/$ver" "$HOME/.local/bin/claude"',
      ],
      { timeoutMs: 15_000 },
    )
    repairOfficialClaudeBinLink(homeDir)
  }
  if (!fs.existsSync(bin) && latestOfficialClaudeVersion(homeDir)) {
    repairOfficialClaudeBinLink(homeDir)
  }
  if (!fs.existsSync(bin) && !latestOfficialClaudeVersion(homeDir)) {
    const latest = await spawnCaptured(['curl', '-fsSL', 'https://downloads.claude.ai/claude-code-releases/latest'], {
      timeoutMs: 30_000,
    })
    const ver = String(latest.stdout || '').trim()
    if (latest.ok && ver) {
      const tmp = `${bin}.part`
      try {
        fs.unlinkSync(tmp)
      } catch {}
      try {
        fs.lstatSync(bin) && fs.unlinkSync(bin)
      } catch {}
      r = await spawnCaptured(
        [
          'curl',
          '-fsSL',
          '--retry',
          '3',
          '-o',
          tmp,
          `https://downloads.claude.ai/claude-code-releases/${ver}/linux-x64/claude`,
        ],
        { timeoutMs },
      )
      if (r.ok && fs.existsSync(tmp)) {
        fs.renameSync(tmp, bin)
        try {
          fs.chmodSync(bin, 0o755)
        } catch {}
      } else {
        try {
          fs.unlinkSync(tmp)
        } catch {}
      }
    }
  }
  try {
    fs.chownSync(path.join(homeDir, '.local'), uid, gid)
    fs.chownSync(path.join(homeDir, '.cache'), uid, gid)
  } catch {}
  if (!fs.existsSync(bin)) {
    return { ok: false, error: sanitizeOfficialCcInstallError(r.stderr || r.stdout || r.error) }
  }
  const ver = await spawnCaptured([bin, '--version'], { timeoutMs: 15_000 })
  return { ok: true, path: bin, version: ver.stdout || null, installed: true }
}

export function isOfficialCcSlashPrompt(prompt = '') {
  return /^\s*\/[a-z0-9][\w-]*/i.test(String(prompt || ''))
}

export function buildOfficialCcDockerArgs({
  vmId,
  uid,
  gid,
  timezone = 'UTC',
  locale = 'en_US.UTF-8',
  bridgeUrl,
  prompt = DEFAULT_PLAN_PROMPT,
}) {
  const text = String(prompt || '').trim() || DEFAULT_PLAN_PROMPT
  const slash = isOfficialCcSlashPrompt(text)
  return [
    'exec',
    '-u',
    `${uid}:${gid}`,
    '-e',
    'HOME=/home/kincli',
    '-e',
    'TMPDIR=/home/kincli/.cache/tmp',
    '-e',
    `TZ=${timezone}`,
    '-e',
    `LANG=${locale}`,
    '-e',
    `LC_ALL=${locale}`,
    '-e',
    'PATH=/home/kincli/.local/bin:/usr/bin:/bin',
    '-e',
    'CLAUDE_CODE_USE_BEDROCK=0',
    '-e',
    'CLAUDE_CODE_USE_VERTEX=0',
    '-e',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0',
    '-e',
    'DISABLE_TELEMETRY=1',
    '-e',
    'DO_NOT_TRACK=1',
    '-e',
    'ANTHROPIC_BASE_URL=',
    '-e',
    'ANTHROPIC_API_KEY=',
    '-e',
    'ANTHROPIC_AUTH_TOKEN=',
    '-e',
    'CI=1',
    '-w',
    '/home/kincli',
    containerName(vmId),
    '/home/kincli/.local/bin/claude',
    ...(slash
      ? [text, '--print', '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose']
      : ['-p', text, '--permission-mode', 'bypassPermissions', '--output-format', 'json']),
  ]
}

export async function runOfficialCcTurn({
  vmId,
  uid,
  gid,
  timezone,
  locale,
  bridgeUrl,
  prompt,
  outFile,
  errFile,
  timeoutMs,
}) {
  const out = fs.openSync(outFile, 'w', 0o600)
  const err = fs.openSync(errFile, 'w', 0o600)
  const child = spawn(
    'docker',
    buildOfficialCcDockerArgs({
      vmId,
      uid,
      gid,
      timezone,
      locale,
      bridgeUrl,
      prompt,
    }),
    { stdio: ['ignore', out, err] },
  )
  const finished = await waitExit(child, timeoutMs)
  try {
    fs.closeSync(out)
  } catch {}
  try {
    fs.closeSync(err)
  } catch {}
  try {
    fs.chownSync(outFile, uid, gid)
  } catch {}
  try {
    fs.chownSync(errFile, uid, gid)
  } catch {}
  let parsed = null
  let raw = ''
  try {
    raw = fs.readFileSync(outFile, 'utf8').trim()
    if (raw) parsed = JSON.parse(raw)
  } catch {}
  const ok = finished.code === 0 && !finished.timed_out && !parsed?.is_error && !parsed?.error
  return {
    ok,
    timed_out: !!finished.timed_out,
    code: finished.code,
    error: finished.error || null,
    parsed,
    raw_len: raw.length,
  }
}

function persistOfficialCcFingerprint(vmPath, homeDir) {
  return applyOfficialFingerprintToVm(vmPath, homeDir)
}

/**
 * Post-init telemetry close-out used by vm-05 / vm-13 / vm-30:
 * normalize seed (telemetry on, NONESSENTIAL=1, grove_enabled false), write official
 * ~/.claude.json IDs into worker.json.telemetry, reload the slot so
 * `kin-worker telemetry` starts, then touch a 10-minute session.
 * Never docker rm.
 */
export async function finalizeOfficialCcTelemetry(
  projectRoot,
  vmId,
  { reload = true, enable = true, routing = {}, reloadSlot = reloadSlotReady } = {},
) {
  if (!projectRoot || !vmId) {
    return { wrote: false, enabled: false, official: false, reloaded: false, seed_aligned: false, touched: false }
  }
  const vmPath = path.join(projectRoot, 'vms', `${vmId}.json`)
  if (!fs.existsSync(vmPath)) {
    return { wrote: false, enabled: false, official: false, reloaded: false, seed_aligned: false, touched: false }
  }
  let vm
  try {
    vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  } catch {
    return { wrote: false, enabled: false, official: false, reloaded: false, seed_aligned: false, touched: false }
  }
  const seed = defaultSeedPolicy({
    ...(vm.seed_policy || {}),
    telemetry_disabled: enable ? false : vm.seed_policy?.telemetry_disabled !== false,
    disable_nonessential_traffic: enable ? true : vm.seed_policy?.telemetry_disabled === false,
    do_not_track: enable ? false : vm.seed_policy?.do_not_track !== false,
  })
  vm.seed_policy = seed
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(vmPath, vm, { mode: 0o600 })
  const homeDir = officialCcHome(projectRoot, vmId)
  applySeedAfterOfficialInit(homeDir, vm, seed, projectRoot)
  const tel = writeOfficialCcTelemetry(projectRoot, vmId)
  let reloaded = false
  if (reload && tel.enabled) {
    try {
      const r = await reloadSlot(vm, projectRoot, { routing })
      reloaded = r?.ok === true && r?.rust_ok !== false
    } catch {}
  }
  let touched = false
  if (tel.enabled) {
    try {
      touched = !!touchTelemetrySession(projectRoot, vmId).wrote
    } catch {}
  }
  return {
    wrote: !!tel.wrote,
    enabled: tel.enabled === true,
    official: !!tel.official,
    identity_wrote: !!tel.identity_wrote,
    fingerprint_wrote: !!tel.fingerprint_wrote,
    seed_aligned: true,
    reloaded,
    touched,
  }
}

/** Fingerprint + kin-identity + worker.json.telemetry from official ~/.claude.json. */
export function writeOfficialCcTelemetry(projectRoot, vmId) {
  if (!projectRoot || !vmId) return { wrote: false, enabled: false, official: false }
  const vmPath = path.join(projectRoot, 'vms', `${vmId}.json`)
  if (!fs.existsSync(vmPath)) return { wrote: false, enabled: false, official: false }
  const homeDir = officialCcHome(projectRoot, vmId)
  const fingerprint = persistOfficialCcFingerprint(vmPath, homeDir)
  let vm
  try {
    vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  } catch {
    return {
      wrote: false,
      enabled: false,
      official: !!fingerprint?.official,
      identity_wrote: !!fingerprint?.identity_wrote,
    }
  }
  const tel = syncWorkerTelemetry(vm, projectRoot)
  return {
    wrote: !!tel.wrote,
    enabled: tel.enabled === true,
    official: !!fingerprint?.official,
    identity_wrote: !!fingerprint?.identity_wrote || !!fingerprint?.wrote,
    fingerprint_wrote: !!fingerprint?.wrote,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Official `/usage` inside the slot (egress = slot SOCKS5 / transparent exit).
 * One try plus OFFICIAL_USAGE_RETRIES. A reply without the server limits[]
 * rows is retried too: that cached/seeded read is where Max loses Fable.
 */
export async function runOfficialCcUsage({
  turn,
  homeDir,
  retries = OFFICIAL_USAGE_RETRIES,
  retryDelayMs = OFFICIAL_USAGE_RETRY_DELAY_MS,
}) {
  const outFile = path.join(homeDir, '.claude', 'kin-official-usage.json')
  const errFile = path.join(homeDir, '.claude', 'kin-official-usage.err')
  let last = { turn: { ok: false, code: null, timed_out: false, error: null }, stats: null, attempts: 0 }
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0 && retryDelayMs > 0) await sleep(retryDelayMs)
    const result = await turn({ prompt: DEFAULT_USAGE_PROMPT, outFile, errFile })
    let stats = null
    try {
      stats = parseOfficialCcStats(fs.readFileSync(outFile, 'utf8'))
    } catch {}
    last = { turn: result, stats, attempts: attempt + 1 }
    if (stats?.ok && stats.limits_present) break
  }
  return last
}

/** Tier (from /api/oauth/profile) and model ids (from /v1/models) via the slot worker. */
export async function collectOfficialCcAccount(exec, { slotOauth } = {}) {
  const call = slotOauth || (await import('../transport/slot-oauth.mjs')).runSlotOauth
  const [profile, models] = await Promise.all([
    call(exec, 'profile', { timeoutMs: 30_000 }),
    call(exec, 'models', { timeoutMs: 30_000 }),
  ])
  const tier = profile?.ok ? tierFromOauthProfile(profile.body) : null
  const list = Array.isArray(models?.body?.data) ? models.body.data : []
  return {
    account_tier: tier,
    profile_ok: !!profile?.ok,
    profile_error: profile?.ok ? null : profile?.body?.error?.code || `http_${profile?.status || 0}`,
    available_models: models?.ok ? list.map((m) => String(m?.id || '')).filter(Boolean) : null,
    models_error: models?.ok ? null : models?.body?.error?.code || `http_${models?.status || 0}`,
  }
}

export async function runOfficialCcBootstrap(rawOpts = {}) {
  const config = normalizeOfficialCcConfig(rawOpts.config || loadOfficialCcConfig(rawOpts.routingFile))
  const routing = loadRoutingDocument(rawOpts.routingFile)
  const {
    vmId,
    projectRoot,
    prompt,
    force = true,
    timeoutMs,
    collectIdentity = null,
    onStats = null,
    applySeed,
    wipe: doWipe,
    reconcileFingerprint,
    syncTelemetry,
    memory,
    resident,
    runTurn = runOfficialCcTurn,
    slotOauth,
    retryDelayMs,
  } = applyOfficialCcConfig(rawOpts, config)
  if (!vmId || !projectRoot) return { ok: false, error: 'vmId and projectRoot required' }
  const vmPath = path.join(projectRoot, 'vms', `${vmId}.json`)
  if (!fs.existsSync(vmPath)) return { ok: false, error: 'vm not found' }
  let vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  const homeDir = officialCcHome(projectRoot, vmId)
  const { uid, gid } = officialCcUidGid(vmId)
  const startedAt = new Date().toISOString()
  if (!canOfficialCc(credentialModeOfVm(vm))) {
    return { ok: false, error: 'official Claude Code init requires full OAuth' }
  }
  if (!(hasAccessPresence(vm.claude) || hasRefreshPresence(vm.claude))) {
    const credFile = path.join(homeDir, '.claude', 'credentials.json')
    let live = false
    try {
      const doc = JSON.parse(fs.readFileSync(credFile, 'utf8'))
      const oauth = doc.claudeAiOauth && typeof doc.claudeAiOauth === 'object' ? doc.claudeAiOauth : doc
      live = !!(oauth.accessToken || oauth.access_token || oauth.refreshToken || oauth.refresh_token)
    } catch {}
    if (!live) {
      return { ok: false, error: 'slot has no live OAuth credential' }
    }
  }

  const keepResident = resident !== false && resolveOfficialCcInference(vm, routing) !== 'cli-hop'
  const idleMemory = keepResident
    ? slotIdleMemory()
    : chooseIdleMemory(inspectContainerMemory(vmId), memory, slotIdleMemory())
  stopOfficialCcResident(vmId, projectRoot)
  applyContainerMemory(vmId, memory)
  let helloOk = false
  try {
    writeOfficialCcStatus(homeDir, {
      status: 'running',
      vm_id: vmId,
      started_at: startedAt,
      force,
      step: 'wipe',
      memory_init: memory,
      memory_idle: idleMemory,
    })
    const wiped =
      doWipe === false ? { wiped: false, kept_credentials: true } : wipeOfficialFirstUseHome(homeDir, { uid, gid })
    if (isSlotProxyDesynced(vm, projectRoot)) {
      try {
        await reloadSlotReady(vm, projectRoot, { routing })
      } catch {}
      try {
        vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
      } catch {}
    }
    const needForceRefresh = officialCcShouldForceRefresh(homeDir, vm)
    if (needForceRefresh) {
      writeOfficialCcStatus(homeDir, {
        status: 'running',
        vm_id: vmId,
        started_at: startedAt,
        wiped: wiped.wiped,
        force,
        step: 'refresh',
      })
      const refreshed = await ensureWorkerCredential(
        {
          vmId,
          vm,
          homeDir,
        },
        { force: true, timeoutMs: 60_000 },
      )
      if (!refreshed?.ok && refreshed?.status !== 200) {
        const status = writeOfficialCcStatus(homeDir, {
          status: 'error',
          vm_id: vmId,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          wiped: wiped.wiped,
          step: 'refresh',
          error: refreshed?.error?.message || `worker credential refresh failed (${refreshed?.status || 0})`,
        })
        return { ok: false, error: status.error, status }
      }
    }
    writeOfficialCcStatus(homeDir, {
      status: 'running',
      vm_id: vmId,
      started_at: startedAt,
      wiped: wiped.wiped,
      force,
      step: 'login',
    })
    const login = materializeOfficialClaudeCredentials(homeDir, { uid, gid })
    if (!login.wrote) {
      const status = writeOfficialCcStatus(homeDir, {
        status: 'error',
        vm_id: vmId,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        wiped: wiped.wiped,
        error: login.error || 'failed to materialize official .credentials.json',
      })
      return { ok: false, error: status.error, status }
    }
    writeOfficialCcStatus(homeDir, {
      status: 'running',
      vm_id: vmId,
      started_at: startedAt,
      wiped: wiped.wiped,
      official_login: true,
      force,
      step: 'hello',
    })

    const installed = await ensureOfficialClaudeBinary(homeDir, {
      uid,
      gid,
      container: containerName(vmId),
    })
    if (!installed.ok) {
      const status = writeOfficialCcStatus(homeDir, {
        status: 'error',
        vm_id: vmId,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        wiped: wiped.wiped,
        error: installed.error,
      })
      return { ok: false, error: installed.error, status }
    }
    try {
      fs.chownSync(officialCcBin(homeDir), uid, gid)
    } catch {}

    const timezone = vm.timezone || vm.fingerprint?.timezone || 'UTC'
    const locale = vm.locale || vm.fingerprint?.locale || 'en_US.UTF-8'
    writeOfficialCcStatus(homeDir, {
      status: 'running',
      vm_id: vmId,
      started_at: startedAt,
      wiped: wiped.wiped,
      official_login: true,
      claude_version: installed.version,
      force,
      step: 'hello',
    })
    const hello = await runOfficialCcTurn({
      vmId,
      uid,
      gid,
      timezone,
      locale,
      prompt,
      outFile: path.join(homeDir, '.claude', 'kin-official-hello.json'),
      errFile: path.join(homeDir, '.claude', 'kin-official-hello.err'),
      timeoutMs,
    })
    helloOk = !!hello.ok
    const turn = ({ prompt: text, outFile, errFile }) =>
      runTurn({ vmId, uid, gid, timezone, locale, prompt: text, outFile, errFile, timeoutMs })
    writeOfficialCcStatus(homeDir, {
      status: 'running',
      vm_id: vmId,
      started_at: startedAt,
      wiped: wiped.wiped,
      official_login: true,
      claude_version: installed.version,
      hello_ok: hello.ok,
      force,
      step: 'usage',
    })
    const usageRun = hello.ok
      ? await runOfficialCcUsage({ turn, homeDir, retryDelayMs })
      : { turn: { ok: false, code: null, timed_out: false, error: null }, stats: null, attempts: 0 }
    const statsTurn = usageRun.turn
    let stats = usageRun.stats

    writeOfficialCcStatus(homeDir, {
      status: 'running',
      vm_id: vmId,
      started_at: startedAt,
      wiped: wiped.wiped,
      official_login: true,
      claude_version: installed.version,
      hello_ok: hello.ok,
      force,
      step: 'profile',
    })
    const account = await collectOfficialCcAccount({ vmId, homeDir, vm }, { slotOauth })
    let tierSource = null
    if (stats?.limits_present === true && !stats.account_tier) {
      const accountTier = inferTierFromOfficialStats('', stats)
      if (accountTier) stats = { ...stats, account_tier: accountTier }
    }
    if (!tierSource && stats?.account_tier) tierSource = 'usage'
    if (stats) stats = { ...stats, account_tier_source: tierSource }
    if (typeof onStats === 'function' && stats) {
      try {
        await onStats(stats, { vmId, projectRoot, homeDir })
      } catch {}
    }

    const usageOk = officialCcQuotaSucceeded(stats)
    writeOfficialCcStatus(homeDir, {
      status: 'running',
      vm_id: vmId,
      started_at: startedAt,
      wiped: wiped.wiped,
      official_login: true,
      claude_version: installed.version,
      hello_ok: hello.ok,
      usage_ok: usageOk,
      usage_source: stats?.source || null,
      usage_via: stats?.via || null,
      stats_ok: usageOk,
      account_tier: stats?.account_tier || null,
      force,
      step: 'seed',
    })
    if (applySeed !== false) {
      try {
        vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        applySeedAfterOfficialInit(homeDir, vm)
      } catch {}
    }
    if (reconcileFingerprint !== false) persistOfficialCcFingerprint(vmPath, homeDir)
    if (typeof collectIdentity === 'function') {
      try {
        await collectIdentity(projectRoot, JSON.parse(fs.readFileSync(vmPath, 'utf8')))
      } catch {}
    }
    writeOfficialCcStatus(homeDir, {
      status: 'running',
      vm_id: vmId,
      started_at: startedAt,
      wiped: wiped.wiped,
      official_login: true,
      claude_version: installed.version,
      hello_ok: hello.ok,
      usage_ok: usageOk,
      usage_source: stats?.source || null,
      usage_via: stats?.via || null,
      stats_ok: usageOk,
      account_tier: stats?.account_tier || null,
      force,
      step: 'telemetry',
    })
    const telemetry =
      syncTelemetry !== false && hello.ok
        ? await finalizeOfficialCcTelemetry(projectRoot, vmId, { reload: true, enable: true, routing })
        : writeOfficialCcTelemetry(projectRoot, vmId)

    const homeAfter = summarizeOfficialCcHome(homeDir)
    const ok = !!(hello.ok && usageOk)
    const usageError = stats?.usage_error || stats?.error || null
    const status = writeOfficialCcStatus(homeDir, {
      status: ok ? 'ok' : 'error',
      vm_id: vmId,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      claude_version: installed.version,
      exit_code: hello.ok ? (statsTurn.code ?? (usageOk ? 0 : 1)) : hello.code,
      hello_ok: hello.ok,
      usage_ok: usageOk,
      usage_source: stats?.source || null,
      usage_via: stats?.via || null,
      usage_attempts: usageRun.attempts,
      usage_limits_present: stats?.limits_present === true,
      stats_ok: usageOk,
      wiped: wiped.wiped,
      official_login: true,
      account_tier: stats?.account_tier || null,
      account_tier_source: tierSource,
      available_models: account.available_models,
      profile_error: account.profile_error,
      models_error: account.models_error,
      force,
      step: ok ? 'done' : hello.ok ? 'usage' : 'hello',
      telemetry_wrote: telemetry.wrote,
      telemetry_enabled: telemetry.enabled,
      telemetry_official: telemetry.official,
      identity_wrote: telemetry.identity_wrote,
      sidecar_reloaded: telemetry.reloaded === true,
      seed_aligned: telemetry.seed_aligned === true,
      telemetry_touched: telemetry.touched === true,
      ...homeAfter,
      memory_init: memory,
      memory_idle: idleMemory,
      resident: keepResident && hello.ok,
      error: ok
        ? null
        : hello.timed_out
          ? 'official claude hello timed out'
          : statsTurn.timed_out
            ? 'official claude /usage timed out'
            : hello.error ||
              (typeof usageError === 'string' ? usageError : null) ||
              statsTurn.error ||
              `official claude hello=${hello.code} usage=${usageOk ? 'ok' : 'fail'}`,
    })
    let residentInfo = null
    if (keepResident && hello.ok) {
      writeOfficialCcStatus(homeDir, { ...status, step: 'resident', resident: true })
      residentInfo = await keepOfficialCcResidentAfterHello({
        vmId,
        projectRoot,
        uid,
        gid,
        timezone,
        locale,
        idleMemory,
      })
      writeOfficialCcStatus(homeDir, {
        ...status,
        step: ok ? 'done' : status.step,
        resident: true,
        resident_ok: residentInfo.ok === true,
        resident_pid: residentInfo.guest_pid,
        bridge_port: residentInfo.bridge_port,
        memory_restored: true,
        error: status.error,
      })
    }
    return {
      ok,
      status: readOfficialCcStatus(homeDir) || status,
      stats,
      memory: { init: memory, idle: idleMemory },
      resident: residentInfo,
    }
  } finally {
    if (!(keepResident && helloOk)) {
      const restored = restoreSlotMemoryAfterOfficialCc(vmId, idleMemory)
      try {
        const prev = readOfficialCcStatus(homeDir) || {}
        writeOfficialCcStatus(homeDir, {
          ...prev,
          memory_init: memory,
          memory_idle: idleMemory,
          memory_restored: restored.ok !== false,
          resident: false,
          resident_ok: false,
        })
      } catch {}
    }
  }
}

export function scheduleOfficialCcBootstrap(opts = {}) {
  const vmId = opts.vmId
  if (!vmId || process.env.KIN_CRS_MOCK === '1') {
    return { scheduled: false, reason: process.env.KIN_CRS_MOCK === '1' ? 'mock' : 'vmId required' }
  }
  const mode = credentialModeOfVm(opts.vm) || opts.credentialMode || opts.mode
  if (mode && !canOfficialCc(mode)) {
    return { scheduled: false, reason: 'credential_mode_unsupported' }
  }
  const config = normalizeOfficialCcConfig(opts.config || loadOfficialCcConfig(opts.routingFile))
  if (config.enabled === false && opts.manual !== true) {
    return { scheduled: false, reason: 'disabled' }
  }
  const merged = applyOfficialCcConfig({ ...opts, config }, config)
  const current = running.get(vmId)
  if (current && !opts.force) {
    return { scheduled: false, reason: 'already_running' }
  }
  if (opts.manual !== true && opts.force !== true && merged.projectRoot) {
    const gate = officialCcShouldSkipAutoInit(merged.projectRoot, vmId, {
      incoming: opts.incomingOauth || {},
    })
    if (gate.skip) {
      return { scheduled: false, reason: 'already_initialized' }
    }
  }
  if (merged.projectRoot) {
    try {
      writeOfficialCcStatus(officialCcHome(merged.projectRoot, vmId), {
        status: 'running',
        vm_id: vmId,
        started_at: new Date().toISOString(),
        force: merged.force !== false,
        step: 'queued',
      })
    } catch {}
  }
  const job = Promise.resolve()
    .then(() => runOfficialCcBootstrap(merged))
    .catch((error) => {
      try {
        const homeDir = officialCcHome(merged.projectRoot, vmId)
        writeOfficialCcStatus(homeDir, {
          status: 'error',
          vm_id: vmId,
          finished_at: new Date().toISOString(),
          error: String(error.message || error).slice(0, 300),
        })
      } catch {}
      return { ok: false, error: String(error.message || error).slice(0, 300) }
    })
    .finally(() => {
      if (running.get(vmId) === job) running.delete(vmId)
    })
  running.set(vmId, job)
  return { scheduled: true, vmId }
}
