import { formatNodeKey } from '../../src/lib/scheduler/scheduler-runtime.mjs'
import { SchedulerApiError } from '../../src/lib/transport/scheduler-client.mjs'
import { listVms } from '../../src/lib/vm/vm-registry.mjs'

/**
 * Generic acquire/switch/commit/release mock for unit tests that wire M3 Rust dispatch
 * without starting kin-scheduler.
 */
export function makeStubSchedulerRuntime({ defaultPoolId = null } = {}) {
  let seq = 0
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
      const key = allowed.find((k) => !excluded.has(k))
      if (!key) {
        throw new SchedulerApiError({
          status: 429,
          code: 'pool_exhausted',
          message: 'No schedulable node available',
          retryAfterSec: 1,
        })
      }
      const nodeType = key.split(':')[0] || 'claude_vm'
      const nodeId = key.split(':').slice(1).join(':')
      return {
        lease_id: `stub-lease-${++seq}`,
        lease_ttl_ms: 30_000,
        resolved_pool_id: params.originPoolId || defaultPoolId || '__default_stub__',
        selected_node: { node_type: nodeType, node_id: nodeId, node_key: key },
        explain: params.explain || null,
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
export function makeMockGeminiRuntime() {
  let seq = 0
  return {
    async acquireNode(params) {
      const excluded = new Set(params.excludeNodes || [])
      const allowed = Array.isArray(params.allowedNodeKeys) ? params.allowedNodeKeys : []
      const key = allowed.find((k) => !excluded.has(k))
      if (!key) {
        throw new SchedulerApiError({
          status: 429,
          code: 'pool_exhausted',
          message: 'No gemini environment available',
          retryAfterSec: 5,
        })
      }
      const id = key.split(':').slice(1).join(':')
      return {
        lease_id: `gem-lease-${++seq}`,
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
    async releaseLease() {},
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
  const schedulerRuntime = deps.schedulerRuntime || makeStubSchedulerRuntime()
  if (deps.apiScheduler) ensureApiSchedulerM3(deps.apiScheduler)
  return { ...deps, schedulerRuntime }
}

/** Minimal Codex vm picker from on-disk registry rows (handle-codex.test.mjs style). */
export function makePoolStubRuntimeForProject(projectRoot) {
  const rt = makeStubSchedulerRuntime()
  const acquire = rt.acquireNode.bind(rt)
  rt.acquireNode = async (params, opts) => {
    const acquired = await acquire(params, opts)
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