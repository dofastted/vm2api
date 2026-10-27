/**
 * OAuth credential normalization + metadata persistence.
 *
 * The slot worker owns refresh and writes slot credentials.json.
 * Slot kernel/CLI read AT; vm.json / SQLite / panel keep metadata only.
 *
 * persistOauthToVm writes presence flags + expiry/identity, then strips
 * access_token / refresh_token / session_key from the VM record.
 */

import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from '../vm/vm-file.mjs'
import { applyClearUnschedulable, applyUnschedulable, migrateScheduleRecord } from '../pool/schedule-state.mjs'
import {
  credentialModeFromOauth,
  isApiKeyMode,
  isAnySetupTokenMode,
  isOfficialSetupTokenMode,
  isSetupTokenMode,
} from './credential-mode.mjs'
import { resolveAuthScheme } from './auth-scheme.mjs'
import { flattenOauthIdentity, normalizeSubscriptionType } from './oauth-identity.mjs'

export const REFRESH_SKEW_MS = 5 * 60 * 1000

export const SENSITIVE_CREDENTIAL_KEYS = [
  'access_token',
  'refresh_token',
  'session_key',
  'accessToken',
  'refreshToken',
  'sessionKey',
  'id_token',
  'idToken',
  'api_key',
  'apiKey',
]

export function expiresAtToMs(expiresAt) {
  const n = Number(expiresAt) || 0
  if (!n) return 0
  return n < 10_000_000_000 ? n * 1000 : n
}

export function needsRefresh(expiresAt, now = Date.now(), skewMs = REFRESH_SKEW_MS) {
  const ms = expiresAtToMs(expiresAt)
  if (!ms) return true
  return ms - now <= skewMs
}

export function isFullyExpired(expiresAt, now = Date.now()) {
  const ms = expiresAtToMs(expiresAt)
  if (!ms) return true
  return ms <= now
}

export function normalizeOauth(cred = {}) {
  const access = cred.access_token || cred.accessToken || ''
  const refresh = cred.refresh_token || cred.refreshToken || ''
  let exp = cred.expires_at || cred.expiresAt || 0
  if (exp && exp > 10_000_000_000) exp = Math.floor(exp / 1000)
  if (!exp && cred.expires_in) exp = Math.floor(Date.now() / 1000) + Number(cred.expires_in)
  const scopes = Array.isArray(cred.scopes) ? cred.scopes.filter(Boolean) : []
  const identity = flattenOauthIdentity(cred)
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: exp || null,
    email: identity.email,
    account_uuid: identity.account_uuid,
    org_uuid: identity.org_uuid,
    scope: cred.scope || (scopes.length ? scopes.join(' ') : null),
    source: cred.source || null,
    session_key: cred.session_key || cred.sessionKey || null,
    _token_version: cred._token_version || cred.token_version || cred.kinGeneration || cred.kin_generation || null,
  }
}

export function hasAccessPresence(claude = {}) {
  return !!(
    claude.has_access ||
    claude.has_api_key ||
    claude.access_token ||
    claude.accessToken ||
    claude.api_key ||
    claude.apiKey
  )
}

export function hasRefreshPresence(claude = {}) {
  return !!(claude.has_refresh || claude.refresh_token || claude.refreshToken)
}

export function hasCredentialPresence(claude = {}) {
  return hasAccessPresence(claude) || hasRefreshPresence(claude)
}

export function stripCredentialSecrets(claude = {}) {
  const out = { ...claude }
  for (const key of SENSITIVE_CREDENTIAL_KEYS) delete out[key]
  return out
}

/** Metadata-only apply. Never copies live tokens onto cfg. */
export function applyOauthToCfg(cfg, cred) {
  if (!cfg?.vm) return cfg
  const n = normalizeOauth(cred)
  if (n.expires_at) cfg.vm.expires_at = n.expires_at
  if (n.email) cfg.vm.email = n.email
  if (n.account_uuid) cfg.vm.account_uuid = n.account_uuid
  if (n.org_uuid) cfg.vm.org_uuid = n.org_uuid
  cfg.vm.has_access = !!(n.access_token || cred.has_access || cfg.vm.has_access)
  cfg.vm.has_refresh = !!(n.refresh_token || cred.has_refresh || cfg.vm.has_refresh)
  cfg.vm.refresh_error = null
  delete cfg.vm.access_token
  delete cfg.vm.refresh_token
  delete cfg.vm.session_key
  return cfg
}

