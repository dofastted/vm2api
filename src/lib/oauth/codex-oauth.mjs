/**
 * Official Codex Desktop OAuth (chatgpt.com/codex/desktop-auth + PKCE).
 * Matches codex-proxy-rs: loopback callback is pasted back, exchange via slot SOCKS5.
 */
import crypto from 'node:crypto'
import { isKubernetesMode } from '../core/control-plane-mode.mjs'
import { OneTimeAuthRepo } from '../db/repos/one-time-auth-repo.mjs'
import {
  CODEX_APP_VERSION,
  CODEX_OAUTH_AUTHORIZE_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_DESKTOP_AUTH_URL,
  CODEX_OAUTH_ORIGINATOR,
  CODEX_OAUTH_REDIRECT_URI,
  CODEX_OAUTH_SCOPE,
  exchangeCodexAuthorizationCode,
} from '../protocol/codex-models.mjs'

export const CODEX_OAUTH_SESSION_TTL_MS = 10 * 60 * 1000
const SURFACE_STABLE_ID_DOMAIN = Buffer.from('openai/codex-desktop/surface-stable-id/v1\0')

const sessions = new Map()

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function sweepExpired(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (now - session.createdAt > CODEX_OAUTH_SESSION_TTL_MS) sessions.delete(id)
  }
}

function uuidBytes(value) {
  const hex = String(value || '')
    .trim()
    .replace(/-/g, '')
  if (/^[0-9a-f]{32}$/i.test(hex)) return Buffer.from(hex, 'hex')
  return crypto
    .createHash('sha256')
    .update(String(value || 'codex'))
    .digest()
    .subarray(0, 16)
}

