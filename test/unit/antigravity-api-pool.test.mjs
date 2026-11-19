import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createAntigravityPoolRuntime,
  pickAntigravityCandidates,
  isAntigravityFailoverError,
  antigravitySlotAllowsModel,
} from '../../src/lib/pool/antigravity-slot-pool.mjs'
import {
  createAntigravityResponseStore,
  antigravityResponseScope,
} from '../../src/lib/protocol/antigravity-response-store.mjs'

const vm = {
  id: 'vm-ag-01',
  platform: 'antigravity',
  status: 'running',
  schedulable: true,
  antigravity: { authenticated: true },
  proxy: { id: 'px-test', host: '1.2.3.4', port: 1080 },
}
const options = {
  routing: { antigravity: { enabled: true, models: ['model-one'] } },
  model: 'model-one',
  scope: { group_type: 'all' },
  ownerScope: { type: 'platform' },
  supportsModel: () => true,
}

test('Antigravity candidates enforce owner, key, runtime, login, operator and actual model catalog', () => {
  const pick = (rows, patch = {}) =>
    pickAntigravityCandidates(rows, { ...options, ...patch, runtime: createAntigravityPoolRuntime() }).candidates.map(
      (c) => c.vm.id,
    )
  assert.deepEqual(pick([vm]), [vm.id])
  for (const patch of [
    { platform: 'openai' },
    { status: 'stopped' },
    { schedulable: false },
    { antigravity: { authenticated: false } },
    { owner_user_id: 'user-other' },
    { node_id: 'remote' },
    { proxy: null },
    { allowed_models: ['different-model'] },
  ])
    assert.deepEqual(pick([{ ...vm, ...patch }]), [], JSON.stringify(patch))
  assert.deepEqual(pick([vm], { supportsModel: () => false }), [])
  assert.deepEqual(pick([vm], { scope: { group_type: 'antigravity', allowed_vms: ['vm-other'] } }), [])
  assert.deepEqual(
    pick([vm], { scope: { group_type: 'all', vm_pool_id: 'pool_12345678', allowed_vms: ['vm-other'] } }),
    [],
  )
  assert.deepEqual(pick([{ ...vm, owner_user_id: 'user-one' }], { ownerScope: { type: 'user', userId: 'user-one' } }), [
    vm.id,
  ])
  // Pin diagnostics bypass the operator switch, never credentials or model availability.
  assert.deepEqual(pick([{ ...vm, schedulable: false }], { pin: vm.id }), [vm.id])
  assert.deepEqual(pick([{ ...vm, antigravity: { authenticated: false } }], { pin: vm.id }), [])
  assert.equal(antigravitySlotAllowsModel({ allowed_models: ['model-one'] }, 'model-one-high'), true)
  assert.equal(antigravitySlotAllowsModel({ allowed_models: ['claude-opus-5'] }, 'claude-opus-5-5'), false)
})

test('Antigravity execution lease is atomic and idempotent; RPM and error holds are isolated', async () => {
  let at = 1000
  const runtime = createAntigravityPoolRuntime({ now: () => at })
  const first = runtime.acquire(vm.id)
  assert.ok(first)
  assert.equal(runtime.acquire(vm.id), null)
  const wait = runtime.wait({ deadline: at + 1000 })
  first.release()
  first.release()
  assert.equal(await wait, true)
  assert.equal(runtime.snapshot(vm.id).inFlight, 0)
  assert.equal(runtime.acquire(vm.id, { maxRpm: 1 }), null)
  at += 60_001
  const second = runtime.acquire(vm.id, { maxRpm: 1 })
  assert.ok(second)
  second.release()
  runtime.report(vm.id, { status: 429, retry_after_ms: 5000 })
  assert.equal(runtime.acquire(vm.id), null)
  assert.ok(runtime.acquire('vm-independent'))
  at += 5001
  assert.ok(runtime.acquire(vm.id))
})

test('Antigravity queued admission can be cancelled and queue size is bounded', async () => {
  const runtime = createAntigravityPoolRuntime({ maxWaiters: 1 })
  const controller = new AbortController()
  const pending = runtime.wait({ deadline: Date.now() + 10000, signal: controller.signal })
  await assert.rejects(runtime.wait({ deadline: Date.now() + 10000 }), { code: 'pool_wait_queue_full' })
  controller.abort()
  assert.equal(await pending, false)
  assert.equal(runtime.waiterCount, 0)
  assert.equal(isAntigravityFailoverError({ status: 401 }), true)
  assert.equal(isAntigravityFailoverError({ status: 429, output_committed: true }), false)
  assert.equal(isAntigravityFailoverError({ status: 400 }), false)
  assert.equal(isAntigravityFailoverError({ status: 403, code: 'content_policy' }), false)
  assert.equal(isAntigravityFailoverError({ status: 502, usage: { input_tokens: 12, output_tokens: 1 } }), false)
})

test('Responses continuation store enforces key/tenant/model, TTL, bounds and cloned history', () => {
  let at = 1000
  const store = createAntigravityResponseStore({ now: () => at, ttlMs: 20, maxEntries: 1 })
  const record = {
    scope: 'key-one',
    model: 'model-one',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    content: [{ type: 'text', text: 'hi' }],
    vmId: vm.id,
  }
  assert.equal(store.put('resp_one', record), true)
  assert.equal(store.get('resp_one', { scope: 'other-key' }), null)
  assert.equal(store.get('resp_one', { scope: record.scope, model: 'other-model' }), null)
  const history = store.get('resp_one', record)
  assert.equal(history.messages.length, 2)
  history.messages[0].content[0].text = 'edited'
  assert.equal(store.get('resp_one', record).messages[0].content[0].text, 'hello')
  store.put('resp_two', record)
  assert.equal(store.get('resp_one', record), null)
  at += 21
  assert.equal(store.get('resp_two', record), null)
  assert.notEqual(
    antigravityResponseScope({ apiKeyRecord: { id: 'one', user_id: 'a' } }),
    antigravityResponseScope({ apiKeyRecord: { id: 'one', user_id: 'b' } }),
  )
})
