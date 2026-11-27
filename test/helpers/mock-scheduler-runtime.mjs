import { activeHoursOf, evaluateActiveHours } from '../../src/lib/pool/active-hours.mjs'
import { codexSlotAllowsModel } from '../../src/lib/pool/codex-slot-pool.mjs'
import { openAIAccountHold } from '../../src/lib/pool/openai-account-runtime.mjs'
import { SchedulerApiError } from '../../src/lib/transport/scheduler-client.mjs'
import { listVms } from '../../src/lib/vm/vm-registry.mjs'

function makeAbortError() {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}

function splitNodeKey(raw, fallbackType = 'gemini_env') {
  const str = String(raw || '')
  const idx = str.indexOf(':')
  if (idx > 0) {
    return { nodeType: str.slice(0, idx), nodeId: str.slice(idx + 1), nodeKey: str }
  }
  return { nodeType: fallbackType, nodeId: str, nodeKey: `${fallbackType}:${str}` }
}

function defaultPoolIdFor(nodeType) {
  if (nodeType === 'gemini_env') return '__default_gemini__'
  if (nodeType === 'codex_vm') return '__default_codex__'
  if (nodeType === 'api_endpoint') return '__default_api__'
  return '__default_claude__'
}

function defaultExhaustedError(nodeType) {
  if (nodeType === 'gemini_env') {
    return new SchedulerApiError({
      status: 429,
      code: 'pool_exhausted',
      message: 'No gemini environment available',
      retryAfterSec: 5,
    })
  }
  if (nodeType === 'codex_vm') {
    return new SchedulerApiError({
      status: 503,
      code: 'pool_exhausted',
      message: 'No GPT slot available',
    })
  }
  if (nodeType === 'api_endpoint') {
    return new SchedulerApiError({
      status: 503,
      code: 'pool_exhausted',
      message: 'No API endpoint available',
    })
  }
  return new SchedulerApiError({
    status: 503,
    code: 'account_pool_exhausted',
    message: 'No eligible Claude accounts remain',
  })
}

function createSessionGate(defaultTimeoutMs = 900_000) {
  const sessionLocks = new Map()
  return async function acquireSessionLock(sessionKey, timeoutMs = defaultTimeoutMs, signal = null) {
    if (!sessionKey) return () => {}
    if (signal?.aborted) throw makeAbortError()
    let state = sessionLocks.get(sessionKey)
    if (!state) {
      state = { held: false, waiters: [] }
      sessionLocks.set(sessionKey, state)
    }
    let released = false
    const release = () => {
      if (released) return
      released = true
      const next = state.waiters.shift()
      if (next) {
        next.grant()
      } else {
        state.held = false
        if (sessionLocks.get(sessionKey) === state) sessionLocks.delete(sessionKey)
      }
    }
    if (!state.held) {
      state.held = true
      return release
    }
    await new Promise((resolve, reject) => {
      let settled = false
      const removeWaiter = () => {
        const idx = state.waiters.indexOf(waiter)
        if (idx >= 0) state.waiters.splice(idx, 1)
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        removeWaiter()
        reject(makeAbortError())
      }
      const waiter = {
        grant() {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener?.('abort', onAbort)
          resolve()
        },
      }
      const timer = setTimeout(
        () => {
          if (settled) return
          settled = true
          signal?.removeEventListener?.('abort', onAbort)
          removeWaiter()
          reject(
            new SchedulerApiError({
              status: 529,
              code: 'pool_overloaded',
              message: '号池负载过高，稍后再试',
              retryAfterSec: 1,
              explain: { reason: 'session_queue_timeout' },
            }),
          )
        },
        Math.max(1, Number(timeoutMs) || 900_000),
      )
      signal?.addEventListener?.('abort', onAbort, { once: true })
      state.waiters.push(waiter)
    })
    return release
  }
}

function normalizeNodeEntry(entry, fallbackType) {
  if (typeof entry === 'string') {
    const parsed = splitNodeKey(entry, fallbackType)
    return { ...parsed, maxConcurrency: Infinity, priority: 0, schedulable: true }
  }
  if (!entry || typeof entry !== 'object') return null
  const rawKey = entry.node_key || entry.nodeKey || null
  const nodeType =
    entry.node_type || entry.nodeType || (rawKey ? splitNodeKey(rawKey, fallbackType).nodeType : fallbackType)
  const nodeId = entry.node_id || entry.nodeId || entry.id || (rawKey ? splitNodeKey(rawKey, nodeType).nodeId : '')
  if (!nodeId) return null
  const nodeKey = rawKey || `${nodeType}:${nodeId}`
  const rawCap = entry.maxConcurrency ?? entry.max_concurrency ?? entry.policy?.maxConcurrency
  const cap = Number.isFinite(Number(rawCap)) && Number(rawCap) > 0 ? Number(rawCap) : Infinity
  const priority = Number.isFinite(Number(entry.priority ?? entry.policy?.priority))
    ? Number(entry.priority ?? entry.policy?.priority)
    : 0
  return {
    nodeType,
    nodeId: String(nodeId),
    nodeKey,
    maxConcurrency: cap,
    priority,
    schedulable: entry.schedulable !== false,
    raw: entry,
  }
}