export function deriveCodexSurfaceStableId(installationId) {
  const digest = crypto.createHash('sha256')
  digest.update(SURFACE_STABLE_ID_DOMAIN)
  digest.update(uuidBytes(installationId))
  const bytes = Buffer.from(digest.digest().subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function parseCodexOAuthCallback(raw) {
  const text = String(raw || '').trim()
  if (!text) return { code: '', state: '' }
  try {
    const url = new URL(text)
    return {
      code: String(url.searchParams.get('code') || '').trim(),
      state: String(url.searchParams.get('state') || '').trim(),
    }
  } catch {
    const hash = text.indexOf('#')
    if (hash !== -1) {
      return { code: text.slice(0, hash).trim(), state: text.slice(hash + 1).trim() }
    }
    const params = new URLSearchParams(text.includes('?') ? text.slice(text.indexOf('?') + 1) : text)
    return {
      code: String(params.get('code') || '').trim(),
      state: String(params.get('state') || '').trim(),
    }
  }
}

function buildDesktopAuthUrl({ state, codeChallenge, installationId }) {
  const inner = new URL(CODEX_OAUTH_AUTHORIZE_URL)
  const stableId = deriveCodexSurfaceStableId(installationId)
  inner.searchParams.set('response_type', 'code')
  inner.searchParams.set('client_id', CODEX_OAUTH_CLIENT_ID)
  inner.searchParams.set('redirect_uri', CODEX_OAUTH_REDIRECT_URI)
  inner.searchParams.set('scope', CODEX_OAUTH_SCOPE)
  inner.searchParams.set('code_challenge', codeChallenge)
  inner.searchParams.set('code_challenge_method', 'S256')
  inner.searchParams.set('id_token_add_organizations', 'true')
  inner.searchParams.set('codex_cli_simplified_flow', 'true')
  inner.searchParams.set('state', state)
  inner.searchParams.set('originator', CODEX_OAUTH_ORIGINATOR)
  inner.searchParams.set('codex_app_version', CODEX_APP_VERSION)
  inner.searchParams.set('source_surface_stable_id', stableId)
  inner.searchParams.set('codex_origin_stable_id', stableId)
  inner.searchParams.set('codex_streamlined_login', 'true')
  const outer = new URL(CODEX_OAUTH_DESKTOP_AUTH_URL)
  outer.searchParams.set('authorize_url', inner.toString())
  outer.searchParams.set('codex_streamlined_login', 'true')
  outer.searchParams.set('no_universal_links', '1')
  return outer.toString()
}

export function generateCodexAuthUrl({ vmId, proxyUrl, installationId, db } = {}) {
  sweepExpired()
  if (!vmId) throw fail('vm_required', 'vm_id required (先创建虚拟机)')
  if (proxyUrl == null) throw fail('proxy_required', '虚拟机未绑定 SOCKS5，请先分配代理再生成授权链接')
  const state = b64url(crypto.randomBytes(32))
  const codeVerifier = b64url(crypto.randomBytes(32))
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest())
  const sessionId = crypto.randomBytes(16).toString('hex')
  const createdAt = Date.now()
  const install = String(installationId || crypto.randomUUID())
  const session = {
    state,
    codeVerifier,
    proxyUrl: proxyUrl === '' ? '' : String(proxyUrl),
    vmId: String(vmId),
    installationId: install,
    createdAt,
  }
  const generated = {
    auth_url: buildDesktopAuthUrl({ state, codeChallenge, installationId: install }),
    session_id: sessionId,
    expires_at: createdAt + CODEX_OAUTH_SESSION_TTL_MS,
    vm_id: String(vmId),
    flavor: 'codex',
  }
  if (isKubernetesMode()) {
    return new OneTimeAuthRepo(db)
      .issuePkce('codex', sessionId, session, CODEX_OAUTH_SESSION_TTL_MS)
      .then(({ expiresAt }) => ({ ...generated, expires_at: expiresAt }))
  }
  sessions.set(sessionId, session)
  return generated
}

export async function exchangeCodexAuthCode({ sessionId, code, proxyUrl, vmId, fetchImpl, db } = {}) {
  sweepExpired()
  const parsed = parseCodexOAuthCallback(code)
  const store = isKubernetesMode() ? new OneTimeAuthRepo(db) : null
  const validate = (session) => {
    if (vmId && session.vmId && session.vmId !== String(vmId))
      throw fail('session_vm_mismatch', '授权会话与当前虚拟机不匹配')
    if (!parsed.code) throw fail('code_required', '请粘贴 Codex 回调 URL 或授权码')
    if (parsed.state && parsed.state !== session.state) throw fail('state_mismatch', '回调 state 与授权会话不匹配')
    if ((proxyUrl ?? session.proxyUrl) == null) throw fail('proxy_required', '虚拟机未绑定 SOCKS5，无法换票')
  }
  const claim = store ? await store.claimPkce('codex', sessionId, validate) : null
  const session = store ? claim.session : sessions.get(sessionId)
  if (!session || (!store && Date.now() - session.createdAt > CODEX_OAUTH_SESSION_TTL_MS)) {
    if (session) sessions.delete(sessionId)
    throw fail('session_expired', '授权会话不存在或已过期，请重新生成授权链接')
  }
  if (!store) validate(session)
  const px = proxyUrl ?? session.proxyUrl
  if (px == null) throw fail('proxy_required', '虚拟机未绑定 SOCKS5，无法换票')
  const tok = await exchangeCodexAuthorizationCode({
    code: parsed.code,
    codeVerifier: session.codeVerifier,
    proxyUrl: px,
    fetchImpl,
  })
  if (!tok.ok) {
    if (store) await store.finishPkce('codex', sessionId, claim.claimId, false)
    throw fail(tok.error || 'exchange_failed', 'Codex OAuth 换票失败，请重新生成授权链接')
  }
  if (store) await store.finishPkce('codex', sessionId, claim.claimId, true)
  else sessions.delete(sessionId)
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    id_token: tok.id_token,
    expires_at: tok.expires_at,
    flavor: 'codex',
    source: 'codex-oauth',
  }
}

export function resetCodexAuthUrlSessions() {
  sessions.clear()
}
