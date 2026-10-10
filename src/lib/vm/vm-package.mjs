/**
 * One finished slot as a portable JSON document.
 * Secrets stay on the returned object; callers must not log the package.
 * Runtime counters, fingerprints, and cluster placement are not part of the
 * document: import mints a new workstation identity and never starts a container.
 */
import fs from 'node:fs'
import path from 'node:path'
import { validTimezone } from '../core/timezone.mjs'
import { normalizeAuthScheme } from '../oauth/auth-scheme.mjs'
import { persistOauthToVm, readWorkerCredentialFile, writeWorkerCredentialFile } from '../oauth/oauth-credentials.mjs'
import { oauthToSub2apiExport, sub2apiAccountToOauth } from '../oauth/sub2api-account.mjs'
import { parseScheduleLevelInput } from '../pool/credential-weight.mjs'
import { parseAllowedModelsPatch } from '../pool/slot-model-gate.mjs'
import { parseVmQuotaOverride } from '../pool/vm-quota-override.mjs'
import { defaultSeedPolicy, standardSeedPolicy } from '../protocol/seed-policy.mjs'
import {
  applyGeneratedFingerprint,
  generateWorkstationFingerprint,
  takenFingerprintKeys,
  writeGuestMachineIdFile,
} from '../identity/workstation-fingerprint.mjs'
import { VM_ORIGIN, canBindProxyToVm, normalizeOwnerId } from '../admin/resource-owner.mjs'
import { readCodexAccounts, writeCodexAccounts } from './codex-slot.mjs'
import { isLocalEgressProxy } from './egress.mjs'
import { OS_CATALOG, STANDARD_LOCALE, nextNumericIndex, padVm, parseVmIndex } from './vm-runtime.mjs'
import { parseSocks5Fields } from './proxy-pool.mjs'
import { seedFreshCliHome } from './vm-recreate.mjs'
import { atomicWriteJson, isValidVmId } from './vm-file.mjs'
import { bindVmProxy, getVm, listVms } from './vm-registry.mjs'
import { isCodexVm, stampVmKind } from './vm-kind.mjs'
import { normalizeVmConfig, resolveMachineSpec } from './machine-spec.mjs'
import {
  SESSION_SLOT_MAX,
  SESSION_SLOT_MIN,
  normalizeKernelDataplane,
  normalizeSlotPersonaPreset,
  parseKernelDataplanePatch,
} from './slot-engine.mjs'
export const VM_PACKAGE_TYPE = 'vm2api-vm-package'
export const VM_PACKAGE_VERSION = 1

const DEFAULT_KERNEL = 'ubuntu-24.04'

function fail(code, message) {
  return { ok: false, error: { code, message } }
}

function has(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key)
}

function cleanText(value, max) {
  return String(value ?? '')
    .trim()
    .slice(0, max)
}

