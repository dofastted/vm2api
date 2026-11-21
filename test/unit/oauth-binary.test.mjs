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
import {
  exchangeAuthCode,
  generateAuthUrl,
  peekAuthUrlSession,
  resetAuthUrlSessions,
} from '../../src/lib/oauth/oauth-auth-url.mjs'
import { sessionKeyToOAuth } from '../../src/lib/oauth/cookie-auth.mjs'
import {
  CLIENT_ID,
  FULL_OAUTH_SCOPE,
  REDIRECT_URI,
  SETUP_TOKEN_TTL_SECONDS,
} from '../../src/lib/oauth/oauth-contract.mjs'
import { OFFICIAL_CLI_VERSION } from '../../src/lib/identity/vm-identity.mjs'
import { prepareSlotOAuth, runGuestOAuthAuthService } from '../../src/lib/oauth/guest-oauth-helper.mjs'
import { slotExec } from '../../src/lib/vm/slot-runtime.mjs'

test('guest OAuth helper preserves provider state, PKCE and cookie authorization', {
  timeout: 30000,
}, async (t) => {
  const binary =
    process.env.KIN_TEST_OAUTH_AUTH_BIN || fileURLToPath(new URL('../../bin/kin-oauth-auth', import.meta.url))
  fs.accessSync(binary, fs.constants.X_OK)
  // A released helper advertises what it implements; a PR that changes policy
  // must not turn CI red before the binary carrying it exists. Probed straight
  // from the binary: runGuestOAuthAuthService only returns credential payloads.
  const capabilities = await new Promise((resolve) => {
    const child = spawn(binary, [], { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8')
    })
    child.on('error', () => resolve([]))
    child.on('close', () => {
      try {
        const line = out
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean)
          .at(-1)
        resolve(JSON.parse(line || '{}')?.credential?.capabilities || [])
      } catch {
        resolve([])
      }
    })
    child.stdin.end('{"operation":"capabilities"}\n')
  })
  // Two binary generations are in the wild: the released one still asks for a
  // one-year mint, the current source asks for nothing (short-lived oauth).
  const mintsYear = capabilities.includes('setup-token-long-lived')
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
  // The token response echoes the scope the authorize request named, so a
  // narrowed mint is observable end-to-end instead of always granting FULL.
  let grantedScope = null
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
      const scope = grantedScope || FULL_OAUTH_SCOPE
      grantedScope = null
      const token = JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: 28800,
        scope,
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
    if (req.method === 'GET' && req.url === '/api/oauth/profile') {
      res.end(
        JSON.stringify({
          account: { uuid: 'account-exchange', email: 'exchange@example.test', email_address: 'exchange@example.test' },
          organization: {
            uuid: org,
            organization_type: 'claude_pro',
            rate_limit_tier: 'default',
            subscription_created_at: '2020-01-01T00:00:00.000Z',
          },
        }),
      )
      return
    }
    if (req.method === 'GET' && req.url === '/api/oauth/claude_cli/roles') {
      res.end(
        JSON.stringify({ organization_role: 'admin', workspace_role: 'workspace_admin', organization_name: 'fixture' }),
      )
      return
    }
    if (req.method === 'GET' && req.url === '/api/organization/claude_code_first_token_date') {
      res.end(JSON.stringify({ first_token_date: null }))
      return
    }
    if (req.method === 'POST' && req.url === '/api/eval/sdk-zAZezfDKGoZuXXKe') {
      res.end('{}')
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
      if (authorizeMode === 'attestation') {
        res.writeHead(400)
        res.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: "This request couldn't be completed.",
              details: { error_code: 'missing_client_attestation' },
            },
          }),
        )
        return
      }
      grantedScope = payload.scope || null
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
      vm_id: vm.id,
      credential_path: '/home/kincli/.claude/credentials.json',
      proxy_url: `socks5h://127.0.0.1:${proxy.address().port}`,
    }),
  )
  const exec = slotExec(root, vm)
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
            readHealth: async () => ({ ok: true, vm_telemetry: true, telemetry_ready: true }),
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
            const guestPayload = JSON.parse(stdin)
            assert.equal(guestPayload.proxy_url, '')
            if (process.env.KIN_TEST_OAUTH_AUTH_BIN) guestPayload.claude_version = '2.1.321'
            // This unit fixture uses a host-local SOCKS listener in place of
            // the transparent kin-eg-* network available to a real slot.
            guestPayload.proxy_url = proxyUrl
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
            child.stdin.end(`${JSON.stringify(guestPayload)}\n`)
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
      // Both flavors ask for the login scope; only the lifetime differs.
      assert.equal(url.searchParams.get('scope'), FULL_OAUTH_SCOPE)
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
      const flow = requests.slice(requestStart)
      const token = flow[0]
      const profile = flow.find((item) => item.url === '/api/oauth/profile')
      const evals = flow.filter((item) => item.url === '/api/eval/sdk-zAZezfDKGoZuXXKe')
      const bootstrap = flow.find((item) => String(item.url).startsWith('/api/claude_cli/bootstrap?'))
      const setup = scenario.flavor === 'setup_token'
      assert.equal(token.payload.grant_type, 'authorization_code')
      assert.equal(token.payload.client_id, CLIENT_ID)
      assert.equal(token.headers.cookie, undefined)
      assert.equal(token.payload.expires_in, mintsYear && setup ? SETUP_TOKEN_TTL_SECONDS : undefined)
      assert.equal(token.headers['user-agent'], 'axios/1.15.2')
      assert.equal(token.headers['sec-ch-ua'], undefined)
      assert.equal(profile.headers.authorization, `Bearer ${accessToken}`)
      assert.equal(profile.headers['user-agent'], `claude-code/${OFFICIAL_CLI_VERSION}`)
      assert.equal(evals.length, 2)
      assert.equal(evals[0].payload.attributes.entrypoint, 'sdk-cli')
      assert.match(evals[0].payload.attributes.sdkCachePartition, /^served-to-bearer:/)
      assert.equal(evals[1].payload.attributes.sdkCachePartition, undefined)
      assert.equal(evals[1].payload.attributes.subscriptionType, 'pro')
      assert.equal(evals[1].payload.attributes.rateLimitTier, 'default')
      assert.equal(evals[1].payload.attributes.organizationRole, 'admin')
      assert.equal(evals[1].payload.attributes.accountUUID, 'account-exchange')
      assert.equal(evals[1].payload.attributes.organizationUUID, org)
      assert.equal(evals[1].payload.attributes.subscriptionCreatedAt, Date.parse('2020-01-01T00:00:00.000Z'))
      assert.equal(evals[1].payload.forcedFeatures.length, 0)
      assert.equal(evals[1].payload.url, '')
      assert.equal(bootstrap.headers.authorization, `Bearer ${accessToken}`)
      assert.equal(bootstrap.headers['user-agent'], `claude-code/${OFFICIAL_CLI_VERSION}`)
      assert.match(bootstrap.url, /^\/api\/claude_cli\/bootstrap\?entrypoint=sdk-cli&model=claude-opus-5-5$/)
      assert.equal(
        flow.some((item) => item.url === '/api/oauth/account/settings'),
        false,
      )
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
      const minted = runtimeMode === 'setup-token'
      // Both paths ask for the login scope; only the mint carries a lifetime.
      assert.equal(credential.scope, FULL_OAUTH_SCOPE)
      assert.equal(credential.type, runtimeMode)
      assert.equal(credential.mode, runtimeMode)
      assert.equal(credential.email, 'exchange@example.test')
      assert.equal(credential.account_uuid, 'account-exchange')
      assert.equal(credential.org_uuid, org)
      const flow = requests.slice(requestStart)
      const setup = runtimeMode === 'setup-token'
      assert.deepEqual(
        flow.map(({ method, url }) => [method, url.split('?')[0]]),
        [
          ['GET', '/api/organizations'],
          ['POST', `/v1/oauth/${org}/authorize`],
          ['POST', '/v1/oauth/token'],
          ['GET', '/api/oauth/profile'],
          ['POST', '/api/eval/sdk-zAZezfDKGoZuXXKe'],
          ['GET', '/api/oauth/claude_cli/roles'],
          ['GET', '/api/organization/claude_code_first_token_date'],
          ['POST', '/api/eval/sdk-zAZezfDKGoZuXXKe'],
          ['GET', '/api/claude_cli/bootstrap'],
        ],
      )
      const [orgs, authorize, token, profile, evalBefore, roles, firstToken, evalAfter, bootstrap] = flow
      for (const request of [orgs, authorize]) {
        assert.equal(request.headers.cookie, `sessionKey=${sessionKey}`)
        assert.match(request.headers['user-agent'], /Chrome\/146\.0\.0\.0/)
        assert.match(request.headers['sec-ch-ua'], /Google Chrome/)
      }
      assert.equal(orgs.headers.host, 'claude.ai')
      assert.equal(authorize.headers.host, setup ? 'platform.claude.com' : 'claude.ai')
      assert.equal(orgs.headers.origin, 'https://claude.ai')
      assert.equal(authorize.headers.origin, 'https://claude.ai')
      assert.equal(
        authorize.headers.referer,
        setup ? 'https://platform.claude.com/oauth/authorize?code=true' : 'https://claude.ai/new',
      )
      assert.equal(token.headers['user-agent'], 'axios/1.15.2')
      assert.equal(token.headers['sec-ch-ua'], undefined)
      assert.equal(token.payload.expires_in, mintsYear && minted ? SETUP_TOKEN_TTL_SECONDS : undefined)
      assert.equal(profile.headers['user-agent'], `claude-code/${OFFICIAL_CLI_VERSION}`)
      assert.match(evalBefore.payload.attributes.sdkCachePartition, /^served-to-bearer:/)
      assert.equal(roles.headers['content-type'], undefined)
      assert.equal(firstToken.headers['user-agent'], `claude-cli/${OFFICIAL_CLI_VERSION} (external, sdk-cli)`)
      assert.equal(evalAfter.payload.attributes.organizationRole, 'admin')
      assert.equal(evalAfter.payload.attributes.subscriptionType, 'pro')
      assert.equal(evalAfter.payload.attributes.accountUUID, 'account-exchange')
      assert.equal(evalAfter.payload.attributes.organizationUUID, org)
      assert.equal(bootstrap.headers['user-agent'], `claude-code/${OFFICIAL_CLI_VERSION}`)
      assert.match(bootstrap.url, /entrypoint=sdk-cli&model=claude-opus-5-5$/)
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
      assert.equal(
        flow.some((item) => item.method === 'PATCH'),
        false,
      )
    })
  }
  for (const mode of ['stale', 'state_mismatch', 'attestation']) {
    await t.test(`session cookie rejects ${mode} before token exchange`, async () => {
      authorizeMode = mode
      const before = tokenRequests
      const requestStart = requests.length
      // A missing browser attestation is final: no other origin variant is tried.
      await assert.rejects(run({ operation: 'session_key', session_key: sessionKey }), (err) =>
        mode === 'attestation' ? err.code === 'authorize_client_attestation' : true,
      )
      assert.equal(tokenRequests, before)
      assert.deepEqual(
        requests.slice(requestStart).map(({ url }) => url),
        ['/api/organizations', `/v1/oauth/${org}/authorize`],
      )
    })
  }
  assert.equal(tokenRequests, 5)
  await t.test(
    'legacy kernel authorization-link and Cookie exchanges use the real helper and bound SOCKS exit',
    async (t) => {
      const previousCert = process.env.NODE_EXTRA_CA_CERTS
      // kin-worker mints the session code in its own Go process, which does not
      // read NODE_EXTRA_CA_CERTS. Go reads SSL_CERT_FILE, so the bridge trusts
      // the same fixture CA the Node side already trusts.
      const previousSslCert = process.env.SSL_CERT_FILE
      process.env.NODE_EXTRA_CA_CERTS = cert
      process.env.SSL_CERT_FILE = cert
      t.after(() => {
        if (previousCert === undefined) delete process.env.NODE_EXTRA_CA_CERTS
        else process.env.NODE_EXTRA_CA_CERTS = previousCert
        if (previousSslCert === undefined) delete process.env.SSL_CERT_FILE
        else process.env.SSL_CERT_FILE = previousSslCert
      })
      const generated = generateAuthUrl({ vmId: vm.id, proxyUrl: 'socks5h://127.0.0.1:1' })
      const url = new URL(generated.auth_url)
      expectedExchange = {
        code: 'legacy-auth-code',
        challenge: url.searchParams.get('code_challenge'),
        redirectUri: url.searchParams.get('redirect_uri'),
        state: 'legacy-provider-state',
      }
      const before = tokenRequests
      const vmFile = path.join(root, 'vms', `${vm.id}.json`)
      const vmBefore = fs.readFileSync(vmFile, 'utf8')
      const linked = await exchangeAuthCode({
        sessionId: generated.session_id,
        code: `${expectedExchange.code}#${expectedExchange.state}`,
        vmId: vm.id,
        exec,
      })
      assert.equal(linked.access_token, accessToken)
      assert.equal(linked.email, 'exchange@example.test')
      assert.equal(peekAuthUrlSession(generated.session_id), null)
      authorizeMode = 'success'
      const cookie = await sessionKeyToOAuth(sessionKey, { exec, proxyUrl: 'socks5h://127.0.0.1:1' })
      assert.equal(cookie.access_token, accessToken)
      assert.equal(cookie.email, 'exchange@example.test')
      assert.equal(tokenRequests, before + 2)
      assert.equal(fs.readFileSync(vmFile, 'utf8'), vmBefore)
    },
  )
})
