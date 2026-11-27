import { formatNodeKey } from '../../src/lib/scheduler/scheduler-runtime.mjs'
import { SchedulerApiError } from '../../src/lib/transport/scheduler-client.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { listVms } from '../../src/lib/vm/vm-registry.mjs'

/**
 * Generic acquire/switch/commit/release mock for unit tests that wire M3 Rust dispatch
 * without starting kin-scheduler.
 */
export function makeStubSchedulerRuntime({ defaultPoolId = null, getKernelLeaseMode = () => 'off' } = {}) {
  let seq = 0
  let rr = 0
  const sessionAffinity = new Map()
  const seatLast = new Map()
  const seatCalls = new Map()
  return {
    async acquireNode(params, _opts = {}) {
      const excluded = new Set(params.excludeNodes || [])
      const allowed = Array.isArray(params.allowedNodeKeys) ? params.allowedNodeKeys : []
      if (!allowed.length) {
        throw new SchedulerApiError({
          status: 503,
          code: 'pool_exhausted',
          message: 'No schedulable node available',
        })
      }
      const eligible = allowed.filter((k) => !excluded.has(k))
      if (!eligible.length) {
        throw new SchedulerApiError({
          status: 429,
          code: 'pool_exhausted',
          message: 'No schedulable node available',
          retryAfterSec: 1,
        })
      }
      let key = null
      if (typeof params.pinNodeKey === 'string' && eligible.includes(params.pinNodeKey)) {
        key = params.pinNodeKey
      } else {
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
        const kernelMode = String(getKernelLeaseMode() || 'off').toLowerCase()
        const stickySession =
          sessionId.includes('seat:sess') || (kernelMode === 'observe' && sessionId.includes('seat:h'))
        if (stickySession && sessionAffinity.has(sessionId)) {
          key = sessionAffinity.get(sessionId)
          if (!eligible.includes(key)) key = null
        }
        if (!key) {
          if (sessionId.includes('seat:h') && kernelMode === 'enforce') {
            const n = (seatCalls.get(sessionId) || 0) + 1
            seatCalls.set(sessionId, n)
            const prior = seatLast.get(sessionId)
            if (n >= 3 && prior && eligible.includes(prior)) {
              key = prior
            } else if (n === 2 && prior) {
              key = eligible.find((k) => k !== prior) || eligible[rr++ % eligible.length]
            } else {
              key = eligible[rr++ % eligible.length]
            }
            seatLast.set(sessionId, key)
          } else {
            key = eligible[rr++ % eligible.length]
          }
          if (stickySession) sessionAffinity.set(sessionId, key)
        }
      }
      const nodeType = key.split(':')[0] || 'claude_vm'
      const nodeId = key.split(':').slice(1).join(':')
      const selectionWhy =
        sessionAffinity.get(params.sessionId) === key && String(params.sessionId || '').includes('seat:')
          ? 'seat-held'
          : 'rust-scheduler'
      return {
        lease_id: `stub-lease-${++seq}`,
        lease_ttl_ms: 30_000,
        resolved_pool_id: params.originPoolId || defaultPoolId || '__default_stub__',
        selected_node: { node_type: nodeType, node_id: nodeId, node_key: key },
        explain: { affinity: { why: selectionWhy } },
      }
    },
    async switchNode(body, opts) {
      return this.acquireNode(body.next_attempt || {}, opts)
    },
    async commitLease() {},
    async releaseLease() {},
  }
}

/** Gemini environment picker aligned with gemini-scheduling-status.test.mjs */
export function makeMockGeminiRuntime(poolScheduler = null) {
  let seq = 0
  let rr = 0
  const leases = new Map()
  return {
    async acquireNode(params) {
      const excluded = new Set(params.excludeNodes || [])
      const allowed = Array.isArray(params.allowedNodeKeys)
        ? params.allowedNodeKeys.filter((k) => !excluded.has(k))
        : []
      if (!allowed.length) {
        throw new SchedulerApiError({
          status: 429,
          code: 'pool_exhausted',
          message: 'No gemini environment available',
          retryAfterSec: 5,
        })
      }
      const key = allowed[rr++ % allowed.length]
      const id = key.split(':').slice(1).join(':')
      const accountKey = `gemini:${id}`
      if (poolScheduler?.bumpInflight) {
        poolScheduler.bumpInflight(accountKey, id, 1)
      }
      const lease_id = `gem-lease-${++seq}`
      leases.set(lease_id, { accountKey, id })
      return {
        lease_id,
        lease_ttl_ms: 30_000,
        resolved_pool_id: params.originPoolId || '__default_gemini__',
        selected_node: { node_type: 'gemini_env', node_id: id, node_key: key },
        explain: { affinity: { why: 'balanced' } },
      }
    },
    async switchNode(body) {
      return this.acquireNode(body.next_attempt || {})
    },
    async commitLease() {},
    async releaseLease(leaseId) {
      const held = leaseId ? leases.get(leaseId) : null
      if (held && poolScheduler?.bumpInflight) {
        poolScheduler.bumpInflight(held.accountKey, held.id, -1)
      }
      if (leaseId) leases.delete(leaseId)
    },
  }
}

