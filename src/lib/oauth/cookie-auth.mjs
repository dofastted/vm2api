/**
 * OAuth import surface. Production exchange runs in the local-only
 * `kin-oauth-auth` binary; auth.js is loaded dynamically only by tests.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAI_AUTHORIZE_URL, CLIENT_ID, FULL_OAUTH_SCOPE, REDIRECT_URI } from './oauth-contract.mjs'
import { withOAuthProxy } from './http-proxy-bridge.mjs'

export { CLIENT_ID, REDIRECT_URI }

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function findOAuthAuthBin() {
  const named = process.env.KIN_OAUTH_AUTH_BIN
  const candidates = [
    named,
    path.join(__dirname, '..', '..', '..', 'bin', 'kin-oauth-auth'),
    '/opt/vm2api/bin/kin-oauth-auth',
    '/opt/kin-gateway/bin/kin-oauth-auth',
  ].filter(Boolean)
  return candidates.find((item) => fs.existsSync(item)) || null
}

function serviceFailure(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function runOAuthAuthService(payload) {
  return withOAuthProxy(payload.proxy_url, (proxyUrl) => runOAuthAuthProcess({ ...payload, proxy_url: proxyUrl }), {
    timeoutMs: payload.timeout_ms,
  })
}

function runOAuthAuthProcess(payload) {
  const bin = findOAuthAuthBin()
  if (!bin) return Promise.reject(serviceFailure('oauth_auth_bin_missing', 'kin-oauth-auth not found'))
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => reject(serviceFailure('oauth_auth_spawn_failed', error.message)))
    child.on('close', (code) => {
      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      let result = null
      try {
        result = lines.length ? JSON.parse(lines[lines.length - 1]) : null
      } catch {}
      if (!result || typeof result !== 'object') {
        reject(serviceFailure('oauth_auth_output_invalid', stderr.trim().slice(0, 300) || `service exited ${code}`))
        return
      }
      if (result.ok !== true) {
        reject(
          serviceFailure(result.error?.code || 'oauth_auth_failed', result.error?.message || 'OAuth service failed'),
        )
        return
      }
      resolve(result.credential)
    })
    child.stdin.end(JSON.stringify(payload) + '\n')
  })
}

async function loadLocalAuthForTest() {
  return import('./auth.js')
}

export function buildSetupTokenAuthorizeURL(state, codeChallenge) {
  const encodedRedirectURI = encodeURIComponent(REDIRECT_URI)
  const encodedScope = encodeURIComponent(FULL_OAUTH_SCOPE).replace(/%20/g, '+')
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
  if (s.length <= keep * 2) return s.slice(0, 4) + '...'
  return s.slice(0, keep) + '...' + s.slice(-8)
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
  if (/state_mismatch/i.test(t)) return 'state_mismatch'
  if (/authorize_no_code/i.test(t)) return 'authorize_no_code'
  if (/proxy_auth_rejected|user was rejected by the socks5 server/i.test(t)) return 'proxy_auth_rejected'
  if (/bootstrap/i.test(t)) return 'bootstrap_failed'
  if (/grove_settings|grove/i.test(t)) return 'grove_settings_failed'
  if (isCloudflareChallenge(t)) return 'cloudflare_challenge'
  return 'cookie_auth_failed'
}

export function publicImportError(raw) {
  const s = String(raw || 'session import failed')
  if (isSessionStale(s)) {
    return 'sessionKey 不够新，Anthropic 拒绝授权（Session is not fresh enough）。请重新登录 claude.ai 后立刻复制最新 sessionKey，不要用旧 cookie。'
  }
  if (/state_mismatch/i.test(s)) return 'OAuth state 校验失败，请重新生成授权链接后再导入。'
  if (/authorize_no_code/i.test(s)) {
    return '官方 CAI 授权页没有返回 code。sessionKey 可能未完成 claude.ai SSO，请重新登录 claude.ai 后立刻复制最新 sessionKey。'
  }
  if (/proxy_auth_rejected|user was rejected by the socks5 server/i.test(s)) {
    return '槽位 SOCKS5 拒绝了用户名或密码（curl 97）。sessionKey 还没发出去。请核对这条代理的账密，或换一条能登录的 SOCKS5 后再导入。'
  }
  if (isCloudflareChallenge(s)) {
    return 'Cloudflare 拦截了该槽位 SOCKS5 出口。请换住宅代理或稍后重试。'
  }
  const compact = s
    .replace(/sk-ant-[A-Za-z0-9._~+/-]+/g, '[redacted-token]')
    .replace(/\s+/g, ' ')
    .trim()
  if (/<!doctype|<html[\s>]/i.test(compact)) {
    const status = (compact.match(/\b([45]\d\d)\b/) || [])[1] || ''
    return `导入失败${status ? `: ${status}` : ''} 上游返回了网页而不是 JSON`
  }
  return compact.slice(0, 240)
}

export function panelImportErrorPayload(err) {
  const raw = String(err?.message || err || '')
  const code = err?.code || classifyImportHelperOutput(raw)
  const stale = code === 'session_stale_relogin' || code === 'authorize_no_code' || code === 'state_mismatch'
  const proxyAuth = code === 'proxy_auth_rejected'
  const cf =
    !stale && !proxyAuth && (code === 'cloudflare_challenge' || /just a moment|cloudflare|doctype html/i.test(raw))
  return {
    status: stale || proxyAuth ? 400 : cf ? 502 : 500,
    error: {
      code: stale
        ? code === 'authorize_no_code'
          ? 'authorize_no_code'
          : code === 'state_mismatch'
            ? 'state_mismatch'
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

function fakeOauth(scope) {
  const now = Math.floor(Date.now() / 1000)
  const setup = String(scope || '').toLowerCase() === 'inference'
  return {
    type: setup ? 'setup-token' : 'oauth',
    mode: setup ? 'setup-token' : 'oauth',
    access_token: 'sk-ant-oat01-FAKE-SIM',
    refresh_token: 'sk-ant-ort01-FAKE-SIM',
    expires_at: now + 8 * 3600,
    expiresAt: (now + 8 * 3600) * 1000,
    email: 'fake-oauth@kin.test',
    account_uuid: 'acct-fake-sim',
    org_uuid: 'org-fake-sim',
    source: 'KIN_FAKE_SESSION_OAUTH',
    scope: FULL_OAUTH_SCOPE,
  }
}

function parseFullCode(code, state = '') {
  const raw = String(code || '').trim()
  const hash = raw.indexOf('#')
  if (hash === -1) return { code: raw, state: String(state || '') }
  return { code: raw.slice(0, hash), state: raw.slice(hash + 1) }
}

export async function exchangeTokenViaCookieAuth({
  code,
  codeVerifier,
  state = '',
  proxyUrl = null,
  redirectUri = null,
  fetchImpl = null,
  timeoutMs = 15000,
} = {}) {
  const parsed = parseFullCode(code, state)
  if (!fetchImpl) {
    return runOAuthAuthService({
      operation: 'exchange_code',
      code: parsed.code,
      code_verifier: codeVerifier,
      state: parsed.state,
      redirect_uri: redirectUri || REDIRECT_URI,
      proxy_url: proxyUrl,
      timeout_ms: timeoutMs,
    })
  }
  const auth = await loadLocalAuthForTest()
  const token = await auth.exchangeAuthorizationCode({
    code: parsed.code,
    codeVerifier,
    state: parsed.state,
    proxyUrl,
    redirectUri: redirectUri || REDIRECT_URI,
    fetchImpl,
    timeoutMs,
  })
  return auth.completeAuthorizedToken({ token, proxyUrl, fetchImpl, timeoutMs })
}

export async function sessionKeyToOAuth(
  sessionKey,
  { scope = 'full', proxyUrl = null, fetchImpl = null, timeoutMs = 15000 } = {},
) {
  const sk = String(sessionKey || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
  if (!sk.startsWith('sk-ant-sid')) {
    throw new Error(`expected sk-ant-sid* sessionKey, got: ${redact(sk)}`)
  }
  if (process.env.KIN_FAKE_SESSION_OAUTH === '1' || process.env.KIN_FAKE_SESSION_OAUTH === 'true') {
    return fakeOauth(scope)
  }
  try {
    const requestedScope = FULL_OAUTH_SCOPE
    const setup = String(scope || '').toLowerCase() === 'inference'
    const cred = !fetchImpl
      ? await runOAuthAuthService({
          operation: 'session_key',
          session_key: sk,
          scope: requestedScope,
          runtime_mode: setup ? 'setup-token' : 'oauth',
          proxy_url: proxyUrl,
          timeout_ms: timeoutMs,
        })
      : await (async () => {
          const auth = await loadLocalAuthForTest()
          return auth.sessionKeyToAuthorizedOAuth({
            sessionKey: sk,
            scope: requestedScope,
            proxyUrl,
            fetchImpl,
            timeoutMs,
          })
        })()
    return {
      ...cred,
      type: setup ? 'setup-token' : cred.type || 'oauth',
      mode: setup ? 'setup-token' : cred.mode || 'oauth',
      scope: cred.scope || requestedScope,
      source: cred.source || 'sessionKey-cookie-auth',
    }
  } catch (e) {
    const err = new Error(publicImportError(e.message || 'session import failed'))
    const classified = classifyImportHelperOutput(e.message)
    err.code = classified === 'cookie_auth_failed' ? e.code || classified : classified
    throw err
  }
}