/** The Go worker's only credential file. Official CLI name is `.credentials.json`. */
export function slotWorkerCredentialPath(homeDir) {
  if (!homeDir) return null
  return path.join(homeDir, '.claude', 'credentials.json')
}

const AUTH_LOGIN_REFRESH_HOLD_MS = 30 * 60 * 1000

/** A live `claude auth login` is about to exchange a new grant. Do not spend the old RT. */
export function authLoginBlocksRefresh(homeDir, now = Date.now()) {
  if (!homeDir) return false
  try {
    const status = JSON.parse(fs.readFileSync(path.join(homeDir, '..', 'run', 'auth-login', 'status.json'), 'utf8'))
    const state = String(status.status || '')
    if (!state || state === 'login_ready' || state === 'error' || state === 'exited') return false
    const expires = Number(status.expires_at || 0)
    if (expires > 0) return now < expires
    const created = Number(status.created_at || 0)
    return !created || now < created + AUTH_LOGIN_REFRESH_HOLD_MS
  } catch {
    return false
  }
}

function regularOauthGrant(file) {
  let st
  try {
    st = fs.lstatSync(file)
  } catch {
    return null
  }
  if (!st.isFile()) return null
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    const oauth = doc?.claudeAiOauth && typeof doc.claudeAiOauth === 'object' ? doc.claudeAiOauth : doc
    if (!oauth || typeof oauth !== 'object') return null
    return {
      refresh: String(oauth.refreshToken || oauth.refresh_token || '').trim(),
      expires: Number(oauth.expiresAt || oauth.expires_at || 0) || 0,
      mtimeMs: Number(st.mtimeMs) || 0,
    }
  } catch {
    return null
  }
}

/** A different refresh token in the official file wins only when it is the later grant. */
function officialGrantWins(official, worker) {
  if (!official?.refresh) return false
  if (!worker?.refresh) return true
  if (official.refresh === worker.refresh) return false
  if (official.expires !== worker.expires) {
    if (!worker.expires) return true
    if (!official.expires) return false
    return official.expires > worker.expires
  }
  return official.mtimeMs > worker.mtimeMs
}

/**
 * Official CLI reads ~/.claude/.credentials.json. One store: symlink
 * that name onto host-owned credentials.json so the two names cannot
 * hold two refresh tokens. A regular `.credentials.json` with a later
 * grant is copied onto the worker file first. Deleting it and refreshing
 * the older RT is what revokes the new grant.
 */
export function ensureOfficialCredentialLink(homeDir, { uid, gid, create = false } = {}) {
  const claudeDir = path.join(homeDir || '', '.claude')
  const workerFile = path.join(claudeDir, 'credentials.json')
  const officialFile = path.join(claudeDir, '.credentials.json')
  if (!homeDir) return { wrote: false, error: 'home missing' }
  const officialGrant = regularOauthGrant(officialFile)
  const workerGrant = regularOauthGrant(workerFile)
  const adopt = officialGrantWins(officialGrant, workerGrant)
  if (!workerGrant && !fs.existsSync(workerFile)) {
    if (!adopt && !create) return { wrote: false, error: 'worker credentials.json missing' }
    fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 })
    if (adopt) fs.copyFileSync(officialFile, workerFile)
    else fs.writeFileSync(workerFile, '{}\n', { mode: 0o600 })
    fs.chmodSync(workerFile, 0o600)
    if (uid != null && gid != null) {
      try {
        fs.chownSync(workerFile, uid, gid)
      } catch {}
    }
  } else if (adopt) {
    fs.copyFileSync(officialFile, workerFile)
    fs.chmodSync(workerFile, 0o600)
    if (uid != null && gid != null) {
      try {
        fs.chownSync(workerFile, uid, gid)
      } catch {}
    }
  }
  fs.mkdirSync(claudeDir, { recursive: true })
  try {
    const st = fs.lstatSync(officialFile)
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(officialFile)
      if (target === 'credentials.json' || path.resolve(claudeDir, target) === path.resolve(workerFile)) {
        return { wrote: true, path: officialFile, linked: true, adopted: adopt }
      }
    }
    fs.rmSync(officialFile, { force: true })
  } catch {}
  try {
    fs.symlinkSync('credentials.json', officialFile)
  } catch (e) {
    return { wrote: false, error: String(e.message || e).slice(0, 200) }
  }
  if (uid != null && gid != null) {
    try {
      fs.lchownSync(officialFile, uid, gid)
    } catch {}
  }
  return { wrote: true, path: officialFile, linked: true, adopted: adopt }
}

