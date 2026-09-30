import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../../share/wrap-cli/cli-node', import.meta.url))

async function runTurn(t, stopReason, apiError = false) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cli-hop-limit-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_limit',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 41, output_tokens: 0, cache_creation_input_tokens: 3, cache_read_input_tokens: 7 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '1 2 3 4 5' } },
    { type: 'content_block_stop', index: 0 },
    ...(apiError
      ? [{ type: 'error', error: { type: 'api_error', message: 'upstream fixture failure' } }]
      : [
          {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: 128 },
          },
          { type: 'message_stop' },
        ]),
  ]
  const requests = []
  const upstream = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (!req.url.startsWith('/v1/messages')) {
      res.writeHead(404).end()
      return
    }
    requests.push(JSON.parse(raw))
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_limit_fixture' })
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    upstream.closeAllConnections()
    return new Promise((resolve) => upstream.close(resolve))
  })
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: home,
    CLAUDE_CODE_KIN_NATIVE_SLOTS: '1',
    ANTHROPIC_API_KEY: 'fixture-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    NO_PROXY: '127.0.0.1,localhost',
  }
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ])
    delete env[key]
  const child = spawn(cli, [], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise((resolve) => child.once('close', resolve))
  t.after(async () => {
    child.kill('SIGKILL')
    await closed
  })
  let raw = ''
  let stderr = ''
  const frames = []
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const terminal = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CLI turn timed out: ${stderr}`)), 15000)
    const finish = (error, frame) => {
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve(frame)
    }
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => finish(new Error(`CLI exited ${code}: ${stderr}`)))
    child.stdout.on('data', (chunk) => {
      raw += chunk
      let end
      while ((end = raw.indexOf('\n')) >= 0) {
        const line = raw.slice(0, end)
        raw = raw.slice(end + 1)
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          continue
        }
        frames.push(frame)
        if (frame.type === 'kin_slot_ready') {
          child.stdin.write(
            JSON.stringify({
              type: 'kin_job_start',
              job_id: 'limit-job',
              slot_id: frame.slot_id,
              request: {
                model: 'claude-opus-5-5',
                max_tokens: 128,
                stream: true,
                output_config: { effort: 'low' },
                messages: [{ role: 'user', content: 'Print integers.' }],
              },
            }) + '\n',
          )
        }
        if (frame.type === 'kin_job_done' || frame.type === 'kin_job_error') finish(null, frame)
      }
    })
  })
  return {
    terminal,
    requests,
    events: frames.filter((frame) => frame.type === 'kin_stream_event').map((frame) => frame.event),
  }
}

for (const stopReason of ['max_tokens', 'end_turn']) {
  test(`native CLI preserves ${stopReason}, generated content and real usage`, { timeout: 20000 }, async (t) => {
    const result = await runTurn(t, stopReason)
    assert.equal(result.terminal.type, 'kin_job_done')
    assert.equal(result.requests.length, 1, 'normal truncation must not retry')
    assert.equal(result.requests[0].max_tokens, 128, 'honor the explicit output limit')
    assert.equal(result.events.find((event) => event.type === 'content_block_delta').delta.text, '1 2 3 4 5')
    assert.deepEqual(result.events.find((event) => event.type === 'message_start').message.usage, {
      input_tokens: 41,
      output_tokens: 0,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 7,
    })
    assert.deepEqual(
      result.events.find((event) => event.type === 'message_delta'),
      { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 128 } },
    )
    assert.equal(result.events.filter((event) => event.type === 'message_stop').length, 1)
  })
}

test('native CLI still fails on a real upstream SSE error', { timeout: 20000 }, async (t) => {
  const result = await runTurn(t, 'max_tokens', true)
  assert.equal(result.terminal.type, 'kin_job_error')
  assert.match(result.terminal.error, /upstream fixture failure/)
  assert.equal(
    result.events.some((event) => event.type === 'message_stop'),
    false,
  )
})
