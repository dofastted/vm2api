/**
 * Convert an account export into KIN OAuth import fields.
 * Secrets stay on the returned object; callers must not log them.
 * Device / Windows profile / headers are ignored — official Claude Code
 * on the slot writes those after import.
 */
import { normalizeOauth } from './oauth-credentials.mjs'
import { credentialModeFromOauth, looksLikeConsoleApiKey } from './credential-mode.mjs'
import { resolveAuthScheme } from './auth-scheme.mjs'

export function pickSub2apiAccount(doc = {}) {
  if (!doc || typeof doc !== 'object') return null
  if (doc.credentials && typeof doc.credentials === 'object') return doc
  const accounts = Array.isArray(doc.accounts) ? doc.accounts : []
  return accounts.find((item) => item && typeof item === 'object') || null
}

export function sub2apiAccountToOauth(doc = {}, existing = {}) {
  const account = pickSub2apiAccount(doc) || {}
  const cred =
    account.credentials && typeof account.credentials === 'object'
      ? account.credentials
      : doc.credentials && typeof doc.credentials === 'object'
        ? doc.credentials
        : doc
  const extra = account.extra && typeof account.extra === 'object' ? account.extra : {}
  const n = normalizeOauth({
    ...cred,
    email: cred.email || cred.email_address || extra.email_address || existing.claude?.email,
    account_uuid: cred.account_uuid || extra.account_uuid || existing.claude?.account_uuid,
    org_uuid: cred.org_uuid || extra.org_uuid || existing.claude?.org_uuid,
    source: 'sub2api-account-export',
  })
  const scopes = Array.isArray(cred.scopes)
    ? cred.scopes.filter(Boolean)
    : String(n.scope || cred.scope || '')
        .split(/\s+/)
        .filter(Boolean)
  const mode = credentialModeFromOauth({
    ...cred,
    type: account.type || cred.type || existing.claude?.mode,
    api_key: cred.api_key || cred.apiKey,
    scopes,
    scope: scopes.join(' '),
  })
  return {
    ...n,
    api_key: cred.api_key || cred.apiKey || (looksLikeConsoleApiKey(n.access_token) ? n.access_token : null),
    type: mode,
    mode,
    scopes,
    source: 'sub2api-account-export',
    auth_scheme: resolveAuthScheme({
      mode,
      auth_scheme: extra.anthropic_apikey_auth_scheme || extra.auth_scheme || cred.auth_scheme,
    }),
  }
}

function credHasToken(cred) {
  return !!(
    cred?.access_token ||
    cred?.accessToken ||
    cred?.refresh_token ||
    cred?.refreshToken ||
    cred?.api_key ||
    cred?.apiKey
  )
}

export function isSub2apiAccountExport(doc) {
  if (!doc || typeof doc !== 'object') return false
  if (Array.isArray(doc.accounts)) {
    return doc.accounts.some((item) => credHasToken(item?.credentials || item))
  }
  if (doc.credentials && typeof doc.credentials === 'object') return credHasToken(doc.credentials)
  return false
}

export function panelImportFromOauth(oauth, existing = {}) {
  const n = normalizeOauth(oauth)
  const scopes = Array.isArray(oauth.scopes)
    ? oauth.scopes.filter(Boolean)
    : String(n.scope || '')
        .split(/\s+/)
        .filter(Boolean)
  return {
    access_token: n.access_token,
    refresh_token: n.refresh_token || null,
    expires_at: n.expires_at || null,
    email: n.email || existing.claude?.email || null,
    account_uuid: n.account_uuid || existing.claude?.account_uuid || null,
    org_uuid: n.org_uuid || existing.claude?.org_uuid || null,
    scopes,
    source: n.source || oauth.source || null,
  }
}

function oauthScopes(cred = {}, n = {}) {
  return Array.isArray(cred.scopes)
    ? cred.scopes.filter(Boolean)
    : String(n.scope || cred.scope || '')
        .split(/\s+/)
        .filter(Boolean)
}

/** Build an account export that the import parser can round-trip. */
export function oauthToSub2apiExport(vm = {}, cred = {}, { now = new Date() } = {}) {
  const n = normalizeOauth({
    ...cred,
    email: cred.email || cred.email_address || vm.email || vm.claude?.email,
    account_uuid: cred.account_uuid || vm.account_uuid || vm.claude?.account_uuid,
    org_uuid: cred.org_uuid || vm.org_uuid || vm.claude?.org_uuid,
  })
  const scopes = oauthScopes(cred, n)
  const credentials = {
    access_token: n.access_token || '',
    refresh_token: n.refresh_token || '',
    expires_at: n.expires_at || null,
  }
  if (n.email) {
    credentials.email = n.email
    credentials.email_address = n.email
  }
  if (n.account_uuid) credentials.account_uuid = n.account_uuid
  if (n.org_uuid) credentials.org_uuid = n.org_uuid
  if (scopes.length) {
    credentials.scopes = scopes
    credentials.scope = scopes.join(' ')
  }
  const extra = {}
  if (n.email) extra.email_address = n.email
  if (n.account_uuid) extra.account_uuid = n.account_uuid
  if (n.org_uuid) extra.org_uuid = n.org_uuid
  const mode = credentialModeFromOauth({
    ...cred,
    type: cred.type || cred.mode || vm.claude?.mode,
    api_key: cred.api_key || cred.apiKey,
    scopes,
    scope: scopes.join(' '),
  })
  const authScheme = resolveAuthScheme({
    mode,
    auth_scheme: cred.auth_scheme || cred.authScheme || vm.claude?.auth_scheme,
  })
  if (authScheme) extra.anthropic_apikey_auth_scheme = authScheme
  if (mode === 'apikey') {
    credentials.api_key = cred.api_key || cred.apiKey || n.access_token || ''
    credentials.base_url = cred.base_url || cred.baseUrl || 'https://api.anthropic.com'
    delete credentials.access_token
    delete credentials.refresh_token
    delete credentials.expires_at
  }
  const account = {
    name: vm.name || vm.id || 'claude-oauth',
    platform: 'anthropic',
    type: mode,
    credentials,
  }
  if (Object.keys(extra).length) account.extra = extra
  const conc = Number(vm.max_concurrency)
  if (Number.isFinite(conc) && conc > 0) account.concurrency = conc
  return {
    type: 'sub2api-data',
    version: 1,
    exported_at: now.toISOString(),
    accounts: [account],
  }
}

/** Accept GET payload, full export, single account, or raw oauth fields. */
export function parseCredentialEdit(doc) {
  if (!doc || typeof doc !== 'object') return null
  const nested = doc.export && typeof doc.export === 'object' ? doc.export : doc
  if (isSub2apiAccountExport(nested) || credHasToken(nested) || credHasToken(nested.credentials)) {
    return sub2apiAccountToOauth(nested)
  }
  return null
}
