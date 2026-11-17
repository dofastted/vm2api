import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { startGateway, api, readTrace, seedVm } from '../harness.mjs'
import { startRealChain } from './helpers/real-chain.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

async function startResponsesGateway(options) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-responses-'))
  const vm = seedVm({ project })
  const socket = vm.runtime.worker_socket
  fs.mkdirSync(vm.runtime.worker_run_dir, { recursive: true })
  fs.writeFileSync(vm.runtime.worker_token_file, 'responses-fixture')
  const kernel = http.createServer((req, res) => {
    if (req.url === '/internal/health') {
      return res.end(JSON.stringify({ ok: true, engine: 'rust', healthy: true, ready_slots: 4 }))
    }
    return res.writeHead(404).end()
  })
  const stopKernel = async () => {
    if (kernel.listening) await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(project, { recursive: true, force: true })
  }
  try {
    kernel.listen(socket)
    await once(kernel, 'listening')
    const gateway = await startGateway({
      ...options,
      project,
      env: { KIN_KERNEL_BIN: path.join(project, 'kin-kernel') },
    })
    return {
      ...gateway,
      stop: async () => {
        await gateway.stop()
        await stopKernel()
      },
    }
  } catch (error) {
    await stopKernel()
    throw error
  }
}

test('POST /v1/responses non-stream shape: object + output_text + usage', async () => {
  const gw = await startResponsesGateway({ mockText: 'hello-resp' })
  try {
    const r = await api(gw, 'POST', '/v1/responses', {
      body: { model: MODEL, input: 'hi', max_output_tokens: 4096 },
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.object, 'response')
    assert.equal(r.json.status, 'completed')
    assert.equal(r.json.output_text, 'hello-resp')
    const msg = (r.json.output || []).find((o) => o.type === 'message')
    assert.ok(msg)
    assert.equal(msg.content[0].type, 'output_text')
    assert.equal(msg.content[0].text, 'hello-resp')
    assert.equal(typeof r.json.usage.input_tokens, 'number')
    assert.equal(typeof r.json.usage.output_tokens, 'number')
    assert.equal(r.json.usage.total_tokens, r.json.usage.input_tokens + r.json.usage.output_tokens)
    const trace = readTrace(gw)
    assert.equal(trace.body.stream, true)
    assert.equal(trace.body.input, undefined)
    assert.notEqual(r.headers.get('content-type'), 'text/event-stream')
  } finally {
    await gw.stop()
  }
})

test('POST /v1/responses stream includes [DONE]', async () => {
  const gw = await startResponsesGateway({ mockText: 'rchunk' })
  try {
    const res = await fetch(gw.baseUrl + '/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gw.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, stream: true, input: 'hi', max_output_tokens: 4096 }),
    })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.match(body, /event: response.completed\n/)
    assert.match(body, /\[DONE\]/)
    assert.match(body, /rchunk/)
  } finally {
    await gw.stop()
  }
})

test('POST /v1/responses tools → function_call in output', async () => {
  const gw = await startResponsesGateway({ scenario: 'tool_use' })
  try {
    const r = await api(gw, 'POST', '/v1/responses', {
      body: {
        model: MODEL,
        input: 'read /tmp/x',
        max_output_tokens: 4096,
        tools: [
          {
            type: 'function',
            name: 'read_file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      },
    })
    assert.equal(r.status, 200, r.text)
    const fc = (r.json.output || []).find((o) => o.type === 'function_call')
    assert.ok(fc, JSON.stringify(r.json.output))
    assert.equal(fc.name, 'read_file')
  } finally {
    await gw.stop()
  }
})

test('Codex Responses history reaches the actual cli-node wire as Messages', {
  skip: !process.env.KIN_RESPONSES_KERNEL || !process.env.KIN_RESPONSES_CLI,
  timeout: 30000,
}, async (t) => {
  const chain = await startRealChain({
    kernelBin: process.env.KIN_RESPONSES_KERNEL,
    cliBin: process.env.KIN_RESPONSES_CLI,
    preset: 'official_full',
  })
  t.after(chain.close)
  const schema = { type: 'object', properties: { file: { type: 'string' } } }
  const wire = await chain.send({
    request: {
      path: '/v1/responses',
      headers: { 'user-agent': 'codex_cli_rs/0.0.0' },
      body: {
        model: 'claude-sonnet-5-5',
        max_output_tokens: 32000,
        stream: true,
        instructions: 'Validate a synthetic result.',
        input: [
          { role: 'user', content: 'Read the sample.' },
          {
            type: 'function_call',
            id: 'fc_different',
            call_id: 'call_sample',
            name: 'read_file',
            arguments: '{"file":"sample"}',
          },
          { type: 'function_call_output', call_id: 'call_sample', output: 'Synthetic result.' },
        ],
        tools: [{ type: 'function', name: 'read_file', parameters: schema }],
      },
    },
  })
  assert.equal(wire.status, 200, wire.response)
  assert.equal(wire.count, 1)
  assert.equal(wire.body.max_tokens, 32000)
  assert.equal(wire.body.input, undefined)
  assert.match(
    JSON.stringify({ system: wire.body.system, messages: wire.body.messages }),
    /Validate a synthetic result\./,
  )
  const blocks = wire.body.messages.flatMap((message) => message.content)
  const call = blocks.find((block) => block.type === 'tool_use')
  const result = blocks.find((block) => block.type === 'tool_result')
  assert.equal(call.id, 'call_sample')
  assert.equal(result.tool_use_id, call.id)
  assert.deepEqual(call.input, { file: 'sample' })
  assert.deepEqual(wire.body.tools.find((tool) => tool.name === call.name)?.input_schema, schema)
  assert.match(wire.response, /"type":"response.completed"/)
})
