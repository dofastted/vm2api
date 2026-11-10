/**
 * Exchange-time OAuth account identity.
 * Flatten helper/token shapes, then fill gaps from claude_cli/bootstrap.
 * This is part of ticket exchange, not official Claude Code first-run.
 */
import { makeProxyFetch } from '../protocol/codex-models.mjs'
import { OFFICIAL_STAINLESS } from '../identity/vm-identity.mjs'
import { BETA_OAUTH, BOOTSTRAP_UA, BOOTSTRAP_URL } from './oauth-contract.mjs'

export const CLAUDE_CLI_BOOTSTRAP_URL = BOOTSTRAP_URL

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

const SUBSCRIPTION_TYPES = new Set(['free', 'pro', 'max', 'team', 'enterprise'])

export function normalizeSubscriptionType(value) {
  const key = String(value || '')
    .trim()
    .toLowerCase()
  return SUBSCRIPTION_TYPES.has(key) ? key : null
}

function subscriptionTypeFromText(text) {
  const blob = String(text || '').toLowerCase()
  if (!blob) return null
  if (/\b(claude[_\s-]*max|max\s*20x)\b/.test(blob)) return 'max'
  if (/\bclaude[_\s-]*enterprise\b/.test(blob)) return 'enterprise'
  if (/\bclaude[_\s-]*team\b/.test(blob)) return 'team'
  if (/\bclaude[_\s-]*pro\b/.test(blob)) return 'pro'
  return null
}

function planFromProfile(profile) {
  const account = profile?.account || {}
  const org = profile?.organization || {}
  const orgType = String(org.organization_type || profile.organization_type || '').toLowerCase()
  const orgPlan = normalizeSubscriptionType(orgType.replace(/^claude_/, ''))
  if (orgPlan === 'team' || orgPlan === 'enterprise') return orgPlan
  if (account.has_claude_max === true || orgPlan === 'max') return 'max'
  const rateTier = String(org.rate_limit_tier || profile.rate_limit_tier || profile.rateLimitTier || '').toLowerCase()
  for (const tier of SUBSCRIPTION_TYPES) {
    if (new RegExp(`(?:^|_)claude_${tier}(?:_|$)`).test(rateTier)) return tier
  }
  if (orgPlan) return orgPlan
  if (account.has_claude_pro === true) return 'pro'
  return null
}

/** Plan from the exchange/bootstrap body. Explicit field, profile, then text. */
export function subscriptionTypeFromOauthRaw(raw) {
  if (raw == null) return null
  if (typeof raw === 'string') return subscriptionTypeFromText(raw)
  if (typeof raw !== 'object') return null
  const explicit = normalizeSubscriptionType(
    raw.subscriptionType || raw.subscription_type || raw.claudeAiOauth?.subscriptionType,
  )
  if (explicit) return explicit
  const profiles = [raw, raw.profile, raw.oauth_profile].filter((item) => item && typeof item === 'object')
  for (const profile of profiles) {
    const tier = planFromProfile(profile)
    if (tier) return tier
  }
  return subscriptionTypeFromText(raw.text)
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
    subscription_type: subscriptionTypeFromOauthRaw(raw),
    rate_limit_tier: firstText(
      raw.rate_limit_tier,
      raw.rateLimitTier,
      raw.claudeAiOauth?.rateLimitTier,
      organization.rate_limit_tier,
      profile.organization?.rate_limit_tier,
      raw.oauth_profile?.organization?.rate_limit_tier,
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
  if (identity.subscription_type) next.subscription_type = identity.subscription_type
  if (identity.rate_limit_tier) next.rate_limit_tier = identity.rate_limit_tier
  return next
}

export function bootstrapRequestHeaders(accessToken) {
  return {
    accept: 'application/json',
    authorization: `Bearer ${String(accessToken || '').trim()}`,
    'user-agent': BOOTSTRAP_UA,
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
  const fetchFn = fetchImpl || makeProxyFetch(proxyUrl, timeoutMs)
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
