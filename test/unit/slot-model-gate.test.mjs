import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  modelMatchesAllowlist,
  parseAllowedModelsPatch,
  slotAllowsModel,
  normalizeAllowedModels,
} from '../../src/lib/pool/slot-model-gate.mjs'
import { persistAllowedModels, summarizeVm } from '../../src/lib/vm/vm-registry.mjs'

test('empty allowlist inherits all models', () => {
  assert.equal(normalizeAllowedModels(null), null)
  assert.equal(normalizeAllowedModels([]), null)
  assert.equal(modelMatchesAllowlist('claude-opus-5', null), true)
})

test('allowlist matches aliases and dated prefixes', () => {
  assert.equal(modelMatchesAllowlist('claude-fable-5-20260801', ['claude-fable-5']), true)
  assert.equal(modelMatchesAllowlist('claude-fable-5', ['fable']), true)
  assert.equal(modelMatchesAllowlist('claude-opus-5', ['claude-sonnet-5']), false)
})

test('fable requires max even if the allowlist includes it', () => {
  const pro = slotAllowsModel({
    vm: { claude: { account_tier: 'pro' }, policy: { allowed_models: ['claude-fable-5'] } },
    model: 'claude-fable-5',
  })
  assert.equal(pro.ok, false)
  assert.equal(pro.reason, 'fable_requires_max')
  const unknown = slotAllowsModel({
    vm: { claude: {}, policy: {} },
    model: 'claude-fable-5',
  })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.reason, 'fable_requires_max')
  const max = slotAllowsModel({
    vm: { claude: { account_tier: 'max' }, policy: {} },
    model: 'claude-fable-5',
  })
  assert.equal(max.ok, true)
})

test('legacy Fable 5.1 allowlists accept the corrected id without allowing Fable 5', () => {
  assert.equal(modelMatchesAllowlist('claude-fable-5-1', ['claude-fable-5.1']), true)
  assert.equal(modelMatchesAllowlist('claude-fable-5.1', ['claude-fable-5-1']), true)
  assert.equal(modelMatchesAllowlist('claude-fable-5-1-20260918', ['claude-fable-5.1']), true)
  assert.equal(modelMatchesAllowlist('claude-fable-5-1', ['claude-fable-5']), false)
  assert.equal(modelMatchesAllowlist('claude-fable-5', ['claude-fable-5-1']), false)
  assert.equal(modelMatchesAllowlist('claude-fable-5', ['claude-fable-5.1']), false)
  assert.deepEqual(parseAllowedModelsPatch(['claude-fable-5.1']), { ok: true, value: ['claude-fable-5-1'] })
  const vm = { claude: { account_tier: 'max' }, policy: { allowed_models: ['claude-fable-5.1'] } }
  assert.deepEqual(slotAllowsModel({ vm, model: 'claude-fable-5-1' }), { ok: true })
  assert.deepEqual(slotAllowsModel({ vm, model: 'claude-fable-5' }), { ok: false, reason: 'model_not_allowed' })
  assert.deepEqual(slotAllowsModel({ vm: { ...vm, claude: { account_tier: 'pro' } }, model: 'claude-fable-5-1' }), {
    ok: false,
    reason: 'fable_requires_max',
  })
})

test('parseAllowedModelsPatch rejects unknown ids', () => {
  const bad = parseAllowedModelsPatch(['not-a-claude-model'])
  assert.equal(bad.ok, false)
  const ok = parseAllowedModelsPatch(['claude-fable-5', 'fable'])
  assert.equal(ok.ok, true)
  assert.ok(ok.value.includes('claude-fable-5'))
})

test('parseAllowedModelsPatch accepts GPT ids for Codex VMs', () => {
  const gpt = parseAllowedModelsPatch(['gpt-5.4'], { platform: 'openai' })
  assert.equal(gpt.ok, true)
  assert.deepEqual(gpt.value, ['gpt-5.4'])
  const mixed = parseAllowedModelsPatch(['gpt-5.4'], {})
  assert.equal(mixed.ok, false)
})

test('persistAllowedModels writes and summarizeVm echoes the list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-allowed-models-'))
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'vm-01.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      id: 'vm-01',
      name: '01',
      policy: { maxConcurrency: 2 },
      claude: { account_tier: 'max' },
    }),
  )
  persistAllowedModels(root, 'vm-01', ['claude-fable-5'])
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(saved.policy.allowed_models, ['claude-fable-5'])
  assert.deepEqual(summarizeVm(saved).allowed_models, ['claude-fable-5'])
  persistAllowedModels(root, 'vm-01', null)
  const cleared = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(cleared.policy.allowed_models, undefined)
  assert.equal(summarizeVm(cleared).allowed_models, null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('Codex slot rejects Claude models even with an empty allowlist', () => {
  const gpt = slotAllowsModel({
    vm: { platform: 'openai', family: 'codex', policy: {} },
    model: 'gpt-5.4',
  })
  assert.equal(gpt.ok, true)
  const claude = slotAllowsModel({
    vm: { platform: 'openai', family: 'codex', policy: {} },
    model: 'claude-haiku-4-5',
  })
  assert.equal(claude.ok, false)
  assert.equal(claude.reason, 'codex_model_required')
})

test('Claude slot rejects GPT models', () => {
  const hit = slotAllowsModel({
    vm: { platform: 'anthropic', family: 'claude', claude: { account_tier: 'max' }, policy: {} },
    model: 'gpt-5.4',
  })
  assert.equal(hit.ok, false)
  assert.equal(hit.reason, 'claude_model_required')
})
