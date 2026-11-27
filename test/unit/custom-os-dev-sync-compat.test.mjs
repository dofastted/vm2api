import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { LOCAL_TARGET, migrationRequest } from '../../src/lib/cluster/slot-migration.mjs'
import { CRS_OFFICIAL_CLI_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { prepareCragPrintBody } from '../../src/lib/protocol/crag-print-prompt.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { resolvePoolSystemPromptPolicy } from '../../src/lib/protocol/pool-prompt-policy.mjs'
import { buildVmRuntimeCapabilities, createSchedulerRuntime } from '../../src/lib/scheduler/scheduler-runtime.mjs'
import { clearRustHealthCache, rememberRustHealth } from '../../src/lib/transport/kernel-router.mjs'
import { identityDrift } from '../../src/lib/vm/slot-resize-local.mjs'
import { buildKvmRunArgs } from '../../src/lib/vm/vm-runtime.mjs'
import { createFailoverMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'

function extractEnvFromRunArgs(argv) {
  const env = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '-e' && i + 1 < argv.length) {
      env.push(argv[i + 1])
      i += 1
    }
  }
  return env
}

test('M3 scheduler-runtime: syncConfig uses V4 effectiveSlotCount and buildTelemetryBatch projects CRAG V4 + crag-debian13 capabilities', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-m3-v4-compat-'))
  t.after(() => {
    clearRustHealthCache()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const v4Caps = [
    'headless_claude_bridge_v1',
    'pr_set_dumpable_v1',
    'vsock_transport_v1',
    'prompt_replace_empty',
    'count_tokens_v1',
    'generation_controls_v3',
  ]

  const v4KvmVm = {
    id: 'vm-v4-kvm',
    kernel: 'crag-debian13',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    status: 'running',
    schedulable: true,
    runtime: { type: 'kvm' },
    claude: { account_tier: 'max', rate_limit_tier: 'default_claude_max_5x' },
    machine: { memory: '512m', pids_limit: 256 },
    runtime_capabilities: { custom_operator_flag: true, os_custom_store_ro: true },
  }
  // Register cached /internal/health for vm-v4-kvm (without duplicating caps on vm object).
  rememberRustHealth(
    { vmId: v4KvmVm.id, vm: v4KvmVm, homeDir: path.join(root, 'vms', v4KvmVm.id, 'cli-home') },
    { ok: true, health: { ok: true, ready: true, transport: 'headless_bridge', capabilities: v4Caps } },
  )

  const v4DockerVm = {
    id: 'vm-v4-docker',
    kernel: 'crag-debian13',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    status: 'running',
    schedulable: true,
    runtime: { type: 'docker', capabilities: ['headless_claude_bridge_v1', 'count_tokens_v1'] },
    claude: { account_tier: 'pro' },
    machine: { memory: '512m', pids_limit: 256 },
  }

  const explicitOverrideVm = {
    id: 'vm-explicit',
    kernel: 'crag-debian13',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    status: 'running',
    schedulable: true,
    runtime: { type: 'docker', capabilities: ['headless_claude_bridge_v1'] },
    policy: { max_concurrency: 7, session_slots: 6 },
  }

  const legacyVm = {
    id: 'vm-legacy',
    kernel: 'ubuntu-24.04',
    dataplane: 'wrap',
    status: 'running',
    schedulable: true,
    runtime: { type: 'docker' },
  }

  const runtime = createSchedulerRuntime({
    cfg: { paths: { project: root } },
    getDb: () => null,
    getVms: () => [v4KvmVm, v4DockerVm, explicitOverrideVm, legacyVm],
    getRoutingConfig: () => ({
      inference: { session_slots: 20 },
      concurrency: { default_max_per_account: 4 },
    }),
    client: {
      isStandby: false,
      role: 'leader',
      controllerEpoch: 'ep-test',
      stopped: false,
    },
    telemetryIntervalMs: 0,
  })

  // 1. buildConfigSnapshot (syncConfig) applies V4 headless effectiveSlotCount while honoring explicit overrides & legacy defaults.
  const snap = runtime.buildConfigSnapshot({ configVersion: 1 })
  const kvmNode = snap.nodes.find((n) => n.node_key === 'claude_vm:vm-v4-kvm')
  const dockerNode = snap.nodes.find((n) => n.node_key === 'claude_vm:vm-v4-docker')
  const overrideNode = snap.nodes.find((n) => n.node_key === 'claude_vm:vm-explicit')
  const legacyNode = snap.nodes.find((n) => n.node_key === 'claude_vm:vm-legacy')

  // 512m + 256 pids under headless_bridge defaults (base 96m + 12m/slot, base 48 + 2/slot) fits all 12 Max 5x slots!
  assert.equal(kvmNode.capacity.max_concurrency, 12)
  assert.equal(kvmNode.capacity.max_sessions, 12)
  // Pro plan targets 5 slots, all 5 fit easily in 512m under headless_bridge.
  assert.equal(dockerNode.capacity.max_concurrency, 5)
  assert.equal(dockerNode.capacity.max_sessions, 5)
  // Explicit operator policy wins unchanged.
  assert.equal(overrideNode.capacity.max_concurrency, 7)
  assert.equal(overrideNode.capacity.max_sessions, 6)
  // Legacy non-CRAG VM keeps default_max_per_account = 4.
  assert.equal(legacyNode.capacity.max_concurrency, 4)
  assert.equal(legacyNode.capacity.max_sessions, 4)

  // 2. buildTelemetryBatch projects CRAG V4 /internal/health::capabilities + crag-debian13 OS capabilities + explicit overrides.
  const batch = runtime.buildTelemetryBatch()
  const kvmUpd = batch.find((u) => u.node_key === 'claude_vm:vm-v4-kvm')
  const dockerUpd = batch.find((u) => u.node_key === 'claude_vm:vm-v4-docker')
  const legacyUpd = batch.find((u) => u.node_key === 'claude_vm:vm-legacy')

  assert.equal(kvmUpd.runtime_capabilities.headless_claude_bridge_v1, true)
  assert.equal(kvmUpd.runtime_capabilities.pr_set_dumpable_v1, true)
  assert.equal(kvmUpd.runtime_capabilities.vsock_transport_v1, true)
  assert.equal(kvmUpd.runtime_capabilities.prompt_replace_empty, true)
  assert.equal(kvmUpd.runtime_capabilities.count_tokens_v1, true)
  assert.equal(kvmUpd.runtime_capabilities.os_crag_debian13, true)
  assert.equal(kvmUpd.runtime_capabilities.os_custom_erofs, true)
  assert.equal(kvmUpd.runtime_capabilities.os_kvm_native_smbios, true)
  assert.equal(kvmUpd.runtime_capabilities.os_custom_store_ro, true)
  assert.equal(kvmUpd.runtime_capabilities.custom_operator_flag, true)

  // Docker crag-debian13 advertises OS + V4 caps, NOT KVM-only SMBIOS/EROFS caps.
  assert.equal(dockerUpd.runtime_capabilities.os_crag_debian13, true)
  assert.equal(dockerUpd.runtime_capabilities.os_custom_store_ro, true)
  assert.equal(dockerUpd.runtime_capabilities.headless_claude_bridge_v1, true)
  assert.equal(dockerUpd.runtime_capabilities.count_tokens_v1, true)
  assert.equal(dockerUpd.runtime_capabilities.os_kvm_native_smbios, undefined)
  assert.equal(dockerUpd.runtime_capabilities.os_custom_erofs, undefined)

  // Legacy VM with no custom OS / health caps / explicit runtime_capabilities omits runtime_capabilities.
  assert.equal(legacyUpd.runtime_capabilities, undefined)

  // Explicit boolean false in vm.runtime_capabilities overrides derived capability.
  const overridden = buildVmRuntimeCapabilities({
    ...v4KvmVm,
    runtime_capabilities: { os_kvm_native_smbios: false },
  })
  assert.equal(overridden.os_kvm_native_smbios, false)
  assert.equal(overridden.os_crag_debian13, true)
})

test('M3 scheduler-runtime regression: POST /vms/create default unpinned policy and cold-start disk V4 manifest resolve full V4 capacity & telemetry', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-m3-v4-cold-'))
  t.after(() => {
    clearRustHealthCache()
    fs.rmSync(root, { recursive: true, force: true })
  })

  // Seed disk staged CRAG V4 manifest (cold start: zero cached /internal/health in memory).
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const stagedDir = path.join(root, 'share', 'crag', 'kernels', 'v2', arch)
  fs.mkdirSync(stagedDir, { recursive: true })
  fs.writeFileSync(
    path.join(stagedDir, 'manifest.json'),
    JSON.stringify({
      family: 'crag',
      version: 'v2',
      arch,
      officialClaude: { version: '2.1.321', path: 'claude-code-2.1.321/claude' },
      capabilities: ['headless_claude_bridge_v1', 'count_tokens_v1', 'prompt_replace_empty', 'generation_controls_v3'],
    }),
  )

  // (a) Realistic POST /vms/create default policy (maxConcurrency: 2, concurrencyOverride: false, maxSessions: 0, sessionsOverride: false)
  // (b) Cold start with NO cached /internal/health and NO vm.runtime.capabilities (only disk manifest above)
  const coldCreatedVm = {
    id: 'vm-d13-created',
    kernel: 'crag-debian13',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    status: 'running',
    schedulable: true,
    runtime: { type: 'kvm' },
    claude: { account_tier: 'max', rate_limit_tier: 'default_claude_max_5x' },
    machine: { memory: '512m', pids_limit: 256 },
    policy: {
      maxConcurrency: 2,
      concurrencyOverride: false,
      maxRpm: 0,
      rpmOverride: false,
      maxSessions: 0,
      sessionsOverride: false,
      weight: 1,
      inflight: 0,
    },
  }

  // Explicitly pinned operator override must still win.
  const pinnedVm = {
    ...coldCreatedVm,
    id: 'vm-d13-pinned',
    policy: {
      maxConcurrency: 3,
      concurrencyOverride: true,
      maxSessions: 2,
      sessionsOverride: true,
    },
  }

  const runtime = createSchedulerRuntime({
    cfg: { paths: { project: root } },
    getDb: () => null,
    getVms: () => [coldCreatedVm, pinnedVm],
    getRoutingConfig: () => ({
      inference: { session_slots: 20 },
      concurrency: { default_max_per_account: 2 },
    }),
    client: { isStandby: false, role: 'leader', controllerEpoch: 'ep-cold', stopped: false },
    telemetryIntervalMs: 0,
  })

  const snap = runtime.buildConfigSnapshot({ configVersion: 1 })
  const createdNode = snap.nodes.find((n) => n.node_key === 'claude_vm:vm-d13-created')
  const pinnedNode = snap.nodes.find((n) => n.node_key === 'claude_vm:vm-d13-pinned')

  // Unpinned POST /vms/create slot must get full V4 headless capacity (12) on 512m Max 5x, NOT maxConcurrency=2 or maxSessions=1!
  assert.equal(createdNode.capacity.max_concurrency, 12)
  assert.equal(createdNode.capacity.max_sessions, 12)
  // Pinned slot keeps explicit operator override.
  assert.equal(pinnedNode.capacity.max_concurrency, 3)
  assert.equal(pinnedNode.capacity.max_sessions, 2)

  // Cold-start telemetry also projects V4 capabilities from disk manifest + crag-debian13 OS capabilities.
  const batch = runtime.buildTelemetryBatch()
  const createdUpd = batch.find((u) => u.node_key === 'claude_vm:vm-d13-created')
  assert.equal(createdUpd.runtime_capabilities.headless_claude_bridge_v1, true)
  assert.equal(createdUpd.runtime_capabilities.count_tokens_v1, true)
  assert.equal(createdUpd.runtime_capabilities.prompt_replace_empty, true)
  assert.equal(createdUpd.runtime_capabilities.os_crag_debian13, true)
  assert.equal(createdUpd.runtime_capabilities.os_custom_erofs, true)
  assert.equal(createdUpd.runtime_capabilities.os_kvm_native_smbios, true)
})