/** Read the slot worker credentials.json without logging secrets. */
export function readWorkerCredentialFile(homeDir) {
  const file = slotWorkerCredentialPath(homeDir)
  if (!file) return null
  try {
    if (!fs.existsSync(file)) return null
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    const api = doc?.anthropicApiKey && typeof doc.anthropicApiKey === 'object' ? doc.anthropicApiKey : null
    const apiKey = api?.apiKey || api?.api_key || ''
    if (apiKey || isApiKeyMode(doc?.type)) {
      return {
        type: 'apikey',
        mode: 'apikey',
        access_token: apiKey,
        api_key: apiKey,
        refresh_token: '',
        expires_at: null,
        email: api?.email || null,
        account_uuid: api?.accountUuid || api?.account_uuid || null,
        org_uuid: api?.orgUuid || api?.org_uuid || null,
        scope: null,
        source: 'go-slot-worker',
        auth_scheme: resolveAuthScheme({
          mode: 'apikey',
          auth_scheme: doc.authScheme || doc.auth_scheme || api?.authScheme || api?.auth_scheme,
        }),
        _token_version: doc.kinGeneration || doc.kin_generation || null,
      }
    }
    const oauth = doc?.claudeAiOauth && typeof doc.claudeAiOauth === 'object' ? doc.claudeAiOauth : doc
    if (!oauth || typeof oauth !== 'object') return null
    const scope = Array.isArray(oauth.scopes) ? oauth.scopes.join(' ') : oauth.scope || null
    const mode = credentialModeFromOauth({
      type: doc.type || oauth.type,
      mode: doc.mode || oauth.mode,
      scope,
      scopes: oauth.scopes,
      access_token: oauth.accessToken || oauth.access_token,
      refresh_token: oauth.refreshToken || oauth.refresh_token,
      source: oauth.source,
      flavor: oauth.flavor,
    })

    return {
      type: mode,
      mode,
      access_token: oauth.accessToken || oauth.access_token || '',
      refresh_token: oauth.refreshToken || oauth.refresh_token || '',
      expires_at: oauth.expiresAt || oauth.expires_at || null,
      email: oauth.email || oauth.emailAddress || oauth.email_address || null,
      account_uuid: oauth.accountUuid || oauth.account_uuid || null,
      org_uuid: oauth.orgUuid || oauth.org_uuid || null,
      scope,
      subscription_type: oauth.subscriptionType || oauth.subscription_type || null,
      source: 'go-slot-worker',
      auth_scheme: resolveAuthScheme({
        mode,
        auth_scheme: doc.authScheme || doc.auth_scheme || oauth.authScheme || oauth.auth_scheme,
      }),
      _token_version: oauth.kinGeneration || oauth.kin_generation || null,
    }
  } catch {
    return null
  }
}
const SLOT_CLAUDE_FILES = ['credentials.json', 'credentials.json.lock', '.credentials.json']

function slotIndexFromText(value) {
  const s = String(value || '')
  const m = s.match(/^vm-(\d+)$/i) || s.match(/^0*(\d+)$/)
  return m ? Number(m[1]) : null
}

/** Container --user. Non-numeric ids share index 1, matching socksUidFor. */
export function slotRuntimeOwner(vm) {
  const n = slotIndexFromText(vm?.id) || slotIndexFromText(vm?.name) || 1
  const base = Number(process.env.KIN_VM_UID_BASE || 10000)
  const gid = Number(process.env.KIN_VM_GID || 987)
  return {
    uid: (Number.isFinite(base) ? base : 10000) + n,
    gid: Number.isFinite(gid) ? gid : 987,
  }
}

