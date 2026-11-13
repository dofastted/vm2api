/**
 * Claude native limit-reset credits.
 * Query and redeem go through the slot worker so egress stays on the VM.
 * Grant and organization IDs never leave this module.
 * Mirrors sub2api ClaudeResetCreditService, including the org fence:
 * an unconfirmed claim blocks another redemption until it settles.
 * Each held grant is exposed as an opaque card ref so the operator can pick
 * which reset to spend (e.g. a Fable reset vs a full reset); without a ref the
 * server's next grant is used, as before.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { runSlotOauth } from '../transport/slot-oauth.mjs'
import { credentialModeOfVm, isApiKeyMode } from './credential-mode.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { getVm } from '../vm/vm-registry.mjs'
import { atomicWriteJson, withVmLock } from '../vm/vm-file.mjs'

export const CLAUDE_RESET_USAGE_PATH = '/api/oauth/usage?cedar_ember=1&skip_spend=1'
export const CLAUDE_RESET_REDEEM_PATH = '/api/organizations/%s/reset_rate_limits'

const GRANT_ID = /^[a-z0-9_-]{1,40}$/
const CARD_REF = /^[a-f0-9]{24}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NIL_UUID = '00000000-0000-0000-0000-000000000000'
const KNOWN_WINDOWS = new Set(['five_hour', 'seven_day', 'seven_day_overage_included'])
// Every window the official client recognises; only used to classify a grant.
const CLAIM_WINDOWS = new Set([
  ...KNOWN_WINDOWS,
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_cowork',
  'seven_day_omelette',
  'seven_day_oauth_apps',
])
const GRANT_TYPES = new Set(['session', 'weekly', 'full'])
const CARD_KINDS = new Set(['session', 'weekly', 'fable', 'full'])
const KNOWN_REASONS = new Set([
  'no_grant',
  'unknown_grant',
  'not_next_grant',
  'grant_id_required',
  'tenure',
  'other_experiment',
  'stamp_indeterminate',
  'reset_unconfirmed',
  'authorization_rejected',
  'claim_unconfirmed',
  'upstream_unavailable',
  'result_persistence_failed',
])

const LEASE_TTL_MS = 90_000
const UNKNOWN_FENCE_MS = 24 * 60 * 60 * 1000
const UNAVAILABLE_FENCE_MS = 15 * 60 * 1000
const CALL_TIMEOUT_MS = 25_000

const leases = new Map()
const fileLocks = new Map()

export function resetClaudeResetLeasesForTest() {
  leases.clear()
}

export function claudeResetOperationId(vmId, idempotencyKey) {
  return sha256(`claude-reset:${vmId}:${idempotencyKey}`)
}

export function claudeResetOrgId(orgUuid) {
  return sha256(`claude-org:${orgUuid}`)
}

/** Stable, opaque per-slot handle for one grant; the grant id itself never leaves this module. */
export function claudeResetCardRef(vmId, grantId) {
  return sha256(`claude-grant:${vmId}:${grantId}`).slice(0, 24)
}

/**
 * session | weekly | fable | full, as the official client names a grant. A grant that
 * refills the Fable window but not the weekly one is a Fable reset even when upstream
 * omits gives_back_weekly, so it is never shown as a full reset.
 */
export function claudeResetGrantKind(grant) {
  if (grant?.gives_back_weekly === true) return 'fable'
  const clears = Array.isArray(grant?.clears) ? grant.clears.filter((item) => CLAIM_WINDOWS.has(item)) : []
  if (clears.includes('seven_day_overage_included') && !clears.includes('seven_day')) return 'fable'
  if (GRANT_TYPES.has(grant?.type)) return grant.type
  const session = clears.includes('five_hour')
  const other = clears.some((item) => item !== 'five_hour')
  return session && !other ? 'session' : other && !session ? 'weekly' : 'full'
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function fail(code, message, status = 400, extra = {}) {
  return { ok: false, error: code, message, status, ...extra }
}

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.000Z$/, 'Z')
}

function timeOf(value) {
  if (value == null || value === '') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function knownWindows(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => KNOWN_WINDOWS.has(item))
}

function percentUsed(value) {
  const out = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, raw] of Object.entries(value)) {
    if (!KNOWN_WINDOWS.has(key)) continue
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0 && n <= 100) out[key] = n
  }
  return out
}

function publicLabel(grant, grantIds) {
  const label = String(grant?.label || '')
  if (!label || grantIds.has(label)) return ''
  return label
}

