/**
 * General-purpose Integration API (`/api/integration/v1/*`) and admin management routes
 * (`/api/panel/integration/*`).
 *
 * Exposes an explicit, scope-gated subset of vm2api capabilities for external control planes:
 *   - Overview metrics (sanitized dashboard snapshot)
 *   - VM & Gemini environment lifecycle (list / get / create / start / stop / delete)
 *   - SOCKS5 / HTTP proxy pool (list / import / probe / bind / unbind / delete)
 *   - Account credential onboarding (OAuth auth URL / code exchange / import / Gemini OAuth)
 *   - Official API key endpoints (list / create / update / delete / manage upstream keys)
 *   - Scoped inference API keys (list / create / update / delete)
 *
 * Non-whitelisted routes (system upgrades, kernels, cluster SSH, DB metrics, backups,
 * panel users, secret reveal endpoints, interactive shells) are strictly unreachable.
 */

import { hasIntegrationScope, INTEGRATION_SCOPES } from './integration-tokens.mjs'
import {
  normalizeGroupType,
  normalizeKeyCategory,
  normalizePermissionTier,
  parseAllowedIds,
  parseAllowedVms,
} from './key-scope.mjs'
import { normalizeOwnerId } from './resource-owner.mjs'

export const INTEGRATION_API_PREFIX = '/api/integration/v1'
export const INTEGRATION_DELEGATED = Symbol.for('vm2api.integrationDelegated')

const MAX_JSON_BODY = 2 * 1024 * 1024
const ID_PART = '([^/]+)'

function errBody(code, message, extra = null) {
  const error = { code, message }
  if (extra && typeof extra === 'object') Object.assign(error, extra)
  return { ok: false, error }
}

function projectOverview(raw) {
  if (!raw || typeof raw !== 'object') return raw
  const vms = Array.isArray(raw.vms)
    ? raw.vms.map((v) => ({
      id: v.id,
      name: v.name,
      owner_user_id: v.owner_user_id ?? null,
      platform: v.platform || null,
      family: v.family || null,
      status: v.status || 'unknown',
      schedulable: v.schedulable !== false,
      schedule_state: v.schedule_state || null,
      schedule_disabled_reason: v.schedule_disabled_reason || null,
      has_token: Boolean(v.has_token),
      has_refresh: Boolean(v.has_refresh),
      inflight: Number(v.inflight) || 0,
      active_requests: Number(v.active_requests) || 0,
      fable_inflight: Number(v.fable_inflight) || 0,
      queue_depth: Number(v.queue_depth) || 0,
      proxy_configured: Boolean(v.proxy_configured),
      proxy: v.proxy
        ? {
          id: v.proxy.id || null,
          host: v.proxy.host || null,
          port: v.proxy.port ?? null,
          status: v.proxy.status || null,
        }
        : null,
    }))
    : []

  const billing = raw.billing
    ? {
      today: raw.billing.today || null,
      total: raw.billing.total || null,
    }
    : null

  return {
    health: raw.health
      ? {
        status: raw.health.status || 'ok',
        service: raw.health.service || 'vm2api',
      }
      : { status: 'ok', service: 'vm2api' },
    summary: raw.summary || {},
    proxy_pool: raw.proxy_pool || null,
    vms,
    billing,
    ops: raw.ops || null,
    gateway_stats: raw.gateway_stats || null,
  }
}

function projectProxyPool(raw) {
  if (!raw || typeof raw !== 'object') return raw
  const config = raw.config && typeof raw.config === 'object' ? { ...raw.config } : undefined
  if (config) {
    delete config.dns_primary
    delete config.dns_disable_svcb_https
  }
  return {
    ...raw,
    ...(config ? { config } : {}),
  }
}

function sanitizeVmCreateBody(body = {}) {
  const allowed = [
    'id',
    'name',
    'owner_user_id',
    'platform',
    'family',
    'proxy_id',
    'runtime_type',
    'kernel',
    'locale',
    'region',
    'timezone',
    'machine',
    'start',
    'status',
    'max_concurrency',
    'max_rpm',
    'max_sessions',
    'dataplane',
  ]
  const out = {}
  for (const key of allowed) {
    if (Object.hasOwn(body, key)) out[key] = body[key]
  }
  return out
}

