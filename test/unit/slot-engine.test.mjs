import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertCliHopAllowed,
  KERNEL_NATIVE_SLOT_COUNT,
  normalizeInferenceConfig,
  normalizeKernelDataplane,
  normalizeSessionSlots,
  parseSlotEnginePolicyPatch,
  parseSlotPolicyTargets,
  personaModeFromPreset,
  resolveCliSystemLayout,
  resolveInferenceEngine,
  resolveCragKernelVersion,
  resolveKernelDataplane,
  resolveOfficialCcInference,
  resolveSessionSlots,
  resolveSlotPersonaPreset,
  slotPersonaModeOverride,
  validateInferenceRoutingPatch,
} from '../../src/lib/vm/slot-engine.mjs'

import {
  getVm,
  listVms,
  persistSlotEnginePolicy,
  persistSlotEnginePolicyMany,
  summarizeVm,
} from '../../src/lib/vm/vm-registry.mjs'

test('session slots default to native capacity and clamp persisted values', () => {
  assert.equal(KERNEL_NATIVE_SLOT_COUNT, 20)
  assert.equal(normalizeSessionSlots(undefined), 20)
  assert.equal(normalizeSessionSlots(0), 1)
  assert.equal(normalizeSessionSlots(99), 20)
  assert.equal(resolveSessionSlots({ policy: { sessionSlots: 4 } }, { inference: { session_slots: 8 } }), 4)
  assert.equal(resolveSessionSlots({}, { inference: { session_slots: 8 } }), 8)
  assert.equal(normalizeInferenceConfig({}).session_slots, 20)
})

test('routing patch rejects session slots outside the native range', () => {
  assert.deepEqual(validateInferenceRoutingPatch({ inference: { session_slots: 0 } }), [
    'inference.session_slots 必须是 1–20 的整数',
  ])
  assert.deepEqual(validateInferenceRoutingPatch({ inference: { session_slots: 21 } }), [
    'inference.session_slots 必须是 1–20 的整数',
  ])
  assert.deepEqual(validateInferenceRoutingPatch({ inference: { session_slots: 8 } }), [])
})

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-engine-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  return root
}

function writeVm(root, id, extra = {}) {
  const file = path.join(root, 'vms', `${id}.json`)
  fs.writeFileSync(
    file,
    JSON.stringify({
      id,
      name: id,
      policy: { maxConcurrency: 2 },
      ...extra,
    }),
  )
  return file
}

test('vm engine overrides routing, empty inherits rust', () => {
  assert.equal(resolveInferenceEngine({}, {}), 'rust')
  assert.equal(resolveInferenceEngine({}, { inference: { engine: 'rust' } }), 'rust')
  assert.equal(resolveInferenceEngine({ inference_engine: 'go' }, { inference: { engine: 'rust' } }), 'rust')
  assert.equal(resolveInferenceEngine({ inference_engine: 'rust' }, { inference: { engine: 'go' } }), 'rust')
})

test('kernel dataplane defaults wrap and accepts cc and crag', () => {
  assert.equal(resolveKernelDataplane({}, {}), 'wrap')
  assert.equal(resolveKernelDataplane({}, { inference: { dataplane: 'crag' } }), 'crag')
  assert.equal(resolveKernelDataplane({}, { inference: { dataplane: 'cc-node' } }), 'cc')
  assert.equal(resolveKernelDataplane({ dataplane: 'wrap' }, { inference: { dataplane: 'crag' } }), 'wrap')
  assert.equal(normalizeKernelDataplane('cli-node'), 'wrap')
  assert.equal(normalizeKernelDataplane('cc'), 'cc')
  assert.equal(normalizeKernelDataplane('official-cli'), 'crag')
  assert.deepEqual(validateInferenceRoutingPatch({ inference: { dataplane: 'nope' } }), [
    'inference.dataplane 必须是 wrap、cc 或 crag',
  ])
  assert.deepEqual(validateInferenceRoutingPatch({ inference: { dataplane: 'cc' } }), [])
  const patch = parseSlotEnginePolicyPatch({ dataplane: 'cc' })
  assert.equal(patch.ok, true)
  assert.equal(patch.patch.dataplane, 'cc')
  const cragPatch = parseSlotEnginePolicyPatch({ dataplane: 'crag' })
  assert.equal(cragPatch.ok, true)
  assert.equal(cragPatch.patch.dataplane, 'crag')
})

