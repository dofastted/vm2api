/**
 * ChatGPT / Codex model catalog.
 * Live ids come from chatgpt.com/backend-api/models through the slot SOCKS.
 * Background probes never rotate OAuth. User-initiated sync may refresh
 * via refresh_token (auth.openai.com), then persist the new access token.
 */
import fetch from 'node-fetch'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { isSyncableGptCatalogId } from './gpt-ids.mjs'

export { SKIP_GPT, GPT_ID_PREFIX, isGptSeriesId, isSyncableGptCatalogId } from './gpt-ids.mjs'

export const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'
export const CHATGPT_MODELS_URL = CODEX_MODELS_URL
export const CHATGPT_MODELS_URLS = Object.freeze([CODEX_MODELS_URL])
export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const CODEX_OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
export const CODEX_OAUTH_DESKTOP_AUTH_URL = 'https://chatgpt.com/codex/desktop-auth'
export const CODEX_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback'
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_OAUTH_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'
export const CODEX_OAUTH_ORIGINATOR = 'Codex Desktop'
// Keep the catalog request on a current official Codex client version. The
// ChatGPT catalog is version-gated; stale versions can return an older catalog
// without the models exposed to current Codex clients.
export const CODEX_APP_VERSION = '0.158.0'
// The model endpoint validates that Originator matches the User-Agent prefix.
// OAuth still uses CODEX_OAUTH_ORIGINATOR (the desktop login surface), while
// catalog and inference requests use the Codex CLI identity below.
export const CODEX_CATALOG_ORIGINATOR = 'codex_cli_rs'
export const CODEX_USER_AGENT = `${CODEX_CATALOG_ORIGINATOR}/${CODEX_APP_VERSION} (linux x86_64)`

function isCodexRequestSlug(id) {
  return isSyncableGptCatalogId(id)
}

/**
 * Official Codex catalog: `{ models: [{ slug, display_name }] }`.
 * Does not walk ChatGPT web `/backend-api/models` consumer trees.
 */
export function parseCodexModelCatalog(payload) {
  const rows = Array.isArray(payload?.models) ? payload.models : []
  const out = []
  const seen = new Set()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const id = String(row.slug || row.id || '').trim()
    if (!id || !isCodexRequestSlug(id) || seen.has(id.toLowerCase())) continue
    seen.add(id.toLowerCase())
    out.push({
      id,
      display_name: String(row.display_name || row.title || id).trim() || id,
    })
  }
  return out
}

/** Extract gpt catalog ids from a Codex models payload. */
export function parseChatgptModelIds(payload) {
  return parseCodexModelCatalog(payload).map((row) => row.id)
}

async function readFetchBody(res) {
  if (
    res &&
    Object.prototype.hasOwnProperty.call(res, 'body') &&
    res.body &&
    typeof res.body === 'object' &&
    !res.body.pipe
  ) {
    return res.body
  }
  if (typeof res?.json === 'function') {
    try {
      return await res.json()
    } catch {
      return null
    }
  }
  if (typeof res?.text === 'function') {
    const text = await res.text()
    try {
      return text ? JSON.parse(text) : null
    } catch {
      return null
    }
  }
  return null
}

export function makeSocksFetch(proxyUrl, timeoutMs = 15000) {
  const px = String(proxyUrl || '')
    .trim()
    .replace(/^socks5:\/\//i, 'socks5h://')
  const ms = Math.min(Math.max(Number(timeoutMs) || 15000, 3000), 30000)
  return (url, init = {}) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), ms)
    const opts = { ...init, signal: ac.signal }
    if (px) opts.agent = new SocksProxyAgent(px)
    return fetch(url, opts).finally(() => clearTimeout(timer))
  }
}

/**
 * User-initiated Codex OAuth refresh. Not used by background model probes.
 * @param {{ refreshToken?: string, proxyUrl?: string, fetchImpl?: Function, timeoutMs?: number }} opts
 */