/**
 * Upgrade legacy apiScheduler test doubles that only implemented pick() to M3 acquire().
 */
export function ensureApiSchedulerM3(apiScheduler) {
  if (!apiScheduler || typeof apiScheduler.acquire === 'function') return apiScheduler

  let leaseSeq = 0
  const filterPickOpts = (opts = {}) => ({
    groupType: opts.groupType,
    endpointId: opts.endpointId,
    ownerScope: opts.ownerScope,
    allowedEndpointIds: opts.allowedEndpointIds,
  })

  apiScheduler.acquire = async function acquireViaPick(requestedModel, opts = {}) {
    const picked =
      typeof this.pick === 'function'
        ? this.pick(requestedModel, opts.now, filterPickOpts(opts))
        : { ok: false, code: 'no_ready_api_key', message: 'No ready API endpoint' }
    if (!picked?.ok) return picked

    const endpointId = picked.endpoint?.id || 'fixture-endpoint'
    const nodeKey = formatNodeKey('api_endpoint', endpointId)
    const acquireParams = {
      requestId: opts.requestId || `req-${++leaseSeq}`,
      attemptNo: opts.attemptNo || 1,
      originPoolId: opts.originPoolId,
      jevDowngradePoolId: opts.jevDowngradePoolId || null,
      apiKeyRecord: opts.apiKeyRecord,
      apiKeyKind: opts.apiKeyKind,
      poolAccess: opts.poolAccess,
      ownerScope: opts.ownerScope,
      allowedNodeKeys: [nodeKey],
      nodeTypes: ['api_endpoint'],
      model: requestedModel,
      modelFamily: opts.modelFamily,
      protocol: opts.protocol || picked.endpoint?.protocol || 'anthropic',
      noQueue: opts.noQueue === true,
      isAdminDiagnostic: opts.isAdminDiagnostic === true,
      excludeNodes: opts.excludeNodes || [],
    }

    const rt = opts.schedulerRuntime
    if (rt?.acquireNode) {
      const acquired = await rt.acquireNode(acquireParams, { signal: opts.signal })
      return {
        ...picked,
        leaseId: acquired.lease_id,
        leaseTtlMs: acquired.lease_ttl_ms,
        nodeKey: acquired.selected_node?.node_key || nodeKey,
        resolvedPoolId: acquired.resolved_pool_id,
        promptPolicy: acquired.prompt_policy,
        stoodIn: acquired.stood_in === true,
        preserveMachineHome: acquired.preserve_machine_home === true,
        sessionGateWaitMs: acquired.session_gate_wait_ms || 0,
        explain: acquired.explain || null,
        acquireParams,
      }
    }

    return {
      ...picked,
      leaseId: `mock-api-lease-${++leaseSeq}`,
      leaseTtlMs: 30_000,
      nodeKey,
      resolvedPoolId: opts.originPoolId || '__virtual_api__',
      acquireParams,
    }
  }

  if (typeof apiScheduler.switchEndpoint !== 'function') {
    apiScheduler.switchEndpoint = async function switchViaPick(opts = {}) {
      return this.acquire(opts.requestedModel, opts)
    }
  }
  if (typeof apiScheduler.commitLease !== 'function') {
    apiScheduler.commitLease = async () => null
  }
  if (typeof apiScheduler.releaseLease !== 'function') {
    apiScheduler.releaseLease = async () => null
  }

  return apiScheduler
}

/** Spread onto createHandleProtocol deps for M3 scheduler isolation. */
export function withM3SchedulerDeps(deps = {}) {
  let schedulerRuntime = deps.schedulerRuntime
  if (!schedulerRuntime && typeof deps.failoverRunner?.getSchedulerRuntime === 'function') {
    schedulerRuntime = deps.failoverRunner.getSchedulerRuntime()
  }
  if (!schedulerRuntime && deps.failoverRunner?.schedulerRuntime) {
    schedulerRuntime = deps.failoverRunner.schedulerRuntime
  }
  if (!schedulerRuntime) schedulerRuntime = makeStubSchedulerRuntime()
  if (deps.apiScheduler) ensureApiSchedulerM3(deps.apiScheduler)
  return { ...deps, schedulerRuntime }
}

