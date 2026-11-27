import crypto from 'node:crypto'
import { CLAUDE_OFFICIAL_URL, OPENAI_OFFICIAL_URL, normalizeProtocol, trimBaseUrl } from './api-presets.mjs'
import {
  canonicalizeDottedClaudeId,
  isCatalogModelId,
  isCodexCatalogModel,
  listGptPublicModels,
  listOfficialModels,
  resolveCatalogModel,
} from '../protocol/models.mjs'
import { isGptSeriesId } from '../protocol/gpt-ids.mjs'
import { PLATFORM_SCOPE, endpointMatchesOwnerScope } from '../admin/resource-owner.mjs'
import {
  SchedulerUnavailableError,
  VIRTUAL_POOL_IDS,
  formatNodeKey,
  inferModelFamily,
} from '../scheduler/scheduler-runtime.mjs'

/**
 * API Direct endpoint catalog, model resolver, and Rust `kin-scheduler` dispatch facade.
 *
 * M3 cutover (D4): legacy Node round-robin cursors (`parentCursor`, `childCursor`,
 * `modelCursor`) are completely removed. Endpoint selection, sticky affinity,
 * weight-tiering, SWRR, cooldowns, and session FIFO serialization are owned solely
 * by Rust `kin-scheduler` (Fail-Closed 503 when unavailable).
 */

function norm(s) {
  return String(s || '').trim()
}

function lower(s) {
  return norm(s).toLowerCase()
}

function isOfficialClaude(ep) {
  if (!ep) return false
  if (ep.kind === 'claude') return true
  const u = trimBaseUrl(ep.base_url)
  return u === CLAUDE_OFFICIAL_URL
}

function isOfficialOpenAI(ep) {
  if (!ep) return false
  if (ep.kind === 'openai') return true
  const u = trimBaseUrl(ep.base_url)
  return u === OPENAI_OFFICIAL_URL
}

export function stripPrefix(model, prefix) {
  const p = norm(prefix)
  if (!p) return norm(model)
  const needle = `${p}/`
  const raw = norm(model)
  if (raw.toLowerCase().startsWith(needle.toLowerCase())) return raw.slice(needle.length)
  return raw
}

export function modelIdsForEndpoint(ep, { forcePrefix = false } = {}) {
  const prefix = norm(ep.prefix)
  const ids = []
  const seen = new Set()
  const add = (alias) => {
    const a = norm(alias)
    if (!a) return
    if (!forcePrefix || !prefix) {
      if (!seen.has(lower(a))) {
        seen.add(lower(a))
        ids.push(a)
      }
    }
    if (prefix) {
      const pref = `${prefix}/${a}`
      if (!seen.has(lower(pref))) {
        seen.add(lower(pref))
        ids.push(pref)
      }
    }
  }
  for (const m of ep?.models || []) {
    add(m.alias || m.name)
  }
  if (isOfficialClaude(ep)) {
    try {
      for (const m of listOfficialModels()) {
        add(m.id)
      }
    } catch {}
  } else if (isOfficialOpenAI(ep)) {
    try {
      for (const m of listGptPublicModels()) {
        add(m.id)
      }
    } catch {}
  }
  return ids
}

