/**
 * Browser OAuth-link import.
 * CAI (sub2api) and official Claude Code share PKCE + paste-code,
 * then exchange via the slot SOCKS5, or the control-plane default route
 * when the slot is bound to local egress (`proxyUrl` empty string).
 */
import crypto from 'node:crypto'
import { exchangeTokenViaCookieAuth } from './cookie-auth.mjs'
import { enrichOauthIdentity, flattenOauthIdentity } from './oauth-identity.mjs'

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const SESSION_TTL_MS = 30 * 60 * 1000
export const SCOPE_INFERENCE = 'user:inference'

export const OAUTH_FLAVORS = Object.freeze({
  cai: {
    flavor: 'cai',
    authorizeUrl: 'https://claude.com/cai/oauth/authorize',
    redirectUri: 'https://platform.claude.com/oauth/code/callback',
    tokenUrls: ['https://platform.claude.com/v1/oauth/token', 'https://api.anthropic.com/v1/oauth/token'],
    scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
    source: 'oauth-auth-url',
  },
  claude_code: {
    flavor: 'claude_code',
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    redirectUri: 'https://console.anthropic.com/oauth/code/callback',
    tokenUrls: [
      'https://platform.claude.com/v1/oauth/token',
      'https://api.anthropic.com/v1/oauth/token',
      'https://console.anthropic.com/v1/oauth/token',
    ],
    scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers',
    source: 'oauth-claude-code',
  },
  setup_token: {
    flavor: 'setup_token',
    authorizeUrl: 'https://claude.com/cai/oauth/authorize',
    redirectUri: 'https://platform.claude.com/oauth/code/callback',
    tokenUrls: ['https://platform.claude.com/v1/oauth/token', 'https://api.anthropic.com/v1/oauth/token'],
    scope: SCOPE_INFERENCE,
    source: 'oauth-setup-token',
  },
})

export const AUTHORIZE_URL = OAUTH_FLAVORS.cai.authorizeUrl
export const REDIRECT_URI = OAUTH_FLAVORS.cai.redirectUri
export const SCOPE_OAUTH = OAUTH_FLAVORS.cai.scope

const sessions = new Map()

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function generateState() {
  return b64url(crypto.randomBytes(32))
}

function generateCodeVerifier() {
  return b64url(crypto.randomBytes(32))
}

function generateCodeChallenge(verifier) {
  return b64url(crypto.createHash('sha256').update(verifier).digest())
}

function generateSessionId() {
  return crypto.randomBytes(16).toString('hex')
}

function sweepExpired(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id)
  }
}

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function normalizeSocks(proxyUrl) {
  if (!proxyUrl) return null
  const s = String(proxyUrl)
  if (s.startsWith('socks5://') && !s.startsWith('socks5h://')) {
    return 'socks5h://' + s.slice('socks5://'.length)
  }
  return s
}

export function normalizeOauthFlavor(raw) {
  const key = String(raw || 'cai')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
  if (key === 'claude_code' || key === 'cc' || key === 'official') return 'claude_code'
  if (key === 'setup_token' || key === 'inference') return 'setup_token'
  return 'cai'
}

export function oauthFlavorSpec(raw) {
  return OAUTH_FLAVORS[normalizeOauthFlavor(raw)]
}

export function resetAuthUrlSessions() {
  sessions.clear()
}

export function peekAuthUrlSession(sessionId) {
  sweepExpired()
  return sessions.get(sessionId) || null
}

export function buildAuthorizationURL(state, codeChallenge, scope = SCOPE_OAUTH, flavor = 'cai') {
  const spec = oauthFlavorSpec(flavor)
  const encodedRedirectURI = encodeURIComponent(spec.redirectUri)
  const encodedScope = encodeURIComponent(scope || spec.scope).replace(/%20/g, '+')
  return `${spec.authorizeUrl}?code=true&client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodedRedirectURI}&scope=${encodedScope}&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}`
}