/** Minimal Codex vm picker from on-disk registry rows (handle-codex.test.mjs style). */
export function makePoolStubRuntimeForProject(projectRoot, { getKernelLeaseMode = () => 'off' } = {}) {
  const rt = makeStubSchedulerRuntime({ getKernelLeaseMode })
  const acquire = rt.acquireNode.bind(rt)
  rt.acquireNode = async (params, opts) => {
    const withAllowed =
      Array.isArray(params.allowedNodeKeys) && params.allowedNodeKeys.length
        ? params
        : {
            ...params,
            allowedNodeKeys: listVms(projectRoot)
              .filter((vm) => vm?.schedulable !== false)
              .map((vm) => formatNodeKey('claude_vm', vm.id)),
          }
    const acquired = await acquire(withAllowed, opts)
    const id = acquired?.selected_node?.node_id
    if (id && !listVms(projectRoot).some((vm) => vm.id === id)) {
      throw new SchedulerApiError({
        status: 503,
        code: 'pool_exhausted',
        message: `unknown vm '${id}'`,
      })
    }
    return acquired
  }
  return rt
}

export function makeMockCodexRuntimeFor(projectRoot) {
  let leaseSeq = 0
  return {
    async acquireNode(params) {
      const excluded = new Set(params.excludeNodes || [])
      const vm = listVms(projectRoot).find(
        (v) =>
          v?.platform === 'openai' &&
          v.schedulable !== false &&
          !excluded.has(`codex_vm:${v.id}`) &&
          !excluded.has(v.id),
      )
      if (!vm) {
        throw new SchedulerApiError({ status: 503, code: 'pool_exhausted', message: 'No GPT slot available' })
      }
      return {
        lease_id: `codex-mock-lease-${++leaseSeq}`,
        lease_ttl_ms: 30_000,
        resolved_pool_id: params.originPoolId || '__default_codex__',
        selected_node: { node_type: 'codex_vm', node_id: vm.id, node_key: `codex_vm:${vm.id}` },
      }
    },
    async switchNode(body) {
      return this.acquireNode(body.next_attempt || {})
    },
    async commitLease() {},
    async releaseLease() {},
  }
}

/** Ensure FailoverRunner construction includes a Rust runtime mock. */
export function withM3FailoverRunner(opts = {}) {
  const schedulerRuntime = opts.schedulerRuntime || makeStubSchedulerRuntime()
  return { ...opts, schedulerRuntime }
}

const defaultWorkerHealth = async () => ({
  ok: true,
  credential: { generation: 1, has_access: true },
})

/**
 * PoolScheduler wired for M3 unit tests: fills allowed nodes from project VM registry.
 */
export function createM3PoolScheduler(projectRoot, opts = {}) {
  const schedulerRuntime =
    opts.schedulerRuntime || makePoolStubRuntimeForProject(projectRoot, { getKernelLeaseMode: opts.getKernelLeaseMode })
  return new PoolScheduler({
    projectRoot,
    schedulerRuntime,
    stickyRouter: opts.stickyRouter ?? null,
    accountQuota: opts.accountQuota ?? { canAccept: () => ({ ok: true }) },
    workerHealth: opts.workerHealth ?? defaultWorkerHealth,
    runtimeRepo: opts.runtimeRepo,
    config: {
      fallback_wait_timeout_ms: 5,
      sticky_wait_timeout_ms: 5,
      ...(opts.config || {}),
    },
    ...opts.poolExtras,
  })
}

/**
 * FailoverRunner backed by a real PoolScheduler stub runtime (replaces legacy selectAndReserve mocks).
 */
export function createM3FailoverRunner(projectRoot, opts = {}) {
  const pool = opts.scheduler || createM3PoolScheduler(projectRoot, opts)
  if (typeof opts.execFactory === 'function') {
    const base = pool.executionContext?.bind(pool)
    pool.executionContext = (vm, accountId) => opts.execFactory(vm, accountId) ?? base?.(vm, accountId)
  }
  const schedulerRuntime =
    opts.schedulerRuntime || pool.schedulerRuntime || makePoolStubRuntimeForProject(projectRoot, opts)
  return new FailoverRunner(
    withM3FailoverRunner({
      ...opts,
      scheduler: pool,
      schedulerRuntime,
    }),
  )
}