export function resolveUpstreamPool(ep, requestedModel) {
  const want = lower(stripPrefix(requestedModel, ep?.prefix))
  if (!want) return []
  const out = []
  const seen = new Set()
  for (const m of ep?.models || []) {
    if (lower(m.alias) !== want) continue
    const name = norm(m.name) || norm(m.alias)
    const key = lower(name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  if (out.length > 0) return out
  if (isOfficialClaude(ep)) {
    const raw = stripPrefix(requestedModel, ep?.prefix)
    const resolved = resolveCatalogModel(raw)
    if (resolved?.ok && resolved.model) return [resolved.model]
    const canonical = canonicalizeDottedClaudeId(raw)
    if (isCatalogModelId(canonical)) return [canonical]
  } else if (isOfficialOpenAI(ep)) {
    const raw = stripPrefix(requestedModel, ep?.prefix)
    if (isGptSeriesId(raw) || isCodexCatalogModel(raw)) return [raw]
  }
  return []
}

export function endpointMatchesModel(ep, requestedModel) {
  if (!ep || ep.disabled) return false
  const raw = norm(requestedModel)
  const prefix = norm(ep.prefix)
  if (prefix && raw.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) {
    return resolveUpstreamPool(ep, raw).length > 0
  }
  return resolveUpstreamPool(ep, raw).length > 0
}

function keyReady(key, now, disableCooling) {
  if (!key || key.disabled) return false
  if (disableCooling) return true
  if (!key.cooldown_until) return true
  return Date.parse(key.cooldown_until) <= now
}

function endpointMatchesFilters(
  ep,
  { groupType = 'all', endpointId = null, ownerScope = PLATFORM_SCOPE, allowedEndpointIds = null } = {},
) {
  if (!ep || ep.disabled) return false
  if (!endpointMatchesOwnerScope(ep, ownerScope)) return false
  if (endpointId && ep.id !== endpointId) return false
  if (Array.isArray(allowedEndpointIds) && !allowedEndpointIds.includes(ep.id)) return false
  const targetGroup = String(groupType || 'all').toLowerCase()
  const proto = normalizeProtocol(ep.protocol, ep.kind)
  if (targetGroup === 'anthropic' && proto !== 'anthropic') return false
  if (targetGroup === 'openai' && proto !== 'openai') return false
  if (targetGroup === 'gemini' && proto !== 'gemini') return false
  return true
}

export class ApiScheduler {
  constructor({ schedulerRuntime = null } = {}) {
    this.endpoints = []
    this.forcePrefix = false
    this.schedulerRuntime = schedulerRuntime || null
  }

  setSchedulerRuntime(rt) {
    this.schedulerRuntime = rt || null
  }

  reload(endpoints = []) {
    this.endpoints = Array.isArray(endpoints) ? endpoints : []
  }

  hasOwnedEndpoints(
    ownerScope = PLATFORM_SCOPE,
    { groupType = 'all', endpointId = null, allowedEndpointIds = null } = {},
  ) {
    return this.endpoints.some((ep) =>
      endpointMatchesFilters(ep, { groupType, endpointId, ownerScope, allowedEndpointIds }),
    )
  }

  catalog({ groupType = 'all', endpointId = null, ownerScope = PLATFORM_SCOPE, allowedEndpointIds = null } = {}) {
    const data = []
    const seen = new Set()
    for (const ep of this.endpoints) {
      if (!endpointMatchesFilters(ep, { groupType, endpointId, ownerScope, allowedEndpointIds })) continue
      for (const id of modelIdsForEndpoint(ep, { forcePrefix: this.forcePrefix })) {
        const k = lower(id)
        if (seen.has(k)) continue
        seen.add(k)
        data.push({
          id,
          object: 'model',
          type: 'model',
          display_name: id,
          owned_by: ep.name || 'api',
        })
      }
    }
    return { object: 'list', data, source: 'api-endpoints' }
  }

  /**
   * Pure read-only endpoint metadata lookup (no cursors, no mutations, no slot reservation).
   * Used BEFORE JEV to determine protocol/model existence and `risk_review_enabled`.
   */
  matchEndpoints(
    requestedModel,
    now = Date.now(),
    { groupType = 'all', endpointId = null, ownerScope = PLATFORM_SCOPE, allowedEndpointIds = null } = {},
  ) {
    const matched = this.endpoints.filter(
      (ep) =>
        endpointMatchesFilters(ep, { groupType, endpointId, ownerScope, allowedEndpointIds }) &&
        endpointMatchesModel(ep, requestedModel),
    )
    if (!matched.length) {
      return { ok: false, code: 'model_not_found', message: `No API endpoint serves model '${requestedModel}'` }
    }
    const readyEndpoints = matched.filter((ep) =>
      (ep.api_key_entries || []).some((k) => keyReady(k, now, ep.disable_cooling)),
    )
    if (!readyEndpoints.length) {
      return { ok: false, code: 'no_ready_api_key', message: 'All API keys for matching endpoints are unavailable' }
    }
    const primary = readyEndpoints[0]
    const upstreamModels = resolveUpstreamPool(primary, requestedModel)
    const readyKeys = (primary.api_key_entries || []).filter((k) => keyReady(k, now, primary.disable_cooling))
    return {
      ok: true,
      endpoints: matched,
      readyEndpoints,
      endpoint: primary,
      key: readyKeys[0],
      upstream_model: upstreamModels[0] || norm(requestedModel),
      riskReviewEnabled: matched.some((ep) => ep.risk_review_enabled === true),
    }
  }

  /**
   * Resolve concrete `{ endpoint, key, upstream_model }` for a Rust-selected `api_endpoint` node.
   */
  resolveEndpointSelection(
    selectedEndpointId,
    requestedModel,
    now = Date.now(),
    { groupType = 'all', endpointId = null, ownerScope = PLATFORM_SCOPE, allowedEndpointIds = null } = {},
  ) {
    const ep = this.endpoints.find((item) => item.id === selectedEndpointId)
    if (
      !ep ||
      !endpointMatchesFilters(ep, { groupType, endpointId, ownerScope, allowedEndpointIds }) ||
      !endpointMatchesModel(ep, requestedModel)
    ) {
      return {
        ok: false,
        code: 'no_ready_api_key',
        message: `Selected API endpoint '${selectedEndpointId}' is no longer eligible`,
      }
    }
    const readyKeys = (ep.api_key_entries || []).filter((k) => keyReady(k, now, ep.disable_cooling))
    if (!readyKeys.length) {
      return {
        ok: false,
        code: 'no_ready_api_key',
        message: `Selected API endpoint '${selectedEndpointId}' has no ready API keys`,
      }
    }
    const upstreamModels = resolveUpstreamPool(ep, requestedModel)
    return {
      ok: true,
      endpoint: ep,
      key: readyKeys[0],
      upstream_model: upstreamModels[0] || norm(requestedModel),
    }
  }

  /**
   * Authoritative Rust `kin-scheduler` endpoint acquisition (Fail-Closed 503 if unavailable).
   */
  async acquire(
    requestedModel,
    {
      schedulerRuntime = null,
      requestId = crypto.randomUUID(),
      attemptNo = 1,
      originPoolId = null,
      jevDowngradePoolId = null,
      apiKeyRecord = null,
      apiKeyKind = null,
      poolAccess = null,
      ownerScope = PLATFORM_SCOPE,
      groupType = 'all',
      endpointId = null,
      allowedEndpointIds = null,
      protocol = '',
      inboundIdentity = null,
      noQueue = false,
      isAdminDiagnostic = false,
      excludeNodes = [],
      signal = null,
      now = Date.now(),
    } = {},
  ) {
    const rt = schedulerRuntime || this.schedulerRuntime
    if (!rt) {
      throw new SchedulerUnavailableError('Rust scheduler runtime is unavailable for API dispatch', {
        reason: 'runtime_missing',
      })
    }
    const isManagedPool = Boolean(poolAccess && poolAccess.legacy === false)
    // For managed pools, allow Stage 4 fallback_pool_id endpoints owned by the same
    // tenant/platform so Rust Stage 0/4 remains the sole pool membership authority.
    const lookupScope = {
      groupType,
      endpointId,
      ownerScope,
      allowedEndpointIds: isManagedPool ? null : allowedEndpointIds,
    }
    const matched = this.matchEndpoints(requestedModel, now, lookupScope)
    if (!matched.ok) return matched

    const allowedNodeKeys =
      isManagedPool && !endpointId && String(groupType || 'all').toLowerCase() === 'all'
        ? undefined
        : matched.readyEndpoints.map((ep) => formatNodeKey('api_endpoint', ep.id))
    const resolvedOriginPoolId = originPoolId || poolAccess?.effectivePool?.id || VIRTUAL_POOL_IDS.api
    const modelFamily = inferModelFamily(requestedModel, protocol || matched.endpoint?.protocol)
    const acquireParams = {
      requestId,
      attemptNo,
      originPoolId: resolvedOriginPoolId,
      jevDowngradePoolId: jevDowngradePoolId || null,
      apiKeyRecord,
      apiKeyKind,
      poolAccess,
      ownerScope,
      allowedNodeKeys,
      nodeTypes: ['api_endpoint'],
      model: requestedModel,
      modelFamily,
      protocol: protocol || matched.endpoint?.protocol || 'anthropic',
      machineId: inboundIdentity?.machineId || null,
      sessionId: inboundIdentity?.sessionId || crypto.randomUUID(),
      sessionIdSource: inboundIdentity?.sessionSource || null,
      parentSessionId: inboundIdentity?.parentSessionId || null,
      isEphemeralProbe: Boolean(inboundIdentity?.isEphemeralProbe),
      noQueue: noQueue === true,
      isAdminDiagnostic: isAdminDiagnostic === true,
      excludeNodes,
    }
    const acquired = await rt.acquireNode(acquireParams, { signal })
    const selectedId = acquired?.selected_node?.node_id
    const resolved = this.resolveEndpointSelection(selectedId, requestedModel, now, lookupScope)
    if (!resolved.ok) {
      try {
        await rt.releaseLease(acquired.lease_id, { outcome: 'error' })
      } catch {}
      return resolved
    }
    return {
      ...resolved,
      leaseId: acquired.lease_id,
      leaseTtlMs: acquired.lease_ttl_ms,
      nodeKey: acquired.selected_node.node_key,
      resolvedPoolId: acquired.resolved_pool_id,
      promptPolicy: acquired.prompt_policy,
      stoodIn: acquired.stood_in === true,
      preserveMachineHome: acquired.preserve_machine_home === true,
      sessionGateWaitMs: acquired.session_gate_wait_ms || 0,
      explain: acquired.explain || null,
      acquireParams,
    }
  }

  /**
   * Single-RTT atomic endpoint switch in Rust `kin-scheduler` (preserves SessionGate).
   */
  async switchEndpoint({
    schedulerRuntime = null,
    releaseLeaseId,
    failure,
    nextAttempt,
    requestedModel,
    now = Date.now(),
    groupType = 'all',
    endpointId = null,
    ownerScope = PLATFORM_SCOPE,
    allowedEndpointIds = null,
    poolAccess = null,
    signal = null,
  }) {
    const rt = schedulerRuntime || this.schedulerRuntime
    if (!rt) {
      throw new SchedulerUnavailableError('Rust scheduler runtime is unavailable for API switch', {
        reason: 'runtime_missing',
      })
    }
    const switched = await rt.switchNode(
      {
        release_lease_id: releaseLeaseId,
        failure,
        next_attempt: nextAttempt,
      },
      { signal },
    )
    const selectedId = switched?.selected_node?.node_id
    const isManagedPool = Boolean((poolAccess || nextAttempt?.poolAccess)?.legacy === false)
    const resolved = this.resolveEndpointSelection(selectedId, requestedModel, now, {
      groupType,
      endpointId,
      ownerScope,
      allowedEndpointIds: isManagedPool ? null : allowedEndpointIds,
    })
    if (!resolved.ok) {
      try {
        await rt.releaseLease(switched.lease_id, { outcome: 'error' })
      } catch {}
      return resolved
    }
    return {
      ...resolved,
      leaseId: switched.lease_id,
      leaseTtlMs: switched.lease_ttl_ms,
      nodeKey: switched.selected_node.node_key,
      resolvedPoolId: switched.resolved_pool_id,
      promptPolicy: switched.prompt_policy,
      stoodIn: switched.stood_in === true,
      preserveMachineHome: switched.preserve_machine_home === true,
      explain: switched.explain || null,
      acquireParams: nextAttempt,
    }
  }

  async commitLease(leaseId, { schedulerRuntime = null } = {}) {
    const rt = schedulerRuntime || this.schedulerRuntime
    if (!rt || !leaseId) return null
    return rt.commitLease(leaseId)
  }

  async releaseLease(leaseId, payload = {}, { schedulerRuntime = null } = {}) {
    const rt = schedulerRuntime || this.schedulerRuntime
    if (!rt || !leaseId) return null
    return rt.releaseLease(leaseId, payload)
  }

  /**
   * Pure stateless metadata lookup retained ONLY for synchronous panel debug console
   * (`anthropic-console.mjs`). Inference dispatch MUST use `acquire()` via Rust.
   */
  pick(requestedModel, now = Date.now(), filterOpts = {}) {
    const matched = this.matchEndpoints(requestedModel, now, filterOpts)
    if (!matched.ok) return matched
    return {
      ok: true,
      endpoint: matched.endpoint,
      key: matched.key,
      upstream_model: matched.upstream_model,
    }
  }
}