/**
 * Shared deterministic in-memory mock for `schedulerRuntime` across all M3 dataplanes
 * (`gemini_env`, `api_endpoint`, `claude_vm`, `codex_vm`).
 */
export function createMockSchedulerRuntime({
  nodes = null,
  listNodes = null,
  projectRoot = null,
  poolScheduler = null,
  getRoutingConfig = null,
  strategy = null,
  stickyEnabled = null,
  maxConcurrency = Infinity,
  quotaCooldownMs = 60_000,
  now = () => Date.now(),
  sessionGate = false,
  sessionQueueTimeoutMs = 900_000,
  codexQueueTimeoutMs = 1_500,
  exhaustedError = null,
  onAcquire = null,
  onSwitch = null,
  onCommit = null,
  onRelease = null,
} = {}) {
  let leaseSeq = 0
  let rrCursor = 0
  let configVersion = 1
  const activeLeases = new Map()
  const activeCount = new Map()
  const stickyBySession = new Map()
  const modelCooldowns = new Map()
  const unschedulableNodes = new Set()
  const heldVms = new Set()
  const failures = []
  const telemetry = []
  const syncCalls = []
  const unrestCalls = []
  const deletedStickies = []
  const waiters = []
  const acquireSessionLock = createSessionGate(sessionQueueTimeoutMs)

  const wakeWaiters = () => {
    const pending = waiters.splice(0, waiters.length)
    for (const fn of pending) fn()
  }

  const resolveStrategy = () => {
    if (typeof strategy === 'function') return strategy() || 'balanced'
    if (typeof strategy === 'string' && strategy) return strategy
    if (typeof getRoutingConfig === 'function') {
      const cfg = getRoutingConfig()
      if (cfg?.gemini?.pool?.strategy) return cfg.gemini.pool.strategy
    }
    return 'balanced'
  }

  const isStickyEnabled = () => {
    if (typeof stickyEnabled === 'function') return Boolean(stickyEnabled())
    if (typeof stickyEnabled === 'boolean') return stickyEnabled
    if (typeof getRoutingConfig === 'function') {
      const cfg = getRoutingConfig()
      if (cfg?.gemini?.sticky && typeof cfg.gemini.sticky.enabled === 'boolean') {
        return cfg.gemini.sticky.enabled
      }
    }
    return true
  }

  const capFor = (cand, params) => {
    if (typeof maxConcurrency === 'function') {
      const val = Number(maxConcurrency(cand.nodeKey, params))
      if (Number.isFinite(val) && val > 0) return val
    } else if (Number.isFinite(maxConcurrency) && maxConcurrency > 0) {
      return Math.min(cand.maxConcurrency, maxConcurrency)
    }
    return cand.maxConcurrency
  }

  const bumpActive = (nodeKey, delta) => {
    const next = Math.max(0, (activeCount.get(nodeKey) || 0) + delta)
    if (next === 0) activeCount.delete(nodeKey)
    else activeCount.set(nodeKey, next)
    if (delta < 0) wakeWaiters()
  }

  const noteFailure = (rec, failure) => {
    if (!rec || !failure) return
    failures.push({ nodeKey: rec.nodeKey, nodeId: rec.nodeId, model: rec.model, failure })
    if (rec.nodeType === 'codex_vm' && (failure.http_status === 401 || failure.error_class === 'auth_error')) {
      heldVms.add(rec.nodeId)
    }
    if (failure.error_class === 'rate_limit' || failure.error_class === 'quota_exhausted') {
      const waitMs =
        Number.isFinite(failure.retry_after_sec) && failure.retry_after_sec > 0
          ? failure.retry_after_sec * 1000
          : quotaCooldownMs
      if (waitMs > 0) {
        modelCooldowns.set(`${rec.nodeKey}:${rec.model}`, now() + waitMs)
      }
    }
  }

  const inferNodeType = (params) => {
    if (Array.isArray(params.nodeTypes) && params.nodeTypes.length) return String(params.nodeTypes[0])
    if (Array.isArray(params.allowedNodeKeys) && params.allowedNodeKeys.length) {
      return splitNodeKey(params.allowedNodeKeys[0]).nodeType
    }
    if (params.pinNodeKey) return splitNodeKey(params.pinNodeKey).nodeType
    return 'gemini_env'
  }

  const buildExcludedSet = (excludeNodes = []) => {
    const set = new Set()
    for (const raw of excludeNodes || []) {
      const s = String(raw || '')
      if (!s) continue
      set.add(s)
      const idx = s.indexOf(':')
      if (idx > 0) set.add(s.slice(idx + 1))
    }
    return set
  }

  const buildAllowedSet = (allowedNodeKeys) => {
    if (!Array.isArray(allowedNodeKeys)) return null
    const set = new Set()
    for (const raw of allowedNodeKeys) {
      const s = String(raw || '')
      if (!s) continue
      set.add(s)
      const idx = s.indexOf(':')
      if (idx > 0) set.add(s.slice(idx + 1))
    }
    return set
  }

  const resolveCandidates = (params, nodeType, ts) => {
    const excluded = buildExcludedSet(params.excludeNodes)
    const allowedSet = buildAllowedSet(params.allowedNodeKeys)

    let rawList = null
    if (typeof listNodes === 'function') {
      rawList = listNodes(params)
    } else if (Array.isArray(nodes)) {
      rawList = nodes
    } else if (projectRoot && nodeType === 'codex_vm') {
      const vms = listVms(projectRoot).filter((v) => v?.platform === 'openai')
      const modelMatched = vms.filter((v) => codexSlotAllowsModel(v, params.model))
      if (vms.length > 0 && modelMatched.length === 0) {
        throw new SchedulerApiError({
          status: 400,
          code: 'model_not_allowed',
          message: `model '${params.model || ''}' is not allowed on any GPT slot`,
        })
      }
      const scoped = modelMatched.filter((v) => {
        const key = `codex_vm:${v.id}`
        if (allowedSet && !allowedSet.has(key) && !allowedSet.has(v.id)) return false
        if (excluded.has(key) || excluded.has(v.id)) return false
        if (unschedulableNodes.has(key)) return false
        if (openAIAccountHold(v.id, ts) || heldVms.has(v.id) || heldVms.has(key)) return false
        return true
      })
      if (!scoped.length) {
        throw exhaustedError ? exhaustedError(params) : defaultExhaustedError('codex_vm')
      }
      const active = []
      let earliestRestUntil = null
      for (const vm of scoped) {
        const ah = evaluateActiveHours(activeHoursOf(vm), ts, vm.timezone)
        if (!ah.active) {
          earliestRestUntil = earliestRestUntil == null ? ah.until : Math.min(earliestRestUntil, ah.until)
          continue
        }
        active.push({
          nodeType: 'codex_vm',
          nodeId: vm.id,
          nodeKey: `codex_vm:${vm.id}`,
          maxConcurrency: Number(vm.policy?.maxConcurrency ?? vm.max_concurrency) || 16,
          priority: Number(vm.policy?.priority) || 0,
          schedulable: true,
          raw: vm,
        })
      }
      if (!active.length && earliestRestUntil != null) {
        const retryAfterSec = Math.max(1, Math.ceil((earliestRestUntil - ts) / 1000))
        throw new SchedulerApiError({
          status: 503,
          code: 'pool_unavailable',
          message: 'GPT slots are resting',
          retryAfterSec,
          explain: { reason: 'pool_resting' },
        })
      }
      return active
    } else if (projectRoot && nodeType === 'claude_vm') {
      rawList = listVms(projectRoot)
        .filter((v) => v?.platform !== 'openai' && v?.status === 'running' && v?.schedulable !== false)
        .map((v) => ({
          nodeType: 'claude_vm',
          nodeId: v.id,
          nodeKey: `claude_vm:${v.id}`,
          maxConcurrency: Number(v.policy?.maxConcurrency ?? v.max_concurrency) || 16,
          priority: Number(v.policy?.priority) || 0,
          schedulable: true,
          raw: v,
        }))
    } else if (Array.isArray(params.allowedNodeKeys)) {
      rawList = params.allowedNodeKeys
    } else if (params.pinNodeKey) {
      rawList = [params.pinNodeKey]
    } else {
      rawList = []
    }

    const normalized = []
    for (const item of rawList || []) {
      const cand = normalizeNodeEntry(item, nodeType)
      if (!cand || !cand.schedulable) continue
      if (allowedSet && !allowedSet.has(cand.nodeKey) && !allowedSet.has(cand.nodeId)) continue
      if (excluded.has(cand.nodeKey) || excluded.has(cand.nodeId)) continue
      if (unschedulableNodes.has(cand.nodeKey)) continue
      if (heldVms.has(cand.nodeId) || heldVms.has(cand.nodeKey)) continue
      if (
        cand.nodeType === 'gemini_env' &&
        poolScheduler?.unitCircuit?.inspect?.(`gemini:${cand.nodeId}`)?.ok === false
      ) {
        continue
      }
      normalized.push(cand)
    }
    return normalized
  }

  const selectCandidate = (params, { dryRun = false } = {}) => {
    const ts = now()
    const nodeType = inferNodeType(params)
    const candidates = resolveCandidates(params, nodeType, ts)
    if (!candidates.length) {
      return { ok: false, error: exhaustedError ? exhaustedError(params) : defaultExhaustedError(nodeType) }
    }

    const model = String(params.model || '')
    const cooldownUntil = (cand) => {
      const until = modelCooldowns.get(`${cand.nodeKey}:${model}`) || 0
      return until > ts ? until : 0
    }

    const unsaturated = (list) => list.filter((c) => (activeCount.get(c.nodeKey) || 0) < capFor(c, params))

    const uncooled = candidates.filter((c) => !cooldownUntil(c))
    const pool = uncooled.length ? uncooled : candidates
    const isCooldownFallback = uncooled.length === 0
    const available = unsaturated(pool)
    if (!available.length) {
      return {
        ok: false,
        saturated: true,
        error: new SchedulerApiError({
          status: 429,
          code: nodeType === 'gemini_env' ? 'pool_exhausted' : 'pool_overloaded',
          message: '号池负载过高，稍后再试',
          retryAfterSec: 1,
        }),
      }
    }

    const stickyOn = isStickyEnabled()
    const pinnedKey = params.pinNodeKey ? splitNodeKey(params.pinNodeKey, nodeType).nodeKey : null
    const stickyKey = stickyOn && params.sessionId ? stickyBySession.get(params.sessionId) : null
    const strat = resolveStrategy()

    const ordered = (() => {
      if (pinnedKey) {
        const hit = available.find((c) => c.nodeKey === pinnedKey)
        if (hit) return [{ cand: hit, why: 'admin_pin' }]
      }
      if (isCooldownFallback) {
        return [...available]
          .sort((a, b) => cooldownUntil(a) - cooldownUntil(b) || a.nodeKey.localeCompare(b.nodeKey))
          .map((cand) => ({ cand, why: 'cooldown_fallback' }))
      }
      const list = []
      const seen = new Set()
      if (stickyKey) {
        const hit = available.find((c) => c.nodeKey === stickyKey)
        if (hit) {
          list.push({ cand: hit, why: 'session_sticky' })
          seen.add(hit.nodeKey)
        }
      }
      const rest = available.filter((c) => !seen.has(c.nodeKey))
      if (strat === 'round_robin' && rest.length > 0) {
        const start = rrCursor++ % rest.length
        for (let i = 0; i < rest.length; i++) {
          list.push({ cand: rest[(start + i) % rest.length], why: 'round_robin' })
        }
      } else if (strat === 'fill') {
        const sorted = [...rest].sort((a, b) => {
          const curA = activeCount.get(a.nodeKey) || 0
          const curB = activeCount.get(b.nodeKey) || 0
          const capA = capFor(a, params)
          const capB = capFor(b, params)
          const loadA = Number.isFinite(capA) ? curA / capA : curA
          const loadB = Number.isFinite(capB) ? curB / capB : curB
          if (loadB !== loadA) return loadB - loadA
          if (b.priority !== a.priority) return b.priority - a.priority
          return 0
        })
        for (const cand of sorted) list.push({ cand, why: 'fill' })
      } else {
        const sorted = [...rest].sort((a, b) => {
          const curA = activeCount.get(a.nodeKey) || 0
          const curB = activeCount.get(b.nodeKey) || 0
          const capA = capFor(a, params)
          const capB = capFor(b, params)
          const loadA = Number.isFinite(capA) ? curA / capA : curA
          const loadB = Number.isFinite(capB) ? curB / capB : curB
          if (loadA !== loadB) return loadA - loadB
          if (b.priority !== a.priority) return b.priority - a.priority
          if (a.nodeType === 'gemini_env' && poolScheduler?.lastUsed?.size) {
            const luA = poolScheduler.lastUsed.get(`gemini:${a.nodeId}`) || 0
            const luB = poolScheduler.lastUsed.get(`gemini:${b.nodeId}`) || 0
            if (luA !== luB) return luA - luB
          }
          return 0
        })
        for (const cand of sorted) list.push({ cand, why: 'balanced' })
      }
      return list
    })()

    for (const { cand, why } of ordered) {
      if (!dryRun && cand.nodeType === 'gemini_env' && typeof poolScheduler?.unitCircuit?.admit === 'function') {
        const admitted = poolScheduler.unitCircuit.admit(`gemini:${cand.nodeId}`)
        if (admitted?.ok === false) continue
      }
      return { ok: true, cand, why, nodeType }
    }

    return { ok: false, error: exhaustedError ? exhaustedError(params) : defaultExhaustedError(nodeType) }
  }

  const acquireCore = async (params = {}, { signal, timeoutMs, existingReleaseLock = null } = {}) => {
    const nodeType = inferNodeType(params)
    const lockKey = sessionGate && !params.isEphemeralProbe ? String(params.sessionId || '') : ''
    const releaseLock = existingReleaseLock || (await acquireSessionLock(lockKey, sessionQueueTimeoutMs, signal))
    const waitBudgetMs = timeoutMs ?? (nodeType === 'codex_vm' ? codexQueueTimeoutMs : 0)
    const deadline = Date.now() + Math.max(0, waitBudgetMs)
    try {
      for (;;) {
        if (signal?.aborted) throw makeAbortError()
        const picked = selectCandidate(params, { dryRun: false })
        if (picked.ok) {
          const { cand, why } = picked
          bumpActive(cand.nodeKey, 1)
          const leaseId = `mock-lease-${++leaseSeq}`
          const rec = {
            leaseId,
            nodeKey: cand.nodeKey,
            nodeId: cand.nodeId,
            nodeType: cand.nodeType,
            sessionId: params.sessionId || null,
            model: String(params.model || ''),
            releaseLock,
            committed: false,
          }
          activeLeases.set(leaseId, rec)
          const response = {
            lease_id: leaseId,
            lease_ttl_ms: 30_000,
            resolved_pool_id: params.originPoolId || defaultPoolIdFor(cand.nodeType),
            selected_node: {
              node_type: cand.nodeType,
              node_id: cand.nodeId,
              node_key: cand.nodeKey,
            },
            prompt_policy: null,
            stood_in: false,
            preserve_machine_home: false,
            session_gate_wait_ms: 0,
            explain: { affinity: { why } },
          }
          onAcquire?.({ params, response, rec })
          return response
        }
        const remaining = deadline - Date.now()
        if (!picked.saturated || params.noQueue || remaining <= 0) {
          throw picked.error
        }
        await new Promise((resolve) => {
          const onWake = () => {
            clearTimeout(timer)
            signal?.removeEventListener?.('abort', onWake)
            resolve()
          }
          const timer = setTimeout(
            () => {
              const idx = waiters.indexOf(onWake)
              if (idx >= 0) waiters.splice(idx, 1)
              signal?.removeEventListener?.('abort', onWake)
              resolve()
            },
            Math.min(remaining, 100),
          )
          signal?.addEventListener?.('abort', onWake, { once: true })
          waiters.push(onWake)
        })
      }
    } catch (err) {
      releaseLock()
      throw err
    }
  }

  const rt = {
    activeLeases,
    activeCount,
    stickyBySession,
    modelCooldowns,
    unschedulableNodes,
    heldVms,
    failures,
    telemetry,
    syncCalls,
    unrestCalls,
    deletedStickies,
    lastSnapshot: { nodes: [] },
    get configVersion() {
      return configVersion
    },
    waiterCount: () => waiters.length,
    inflightCount(nodeKeyOrId = null) {
      if (!nodeKeyOrId) {
        let total = 0
        for (const count of activeCount.values()) total += count
        return total
      }
      if (activeCount.has(nodeKeyOrId)) return activeCount.get(nodeKeyOrId) || 0
      for (const [k, count] of activeCount.entries()) {
        if (k.endsWith(`:${nodeKeyOrId}`)) return count
      }
      return 0
    },
    holdSlot(nodeKeyOrId) {
      const key = String(nodeKeyOrId).includes(':')
        ? String(nodeKeyOrId)
        : projectRoot
          ? `codex_vm:${nodeKeyOrId}`
          : `gemini_env:${nodeKeyOrId}`
      bumpActive(key, 1)
      let released = false
      return {
        release() {
          if (released) return
          released = true
          bumpActive(key, -1)
        },
      }
    },
    reset() {
      for (const rec of activeLeases.values()) rec.releaseLock?.()
      activeLeases.clear()
      activeCount.clear()
      stickyBySession.clear()
      modelCooldowns.clear()
      unschedulableNodes.clear()
      heldVms.clear()
      failures.length = 0
      telemetry.length = 0
      syncCalls.length = 0
      unrestCalls.length = 0
      deletedStickies.length = 0
      rrCursor = 0
      wakeWaiters()
    },
    async acquireNode(params = {}, opts = {}) {
      return acquireCore(params, opts)
    },
    async switchNode(body = {}, opts = {}) {
      const prevId = body.release_lease_id
      const prev = prevId ? activeLeases.get(prevId) : null
      if (prev) {
        activeLeases.delete(prevId)
        bumpActive(prev.nodeKey, -1)
        noteFailure(prev, body.failure)
      }
      onSwitch?.({ body, prev })
      const next = await acquireCore(body.next_attempt || {}, {
        ...opts,
        existingReleaseLock: prev?.releaseLock || null,
      })
      return next
    },
    switchLease(body = {}, opts = {}) {
      return this.switchNode(body, opts)
    },
    async commitLease(leaseId) {
      const rec = activeLeases.get(leaseId)
      if (!rec) return
      rec.committed = true
      if (isStickyEnabled() && rec.sessionId) {
        stickyBySession.set(rec.sessionId, rec.nodeKey)
      }
      onCommit?.({ leaseId, rec })
    },
    async releaseLease(leaseIdOrPayload, outcomeOrPayload = {}) {
      const leaseId = typeof leaseIdOrPayload === 'string' ? leaseIdOrPayload : leaseIdOrPayload?.lease_id || null
      const payload = typeof leaseIdOrPayload === 'string' ? outcomeOrPayload || {} : leaseIdOrPayload || {}
      if (!leaseId) return
      const rec = activeLeases.get(leaseId)
      if (!rec) return
      activeLeases.delete(leaseId)
      bumpActive(rec.nodeKey, -1)
      rec.releaseLock?.()
      if (isStickyEnabled() && rec.sessionId && payload?.outcome === 'ok') {
        stickyBySession.set(rec.sessionId, rec.nodeKey)
      } else if (payload && payload.outcome && payload.outcome !== 'ok' && payload.outcome !== 'aborted') {
        noteFailure(rec, payload)
      }
      onRelease?.({ leaseId, rec, payload })
    },
    async explainDispatch(params = {}, { signal } = {}) {
      if (signal?.aborted) throw makeAbortError()
      const picked = selectCandidate(params, { dryRun: true })
      if (!picked.ok) {
        return {
          ok: false,
          error_code: picked.error?.code || 'no_eligible_accounts',
          explain: picked.error?.explain || null,
          config_version: configVersion,
        }
      }
      return {
        ok: true,
        resolved_pool_id: params.originPoolId || defaultPoolIdFor(picked.cand.nodeType),
        selected_node: {
          node_type: picked.cand.nodeType,
          node_id: picked.cand.nodeId,
          node_key: picked.cand.nodeKey,
        },
        prompt_policy: null,
        stood_in: false,
        preserve_machine_home: false,
        explain: { affinity: { why: picked.why } },
        config_version: configVersion,
      }
    },
    explain(params = {}, opts = {}) {
      return this.explainDispatch(params, opts)
    },
    async syncConfigNow(reason = 'manual') {
      configVersion += 1
      syncCalls.push({ reason, at: now(), configVersion })
      return { ok: true, config_version: configVersion }
    },
    syncConfig(reason = 'manual') {
      return this.syncConfigNow(reason)
    },
    enqueueTelemetry(updates) {
      if (!Array.isArray(updates)) return
      for (const upd of updates) {
        telemetry.push(upd)
        if (upd?.node_key && typeof upd.schedulable === 'boolean') {
          if (upd.schedulable) unschedulableNodes.delete(upd.node_key)
          else unschedulableNodes.add(upd.node_key)
        }
      }
    },
    async pushTelemetryNow(updates = null) {
      if (Array.isArray(updates)) this.enqueueTelemetry(updates)
      return { ok: true }
    },
    pushTelemetry(updates = null) {
      return this.pushTelemetryNow(updates)
    },
    async unrestNode(nodeKey) {
      const key = String(nodeKey || '')
      unrestCalls.push(key)
      unschedulableNodes.delete(key)
      const id = key.includes(':') ? key.split(':').slice(1).join(':') : key
      heldVms.delete(key)
      heldVms.delete(id)
      for (const mk of [...modelCooldowns.keys()]) {
        if (mk.startsWith(`${key}:`)) modelCooldowns.delete(mk)
      }
      return { ok: true, unrested: true }
    },
    async querySticky(filter = {}) {
      const items = []
      for (const [sessionId, nodeKey] of stickyBySession.entries()) {
        if (filter.session_id && filter.session_id !== sessionId) continue
        if (filter.node_key && filter.node_key !== nodeKey) continue
        items.push({ scope_kind: 'session', session_id: sessionId, node_key: nodeKey })
      }
      return { items }
    },
    async deleteSticky(filter = {}) {
      deletedStickies.push(filter)
      let deleted = 0
      for (const [sessionId, nodeKey] of [...stickyBySession.entries()]) {
        if (filter.session_id && filter.session_id !== sessionId) continue
        if (filter.node_key && filter.node_key !== nodeKey) continue
        stickyBySession.delete(sessionId)
        deleted += 1
      }
      return { ok: true, deleted }
    },
    async drainPersistenceNow() {
      return { ok: true }
    },
    async health() {
      return { ok: true, config_version: configVersion }
    },
    async start() {
      return { ok: true }
    },
    async shutdown() {
      this.reset()
      return { ok: true }
    },
    subscribeEvents() {
      return {
        async *[Symbol.asyncIterator]() {},
        close() {},
      }
    },
  }
  return rt
}

