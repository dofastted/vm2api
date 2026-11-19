import '../fixtures/kin-computer-test-env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import {
  parseAntigravityModels,
  syncAntigravityModels,
  readAntigravityModelCatalog,
  slotAntigravitySupportsModel,
  mergeAntigravityCatalogModels,
  foldAntigravityModelCatalog,
} from '../../src/lib/oauth/antigravity-models.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { parseAllowedModelsPatch } from '../../src/lib/pool/slot-model-gate.mjs'
import { parseModelLimits } from '../../src/lib/admin/price-catalog.mjs'

const vm = {
  id: 'vm-ag',
  platform: 'antigravity',
  owner_user_id: 'owner',
  runtime: { type: 'docker', network: 'kin-ag-egress' },
  proxy: { id: 'p-test', enabled: true },
}
const stdout =
  'gemini-example-low\tGemini Example (Low)\ngemini-example-high\tGemini Example (High)\nclaude-example\tClaude Example\n'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-models-'))
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('official catalog parser accepts only public bounded TSV model metadata', () => {
  assert.deepEqual(parseAntigravityModels(stdout), [
    { id: 'gemini-example-low', display_name: 'Gemini Example (Low)', vendor: 'google', enabled: true },
    { id: 'gemini-example-high', display_name: 'Gemini Example (High)', vendor: 'google', enabled: true },
    { id: 'claude-example', display_name: 'Claude Example', vendor: 'anthropic', enabled: true },
  ])
  for (const raw of ['', 'Login with Google', 'id\tname\textra', 'id\tname\u001b', 'a'.repeat(300000)])
    assert.equal(parseAntigravityModels(raw), null)
})

