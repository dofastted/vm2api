/**
 * Codex slot metadata. Tokens stay in vms/<id>/codex-credentials.json.
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from './vm-file.mjs'
import { isCodexVm } from '../protocol/codex-route.mjs'
import { buildCodexUsageView, extraToCodexSnapshot } from '../protocol/codex-usage.mjs'

export { isCodexVm }

export function codexCredentialPath(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', vmId, 'codex-credentials.json')
}

export function readCodexAccounts(projectRoot, vmId) {
  const file = codexCredentialPath(projectRoot, vmId)
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(raw?.accounts) ? raw.accounts : []
  } catch {
    return []
  }
}

export function writeCodexAccounts(projectRoot, vmId, accounts) {
  if (!projectRoot || !vmId) throw new Error('projectRoot and vmId required')
  atomicWriteJson(
    codexCredentialPath(projectRoot, vmId),
    { accounts: Array.isArray(accounts) ? accounts : [] },
    { mode: 0o600 },
  )
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value || '').trim()
    if (text) return text
  }
  return ''
}

function looksLikeClaudeSecret(text) {
  return /^sk-ant-/i.test(String(text || '').trim())
}

function extractOauthTokens(value) {
  let access = ''
  let refresh = ''
  let idToken = ''
  const pending = [value]
  const seen = new Set()
  while (pending.length) {
    const current = pending.pop()
    if (!current || typeof current !== 'object') continue
    if (seen.has(current)) continue
    seen.add(current)
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    for (const [key, nested] of Object.entries(current)) {
      if (key === 'accessToken' || key === 'access_token') {
        if (!access) access = firstString(nested)
        continue
      }
      if (key === 'refreshToken' || key === 'refresh_token') {
        if (!refresh) refresh = firstString(nested)
        continue
      }
      if (key === 'idToken' || key === 'id_token') {
        if (!idToken) idToken = firstString(nested)
        continue
      }
      if (nested && typeof nested === 'object') pending.push(nested)
    }
  }
  return { access, refresh, idToken }
}

function collectImportCandidates(doc) {
  if (!doc || typeof doc !== 'object') return []
  if (Array.isArray(doc.documents)) {
    const out = []
    for (const entry of doc.documents) {
      if (!entry || typeof entry !== 'object') continue
      const provider = String(entry.provider || '')
        .trim()
        .toLowerCase()
      if (provider && provider !== 'openai' && provider !== 'codex') continue
      if (entry.document && typeof entry.document === 'object') out.push(...collectImportCandidates(entry.document))
    }
    return out
  }
  if (Array.isArray(doc.accounts)) return doc.accounts.filter((item) => item && typeof item === 'object')
  if (Array.isArray(doc)) return doc.filter((item) => item && typeof item === 'object')
  return [doc]
}

function isOpenaiApiKeyOnly(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false
  const apiKey = firstString(doc.OPENAI_API_KEY, doc.openai_api_key, doc.api_key)
  if (!apiKey) return false
  const tokens = extractOauthTokens(doc)
  return !tokens.access && !tokens.refresh
}

function accountFromTokens(source, access, refresh, idToken) {
  const nested =
    source && typeof source === 'object' && !Array.isArray(source)
      ? source.credentials && typeof source.credentials === 'object'
        ? source.credentials
        : source
      : {}
  const chatgptAccountId = firstString(
    source?.chatgpt_account_id,
    nested.chatgpt_account_id,
    source?.account_id,
    nested.account_id,
    source?.accountId,
    nested.accountId,
  )
  const email = firstString(source?.email, nested.email, nested.id)
  const expiresAt = Number(source?.expires_at || nested.expires_at || 0)
  const rpm = Number(source?.rpm ?? nested.rpm)
  const conc = Number(source?.max_concurrency ?? nested.max_concurrency)
  return {
    id: email || chatgptAccountId || 'codex',
    access_token: access,
    refresh_token: refresh,
    id_token: idToken,
    expires_at: Number.isFinite(expiresAt) ? expiresAt : 0,
    chatgpt_account_id: chatgptAccountId,
    email: email || null,
    rpm: Number.isFinite(rpm) && rpm > 0 ? rpm : 0,
    max_concurrency: Number.isFinite(conc) && conc > 0 ? conc : 0,
  }
}

function parseTokenList(text, mode) {
  const tokens = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!tokens.length) return { ok: false, error: 'empty', message: '凭证不能为空' }
  const first = tokens[0]
  if (looksLikeClaudeSecret(first)) {
    return {
      ok: false,
      error: 'credential_kind_mismatch',
      message: '不能导入 Claude 凭证。GPT 槽需要 ChatGPT/Codex OAuth。',
    }
  }
  const access = mode === 'refresh_token' ? '' : first
  const refresh = mode === 'refresh_token' ? first : ''
  if (!access && !refresh) return { ok: false, error: 'missing_token', message: '需要 access_token 或 refresh_token' }
  return {
    ok: true,
    account: accountFromTokens({}, access, refresh, ''),
    extra_count: Math.max(0, tokens.length - 1),
  }
}

/**
 * Parse Codex CLI auth.json, ChatGPT OAuth JSON, CPR openai document, AT/RT paste.
 * Does not accept Claude sessionKey / Setup Token / Console API Key / OPENAI_API_KEY-only.
 */