test('crag kernel version is native v2, including a stored legacy pin', () => {
  assert.equal(resolveCragKernelVersion({}, {}), 'v2')
  assert.equal(resolveCragKernelVersion({}, { inference: { crag_kernel_version: 'crag-v2' } }), 'v2')
  assert.equal(
    resolveCragKernelVersion({ crag_kernel_version: 'legacy' }, { inference: { crag_kernel_version: 'v2' } }),
    'v2',
  )
  assert.equal(resolveCragKernelVersion({ crag_kernel_version: 'elf' }, {}), 'v2')
  assert.equal(resolveCragKernelVersion({ crag_kernel_version: 'crag-v2' }, {}), 'v2')
  assert.equal(normalizeInferenceConfig({}).crag_kernel_version, 'v2')
  assert.equal(parseSlotEnginePolicyPatch({ crag_kernel_version: 'nope' }).ok, false)
  const legacy = parseSlotEnginePolicyPatch({ crag_kernel_version: 'legacy' })
  assert.equal(legacy.ok, true)
  assert.equal(legacy.patch.crag_kernel_version, 'v2')
  const patch = parseSlotEnginePolicyPatch({ dataplane: 'crag', crag_kernel_version: 'v2' })
  assert.equal(patch.ok, true)
  assert.equal(patch.patch.dataplane, 'crag')
  assert.equal(patch.patch.crag_kernel_version, 'v2')
  assert.deepEqual(validateInferenceRoutingPatch({ inference: { crag_kernel_version: '' } }), [
    'inference.crag_kernel_version 必须是 v2',
  ])
})

test('resolveCliSystemLayout follows persona_preset, not leftover inject-only', () => {
  assert.equal(resolveCliSystemLayout({}, {}), 'identity')
  assert.equal(resolveCliSystemLayout({}, { compatibility: { persona_preset: 'official_full' } }), 'identity')
  assert.equal(resolveCliSystemLayout({}, { compatibility: { persona_preset: 'official' } }), 'identity')
  assert.equal(resolveCliSystemLayout({}, { compatibility: { persona_inject: 'rewrite' } }), 'identity')
  assert.equal(resolveCliSystemLayout({}, { compatibility: { persona_preset: 'zero' } }), 'zero')
  assert.equal(
    resolveCliSystemLayout({ persona_preset: 'zero' }, { compatibility: { persona_inject: 'rewrite' } }),
    'zero',
  )
})

test('official_cc inference: rust is always cli-hop; stored go is rust', () => {
  assert.equal(resolveOfficialCcInference({}, {}), 'cli-hop')
  assert.equal(resolveOfficialCcInference({}, { official_cc: {} }), 'cli-hop')
  assert.equal(resolveOfficialCcInference({}, { official_cc: { inference: 'cli-hop' } }), 'cli-hop')
  assert.equal(
    resolveOfficialCcInference(
      { inference_engine: 'go', official_cc_inference: 'http' },
      { official_cc: { inference: 'cli-hop' } },
    ),
    'cli-hop',
  )

  assert.equal(resolveOfficialCcInference({ inference_engine: 'go' }, {}), 'cli-hop')
  assert.equal(resolveOfficialCcInference({ inference_engine: 'rust' }, {}), 'cli-hop')
  assert.equal(resolveOfficialCcInference({ inference_engine: 'rust', official_cc_inference: 'http' }, {}), 'cli-hop')
  assert.equal(assertCliHopAllowed({}, { official_cc: { inference: 'cli-hop' } }).ok, true)
  assert.equal(assertCliHopAllowed({ inference_engine: 'rust' }, {}).ok, true)
  assert.equal(assertCliHopAllowed({ inference_engine: 'go' }, { official_cc: { inference: 'cli-hop' } }).ok, true)
})

test('setup-token rust slots still cli-hop; only token minting skips CLI', () => {
  const rust = { inference_engine: 'rust', claude: { mode: 'setup-token' } }
  assert.equal(resolveInferenceEngine(rust, {}), 'rust')
  assert.equal(resolveOfficialCcInference(rust, {}), 'cli-hop')
})

test('slot persona inherit vs override', () => {
  const routing = { compatibility: { persona_preset: 'official_full' } }
  assert.equal(resolveSlotPersonaPreset({}, routing), 'official_full')
  assert.equal(resolveSlotPersonaPreset({ persona_preset: 'zero' }, routing), 'zero')
  assert.equal(resolveSlotPersonaPreset({ persona_preset: 'official' }, routing), 'official')
  assert.equal(resolveSlotPersonaPreset({ persona_preset: 'official_full' }, routing), 'official_full')
  assert.equal(slotPersonaModeOverride({}), null)
  assert.equal(slotPersonaModeOverride({ persona_preset: 'official' }), 'official_prompt')
  assert.equal(slotPersonaModeOverride({ persona_preset: 'zero' }), 'zero')
  assert.equal(slotPersonaModeOverride({ persona_preset: 'official_full' }), 'official_full')
  assert.equal(personaModeFromPreset('official'), 'official_prompt')
  assert.equal(personaModeFromPreset('official_full'), 'official_full')
})

