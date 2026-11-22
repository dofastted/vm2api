import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import {
  familyOfModelId,
  getModelEntry,
  getPolicyCatalogIds,
  loadModelPolicy,
  saveModelPolicy,
  seedDefaultPolicy,
} from '../../src/lib/protocol/model-policy.mjs'
import {
  clearModelsCache,
  gatewayModelCatalog,
  isCatalogModelId,
  validateOfficialModel,
} from '../../src/lib/protocol/models.mjs'
import { prepareAnthropicRequest } from '../../src/lib/protocol/anthropic-policy.mjs'
import { officialMessagesBody } from '../../src/lib/protocol/anthropic-messages.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { withRequestProtocolBetas } from '../../src/lib/protocol/claude-code-betas.mjs'
import { finalizeWorkerPayload } from '../../src/lib/transport/go-worker-client.mjs'

const model = 'claude-mythos-5-2'
const dotted = 'claude-mythos-5.2'
const fable = 'claude-fable-5-2'

openDatabase({ dbPath: ':memory:' })
after(() => closeDatabase())
beforeEach(() => {
  new SettingsRepo().set('model_policy', seedDefaultPolicy())
  loadModelPolicy({ force: true })
  clearModelsCache()
})

test('saved pre-Mythos policies expose Mythos 5.2 without resetting administrator settings', () => {
  const saved = seedDefaultPolicy()
  delete saved.models[model]
  delete saved.aliases[dotted]
  saved.models[fable].enabled = false
  saved.models[fable].params.max_tokens_cap = 2048
  saved.defaults.max_tokens = 512
  new SettingsRepo().set('model_policy', saved)
  loadModelPolicy({ force: true })

  assert.ok(getPolicyCatalogIds().includes(model))
  assert.equal(isCatalogModelId(model), true)
  const item = gatewayModelCatalog({ groupType: 'anthropic' }).data.find((item) => item.id === model)
  assert.equal(item.family, 'mythos')
  assert.equal(item.display_name, 'Mythos 5.2')
  assert.equal(item.enabled, true)
  assert.equal(getModelEntry(fable).enabled, false)
  assert.equal(getModelEntry(fable).params.max_tokens_cap, 2048)
  assert.equal(familyOfModelId(model), 'mythos')
  assert.ok(!gatewayModelCatalog({ groupType: 'openai' }).data.some((item) => item.id === model))

  for (const id of [model, dotted, `anthropic/${dotted}`, `openrouter/anthropic/${model}[1m]`]) {
    const result = validateOfficialModel(id)
    assert.equal(result.ok, true, id)
    assert.equal(result.model, model, id)
  }
  assert.equal(validateOfficialModel(`${dotted}[1m]`).want1m, true)
  assert.equal(validateOfficialModel('claude-mythos-99').error.code, 'model_not_supported')
})

test('Mythos shares the Fable 5.2 defaults while keeping independent overrides', () => {
  const a = getModelEntry(model)
  const b = getModelEntry(fable)
  assert.deepEqual(a.capabilities, b.capabilities)
  assert.deepEqual(a.params, b.params)
  assert.deepEqual(a.betas, b.betas)
  assert.equal(a.params.max_tokens_default, 128000)
  assert.equal(a.params.max_tokens_cap, 128000)
  assert.equal(a.params.default_effort, 'medium')

  saveModelPolicy({ models: { [model]: { enabled: false, params: { max_tokens_cap: 8192 } } } })
  loadModelPolicy({ force: true })
  clearModelsCache()
  for (const id of [model, dotted]) {
    assert.equal(validateOfficialModel(id).error.code, 'model_disabled')
  }
  assert.equal(getModelEntry(model).params.max_tokens_cap, 8192)
  assert.equal(getModelEntry(fable).params.max_tokens_cap, 128000)
  assert.equal(validateOfficialModel(fable).ok, true)
  assert.ok(!gatewayModelCatalog({ groupType: 'anthropic' }).data.some((item) => item.id === model))
})

test('API and CRAG assembly keep the Mythos id and use the Fable 5.2 protocol parameters', () => {
  const input = (id) => ({
    model: id,
    messages: [{ role: 'user', content: 'Hello' }],
    thinking: { type: 'adaptive' },
    thread: { id: 'thread-test' },
    output_config: { effort: 'medium' },
  })
  assert.deepEqual(withRequestProtocolBetas([], input(model)), withRequestProtocolBetas([], input(fable)))
  for (const prepare of [prepareAnthropicRequest, prepareCliHopBody]) {
    const shaped = prepare(officialMessagesBody(input(model)))
    assert.equal(shaped.model, model)
    assert.equal(shaped.max_tokens, 128000)
    assert.equal(shaped.thinking.type, 'adaptive')
    assert.equal(shaped.output_config.effort, 'medium')
  }
  const exec = { workerStatus: { runtime_variant: 'crag-v2', capabilities: ['model_directive'] } }
  for (const cragPrint of [false, true]) {
    const finalize = (id) => {
      const body = input(id)
      delete body.thread
      return finalizeWorkerPayload({ body, cliHop: true, cragPrint, exec }).body
    }
    const body = finalize(model)
    assert.equal(body.model, model)
    if (cragPrint) {
      assert.equal(body.crag_model.id, model)
      assert.deepEqual(body.crag_model.params, finalize(fable).crag_model.params)
      assert.deepEqual(body.crag_model.capabilities, finalize(fable).crag_model.capabilities)
    }
  }
})