export function generateAuthUrl({ vmId, proxyUrl, flavor } = {}) {
  sweepExpired()
  if (!vmId) throw fail('vm_required', 'vm_id required (先创建虚拟机)')
  if (proxyUrl == null) {
    throw fail('proxy_required', '虚拟机未绑定 SOCKS5，请先分配代理再生成授权链接')
  }
  const spec = oauthFlavorSpec(flavor)
  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const sessionId = generateSessionId()
  const createdAt = Date.now()
  sessions.set(sessionId, {
    state,
    codeVerifier,
    flavor: spec.flavor,
    scope: spec.scope,
    redirectUri: spec.redirectUri,
    tokenUrls: spec.tokenUrls.slice(),
    source: spec.source,
    proxyUrl: proxyUrl === '' ? '' : String(proxyUrl),
    vmId: String(vmId),
    createdAt,
  })
  return {
    auth_url: buildAuthorizationURL(state, codeChallenge, spec.scope, spec.flavor),
    session_id: sessionId,
    expires_at: createdAt + SESSION_TTL_MS,
    vm_id: String(vmId),
    flavor: spec.flavor,
  }
}

function parseAuthCode(fullCode) {
  const raw = String(fullCode || '').trim()
  const hash = raw.indexOf('#')
  if (hash === -1) return { code: raw, state: '' }
  return { code: raw.slice(0, hash), state: raw.slice(hash + 1) }
}

async function exchangeCodeForToken(authCode, codeVerifier, state, proxyUrl, session) {
  const px = proxyUrl === '' ? '' : normalizeSocks(proxyUrl)
  if (px == null) throw fail('proxy_required', '虚拟机未绑定 SOCKS5，无法换票')
  return exchangeTokenViaCookieAuth({
    code: authCode,
    codeVerifier,
    state,
    proxyUrl: px,
    redirectUri: session.redirectUri,
    tokenUrls: session.tokenUrls,
  })
}

export async function exchangeAuthCode({ sessionId, code, proxyUrl, vmId, fetchImpl = null } = {}) {
  sweepExpired()
  const session = sessions.get(sessionId)
  if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) {
    if (session) sessions.delete(sessionId)
    throw fail('session_expired', '授权会话不存在或已过期，请重新生成授权链接')
  }
  if (vmId && session.vmId && session.vmId !== String(vmId)) {
    throw fail('session_vm_mismatch', '授权会话与当前虚拟机不匹配')
  }
  const parsed = parseAuthCode(code)
  if (!parsed.code) throw fail('code_required', '请粘贴授权码')
  const px = proxyUrl ?? session.proxyUrl
  if (px == null) throw fail('proxy_required', '虚拟机未绑定 SOCKS5，无法换票')

  if (process.env.KIN_FAKE_SESSION_OAUTH === '1' || process.env.KIN_FAKE_SESSION_OAUTH === 'true') {
    sessions.delete(sessionId)
    const now = Math.floor(Date.now() / 1000)
    return {
      access_token: 'sk-ant-oat01-FAKE-AUTH-URL',
      refresh_token: 'sk-ant-ort01-FAKE-AUTH-URL',
      token_type: 'Bearer',
      expires_in: 8 * 3600,
      expires_at: now + 8 * 3600,
      scope: session.scope,
      email_address: 'fake-oauth@kin.test',
      account_uuid: 'acct-fake-auth-url',
      org_uuid: 'org-fake-auth-url',
      source: 'KIN_FAKE_SESSION_OAUTH',
      flavor: session.flavor || 'cai',
    }
  }

  const token = await exchangeCodeForToken(
    parsed.code,
    session.codeVerifier,
    parsed.state || session.state,
    px,
    session,
  )
  sessions.delete(sessionId)
  const expiresIn = Number(token.expires_in || 0)
  const now = Math.floor(Date.now() / 1000)
  const identity = flattenOauthIdentity(token)
  return enrichOauthIdentity(
    {
      access_token: token.access_token,
      refresh_token: token.refresh_token || '',
      token_type: token.token_type || 'Bearer',
      expires_in: expiresIn,
      expires_at: token.expires_at || now + expiresIn,
      scope: token.scope || session.scope,
      email: identity.email,
      email_address: identity.email,
      account_uuid: identity.account_uuid,
      org_uuid: identity.org_uuid,
      source: session.source || 'oauth-auth-url',
      flavor: session.flavor || 'cai',
    },
    { proxyUrl: px, fetchImpl },
  )
}
