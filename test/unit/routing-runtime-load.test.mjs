import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'
import { OFFICIAL_CLI_VERSION } from '../../src/lib/identity/vm-identity.mjs'

function runtimeFor(file) {
  return createRoutingRuntime({ routingConfigPath: file })
}

test('loadRoutingConfig fails when routing.json is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-runtime-missing-'))
  try {
    assert.throws(() => runtimeFor(path.join(root, 'routing.json')).loadRoutingConfig(), /Routing config .*not found/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('loadRoutingConfig fails when routing.json is invalid', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-runtime-invalid-'))
  const file = path.join(root, 'routing.json')
  try {
    fs.writeFileSync(file, '{invalid')
    assert.throws(() => runtimeFor(file).loadRoutingConfig(), /Routing config .*invalid JSON/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('applyVmSessionSlots updates only native admission policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-session-slots-'))
  const vms = path.join(root, 'vms')
  const file = path.join(vms, 'vm-01.json')
  fs.mkdirSync(vms, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ id: 'vm-01', policy: { maxConcurrency: 8, maxRpm: 60 } }))
  try {
    const runtime = createRoutingRuntime({ cfg: { paths: { project: root } } })
    runtime.applyVmSessionSlots('vm-01', 4, { override: true })
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(saved.policy.sessionSlots, 4)
    assert.equal(saved.policy.sessionSlotsOverride, true)
    assert.equal(saved.policy.maxConcurrency, 8)
    assert.equal(saved.policy.maxRpm, 60)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('persistRoutingPatch reconciles inherited Claude session slots and preserves overrides', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-session-default-'))
  const vms = path.join(root, 'vms')
  const routingFile = path.join(root, 'routing.json')
  fs.mkdirSync(vms, { recursive: true })
  fs.writeFileSync(
    path.join(vms, 'vm-inherited.json'),
    JSON.stringify({
      id: 'vm-inherited',
      claude: { account_uuid: 'account-inherited' },
      policy: { sessionSlots: 20, sessionSlotsOverride: false },
    }),
  )
  fs.writeFileSync(
    path.join(vms, 'vm-override.json'),
    JSON.stringify({
      id: 'vm-override',
      claude: { account_uuid: 'account-override' },
      policy: { sessionSlots: 8, sessionSlotsOverride: true },
    }),
  )
  fs.writeFileSync(
    path.join(vms, 'vm-codex.json'),
    JSON.stringify({
      id: 'vm-codex',
      platform: 'openai',
      family: 'codex',
      codex: {},
      policy: { sessionSlots: 20, sessionSlotsOverride: false },
    }),
  )
  const routingConfig = {
    inference: { session_slots: 4 },
    concurrency: {},
    tiers: {},
  }
  fs.writeFileSync(routingFile, JSON.stringify(routingConfig))
  try {
    const runtime = createRoutingRuntime({
      cfg: { paths: { project: root } },
      routingConfigPath: routingFile,
      routingConfig,
      stickyRouter: { reloadConfig() {} },
      accountQuota: {
        setMaxConcurrency() {},
        setMaxRpm() {},
        reloadConfig() {},
        applyTierConcurrency() {},
        applyTierRpm() {},
        repo: { get: () => null },
      },
      requestLog: { setConfig() {} },
    })

    const applied = runtime.persistRoutingPatch({ inference: { session_slots: 4 } })

    const inherited = JSON.parse(fs.readFileSync(path.join(vms, 'vm-inherited.json'), 'utf8'))
    const overridden = JSON.parse(fs.readFileSync(path.join(vms, 'vm-override.json'), 'utf8'))
    const codex = JSON.parse(fs.readFileSync(path.join(vms, 'vm-codex.json'), 'utf8'))
    assert.deepEqual(applied.session_slots, { updated: 1, skipped: 1 })
    assert.equal(inherited.policy.sessionSlots, 4)
    assert.equal(inherited.policy.sessionSlotsOverride, false)
    assert.equal(overridden.policy.sessionSlots, 8)
    assert.equal(overridden.policy.sessionSlotsOverride, true)
    assert.equal(codex.policy.sessionSlots, 20)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('persistRoutingPatch writes compatibility cache_ttl into Claude kernel configs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-cache-ttl-'))
  const vms = path.join(root, 'vms')
  const routingFile = path.join(root, 'routing.json')
  fs.mkdirSync(vms, { recursive: true })
  fs.writeFileSync(path.join(vms, 'vm-claude.json'), JSON.stringify({ id: 'vm-claude', claude: {} }))
  fs.writeFileSync(
    path.join(vms, 'vm-codex.json'),
    JSON.stringify({ id: 'vm-codex', platform: 'openai', family: 'codex', codex: {} }),
  )
  const routingConfig = { compatibility: { cache_ttl: '1h' }, concurrency: {}, tiers: {} }
  fs.writeFileSync(routingFile, JSON.stringify(routingConfig))
  try {
    const runtime = createRoutingRuntime({
      cfg: { paths: { project: root } },
      routingConfigPath: routingFile,
      routingConfig,
      stickyRouter: { reloadConfig() {} },
      accountQuota: {
        reloadConfig() {},
        applyTierConcurrency() {},
        applyTierRpm() {},
        repo: { get: () => null },
      },
      requestLog: { setConfig() {} },
    })

    runtime.persistRoutingPatch({ compatibility: { cache_ttl: '5m' } })

    const kernel = JSON.parse(fs.readFileSync(path.join(vms, 'vm-claude', 'run', 'kernel.json'), 'utf8'))
    assert.equal(kernel.default_cache_ttl, '5m')
    assert.equal(fs.existsSync(path.join(vms, 'vm-codex', 'run', 'kernel.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('persistRoutingPatch writes a changed stream idle timeout into Claude kernel configs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-idle-'))
  const vms = path.join(root, 'vms')
  const routingFile = path.join(root, 'routing.json')
  const kernelFile = path.join(vms, 'vm-claude', 'run', 'kernel.json')
  fs.mkdirSync(vms, { recursive: true })
  // Stopped slot: config is written, no kernel restart is queued.
  fs.writeFileSync(path.join(vms, 'vm-claude.json'), JSON.stringify({ id: 'vm-claude', status: 'stopped', claude: {} }))
  const routingConfig = { failover: { stream_idle_timeout_ms: 600000 }, concurrency: {}, tiers: {} }
  fs.writeFileSync(routingFile, JSON.stringify(routingConfig))
  try {
    const runtime = createRoutingRuntime({
      cfg: { paths: { project: root } },
      routingConfigPath: routingFile,
      routingConfig,
      stickyRouter: { reloadConfig() {} },
      accountQuota: {
        reloadConfig() {},
        applyTierConcurrency() {},
        applyTierRpm() {},
        repo: { get: () => null },
      },
      requestLog: { setConfig() {} },
    })

    const same = runtime.persistRoutingPatch({ failover: { stream_idle_timeout_ms: 600000 } })
    assert.equal(same.kernel_persona, null)
    assert.equal(fs.existsSync(kernelFile), false)

    const changed = runtime.persistRoutingPatch({ failover: { stream_idle_timeout_ms: 900000 } })
    assert.equal(changed.kernel_reload, 0)
    assert.equal(JSON.parse(fs.readFileSync(kernelFile, 'utf8')).idle_timeout_seconds, 900)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('persistRoutingPatch writes persona_preset into Claude kernel system_layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-persona-kernel-'))
  const vms = path.join(root, 'vms')
  const routingFile = path.join(root, 'routing.json')
  fs.mkdirSync(vms, { recursive: true })
  fs.writeFileSync(path.join(vms, 'vm-claude.json'), JSON.stringify({ id: 'vm-claude', claude: {} }))
  fs.writeFileSync(
    path.join(vms, 'vm-codex.json'),
    JSON.stringify({ id: 'vm-codex', platform: 'openai', family: 'codex', codex: {} }),
  )
  const routingConfig = {
    compatibility: { cache_ttl: '1h', persona_preset: 'official_full' },
    concurrency: {},
    tiers: {},
  }
  fs.writeFileSync(routingFile, JSON.stringify(routingConfig))
  try {
    const runtime = createRoutingRuntime({
      cfg: { paths: { project: root } },
      routingConfigPath: routingFile,
      routingConfig,
      stickyRouter: { reloadConfig() {} },
      accountQuota: {
        reloadConfig() {},
        applyTierConcurrency() {},
        applyTierRpm() {},
        repo: { get: () => null },
      },
      requestLog: { setConfig() {} },
    })

    const applied = runtime.persistRoutingPatch({ compatibility: { persona_preset: 'zero' } })
    assert.equal(applied.kernel_persona.updated, 1)

    const kernel = JSON.parse(fs.readFileSync(path.join(vms, 'vm-claude', 'run', 'kernel.json'), 'utf8'))
    assert.equal(kernel.system_layout, 'zero')
    assert.equal(kernel.persona_preset, 'zero')
    assert.equal(kernel.default_cache_ttl, '1h')
    assert.equal(kernel.cli_version, OFFICIAL_CLI_VERSION)
    assert.equal(fs.existsSync(path.join(vms, 'vm-codex', 'run', 'kernel.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('OpenAI legacy migration preserves effective pins and resumes before canonical routing commit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-openai-migration-'))
  const vms = path.join(root, 'vms')
  const routingFile = path.join(root, 'routing.json')
  fs.mkdirSync(vms, { recursive: true })
  const legacy = { concurrency: {}, tiers: {}, codex: { enabled: true } }
  const records = [
    {
      id: 'vm-pinned',
      platform: 'openai',
      family: 'codex',
      policy: { maxConcurrency: 1, maxRpm: 37, maxSessions: 999 },
      codex: { extra: { codex_5h_used_percent: 45 } },
      schedulable: false,
      schedule_disabled_reason: 'operator',
    },
    {
      id: 'vm-default',
      platform: 'openai',
      family: 'codex',
      policy: { maxConcurrency: 0, maxRpm: null, maxSessions: '' },
    },
    { id: 'vm-claude', platform: 'anthropic', policy: { maxConcurrency: 8, maxSessions: 999 } },
  ]
  for (const vm of records) fs.writeFileSync(path.join(vms, `${vm.id}.json`), JSON.stringify(vm))
  const read = (id) => JSON.parse(fs.readFileSync(path.join(vms, `${id}.json`), 'utf8'))
  const runtime = () => createRoutingRuntime({ cfg: { paths: { project: root } }, routingConfigPath: routingFile })
  try {
    fs.writeFileSync(routingFile, JSON.stringify(legacy))
    runtime().loadRoutingConfig()
    const pinned = read('vm-pinned')
    assert.deepEqual(pinned.policy, {
      maxConcurrency: 1,
      maxRpm: 37,
      maxSessions: 999,
      concurrencyOverride: true,
      rpmOverride: true,
      sessionsOverride: true,
    })
    assert.equal(pinned.schedulable, false)
    assert.equal(pinned.schedule_disabled_reason, 'operator')
    assert.deepEqual(pinned.codex, records[0].codex)
    assert.deepEqual(read('vm-default').policy, {
      maxConcurrency: 2,
      maxRpm: 0,
      maxSessions: 0,
      concurrencyOverride: false,
      rpmOverride: false,
      sessionsOverride: false,
    })
    assert.deepEqual(read('vm-claude'), records[2])
    const snapshot = records.map((vm) => fs.readFileSync(path.join(vms, `${vm.id}.json`), 'utf8'))
    // Simulate interruption after VM writes but before the routing migration marker.
    fs.writeFileSync(routingFile, JSON.stringify(legacy))
    runtime().loadRoutingConfig()
    assert.deepEqual(
      records.map((vm) => fs.readFileSync(path.join(vms, `${vm.id}.json`), 'utf8')),
      snapshot,
    )
    const canonical = JSON.parse(fs.readFileSync(routingFile, 'utf8'))
    assert.equal(canonical.codex.quota.max_concurrency, 2)
    runtime().loadRoutingConfig()
    assert.deepEqual(
      records.map((vm) => fs.readFileSync(path.join(vms, `${vm.id}.json`), 'utf8')),
      snapshot,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('shipped routing.json loads as canonical without the OpenAI legacy rewrite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shipped-routing-'))
  const routingFile = path.join(root, 'routing.json')
  const shipped = fs.readFileSync(new URL('../../src/config/routing.json', import.meta.url), 'utf8')
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(routingFile, shipped)
  try {
    const doc = createRoutingRuntime({
      cfg: { paths: { project: root } },
      routingConfigPath: routingFile,
    }).loadRoutingConfig()
    assert.equal(doc.codex.enabled, true)
    assert.equal(doc.codex.protocols['openai.responses'].mode, 'native')
    // A duplicate top-level key would drop codex.quota and make the shipped file look legacy.
    assert.equal(fs.readFileSync(routingFile, 'utf8'), shipped)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('OpenAI per-slot limit writes never invoke the Claude quota holder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-openai-isolation-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const file = path.join(root, 'vms', 'vm-openai.json')
  fs.writeFileSync(file, JSON.stringify({ id: 'vm-openai', platform: 'openai', family: 'codex', policy: {} }))
  try {
    const runtime = createRoutingRuntime({ cfg: { paths: { project: root } } })
    runtime.applyVmConcurrency('vm-openai', 3)
    runtime.applyVmRpm('vm-openai', 37)
    runtime.applyVmMaxSessions('vm-openai', 4)
    const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(vm.policy, {
      maxConcurrency: 3,
      concurrencyOverride: true,
      maxRpm: 37,
      rpmOverride: true,
      maxSessions: 4,
      sessionsOverride: true,
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function persistHarness(root, routingFile, routingConfig) {
  return createRoutingRuntime({
    cfg: { paths: { project: root } },
    routingConfigPath: routingFile,
    routingConfig,
    stickyRouter: { reloadConfig() {} },
    accountQuota: {
      setMaxConcurrency() {},
      setMaxRpm() {},
      reloadConfig() {},
      applyTierConcurrency() {},
      applyTierRpm() {},
      repo: { get: () => null },
    },
    requestLog: { setConfig() {} },
  })
}

test('loadRoutingConfig normalizes a missing or invalid vm section', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-vm-load-'))
  const file = path.join(root, 'routing.json')
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        codex: { quota: { max_concurrency: 2 } },
        vm: { memory: '3g', vcpus: 99, allow_tcg: 'yes' },
      }),
    )
    const doc = runtimeFor(file).loadRoutingConfig()
    assert.equal(doc.vm.memory, '512m')
    assert.equal(doc.vm.vcpus, 2)
    assert.equal(doc.vm.default_runtime, 'docker')
    assert.equal(doc.vm.allow_tcg, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('persistRoutingPatch merges a valid vm patch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-vm-persist-'))
  const routingFile = path.join(root, 'routing.json')
  const routingConfig = { concurrency: {}, tiers: {}, vm: { memory: '1g', vcpus: 2 } }
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(routingFile, JSON.stringify(routingConfig))
  try {
    const runtime = persistHarness(root, routingFile, routingConfig)
    runtime.persistRoutingPatch({ vm: { memory: '4g', vcpus: 4, smbios: { product: 'Precision 5860' } } })
    const saved = JSON.parse(fs.readFileSync(routingFile, 'utf8'))
    assert.equal(saved.vm.memory, '4g')
    assert.equal(saved.vm.vcpus, 4)
    assert.equal(saved.vm.smbios.product, 'Precision 5860')
    assert.equal(saved.vm.smbios.manufacturer, 'Dell Inc.')
    assert.equal(saved.vm.allow_tcg, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PUT /api/panel/routing rejects an invalid vm patch before persist', async () => {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: os.tmpdir() }, limits: { max_body_bytes: 4096 } },
    routingConfig: {},
    stickyRouter: { stats: () => ({}) },
    persistRoutingPatch() {
      throw new Error('must not persist invalid vm')
    },
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => ({ vm: { memory: '3g' } }),
  })
  await handlePanel({ method: 'PUT' }, {}, new URL('http://localhost/api/panel/routing'))
  assert.equal(response.status, 400)
  assert.equal(response.body?.error?.code, 'invalid_vm_config')
  assert.match(response.body?.error?.message, /memory/)
})
