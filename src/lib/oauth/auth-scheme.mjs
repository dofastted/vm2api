/**
 * Upstream Anthropic auth header: x-api-key vs Authorization: Bearer.
 * Account exports can override it with `extra.anthropic_apikey_auth_scheme`.
 *
 * Defaults: OAuth / official setup-token → Bearer (Claude Console accepts
 * sk-ant-oat01-… this way). Console API key → x-api-key.
 */
import { credentialModeOfVm, normalizeCredentialMode } from './credential-mode.mjs'

export const AUTH_SCHEME_X_API_KEY = 'x_api_key'
export const AUTH_SCHEME_BEARER = 'authorization_bearer'

export function normalizeAuthScheme(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
  if (
    s === AUTH_SCHEME_BEARER ||
    s === 'bearer' ||
    s === 'authorization' ||
    s === 'authorization_bearer' ||
    s === 'oauth'
  )
    return AUTH_SCHEME_BEARER
  if (s === AUTH_SCHEME_X_API_KEY || s === 'x_api_key' || s === 'apikey' || s === 'api_key')
    return AUTH_SCHEME_X_API_KEY
  return ''
}

export function defaultAuthScheme(mode) {
  return normalizeCredentialMode(mode) === 'apikey' ? AUTH_SCHEME_X_API_KEY : AUTH_SCHEME_BEARER
}

export function resolveAuthScheme({ mode, auth_scheme, authScheme, extra } = {}) {
  const explicit = normalizeAuthScheme(
    auth_scheme || authScheme || extra?.anthropic_apikey_auth_scheme || extra?.auth_scheme,
  )
  return explicit || defaultAuthScheme(mode)
}

export function authSchemeOfVm(vm = {}) {
  return resolveAuthScheme({
    mode: credentialModeOfVm(vm),
    auth_scheme: vm.auth_scheme || vm.claude?.auth_scheme,
  })
}