function requiresLimit(grant) {
  return grant?.use_requires_limit == null || grant.use_requires_limit === true
}

function held(grant, now) {
  if (!grant || typeof grant !== 'object') return false
  if (!GRANT_ID.test(String(grant.id || ''))) return false
  if (!Array.isArray(grant.clears)) return false
  if (grant.clears.length === 0 && grant.gives_back_weekly !== true) return false
  const left = grant.resets_left
  if (typeof left !== 'number' || !Number.isInteger(left) || left <= 0) return false
  if (grant.paused === true) return false
  const starts = timeOf(grant.starts_at)
  if (Number.isNaN(starts) || (starts != null && now < starts)) return false
  const ends = timeOf(grant.ends_at)
  if (Number.isNaN(ends) || (ends != null && !(now < ends))) return false
  return true
}

export function claudeResetGrantRedeemable(block, grant, now = Date.now()) {
  if (!block || !held(grant, now)) return false
  const cooldown = timeOf(block.cooldown_until)
  if (Number.isNaN(cooldown)) return false
  return (
    block.eligible === true &&
    grant.usable_now === true &&
    (!requiresLimit(grant) || block.at_limit === true) &&
    (!Array.isArray(grant.blocking) || grant.blocking.length === 0) &&
    (cooldown == null || !(now < cooldown))
  )
}

function cardState(block, grant, now, cooling) {
  if (claudeResetGrantRedeemable(block, grant, now)) return 'ready'
  // A reset just spent puts the account in a short cooldown; the other cards are still held.
  const blocked = Array.isArray(grant.blocking) && grant.blocking.length > 0
  if (cooling && block.eligible === true && !blocked) return 'cooldown'
  return 'unavailable'
}

function byExpiry(a, b) {
  const left = a.expires_at ? Date.parse(a.expires_at) : Number.POSITIVE_INFINITY
  const right = b.expires_at ? Date.parse(b.expires_at) : Number.POSITIVE_INFINITY
  return left - right
}

export function projectClaudeResetCredits(block, now = Date.now(), vmId = '') {
  const credits = []
  const out = {
    eligible: false,
    available_count: 0,
    held_count: 0,
    credits,
    fetched_at: iso(now),
  }
  if (!block) return out
  out.eligible = block.eligible === true
  const cooldown = timeOf(block.cooldown_until)
  const cooling = cooldown != null && !Number.isNaN(cooldown) && now < cooldown
  if (cooling) out.cooldown_until = iso(cooldown)
  const weekly = timeOf(block.weekly_resets_at)
  if (weekly != null && !Number.isNaN(weekly)) out.weekly_resets_at = iso(weekly)
  const grantIds = new Set((Array.isArray(block.grants) ? block.grants : []).map((grant) => grant?.id))
  let available = 0
  let shown = 0
  for (const grant of Array.isArray(block.grants) ? block.grants : []) {
    if (!held(grant, now)) continue
    const state = cardState(block, grant, now, cooling)
    const redeemable = state === 'ready'
    const credit = {
      ...(vmId ? { ref: claudeResetCardRef(vmId, grant.id) } : {}),
      kind: claudeResetGrantKind(grant),
      state,
      gives_back_weekly: grant.gives_back_weekly === true,
      label: publicLabel(grant, grantIds),
      resets_left: grant.resets_left,
      clears: knownWindows(grant.clears),
      percent_used: percentUsed(grant.percent_used),
      blocking: knownWindows(grant.blocking),
      use_requires_limit: requiresLimit(grant),
      redeemable,
    }
    const starts = timeOf(grant.starts_at)
    const ends = timeOf(grant.ends_at)
    if (starts != null && !Number.isNaN(starts)) credit.starts_at = iso(starts)
    if (ends != null && !Number.isNaN(ends)) credit.expires_at = iso(ends)
    credits.push(credit)
    if (redeemable) available += grant.resets_left
    if (state !== 'unavailable') shown += grant.resets_left
  }
  credits.sort(byExpiry)
  out.available_count = available
  out.held_count = shown
  return out
}

function invalidTime(value) {
  return value != null && value !== '' && Number.isNaN(timeOf(value))
}