test('handle-protocol regression: headless_bridge fallback from official origin pool to passthrough pool uses preRelocateBody (un-relocated system)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fallback-pass-'))
  t.after(() => {
    clearRustHealthCache()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const routingFile = path.join(root, 'routing.json')
  const routing = {
    sticky: { outbound_session: 'passthrough' },
    compatibility: {
      persona_preset: 'official_full',
      crag_persona_preset: 'official_full',
      official_cc_passthrough: true,
      crag_strict_passthrough: false,
      third_party_system_relocate: true,
    },
  }
  fs.writeFileSync(routingFile, JSON.stringify(routing))

  const vm = {
    id: 'vm-fb-pass',
    node_id: 'node-fixture',
    dataplane: 'wrap',
    crag_kernel_version: 'v2',
    official_cc_inference: 'cli-hop',
  }
  const health = {
    ok: true,
    ready: true,
    status: 'ready',
    cli_pid: 55555,
    ready_slots: 10,
    runtime_variant: 'crag-v2',
    transport: 'headless_bridge',
    capabilities: ['headless_claude_bridge_v1', 'generation_controls_v3', 'prompt_replace', 'prompt_append'],
  }
  const exec = { vmId: vm.id, vm, homeDir: root, workerStatus: health }
  rememberRustHealth(exec, { ok: true, health })

  const fallbackPassthroughPoolId = 'pool_fb_passthrough'

  // Ingress starts under official_full (poolOwnsSystemDirectly=false -> relocateThirdPartySystem moves system into messages[0]),
  // while M3 scheduler acquire resolves to fallback pool with `system_prompt_mode: 'passthrough'`.
  const scheduler = {
    resolveCandidateForNode(selectedNode, extra = {}) {
      return {
        ok: true,
        vmId: vm.id,
        accountId: vm.id,
        vm,
        exec,
        nodeKey: selectedNode.node_key,
        ...extra,
        release() {},
      }
    },
    async selectAndReserve() {
      return { ok: true, vmId: vm.id, accountId: vm.id, vm, exec, release() {} }
    },
    markSuccess() {},
    markCooldown() {},
    releaseAccountSessions() {},
  }
  const baseMockRuntime = createFailoverMockSchedulerRuntime({ scheduler })
  const schedulerRuntime = {
    ...baseMockRuntime,
    async acquireNode(params = {}, opts = {}) {
      const acquired = await baseMockRuntime.acquireNode(params, opts)
      return {
        ...acquired,
        resolved_pool_id: fallbackPassthroughPoolId,
        prompt_policy: {
          pool_id: fallbackPassthroughPoolId,
          mode: 'passthrough',
          preset: 'official_full',
          text: '',
          client_system_policy: 'prepend_pool',
          source: 'pool',
        },
      }
    },
  }
  const runner = new FailoverRunner({
    scheduler,
    schedulerRuntime,
    config: { max_same_account_retries: 0 },
  })

  const sentCalls = []
  const response = { headersSent: false, statusCode: 0, on() {}, once() {}, off() {}, write() {}, end() {} }
  const handler = createHandleProtocol({
    json(_res, status, body) {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => ({
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      stream: false,
      system: [{ type: 'text', text: 'You are OpenCode, an autonomous third-party agent.' }],
      messages: [{ role: 'user', content: 'Keep my system prompt untouched.' }],
    }),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 2 * 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'fb-pass-req' }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {}, recordUsage() {} },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    schedulerRuntime,
    failoverRunner: {
      run(opts) {
        return runner.run({
          ...opts,
          callAttempt({ body, attemptMeta }) {
            sentCalls.push({ body: structuredClone(body), attemptMeta: structuredClone(attemptMeta) })
            return {
              ok: true,
              status: 200,
              terminalState: 'verified',
              body: {
                id: 'msg_fb_pass',
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-5-5',
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 10, output_tokens: 2 },
              },
            }
          },
        })
      },
    },
  })

  await handler.handleProtocol(
    {
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: 'Bearer sk-3p', 'user-agent': 'OpenCode/2.0' },
      apiKeyKind: 'managed',
      apiKeyRecord: { id: 'fixture' },
      once() {},
      off() {},
    },
    response,
    'anthropic.messages',
    '/v1/messages',
  )
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(sentCalls.length, 1)
  assert.equal(sentCalls[0].attemptMeta?.cragPrint, true)
  const sentBody = sentCalls[0].body
  // Original third-party system prompt MUST stay in `system[]` and NOT be relocated into `messages[0]`.
  assert.equal(sentBody.system?.length, 1)
  assert.equal(sentBody.system[0].text, 'You are OpenCode, an autonomous third-party agent.')
  assert.equal(sentBody.messages.length, 1)
  const firstMsgText = Array.isArray(sentBody.messages[0].content)
    ? sentBody.messages[0].content.map((b) => b.text).join('\n')
    : String(sentBody.messages[0].content || '')
  assert.equal(firstMsgText, 'Keep my system prompt untouched.')
  assert.equal(sentBody.crag_persona_preset, undefined)
  assert.equal(sentBody.crag_prompt, undefined)
})