/** Root can hand the file to the slot user. Non-root keeps the control-plane group. */
export function runtimeFileOwner(vm) {
  const slot = slotRuntimeOwner(vm)
  if (typeof process.getuid === 'function' && process.getuid() === 0) return slot
  return { uid: vm?.id ? slot.uid : -1, gid: process.getgid() }
}

/** Best-effort. Non-root tests cannot chown; the write must still publish. */
export function chownSlotRuntimeFile(filePath, vm) {
  if (!filePath || !vm?.id) return false
  const { uid, gid } = runtimeFileOwner(vm)
  try {
    const st = fs.statSync(filePath)
    if (st.uid === uid && st.gid === gid) return false
    fs.chownSync(filePath, uid, gid)
    return true
  } catch {
    return false
  }
}

/**
 * Temp + rename drops the previous inode. chown the temp first so the
 * published file is already readable by the slot. Root uses the slot
 * uid:gid; non-root keeps the control-plane gid for --group-add.
 */
export function replaceSlotOwnedFile(filePath, body, vm) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const { uid, gid } = runtimeFileOwner(vm)
  try {
    fs.writeFileSync(tempPath, body, { mode: 0o600 })
    try {
      fs.chownSync(tempPath, uid, gid)
    } catch {}
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true })
    } catch {}
    throw error
  }
}

export function slotUidGidFromHomeDir(homeDir) {
  const id = String(homeDir || '')
    .replace(/\\/g, '/')
    .match(/\/([^/]+)\/cli-home\/?$/i)?.[1]
  if (!id) return null
  return slotRuntimeOwner({ id })
}

export function ensureSlotClaudeOwnership(homeDir, uid = null, gid = null) {
  if (!homeDir) return
  let u = uid
  let g = gid
  if (u == null || g == null) {
    const parsed = slotUidGidFromHomeDir(homeDir)
    if (!parsed) return
    u = parsed.uid
    g = parsed.gid
  }
  const user = Number(u)
  const group = Number(g)
  if (!Number.isFinite(user) || !Number.isFinite(group)) return
  const claudeDir = path.join(homeDir, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 })
  for (const p of [homeDir, claudeDir, ...SLOT_CLAUDE_FILES.map((name) => path.join(claudeDir, name))]) {
    try {
      if (fs.existsSync(p)) fs.chownSync(p, user, group)
    } catch {}
  }
}
function chownSlotCredentialFile(homeDir, file) {
  ensureSlotClaudeOwnership(homeDir)
  if (!file) return
  const parsed = slotUidGidFromHomeDir(homeDir)
  if (!parsed) return
  try {
    fs.chownSync(file, parsed.uid, parsed.gid)
  } catch {}
}

function sealSlotCredentialFile(file) {
  if (!file) return
  // Slot Claude must not rewrite the shared RT; that drops kinGeneration.
  try {
    fs.chmodSync(file, 0o444)
  } catch {}
}

/** Write slot credentials.json for imports and worker-owned credential updates. */

