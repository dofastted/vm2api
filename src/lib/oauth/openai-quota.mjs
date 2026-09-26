/**
 * ChatGPT / Codex quota + rate-limit-reset-credit.
 * Upstream via slot SOCKS5 only. Mirrors sub2api OpenAIQuotaService,
 * without auto-reset, spark shadow, or agent-identity recovery.
 */
import crypto from 'node:crypto'
import { getVm } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { boundProxyUrl, isLocalEgressProxy } from '../vm/egress.mjs'
import { readCodexAccounts, upsertCodexAccount, persistCodexQuotaSnapshot } from '../vm/codex-slot.mjs'
import { buildCodexUsageView, extraToCodexSnapshot, normalizeCodexLimits } from '../protocol/codex-usage.mjs'
import { CODEX_OAUTH_ORIGINATOR, makeSocksFetch, refreshCodexAccessToken } from '../protocol/codex-models.mjs'

export const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
export const CHATGPT_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
export const CHATGPT_RESET_CONSUME_URL = `${CHATGPT_RESET_CREDITS_URL}/consume`
export const OPENAI_QUOTA_TIMEOUT_MS = 20_000
const CODEX_BETA = 'codex-1'

function num(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function int(value) {
  const n = num(value)
  return n == null ? null : Math.trunc(n)
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value || '').trim()
    if (text) return text
  }
  return ''
}

export function buildOpenaiQuotaHeaders({ accessToken, accountId, fedRamp = false } = {}) {
  const headers = {
    authorization: `Bearer ${String(accessToken || '').trim()}`,
    accept: 'application/json',
    'openai-beta': CODEX_BETA,
    'oai-language': 'zh-CN',
    originator: CODEX_OAUTH_ORIGINATOR,
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-dest': 'empty',
    priority: 'u=4, i',
  }
  const account = firstString(accountId)
  if (account) headers['chatgpt-account-id'] = account
  if (fedRamp) headers['x-openai-fedramp'] = 'true'
  return headers
}

function windowMinutes(window = {}) {
  const seconds = num(window.limit_window_seconds ?? window.limitWindowSeconds)
  if (seconds == null) return null
  return Math.max(0, Math.round(seconds / 60))
}

function resetAtIso(window = {}, now = Date.now()) {
  const raw = window.reset_at ?? window.resetAt
  const n = num(raw)
  if (n != null && n > 0) {
    const ms = n < 1e12 ? n * 1000 : n
    return new Date(ms).toISOString()
  }
  const after = num(window.reset_after_seconds ?? window.resetAfterSeconds)
  if (after == null) return null
  return new Date(now + after * 1000).toISOString()
}

function pickWindow(window) {
  if (!window || typeof window !== 'object') return null
  return {
    used_percent: num(window.used_percent ?? window.usedPercent),
    reset_after_seconds: int(window.reset_after_seconds ?? window.resetAfterSeconds),
    window_minutes: windowMinutes(window),
    reset_at: resetAtIso(window),
  }
}

export function extraFromRateLimit(rateLimit = {}, now = Date.now()) {
  const primary = pickWindow(rateLimit.primary_window || rateLimit.primaryWindow)
  const secondary = pickWindow(rateLimit.secondary_window || rateLimit.secondaryWindow)
  const extra = {
    codex_usage_updated_at: new Date(now).toISOString(),
  }
  if (primary) {
    extra.codex_primary_used_percent = primary.used_percent
    extra.codex_primary_reset_after_seconds = primary.reset_after_seconds
    extra.codex_primary_window_minutes = primary.window_minutes
    extra.codex_primary_reset_at = primary.reset_at
  }
  if (secondary) {
    extra.codex_secondary_used_percent = secondary.used_percent
    extra.codex_secondary_reset_after_seconds = secondary.reset_after_seconds
    extra.codex_secondary_window_minutes = secondary.window_minutes
    extra.codex_secondary_reset_at = secondary.reset_at
  }
  const limits = normalizeCodexLimits(extraToCodexSnapshot(extra))
  extra.codex_5h_used_percent = limits.used_5h_percent
  extra.codex_7d_used_percent = limits.used_7d_percent
  extra.codex_5h_reset_after_seconds = limits.reset_5h_seconds
  extra.codex_7d_reset_after_seconds = limits.reset_7d_seconds
  extra.codex_5h_window_minutes = limits.window_5h_minutes
  extra.codex_7d_window_minutes = limits.window_7d_minutes
  extra.codex_5h_reset_at = limits.reset_5h_at
  extra.codex_7d_reset_at = limits.reset_7d_at
  return extra
}

