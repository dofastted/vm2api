import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ApiScheduler,
  stripPrefix,
  resolveUpstreamPool,
  modelIdsForEndpoint,
} from '../../src/lib/pool/api-scheduler.mjs'

const ep = (over = {}) => ({
  id: 'ep1',
  name: 'one',
  disabled: false,
  prefix: 'team',
  priority: 0,
  disable_cooling: false,
  models: [
    { name: 'claude-sonnet-4-6', alias: 'sonnet' },
    { name: 'claude-opus-4-6', alias: 'opus' },
    { name: 'upstream-a', alias: 'pool' },
    { name: 'upstream-b', alias: 'pool' },
  ],
  api_key_entries: [
    { id: 'k1', api_key: 'aaaa', disabled: false },
    { id: 'k2', api_key: 'bbbb', disabled: false },
  ],
  ...over,
})

test('prefix strip and catalog ids', () => {
  assert.equal(stripPrefix('team/sonnet', 'team'), 'sonnet')
  const ids = modelIdsForEndpoint(ep())
  assert.ok(ids.includes('sonnet'))
  assert.ok(ids.includes('team/sonnet'))
})

test('same alias builds upstream name pool', () => {
  assert.deepEqual(resolveUpstreamPool(ep(), 'pool'), ['upstream-a', 'upstream-b'])
  assert.deepEqual(resolveUpstreamPool(ep(), 'team/pool'), ['upstream-a', 'upstream-b'])
})

test('grouped round-robin walks keys then endpoints', () => {
  const s = new ApiScheduler()
  const a = ep({
    id: 'a',
    prefix: '',
    models: [{ name: 'u1', alias: 'm' }],
    api_key_entries: [{ id: 'a1', api_key: '1', disabled: false }],
  })
  const b = ep({
    id: 'b',
    prefix: '',
    models: [{ name: 'u2', alias: 'm' }],
    api_key_entries: [{ id: 'b1', api_key: '2', disabled: false }],
  })
  s.reload([a, b])
  const first = s.pick('m')
  const second = s.pick('m')
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.notEqual(first.endpoint.id, second.endpoint.id)
})

test('catalog is unique aliases', () => {
  const s = new ApiScheduler()
  s.reload([ep({ prefix: '' }), ep({ id: 'ep2', prefix: '', name: 'two' })])
  const cat = s.catalog()
  const ids = cat.data.map((x) => x.id)
  assert.equal(ids.filter((id) => id === 'sonnet').length, 1)
})

test('catalog filters by protocol group_type', () => {
  const s = new ApiScheduler()
  const anthropicEp = ep({
    id: 'anthropic-ep',
    protocol: 'anthropic',
    prefix: '',
    models: [{ name: 'claude-sonnet-4-5', alias: 'claude-sonnet-4-5' }],
  })
  const openaiEp = ep({
    id: 'openai-ep',
    protocol: 'openai',
    prefix: '',
    models: [{ name: 'gpt-4o', alias: 'gpt-4o' }],
  })
  s.reload([anthropicEp, openaiEp])

  const all = s.catalog({ groupType: 'all' }).data.map((m) => m.id)
  assert.deepEqual(all.sort(), ['claude-sonnet-4-5', 'gpt-4o'])

  const anthropicOnly = s.catalog({ groupType: 'anthropic' }).data.map((m) => m.id)
  assert.deepEqual(anthropicOnly, ['claude-sonnet-4-5'])

  const openaiOnly = s.catalog({ groupType: 'openai' }).data.map((m) => m.id)
  assert.deepEqual(openaiOnly, ['gpt-4o'])
})

test('pick filters endpoints by protocol group_type', () => {
  const s = new ApiScheduler()
  const anthropicEp = ep({
    id: 'anthropic-ep',
    protocol: 'anthropic',
    prefix: '',
    models: [{ name: 'shared-model', alias: 'shared-model' }],
    api_key_entries: [{ id: 'k-ant', api_key: 'sk-ant', disabled: false }],
  })
  const openaiEp = ep({
    id: 'openai-ep',
    protocol: 'openai',
    prefix: '',
    models: [{ name: 'shared-model', alias: 'shared-model' }],
    api_key_entries: [{ id: 'k-oai', api_key: 'sk-oai', disabled: false }],
  })
  s.reload([anthropicEp, openaiEp])

  const pickAnthropic = s.pick('shared-model', Date.now(), { groupType: 'anthropic' })
  assert.equal(pickAnthropic.ok, true)
  assert.equal(pickAnthropic.endpoint.id, 'anthropic-ep')

  const pickOpenai = s.pick('shared-model', Date.now(), { groupType: 'openai' })
  assert.equal(pickOpenai.ok, true)
  assert.equal(pickOpenai.endpoint.id, 'openai-ep')

  const failUnknown = s.pick('nonexistent', Date.now(), { groupType: 'anthropic' })
  assert.equal(failUnknown.ok, false)
})

test('official endpoint catalog includes protocol models even with single or empty models list', () => {
  const s = new ApiScheduler()
  const epClaude = ep({
    id: 'ep-claude',
    kind: 'claude',
    protocol: 'anthropic',
    base_url: 'https://api.anthropic.com',
    prefix: '',
    models: [{ name: 'claude-sonnet-4-5', alias: 'claude-sonnet-4-5' }],
    api_key_entries: [{ id: 'k1', api_key: 'sk-ant-test', disabled: false }],
  })
  s.reload([epClaude])

  const cat = s.catalog({ groupType: 'anthropic' })
  const ids = cat.data.map((m) => m.id)
  assert.ok(ids.length > 5, 'should return full official catalog, got: ' + ids.length)
  assert.ok(ids.includes('claude-sonnet-4-5'), 'should include claude-sonnet-4-5')
  assert.ok(
    ids.some((id) => id.includes('haiku')),
    'should include haiku models',
  )
  assert.ok(
    ids.some((id) => id.includes('opus')),
    'should include opus models',
  )

  const picked = s.pick('claude-sonnet-4-6')
  assert.equal(picked.ok, true)
  assert.equal(picked.endpoint.id, 'ep-claude')
  assert.equal(picked.upstream_model, 'claude-sonnet-4-6')
})