export function writeWorkerCredentialFile(homeDir, cred) {
  const file = slotWorkerCredentialPath(homeDir)
  if (!file) return null
  const mode = credentialModeFromOauth(cred)
  const authScheme = resolveAuthScheme({ mode, auth_scheme: cred.auth_scheme || cred.authScheme })
  if (mode === 'apikey') {
    const apiKey = String(cred.api_key || cred.apiKey || cred.access_token || cred.accessToken || '').trim()
    if (!apiKey) return null
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    ensureSlotClaudeOwnership(homeDir)
    try {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600)
    } catch {}
    atomicWriteJson(
      file,
      {
        type: 'apikey',
        authScheme,
        anthropicApiKey: {
          apiKey,
          baseUrl: cred.base_url || cred.baseUrl || 'https://api.anthropic.com',
        },
      },
      { mode: 0o600 },
    )
    chownSlotCredentialFile(homeDir, file)
    sealSlotCredentialFile(file)
    ensureOfficialCredentialLink(homeDir)
    return file
  }
  const n = normalizeOauth(cred)
  if (!n.access_token && !n.refresh_token) return null
  let scopes = Array.isArray(cred.scopes)
    ? cred.scopes.filter(Boolean)
    : String(n.scope || cred.scope || '')
        .split(/\s+/)
        .filter(Boolean)
  if (isOfficialSetupTokenMode(mode)) {
    scopes = ['user:inference']
  } else if (isSetupTokenMode(mode)) {
    scopes = scopes.map((s) => (s === 'inference' ? 'user:inference' : s))
    if (!scopes.includes('user:inference')) scopes = ['user:inference']
  }
  const expiresAtMs = expiresAtToMs(n.expires_at) || null
  let previousType = null
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'))
    previousType = normalizeSubscriptionType(prev?.claudeAiOauth?.subscriptionType)
  } catch {}
  const subscriptionType =
    normalizeSubscriptionType(cred.subscription_type || cred.subscriptionType) ||
    normalizeSubscriptionType(cred.account_tier) ||
    previousType
  const oauth = {
    accessToken: n.access_token || '',
  }
  if (n.refresh_token && !isOfficialSetupTokenMode(mode)) oauth.refreshToken = n.refresh_token
  if (expiresAtMs) oauth.expiresAt = expiresAtMs
  if (n.email) oauth.email = n.email
  if (n.account_uuid) oauth.accountUuid = n.account_uuid
  if (n.org_uuid) oauth.orgUuid = n.org_uuid
  if (scopes.length) oauth.scopes = scopes
  if (isAnySetupTokenMode(mode)) oauth.type = mode

  if (subscriptionType) oauth.subscriptionType = subscriptionType
  const generation = Number(n._token_version || cred.kinGeneration || cred.kin_generation) || Date.now()
  oauth.kinGeneration = generation
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  ensureSlotClaudeOwnership(homeDir)
  try {
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600)
  } catch {}
  atomicWriteJson(file, { type: mode, authScheme, kinGeneration: generation, claudeAiOauth: oauth }, { mode: 0o600 })
  chownSlotCredentialFile(homeDir, file)
  sealSlotCredentialFile(file)
  ensureOfficialCredentialLink(homeDir)
  return file
}

/**
 * Old slot files predate subscriptionType. Fill from the identified plan,
 * otherwise pro; repair the legacy pro fallback for an identified Max slot.
 */
export function ensureSlotSubscriptionType(homeDir, accountTier = null) {
  const file = slotWorkerCredentialPath(homeDir)
  if (!file || !fs.existsSync(file)) return { wrote: false, reason: 'missing' }
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { wrote: false, reason: 'unreadable' }
  }
  const oauth = doc?.claudeAiOauth
  if (!oauth || typeof oauth !== 'object') return { wrote: false, reason: 'no_oauth' }
  const present = normalizeSubscriptionType(oauth.subscriptionType)
  const identified = normalizeSubscriptionType(accountTier)
  // Startup summaries used to lose the identified tier and write pro. A pro
  // hint may itself be a default, so it must not downgrade an existing plan.
  if (present && !(present === 'pro' && identified === 'max')) {
    chownSlotCredentialFile(homeDir, file)
    return { wrote: false, reason: 'present' }
  }

  const tier = identified || 'pro'
  oauth.subscriptionType = tier
  try {
    fs.chmodSync(file, 0o600)
  } catch {}
  atomicWriteJson(file, doc, { mode: 0o600 })
  chownSlotCredentialFile(homeDir, file)
  return { wrote: true, subscriptionType: tier }
}

export function persistSlotAuthScheme(projectRoot, vmId, rawScheme) {
  const vmPath = path.join(projectRoot, 'vms', `${vmId}.json`)
  if (!vmPath || !fs.existsSync(vmPath)) return null
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  vm.id = vm.id || vmId
  const scheme = resolveAuthScheme({
    mode: credentialModeFromOauth({ type: vm.claude?.mode, mode: vm.claude?.mode }),
    auth_scheme: rawScheme,
  })
  vm.claude = vm.claude || {}
  vm.claude.auth_scheme = scheme
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(vmPath, vm, { mode: 0o600 })
  const homeDir = path.join(projectRoot, 'vms', vmId, 'cli-home')
  const cred = readWorkerCredentialFile(homeDir)
  if (cred) {
    try {
      writeWorkerCredentialFile(homeDir, { ...cred, auth_scheme: scheme })
    } catch {}
  }
  return vm
}