function creditExpiresAt(row = {}) {
  return firstString(row.expires_at, row.expiresAt)
}

function creditResetType(row = {}) {
  return firstString(row.reset_type, row.resetType)
}

function creditStatus(row = {}) {
  return firstString(row.status)
}

function isCodexResetCredit(row) {
  if (!row || typeof row !== 'object') return false
  const type = creditResetType(row)
  if (type && type.toLowerCase() !== 'codex_rate_limits') return false
  const status = creditStatus(row)
  if (status && status.toLowerCase() !== 'available') return false
  return true
}

function asCreditList(value) {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object')
  return []
}

export function parseResetCreditDetails(body) {
  const empty = { available_count: 0, credits: [], list_present: false }
  if (body == null) return empty
  let raw = body
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return empty
    try {
      raw = JSON.parse(text)
    } catch {
      return empty
    }
  }
  if (Array.isArray(raw)) {
    const credits = raw
      .filter(isCodexResetCredit)
      .map((row) => ({ expires_at: creditExpiresAt(row) }))
      .filter((row) => row.expires_at)
    return { available_count: credits.length, credits, list_present: true }
  }
  if (!raw || typeof raw !== 'object') return empty
  const listed = asCreditList(raw.credits || raw.rate_limit_reset_credits || raw.items || raw.data)
  const listPresent = !!(raw.credits || raw.rate_limit_reset_credits || raw.items || raw.data)
  const filtered = listed.filter(isCodexResetCredit)
  const credits = filtered.map((row) => ({ expires_at: creditExpiresAt(row) })).filter((row) => row.expires_at)
  const counted = num(raw.available_count ?? raw.availableCount)
  return {
    available_count: counted != null && counted >= 0 ? Math.trunc(counted) : filtered.length,
    credits,
    list_present: listPresent,
  }
}

export function mergeResetCredits(usageCredits, detailCredits) {
  const usage = usageCredits && typeof usageCredits === 'object' ? usageCredits : null
  const details = detailCredits && typeof detailCredits === 'object' ? detailCredits : null
  const merged = {
    available_count: Number(usage?.available_count) || 0,
    credits: Array.isArray(usage?.credits) ? usage.credits.filter((row) => row?.expires_at) : [],
  }
  if (details) {
    if (details.list_present) merged.credits = details.credits || []
    if (details.available_count != null && Number.isFinite(Number(details.available_count))) {
      merged.available_count = Math.trunc(Number(details.available_count))
    } else if (details.list_present) {
      merged.available_count = (details.credits || []).length
    }
  }
  if (merged.available_count > 0 && !merged.credits.length && details?.credits?.length) {
    merged.credits = details.credits
  }
  return {
    available_count: Math.max(0, merged.available_count || 0),
    credits: merged.credits,
    fetched_at: new Date().toISOString(),
  }
}

export function redeemRequestId() {
  return crypto.randomUUID()
}

async function readJson(res) {
  if (res && typeof res.json === 'function') {
    try {
      return await res.json()
    } catch {
      return null
    }
  }
  if (res && typeof res.text === 'function') {
    const text = await res.text()
    try {
      return text ? JSON.parse(text) : null
    } catch {
      return null
    }
  }
  return res?.body && typeof res.body === 'object' ? res.body : null
}

function mapUpstreamStatus(status) {
  if (status === 401 || status === 403 || status === 429) return status
  return 502
}

function fail(code, message, status = 400, extra = {}) {
  return { ok: false, error: code, message, status, ...extra }
}

async function loadSlot(projectRoot, vmId) {
  const vm = getVm(projectRoot, vmId)
  if (!vm) return { ok: false, error: 'vm_not_found', message: 'VM not found', status: 404 }
  if (!isCodexVm(vm)) {
    return { ok: false, error: 'not_gpt_slot', message: '只有 GPT 槽支持重置券', status: 400 }
  }
  const first = readCodexAccounts(projectRoot, vmId)[0] || {}
  const access = firstString(first.access_token, vm.codex?.access_token)
  const refresh = firstString(first.refresh_token, vm.codex?.refresh_token)
  if (!access && !refresh) {
    return { ok: false, error: 'no_oauth_token', message: 'GPT 槽没有 OAuth 凭证', status: 400 }
  }
  const proxyUrl = boundProxyUrl(vm.proxy)
  return {
    ok: true,
    vm,
    first,
    access,
    refresh,
    accountId: firstString(first.chatgpt_account_id, vm.codex?.chatgpt_account_id),
    proxyUrl,
    direct: isLocalEgressProxy(vm.proxy),
  }
}

