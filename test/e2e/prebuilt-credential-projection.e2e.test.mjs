import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const repository = path.resolve(import.meta.dirname, '../..')
// Use the same explicit payload overrides as auto-mode.e2e.test.mjs. No mock
// kernel or provider credentials are loaded from a developer's project.
const kernelBin = process.env.KIN_AUTOMODE_KERNEL || path.join(repository, 'bin/kin-kernel')
const cliBin = process.env.KIN_AUTOMODE_CLI || path.join(repository, 'share/wrap-cli/cli-node')

test('the prebuilt kernel consumes an atomic AT-only projection without restarting its kernel or CLI', {
  timeout: 45000,
}, async (t) => {
  fs.accessSync(kernelBin, fs.constants.X_OK)
  fs.accessSync(cliBin, fs.constants.X_OK)
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-at-projection-'))
  const home = path.join(temp, 'home')
  const socketPath = path.join(temp, 'kernel.sock')
  const credentials = path.join(home, '.claude', 'credentials.json')
  const tokens = ['synthetic-at-before', 'synthetic-at-after']
  const internalToken = 'synthetic-local-internal-token'
  const observations = []
  let child
  let closed
  let upstream
  let stderrBytes = 0
  let spawnError = null
  const summary = (result) =>
    JSON.stringify({
      status: result?.status,
      type: result?.body?.type,
      error_code: result?.body?.error?.code,
      error_type: result?.body?.error?.type,
      kernel_exit: child?.exitCode,
      spawn_error: spawnError,
      stderr_bytes: stderrBytes,
      provider_calls: observations.length,
      token_indices: observations.map((row) => row.tokenIndex),
    })
      .replaceAll(tokens[0], '[redacted]')
      .replaceAll(tokens[1], '[redacted]')
      .replaceAll(internalToken, '[redacted]')
      .slice(0, 800)
  const publish = (token) => {
    fs.writeFileSync(
      credentials + '.next',
      JSON.stringify({
        claudeAiOauth: {
          accessToken: token,
          expiresAt: Date.now() + 86400000,
          accountUuid: 'synthetic-account',
          scopes: ['user:inference', 'user:profile'],
          subscriptionType: 'max',
        },
      }),
      { mode: 0o600, flag: 'wx' },
    )
    fs.renameSync(credentials + '.next', credentials)
  }
  const assertATOnly = () => {
    const parsed = JSON.parse(fs.readFileSync(credentials, 'utf8'))
    assert.deepEqual(Object.keys(parsed), ['claudeAiOauth'])
    assert.deepEqual(Object.keys(parsed.claudeAiOauth).sort(), [
      'accessToken',
      'accountUuid',
      'expiresAt',
      'scopes',
      'subscriptionType',
    ])
    assert.equal(Object.hasOwn(parsed.claudeAiOauth, 'refreshToken'), false)
    assert.equal(fs.statSync(credentials).mode & 0o777, 0o600)
  }
  const request = (endpoint, payload, timeout = 15000) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          path: endpoint,
          method: payload ? 'POST' : 'GET',
          agent: false,
          headers: { 'x-internal-token': internalToken, 'content-type': 'application/json' },
          timeout,
        },
        (res) => {
          let data = ''
          res.on('data', (chunk) => {
            data += chunk
            if (data.length > 65536) res.destroy(new Error('synthetic response limit'))
          })
          res.on('error', reject)
          res.on('end', () => {
            let body
            try {
              body = JSON.parse(data)
            } catch {}
            resolve({ status: res.statusCode, body, complete: res.complete })
          })
        },
      )
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error('synthetic local request timeout')))
      req.end(payload ? JSON.stringify(payload) : undefined)
    })
  try {
    fs.mkdirSync(path.dirname(credentials), { recursive: true, mode: 0o700 })
    fs.symlinkSync('credentials.json', path.join(path.dirname(credentials), '.credentials.json'))
    publish(tokens[0])
    assertATOnly()
    upstream = http.createServer(async (req, res) => {
      try {
        for await (const _ of req) {
          /* Consume only this synthetic request. */
        }
      } catch {
        return res.destroy()
      }
      const tokenIndex = tokens.findIndex(
        (token) => req.headers.authorization === `Bearer ${token}` || req.headers['x-api-key'] === token,
      )
      observations.push({ method: req.method, path: new URL(req.url, 'http://local').pathname, tokenIndex })
      if (observations.at(-1).path !== '/v1/messages') return res.writeHead(404).end()
      if (tokenIndex < 0)
        return res.writeHead(401, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'synthetic credential mismatch' },
          }),
        )
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = [
        {
          type: 'message_start',
          message: {
            id: 'msg_synthetic',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [],
            usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic answer' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    })
    await new Promise((resolve, reject) => {
      upstream.once('error', reject)
      upstream.listen(0, '127.0.0.1', resolve)
    })
    const url = `http://127.0.0.1:${upstream.address().port}`
    const config = path.join(temp, 'kernel.json')
    fs.writeFileSync(
      config,
      JSON.stringify({
        vm_id: 'synthetic-prebuilt',
        socket_path: socketPath,
        credential_path: credentials,
        internal_token: internalToken,
        provider: 'local_cli',
        claude_bin: cliBin,
        slots_per_worker: 1,
        test_endpoints: true,
        anthropic_base_url: url,
      }),
      { mode: 0o600 },
    )
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: url,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      NO_PROXY: '127.0.0.1,localhost',
      KIN_ENVELOPE_PATH: path.join(temp, 'no-envelope.json'),
    }
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'KIN_SOCKS5',
      'KIN_HTTPS_PROXY',
      'KIN_CLAUDE_AI_OAUTH_JSON',
      'KIN_CLAUDE_CODE_OAUTH_TOKEN',
      'KIN_CRS_MOCK',
      'KIN_FAKE_SESSION_OAUTH',
    ])
      delete env[key]
    child = spawn(kernelBin, ['--gateway-worker', '--config', config], {
      cwd: temp,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    })
    closed = once(child, 'close').then(
      () => {},
      () => {},
    )
    child.once('error', (error) => {
      spawnError = error.code || error.name
    })
    child.stderr.on('data', (part) => {
      stderrBytes += part.length
    })
    const kernelPid = child.pid
    let before
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && child.exitCode == null && !spawnError) {
      try {
        before = await request('/internal/health', null, 250)
        if (before.status === 200 && before.body?.ready_slots === 1) break
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(before?.body?.ready_slots, 1, summary(before))
    assert.ok(Number.isInteger(before.body.cli_pid) && before.body.cli_pid > 0, summary(before))
    const socketInode = fs.statSync(socketPath).ino
    const credentialInode = fs.statSync(credentials).ino
    for (let index = 0; index < 2; index++) {
      if (index === 1) publish(tokens[index])
      assertATOnly()
      const result = await request('/internal/v1/messages', {
        request_id: 'synthetic-rotation-' + index,
        body: {
          model: 'claude-sonnet-4-6',
          max_tokens: 32,
          messages: [{ role: 'user', content: 'synthetic local request' }],
        },
        stream: false,
      })
      assert.equal(result.status, 200, summary(result))
      assert.equal(result.complete, true, summary(result))
      assert.equal(result.body?.type, 'message', summary(result))
      assert.equal(result.body?.stop_reason, 'end_turn', summary(result))
      assert.equal(
        result.body?.content?.find((block) => block.type === 'text')?.text,
        'synthetic answer',
        summary(result),
      )
      assert.equal(child.pid, kernelPid)
      assert.equal(child.exitCode, null)
      const health = await request('/internal/health')
      assert.equal(health.body?.cli_pid, before.body.cli_pid, summary(health))
      assert.equal(health.body?.cli_restarts, before.body.cli_restarts, summary(health))
      assert.equal(fs.statSync(socketPath).ino, socketInode)
    }
    assert.notEqual(fs.statSync(credentials).ino, credentialInode, 'credential projection must use atomic replacement')
    assertATOnly()
    assert.deepEqual(observations, [
      { method: 'POST', path: '/v1/messages', tokenIndex: 0 },
      { method: 'POST', path: '/v1/messages', tokenIndex: 1 },
    ])
    t.diagnostic(
      JSON.stringify({
        boundary:
          'prebuilt payload with AT-only synthetic credentials and localhost fake provider; no refresh/provider acceptance',
        kernel_sha256: crypto.createHash('sha256').update(fs.readFileSync(kernelBin)).digest('hex'),
        cli_sha256: crypto.createHash('sha256').update(fs.readFileSync(cliBin)).digest('hex'),
        kernel_pid: kernelPid,
        cli_pid: before.body.cli_pid,
        cli_restarts: before.body.cli_restarts,
        temp,
      }),
    )
  } finally {
    let cleanupError
    try {
      if (child?.pid) {
        const killGroup = (signal) => {
          try {
            process.kill(-child.pid, signal)
          } catch (error) {
            if (error.code !== 'ESRCH') throw error
          }
        }
        killGroup('SIGTERM')
        let timer
        try {
          await Promise.race([
            closed,
            new Promise((resolve) => {
              timer = setTimeout(resolve, 1000)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
        killGroup('SIGKILL')
        await closed
        let groupPresent = true
        for (let attempt = 0; attempt < 40; attempt++) {
          try {
            process.kill(-child.pid, 0)
          } catch (error) {
            if (error.code !== 'ESRCH') throw error
            groupPresent = false
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        assert.equal(groupPresent, false, `owned process group still exists: ${child.pid}`)
      }
    } catch (error) {
      cleanupError = error
    }
    if (upstream) {
      upstream.closeAllConnections()
      await new Promise((resolve) => upstream.close(resolve))
    }
    fs.rmSync(temp, { recursive: true, force: true })
    assert.equal(fs.existsSync(temp), false)
    if (cleanupError) throw cleanupError
    t.diagnostic(`owned process group stopped, localhost provider closed, temporary directory removed: ${temp}`)
  }
})