function sanitizeApiEndpointWriteBody(body = {}) {
  const allowed = [
    'name',
    'kind',
    'protocol',
    'base_url',
    'prefix',
    'priority',
    'headers',
    'models',
    'api_key',
    'api_key_entries',
    'key_id',
    'proxy_id',
    'proxy_url',
    'auth_scheme',
    'body_policy',
    'disable_cooling',
    'disabled',
    'risk_review_enabled',
    'owner_user_id',
    'fetched_models',
  ]
  const out = {}
  for (const key of allowed) {
    if (Object.hasOwn(body, key)) out[key] = body[key]
  }
  return out
}

function stripEndpointSecrets(ep) {
  if (!ep || typeof ep !== 'object') return ep
  const copy = { ...ep }
  if (Array.isArray(copy.api_key_entries)) {
    copy.api_key_entries = copy.api_key_entries.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry
      const safe = { ...entry }
      delete safe.api_key
      return safe
    })
  }
  return copy
}

function sanitizeApiKeyWriteBody(body = {}, { isCreate = false, allowGlobal = false } = {}) {
  const allowed = [
    'name',
    'status',
    'category',
    'permission_tier',
    'owner_id',
    'group_type',
    'allowed_vms',
    'api_endpoint_id',
    'allowed_endpoints',
    'allowed_gemini_envs',
    'allowed_models',
    'max_concurrency',
    'rpm',
    'rate_limit_rpm',
    'quota',
    'quota_usd',
    'quota_requests',
    'rate_limit_5h',
    'rate_limit_1d',
    'rate_limit_7d',
    'expires_at',
    'expires_in_days',
  ]
  const out = {}
  for (const key of allowed) {
    if (Object.hasOwn(body, key)) out[key] = body[key]
  }

  const hasType = out.group_type != null && String(out.group_type).trim() !== ''
  const groupType = hasType ? normalizeGroupType(out.group_type, { fallback: null }) : isCreate ? 'all' : null
  if (hasType && !groupType) {
    throw Object.assign(new Error('group_type must be one of all, anthropic, openai, gemini'), {
      status: 400,
      code: 'invalid_group_type',
    })
  }

  const hasCat = out.category != null && String(out.category).trim() !== ''
  const category = hasCat ? normalizeKeyCategory(out.category, { fallback: null }) : isCreate ? 'oauth' : null
  if (hasCat && !category) {
    throw Object.assign(new Error('category must be one of oauth, api, all'), {
      status: 400,
      code: 'invalid_key_category',
    })
  }

  const ownerId = normalizeOwnerId(out.owner_id)
  const hasTier = out.permission_tier != null && String(out.permission_tier).trim() !== ''
  const tier = hasTier
    ? normalizePermissionTier(out.permission_tier, { fallback: null })
    : ownerId
      ? 'tenant'
      : 'platform'
  if (hasTier && !tier) {
    throw Object.assign(new Error('permission_tier must be one of platform, tenant, resource'), {
      status: 400,
      code: 'invalid_permission_tier',
    })
  }
  if (tier === 'tenant' && !ownerId) {
    throw Object.assign(new Error('tenant permission_tier requires a non-empty owner_id'), {
      status: 400,
      code: 'key_owner_required',
    })
  }
  if (tier === 'platform' && ownerId) {
    throw Object.assign(new Error('platform permission_tier cannot bind a tenant owner_id'), {
      status: 400,
      code: 'invalid_permission_tier',
    })
  }

  const vms = parseAllowedVms(out.allowed_vms)
  const endpoints = parseAllowedIds(out.allowed_endpoints)
  const geminiEnvs = parseAllowedIds(out.allowed_gemini_envs)
  const pinnedEndpointId = normalizeOwnerId(out.api_endpoint_id)

  // Enforce strict isolation unless the integration token explicitly has `keys:global`:
  // - `tenant` tier with explicit `owner_id` is isolated to that owner's resources.
  // - `resource` tier with explicit non-empty resource pins is isolated to those exact IDs.
  // - `platform` tier cannot create unscoped `group_type: 'all'` keys without `keys:global`.
  if (!allowGlobal) {
    if (tier === 'resource') {
      if (isCreate && vms.length === 0 && endpoints.length === 0 && !pinnedEndpointId && geminiEnvs.length === 0) {
        throw Object.assign(
          new Error('resource permission_tier requires at least one pinned VM, API endpoint, or Gemini environment'),
          { status: 400, code: 'key_resources_required' },
        )
      }
    } else if (tier === 'platform') {
      if (groupType === 'all') {
        throw Object.assign(
          new Error(
            'Global unscoped platform API keys require the keys:global integration scope; specify permission_tier/owner_id or group_type and allowed_vms',
          ),
          { status: 403, code: 'scope_denied' },
        )
      }
      if (isCreate && groupType !== 'gemini') {
        if (category === 'api') {
          if (endpoints.length === 0 && !pinnedEndpointId) {
            throw Object.assign(new Error('allowed_endpoints or api_endpoint_id is required for scoped api keys'), {
              status: 400,
              code: 'key_resources_required',
            })
          }
        } else if (vms.length === 0) {
          throw Object.assign(new Error('allowed_vms must be a non-empty list of VM IDs'), {
            status: 400,
            code: 'key_vms_required',
          })
        }
      }
    }
  }
  if (Object.hasOwn(out, 'allowed_vms')) out.allowed_vms = vms
  if (Object.hasOwn(out, 'allowed_endpoints')) out.allowed_endpoints = endpoints
  if (Object.hasOwn(out, 'allowed_gemini_envs')) out.allowed_gemini_envs = geminiEnvs
  return out
}