/** Metadata only — never tokens. Identity/scheduler must use this location. */
export function readSlotCredentialIdentity(homeDir) {
  const cred = readWorkerCredentialFile(homeDir)
  if (!cred) return null
  return {
    account_uuid: cred.account_uuid || null,
    org_uuid: cred.org_uuid || null,
    email: cred.email || null,
    has_access: !!cred.access_token,
    has_refresh: !!cred.refresh_token,
    expires_at: cred.expires_at || null,
    generation: cred._token_version || null,
    source: 'slot-credentials.json',
  }
}

/**
 * After the Go worker rotates tokens, mirror metadata (not secrets) into vm.json.
 */
export function mirrorWorkerCredentialsToVm(vmPath, homeDir, opts = {}) {
  const cred = readWorkerCredentialFile(homeDir)
  if (!cred?.access_token && !cred?.refresh_token) return null
  return persistOauthToVm(vmPath, cred, opts)
}

/**
 * An operator credential import clears 不可调度. A background refresh or
 * worker mirror only lifts a bare no-ticket park: any other verdict
 * waits for an operator action, so a misread grant death cannot silently
 * come back.
 */
export function restoreScheduleAfterLiveCredential(vm, { operatorImport = false } = {}) {
  if (!vm || !hasCredentialPresence(vm.claude)) return vm
  migrateScheduleRecord(vm)
  if (!vm.unschedulable) return vm
  applyClearUnschedulable(vm, { by: operatorImport ? 'credential_import' : 'credential_present' })
  if (vm.unschedulable) return vm
  const status = String(vm.status || '').toLowerCase()
  if (status === 'stopped' || status === 'paused' || status === 'disabled') vm.status = 'running'
  return vm
}

export function persistOauthToVm(vmPath, cred, { acceptLiveGrant = false, operatorImport = false } = {}) {
  if (!vmPath || !fs.existsSync(vmPath)) return null
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  const prev = vm.claude || {}
  const prevRevoked = /oauth_revoked|token has been revoked/i.test(
    String(prev.refresh_error || prev.temp_unschedulable_reason || vm.schedule_disabled_reason || ''),
  )
  const prevExp = expiresAtToMs(prev.expires_at)
  const n = normalizeOauth(cred)
  const nextExp = expiresAtToMs(n.expires_at)
  const rotated =
    !!(nextExp && prevExp && nextExp > prevExp + 2000) ||
    !!(n._token_version && prev._token_version && Number(n._token_version) > Number(prev._token_version))
  const mode = credentialModeFromOauth({ ...cred, mode: cred?.mode || cred?.type || prev.mode })
  vm.claude = stripCredentialSecrets({ ...prev })
  if (n.access_token || cred.has_access || cred.has_api_key || cred.api_key) vm.claude.has_access = true
  if (n.refresh_token || cred.has_refresh) vm.claude.has_refresh = true
  if (n.expires_at) vm.claude.expires_at = n.expires_at
  if (n.email) vm.claude.email = n.email
  if (n.account_uuid) vm.claude.account_uuid = n.account_uuid
  if (n.org_uuid) vm.claude.org_uuid = n.org_uuid
  if (isOfficialSetupTokenMode(mode)) {
    vm.claude.scope = 'user:inference'
  } else if (n.scope) {
    vm.claude.scope = isSetupTokenMode(mode) && n.scope === 'inference' ? 'user:inference' : n.scope
  } else if (isSetupTokenMode(mode)) {
    vm.claude.scope = 'user:inference'
  }
  if (n.source) vm.claude.source = n.source
  vm.claude.mode = mode
  if (mode !== 'apikey' && vm.claude.account_tier !== 'max') {
    vm.claude.account_tier = 'pro'
    vm.claude.account_tier_source = vm.claude.account_tier_source || 'default'
  }
  vm.claude.auth_scheme = resolveAuthScheme({
    mode,
    auth_scheme: cred.auth_scheme || cred.authScheme || prev.auth_scheme,
  })
  if (mode === 'apikey') {
    vm.claude.has_api_key = true
    vm.claude.has_refresh = false
    delete vm.claude.expires_at
    delete vm.claude.scope
  } else if (isOfficialSetupTokenMode(mode) || (isSetupTokenMode(mode) && !n.refresh_token)) {
    delete vm.claude.has_api_key
    vm.claude.has_refresh = false
  } else {
    delete vm.claude.has_api_key
  }
  if (prevRevoked && !rotated && !acceptLiveGrant) {
    vm.claude.refresh_error = prev.refresh_error || 'oauth_revoked'
    vm.updated_at = new Date().toISOString()
    atomicWriteJson(vmPath, vm, { mode: 0o600 })
    return vm
  }
  vm.claude.refresh_error = null
  vm.claude.refreshed_at = new Date().toISOString()
  vm.claude._token_version = n._token_version || Date.now()
  clearClaudeAuthCooldown(vm.claude)
  restoreScheduleAfterLiveCredential(vm, { operatorImport })
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(vmPath, vm, { mode: 0o600 })
  return vm
}