test('catalog sync is slot-local, model-only and persists private metadata tied to the owner', async (t) => {
  const root = fixture(t)
  let argv
  const result = await syncAntigravityModels({
    projectRoot: root,
    vm,
    ops: {
      execFile: async (cmd, args, options) => {
        assert.equal(cmd, 'docker')
        argv = args
        assert.equal(options.timeout, 20000)
        return { stdout, stderr: 'private diagnostics must not be returned' }
      },
    },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(argv.slice(-6), ['timeout', '-k', '2s', '15s', 'agy', 'models'])
  assert.equal(argv.includes('kin-ag'), true)
  assert.equal(result.models.length, 3)
  assert.doesNotMatch(JSON.stringify(result), /private diagnostics|owner/)
  assert.equal(slotAntigravitySupportsModel(root, vm, 'gemini-example-high'), true)
  assert.equal(slotAntigravitySupportsModel(root, vm, 'gemini-example'), false)
  assert.equal(slotAntigravitySupportsModel(root, vm, 'gpt-example'), false)
  assert.deepEqual(foldAntigravityModelCatalog(readAntigravityModelCatalog(root, vm)).models, [
    { id: 'gemini-example', display_name: 'Gemini Example', vendor: 'google', enabled: true, levels: ['low', 'high'] },
    { id: 'claude-example', display_name: 'Claude Example', vendor: 'anthropic', enabled: true, levels: [] },
  ])
  assert.equal(readAntigravityModelCatalog(root, { ...vm, owner_user_id: 'changed' }), null)
  const file = path.join(root, 'data', 'antigravity-models', `${vm.id}.json`)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
  const failed = await syncAntigravityModels({
    projectRoot: root,
    vm,
    ops: {
      execFile: async () => {
        throw new Error('secret-token')
      },
    },
  })
  assert.equal(failed.ok, false)
  assert.doesNotMatch(JSON.stringify(failed), /secret-token/)
  assert.equal(readAntigravityModelCatalog(root, vm).models.length, 3)
})

test('catalog metadata never follows a symlink or publishes a stale owner result', async (t) => {
  const root = fixture(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'data'))
  fs.symlinkSync(outside, path.join(root, 'data', 'antigravity-models'))
  const result = await syncAntigravityModels({ projectRoot: root, vm, ops: { execFile: async () => ({ stdout }) } })
  assert.equal(result.ok, false)
  assert.equal(readAntigravityModelCatalog(root, vm), null)
  assert.deepEqual(fs.readdirSync(outside), [])
  fs.unlinkSync(path.join(root, 'data', 'antigravity-models'))
  const changed = await syncAntigravityModels({
    projectRoot: root,
    vm,
    ops: {
      execFile: async () => ({ stdout }),
      getVm: () => ({ ...vm, owner_user_id: 'new' }),
    },
  })
  assert.equal(changed.code, 'antigravity_owner_changed')
})

test('global model merge folds variants and preserves disabled choices, levels and display/vendor overrides', () => {
  const old = { id: 'gemini-example', display_name: 'Custom', enabled: false, vendor: 'private', levels: ['high'] }
  assert.deepEqual(mergeAntigravityCatalogModels([old], parseAntigravityModels(stdout)), [
    old,
    { id: 'claude-example', display_name: 'Claude Example', vendor: 'anthropic', enabled: true, levels: [] },
  ])
  assert.deepEqual(mergeAntigravityCatalogModels([], parseAntigravityModels(stdout))[0].levels, ['low', 'high'])
})

test('token limits prefer the vendor provider, fall back to the reseller majority, and never override admin values', () => {
  const limits = parseModelLimits({
    google: { models: { 'gemini-example': { limit: { context: 1048576, output: 32768 } } } },
    reseller: {
      models: {
        'google/gemini-example': { limit: { context: 1000000, output: 1000000 } },
        'openai/gpt-oss-x': { limit: { context: 131072, output: 32768 } },
      },
    },
    other: { models: { 'gpt-oss-x': { limit: { context: 131072, output: 32768 } } } },
    third: { models: { 'gpt-oss-x': { limit: { context: 128000, output: 8192 } } } },
  })
  assert.deepEqual(limits['gemini-example'], { context: 1048576, output: 32768 })
  assert.deepEqual(limits['gpt-oss-x'], { context: 131072, output: 32768 })
  const merged = mergeAntigravityCatalogModels(
    [{ id: 'gemini-example', context_window: 200000 }],
    [{ id: 'gpt-oss-x' }],
    (id) => (limits[id] ? { context: limits[id].context, output: limits[id].output } : null),
  )
  assert.equal(merged[0].context_window, 200000)
  assert.equal(merged[0].max_output_tokens, 32768)
  assert.equal(merged[1].context_window, 131072)
})

test('model access is invalidated by account replacement and rejects linked catalog files', async (t) => {
  const root = fixture(t)
  await syncAntigravityModels({ projectRoot: root, vm, ops: { execFile: async () => ({ stdout }) } })
  const run = path.join(root, 'vms', vm.id, 'run')
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(
    path.join(run, 'antigravity-auth.json'),
    JSON.stringify({ authenticated: true, updated_at: new Date().toISOString() }),
  )
  assert.equal(readAntigravityModelCatalog(root, vm), null)
  const file = path.join(root, 'data', 'antigravity-models', `${vm.id}.json`)
  const outside = path.join(root, 'untrusted.json')
  fs.renameSync(file, outside)
  fs.symlinkSync(outside, file)
  assert.equal(readAntigravityModelCatalog(root, vm), null)
})

test('AG allowlists store base official IDs; the retired prefix is rejected', () => {
  assert.deepEqual(parseAllowedModelsPatch(['gemini-example', 'claude-example'], { vm }), {
    ok: true,
    value: ['gemini-example', 'claude-example'],
  })
  for (const model of ['../../secret', 'google/model', 'antigravity/gemini-example', '', 'a\nheader', 23])
    assert.equal(parseAllowedModelsPatch([model], { vm }).ok, false)
})

function panel(root, role, owner, body, extra = {}) {
  const response = new EventEmitter()
  const handler = createPanelHandler({
    cfg: { paths: { project: root } },
    routingConfig: {},
    requireAuth(req) {
      Object.assign(req, { panelUser: 'tester', panelRole: role, panelUserId: owner })
      return true
    },
    readBody: async () => body,
    json(_res, status, payload) {
      Object.assign(response, { status, body: payload })
      return true
    },
    ...extra,
  })
  return async (suffix = 'antigravity/models/sync') => {
    const req = Object.assign(new EventEmitter(), { method: 'POST', headers: {} })
    await handler(req, response, new URL(`http://localhost/api/panel/vms/${vm.id}/${suffix}`))
    return response
  }
}

test('owners sync their slot; admin syncs publish the global catalog', async (t) => {
  const root = fixture(t)
  let calls = 0
  const syncAntigravityModels = async () => {
    calls++
    return { ok: true, models: parseAntigravityModels(stdout), updated_at: new Date().toISOString() }
  }
  for (const [role, owner, body, status] of [
    ['user', 'other', {}, [403, 404]],
    ['super', 'owner', {}, [403, 404]],
    ['user', 'owner', { publish_global: true }, [400]],
  ]) {
    const res = await panel(root, role, owner, body, { syncAntigravityModels })()
    assert.ok(status.includes(res.status), JSON.stringify(res.body))
  }
  assert.equal(calls, 0)
  let patch
  const persistRoutingPatch = (value) => {
    patch = value
  }
  const own = await panel(root, 'user', 'owner', {}, { syncAntigravityModels, persistRoutingPatch })()
  assert.equal(own.status, 200)
  assert.equal(own.body.data.published_global, false)
  assert.equal(patch, undefined)
  const fresh = await panel(root, 'admin', 'admin', {}, { syncAntigravityModels, persistRoutingPatch })()
  assert.equal(fresh.body.data.published_global, true)
  assert.equal(patch.antigravity.enabled, true)
  assert.ok(patch.antigravity.models.length > 0 && patch.antigravity.models.every((model) => model.enabled))
  const admin = await panel(
    root,
    'admin',
    'admin',
    {},
    {
      syncAntigravityModels,
      routingConfig: { antigravity: { enabled: false, models: [{ id: 'gemini-example', enabled: false }] } },
      persistRoutingPatch,
    },
  )()
  assert.equal(admin.status, 200, JSON.stringify(admin.body))
  assert.equal(patch.antigravity.enabled, false)
  assert.equal(patch.antigravity.models[0].enabled, false)
  assert.equal(patch.antigravity.models.length, 2)
})

test('AG scheduling needs confirmed login and allows existing authenticated accounts', async (t) => {
  const root = fixture(t)
  const missing = await panel(root, 'user', 'owner', { schedulable: true })('schedulable')
  assert.equal(missing.status, 409)
  const run = path.join(root, 'vms', vm.id, 'run')
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(path.join(run, 'antigravity-auth.json'), JSON.stringify({ authenticated: true }))
  const allowed = await panel(root, 'user', 'owner', { schedulable: true })('schedulable')
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body))
  assert.equal(allowed.body.data.schedulable, true)
})