test('persistSlotEnginePolicy writes inherit as deleted fields', () => {
  const root = makeRoot()
  const file = writeVm(root, 'vm-01')
  persistSlotEnginePolicy(root, 'vm-01', { inference_engine: 'rust', persona_preset: 'zero' })
  let saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.inference_engine, 'rust')
  assert.equal(saved.persona_preset, 'zero')
  assert.equal(summarizeVm(saved).inference_engine, 'rust')
  assert.equal(summarizeVm(saved).persona_preset, 'zero')
  persistSlotEnginePolicy(root, 'vm-01', { inference_engine: '', persona_preset: '' })
  saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.inference_engine, undefined)
  assert.equal(saved.persona_preset, undefined)
  assert.equal(summarizeVm(saved).inference_engine, null)
  assert.equal(summarizeVm(saved).persona_preset, null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('persisted CRAG pin survives summary projection and overrides conflicting global defaults', (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeVm(root, 'vm-01', { dataplane: 'wrap', crag_kernel_version: 'legacy' })
  getVm(root, 'vm-01')
  persistSlotEnginePolicy(root, 'vm-01', { dataplane: 'crag', crag_kernel_version: 'v2' })
  const summary = listVms(root)[0]
  assert.equal(summary.dataplane, 'crag')
  assert.equal(summary.crag_kernel_version, 'v2')
  assert.equal(resolveKernelDataplane(summary, { inference: { dataplane: 'wrap' } }), 'crag')
  assert.equal(resolveCragKernelVersion(summary, { inference: { crag_kernel_version: 'legacy' } }), 'v2')
  persistSlotEnginePolicy(root, 'vm-01', { dataplane: 'wrap', crag_kernel_version: '' })
  const wrapped = listVms(root)[0]
  assert.equal(wrapped.dataplane, 'wrap')
  assert.equal(wrapped.crag_kernel_version, null)
  assert.equal(resolveKernelDataplane(wrapped, { inference: { dataplane: 'crag' } }), 'wrap')
})

test('persistSlotEnginePolicyMany updates listed ids only', () => {
  const root = makeRoot()
  writeVm(root, 'vm-01')
  writeVm(root, 'vm-02')
  const report = persistSlotEnginePolicyMany(root, ['vm-01'], { inference_engine: 'rust' })
  assert.equal(report.updated, 1)
  assert.equal(report.items[0].inference_engine, 'rust')
  const two = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-02.json'), 'utf8'))
  assert.equal(two.inference_engine, undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

test('patch parsers reject unknown values', () => {
  assert.equal(parseSlotEnginePolicyPatch({}).ok, false)
  assert.equal(parseSlotEnginePolicyPatch({ inference_engine: 'kvm' }).ok, false)
  assert.equal(parseSlotEnginePolicyPatch({ persona_preset: 'custom' }).ok, false)
  const ok = parseSlotEnginePolicyPatch({ inference_engine: 'inherit', persona_preset: 'official_prompt' })
  assert.equal(ok.ok, true)
  assert.equal(ok.patch.inference_engine, '')
  assert.equal(ok.patch.persona_preset, 'official')
  const full = parseSlotEnginePolicyPatch({ persona_preset: 'official_full' })
  assert.equal(full.ok, true)
  assert.equal(full.patch.persona_preset, 'official_full')
  const targets = parseSlotPolicyTargets({ ids: ['vm-01', 'vm-01', ''] })
  assert.deepEqual(targets.ids, ['vm-01'])
  assert.equal(parseSlotPolicyTargets({ all: true }).all, true)
  assert.deepEqual(validateInferenceRoutingPatch({ inference: { engine: 'rust' } }), [])
  assert.ok(validateInferenceRoutingPatch({ inference: { engine: '' } }).length)
  assert.equal(normalizeInferenceConfig({ engine: 'rust', fallback_to_go: false }).fallback_to_go, false)
  assert.equal(normalizeInferenceConfig({ engine: 'rust', strict: true }).strict, true)
  const omitted = normalizeInferenceConfig({ engine: 'go' })
  assert.equal(omitted.engine, 'rust')
  assert.equal(omitted.fallback_to_go, false)
  assert.equal(omitted.eager_start, true)
  assert.equal(omitted.health_ttl_ms, 2000)
  assert.equal(omitted.tcp_nodelay, true)

  assert.equal(
    normalizeInferenceConfig({ eager_start: false, health_ttl_ms: 0, tcp_nodelay: false }).eager_start,
    false,
  )
  assert.equal(normalizeInferenceConfig({ health_ttl_ms: 0 }).health_ttl_ms, 0)
  assert.ok(validateInferenceRoutingPatch({ inference: { strict: 'true' } }).length)
  assert.ok(validateInferenceRoutingPatch({ inference: { fallback_to_go: 1 } }).length)
  assert.ok(validateInferenceRoutingPatch({ inference: { eager_start: 1 } }).length)
  assert.ok(validateInferenceRoutingPatch({ inference: { health_ttl_ms: -1 } }).length)
  assert.deepEqual(validateInferenceRoutingPatch({ inference: { eager_start: false, health_ttl_ms: 0 } }), [])
})