function integer(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function operatorSchedulable(vm) {
  return !(vm?.schedule_manual === true && vm?.schedulable === false)
}

function engineOf(value) {
  if (value == null || value === '') return ''
  const raw = String(value).trim().toLowerCase()
  if (raw === 'inherit' || raw === 'global' || raw === 'default' || raw === 'auto') return ''
  if (raw === 'rust' || raw === 'kernel' || raw === 'kin-kernel') return 'rust'
  if (raw === 'go' || raw === 'worker' || raw === 'go-worker') return 'go'
  return null
}

function personaOf(value) {
  if (value == null || value === '') return ''
  const raw = String(value).trim().toLowerCase()
  if (raw === 'inherit' || raw === 'global' || raw === 'default') return ''
  const parsed = normalizeSlotPersonaPreset(value, { inherit: false })
  return parsed || null
}

function policyFromVm(vm, codex) {
  const policy = vm?.policy && typeof vm.policy === 'object' ? vm.policy : {}
  const out = {
    weight: integer(policy.weight, 1, 100) ? policy.weight : 1,
  }
  if (integer(policy.maxConcurrency, codex ? 1 : 0, 256)) {
    out.maxConcurrency = policy.maxConcurrency
    out.concurrencyOverride = policy.concurrencyOverride === true
  }
  if (integer(policy.maxRpm, 0, 1_000_000)) {
    out.maxRpm = policy.maxRpm
    out.rpmOverride = policy.rpmOverride === true
  }
  if (codex && integer(policy.maxSessions, 0, 256)) {
    out.maxSessions = policy.maxSessions
    out.sessionsOverride = policy.sessionsOverride === true
  }
  if (!codex && integer(policy.sessionSlots, SESSION_SLOT_MIN, SESSION_SLOT_MAX)) {
    out.sessionSlots = policy.sessionSlots
    out.sessionSlotsOverride = policy.sessionSlotsOverride === true
  }
  if (policy.priority != null) out.priority = policy.priority
  if (policy.quota && typeof policy.quota === 'object') out.quota = policy.quota
  if (Array.isArray(policy.allowed_models)) out.allowed_models = policy.allowed_models
  return out
}

function proxyDocument(proxy, label) {
  if (!proxy || typeof proxy !== 'object') return null
  if (isLocalEgressProxy(proxy)) return { kind: 'local' }
  const host = cleanText(proxy.host, 253)
  const port = Number(proxy.port)
  if (!host || !Number.isInteger(port)) return null
  const username = proxy.username == null || proxy.username === '' ? null : String(proxy.username)
  const password = username == null || proxy.password == null ? null : String(proxy.password)
  return {
    kind: 'socks5',
    host,
    port,
    username,
    password,
    label: cleanText(label || proxy.label, 80) || null,
  }
}

function codexAccount(row) {
  if (!row || typeof row !== 'object') return null
  const access = String(row.access_token || '').trim()
  const refresh = String(row.refresh_token || '').trim()
  if (!access && !refresh) return null
  return {
    id: cleanText(row.id || row.email || row.chatgpt_account_id || 'codex', 120) || 'codex',
    access_token: access,
    refresh_token: refresh,
    id_token: String(row.id_token || ''),
    expires_at: Number(row.expires_at) || 0,
    chatgpt_account_id: cleanText(row.chatgpt_account_id, 80),
    email: cleanText(row.email, 120) || null,
  }
}

export function buildVmPackage({
  vm,
  proxy = null,
  proxyLabel = null,
  claudeCred = null,
  codexAccounts = [],
  now = new Date(),
} = {}) {
  const codex = isCodexVm(vm)
  const kind = stampVmKind({}, vm)
  const doc = {
    type: VM_PACKAGE_TYPE,
    version: VM_PACKAGE_VERSION,
    exported_at: now.toISOString(),
    vm: {
      id: vm.id,
      name: vm.name || vm.id,
      platform: kind.platform,
      family: kind.family,
      kernel: OS_CATALOG[vm.kernel] ? vm.kernel : DEFAULT_KERNEL,
      timezone: vm.timezone || null,
      timezone_source: vm.timezone_source || 'auto',
      locale: vm.locale || STANDARD_LOCALE,
      region: vm.region || null,
      note: vm.note || '',
      persona_preset: personaOf(vm.persona_preset) || '',
      inference_engine: engineOf(vm.inference_engine) || '',
      dataplane: normalizeKernelDataplane(vm.dataplane, { inherit: true }) || '',
      auth_scheme: codex ? '' : normalizeAuthScheme(vm.claude?.auth_scheme || vm.auth_scheme),
      proxy_cli_enabled: vm.proxy_cli_enabled === true,
      schedulable: operatorSchedulable(vm),
      schedule_manual: vm.schedule_manual === true,
      policy: policyFromVm(vm, codex),
      seed_policy: defaultSeedPolicy(vm.seed_policy || {}),
    },
    proxy: proxyDocument(proxy, proxyLabel),
    credential: null,
  }
  if (codex) {
    const accounts = (Array.isArray(codexAccounts) ? codexAccounts : []).map(codexAccount).filter(Boolean)
    if (accounts.length) doc.credential = { platform: 'openai', accounts }
  } else if (claudeCred && (claudeCred.access_token || claudeCred.refresh_token || claudeCred.api_key)) {
    doc.credential = {
      platform: 'anthropic',
      export: oauthToSub2apiExport(vm, claudeCred, { now }),
    }
  }
  return doc
}

function parsePolicy(raw, codex) {
  if (raw == null) return { ok: true, value: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_package', 'vm.policy 必须是对象')
  const value = {}
  if (has(raw, 'maxConcurrency')) {
    if (!integer(raw.maxConcurrency, codex ? 1 : 0, 256)) {
      return fail('invalid_package', 'maxConcurrency 超出范围')
    }
    value.maxConcurrency = raw.maxConcurrency
    value.concurrencyOverride = raw.concurrencyOverride !== false
  } else if (has(raw, 'concurrencyOverride')) {
    if (typeof raw.concurrencyOverride !== 'boolean') return fail('invalid_package', 'concurrencyOverride 必须是布尔')
    value.concurrencyOverride = raw.concurrencyOverride
  }
  if (has(raw, 'maxRpm')) {
    if (!integer(raw.maxRpm, 0, 1_000_000)) return fail('invalid_package', 'maxRpm 超出范围')
    value.maxRpm = raw.maxRpm
    value.rpmOverride = raw.rpmOverride !== false
  } else if (has(raw, 'rpmOverride')) {
    if (typeof raw.rpmOverride !== 'boolean') return fail('invalid_package', 'rpmOverride 必须是布尔')
    value.rpmOverride = raw.rpmOverride
  }
  if (codex && has(raw, 'maxSessions')) {
    if (!integer(raw.maxSessions, 0, 256)) return fail('invalid_package', 'maxSessions 超出范围')
    value.maxSessions = raw.maxSessions
    value.sessionsOverride = raw.sessionsOverride !== false
  }
  if (!codex && has(raw, 'sessionSlots')) {
    if (raw.sessionSlots == null) {
      value.sessionSlots = null
      value.sessionSlotsOverride = false
    } else if (!integer(raw.sessionSlots, SESSION_SLOT_MIN, SESSION_SLOT_MAX)) {
      return fail('invalid_package', 'sessionSlots 超出范围')
    } else {
      value.sessionSlots = raw.sessionSlots
      value.sessionSlotsOverride = raw.sessionSlotsOverride !== false
    }
  }
  if (has(raw, 'weight')) {
    if (!integer(raw.weight, 1, 100)) return fail('invalid_package', 'weight 必须是 1 到 100 的整数')
    value.weight = raw.weight
  }
  if (has(raw, 'priority')) {
    const parsed = parseScheduleLevelInput(raw.priority)
    if (!parsed.ok) return fail('invalid_package', parsed.error || '调度等级无效')
    value.priority = parsed.value
  }
  if (has(raw, 'quota')) {
    const parsed = parseVmQuotaOverride(raw.quota)
    if (!parsed.ok) return fail('invalid_package', parsed.error || '配额覆盖无效')
    value.quota = parsed.value
  }
  if (has(raw, 'allowed_models')) {
    const parsed = parseAllowedModelsPatch(raw.allowed_models, { platform: codex ? 'openai' : 'anthropic' })
    if (!parsed.ok) return fail('invalid_package', parsed.error || '允许模型无效')
    value.allowed_models = parsed.value
  }
  return { ok: true, value }
}

function parseProxy(raw) {
  if (raw == null) return { ok: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_package', 'proxy 必须是对象或 null')
  const kind = cleanText(raw.kind || raw.scheme, 16).toLowerCase()
  if (kind === 'local' || raw.host === 'local') return { ok: true, value: { kind: 'local' } }
  if (raw.password && !cleanText(raw.username ?? raw.user, 200)) {
    return fail('invalid_proxy', 'SOCKS5 不能只有密码没有用户名')
  }
  const parsed = parseSocks5Fields({
    host: raw.host,
    port: raw.port,
    username: raw.username ?? raw.user,
    password: raw.password ?? raw.pass,
  })
  if (!parsed) return fail('invalid_proxy', 'SOCKS5 地址无效')
  return {
    ok: true,
    value: {
      kind: 'socks5',
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password,
      label: cleanText(raw.label, 80) || null,
    },
  }
}

function parseCredential(raw, codex) {
  if (raw == null) return { ok: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_package', 'credential 必须是对象或 null')
  const platform = cleanText(raw.platform, 16).toLowerCase()
  if (codex || platform === 'openai') {
    if (!codex) return fail('credential_kind_mismatch', 'Claude 槽的包不能带 Codex 凭证')
    const rows = Array.isArray(raw.accounts) ? raw.accounts : []
    const accounts = rows.map(codexAccount).filter(Boolean)
    if (!accounts.length) return fail('credential_required', 'Codex 包需要 access_token 或 refresh_token')
    return { ok: true, value: { platform: 'openai', accounts } }
  }
  if (codex) return fail('credential_kind_mismatch', 'Codex 槽的包不能带 Claude 凭证')
  const exportDoc = raw.export && typeof raw.export === 'object' ? raw.export : raw
  let oauth
  try {
    oauth = sub2apiAccountToOauth(exportDoc)
  } catch {
    oauth = null
  }
  if (!oauth?.access_token && !oauth?.refresh_token && !oauth?.api_key) {
    return fail('credential_required', 'Claude 包需要 access_token、refresh_token 或 api_key')
  }
  return { ok: true, value: { platform: 'anthropic', export: exportDoc, oauth } }
}

export function parseVmPackage(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return fail('invalid_package', '包必须是 JSON 对象')
  if (doc.type !== VM_PACKAGE_TYPE || doc.version !== VM_PACKAGE_VERSION) {
    return fail('invalid_package', '不是 vm2api 单槽包')
  }
  const vm = doc.vm && typeof doc.vm === 'object' ? doc.vm : null
  if (!vm) return fail('invalid_package', '缺少 vm')
  const id = String(vm.id || '').replace(/[^a-zA-Z0-9_-]/g, '')
  if (!isValidVmId(id)) return fail('invalid_id', 'vm.id 无效')
  const probe = { platform: vm.platform, family: vm.family }
  const codex = isCodexVm(probe)
  if (vm.kernel != null && vm.kernel !== '' && !OS_CATALOG[vm.kernel]) {
    return fail('invalid_kernel', '未知系统')
  }
  let timezone = null
  if (vm.timezone != null && String(vm.timezone).trim() !== '') {
    timezone = validTimezone(vm.timezone)
    if (!timezone) return fail('invalid_package', '时区无效')
  }
  const source = cleanText(vm.timezone_source, 16)
  if (source && source !== 'auto' && source !== 'manual' && source !== 'proxy_geo') {
    return fail('invalid_package', 'timezone_source 无效')
  }
  const engine = engineOf(vm.inference_engine)
  if (engine == null) return fail('invalid_package', 'inference_engine 无效')
  const persona = personaOf(vm.persona_preset)
  if (persona == null) return fail('invalid_package', 'persona_preset 无效')
  const dataplane = parseKernelDataplanePatch(vm.dataplane)
  if (!dataplane.ok) return fail('invalid_package', dataplane.error || 'dataplane 无效')
  const policy = parsePolicy(vm.policy, codex)
  if (!policy.ok) return policy
  const proxy = parseProxy(doc.proxy)
  if (!proxy.ok) return proxy
  const credential = parseCredential(has(doc, 'credential') ? doc.credential : null, codex)
  if (!credential.ok) return credential
  const auth = normalizeAuthScheme(vm.auth_scheme)
  if (vm.auth_scheme && !auth) return fail('invalid_package', 'auth_scheme 无效')
  return {
    ok: true,
    value: {
      id,
      codex,
      vm: {
        name: cleanText(vm.name, 80),
        platform: codex ? 'openai' : 'anthropic',
        family: codex ? 'codex' : 'claude',
        kernel: OS_CATALOG[vm.kernel] ? vm.kernel : DEFAULT_KERNEL,
        timezone,
        timezone_source: source || (timezone ? 'manual' : 'auto'),
        locale: cleanText(vm.locale, 64) || STANDARD_LOCALE,
        region: cleanText(vm.region, 64) || null,
        note: cleanText(vm.note, 240),
        persona_preset: persona,
        inference_engine: engine,
        dataplane: dataplane.value,
        auth_scheme: auth,
        proxy_cli_enabled: vm.proxy_cli_enabled === true,
        schedulable: vm.schedulable !== false,
        schedule_manual: vm.schedule_manual === true,
        policy: policy.value,
        seed_policy: vm.seed_policy && typeof vm.seed_policy === 'object' ? defaultSeedPolicy(vm.seed_policy) : null,
      },
      proxy: proxy.value,
      credential: credential.value,
    },
  }
}

function applyPolicy(vm, policy, codex) {
  vm.policy = { ...(vm.policy || {}), inflight: vm.policy?.inflight || 0 }
  if (has(policy, 'maxConcurrency')) {
    vm.policy.maxConcurrency = policy.maxConcurrency
    vm.policy.concurrencyOverride = policy.concurrencyOverride === true
  } else if (has(policy, 'concurrencyOverride')) {
    vm.policy.concurrencyOverride = policy.concurrencyOverride
  }
  if (has(policy, 'maxRpm')) {
    vm.policy.maxRpm = policy.maxRpm
    vm.policy.rpmOverride = policy.rpmOverride === true
  } else if (has(policy, 'rpmOverride')) {
    vm.policy.rpmOverride = policy.rpmOverride
  }
  if (codex && has(policy, 'maxSessions')) {
    vm.policy.maxSessions = policy.maxSessions
    vm.policy.sessionsOverride = policy.sessionsOverride === true
  }
  if (!codex && has(policy, 'sessionSlots')) {
    vm.policy.sessionSlots = policy.sessionSlots
    vm.policy.sessionSlotsOverride = policy.sessionSlotsOverride === true
  }
  if (has(policy, 'weight')) vm.policy.weight = policy.weight
  if (has(policy, 'priority')) {
    if (policy.priority == null) delete vm.policy.priority
    else vm.policy.priority = policy.priority
  }
  if (has(policy, 'quota')) {
    if (policy.quota) vm.policy.quota = policy.quota
    else delete vm.policy.quota
  }
  if (has(policy, 'allowed_models')) {
    if (Array.isArray(policy.allowed_models) && policy.allowed_models.length) {
      vm.policy.allowed_models = policy.allowed_models
    } else delete vm.policy.allowed_models
  }
}

function applyTraits(vm, spec) {
  const traits = spec.vm
  stampVmKind(vm, traits)
  if (traits.name) vm.name = traits.name
  vm.kernel = traits.kernel
  if (traits.timezone) {
    vm.timezone = traits.timezone
    vm.timezone_source = traits.timezone_source || 'manual'
    if (vm.fingerprint && typeof vm.fingerprint === 'object') vm.fingerprint.timezone = traits.timezone
  } else if (traits.timezone_source) {
    vm.timezone_source = traits.timezone_source
  }
  if (traits.locale) vm.locale = traits.locale
  vm.region = traits.region
  vm.note = traits.note
  if (traits.persona_preset) vm.persona_preset = traits.persona_preset
  else delete vm.persona_preset
  if (traits.inference_engine) vm.inference_engine = traits.inference_engine
  else delete vm.inference_engine
  if (traits.dataplane) vm.dataplane = traits.dataplane
  else delete vm.dataplane
  if (!spec.codex) {
    vm.claude = vm.claude && typeof vm.claude === 'object' ? vm.claude : {}
    if (traits.auth_scheme) vm.claude.auth_scheme = traits.auth_scheme
  }
  vm.proxy_cli_enabled = traits.proxy_cli_enabled === true
  applyPolicy(vm, traits.policy, spec.codex)
  if (traits.seed_policy) vm.seed_policy = traits.seed_policy
  vm.updated_at = new Date().toISOString()
}

function applySchedule(vm, spec, hasCredential) {
  const operatorOff = spec.vm.schedule_manual === true && spec.vm.schedulable === false
  if (operatorOff) {
    vm.schedule_manual = true
    vm.schedulable = false
    vm.schedule_disabled_reason = 'disabled'
    return
  }
  vm.schedule_manual = spec.vm.schedule_manual === true
  if (!hasCredential) {
    vm.schedulable = false
    vm.schedule_disabled_reason = 'no_credential'
    return
  }
  vm.schedulable = spec.vm.schedulable !== false
  if (vm.schedulable) {
    const reason = String(vm.schedule_disabled_reason || '')
    if (!reason || reason === 'disabled' || reason === 'no_credential') vm.schedule_disabled_reason = null
  } else if (!vm.schedule_disabled_reason) {
    vm.schedule_disabled_reason = 'disabled'
  }
}

function credentialPresent(spec, vm) {
  if (spec.credential) return true
  if (spec.codex) return !!(vm.codex?.has_access || vm.codex?.has_refresh)
  return !!(vm.claude?.has_access || vm.claude?.has_refresh || vm.claude?.has_api_key)
}

function writeCredential(projectRoot, id, spec) {
  if (!spec.credential) return { ok: true }
  if (spec.codex) {
    const saved = spec.credential.accounts
    writeCodexAccounts(projectRoot, id, saved)
    return { ok: true, account: saved[0] }
  }
  const home = path.join(projectRoot, 'vms', id, 'cli-home')
  const oauth = spec.credential.oauth
  const file = writeWorkerCredentialFile(home, oauth)
  if (!file) return fail('credential_required', 'Claude 包需要 access_token、refresh_token 或 api_key')
  persistOauthToVm(path.join(projectRoot, 'vms', `${id}.json`), oauth, { acceptLiveGrant: true })
  return { ok: true }
}

function mirrorCodex(vm, account) {
  if (!account) return
  vm.codex = {
    ...(vm.codex && typeof vm.codex === 'object' ? vm.codex : {}),
    has_access: !!account.access_token,
    has_refresh: !!account.refresh_token,
    chatgpt_account_id: account.chatgpt_account_id || null,
    email: account.email || null,
    expires_at: account.expires_at || null,
  }
}

/**
 * Same ownership rule as the panel bind routes: a tenant binds only its own
 * SOCKS rows, never px-local or a platform/other-tenant row with equal credentials.
 * Runs before any file is written so a refused package leaves nothing behind.
 */
function proxyBindAllowed(spec, vm, role, proxyPool) {
  if (!spec.proxy) return true
  let owner = null
  if (spec.proxy.kind === 'local') {
    if (role === 'user') return false
  } else {
    const found = proxyPool.findSocks?.(spec.proxy)
    owner = found ? found.owner_user_id : vm.owner_user_id || null
  }
  return canBindProxyToVm({ owner_user_id: owner }, vm, { role })
}

async function attachProxy(projectRoot, id, spec, proxyPool, ownerUserId) {
  if (!spec.proxy) {
    proxyPool.unbindVm?.(id)
    bindVmProxy(projectRoot, id, null)
    return { ok: true }
  }
  if (spec.proxy.kind === 'local') {
    const ensured = proxyPool.ensureLocal()
    const proxyId = ensured?.proxy?.id
    if (!proxyId) return fail('proxy_import_failed', '本机直连出口不可用')
    const bound = proxyPool.bind(proxyId, id)
    if (!bound.ok) return fail(bound.error || 'proxy_bind_failed', '绑定直连出口失败')
    bindVmProxy(projectRoot, id, proxyPool.getProxyByIdWithAuth(proxyId))
    return { ok: true }
  }
  const ensured = proxyPool.ensureSocks(spec.proxy, { ownerUserId, label: spec.proxy.label })
  if (!ensured.ok) return fail(ensured.error || 'invalid_proxy', 'SOCKS5 无法写入')
  const bound = proxyPool.bind(ensured.proxy.id, id)
  if (!bound.ok) {
    const message = bound.error === 'proxy_bind_limit' ? 'SOCKS5 绑定数量已满' : '绑定 SOCKS5 失败'
    return fail(bound.error || 'proxy_bind_failed', message)
  }
  bindVmProxy(projectRoot, id, proxyPool.getProxyByIdWithAuth(ensured.proxy.id))
  return { ok: true }
}

function finishControl(projectRoot, id, spec, status) {
  const file = path.join(projectRoot, 'vms', `${id}.json`)
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  applyTraits(vm, spec)
  applySchedule(vm, spec, credentialPresent(spec, vm))
  vm.status = status
  if (spec.vm.proxy_cli_enabled !== true) vm.proxy_cli_enabled = false
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  return vm
}

export function exportVmPackage(projectRoot, id, proxyPool, now = new Date()) {
  const vm = getVm(projectRoot, id)
  if (!vm) return fail('vm_not_found', 'VM not found')
  const proxyId = vm.proxy?.id || null
  const proxy = proxyId && proxyPool?.getProxyByIdWithAuth ? proxyPool.getProxyByIdWithAuth(proxyId) : null
  const label = proxyId && proxyPool?.labelOf ? proxyPool.labelOf(proxyId) : null
  const home = path.join(projectRoot, 'vms', id, 'cli-home')
  return {
    ok: true,
    package: buildVmPackage({
      vm,
      proxy: proxy || vm.proxy,
      proxyLabel: label,
      claudeCred: isCodexVm(vm) ? null : readWorkerCredentialFile(home),
      codexAccounts: isCodexVm(vm) ? readCodexAccounts(projectRoot, id) : [],
      now,
    }),
  }
}

export async function commitVmPackage({
  projectRoot,
  parsed,
  mode,
  targetId = null,
  owner = { role: 'admin', userId: null },
  proxyPool,
  occupied = [],
}) {
  if (!parsed?.ok)
    return { ok: false, status: 400, error: parsed?.error || { code: 'invalid_package', message: '包无效' } }
  const spec = parsed.value
  // Tenants cannot read or write seed-settings; a package must not smuggle them in either.
  if (owner.role === 'user') spec.vm.seed_policy = null
  const create = mode === 'create'
  let id = create ? spec.id : targetId
  let renamedFrom = null
  if (!isValidVmId(id)) return { ok: false, status: 400, error: { code: 'invalid_id', message: 'vm.id 无效' } }
  if (create && fs.existsSync(path.join(projectRoot, 'vms', `${id}.json`))) {
    renamedFrom = id
    id = nextFreePackageVmId(projectRoot, occupied)
    const oldLabel = slotLabel(renamedFrom)
    if (!spec.vm.name || spec.vm.name === oldLabel || spec.vm.name === renamedFrom) spec.vm.name = slotLabel(id)
  }
  const file = path.join(projectRoot, 'vms', `${id}.json`)
  if (!create && !fs.existsSync(file)) {
    return { ok: false, status: 404, error: { code: 'vm_not_found', message: 'VM not found' } }
  }

  let status = 'stopped'
  let vm
  if (create) {
    const existing = listVms(projectRoot)
    const generated = generateWorkstationFingerprint(
      { id, kernel: spec.vm.kernel, timezone: spec.vm.timezone, locale: spec.vm.locale },
      { taken: takenFingerprintKeys(existing) },
    )
    vm = {
      id,
      name: spec.vm.name || id,
      status: 'stopped',
      kernel: spec.vm.kernel,
      timezone: generated.timezone,
      timezone_source: spec.vm.timezone ? 'manual' : 'auto',
      locale: generated.locale || STANDARD_LOCALE,
      region: null,
      note: '',
      proxy: null,
      policy: { maxConcurrency: 0, concurrencyOverride: false, maxRpm: 0, rpmOverride: false, weight: 1, inflight: 0 },
      fingerprint: applyGeneratedFingerprint({}, generated),
      stats: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      schedulable: false,
      schedule_disabled_reason: 'no_credential',
      proxy_cli_enabled: false,
      proxy_required: false,
      seed_policy: standardSeedPolicy(),
      runtime: { type: 'docker' },
      machine: resolveMachineSpec({ config: normalizeVmConfig(), runtime: 'docker' }),
      owner_user_id: owner.role === 'user' ? normalizeOwnerId(owner.userId) : null,
      origin: owner.role === 'user' ? VM_ORIGIN.userCreated : VM_ORIGIN.platform,
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
  } else {
    vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (vm.node_id) {
      return {
        ok: false,
        status: 409,
        error: { code: 'remote_unsupported', message: '集群节点上的虚拟机不能用包写回' },
      }
    }
    if (isCodexVm(vm) !== spec.codex) {
      return {
        ok: false,
        status: 409,
        error: { code: 'credential_kind_mismatch', message: '不能把包写到不同平台的槽' },
      }
    }
    status = vm.status || 'stopped'
  }
  if (!proxyBindAllowed(spec, vm, owner.role, proxyPool)) {
    return { ok: false, status: 403, error: { code: 'proxy_forbidden', message: '无权绑定这个出口' } }
  }
  applyTraits(vm, spec)
  applySchedule(vm, spec, false)
  atomicWriteJson(file, vm, { mode: 0o600 })
  if (create) {
    try {
      writeGuestMachineIdFile(projectRoot, id, vm.fingerprint?.guest_machine_id)
    } catch {}
    try {
      seedFreshCliHome(projectRoot, vm)
    } catch {}
  }

  const written = writeCredential(projectRoot, id, spec)
  if (!written.ok) return { ok: false, status: 400, error: written.error }
  let saved = finishControl(projectRoot, id, spec, status)
  if (written.account) {
    mirrorCodex(saved, written.account)
    saved.updated_at = new Date().toISOString()
    atomicWriteJson(file, saved, { mode: 0o600 })
  }
  const attached = await attachProxy(projectRoot, id, spec, proxyPool, saved.owner_user_id || null)
  if (!attached.ok) return { ok: false, status: 400, error: attached.error }
  saved = finishControl(projectRoot, id, spec, status)
  if (written.account) mirrorCodex(saved, written.account)
  if (spec.proxy && spec.vm.proxy_cli_enabled === true) saved.proxy_cli_enabled = true
  saved.updated_at = new Date().toISOString()
  atomicWriteJson(file, saved, { mode: 0o600 })
  return { ok: true, status: create ? 201 : 200, vm: saved, renamed_from: renamedFrom }
}

function slotLabel(id) {
  const n = parseVmIndex(id)
  return n ? padVm(n) : String(id || '')
}

function nextFreePackageVmId(projectRoot, extra = []) {
  const existing = listVms(projectRoot)
  let n = nextNumericIndex([...(existing || []), ...(extra || [])])
  for (;;) {
    const id = `vm-${padVm(n)}`
    if (isValidVmId(id) && !fs.existsSync(path.join(projectRoot, 'vms', `${id}.json`))) return id
    n += 1
  }
}
