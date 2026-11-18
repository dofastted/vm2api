/**
 * Linux exchanges use the target VM when native telemetry is ready; older
 * kernels use the controller helper through that VM's bound exit. The native
 * macOS path is unchanged; auth.js is loaded only by fetch test seams.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CAI_AUTHORIZE_URL,
  CLIENT_ID,
  FULL_OAUTH_SCOPE,
  INFERENCE_ONLY_SCOPE,
  OAUTH_REQUEST_TIMEOUT_MS,
  REDIRECT_URI,
  SETUP_TOKEN_TTL_SECONDS,
} from './oauth-contract.mjs'
import { carryOAuthAttempt, runGuestOAuthAuthService } from './guest-oauth-helper.mjs'

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

function runNativeOAuthAuthService(payload) {
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

/**
 * The setup-token consent link. `claude setup-token` authorizes `inferenceOnly`,
 * so the mint asks for `user:inference` alone — the full login set belongs to
 * the cookie import, which does not use this helper.
 */
export function buildSetupTokenAuthorizeURL(state, codeChallenge) {
  const encodedRedirectURI = encodeURIComponent(REDIRECT_URI)
  const encodedScope = encodeURIComponent(INFERENCE_ONLY_SCOPE)
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

/** The authorize endpoint allowlists the calling origin; a moved app domain looks like this. */
function isOriginRejected(s) {
  return /origin not allowed/i.test(String(s || ''))
}

/** The token endpoint throttles per exit IP; retrying the same second only extends it. */
function isRateLimited(s) {
  const t = String(s || '')
  return /_rate_limited|rate_limit_error|\b429\b/i.test(t)
}

/** `403 Request not allowed` on the token hop is a region-blocked exit, not a bad code. */
function isTokenForbidden(s) {
  return /token_exchange_forbidden|request not allowed/i.test(String(s || ''))
}

/**
 * claude.ai now requires `client_attestation: { hcaptcha_token }` — a token only
 * the page's hCaptcha can mint. The refusal says so, and no retry fixes it.
 */
function isClientAttestationRequired(s) {
  return /missing_client_attestation|client_attestation/i.test(String(s || ''))
}

export function classifyImportHelperOutput(stderr) {
  const t = String(stderr || '')
  if (isSessionStale(t)) return 'session_stale_relogin'
  if (/state_mismatch/i.test(t)) return 'state_mismatch'
  if (/authorize_no_code/i.test(t)) return 'authorize_no_code'
  if (/proxy_auth_rejected|user was rejected by the socks5 server/i.test(t)) return 'proxy_auth_rejected'
  if (isClientAttestationRequired(t)) return 'client_attestation_required'
  if (isOriginRejected(t)) return 'origin_rejected'
  if (/worker_session_code_unsupported/i.test(t)) return 'worker_session_code_unsupported'
  if (/worker_session_code_config/i.test(t)) return 'worker_session_code_config'
  if (isRateLimited(t)) return 'token_exchange_rate_limited'
  if (isTokenForbidden(t)) return 'token_exchange_forbidden'
  if (/bootstrap/i.test(t)) return 'bootstrap_failed'
  if (/grove_settings|grove/i.test(t)) return 'grove_settings_failed'
  if (isCloudflareChallenge(t)) return 'cloudflare_challenge'
  return 'cookie_auth_failed'
}

/**
 * `code` wins when the resolver already classified the failure: an exit policy
 * decision carries no recognisable text, and IPv6-off is a policy, not a fault.
 */
export function publicImportError(raw, code = '') {
  const s = String(raw || 'session import failed')
  switch (String(code || '')) {
    case 'proxy_unavailable':
      return '槽位 SOCKS5 当前不可用（已停用或探测失败）。请更换代理或重新探测后再导入。'
    case 'ipv6_disabled':
      return 'IPv6 已关闭，请在设置 → SOCKS5 开启 IPv6 代理出口'
    case 'proxy_required':
      return '虚拟机未绑定 SOCKS5，请先分配代理再导入。'
    default:
      break
  }
  if (isSessionStale(s)) {
    return 'sessionKey 不够新，Anthropic 拒绝授权（Session is not fresh enough）。请重新登录 claude.ai 后立刻复制最新 sessionKey，不要用旧 cookie。'
  }
  if (/state_mismatch/i.test(s)) return 'OAuth state 校验失败，请重新生成授权链接后再导入。'
  if (isClientAttestationRequired(s)) {
    return '上游拒绝了这次 authorize 的客户端指纹（missing_client_attestation）：闸门量的是 TLS/HTTP2 指纹，cookie 段必须经 kin-worker 的 Chrome 传输（oauth session-code）。请确认槽位里的 kin-worker 是本次构建、kernel config 可读；临时也可改用「授权链接」在浏览器完成授权。'
  }
  if (/worker_session_code_unsupported/i.test(s)) {
    return '槽位里的 kin-worker 太旧，没有 oauth session-code 操作（cookie 段要靠它的 Chrome TLS 指纹才能过 authorize）。请把 kin-worker 更新到本次构建后重试。'
  }
  if (/worker_session_code_config/i.test(s)) {
    return '槽位里的 kernel config 读不到，cookie 段没法用它选出口（Chrome TLS 传输需要这一步）。请检查槽位 /run/kin/kernel.json 是否可读，或改用「授权链接」。'
  }
  if (isOriginRejected(s)) {
    return '授权端点拒绝了来源头（Origin not allowed）：claude.ai 与 claude.com 两套来源都被拒。上游前端域名可能再次变更，请更新 src/lib/oauth/oauth-contract.mjs 里的授权来源常量。'
  }
  if (isRateLimited(s)) {
    return 'Anthropic 换票接口限流（429 Ratelimited）。这不是授权码的问题：等 1 分钟后再提交同一个码，连续点击只会继续被拒；持续出现说明该槽位出口 IP 被上游限速，换一条出口再试。'
  }
  if (isTokenForbidden(s)) {
    return 'Anthropic 拒绝了该出口的换票请求（403 Request not allowed）：通常是出口 IP 所在地区不被支持，请更换槽位出口后再导入。'
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
  // An exit the resolver refused is the operator's to fix, like a rejected
  // SOCKS5 login: 400, and never reported as an upstream fault.
  const exitPolicy = code === 'proxy_unavailable' || code === 'ipv6_disabled' || code === 'proxy_required'
  const settled = stale || proxyAuth || exitPolicy
  const cf = !settled && (code === 'cloudflare_challenge' || /just a moment|cloudflare|doctype html/i.test(raw))
  // Edge refusals: a refused Origin, a region-blocked token hop, or a new
  // browser-attestation gate is the upstream moving under us — not a bad code.
  const upstreamProtocol =
    !settled &&
    (code === 'origin_rejected' || code === 'token_exchange_forbidden' || code === 'client_attestation_required')
  // A throttle is the one failure worth retrying unchanged, after a wait.
  const throttled = !settled && (code === 'token_exchange_rate_limited' || isRateLimited(raw))
  const reported = stale
    ? code === 'authorize_no_code' || code === 'state_mismatch'
      ? code
      : 'session_stale_relogin'
    : proxyAuth
      ? 'proxy_auth_rejected'
      : cf
        ? 'cloudflare_challenge'
        : upstreamProtocol
          ? code
          : throttled
            ? 'token_exchange_rate_limited'
            : code || 'import_failed'
  return {
    status: settled ? 400 : throttled ? 429 : cf || upstreamProtocol ? 502 : 500,
    error: { code: reported, message: publicImportError(raw, code) },
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
  // proxyUrl is the fetchImpl test seam only: the real exchange resolves the
  // exit at the point of use (prepareSlotOAuth), never from a caller's value.
  proxyUrl = null,
  redirectUri = null,
  runtimeMode = 'oauth',
  fetchImpl = null,
  timeoutMs = OAUTH_REQUEST_TIMEOUT_MS,
  exec,
  projectRoot,
  routing,
  proxyPool,
} = {}) {
  const parsed = parseFullCode(code, state)
  if (!fetchImpl) {
    return runGuestOAuthAuthService(
      {
        operation: 'exchange_code',
        code: parsed.code,
        code_verifier: codeVerifier,
        state: parsed.state,
        redirect_uri: redirectUri || REDIRECT_URI,
        runtime_mode: runtimeMode,
        timeout_ms: timeoutMs,
      },
      { exec, projectRoot, routing, timeoutMs, proxyPool, runNative: runNativeOAuthAuthService },
    )
  }
  const auth = await loadLocalAuthForTest()
  const profile = runtimeMode === 'setup-token' ? 'setup-token' : 'sub2api'
  const token = await auth.exchangeAuthorizationCode({
    code: parsed.code,
    codeVerifier,
    state: parsed.state,
    profile,
    // The mint is the CLI's year-long setup token; a CAI login code is not.
    expiresIn: profile === 'setup-token' ? SETUP_TOKEN_TTL_SECONDS : undefined,
    proxyUrl,
    redirectUri: redirectUri || REDIRECT_URI,
    fetchImpl,
    timeoutMs,
  })
  return auth.completeAuthorizedToken({ token, profile, proxyUrl, fetchImpl, timeoutMs })
}

export async function sessionKeyToOAuth(
  sessionKey,
  {
    scope = 'full',
    // see exchangeTokenViaCookieAuth: test seam only
    proxyUrl = null,
    fetchImpl = null,
    timeoutMs = OAUTH_REQUEST_TIMEOUT_MS,
    exec,
    projectRoot,
    routing,
    proxyPool,
  } = {},
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
      ? await runGuestOAuthAuthService(
          {
            operation: 'session_key',
            session_key: sk,
            scope: requestedScope,
            runtime_mode: setup ? 'setup-token' : 'oauth',
            timeout_ms: timeoutMs,
          },
          { exec, projectRoot, routing, timeoutMs, proxyPool, runNative: runNativeOAuthAuthService },
        )
      : await (async () => {
          const auth = await loadLocalAuthForTest()
          return auth.sessionKeyToAuthorizedOAuth({
            sessionKey: sk,
            scope: requestedScope,
            profile: setup ? 'setup-token' : 'sub2api',
            proxyUrl,
            fetchImpl,
            timeoutMs,
          })
        })()
    return carryOAuthAttempt(cred, {
      ...cred,
      type: setup ? 'setup-token' : cred.type || 'oauth',
      mode: setup ? 'setup-token' : cred.mode || 'oauth',
      scope: cred.scope || requestedScope,
      source: cred.source || 'sessionKey-cookie-auth',
    })
  } catch (e) {
    const classified = classifyImportHelperOutput(e.message)
    const code = classified === 'cookie_auth_failed' ? e.code || classified : classified
    const err = new Error(publicImportError(e.message || 'session import failed', code))
    err.code = code
    throw err
  }
}