export function parseClaudeResetStatus(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid' }
  if (Object.prototype.hasOwnProperty.call(body, 'error')) return { error: 'invalid' }
  if (!Object.prototype.hasOwnProperty.call(body, 'cedar_ember') || body.cedar_ember == null) return { block: null }
  const block = body.cedar_ember
  if (!block || typeof block !== 'object' || Array.isArray(block) || !Array.isArray(block.grants))
    return { error: 'invalid' }
  if (invalidTime(block.cooldown_until) || invalidTime(block.weekly_resets_at)) return { error: 'invalid' }
  for (const grant of block.grants) {
    if (!grant || typeof grant !== 'object') return { error: 'invalid' }
    if (invalidTime(grant.starts_at) || invalidTime(grant.ends_at)) return { error: 'invalid' }
    if (grant.resets_left != null && (typeof grant.resets_left !== 'number' || !Number.isInteger(grant.resets_left))) {
      return { error: 'invalid' }
    }
  }
  return { block }
}

function scopeText(vm) {
  const claude = vm?.claude || {}
  if (Array.isArray(claude.scopes) && claude.scopes.length) return claude.scopes.join(' ')
  return String(claude.scope || '')
}

function loadAccount(projectRoot, vmId) {
  const vm = getVm(projectRoot, vmId)
  if (!vm) return fail('vm_not_found', 'VM not found', 404)
  if (isCodexVm(vm) || isApiKeyMode(credentialModeOfVm(vm))) {
    return fail('CLAUDE_RESET_OAUTH_REQUIRED', '只有 Claude 完整 OAuth 槽可以兑换原生限额重置', 400)
  }
  const scopes = scopeText(vm).split(/\s+/).filter(Boolean)
  if (!scopes.includes('user:profile')) {
    return fail('CLAUDE_RESET_PROFILE_SCOPE_REQUIRED', '当前凭证缺少 user:profile，无法查询原生限额重置', 400)
  }
  return {
    ok: true,
    vm,
    exec: {
      vmId: vm.id,
      homeDir: path.join(projectRoot, 'vms', vm.id, 'cli-home'),
      vm,
    },
  }
}

function normalizeKey(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value == null) return { error: fail('IDEMPOTENCY_KEY_REQUIRED', '缺少 Idempotency-Key', 400) }
  const key = String(value)
  if (!key.trim()) return { error: fail('IDEMPOTENCY_KEY_REQUIRED', '缺少 Idempotency-Key', 400) }
  const trimmed = key.trim()
  if (trimmed.length > 128 || [...trimmed].some((ch) => ch.charCodeAt(0) < 33 || ch.charCodeAt(0) > 126)) {
    return { error: fail('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key 无效', 400) }
  }
  return { key: trimmed }
}

function statePath(projectRoot) {
  return path.join(projectRoot, 'data', 'claude-reset-state.json')
}