function normalizeEnvelope(status, payload, { project = null, unwrapItem = false } = {}) {
  if (payload && typeof payload === 'object' && payload.ok === false) {
    return { status, body: payload }
  }
  if (status >= 400) {
    if (payload && typeof payload === 'object' && payload.error) {
      return { status, body: { ok: false, error: payload.error } }
    }
    return { status, body: errBody('request_failed', 'Request failed') }
  }
  let data = payload
  if (payload && typeof payload === 'object') {
    if (Object.hasOwn(payload, 'data')) {
      data = payload.data
    } else if (unwrapItem && Object.hasOwn(payload, 'item')) {
      data = payload.item
    } else if (payload.ok === true) {
      const copy = { ...payload }
      delete copy.ok
      data = copy
    }
  }
  if (typeof project === 'function') {
    data = project(data)
  }
  return { status, body: { ok: true, data } }
}

/**
 * Resolve an incoming `/api/integration/v1/*` path + method against the strict allowlist.
 * Returns null if the route is not exposed.
 */
export function matchIntegrationRoute(method, pathname) {
  const m = String(method || 'GET').toUpperCase()
  const p = String(pathname || '')
  if (!p.startsWith(INTEGRATION_API_PREFIX)) return null
  const sub = p.slice(INTEGRATION_API_PREFIX.length) || '/'

  if (m === 'GET' && (sub === '/ping' || sub === '/meta')) {
    return { kind: 'ping', scope: null }
  }

  // 1. Overview / dashboard metrics
  if (m === 'GET' && (sub === '/overview' || sub === '/dashboard')) {
    return {
      kind: 'delegate',
      scope: 'overview:read',
      panelPath: '/api/panel/dashboard',
      project: projectOverview,
    }
  }

  // 2. VM lifecycle & Gemini environments
  if (m === 'GET' && sub === '/vms') {
    return { kind: 'delegate', scope: 'vms:read', panelPath: '/api/panel/vms' }
  }
  if (m === 'POST' && sub === '/vms') {
    return {
      kind: 'delegate',
      scope: 'vms:write',
      panelPath: '/api/panel/vms/create',
      sanitizeBody: (body) => sanitizeVmCreateBody(body),
    }
  }
  if (m === 'POST' && sub === '/vms/import') {
    return { kind: 'delegate', scope: 'credentials:write', panelPath: '/api/panel/vms/import' }
  }
  let match = new RegExp(`^/vms/${ID_PART}$`).exec(sub)
  if (match) {
    const id = match[1]
    if (m === 'GET') return { kind: 'delegate', scope: 'vms:read', panelPath: `/api/panel/vms/${id}` }
    if (m === 'DELETE') return { kind: 'delegate', scope: 'vms:write', panelPath: `/api/panel/vms/${id}` }
  }
  match = new RegExp(`^/vms/${ID_PART}/(start|stop)$`).exec(sub)
  if (match && m === 'POST') {
    return { kind: 'delegate', scope: 'vms:write', panelPath: `/api/panel/vms/${match[1]}/${match[2]}` }
  }

  // 3. Account OAuth onboarding
  match = new RegExp(`^/vms/${ID_PART}/oauth/auth-url$`).exec(sub)
  if (match && m === 'POST') {
    return {
      kind: 'delegate',
      scope: 'credentials:write',
      panelPath: `/api/panel/vms/${match[1]}/oauth/generate-auth-url`,
    }
  }
  match = new RegExp(`^/vms/${ID_PART}/oauth/exchange$`).exec(sub)
  if (match && m === 'POST') {
    return {
      kind: 'delegate',
      scope: 'credentials:write',
      panelPath: `/api/panel/vms/${match[1]}/oauth/exchange-code`,
    }
  }

  // Gemini environments & OAuth
  if (sub === '/gemini/environments') {
    if (m === 'GET') return { kind: 'delegate', scope: 'vms:read', panelPath: '/api/panel/gemini' }
    if (m === 'POST') return { kind: 'delegate', scope: 'vms:write', panelPath: '/api/panel/gemini/environments' }
  }
  match = new RegExp(`^/gemini/environments/${ID_PART}$`).exec(sub)
  if (match) {
    if (m === 'GET')
      return { kind: 'delegate', scope: 'vms:read', panelPath: `/api/panel/gemini/environments/${match[1]}` }
    if (m === 'DELETE')
      return { kind: 'delegate', scope: 'vms:write', panelPath: `/api/panel/gemini/environments/${match[1]}` }
  }
  match = new RegExp(`^/gemini/environments/${ID_PART}/authorization$`).exec(sub)
  if (match && (m === 'POST' || m === 'PUT')) {
    return {
      kind: 'delegate',
      scope: 'credentials:write',
      panelPath: `/api/panel/gemini/environments/${match[1]}/authorization`,
    }
  }

  // 3b. Official API key channels (tenant-isolated, never returns plaintext upstream keys)
  if (m === 'GET' && sub === '/api-endpoints') {
    return {
      kind: 'delegate',
      scope: 'endpoints:read',
      panelPath: '/api/panel/api-endpoints',
      project: (d) => ({
        items: Array.isArray(d?.items) ? d.items.map(stripEndpointSecrets) : [],
      }),
    }
  }
  if (m === 'POST' && sub === '/api-endpoints') {
    return {
      kind: 'delegate',
      scope: 'endpoints:write',
      panelPath: '/api/panel/api-endpoints',
      unwrapItem: true,
      sanitizeBody: (body) => sanitizeApiEndpointWriteBody(body),
      project: stripEndpointSecrets,
    }
  }
  match = new RegExp(`^/api-endpoints/${ID_PART}$`).exec(sub)
  if (match) {
    if (m === 'PATCH') {
      return {
        kind: 'delegate',
        scope: 'endpoints:write',
        panelPath: `/api/panel/api-endpoints/${match[1]}`,
        unwrapItem: true,
        sanitizeBody: (body) => sanitizeApiEndpointWriteBody(body),
        project: stripEndpointSecrets,
      }
    }
    if (m === 'DELETE') {
      return { kind: 'delegate', scope: 'endpoints:write', panelPath: `/api/panel/api-endpoints/${match[1]}` }
    }
  }
  match = new RegExp(`^/api-endpoints/${ID_PART}/keys$`).exec(sub)
  if (match && m === 'POST') {
    return {
      kind: 'delegate',
      scope: 'endpoints:write',
      panelPath: `/api/panel/api-endpoints/${match[1]}/keys`,
      unwrapItem: true,
      project: (entry) => {
        if (!entry || typeof entry !== 'object') return entry
        const safe = { ...entry }
        delete safe.api_key
        return safe
      },
    }
  }
  match = new RegExp(`^/api-endpoints/${ID_PART}/keys/${ID_PART}$`).exec(sub)
  if (match && m === 'DELETE') {
    return {
      kind: 'delegate',
      scope: 'endpoints:write',
      panelPath: `/api/panel/api-endpoints/${match[1]}/keys/${match[2]}`,
    }
  }

  // 4. SOCKS5 / HTTP proxy pool (explicitly excludes /reveal)
  if (m === 'GET' && sub === '/proxies') {
    return {
      kind: 'delegate',
      scope: 'proxies:read',
      panelPath: '/api/panel/proxies',
      project: projectProxyPool,
    }
  }
  if (m === 'POST' && sub === '/proxies/import') {
    return { kind: 'delegate', scope: 'proxies:write', panelPath: '/api/panel/proxies/import' }
  }
  match = new RegExp(`^/proxies/${ID_PART}/(probe|bind|unbind)$`).exec(sub)
  if (match && m === 'POST') {
    return { kind: 'delegate', scope: 'proxies:write', panelPath: `/api/panel/proxies/${match[1]}/${match[2]}` }
  }
  match = new RegExp(`^/proxies/${ID_PART}$`).exec(sub)
  if (match && m === 'DELETE') {
    return { kind: 'delegate', scope: 'proxies:write', panelPath: `/api/panel/proxies/${match[1]}` }
  }

  // 5. Scoped inference API keys (explicitly excludes /reveal)
  if (m === 'GET' && sub === '/api-keys') {
    return {
      kind: 'delegate',
      scope: 'keys:read',
      panelPath: '/api/panel/api-keys',
      project: (d) => ({
        items: Array.isArray(d?.keys) ? d.keys : Array.isArray(d?.items) ? d.items : [],
        total: Number(d?.total) || 0,
        active: Number(d?.active) || 0,
      }),
    }
  }
  if (m === 'POST' && sub === '/api-keys') {
    return {
      kind: 'delegate',
      scope: 'keys:write',
      panelPath: '/api/panel/api-keys',
      unwrapItem: true,
      sanitizeBody: (body, token) =>
        sanitizeApiKeyWriteBody(body, {
          isCreate: true,
          allowGlobal: hasIntegrationScope(token, 'keys:global'),
        }),
    }
  }
  match = new RegExp(`^/api-keys/${ID_PART}$`).exec(sub)
  if (match) {
    if (m === 'PATCH') {
      return {
        kind: 'delegate',
        scope: 'keys:write',
        panelPath: `/api/panel/api-keys/${match[1]}`,
        unwrapItem: true,
        sanitizeBody: (body, token) =>
          sanitizeApiKeyWriteBody(body, {
            isCreate: false,
            allowGlobal: hasIntegrationScope(token, 'keys:global'),
          }),
      }
    }
    if (m === 'DELETE') {
      return { kind: 'delegate', scope: 'keys:write', panelPath: `/api/panel/api-keys/${match[1]}` }
    }
  }

  return null
}