function isQuotaParkReason(reason) {
  return /^(quota_5h|quota_7d)|account_quota_exhausted|^rate_limited$/i.test(String(reason || ''))
}

function clearClaudeAuthCooldown(claude = {}) {
  delete claude.temp_unschedulable_until
  delete claude.temp_unschedulable_reason
  delete claude.oauth_401_generation
  return claude
}

/** Quota / 429 / account cooldown: same temp_unschedulable_* store as auth park. */
export function markVmRestriction(vmPath, { until, reason } = {}) {
  if (!vmPath || !fs.existsSync(vmPath)) return null
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  vm.claude = { ...(vm.claude || {}) }
  const untilMs = Number(until) || 0
  if (untilMs > Date.now()) {
    vm.claude.temp_unschedulable_until = untilMs
    vm.temp_unschedulable_until = untilMs
  }
  const why = reason || 'restricted'
  vm.claude.temp_unschedulable_reason = why
  vm.temp_unschedulable_reason = why
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(vmPath, vm)
  return vm
}

/** Drop quota/429 restriction only. Auth parks stay. */
export function clearVmQuotaRestriction(vmPath) {
  if (!vmPath || !fs.existsSync(vmPath)) return null
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  const reason = vm.claude?.temp_unschedulable_reason || vm.temp_unschedulable_reason
  if (!isQuotaParkReason(reason)) return vm
  vm.claude = { ...(vm.claude || {}) }
  delete vm.claude.temp_unschedulable_until
  delete vm.claude.temp_unschedulable_reason
  delete vm.temp_unschedulable_until
  delete vm.temp_unschedulable_reason
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(vmPath, vm)
  return vm
}

function isRecoverableCooldownReason(reason) {
  const text = String(reason || '')
  if (!text) return true
  if (/oauth_revoked|oauth_invalid_grant|invalid_grant|token has been revoked|credential_refresh_failed/i.test(text)) {
    return false
  }
  return true
}

/** Operator recovery: drop quota, RPM, and provider cooldown. Dead grants stay parked. */
export function clearRecoverableVmCooldown(vmPath) {
  if (!vmPath || !fs.existsSync(vmPath)) return null
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  const reason = vm.claude?.temp_unschedulable_reason || vm.temp_unschedulable_reason
  if (!isRecoverableCooldownReason(reason)) return vm
  vm.claude = { ...(vm.claude || {}) }
  delete vm.claude.temp_unschedulable_until
  delete vm.claude.temp_unschedulable_reason
  delete vm.temp_unschedulable_until
  delete vm.temp_unschedulable_reason
  if (vm.codex?.extra?.codex_limited_until) {
    vm.codex = { ...vm.codex, extra: { ...vm.codex.extra } }
    delete vm.codex.extra.codex_limited_until
  }
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(vmPath, vm)
  return vm
}

/** First messages 401: park the slot without burning the grant. */
export function markVmAuthCooldown(
  vmPath,
  { until, reason = 'authentication_failed_after_refresh', generation = null } = {},
) {
  if (!vmPath || !fs.existsSync(vmPath)) return null
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  vm.claude = stripCredentialSecrets({ ...(vm.claude || {}) })
  const untilMs = Number(until) || 0
  if (untilMs > Date.now()) vm.claude.temp_unschedulable_until = untilMs
  vm.claude.temp_unschedulable_reason = reason || 'authentication_failed_after_refresh'
  if (generation != null && generation !== '') vm.claude.oauth_401_generation = generation
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(vmPath, vm, { mode: 0o600 })
  return vm
}