export async function refreshCodexAccessToken(opts = {}) {
  const refreshToken = String(opts.refreshToken || '').trim()
  if (!refreshToken) return { ok: false, error: 'missing_refresh_token' }
  const fetchFn = opts.fetchImpl || makeSocksFetch(opts.proxyUrl, opts.timeoutMs)
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID,
    scope: CODEX_OAUTH_SCOPE,
  })
  try {
    const res = await fetchFn(CODEX_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': CODEX_USER_AGENT,
      },
      body: String(body),
    })
    const status = Number(res?.status) || 0
    const payload = await readFetchBody(res)
    if (status === 401 || status === 403) {
      return { ok: false, error: 'refresh_rejected', status }
    }
    if (status >= 400) return { ok: false, error: 'refresh_failed', status }
    const access = String(payload?.access_token || '').trim()
    if (!access) return { ok: false, error: 'refresh_empty', status }
    const expiresIn = Number(payload?.expires_in)
    return {
      ok: true,
      access_token: access,
      refresh_token: String(payload?.refresh_token || refreshToken).trim() || refreshToken,
      id_token: String(payload?.id_token || '').trim(),
      expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
    }
  } catch (e) {
    const aborted = e?.name === 'AbortError' || /aborted/i.test(String(e?.message || e))
    return { ok: false, error: aborted ? 'timeout' : 'fetch_failed' }
  }
}

/**
 * Official Codex Desktop authorization-code + PKCE exchange.
 * @param {{ code?: string, codeVerifier?: string, proxyUrl?: string, fetchImpl?: Function, timeoutMs?: number }} opts
 */
export async function exchangeCodexAuthorizationCode(opts = {}) {
  const code = String(opts.code || '').trim()
  const codeVerifier = String(opts.codeVerifier || '').trim()
  if (!code || !codeVerifier) return { ok: false, error: 'code_required' }
  const fetchFn = opts.fetchImpl || makeSocksFetch(opts.proxyUrl, opts.timeoutMs)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX_OAUTH_CLIENT_ID,
    code,
    redirect_uri: CODEX_OAUTH_REDIRECT_URI,
    code_verifier: codeVerifier,
  })
  try {
    const res = await fetchFn(CODEX_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': CODEX_USER_AGENT,
      },
      body: String(body),
    })
    const status = Number(res?.status) || 0
    const payload = await readFetchBody(res)
    if (status === 401 || status === 403) return { ok: false, error: 'exchange_rejected', status }
    if (status >= 400) return { ok: false, error: 'exchange_failed', status }
    const access = String(payload?.access_token || '').trim()
    const refresh = String(payload?.refresh_token || '').trim()
    if (!access || !refresh) return { ok: false, error: 'exchange_empty', status }
    const expiresIn = Number(payload?.expires_in)
    return {
      ok: true,
      access_token: access,
      refresh_token: refresh,
      id_token: String(payload?.id_token || '').trim(),
      expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
    }
  } catch (e) {
    const aborted = e?.name === 'AbortError' || /aborted/i.test(String(e?.message || e))
    return { ok: false, error: aborted ? 'timeout' : 'fetch_failed' }
  }
}

/**
 * @param {{
 *   accessToken?: string,
 *   accountId?: string,
 *   proxyUrl?: string,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 * }} opts
 */
export async function fetchChatgptModelCatalog(opts = {}) {
  const token = String(opts.accessToken || '').trim()
  if (!token) return { ok: false, error: 'missing_access_token', ids: [], models: [] }
  const proxyUrl = String(opts.proxyUrl || '')
    .trim()
    .replace(/^socks5:\/\//i, 'socks5h://')
  if (!proxyUrl && !opts.fetchImpl && !opts.direct) return { ok: false, error: 'proxy_required', ids: [], models: [] }

  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'user-agent': CODEX_USER_AGENT,
    originator: CODEX_CATALOG_ORIGINATOR,
    version: CODEX_APP_VERSION,
  }
  const accountId = String(opts.accountId || '').trim()
  if (accountId) headers['chatgpt-account-id'] = accountId

  const url = `${CODEX_MODELS_URL}?client_version=${encodeURIComponent(CODEX_APP_VERSION)}`
  const fetchFn = opts.fetchImpl || makeSocksFetch(proxyUrl, opts.timeoutMs)
  try {
    const res = await fetchFn(url, { method: 'GET', headers })
    const status = Number(res?.status) || 0
    if (status === 401 || status === 403) {
      return { ok: false, error: 'upstream_auth', status, ids: [], models: [] }
    }
    if (status >= 400) return { ok: false, error: 'upstream_error', status, ids: [], models: [] }
    const body = await readFetchBody(res)
    const models = parseCodexModelCatalog(body)
    const ids = models.map((row) => row.id)
    if (!ids.length) return { ok: false, error: 'empty_catalog', status, ids: [], models: [] }
    return { ok: true, status: status || 200, ids, models, source: 'codex' }
  } catch (e) {
    const aborted = e?.name === 'AbortError' || /aborted/i.test(String(e?.message || e))
    return { ok: false, error: aborted ? 'timeout' : 'fetch_failed', ids: [], models: [] }
  }
}
