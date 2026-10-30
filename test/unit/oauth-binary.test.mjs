import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { generateAuthUrl, peekAuthUrlSession, resetAuthUrlSessions } from '../../src/lib/oauth/oauth-auth-url.mjs'
import { CLIENT_ID, FULL_OAUTH_SCOPE, REDIRECT_URI, TOKEN_UA } from '../../src/lib/oauth/oauth-contract.mjs'
import { prepareSlotOAuth, runGuestOAuthAuthService } from '../../src/lib/oauth/guest-oauth-helper.mjs'
import { slotExec } from '../../src/lib/vm/slot-runtime.mjs'

test('guest OAuth helper preserves provider state, PKCE and cookie authorization', {
  timeout: 30000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-authorize-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  t.after(resetAuthUrlSessions)
  const key = path.join(root, 'key.pem')
  const cert = path.join(root, 'cert.pem')
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=claude.ai',
        '-addext',
        'subjectAltName=DNS:claude.ai,DNS:platform.claude.com,DNS:api.anthropic.com',
      ],
      { stdio: 'ignore' },
    )
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    t.skip('openssl unavailable')
    return
  }
  const org = '12345678-1234-4234-8234-123456789abc'
  let expectedExchange = null
  let tokenRequests = 0
  const accessToken = 'fixture-access-token'
  const refreshToken = 'fixture-refresh-token'
  const sessionKey = 'sk-ant-sid-unit-cookie'
  const requests = []
  let authorizeMode = 'success'
  const upstream = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    requests.push({ method: req.method, url: req.url, headers: req.headers, payload })
    res.setHeader('content-type', 'application/json')
    if (req.method === 'POST' && req.url === '/v1/oauth/token') {
      tokenRequests++
      const challenge = crypto.createHash('sha256').update(payload.code_verifier).digest('base64url')
      if (
        !expectedExchange ||
        payload.code !== expectedExchange.code ||
        challenge !== expectedExchange.challenge ||
        payload.redirect_uri !== expectedExchange.redirectUri ||
        payload.state !== expectedExchange.state ||
        (expectedExchange.state === undefined && Object.hasOwn(payload, 'state'))
      ) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'invalid_grant' }))
        return
      }
      const token = JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: 28800,
        scope: FULL_OAUTH_SCOPE,
      })
      res.write(token.slice(0, 20))
      res.end(token.slice(20))
      return
    }
    if (req.method === 'GET' && req.url.startsWith('/api/claude_cli/bootstrap?')) {
      res.end(
        JSON.stringify({
          oauth_account: {
            account_email: 'exchange@example.test',
            account_uuid: 'account-exchange',
            organization_uuid: org,
          },
        }),
      )
      return
    }
    if (req.method === 'PATCH' && req.url === '/api/oauth/account/settings') {
      res.end('{}')
      return
    }
    if (req.method === 'GET' && req.url === '/api/organizations') {
      res.end(JSON.stringify([{ uuid: org, raven_type: 'team' }]))
      return
    }
    if (req.method === 'POST' && req.url === `/v1/oauth/${org}/authorize`) {
      if (payload.organization_uuid !== org || req.headers.cookie !== `sessionKey=${sessionKey}`) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid request format' } }))
        return
      }
      if (authorizeMode === 'stale') {
        res.writeHead(403)
        res.end(
          JSON.stringify({
            error: { type: 'permission_error', message: 'Session is not fresh enough to authorize' },
          }),
        )
        return
      }
      expectedExchange = {
        code: 'cookie-auth-code',
        challenge: payload.code_challenge,
        redirectUri: payload.redirect_uri,
        state: payload.state,
      }
      const state = authorizeMode === 'state_mismatch' ? 'wrong-provider-state' : payload.state
      res.end(JSON.stringify({ redirect_uri: `${payload.redirect_uri}?code=cookie-auth-code&state=${state}` }))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const sockets = new Set()
  const proxy = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let pending = Buffer.alloc(0)
    let greeted = false
    const onData = (chunk) => {
      pending = Buffer.concat([pending, chunk])
      if (!greeted) {
        if (pending.length < 2 || pending.length < 2 + pending[1]) return
        pending = pending.subarray(2 + pending[1])
        greeted = true
        socket.write(Buffer.from([5, 0]))
      }
      if (pending.length < 5 || pending.length < 7 + pending[4]) return
      socket.off('data', onData)
      const target = net.connect(upstream.address().port, '127.0.0.1', () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
        socket.pipe(target).pipe(socket)
      })
      sockets.add(target)
      target.on('close', () => sockets.delete(target))
      target.on('error', () => socket.destroy())
      socket.on('close', () => target.destroy())
    }
    socket.on('data', onData)
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all([
      new Promise((resolve) => proxy.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ])
  })
  const vm = {
    id: 'vm-01',
    runtime: { type: 'docker' },
    proxy: { id: 'px-fixture', host: '127.0.0.1', port: proxy.address().port },
  }
  const runDir = path.join(root, 'vms', vm.id, 'run')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  fs.writeFileSync(
    path.join(runDir, 'kernel.json'),
    JSON.stringify({
      credential_path: '/home/kincli/.claude/credentials.json',
    }),
  )
  const exec = slotExec(root, vm)
  const binary = fileURLToPath(new URL('../../bin/kin-oauth-auth', import.meta.url))
  // Only guest process execution is substituted. The shipped provider engine
  // talks to the real TLS/SOCKS fixture; this does not prove Docker isolation.
  const run = (payload) =>
    runGuestOAuthAuthService(
      {
        ...payload,
        timeout_ms: 5000,
        proxy_url: 'socks5h://127.0.0.1:1',
      },
      {
        exec,
        projectRoot: root,
        timeoutMs: 5000,
        prepare: (options) =>
          prepareSlotOAuth({
            ...options,
            startReady: async () => ({
              ok: true,
              rust_ok: true,
              // startSlotReady nests it: { ok, engine, rust: { ok, reason, health } }
              rust: {
                ok: true,
                engine: 'rust',
                rust: { ok: true, health: { vm_telemetry: true, telemetry_ready: true } },
              },
            }),
          }),
        postTelemetry: async () => ({ ok: true }),
        runDocker: async (_argv, { stdin, timeoutMs }) =>
          new Promise((resolve, reject) => {
            const child = spawn(binary, [], {
              env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
              stdio: ['pipe', 'pipe', 'pipe'],
              timeout: timeoutMs,
            })
            let stdout = ''
            let stderr = ''
            child.stdout.on('data', (chunk) => {
              stdout += chunk
            })
            child.stderr.on('data', (chunk) => {
              stderr += chunk
            })
            child.once('error', reject)
            child.once('close', (code) => resolve({ code, stdout, stderr }))
            child.stdin.on('error', () => {})
            child.stdin.end(stdin)
          }),
      },
    )
  const proxyUrl = `socks5h://127.0.0.1:${proxy.address().port}`
  for (const scenario of [
    { flavor: 'cai', returnedState: 'provider-exchange-state' },
    { flavor: 'cai', returnedState: undefined },
    { flavor: 'setup_token', returnedState: 'session' },
  ]) {
    await t.test(`${scenario.flavor}: ${scenario.returnedState || 'no state suffix'}`, async () => {
      const generated = generateAuthUrl({ vmId: vm.id, proxyUrl, flavor: scenario.flavor })
      const url = new URL(generated.auth_url)
      const session = peekAuthUrlSession(generated.session_id)
      const state = scenario.returnedState === 'session' ? url.searchParams.get('state') : scenario.returnedState
      expectedExchange = {
        code: 'binary-auth-code',
        challenge: url.searchParams.get('code_challenge'),
        redirectUri: url.searchParams.get('redirect_uri'),
        state,
      }
      const requestStart = requests.length
      const credential = await run({
        operation: 'exchange_code',
        code: state ? `${expectedExchange.code}#${state}` : expectedExchange.code,
        code_verifier: session.codeVerifier,
        redirect_uri: session.redirectUri,
        runtime_mode: scenario.flavor === 'setup_token' ? 'setup-token' : 'oauth',
      })
      assert.equal(credential.access_token, accessToken)
      assert.equal(credential.refresh_token, refreshToken)
      assert.equal(credential.email, 'exchange@example.test')
      assert.equal(credential.account_uuid, 'account-exchange')
      assert.equal(credential.org_uuid, org)
      assert.equal(credential.scope, FULL_OAUTH_SCOPE)
      assert.equal(credential.mode, scenario.flavor === 'setup_token' ? 'setup-token' : 'oauth')
      const [token, bootstrap] = requests.slice(requestStart)
      assert.equal(token.payload.grant_type, 'authorization_code')
      assert.equal(token.payload.client_id, CLIENT_ID)
      assert.equal(token.headers.cookie, undefined)
      assert.equal(Object.hasOwn(token.payload, 'expires_in'), false)
      assert.equal(bootstrap.headers.authorization, `Bearer ${accessToken}`)
      assert.equal(bootstrap.headers.cookie, undefined)
    })
  }
  assert.equal(tokenRequests, 3)
  for (const runtimeMode of ['oauth', 'setup-token']) {
    await t.test(`session cookie: ${runtimeMode}`, async () => {
      const requestStart = requests.length
      const credential = await run({
        operation: 'session_key',
        session_key: sessionKey,
        scope: FULL_OAUTH_SCOPE,
        runtime_mode: runtimeMode,
      })
      assert.equal(credential.access_token, accessToken)
      assert.equal(credential.refresh_token, refreshToken)
      assert.equal(credential.scope, FULL_OAUTH_SCOPE)
      assert.equal(credential.type, runtimeMode)
      assert.equal(credential.mode, runtimeMode)
      assert.equal(credential.email, 'exchange@example.test')
      assert.equal(credential.account_uuid, 'account-exchange')
      assert.equal(credential.org_uuid, org)
      const flow = requests.slice(requestStart)
      assert.deepEqual(
        flow.map(({ method, url }) => [method, url.split('?')[0]]),
        [
          ['GET', '/api/organizations'],
          ['POST', `/v1/oauth/${org}/authorize`],
          ['POST', '/v1/oauth/token'],
          ['GET', '/api/claude_cli/bootstrap'],
        ],
      )
      const [orgs, authorize, token, bootstrap] = flow
      for (const request of [orgs, authorize]) {
        assert.equal(request.headers.cookie, `sessionKey=${sessionKey}`)
        assert.match(request.headers['user-agent'], /Chrome\/146\.0\.0\.0/)
      }
      assert.equal(authorize.payload.response_type, 'code')
      assert.equal(authorize.payload.client_id, CLIENT_ID)
      assert.equal(authorize.payload.redirect_uri, REDIRECT_URI)
      assert.equal(authorize.payload.scope, FULL_OAUTH_SCOPE)
      assert.equal(authorize.payload.code_challenge_method, 'S256')
      assert.ok(authorize.payload.state)
      assert.equal(token.payload.state, authorize.payload.state)
      assert.equal(
        crypto.createHash('sha256').update(token.payload.code_verifier).digest('base64url'),
        authorize.payload.code_challenge,
      )
      assert.equal(token.headers.cookie, undefined)
      assert.equal(bootstrap.headers.authorization, `Bearer ${accessToken}`)
      assert.equal(bootstrap.headers.cookie, undefined)
    })
  }
  for (const mode of ['stale', 'state_mismatch']) {
    await t.test(`session cookie rejects ${mode} before token exchange`, async () => {
      authorizeMode = mode
      const before = tokenRequests
      const requestStart = requests.length
      await assert.rejects(run({ operation: 'session_key', session_key: sessionKey }))
      assert.equal(tokenRequests, before)
      assert.deepEqual(
        requests.slice(requestStart).map(({ url }) => url),
        ['/api/organizations', `/v1/oauth/${org}/authorize`],
      )
    })
  }
  assert.equal(tokenRequests, 5)
})
