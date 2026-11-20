import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { classifyUpstreamResult, repairAnthropicRequest } from '../../src/lib/pool/upstream-error-policy.mjs'
import { prepareOutboundEnvelope } from '../../src/lib/protocol/outbound-attempt.mjs'
import { finalizeWorkerPayload } from '../../src/lib/transport/go-worker-client.mjs'

openDatabase({ dbPath: ':memory:' })
after(() => closeDatabase())

const SAMPLING_REFUSALS = [
  'temperature may only be set to 1 when thinking is enabled.',
  '`temperature` is not supported for this model',
  'top_p is deprecated for this model',
  'This model does not support top_k sampling',
]

const samplingPolicy = { action: 'repair-and-retry', reason: 'sampling_repairable' }

const canonicalBody = () => ({
  model: 'claude-opus-5-5',
  max_tokens: 1024,
  thinking: { type: 'adaptive' },
  temperature: 0.7,
  top_p: 0.9,
  top_k: 40,
  messages: [{ role: 'user', content: 'hi' }],
})

test('an upstream refusing the sampling fields asks for a repair retry', () => {
  for (const message of SAMPLING_REFUSALS) {
    const policy = classifyUpstreamResult({ status: 400, body: { error: { message } } }, {})
    assert.equal(policy.action, 'repair-and-retry', message)
    assert.equal(policy.reason, 'sampling_repairable', message)
  }
})

test('a thinking refusal still classifies as thinking, not sampling', () => {
  const policy = classifyUpstreamResult(
    { status: 400, body: { error: { message: 'adaptive thinking is not supported' } } },
    {},
  )
  assert.equal(policy.reason, 'thinking_repairable')
})

test('an already repaired attempt does not loop on the same refusal', () => {
  const policy = classifyUpstreamResult(
    { status: 400, body: { error: { message: SAMPLING_REFUSALS[0] } } },
    { repaired: true },
  )
  assert.equal(policy.action, 'stop')
  assert.equal(policy.reason, 'invalid_request')
})

test('the sampling repair leaves the body alone, thinking included', () => {
  const body = canonicalBody()
  const out = repairAnthropicRequest(body, samplingPolicy)
  // Stripping here would only be refilled by the assembly, and falling through
  // to the default repair would drop thinking with it.
  assert.deepEqual(out.thinking, { type: 'adaptive' })
  assert.equal(out.temperature, 0.7)
})

test('the HTTP outbound path sends no sampling on a drop retry', () => {
  const pinned = prepareOutboundEnvelope({
    canonicalBody: canonicalBody(),
    inbound: canonicalBody(),
    identity: {},
    unofficial: true,
    stream: false,
  }).body
  assert.equal(pinned.temperature, 1)

  const dropped = prepareOutboundEnvelope({
    canonicalBody: canonicalBody(),
    inbound: canonicalBody(),
    identity: {},
    unofficial: true,
    stream: false,
    dropSampling: true,
  }).body
  assert.equal(Object.hasOwn(dropped, 'temperature'), false)
  assert.equal(Object.hasOwn(dropped, 'top_p'), false)
  assert.equal(Object.hasOwn(dropped, 'top_k'), false)
  assert.equal(dropped.thinking?.type, 'adaptive')
})

test('the CRAG print path sends no sampling on a drop retry', () => {
  const exec = {
    homeDir: '',
    vm: { claude: { mode: 'setup-token' } },
    workerStatus: { runtime_variant: 'crag-v2', capabilities: ['generation_controls_v3'] },
  }
  const payload = (dropSampling) =>
    finalizeWorkerPayload({
      body: canonicalBody(),
      reqHeaders: {},
      exec,
      identity: null,
      routing: {},
      cliHop: true,
      cragPrint: true,
      dropSampling,
    }).body

  const pinned = payload(false)
  assert.equal(pinned.temperature, 1)
  assert.equal(Object.hasOwn(pinned, 'top_p'), false)

  const dropped = payload(true)
  assert.equal(Object.hasOwn(dropped, 'temperature'), false)
  assert.equal(Object.hasOwn(dropped, 'top_p'), false)
  assert.equal(Object.hasOwn(dropped, 'top_k'), false)
  // Dropping sampling must not disturb thinking; the display is the routing default.
  assert.equal(dropped.thinking?.type, 'adaptive')
})