function withFileLock(key, fn) {
  const prev = fileLocks.get(key) || Promise.resolve()
  const run = prev.then(fn, fn)
  fileLocks.set(
    key,
    run.then(
      () => {},
      () => {},
    ),
  )
  return run
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { operations: {}, fences: {} }
    return {
      operations: parsed.operations && typeof parsed.operations === 'object' ? parsed.operations : {},
      fences: parsed.fences && typeof parsed.fences === 'object' ? parsed.fences : {},
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { operations: {}, fences: {} }
    return null
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  atomicWriteJson(file, state, { mode: 0o600 })
}

async function mutateState(projectRoot, fn) {
  const file = statePath(projectRoot)
  return withFileLock(file, async () => {
    const state = readState(file)
    if (!state) return fail('CLAUDE_RESET_STORE_UNAVAILABLE', '重置状态无法读取', 503)
    const result = await fn(state)
    if (result?.write) {
      try {
        writeState(file, state)
      } catch {
        return fail('CLAUDE_RESET_STORE_UNAVAILABLE', '重置状态无法保存', 503)
      }
    }
    return result?.value
  })
}

function tryAcquire(key, owner, now) {
  const current = leases.get(key)
  if (current && current.until > now && current.owner !== owner) return false
  leases.set(key, { owner, until: now + LEASE_TTL_MS })
  return true
}

function releaseLease(key, owner) {
  const current = leases.get(key)
  if (current?.owner === owner) leases.delete(key)
}

async function withAccountLease(vmId, now, fn) {
  const key = `account:${vmId}`
  const owner = crypto.randomUUID()
  if (!tryAcquire(key, owner, now)) return fail('CLAUDE_RESET_BUSY', '已有一次重置正在进行', 409)
  try {
    return await fn()
  } finally {
    releaseLease(key, owner)
  }
}

function defaultTransport(exec, op, opts = {}) {
  return runSlotOauth(exec, op, opts)
}

function workerProblem(res) {
  const code = res?.body?.error?.code || ''
  const message = String(res?.body?.error?.message || '')
  if (code === 'credential_required' || code === 'oauth_refresh_failed' || code === 'refresh_failed') {
    return fail('CLAUDE_RESET_TOKEN_UNAVAILABLE', 'OAuth 凭证不可用', 503)
  }
  if (code === 'worker_op_invalid' || /unknown oauth operation/i.test(message)) {
    return fail('CLAUDE_RESET_WORKER_UNSUPPORTED', '槽内 worker 不支持限额重置，需要更新 worker', 503)
  }
  if (code === 'proxy_required') return fail('CLAUDE_RESET_PROXY_UNAVAILABLE', '槽出口不可用', 503)
  return null
}

async function callWorker(transport, exec, op, opts) {
  try {
    return await transport(exec, op, { timeoutMs: CALL_TIMEOUT_MS, ...opts })
  } catch {
    return { ok: false, status: 0, transportError: true, body: null }
  }
}

async function fetchBlock(transport, exec) {
  const res = await callWorker(transport, exec, 'reset-status')
  const mapped = workerProblem(res)
  if (mapped) return mapped
  if (res?.transportError || !res?.status) return fail('CLAUDE_RESET_QUERY_FAILED', '限额重置状态查询失败', 502)
  if (res.status !== 200) return fail('CLAUDE_RESET_QUERY_FAILED', `限额重置状态上游 HTTP ${res.status}`, 502)
  const parsed = parseClaudeResetStatus(res.body)
  if (parsed.error) return fail('CLAUDE_RESET_STATUS_INVALID', '限额重置状态无效', 502)
  return { ok: true, block: parsed.block }
}

function canonicalUuid(value) {
  const text = String(value || '')
    .trim()
    .toLowerCase()
  if (!UUID_RE.test(text) || text === NIL_UUID) return ''
  return text
}

async function fetchOrg(transport, exec) {
  const res = await callWorker(transport, exec, 'profile')
  const mapped = workerProblem(res)
  if (mapped) return mapped
  if (res?.transportError || res?.status !== 200)
    return fail('CLAUDE_RESET_PROFILE_FAILED', 'OAuth 组织信息不可用', 502)
  const org = canonicalUuid(res.body?.organization?.uuid)
  if (!org) return fail('CLAUDE_RESET_ORGANIZATION_INVALID', 'OAuth 组织信息无效', 502)
  return { ok: true, org }
}

function publicOutcome(outcome) {
  const out = {
    outcome: outcome.outcome,
    replayed: outcome.replayed === true,
  }
  if (CARD_KINDS.has(outcome.kind)) out.kind = outcome.kind
  if (outcome.reason) out.reason = outcome.reason
  if (Array.isArray(outcome.cleared) && outcome.cleared.length) out.cleared = outcome.cleared
  if (outcome.cooldown_until) out.cooldown_until = outcome.cooldown_until
  if (outcome.credits) out.claude_reset_credits = outcome.credits
  return out
}

function storedOutcome(record) {
  if (!record || typeof record !== 'object' || !record.outcome) return null
  return publicOutcome({ ...record, replayed: true })
}

async function claim(transport, exec, org, grantId, operation) {
  const unknown = { outcome: 'unknown', reason: 'claim_unconfirmed' }
  const res = await callWorker(transport, exec, 'reset-redeem', {
    body: { organization_uuid: org, grant_id: grantId, request_id: operation },
  })
  if (workerProblem(res) || res?.transportError || !res?.status) return unknown
  if (res.status === 401 || res.status === 403) return { outcome: 'ineligible', reason: 'authorization_rejected' }
  if (res.status !== 200 || !res.body || typeof res.body !== 'object' || Array.isArray(res.body)) return unknown
  const reason = KNOWN_REASONS.has(res.body.reason) ? res.body.reason : ''
  if (reason === 'stamp_indeterminate' || reason === 'reset_unconfirmed') return unknown
  if (
    res.body.result === 'reset' ||
    res.body.result === 'already_used' ||
    res.body.result === 'not_limited' ||
    res.body.result === 'cooldown' ||
    res.body.result === 'ineligible'
  ) {
    const out = { outcome: res.body.result }
    if (reason) out.reason = reason
    const cleared = knownWindows(res.body.cleared)
    if (cleared.length) out.cleared = cleared
    const cooldown = timeOf(res.body.cooldown_until)
    if (cooldown != null && !Number.isNaN(cooldown)) out.cooldown_until = iso(cooldown)
    return out
  }
  if (res.body.result === 'unavailable') return { outcome: 'unknown', reason: 'upstream_unavailable' }
  return unknown
}

function pickGrant(block, now, vmId, card) {
  if (!block || !Array.isArray(block.grants)) return null
  const chosen = card
    ? (grant) => held(grant, now) && claudeResetCardRef(vmId, grant.id) === card
    : (grant) => grant?.id === block.next_grant_id
  return block.grants.find((grant) => chosen(grant) && claudeResetGrantRedeemable(block, grant, now)) || null
}

function normalizeCard(raw) {
  if (raw == null || raw === '') return { card: '' }
  if (typeof raw !== 'string' || !CARD_REF.test(raw)) {
    return { error: fail('CLAUDE_RESET_CARD_INVALID', '重置卡标识无效', 400) }
  }
  return { card: raw }
}

function fenceBlocks(fence, now) {
  if (!fence || fence.outcome !== 'unknown') return null
  const at = Date.parse(fence.at)
  if (!Number.isFinite(at)) return fail('CLAUDE_RESET_UNRESOLVED', '上一次重置结果未确认，暂时不能再兑换', 409)
  if (fence.reason === 'upstream_unavailable') {
    if (now < at + UNAVAILABLE_FENCE_MS) {
      return fail('CLAUDE_RESET_UPSTREAM_UNAVAILABLE', '重置服务暂不可用，请稍后再试', 409)
    }
    return null
  }
  if (now < at + UNKNOWN_FENCE_MS) {
    return fail('CLAUDE_RESET_UNRESOLVED', '上一次重置结果未确认，暂时不能再兑换', 409)
  }
  return null
}

async function persistCredits(projectRoot, vmId, credits) {
  if (!credits) return
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  await withVmLock(file, async () => {
    let vm
    try {
      vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return
    }
    vm.claude_reset_credits = persistedCredits(credits)
    vm.updated_at = new Date().toISOString()
    atomicWriteJson(file, vm, { mode: 0o600 })
  })
}

function persistedCredits(view) {
  return {
    eligible: view.eligible === true,
    available_count: Math.max(0, Number(view.available_count) || 0),
    held_count: Math.max(0, Number(view.held_count) || 0),
    credits: (Array.isArray(view.credits) ? view.credits : []).map((credit) => ({
      ...(CARD_REF.test(String(credit.ref || '')) ? { ref: credit.ref } : {}),
      kind: CARD_KINDS.has(credit.kind) ? credit.kind : 'full',
      state: ['ready', 'cooldown'].includes(credit.state) ? credit.state : 'unavailable',
      gives_back_weekly: credit.gives_back_weekly === true,
      label: String(credit.label || ''),
      resets_left: Math.max(0, Number(credit.resets_left) || 0),
      ...(credit.starts_at ? { starts_at: credit.starts_at } : {}),
      ...(credit.expires_at ? { expires_at: credit.expires_at } : {}),
      clears: Array.isArray(credit.clears) ? credit.clears.filter((item) => KNOWN_WINDOWS.has(item)) : [],
      percent_used: percentUsed(credit.percent_used),
      blocking: Array.isArray(credit.blocking) ? credit.blocking.filter((item) => KNOWN_WINDOWS.has(item)) : [],
      use_requires_limit: credit.use_requires_limit === true,
      redeemable: credit.redeemable === true,
    })),
    ...(view.cooldown_until ? { cooldown_until: view.cooldown_until } : {}),
    ...(view.weekly_resets_at ? { weekly_resets_at: view.weekly_resets_at } : {}),
    fetched_at: view.fetched_at || new Date().toISOString(),
  }
}

export async function queryClaudeResetCredits({
  projectRoot,
  vmId,
  transport = defaultTransport,
  now = () => Date.now(),
} = {}) {
  const account = loadAccount(projectRoot, vmId)
  if (!account.ok) return account
  const fetched = await fetchBlock(transport, account.exec)
  if (!fetched.ok) return fetched
  const credits = projectClaudeResetCredits(fetched.block, now(), vmId)
  await persistCredits(projectRoot, vmId, credits)
  return { ok: true, claude_reset_credits: credits }
}

export async function redeemClaudeResetCredit({
  projectRoot,
  vmId,
  idempotencyKey,
  card,
  transport = defaultTransport,
  now = () => Date.now(),
} = {}) {
  const normalized = normalizeKey(idempotencyKey)
  if (normalized.error) return normalized.error
  const picked = normalizeCard(card)
  if (picked.error) return picked.error
  const account = loadAccount(projectRoot, vmId)
  if (!account.ok) return account
  const operation = claudeResetOperationId(vmId, normalized.key)
  return withAccountLease(vmId, now(), async () => {
    const existing = await mutateState(projectRoot, async (state) => ({
      value: storedOutcome(state.operations[operation]),
    }))
    if (existing?.ok === false) return existing
    if (existing) return { ok: true, ...existing }
    const outcome = await redeemOnce({
      projectRoot,
      vmId,
      operation,
      card: picked.card,
      exec: account.exec,
      transport,
      now,
    })
    if (!outcome.ok) return outcome
    const saved = await mutateState(projectRoot, async (state) => {
      state.operations[operation] = {
        outcome: outcome.outcome,
        ...(outcome.kind ? { kind: outcome.kind } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(outcome.cleared ? { cleared: outcome.cleared } : {}),
        ...(outcome.cooldown_until ? { cooldown_until: outcome.cooldown_until } : {}),
        ...(outcome.claude_reset_credits ? { credits: outcome.claude_reset_credits } : {}),
        at: iso(now()),
      }
      return { write: true, value: outcome }
    })
    return saved?.ok === false ? saved : outcome
  })
}

async function redeemOnce({ projectRoot, vmId, operation, card, exec, transport, now }) {
  const orgResult = await fetchOrg(transport, exec)
  if (!orgResult.ok) return orgResult
  const orgKey = claudeResetOrgId(orgResult.org)
  const owner = crypto.randomUUID()
  if (!tryAcquire(orgKey, owner, now())) {
    return fail('CLAUDE_RESET_BUSY', '已有一次重置正在进行', 409)
  }
  try {
    const fenceResult = await mutateState(projectRoot, async (state) => ({ value: state.fences[orgKey] || null }))
    if (fenceResult?.ok === false) return fenceResult
    const fence = fenceResult
    if (fence && (typeof fence !== 'object' || !fence.operation)) {
      return fail('CLAUDE_RESET_UNRESOLVED', '上一次重置结果未确认，暂时不能再兑换', 409)
    }
    if (fence?.operation === operation) {
      return {
        ok: true,
        ...publicOutcome({
          outcome: fence.outcome || 'unknown',
          reason: fence.reason,
          replayed: true,
        }),
      }
    }
    const blocked = fenceBlocks(fence, now())
    if (blocked) return blocked
    const status = await fetchBlock(transport, exec)
    if (!status.ok) return status
    const grant = pickGrant(status.block, now(), vmId, card)
    if (!grant) {
      return card
        ? fail('CLAUDE_RESET_NOT_AVAILABLE', '这张重置卡现在不能用，请先点限额查询刷新', 409)
        : fail('CLAUDE_RESET_NOT_AVAILABLE', '当前没有可兑换的限额重置', 409)
    }
    const kind = claudeResetGrantKind(grant)
    const marked = await writeFence(projectRoot, orgKey, {
      operation,
      outcome: 'unknown',
      reason: 'claim_unconfirmed',
      at: iso(now()),
    })
    if (marked?.ok === false) return marked
    const claimed = await claim(transport, exec, orgResult.org, grant.id, operation)
    claimed.kind = kind
    const settled = await writeFence(projectRoot, orgKey, {
      operation,
      outcome: claimed.outcome,
      ...(claimed.reason ? { reason: claimed.reason } : {}),
      at: iso(now()),
    })
    if (settled?.ok === false)
      return { ok: true, outcome: 'unknown', reason: 'result_persistence_failed', replayed: false }
    if (claimed.outcome !== 'unknown') {
      const fresh = await fetchBlock(transport, exec)
      if (fresh.ok) {
        claimed.credits = projectClaudeResetCredits(fresh.block, now(), vmId)
        await persistCredits(projectRoot, vmId, claimed.credits)
      }
    }
    return { ok: true, ...publicOutcome(claimed) }
  } finally {
    releaseLease(orgKey, owner)
  }
}

async function writeFence(projectRoot, orgKey, marker) {
  return mutateState(projectRoot, async (state) => {
    state.fences[orgKey] = marker
    return { write: true, value: { ok: true } }
  })
}