/** Panel saw a still-fresh worker ticket: drop leftover 401 park only. Never un-revoke. */
export function healLeftoverAuthState(vmPath) {
  if (!vmPath || !fs.existsSync(vmPath)) return null
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  if (!vm.claude) return vm
  const reason = String(
    vm.schedule_disabled_reason || vm.claude.refresh_error || vm.claude.temp_unschedulable_reason || '',
  )
  if (isQuotaParkReason(vm.claude.temp_unschedulable_reason || vm.temp_unschedulable_reason)) return vm
  if (/oauth_revoked|oauth_invalid_grant|token has been revoked/i.test(reason)) return vm
  const had =
    vm.claude.temp_unschedulable_until || vm.claude.temp_unschedulable_reason || vm.claude.oauth_401_generation
  if (!had) return vm
  vm.claude = stripCredentialSecrets({ ...vm.claude })
  clearClaudeAuthCooldown(vm.claude)
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(vmPath, vm, { mode: 0o600 })
  return vm
}

/** Ensure / import / later success: drop the 401 park so the next 401 is first-hit again. */
export function clearVmAuthCooldown(vmPath) {
  if (!vmPath || !fs.existsSync(vmPath)) return null
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  if (!vm.claude) return vm
  if (isQuotaParkReason(vm.claude.temp_unschedulable_reason || vm.temp_unschedulable_reason)) return vm
  const had =
    vm.claude.temp_unschedulable_until || vm.claude.temp_unschedulable_reason || vm.claude.oauth_401_generation
  if (!had) return vm
  vm.claude = stripCredentialSecrets({ ...vm.claude })
  clearClaudeAuthCooldown(vm.claude)
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(vmPath, vm, { mode: 0o600 })
  return vm
}

export function classifyCredentialRefresh(result) {
  if (result?.ok) return result.refreshed ? 'refreshed' : 'already_fresh'
  const code = String(result?.error?.code || result?.error_code || '')
  const message = String(result?.error?.message || result?.message || result?.error || '')
  const status = Number(result?.status) || 0
  const blob = `${code} ${message}`.toLowerCase()
  if (
    /invalid_grant|invalid_refresh_token|refresh_token_missing|refresh token not found|token has been revoked|oauth_revoked|oauth_no_refresh/.test(
      blob,
    )
  ) {
    return 'fatal'
  }
  if (
    status === 429 ||
    status >= 500 ||
    /timeout|transport|network|temporar|worker_unavailable|worker_timeout|worker_socket/.test(blob)
  ) {
    return 'retryable'
  }
  return 'failed'
}

export function refreshErrorCodeOf(result) {
  const code = String(result?.error?.code || result?.error_code || '').trim()
  const message = String(result?.error?.message || result?.message || '')
  const blob = `${code} ${message}`
  if (/invalid_grant/i.test(blob)) return 'invalid_grant'
  if (/invalid_refresh_token/i.test(blob)) return 'invalid_refresh_token'
  if (/refresh_token_missing|refresh token not found/i.test(blob)) return 'refresh_token_missing'
  if (/token has been revoked|oauth_revoked/i.test(blob)) return 'oauth_revoked'
  return code || 'credential_refresh_failed'
}

/** Persist a fatal/failed refresh onto vm.json. Dead tickets leave the pool even if 调度 was manually on. */
export function markVmRefreshError(vmPath, result) {
  if (!vmPath || !fs.existsSync(vmPath)) return null
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  vm.claude = stripCredentialSecrets({ ...(vm.claude || {}) })
  vm.claude.refresh_error = refreshErrorCodeOf(result)
  if (classifyCredentialRefresh(result) === 'fatal') {
    migrateScheduleRecord(vm)
    const code = vm.claude.refresh_error
    applyUnschedulable(vm, code === 'oauth_revoked' ? 'oauth_revoked' : 'oauth_invalid_grant', { refresh_error: code })
    if (String(vm.status || '').toLowerCase() === 'running') vm.status = 'paused'
  }

  vm.updated_at = new Date().toISOString()
  atomicWriteJson(vmPath, vm, { mode: 0o600 })
  return vm
}
