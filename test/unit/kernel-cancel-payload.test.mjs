import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { callGoWorker } from '../../src/lib/transport/go-worker-client.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const kernelBin = path.join(root, 'bin/kin-kernel')
const cliBin = path.join(root, 'share/wrap-cli/cli-node')
const payloadTest = process.platform === 'linux' && fs.existsSync(kernelBin) && fs.existsSync(cliBin) ? test : test.skip

payloadTest(
  'existing kernel payload cancellation can return complete HTTP while execution remains unconfirmed',
  { timeout: 15_000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cancel-proof-'))
    const socketPath = path.join(dir, 'kernel.sock')
    const cliHome = path.join(dir, 'cli-home')
    fs.mkdirSync(path.join(cliHome, '.claude'), { recursive: true })
    const credentialPath = path.join(cliHome, '.claude/credentials.json')
    fs.writeFileSync(credentialPath, JSON.stringify({ anthropicApiKey: { apiKey: 'synthetic-local-only' } }), {
      mode: 0o600,
    })
    const tokenPath = path.join(dir, 'internal.token')
    const token = 'synthetic-internal-cancel'
    fs.writeFileSync(tokenPath, token, { mode: 0o600 })
    let entered
    const submitted = new Promise((resolve) => {
      entered = resolve
    })
    const upstream = http.createServer(async (req, res) => {
      for await (const _ of req) {
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: {
            id: 'msg_synthetic',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        })}\n\n`,
      )
      entered()
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`
    const configPath = path.join(dir, 'kernel.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        vm_id: 'vm-cancel-proof',
        socket_path: socketPath,
        credential_path: credentialPath,
        internal_token: token,
        provider: 'local_cli',
        claude_bin: cliBin,
        slots_per_worker: 2,
        test_endpoints: true,
        anthropic_base_url: upstreamUrl,
      }),
      { mode: 0o600 },
    )
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: cliHome,
      ANTHROPIC_API_KEY: 'synthetic-local-only',
      ANTHROPIC_BASE_URL: upstreamUrl,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      NO_PROXY: '127.0.0.1,localhost',
      KIN_ENVELOPE_PATH: path.join(dir, 'no-envelope.json'),
    }
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'KIN_SOCKS5',
      'KIN_HTTPS_PROXY',
      'KIN_CLAUDE_AI_OAUTH_JSON',
      'KIN_CLAUDE_CODE_OAUTH_TOKEN',
    ])
      delete env[key]
    const child = spawn(kernelBin, ['--gateway-worker', '--config', configPath], {
      cwd: dir,
      env,
      stdio: 'ignore',
      detached: true,
    })
    const closed = once(child, 'close')
    t.after(async () => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
      await closed
      upstream.closeAllConnections()
      await new Promise((resolve) => upstream.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    })
    const request = (requestPath, body) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            socketPath,
            path: requestPath,
            method: body ? 'POST' : 'GET',
            headers: { 'x-internal-token': token, 'content-type': 'application/json' },
            timeout: 2000,
          },
          (res) => {
            let data = ''
            res.on('data', (chunk) => {
              data += chunk
            })
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }))
          },
        )
        req.on('error', reject)
        req.on('timeout', () => req.destroy(new Error('synthetic request timeout')))
        req.end(body ? JSON.stringify(body) : undefined)
      })
    for (let i = 0; !fs.existsSync(socketPath) && i < 120 && child.exitCode === null; i++) await delay(50)
    const before = await request('/internal/health')
    const pending = callGoWorker({
      exec: { vmId: 'vm-cancel-proof', vm: { runtime: { worker_socket: socketPath, worker_token_file: tokenPath } } },
      envelope: {
        body: {
          model: 'claude-sonnet-4-6',
          max_tokens: 32,
          messages: [{ role: 'user', content: 'synthetic held request' }],
        },
        stream: false,
      },
      requestId: 'synthetic-cancel-proof',
      timeoutMs: 5000,
    })
    await Promise.race([
      submitted,
      pending.then(() => {
        throw new Error('request ended before synthetic provider entry')
      }),
    ])
    const cancelled = await request('/internal/v1/cancel', { request_id: 'synthetic-cancel-proof' })
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.body.cancelled, true)
    const result = await pending
    assert.equal(result.status, 502)
    assert.equal(result.body.error.code, 'provider_error')
    assert.equal(result.body.error.message, 'provider error: client disconnected')
    // This aggregate observation reproduces the counterexample; it is not a per-job termination signal.
    const after = await request('/internal/health')
    assert.equal(before.body.ready_slots, 2)
    assert.equal(after.body.ready_slots, 1)
    assert.equal(result.execution.ended, false)
    assert.equal(result.execution.reason, 'kernel_execution_unconfirmed')
  },
)