async function quotaFetch(url, { method = 'GET', headers, body, proxyUrl, fetchImpl, timeoutMs, direct = false } = {}) {
  const fetchFn = fetchImpl || makeSocksFetch(proxyUrl, timeoutMs || OPENAI_QUOTA_TIMEOUT_MS)
  if (!fetchImpl && !proxyUrl && !direct)
    return { ok: false, error: 'proxy_required', message: 'GPT 槽未绑定 SOCKS5', status: 400 }
  try {
    const res = await fetchFn(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    })
    const status = Number(res?.status) || 0
    const payload = await readJson(res)
    return { ok: status > 0 && status < 400, status, payload }
  } catch (e) {
    const aborted = e?.name === 'AbortError' || /aborted/i.test(String(e?.message || e))
    return {
      ok: false,
      error: aborted ? 'timeout' : 'fetch_failed',
      message: aborted ? '上游超时' : '上游请求失败',
      status: 502,
    }
  }
}

async function rotateIfNeeded(slot, projectRoot, vmId, fetchImpl) {
  if (!slot.refresh) return slot
  const tok = await refreshCodexAccessToken({
    refreshToken: slot.refresh,
    proxyUrl: slot.proxyUrl,
    fetchImpl,
    timeoutMs: OPENAI_QUOTA_TIMEOUT_MS,
  })
  if (!tok.ok) return { ...slot, rotateError: tok.error || 'refresh_failed' }
  upsertCodexAccount(projectRoot, vmId, {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    id_token: tok.id_token || slot.first.id_token,
    expires_at: tok.expires_at || slot.first.expires_at,
  })
  return { ...slot, access: tok.access_token, refresh: tok.refresh_token || slot.refresh }
}

function publicUsage(extra, resetCredits, usagePayload = {}) {
  const view = buildCodexUsageView(extraToCodexSnapshot(extra))
  return {
    usage: view,
    quota: view.quota,
    windows: view.windows,
    reset_credits: resetCredits,
    plan_type: usagePayload.plan_type || usagePayload.planType || null,
    email: usagePayload.email || null,
  }
}

async function queryUpstream(slot, { fetchImpl, rotate = true, projectRoot, vmId } = {}) {
  if (!slot.proxyUrl && !fetchImpl && !slot.direct) {
    return fail('proxy_required', 'GPT 槽未绑定 SOCKS5', 400)
  }
  let current = slot
  const headersOf = (access) => buildOpenaiQuotaHeaders({ accessToken: access, accountId: current.accountId })

  const run = async (access) => {
    const usage = await quotaFetch(CHATGPT_USAGE_URL, {
      headers: headersOf(access),
      proxyUrl: current.proxyUrl,
      fetchImpl,
      direct: current.direct,
    })
    if (!usage.ok && usage.error) return usage
    if (usage.status === 401 || usage.status === 403) {
      return { ...usage, ok: false, error: 'upstream_auth' }
    }
    if (!usage.ok) {
      return fail('upstream_error', `上游返回 ${usage.status || 0}`, mapUpstreamStatus(usage.status), {
        upstream_status: usage.status,
      })
    }
    const details = await quotaFetch(CHATGPT_RESET_CREDITS_URL, {
      headers: headersOf(access),
      proxyUrl: current.proxyUrl,
      fetchImpl,
      direct: current.direct,
    })
    return { usage, details }
  }

  let pack = await run(current.access)
  if (pack.error === 'upstream_auth' && rotate && current.refresh) {
    current = await rotateIfNeeded(current, projectRoot, vmId, fetchImpl)
    if (!current.access || current.rotateError) {
      return fail(current.rotateError || 'refresh_failed', 'GPT OAuth 刷新失败，请重新导入', 502)
    }
    pack = await run(current.access)
  }
  if (pack.error === 'upstream_auth') {
    return fail('upstream_auth', 'GPT 凭证已失效，请重新导入', mapUpstreamStatus(pack.status || 401), {
      upstream_status: pack.status,
    })
  }
  if (pack.ok === false || pack.error) return pack

  const extra = extraFromRateLimit(pack.usage.payload?.rate_limit || pack.usage.payload?.rateLimit || {})
  const usageCredits = pack.usage.payload?.rate_limit_reset_credits || pack.usage.payload?.rateLimitResetCredits
  const detailCredits = pack.details?.ok ? parseResetCreditDetails(pack.details.payload) : null
  const resetCredits = mergeResetCredits(
    usageCredits && typeof usageCredits === 'object'
      ? {
          available_count: num(usageCredits.available_count ?? usageCredits.availableCount) || 0,
          credits: asCreditList(usageCredits.credits)
            .map((row) => ({ expires_at: creditExpiresAt(row) }))
            .filter((row) => row.expires_at),
        }
      : null,
    detailCredits,
  )
  const persistable = resetCredits.available_count <= 0 || resetCredits.credits.length > 0 ? resetCredits : null
  persistCodexQuotaSnapshot(projectRoot, vmId, {
    extra,
    planType: pack.usage.payload?.plan_type || pack.usage.payload?.planType,
    ...(persistable ? { resetCredits: persistable } : {}),
  })
  return {
    ok: true,
    ...publicUsage(extra, persistable || resetCredits, pack.usage.payload || {}),
    fetched_at: resetCredits.fetched_at,
    warning: persistable ? undefined : 'reset_credit_cache_refresh_failed',
  }
}