export function parseCodexCredentialInput(input, opts = {}) {
  const mode = String(opts.mode || '')
    .trim()
    .toLowerCase()
  if (mode === 'access_token' || mode === 'refresh_token') {
    if (typeof input === 'string') return parseTokenList(input, mode)
    const tokens = extractOauthTokens(input)
    const access = mode === 'access_token' ? tokens.access : ''
    const refresh = mode === 'refresh_token' ? tokens.refresh : tokens.refresh
    if (mode === 'access_token' && !tokens.access) {
      return { ok: false, error: 'missing_token', message: '请粘贴 Access Token' }
    }
    if (mode === 'refresh_token' && !tokens.refresh) {
      return { ok: false, error: 'missing_token', message: '请粘贴 Refresh Token' }
    }
    return {
      ok: true,
      account: accountFromTokens(
        input && typeof input === 'object' ? input : {},
        tokens.access,
        tokens.refresh,
        tokens.idToken,
      ),
    }
  }

  let doc = input
  if (typeof input === 'string') {
    const text = input.trim()
    if (!text) return { ok: false, error: 'empty', message: '凭证不能为空' }
    try {
      doc = JSON.parse(text)
    } catch {
      return {
        ok: false,
        error: 'invalid_json',
        message: '不是合法 JSON。请上传 auth.json / 账号文件，或改用 AT/RT 粘贴。',
      }
    }
  }
  if (!doc || typeof doc !== 'object') {
    return { ok: false, error: 'invalid_json', message: '需要 ChatGPT/Codex OAuth JSON' }
  }
  if (isOpenaiApiKeyOnly(doc)) {
    return {
      ok: false,
      error: 'not_oauth_account',
      message: 'OPENAI_API_KEY 客户端配置不是 OAuth 账号。请导入 auth.json / AT / RT。',
    }
  }
  const candidates = collectImportCandidates(doc)
  for (const candidate of candidates) {
    const tokens = extractOauthTokens(candidate)
    if (!tokens.access && !tokens.refresh) continue
    if (looksLikeClaudeSecret(tokens.access) || looksLikeClaudeSecret(tokens.refresh)) {
      return {
        ok: false,
        error: 'credential_kind_mismatch',
        message: '不能导入 Claude 凭证。GPT 槽需要 ChatGPT/Codex OAuth。',
      }
    }
    return { ok: true, account: accountFromTokens(candidate, tokens.access, tokens.refresh, tokens.idToken) }
  }
  return {
    ok: false,
    error: 'missing_token',
    message: '需要 ChatGPT/Codex OAuth（access_token 或 refresh_token）。不能导入 Claude 凭证。',
  }
}

export function parseCodexImportPayload(body = {}) {
  const mode = String(body.mode || body.import_mode || '')
    .trim()
    .toLowerCase()
  const raw = body.auth_json ?? body.raw ?? body.text ?? body.data
  if (raw != null && raw !== '') return parseCodexCredentialInput(raw, { mode })
  return parseCodexCredentialInput(body, { mode })
}

export function upsertCodexAccount(projectRoot, vmId, patch = {}) {
  const accounts = readCodexAccounts(projectRoot, vmId)
  const cur = { ...(accounts[0] || {}) }
  Object.assign(cur, patch)
  if (!cur.id) cur.id = cur.email || cur.chatgpt_account_id || 'codex'
  if (!accounts.length) accounts.push(cur)
  else accounts[0] = cur
  writeCodexAccounts(projectRoot, vmId, accounts)
  return cur
}

export function persistCodexQuotaSnapshot(projectRoot, vmId, { extra, resetCredits, planType } = {}) {
  if (!projectRoot || !vmId) throw new Error('projectRoot and vmId required')
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  let vm = {}
  try {
    vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  vm.codex = vm.codex && typeof vm.codex === 'object' ? { ...vm.codex } : {}
  if (extra && typeof extra === 'object') {
    vm.codex.extra = { ...(vm.codex.extra || {}), ...extra }
    vm.codex.usage = buildCodexUsageView(extraToCodexSnapshot(vm.codex.extra))
  }
  const plan = String(planType || '').trim()
  if (plan) vm.codex.plan_type = plan
  if (resetCredits && typeof resetCredits === 'object') {
    vm.codex.reset_credits = {
      available_count: Math.max(0, Number(resetCredits.available_count) || 0),
      credits: Array.isArray(resetCredits.credits)
        ? resetCredits.credits
            .map((row) => ({ expires_at: String(row?.expires_at || '').trim() }))
            .filter((row) => row.expires_at)
        : [],
      fetched_at: resetCredits.fetched_at || new Date().toISOString(),
    }
  }
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(file, vm, { mode: 0o600 })
  return vm
}

export function summarizeCodexSlot(projectRoot, vm = {}) {
  const accounts = projectRoot && vm?.id ? readCodexAccounts(projectRoot, vm.id) : []
  const first = accounts[0] || {}
  const extra = vm.codex?.extra || vm.codex_extra || {}
  // extra is the source of truth; the stored view is only a fallback for slots without extra.
  const usage = buildCodexUsageView(Object.keys(extra).length ? extraToCodexSnapshot(extra) : vm.codex?.usage || {})
  const hasAccess = !!(first.access_token || vm.codex?.has_access)
  const hasRefresh = !!(first.refresh_token || vm.codex?.has_refresh)
  return {
    platform: 'openai',
    family: 'codex',
    has_token: hasAccess || hasRefresh,
    has_refresh: hasRefresh,
    email: first.email || vm.codex?.email || vm.email || null,
    expires_at: first.expires_at || vm.codex?.expires_at || null,
    chatgpt_account_id: first.chatgpt_account_id || vm.codex?.chatgpt_account_id || null,
    account_count: accounts.length,
    usage,
    reset_credits: vm.codex?.reset_credits || null,
    plan_type: vm.codex?.plan_type || null,
  }
}
