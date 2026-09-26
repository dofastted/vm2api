/**
 * Exchange-time OAuth account identity.
 * Flatten helper/token shapes, then fill gaps from claude_cli/bootstrap.
 * This is part of ticket exchange, not official Claude Code first-run.
 */
import { makeSocksFetch } from '../protocol/codex-models.mjs'
import { OFFICIAL_CLAUDE_CLI_UA, OFFICIAL_STAINLESS } from '../identity/vm-identity.mjs'
import { BETA_OAUTH } from '../protocol/claude-code-betas.mjs'

export const CLAUDE_CLI_BOOTSTRAP_URL =
  'https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=claude-vscode&model=claude-opus-5'

function firstText(...values) {
  for (const value of values) {
    const text = String(value || '').trim()
    if (text) return text
  }
  return null
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function flattenOauthIdentity(raw = {}) {
  const account = asObject(raw.account)
  const organization = asObject(raw.organization)
  const oauthAccount = asObject(raw.oauth_account)
  const profile = asObject(raw.profile)
  return {
    email: firstText(
      raw.email,
      raw.email_address,
      raw.emailAddress,
      account.email_address,
      account.email,
      oauthAccount.account_email,
      oauthAccount.email,
      profile.email,
    ),
    account_uuid: firstText(
      raw.account_uuid,
      raw.accountUuid,
      account.uuid,
      account.account_uuid,
      oauthAccount.account_uuid,
      profile.account_uuid,
    ),
    org_uuid: firstText(
      raw.org_uuid,
      raw.orgUuid,
      raw.organization_uuid,
      organization.uuid,
      organization.org_uuid,
      organization.organization_uuid,
      oauthAccount.organization_uuid,
      profile.organization_uuid,
    ),
  }
}

export function oauthIdentityComplete(identity = {}) {
  return !!(identity.email && identity.account_uuid && identity.org_uuid)
}

export function applyOauthIdentity(cred = {}, identity = {}) {
  const next = { ...cred }
  if (identity.email) {
    next.email = identity.email
    next.email_address = identity.email
  }
  if (identity.account_uuid) next.account_uuid = identity.account_uuid
  if (identity.org_uuid) next.org_uuid = identity.org_uuid
  return next
}

export function bootstrapRequestHeaders(accessToken) {
  return {
    accept: 'application/json',
    authorization: `Bearer ${String(accessToken || '').trim()}`,
    'user-agent': OFFICIAL_CLAUDE_CLI_UA,
    'anthropic-beta': BETA_OAUTH,
    'anthropic-version': '2023-06-01',
    'x-stainless-lang': OFFICIAL_STAINLESS.stainless_lang,
    'x-stainless-os': OFFICIAL_STAINLESS.stainless_os,
    'x-stainless-arch': OFFICIAL_STAINLESS.stainless_arch,
    'x-stainless-runtime': OFFICIAL_STAINLESS.stainless_runtime,
    'x-stainless-runtime-version': OFFICIAL_STAINLESS.stainless_runtime_version,
    'x-stainless-package-version': OFFICIAL_STAINLESS.stainless_package_version,
  }
}

export async function fetchOauthBootstrapAccount({
  accessToken,
  proxyUrl = null,
  fetchImpl = null,
  timeoutMs = 15000,
} = {}) {
  const token = String(accessToken || '').trim()
  if (!token) return { ok: false, reason: 'no_access_token' }
  if (proxyUrl == null && !fetchImpl) return { ok: false, reason: 'proxy_required' }
  const fetchFn = fetchImpl || makeSocksFetch(proxyUrl, timeoutMs)
  try {
    const res = await fetchFn(CLAUDE_CLI_BOOTSTRAP_URL, {
      method: 'GET',
      headers: bootstrapRequestHeaders(token),
    })
    if (!res || typeof res.ok !== 'boolean') return { ok: false, reason: 'bootstrap_no_response' }
    if (!res.ok) return { ok: false, reason: `http_${res.status || 0}` }
    const body = typeof res.json === 'function' ? await res.json() : null
    const identity = flattenOauthIdentity(body || {})
    if (!identity.email && !identity.account_uuid && !identity.org_uuid) {
      return { ok: false, reason: 'empty_identity' }
    }
    return { ok: true, identity }
  } catch (err) {
    return { ok: false, reason: String(err?.message || err).slice(0, 180) }
  }
}

/** Flatten first. Only fetch bootstrap when email / account / org is still missing. */
export async function enrichOauthIdentity(cred, { proxyUrl = null, fetchImpl = null } = {}) {
  const fromCred = flattenOauthIdentity(cred)
  let next = applyOauthIdentity(cred, fromCred)
  if (oauthIdentityComplete(fromCred)) return next
  const access = next.access_token || next.accessToken
  if (!access) return next
  const fetched = await fetchOauthBootstrapAccount({
    accessToken: access,
    proxyUrl,
    fetchImpl,
  })
  if (!fetched.ok) return next
  return applyOauthIdentity(next, fetched.identity)
}