export async function queryOpenaiQuota({ projectRoot, vmId, fetchImpl, rotate = true } = {}) {
  const slot = await loadSlot(projectRoot, vmId)
  if (!slot.ok) return slot
  return queryUpstream(slot, { fetchImpl, rotate, projectRoot, vmId })
}

export async function resetOpenaiQuota({ projectRoot, vmId, fetchImpl, rotate = true } = {}) {
  const slot = await loadSlot(projectRoot, vmId)
  if (!slot.ok) return slot
  if (!slot.proxyUrl && !fetchImpl && !slot.direct) return fail('proxy_required', 'GPT 槽未绑定 SOCKS5', 400)

  let current = slot
  const headersOf = (access) => ({
    ...buildOpenaiQuotaHeaders({ accessToken: access, accountId: current.accountId }),
    'content-type': 'application/json',
  })
  const redeemId = redeemRequestId()

  const consume = async (access) =>
    quotaFetch(CHATGPT_RESET_CONSUME_URL, {
      method: 'POST',
      headers: headersOf(access),
      body: JSON.stringify({ redeem_request_id: redeemId }),
      proxyUrl: current.proxyUrl,
      fetchImpl,
      direct: current.direct,
    })

  let res = await consume(current.access)
  if ((res.status === 401 || res.status === 403) && rotate && current.refresh) {
    current = await rotateIfNeeded(current, projectRoot, vmId, fetchImpl)
    if (!current.access || current.rotateError) {
      return fail(current.rotateError || 'refresh_failed', 'GPT OAuth 刷新失败，请重新导入', 502)
    }
    res = await consume(current.access)
  }
  if (res.error && !res.status) return res
  if (res.status === 401 || res.status === 403) {
    return fail('upstream_auth', 'GPT 凭证已失效，请重新导入', mapUpstreamStatus(res.status), {
      upstream_status: res.status,
    })
  }
  if (!res.ok) {
    return fail('upstream_error', `消费重置券失败（${res.status || 0}）`, mapUpstreamStatus(res.status || 502), {
      upstream_status: res.status,
    })
  }

  const after = await queryUpstream(current, { fetchImpl, rotate: false, projectRoot, vmId })
  if (!after.ok) {
    return {
      ok: true,
      warning: 'reset_credit_cache_refresh_failed',
      code: res.payload?.code || 'ok',
      windows_reset: int(res.payload?.windows_reset ?? res.payload?.windowsReset) || 0,
      reset_credits: null,
      usage: null,
      quota: null,
      windows: [],
    }
  }
  return {
    ok: true,
    code: res.payload?.code || 'ok',
    windows_reset: int(res.payload?.windows_reset ?? res.payload?.windowsReset) || 0,
    ...after,
  }
}