/**
 * Handler for `/api/integration/v1/*`.
 */
export function createIntegrationHandler({ tokenStore, handlePanel, json, readBody }) {
  return async function handleIntegration(req, res, url) {
    const p = url.pathname
    if (!p.startsWith('/api/integration')) return false

    if (typeof res?.setHeader === 'function') {
      res.setHeader('Cache-Control', 'no-store')
    }

    const auth = tokenStore.authenticate(req)
    if (!auth.ok) {
      json(res, auth.status || 401, errBody(auth.code, auth.message))
      return true
    }

    const route = matchIntegrationRoute(req.method, p)
    if (!route) {
      json(res, 404, errBody('not_found', `integration endpoint not found: ${req.method} ${p}`))
      return true
    }

    if (route.scope && !hasIntegrationScope(auth.token, route.scope)) {
      json(
        res,
        403,
        errBody('scope_denied', `Integration token lacks required scope '${route.scope}'`, {
          required_scope: route.scope,
        }),
      )
      return true
    }

    if (route.kind === 'ping') {
      json(res, 200, {
        ok: true,
        data: {
          service: 'vm2api',
          api_version: 'v1',
          token: {
            id: auth.token.id,
            name: auth.token.name,
            scopes: auth.token.scopes,
          },
          available_scopes: [...INTEGRATION_SCOPES],
          policy: {
            allow_remote: auth.config.allow_remote,
          },
        },
      })
      return true
    }

    // Pre-parse and sanitize body when the route requires write-boundary filtering.
    let sanitizedBody = null
    let hasSanitizedBody = false
    if (typeof route.sanitizeBody === 'function') {
      let rawBody
      try {
        rawBody = await readBody(req, MAX_JSON_BODY)
      } catch (err) {
        json(res, err?.status || 400, errBody(err?.code || 'invalid_json', err?.message || 'Invalid JSON body'))
        return true
      }
      try {
        sanitizedBody = route.sanitizeBody(rawBody || {}, auth.token)
        hasSanitizedBody = true
      } catch (err) {
        json(res, err?.status || 400, errBody(err?.code || 'invalid_request', err?.message || 'Invalid request body'))
        return true
      }
    }

    const mappedUrl = new URL(url.href)
    mappedUrl.pathname = route.panelPath

    const prevDelegated = req[INTEGRATION_DELEGATED]
    const prevReadBody = req._integrationReadBody
    const prevJson = res._integrationJson
    const prevRole = req.panelRole
    const prevUser = req.panelUser
    const prevApiKeyKind = req.apiKeyKind

    req[INTEGRATION_DELEGATED] = true
    if (hasSanitizedBody) {
      req._integrationReadBody = async () => sanitizedBody
    }
    res._integrationJson = (targetRes, status, payload) => {
      const normalized = normalizeEnvelope(status, payload, {
        project: route.project,
        unwrapItem: route.unwrapItem,
      })
      return json(targetRes, normalized.status, normalized.body)
    }

    try {
      const handled = await handlePanel(req, res, mappedUrl)
      if (handled === false && !res.headersSent) {
        json(res, 404, errBody('not_found', `integration endpoint unavailable: ${req.method} ${p}`))
      }
      return true
    } finally {
      if (prevDelegated === undefined) delete req[INTEGRATION_DELEGATED]
      else req[INTEGRATION_DELEGATED] = prevDelegated
      if (prevReadBody === undefined) delete req._integrationReadBody
      else req._integrationReadBody = prevReadBody
      if (prevJson === undefined) delete res._integrationJson
      else res._integrationJson = prevJson
      if (prevRole === undefined) delete req.panelRole
      else req.panelRole = prevRole
      if (prevUser === undefined) delete req.panelUser
      else req.panelUser = prevUser
      if (prevApiKeyKind === undefined) delete req.apiKeyKind
      else req.apiKeyKind = prevApiKeyKind
    }
  }
}

