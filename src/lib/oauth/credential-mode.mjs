/**
 * Slot credential kinds: full OAuth, Setup Token (inference-only OAuth),
 * and Anthropic Console API Key.
 */
import { flattenOauthIdentity } from './oauth-identity.mjs'

export const CREDENTIAL_OAUTH = 'oauth'
export const CREDENTIAL_SETUP_TOKEN = 'setup-token'
export const CREDENTIAL_APIKEY = 'apikey'

export function normalizeCredentialMode(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  if (s === 'setup-token' || s === 'inference') return CREDENTIAL_SETUP_TOKEN
  if (s === 'apikey' || s === 'api-key' || s === 'console' || s === 'console-key') return CREDENTIAL_APIKEY
  return CREDENTIAL_OAUTH
}

export function isApiKeyMode(raw) {
  return normalizeCredentialMode(raw) === CREDENTIAL_APIKEY
}

export function isSetupTokenMode(raw) {
  return normalizeCredentialMode(raw) === CREDENTIAL_SETUP_TOKEN
}

export function canOfficialCc(raw) {
  return normalizeCredentialMode(raw) === CREDENTIAL_OAUTH
}

/** Official GET /api/oauth/usage|/profile. Setup-token oat is the same short-lived grant. */
export function canOfficialUsage(raw) {
  const mode = normalizeCredentialMode(raw)
  return mode === CREDENTIAL_OAUTH || mode === CREDENTIAL_SETUP_TOKEN
}

export function canCountTokens(raw) {
  return isSetupTokenMode(raw) || isApiKeyMode(raw)
}

export function canRefreshCredential(raw) {
  return !isApiKeyMode(raw)
}

export function looksLikeConsoleApiKey(value) {
  return /^sk-ant-api03-/i.test(String(value || '').trim())
}

export function looksLikeSessionKey(value) {
  return /^sk-ant-sid/i.test(String(value || '').trim())
}

/** Official `claude setup-token` / CLAUDE_CODE_OAUTH_TOKEN. Same prefix as short-lived OAuth access. */
export function looksLikeOauthAccessToken(value) {
  return /^sk-ant-oat01-/i.test(String(value || '').trim())
}

export function credentialModeFromOauth(oauth = {}) {
  const typed = oauth.type || oauth.mode || oauth.credential_mode
  const labeled = typed ? normalizeCredentialMode(typed) : ''
  if (labeled === CREDENTIAL_APIKEY) return CREDENTIAL_APIKEY
  if (looksLikeConsoleApiKey(oauth.api_key || oauth.apiKey || oauth.access_token || oauth.accessToken)) {
    return CREDENTIAL_APIKEY
  }
  const scope = String(oauth.scope || (Array.isArray(oauth.scopes) ? oauth.scopes.join(' ') : ''))
  // Some account exports label a full OAuth grant as setup-token. The actual
  // scope set is authoritative: preserve profile/session scopes instead of
  // rewriting the grant to inference-only during worker credential import.
  if (/user:profile|user:sessions:claude_code/.test(scope)) return CREDENTIAL_OAUTH
  if (labeled === CREDENTIAL_SETUP_TOKEN) return CREDENTIAL_SETUP_TOKEN
  if (scope && /user:inference/.test(scope)) return CREDENTIAL_SETUP_TOKEN
  if (oauth.flavor === 'setup_token' || oauth.flavor === 'setup-token') return CREDENTIAL_SETUP_TOKEN
  return labeled || CREDENTIAL_OAUTH
}

export function credentialModeOfVm(vm = {}) {
  return normalizeCredentialMode(vm.credential_mode || vm.claude?.mode || vm.claude_mode)
}

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** Relabel a live OAuth grant as setup-token. Keep refresh and real expiry. */
export function liveOauthToSetupToken(oauth = {}) {
  const access = String(oauth.access_token || oauth.accessToken || '').trim()
  if (!access) throw fail('credential_required', '当前槽没有可转换的 OAuth access token')
  if (
    isApiKeyMode(oauth.type || oauth.mode) ||
    looksLikeConsoleApiKey(access) ||
    looksLikeConsoleApiKey(oauth.api_key || oauth.apiKey)
  ) {
    throw fail('credential_kind_mismatch', 'Console API Key 不能转为 Setup Token')
  }
  const identity = flattenOauthIdentity(oauth)
  return {
    type: CREDENTIAL_SETUP_TOKEN,
    mode: CREDENTIAL_SETUP_TOKEN,
    access_token: access,
    refresh_token: String(oauth.refresh_token || oauth.refreshToken || ''),
    expires_at: oauth.expires_at || oauth.expiresAt || null,
    email: identity.email,
    account_uuid: identity.account_uuid,
    org_uuid: identity.org_uuid,
    scope: 'user:inference',
    scopes: ['user:inference'],
    source: 'oauth-to-setup-token',
    auth_scheme: oauth.auth_scheme || oauth.authScheme || undefined,
  }
}