test('#1995 local KVM in-place resize keeps zero identity drift and preserves custom-erofs assets on crag-debian13', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-resize-d13-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const vmBase = {
    id: 'vm-d13-resize',
    kernel: 'crag-debian13',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    status: 'running',
    runtime_type: 'kvm',
    runtime: { type: 'kvm' },
    timezone: 'UTC',
    locale: 'en_US.UTF-8',
    machine: {
      memory: '2g',
      vcpus: 2,
      disk_gb: 20,
      cpu_model: 'host',
      mac: '52:54:00:12:34:56',
      disk_serial: 'KINDSK001',
      smbios: {
        manufacturer: 'HP',
        product: 'HP EliteBook 840 14 inch G9 Notebook PC',
        version: 'SBKPF',
        family: '103C_5336AN',
        serial: '5CG2101ABC',
        uuid: '11111111-2222-3333-4444-555555555555',
      },
    },
    fingerprint: {
      hostname: 'wk-d13-01',
      guest_machine_id: 'a'.repeat(32),
    },
  }

  // 1. migrationRequest accepts local in-place memory growth on crag-debian13 CRAG KVM slot.
  const req = migrationRequest(
    vmBase,
    { target_node_id: LOCAL_TARGET, memory: '4g' },
    { inference: { dataplane: 'crag' } },
  )
  assert.deepEqual(req, { targetNodeId: 'local', memory: '4g' })

  const vmDir = path.join(root, 'vms', vmBase.id)
  const kvmDir = path.join(vmDir, 'kvm')
  const runDir = path.join(vmDir, 'run')
  const homeDir = path.join(vmDir, 'cli-home')
  const storeDir = path.join(root, 'store')
  const osDir = path.join(root, 'share', 'os', 'crag-debian13')
  for (const d of [kvmDir, runDir, homeDir, storeDir, osDir]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(osDir, 'kin-kvm-debian-13.erofs'), 'erofs')
  fs.writeFileSync(path.join(osDir, 'vmlinuz'), 'vmlinuz')
  fs.writeFileSync(path.join(osDir, 'initrd.img'), 'initrd')
  const leaseFile = path.join(root, 'vsock-cids.json')

  const runArgsBefore = buildKvmRunArgs({
    vm: vmBase,
    name: 'kin-d13-resize',
    image: 'sha256:' + 'c'.repeat(64),
    hostName: vmBase.fingerprint.hostname,
    network: 'kin-eg-local',
    memory: '2g',
    accel: 'kvm',
    uid: 999,
    gid: 987,
    home: homeDir,
    runDir,
    kvmDir,
    projectRoot: root,
    vhostVsockAvailable: true,
    vsockLeaseFile: leaseFile,
  })
  const vmAfter = { ...vmBase, machine: { ...vmBase.machine, memory: '4g' } }
  const runArgsAfter = buildKvmRunArgs({
    vm: vmAfter,
    name: 'kin-d13-resize',
    image: 'sha256:' + 'c'.repeat(64),
    hostName: vmAfter.fingerprint.hostname,
    network: 'kin-eg-local',
    memory: '4g',
    accel: 'kvm',
    uid: 999,
    gid: 987,
    home: homeDir,
    runDir,
    kvmDir,
    projectRoot: root,
    vhostVsockAvailable: true,
    vsockLeaseFile: leaseFile,
  })

  const envBefore = extractEnvFromRunArgs(runArgsBefore)
  const envAfter = extractEnvFromRunArgs(runArgsAfter)
  // Zero identity drift across all 15 #1995 LOCAL_RESIZE_IDENTITY_KEYS!
  assert.deepEqual(identityDrift({ Config: { Env: envBefore } }, { Config: { Env: envAfter } }), [])
  // Memory grew cleanly from 2048 to 4096 while preserving custom-erofs + vsock CID lease + EROFS/initrd.
  assert.equal(envBefore.includes('KIN_KVM_MEMORY_MB=2048'), true)
  assert.equal(envAfter.includes('KIN_KVM_MEMORY_MB=4096'), true)
  assert.equal(envAfter.includes('KIN_KVM_MODE=custom-erofs'), true)
  assert.equal(envAfter.includes('KIN_KVM_EROFS_IMAGE=/opt/kin-os/crag-debian13/kin-kvm-debian-13.erofs'), true)
  assert.equal(envAfter.includes('KIN_KVM_INITRD=/opt/kin-os/crag-debian13/initrd.img'), true)
  const cidBefore = envBefore.find((e) => e.startsWith('KIN_KVM_VSOCK_CID='))
  const cidAfter = envAfter.find((e) => e.startsWith('KIN_KVM_VSOCK_CID='))
  assert.ok(
    cidBefore && cidBefore === cidAfter,
    `CID lease must stay stable across in-place resize: ${cidBefore} vs ${cidAfter}`,
  )
})

