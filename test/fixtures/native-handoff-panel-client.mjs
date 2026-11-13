import assert from 'node:assert/strict'
import path from 'node:path'
import { callGoWorker, streamGoWorker, workerHealth } from '../../src/lib/transport/go-worker-client.mjs'

// Invoked by CRAG's ignored native_v2 loopback fixture. No production credentials.
const [socketPath, tokenPath, model = 'claude-opus-5-5'] = process.argv.slice(2)
assert.ok(socketPath && tokenPath, 'kernel socket and fixture token paths are required')
const root = path.dirname(tokenPath)
const exec = {
  projectRoot: root,
  homeDir: path.join(root, 'panel-client-home'),
  vm: {
    id: 'offline-native-handoff',
    runtime: { worker_socket: socketPath, worker_run_dir: root, worker_token_file: tokenPath },
  },
}
const health = await workerHealth(exec, { timeoutMs: 10_000 })
assert.equal(health.ok, true)
assert.ok(health.capabilities?.includes('native_handoff_v1'), 'fixture must run the new native handoff contract')
exec.workerStatus = health

const options = {
  exec,
  cliHop: true,
  cragPrint: true,
  managedCrag: true,
  tenantId: 'offline-panel-handoff',
  reqHeaders: { 'anthropic-version': '2023-06-01' },
  timeoutMs: 90_000,
  idleTimeoutMs: 90_000,
  routing: { compatibility: { cch_enabled: false }, failover: {} },
}
const tools = [
  {
    name: 'panel_probe',
    description: 'Return the caller-provided value for an offline handoff test.',
    input_schema: { type: 'object', properties: { step: { type: 'integer' } }, required: ['step'] },
  },
]

async function request(body, { stream = true, deliveryMode = 'realtime' } = {}) {
  const lines = []
  const result = stream
    ? await streamGoWorker({ ...options, body: { ...body, stream: true }, deliveryMode, onEvent: (line) => lines.push(line) })
    : await callGoWorker({ ...options, body: { ...body, stream: false }, deliveryMode })
  assert.equal(result.nativeHandoff, true)
  assert.equal(result.ok, true, JSON.stringify(result.body))
  assert.equal(result.providerResult?.usage_complete, true)
  assert.equal(result.stopReason, result.providerResult.stop_reason)
  assert.deepEqual(result.usage, result.body.usage)
  assert.equal(result.headers?.['x-kin-provider-result'], undefined)
  assert.doesNotMatch(lines.join('\n'), /kin_provider_result|x-kin-provider-result/)
  return { result, lines }
}

const limited = await request({
  model,
  max_tokens: 4096,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'medium' },
  messages: [{ role: 'user', content: 'offline panel max token handoff' }],
})
assert.equal(limited.result.stopReason, 'max_tokens')
assert.equal(limited.result.usage.output_tokens, 4096)
assert.doesNotMatch(limited.lines.join('\n'), /output token maximum|event: error/)

const refused = await request({
  model,
  max_tokens: 4096,
  tools,
  messages: [{ role: 'user', content: 'offline panel refused tool handoff' }],
}, { stream: false })
assert.equal(refused.result.stopReason, 'refusal')
assert.equal(refused.result.body.content.some((block) => block.type === 'tool_use'), false)

const conversation = {
  model,
  max_tokens: 4096,
  tools,
  messages: [{ role: 'user', content: 'offline panel two tool batches' }],
}
for (const step of [1, 2]) {
  const { result } = await request(conversation, { deliveryMode: step === 1 ? 'verified' : 'realtime' })
  assert.equal(result.stopReason, 'tool_use')
  const calls = result.body.content.filter((block) => block.type === 'tool_use')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'panel_probe')
  assert.equal(calls[0].input.step, step)
  conversation.messages.push(
    { role: 'assistant', content: result.body.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: calls[0].id, content: `completed step ${step}` }] },
  )
}
const finished = await request(conversation, { stream: false })
assert.equal(finished.result.stopReason, 'end_turn')
assert.equal(finished.result.body.content.filter((block) => block.type === 'text').map((block) => block.text).join(''), 'done')
console.log('native-panel handoff: max_tokens, refusal and two tool batches passed')