/**
 * Admin-only management routes under `/api/panel/integration/*`.
 * Caller must already be authenticated and authorized as panel `admin`.
 */
export async function handleIntegrationAdminRoute(req, res, pathname, { tokenStore, json, readBody }) {
  if (!pathname.startsWith('/api/panel/integration')) return false

  if (req.method === 'GET' && pathname === '/api/panel/integration/config') {
    json(res, 200, { ok: true, data: tokenStore.getConfig() })
    return true
  }
  if (req.method === 'PUT' && pathname === '/api/panel/integration/config') {
    const body = await readBody(req, 16 * 1024).catch(() => null)
    if (!body || typeof body !== 'object') {
      json(res, 400, errBody('invalid_json', 'Request body must be a JSON object'))
      return true
    }
    try {
      const updated = tokenStore.updateConfig(body)
      json(res, 200, { ok: true, data: updated })
    } catch (e) {
      json(res, 400, errBody(e.code || 'invalid_config', String(e.message || e)))
    }
    return true
  }
  if (req.method === 'GET' && pathname === '/api/panel/integration/tokens') {
    json(res, 200, {
      ok: true,
      data: {
        items: tokenStore.listTokens(),
        available_scopes: [...INTEGRATION_SCOPES],
      },
    })
    return true
  }
  if (req.method === 'POST' && pathname === '/api/panel/integration/tokens') {
    const body = await readBody(req, 16 * 1024).catch(() => null)
    if (!body || typeof body !== 'object') {
      json(res, 400, errBody('invalid_json', 'Request body must be a JSON object'))
      return true
    }
    try {
      const created = tokenStore.createToken(body)
      json(res, 201, {
        ok: true,
        data: {
          item: created.item,
          token: created.token,
        },
        note: 'Plaintext integration token is shown only once; store it securely.',
      })
    } catch (e) {
      json(res, 400, errBody(e.code || 'create_failed', String(e.message || e)))
    }
    return true
  }
  const tokenMatch = /^\/api\/panel\/integration\/tokens\/([^/]+)$/.exec(pathname)
  if (tokenMatch) {
    const id = decodeURIComponent(tokenMatch[1])
    if (req.method === 'PATCH') {
      const body = await readBody(req, 16 * 1024).catch(() => null)
      if (!body || typeof body !== 'object') {
        json(res, 400, errBody('invalid_json', 'Request body must be a JSON object'))
        return true
      }
      try {
        const updated = tokenStore.updateToken(id, body)
        if (!updated) {
          json(res, 404, errBody('not_found', 'Integration token not found'))
          return true
        }
        json(res, 200, { ok: true, data: { item: updated } })
      } catch (e) {
        const status = e.code === 'env_token_immutable' ? 409 : 400
        json(res, status, errBody(e.code || 'update_failed', String(e.message || e)))
      }
      return true
    }
    if (req.method === 'DELETE') {
      try {
        const deleted = tokenStore.deleteToken(id)
        if (!deleted) {
          json(res, 404, errBody('not_found', 'Integration token not found'))
          return true
        }
        json(res, 200, { ok: true, data: { deleted: id } })
      } catch (e) {
        const status = e.code === 'env_token_immutable' ? 409 : 400
        json(res, status, errBody(e.code || 'delete_failed', String(e.message || e)))
      }
      return true
    }
  }
  return false
}