test('CRAG 3.1.26 headless_claude_bridge_v1 fuses cleanly with M1b/M3 pool promptPolicy modes', () => {
  const caps = [
    'headless_claude_bridge_v1',
    'prompt_replace',
    'prompt_append',
    'prompt_replace_empty',
    'generation_controls_v3',
  ]
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 64,
    system: [{ type: 'text', text: 'CLIENT_SYS' }],
    messages: [{ role: 'user', content: 'hi' }],
  }

  // 1. passthrough leaves system intact and does NOT inject official_full persona
  const passPolicy = resolvePoolSystemPromptPolicy({
    id: 'p_pass',
    provider_scope: 'anthropic',
    system_prompt_mode: 'passthrough',
  })
  const passOut = prepareCragPrintBody(body, { capabilities: caps, promptPolicy: passPolicy })
  assert.deepEqual(passOut.system, [{ type: 'text', text: 'CLIENT_SYS' }])
  assert.equal(passOut.crag_persona_preset, undefined)
  assert.equal(passOut.crag_prompt, undefined)

  // 2. zero_inject sets crag_persona_preset='zero' + official prompt version
  const zeroPolicy = resolvePoolSystemPromptPolicy({
    id: 'p_zero',
    provider_scope: 'anthropic',
    system_prompt_mode: 'zero_inject',
  })
  const zeroOut = prepareCragPrintBody(body, { capabilities: caps, promptPolicy: zeroPolicy })
  assert.equal(zeroOut.crag_persona_preset, 'zero')
  assert.equal(zeroOut.crag_prompt_version, CRS_OFFICIAL_CLI_SYSTEM)

  // 3. override emits crag_prompt.mode='replace' blocks + zero persona so CRAG 3.1.26 does not prepend official template
  const overridePolicy = resolvePoolSystemPromptPolicy({
    id: 'p_ov',
    provider_scope: 'anthropic',
    system_prompt_mode: 'override',
    system_prompt_text: 'POOL_RULE',
    client_system_policy: 'prepend_pool',
  })
  const ovOut = prepareCragPrintBody(body, { capabilities: caps, promptPolicy: overridePolicy })
  assert.equal(ovOut.system, undefined)
  assert.deepEqual(ovOut.crag_prompt, {
    mode: 'replace',
    blocks: [
      { type: 'text', text: 'POOL_RULE' },
      { type: 'text', text: 'CLIENT_SYS' },
    ],
  })
  assert.equal(ovOut.crag_persona_preset, 'zero')
  assert.equal(ovOut.crag_prompt_version, CRS_OFFICIAL_CLI_SYSTEM)

  // 4. append appends pool tail block to system while preserving official_full
  const appendPolicy = resolvePoolSystemPromptPolicy({
    id: 'p_ap',
    provider_scope: 'anthropic',
    system_prompt_mode: 'append',
    system_prompt_text: 'POOL_TAIL',
  })
  const apOut = prepareCragPrintBody(body, { capabilities: caps, promptPolicy: appendPolicy })
  assert.deepEqual(apOut.system, [
    { type: 'text', text: 'CLIENT_SYS' },
    { type: 'text', text: 'POOL_TAIL' },
  ])
  assert.equal(apOut.crag_persona_preset, 'official_full')

  // 5. Legacy non-headless officialPassthrough with preset='zero' still does NOT wipe official system with replace:""
  const officialLegacyOut = prepareCragPrintBody(
    { model: 'claude-sonnet-4-6', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    {
      preset: 'zero',
      officialPassthrough: true,
      capabilities: ['prompt_replace', 'prompt_replace_empty'],
    },
  )
  assert.equal(officialLegacyOut.crag_prompt, undefined)
})