/**
 * Adapter mock for legacy `FailoverRunner({ scheduler })` unit tests whose stub
 * `scheduler` implements `selectAndReserve(...)`.
 *
 * Automatically attaches `scheduler.resolveCandidateForNode` if absent so the exact
 * candidate object (`.vm`, `.exec`, `.accountId`, `.vmId`, `.release`) survives
 * through `FailoverRunner`, enforces per-`sessionId` FIFO `SessionGate` locking,
 * and translates `{ ok: false, reason }` into `SchedulerApiError`.
 */
export function createFailoverMockSchedulerRuntime({ scheduler = null, config = {} } = {}) {
  let leaseSeq = 0
  const leases = new Map()
  const syncCalls = []
  const telemetry = []
  const unrestCalls = []
  const deletedStickies = []
  const acquireSessionLock = createSessionGate(config.session_queue_timeout_ms ?? 900_000)

  const buildExcludedSet = (excludeNodes = []) => {
    const excluded = new Set()
    for (const key of excludeNodes || []) {
      const raw = String(key || '')
      if (!raw) continue
      excluded.add(raw)
      const id = raw.includes(':') ? raw.split(':').slice(1).join(':') : raw
      excluded.add(id)
      const match = (scheduler?.candidates || []).find((c) => c.vmId === id || c.accountId === id)
      if (match) {
        if (match.vmId) excluded.add(match.vmId)
        if (match.accountId) excluded.add(match.accountId)
      }
    }
    return excluded
  }

  const buildKeyScope = (params) => {
    const vmPoolId =
      params.jevDowngradePoolId ||
      (params.originPoolId && !String(params.originPoolId).startsWith('__default_') ? params.originPoolId : null)
    const allowedVms = Array.isArray(params.allowedNodeKeys)
      ? params.allowedNodeKeys.map((k) =>
          String(k).includes(':') ? String(k).split(':').slice(1).join(':') : String(k),
        )
      : undefined
    if (!params.apiKeyScope && !vmPoolId && !allowedVms) return undefined
    return {
      ...(params.apiKeyScope || {}),
      ...(vmPoolId ? { vm_pool_id: vmPoolId } : {}),
      ...(allowedVms ? { allowed_vms: allowedVms } : {}),
    }
  }

  const selectCandidate = async (params) => {
    if (!scheduler || typeof scheduler.selectAndReserve !== 'function') {
      throw new SchedulerApiError({
        status: 503,
        code: 'account_pool_exhausted',
        message: 'No eligible Claude accounts remain',
      })
    }
    const excluded = buildExcludedSet(params.excludeNodes)
    const pinVmId = params.pinNodeKey ? String(params.pinNodeKey).split(':').slice(1).join(':') : null
    const keyScope = buildKeyScope(params)
    let selected
    try {
      selected = await scheduler.selectAndReserve({
        excluded,
        model: params.model,
        pinVmId,
        keyScope,
        originPoolId: params.originPoolId,
        jevDowngradePoolId: params.jevDowngradePoolId,
        poolAccess: params.poolAccess,
        ownerScope: params.ownerScope,
        apiKeyRecord: params.apiKeyRecord,
        apiKeyKind: params.apiKeyKind,
        stickyKey: params.sessionId || null,
        skipSessionSlot: params.isEphemeralProbe === true,
        allowWait: params.noQueue !== true,
      })
    } catch (err) {
      if (err?.code === 'pool_wait_queue_full') {
        throw new SchedulerApiError({
          status: 529,
          code: 'pool_overloaded',
          message: '号池负载过高，稍后再试',
          retryAfterSec: 1,
          explain: { reason: 'pool_wait_queue_full' },
        })
      }
      throw err
    }
    if (!selected || !selected.ok) {
      const reason = selected?.reason || 'no_eligible_accounts'
      const retryMs = Number(selected?.retry_after_ms ?? selected?.soonest_available_ms)
      const retryAfterSec = Number.isFinite(retryMs) && retryMs > 0 ? Math.max(1, Math.ceil(retryMs / 1000)) : undefined
      if (reason === 'quota_guard_request_too_large') {
        throw new SchedulerApiError({
          status: 429,
          code: 'quota_guard_request_too_large',
          message: selected?.message || 'Request exceeds remaining quota band',
          retryAfterSec: retryAfterSec ?? 1,
          explain: { reason, ...selected },
        })
      }
      if (reason === 'fable_requires_max') {
        throw new SchedulerApiError({
          status: 429,
          code: 'fable_requires_max',
          message: 'Fable requires a Max account',
          retryAfterSec: retryAfterSec ?? 1,
        })
      }
      if (reason === 'pool_rate_limited') {
        throw new SchedulerApiError({
          status: 429,
          code: 'pool_rate_limited',
          message: 'All accounts are rate limited',
          retryAfterSec: retryAfterSec ?? 1,
        })
      }
      if (
        reason === 'all_accounts_busy' ||
        reason === 'pool_queue_timeout' ||
        reason === 'pool_overload_cooldown' ||
        reason === 'pool_wait_queue_full'
      ) {
        throw new SchedulerApiError({
          status: 529,
          code: 'pool_overloaded',
          message: '号池负载过高，稍后再试',
          retryAfterSec: retryAfterSec ?? 1,
          explain: { reason, ...selected },
        })
      }
      throw new SchedulerApiError({
        status: 503,
        code: reason === 'pool_resting' ? 'pool_unavailable' : 'account_pool_exhausted',
        message: 'No eligible Claude accounts remain',
        retryAfterSec,
        explain: {
          reason,
          wait_ms: selected?.waitMs ?? 0,
          sticky_cleared: Boolean(selected?.sticky_cleared),
          ...selected,
        },
      })
    }
    return selected
  }

  const runtime = {
    leases,
    syncCalls,
    telemetry,
    unrestCalls,
    deletedStickies,
    lastSnapshot: { nodes: [] },
    configVersion: 1,
    candidateForLease(leaseId) {
      return leases.get(leaseId)?.candidate || null
    },
    async acquireNode(params = {}, { signal } = {}) {
      const lockKey = params.isEphemeralProbe ? '' : String(params.sessionId || '')
      const releaseLock = await acquireSessionLock(lockKey, config.session_queue_timeout_ms, signal)
      try {
        const selected = await selectCandidate(params)
        const leaseId = `mock-fo-lease-${++leaseSeq}`
        leases.set(leaseId, { candidate: selected, releaseLock })
        return {
          lease_id: leaseId,
          lease_ttl_ms: 30_000,
          resolved_pool_id: params.originPoolId || '__default_claude__',
          selected_node: {
            node_type: 'claude_vm',
            node_id: selected.vmId,
            node_key: `claude_vm:${selected.vmId}`,
          },
          explain: { affinity: { why: selected.selectionReason || 'balanced' } },
        }
      } catch (err) {
        releaseLock()
        throw err
      }
    },
    async switchNode(body = {}, { signal } = {}) {
      const prev = leases.get(body.release_lease_id)
      leases.delete(body.release_lease_id)
      const releaseLock = prev?.releaseLock || (() => {})
      try {
        prev?.candidate?.release?.()
      } catch {}
      if (signal?.aborted) {
        releaseLock()
        throw makeAbortError()
      }
      try {
        const selected = await selectCandidate(body.next_attempt || {})
        const leaseId = `mock-fo-lease-${++leaseSeq}`
        leases.set(leaseId, { candidate: selected, releaseLock })
        return {
          lease_id: leaseId,
          lease_ttl_ms: 30_000,
          resolved_pool_id: body.next_attempt?.originPoolId || '__default_claude__',
          selected_node: {
            node_type: 'claude_vm',
            node_id: selected.vmId,
            node_key: `claude_vm:${selected.vmId}`,
          },
          explain: { affinity: { why: selected.selectionReason || 'balanced' } },
        }
      } catch (err) {
        releaseLock()
        throw err
      }
    },
    switchLease(body = {}, opts = {}) {
      return this.switchNode(body, opts)
    },
    async commitLease() {},
    async releaseLease(leaseIdOrPayload) {
      const leaseId = typeof leaseIdOrPayload === 'string' ? leaseIdOrPayload : leaseIdOrPayload?.lease_id
      const rec = leases.get(leaseId)
      if (!rec) return
      leases.delete(leaseId)
      try {
        rec.candidate?.release?.()
      } catch {}
      rec.releaseLock()
    },
    async explainDispatch(params = {}) {
      try {
        const selected = await selectCandidate({ ...params, noQueue: true })
        try {
          selected.release?.()
        } catch {}
        return {
          ok: true,
          resolved_pool_id: params.originPoolId || '__default_claude__',
          selected_node: {
            node_type: 'claude_vm',
            node_id: selected.vmId,
            node_key: `claude_vm:${selected.vmId}`,
          },
          explain: { affinity: { why: selected.selectionReason || 'balanced' } },
          config_version: 1,
        }
      } catch (err) {
        return {
          ok: false,
          error_code: err?.code || 'no_eligible_accounts',
          explain: err?.explain || null,
          config_version: 1,
        }
      }
    },
    explain(params = {}, opts = {}) {
      return this.explainDispatch(params, opts)
    },
    async syncConfigNow(reason = 'manual') {
      syncCalls.push(reason)
      return { ok: true, config_version: 1 }
    },
    syncConfig(reason = 'manual') {
      return this.syncConfigNow(reason)
    },
    enqueueTelemetry(updates) {
      if (Array.isArray(updates)) telemetry.push(...updates)
    },
    async pushTelemetryNow(updates = null) {
      if (Array.isArray(updates)) telemetry.push(...updates)
      return { ok: true }
    },
    pushTelemetry(updates = null) {
      return this.pushTelemetryNow(updates)
    },
    async unrestNode(nodeKey) {
      unrestCalls.push(nodeKey)
      return { ok: true, unrested: true }
    },
    async querySticky() {
      return { items: [] }
    },
    async deleteSticky(filter = {}) {
      deletedStickies.push(filter)
      return { ok: true, deleted: 0 }
    },
    async drainPersistenceNow() {
      return { ok: true }
    },
    async health() {
      return { ok: true, config_version: 1 }
    },
    subscribeEvents() {
      return {
        async *[Symbol.asyncIterator]() {},
        close() {},
      }
    },
  }

  if (scheduler && typeof scheduler.resolveCandidateForNode !== 'function') {
    scheduler.resolveCandidateForNode = (_node, meta) => {
      const cand = runtime.candidateForLease(meta?.leaseId)
      if (!cand) return null
      return {
        ...cand,
        nodeKey: cand.nodeKey || `claude_vm:${cand.vmId}`,
        leaseId: meta?.leaseId || null,
      }
    }
  }

  return runtime
}
