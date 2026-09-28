/**
 * Slot seed policy + inbound body sanitation.
 * The forwarding layer must never honor client-local settings/identity.
 *
 * Telemetry contract:
 *   telemetry_disabled === false → delete kill-switch keys; sidecar on
 *     CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
 *   otherwise → kill-switch keys = "1"; sidecar off
 *     CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "0"
 * grove_enabled is always false (Help improve Claude off).
 * Official CLI treats any set NONESSENTIAL value, including "0", as
 * essential-traffic (GitHub #84631). The seed still writes the requested
 * literal. Other kill switches must be absent when telemetry is on.
 */

export function isTelemetryEnabled(pol = {}) {
  return pol.telemetry_disabled === false
}

/**
 * Official CLI kill switches. When telemetry is ON these keys must be
 * absent — GitHub #84631: the value "0" still disables.
 * NONESSENTIAL is not in this map; it is always written by the contract.
 */
export const NONESSENTIAL_TRAFFIC_ENV_KEY = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'

export const TELEMETRY_KILL_ENV = Object.freeze({
  DISABLE_TELEMETRY: '1',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
})

export const TELEMETRY_KILL_ENV_KEYS = Object.freeze([...Object.keys(TELEMETRY_KILL_ENV), 'DO_NOT_TRACK'])

/**
 * Leftover keys from older seed / init scripts. They must never survive
 * into settings.env — even as "0" (GitHub #84631) or a local Anthropic
 * hop URL that fights the Go worker + slot SOCKS5 path.
 */
export const LEGACY_SCRIPT_ENV_KEYS = Object.freeze([
  ...TELEMETRY_KILL_ENV_KEYS,
  NONESSENTIAL_TRAFFIC_ENV_KEY,
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_UNIX_SOCKET',
])

/** @deprecated use TELEMETRY_KILL_ENV; kept for panel payloads when telemetry is off */
export const REQUIRED_SEED_ENV = TELEMETRY_KILL_ENV

export function stripLegacyScriptEnv(env = {}) {
  const next = { ...(env && typeof env === 'object' ? env : {}) }
  for (const key of LEGACY_SCRIPT_ENV_KEYS) delete next[key]
  return next
}

export function nonessentialTrafficValue(pol = {}) {
  return isTelemetryEnabled(pol) ? '1' : '0'
}

export function applyRequiredSeedEnv(env = {}, pol = {}) {
  const next = { ...env }
  if (isTelemetryEnabled(pol)) {
    for (const key of TELEMETRY_KILL_ENV_KEYS) delete next[key]
  } else {
    Object.assign(next, TELEMETRY_KILL_ENV)
  }
  next[NONESSENTIAL_TRAFFIC_ENV_KEY] = nonessentialTrafficValue(pol)
  return next
}

/**
 * Authoritative slot settings.env. Extra / leftover script keys are
 * stripped; TZ/LANG come from the slot, then the telemetry contract.
 */
export function buildSlotSettingsEnv(pol = {}, { timezone, locale, extra } = {}) {
  const merged = {
    ...(typeof extra === 'object' && extra ? extra : {}),
    ...(pol.extra_env && typeof pol.extra_env === 'object' ? pol.extra_env : {}),
  }
  const env = stripLegacyScriptEnv(merged)
  if (timezone) env.TZ = String(timezone)
  if (locale) {
    env.LANG = String(locale)
    env.LC_ALL = String(locale)
  }
  if (!isTelemetryEnabled(pol) && pol.do_not_track !== false) env.DO_NOT_TRACK = '1'
  else delete env.DO_NOT_TRACK
  const out = applyRequiredSeedEnv(env, pol)
  // 2.1.283+ sends x-claude-code-prompt-id only when this is set. Default on.
  out.CLAUDE_CODE_GATEWAY_HINT_HEADERS = '1'
  return out
}

export function buildSeedSettingsEnv(pol = {}, extra = {}) {
  return buildSlotSettingsEnv(pol, { extra })
}

export function seedTelemetryContract(pol = {}) {
  const enabled = isTelemetryEnabled(pol)
  return {
    telemetry_enabled: enabled,
    telemetry_disabled: !enabled,
    kill_keys: [...TELEMETRY_KILL_ENV_KEYS],
    required_env: enabled
      ? { [NONESSENTIAL_TRAFFIC_ENV_KEY]: '1' }
      : { ...TELEMETRY_KILL_ENV, [NONESSENTIAL_TRAFFIC_ENV_KEY]: '0' },
    grove_enabled: false,
    note: enabled
      ? 'telemetry on: kill-switch keys deleted; NONESSENTIAL=1; grove_enabled false'
      : 'telemetry off: kill-switch keys written as 1; NONESSENTIAL=0; grove_enabled false',
  }
}

export function defaultSeedPolicy(partial = {}) {
  const telemetryDisabled = partial.telemetry_disabled !== false
  return {
    telemetry_disabled: telemetryDisabled,
    disable_nonessential_traffic: !telemetryDisabled,
    grove_enabled: false,
    do_not_track: telemetryDisabled ? partial.do_not_track !== false : false,
    reject_client_settings: partial.reject_client_settings !== false,
    reject_client_metadata_identity: partial.reject_client_metadata_identity !== false,
    theme: partial.theme || 'dark',
    extra_env: partial.extra_env && typeof partial.extra_env === 'object' ? partial.extra_env : {},
    settings_json_override:
      partial.settings_json_override && typeof partial.settings_json_override === 'object'
        ? partial.settings_json_override
        : null,
  }
}

/**
 * Latest create / official-init default. Telemetry is ON (console「标准」).
 * Do not use this to normalize existing slots that omit the field —
 * those still mean telemetry off via defaultSeedPolicy().
 */
export function standardSeedPolicy(partial = {}) {
  return defaultSeedPolicy({
    telemetry_disabled: false,
    do_not_track: false,
    ...partial,
  })
}

/**
 * Strip client-local settings fingerprints from inbound body.
 * Forwarding layer must not honor client settings.json / machine metadata.
 */
export function sanitizeInboundBody(body, seedPolicy = {}) {
  if (!body || typeof body !== 'object') return body || {}
  const out = { ...body }
  const rejectMeta = seedPolicy.reject_client_metadata_identity !== false
  const rejectSettings = seedPolicy.reject_client_settings !== false
  if (rejectMeta && out.metadata && typeof out.metadata === 'object') {
    const md = { ...out.metadata }
    delete md.user_id
    delete md.userId
    delete md.machine_id
    delete md.machineId
    delete md.session_source
    const allow = {}
    for (const [k, v] of Object.entries(md)) {
      if (!/user|machine|device|host|tz|timezone|locale|setting/i.test(k)) allow[k] = v
    }
    if (Object.keys(allow).length) out.metadata = allow
    else delete out.metadata
  }
  if (rejectSettings) {
    delete out.settings
    delete out.claude_settings
    delete out.env
  }
  if (rejectMeta) {
    delete out.user
    delete out.user_id
  }
  return out
}
