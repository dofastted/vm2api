/**
 * Host helper client for sessionKey / auth-code import.
 * Protocol lives in bin/kin-cookie-auth. This module only spawns it and
 * maps stdout JSON / stderr codes. Node does not implement the exchange.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { enrichOauthIdentity } from './oauth-identity.mjs'

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback'
const CAI_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize'
const SCOPE_INFERENCE = 'user:inference'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function buildSetupTokenAuthorizeURL(state, codeChallenge) {
  const encodedRedirectURI = encodeURIComponent(REDIRECT_URI)
  const encodedScope = encodeURIComponent(SCOPE_INFERENCE).replace(/%20/g, '+')
  return `${CAI_AUTHORIZE_URL}?code=true&client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodedRedirectURI}&scope=${encodedScope}&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}`
}

export function extractOAuthCodeFromRedirect(raw) {
  const urls = []
  if (typeof raw === 'string') urls.push(raw)
  else if (raw && typeof raw === 'object') {
    if (raw.url) urls.push(String(raw.url))
    if (raw.redirect_uri) urls.push(String(raw.redirect_uri))
    if (Array.isArray(raw.history)) {
      for (const item of raw.history) urls.push(String(item?.url || item || ''))
    }
    const headers = raw.headers
    if (headers) {
      const loc = typeof headers.get === 'function' ? headers.get('location') : headers.location
      if (loc) urls.push(String(loc))
    }
    if (raw.text) urls.push(String(raw.text))
    if (typeof raw.body === 'string') urls.push(raw.body)
    else if (raw.body?.redirect_uri) urls.push(String(raw.body.redirect_uri))
  }
  for (const value of urls) {
    if (!value) continue
    try {
      const parsed = new URL(value, REDIRECT_URI)
      const code = parsed.searchParams.get('code')
      if (code) return { code, state: parsed.searchParams.get('state') || '' }
      if (parsed.hash) {
        const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''))
        const hashed = hash.get('code')
        if (hashed) return { code: hashed, state: hash.get('state') || '' }
      }
    } catch {
      const match = String(value).match(/[?&#]code=([^&#\s]+)/)
      if (match) return { code: decodeURIComponent(match[1]), state: '' }
    }
  }
  return null
}

function redact(s, keep = 12) {
  if (!s || typeof s !== 'string') return s
  if (s.length <= keep * 2) return s.slice(0, 4) + '…'
  return s.slice(0, keep) + '…' + s.slice(-8)
}

function isCloudflareChallenge(s) {
  const t = String(s || '')
  return (
    /just a moment/i.test(t) ||
    /cloudflare_challenge/i.test(t) ||
    /cf-mitigated/i.test(t) ||
    /cdn-cgi\/challenge/i.test(t) ||
    /<!doctype html/i.test(t)
  )
}

function isSessionStale(s) {
  const t = String(s || '')
  return /session_stale/i.test(t) || /not fresh enough/i.test(t) || /session is not fresh/i.test(t) || /不够新/.test(t)
}

export function classifyImportHelperOutput(stderr) {
  const t = String(stderr || '')
  if (isSessionStale(t)) return 'session_stale_relogin'
  if (/authorize_no_code/i.test(t)) return 'authorize_no_code'
  if (/proxy_auth_rejected|user was rejected by the socks5 server/i.test(t)) return 'proxy_auth_rejected'
  if (isCloudflareChallenge(t)) return 'cloudflare_challenge'
  return 'cookie_auth_failed'
}

export function publicImportError(raw) {
  const s = String(raw || 'session import failed')
  if (isSessionStale(s)) {
    return 'sessionKey 不够新，Anthropic 拒绝授权（Session is not fresh enough）。请重新登录 claude.ai 后立刻复制最新 sessionKey，不要用旧 cookie。'
  }
  if (/authorize_no_code/i.test(s)) {
    return '官方 CAI 授权页没有返回 code。sessionKey 可能未完成 claude.ai SSO，请重新登录 claude.ai 后立刻复制最新 sessionKey。'
  }
  if (/proxy_auth_rejected|user was rejected by the socks5 server/i.test(s)) {
    return '槽位 SOCKS5 拒绝了用户名或密码（curl 97）。sessionKey 还没发出去。请核对这条代理的账密，或换一条能登录的 SOCKS5 后再导入。'
  }
  if (isCloudflareChallenge(s)) {
    return 'Cloudflare 拦截了该槽位 SOCKS5 出口。请换住宅代理或稍后重试。'
  }
  const compact = s.replace(/\s+/g, ' ').trim()
  if (/<!doctype|<html[\s>]/i.test(compact)) {
    const status = (compact.match(/\b([45]\d\d)\b/) || [])[1] || ''
    return `导入失败${status ? `: ${status}` : ''} 上游返回了网页而不是 JSON`
  }
  return compact.slice(0, 240)
}

export function panelImportErrorPayload(err) {
  const raw = String(err?.message || err || '')
  const code = err?.code || classifyImportHelperOutput(raw)
  const stale = code === 'session_stale_relogin' || code === 'authorize_no_code'
  const proxyAuth = code === 'proxy_auth_rejected'
  const cf =
    !stale && !proxyAuth && (code === 'cloudflare_challenge' || /just a moment|cloudflare|doctype html/i.test(raw))
  return {
    status: stale || proxyAuth ? 400 : cf ? 502 : 500,
    error: {
      code: stale
        ? code === 'authorize_no_code'
          ? 'authorize_no_code'
          : 'session_stale_relogin'
        : proxyAuth
          ? 'proxy_auth_rejected'
          : cf
            ? 'cloudflare_challenge'
            : code || 'import_failed',
      message: publicImportError(raw),
    },
  }
}

function cookieAuthBinName() {
  return process.platform === 'win32' ? 'kin-cookie-auth.exe' : 'kin-cookie-auth'
}

export function findCookieAuthBin() {
  const named = process.env.KIN_COOKIE_AUTH_BIN
  const candidates = [
    named,
    path.join(__dirname, '..', '..', '..', 'bin', cookieAuthBinName()),
    path.join(__dirname, '..', '..', '..', 'bin', 'kin-cookie-auth'),
    '/opt/vm2api/bin/kin-cookie-auth',
    '/opt/kin-gateway/bin/kin-cookie-auth',
  ].filter(Boolean)
  return candidates.find((p) => fs.existsSync(p)) || null
}

function normalizeSocks(proxyUrl) {
  if (!proxyUrl) return null
  const s = String(proxyUrl)
  if (s.startsWith('socks5://') && !s.startsWith('socks5h://')) {
    return 'socks5h://' + s.slice('socks5://'.length)
  }
  return s
}

function spawnCookieHelper(envExtra, sessionKey) {
  const bin = findCookieAuthBin()
  if (!bin) {
    const err = new Error('kin-cookie-auth not found')
    err.code = 'no_cookie_auth_bin'
    return Promise.reject(err)
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [], {
      env: {
        ...process.env,
        ...envExtra,
        ...(sessionKey ? { SESSION_KEY: sessionKey } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      const label = path.basename(bin)
      if (stderr.trim()) console.warn(`[${label}]`, publicImportError(stderr))
      if (code !== 0) {
        const classified = classifyImportHelperOutput(stderr)
        const err = new Error(publicImportError(stderr.trim() || `${label} exited ${code}`))
        err.code = classified === 'cookie_auth_failed' && /proxy_required/i.test(stderr) ? 'proxy_required' : classified
        reject(err)
        return
      }
      try {
        const cred = JSON.parse(stdout.trim())
        if (!cred?.access_token) throw new Error(`${label} returned no access_token`)
        resolve(cred)
      } catch (e) {
        reject(e)
      }
    })
  })
}

export async function exchangeTokenViaCookieAuth({
  code,
  codeVerifier,
  state = '',
  proxyUrl = null,
  redirectUri = null,
  tokenUrls = null,
} = {}) {
  const direct = proxyUrl === ''
  const px = direct ? '' : normalizeSocks(proxyUrl)
  if (!direct && !px) {
    const err = new Error('slot SOCKS5 is required for token exchange')
    err.code = 'proxy_required'
    throw err
  }
  const urls = Array.isArray(tokenUrls) ? tokenUrls.map((u) => String(u || '').trim()).filter(Boolean) : []
  return spawnCookieHelper(
    {
      IMPORT_MODE: 'token_exchange',
      ...(px ? { PROXY_URL: px } : {}),
      AUTH_CODE: String(code || ''),
      CODE_VERIFIER: String(codeVerifier || ''),
      OAUTH_STATE: String(state || ''),
      ...(redirectUri ? { OAUTH_REDIRECT_URI: String(redirectUri) } : {}),
      ...(urls.length ? { OAUTH_TOKEN_URLS: urls.join(',') } : {}),
    },
    '',
  )
}

function fakeOauth(scope) {
  const now = Math.floor(Date.now() / 1000)
  return {
    type: scope === 'inference' ? 'setup-token' : 'oauth',
    mode: scope === 'inference' ? 'setup-token' : 'oauth',
    access_token: 'sk-ant-oat01-FAKE-SIM',
    refresh_token: 'sk-ant-ort01-FAKE-SIM',
    expires_at: now + 8 * 3600,
    expiresAt: (now + 8 * 3600) * 1000,
    email: 'fake-oauth@kin.test',
    account_uuid: 'acct-fake-sim',
    org_uuid: 'org-fake-sim',
    source: 'KIN_FAKE_SESSION_OAUTH',
    scope,
  }
}

export async function sessionKeyToOAuth(sessionKey, { scope = 'full', proxyUrl = null, fetchImpl = null } = {}) {
  const sk = String(sessionKey || '')
    .trim()
    .replace(/^["']|["']$/g, '')
  if (!sk.startsWith('sk-ant-sid')) {
    throw new Error(`expected sk-ant-sid* sessionKey, got: ${redact(sk)}`)
  }
  if (process.env.KIN_FAKE_SESSION_OAUTH === '1' || process.env.KIN_FAKE_SESSION_OAUTH === 'true') {
    return fakeOauth(scope)
  }
  const direct = proxyUrl === ''
  const px = direct ? '' : normalizeSocks(proxyUrl)
  if (!direct && !px) {
    const err = new Error('slot SOCKS5 is required for sessionKey import')
    err.code = 'proxy_required'
    throw err
  }
  try {
    const cred = await spawnCookieHelper({ SCOPE: scope, ...(px ? { PROXY_URL: px } : {}) }, sk)
    console.log('[import]', cred.source || 'cookie-auth', 'socks5h', redact(cred.access_token || ''))
    return enrichOauthIdentity(cred, { proxyUrl: px, fetchImpl })
  } catch (e) {
    const err = new Error(publicImportError(e.message || 'session import failed'))
    err.code = e.code || 'cookie_auth_failed'
    throw err
  }
}
