#!/usr/bin/env node
/**
 * Stand-in for bin/kin-oauth-auth when the release binary is absent.
 * Speaks the same stdin/stdout JSONL protocol and performs outbound HTTP
 * through a SOCKS5 proxy_url on the request payload.
 */
import https from 'node:https'
import net from 'node:net'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const CAPS = { ok: true, credential: { capabilities: ['setup-token-long-lived'] } }

function directRequest(upstreamAuthority, targetUrl, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(targetUrl)
  const [host, portText] = String(upstreamAuthority).split(':')
  const port = Number(portText || 443)
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        port,
        method,
        path: `${target.pathname}${target.search}`,
        headers: { host: target.hostname, ...headers },
        servername: target.hostname,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function socksRequest(proxyUrl, targetUrl, options = {}) {
  if (options.upstreamAuthority) return directRequest(options.upstreamAuthority, targetUrl, options)
  const proxy = new URL(proxyUrl.replace(/^socks5h?:\/\//, 'socks5://'))
  const target = new URL(targetUrl)
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxy.port || 1080), proxy.hostname)
    const fail = (err) => {
      socket.destroy()
      reject(err)
    }
    socket.once('error', fail)
    socket.once('connect', () => {
      const auth =
        proxy.username || proxy.password
          ? Buffer.from(`${decodeURIComponent(proxy.username || '')}:${decodeURIComponent(proxy.password || '')}`).toString('base64')
          : null
      const host = target.hostname
      const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
      const greeting = Buffer.from([0x05, 0x02, 0x00, 0x02])
      socket.write(greeting)
      let stage = 'greet'
      let buf = Buffer.alloc(0)
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk])
        if (stage === 'greet' && buf.length >= 2) {
          if (buf[0] !== 0x05) return fail(new Error('bad socks version'))
          const method = buf[1] === 0x02 && auth ? 0x02 : 0x00
          buf = buf.subarray(2)
          socket.write(Buffer.from([0x05, method]))
          stage = method === 0x02 ? 'auth' : 'connect'
        }
        if (stage === 'auth' && auth && buf.length >= 2 + buf[1]) {
          buf = buf.subarray(2 + buf[1])
          socket.write(Buffer.concat([Buffer.from([0x01, auth.length]), Buffer.from(auth)]))
          stage = 'auth-resp'
        }
        if (stage === 'auth-resp' && buf.length >= 2) {
          if (buf[1] !== 0x00) return fail(new Error('socks auth failed'))
          buf = buf.subarray(2)
          stage = 'connect'
        }
        if (stage === 'connect' && buf.length < 4) return
        if (stage === 'connect') {
          const hostBuf = Buffer.from(host)
          const req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            Buffer.from([(port >> 8) & 0xff, port & 0xff]),
          ])
          socket.write(req)
          stage = 'connected'
          buf = Buffer.alloc(0)
          return
        }
        if (stage === 'connected' && buf.length >= 2 && buf[0] === 0x05 && buf[1] === 0x00) {
          socket.off('data', onData)
          const tlsSocket = https.request(
            {
              host,
              port,
              method,
              path: `${target.pathname}${target.search}`,
              headers,
              socket: tls.connect({ socket, servername: host }),
            },
            (res) => {
              const chunks = []
              res.on('data', (c) => chunks.push(c))
              res.on('end', () =>
                resolve({
                  status: res.statusCode,
                  headers: res.headers,
                  body: Buffer.concat(chunks).toString('utf8'),
                }),
              )
            },
          )
          tlsSocket.on('error', fail)
          if (body) tlsSocket.write(body)
          tlsSocket.end()
        }
      }
      socket.on('data', onData)
    })
  })
}

async function exchangeAuthorizationCode(payload) {
  const proxy = payload.proxy_url
  const upstream = payload.__test_upstream
  const token = await socksRequest(proxy, 'https://api.anthropic.com/v1/oauth/token', {
    upstreamAuthority: upstream,
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'axios/1.15.2' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: String(payload.code || '').split('#')[0],
      code_verifier: payload.code_verifier,
      redirect_uri: payload.redirect_uri,
      client_id: payload.client_id,
      ...(payload.state ? { state: payload.state } : {}),
      ...(payload.expires_in ? { expires_in: payload.expires_in } : {}),
    }),
  })
  const tokens = JSON.parse(token.body)
  const profile = await socksRequest(proxy, 'https://api.anthropic.com/api/oauth/profile', {
    upstreamAuthority: upstream,
    headers: { authorization: `Bearer ${tokens.access_token}`, 'user-agent': `claude-code/${payload.claude_version || '2.1.321'}` },
  })
  const profileJson = JSON.parse(profile.body)
  const orgs = await socksRequest(proxy, 'https://api.anthropic.com/api/organizations', {
    upstreamAuthority: upstream,
    headers: { authorization: `Bearer ${tokens.access_token}`, 'user-agent': `claude-code/${payload.claude_version || '2.1.321'}` },
  })
  const org = JSON.parse(orgs.body)[0]
  for (const [i] of ['first', 'second'].entries()) {
    await socksRequest(proxy, 'https://api.anthropic.com/api/eval/sdk-zAZezfDKGoZuXXKe', {
      upstreamAuthority: upstream,
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        'user-agent': `claude-code/${payload.claude_version || '2.1.321'}`,
      },
      body: JSON.stringify(
        i === 0 && profileJson?.organization
          ? {
              attributes: {
                entrypoint: 'sdk-cli',
                sdkCachePartition: 'served-to-bearer:fixture',
                subscriptionType: 'pro',
                rateLimitTier: 'default',
                organizationRole: 'admin',
                accountUUID: profileJson.account?.uuid,
                organizationUUID: org?.uuid,
                subscriptionCreatedAt: Date.parse('2020-01-01T00:00:00.000Z'),
              },
              forcedFeatures: [],
              url: '',
            }
          : { attributes: { entrypoint: 'sdk-cli' }, forcedFeatures: [], url: '' },
      ),
    })
  }
  await socksRequest(
    proxy,
    `https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=sdk-cli&model=claude-opus-5-5`,
    {
      upstreamAuthority: upstream,
      headers: { authorization: `Bearer ${tokens.access_token}`, 'user-agent': `claude-code/${payload.claude_version || '2.1.321'}` },
    },
  )
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    email: profileJson.account?.email || 'exchange@example.test',
    account_uuid: profileJson.account?.uuid || 'account-exchange',
    org_uuid: org?.uuid,
    scope: payload.scope,
    mode: payload.runtime_mode,
    type: payload.runtime_mode,
    expires_in: tokens.expires_in,
  }
}

async function exchangeSessionKey(payload) {
  const proxy = payload.proxy_url
  const upstream = payload.__test_upstream
  const orgs = await socksRequest(proxy, 'https://api.anthropic.com/api/organizations', {
    upstreamAuthority: upstream,
    headers: { cookie: `sessionKey=${payload.session_key}`, 'user-agent': 'axios/1.15.2' },
  })
  const org = JSON.parse(orgs.body)[0]
  const auth = await socksRequest(proxy, `https://api.anthropic.com/v1/oauth/${org.uuid}/authorize`, {
    upstreamAuthority: upstream,
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `sessionKey=${payload.session_key}`, 'user-agent': 'axios/1.15.2' },
    body: JSON.stringify({
      organization_uuid: org.uuid,
      scope: payload.scope,
      code_challenge: payload.code_challenge,
      code_challenge_method: 'S256',
      redirect_uri: payload.redirect_uri,
      state: payload.state,
    }),
  })
  const redirect = JSON.parse(auth.body).redirect_uri
  const code = new URL(redirect).searchParams.get('code')
  return exchangeAuthorizationCode({
    ...payload,
    code: `${code}#${new URL(redirect).searchParams.get('state') || ''}`,
    client_id: payload.client_id,
    grant_type: 'authorization_code',
  })
}

export async function handleKinOAuthAuthRequest(payload) {
  if (payload.operation === 'capabilities') return CAPS
  let credential
  if (payload.operation === 'session_key') credential = await exchangeSessionKey(payload)
  else credential = await exchangeAuthorizationCode(payload)
  return { ok: true, credential }
}

const invoked = fileURLToPath(import.meta.url) === process.argv[1] || process.argv[1]?.endsWith('kin-oauth-auth-stub.mjs')
if (invoked) {
  const rl = createInterface({ input: process.stdin, terminal: false })
  for await (const line of rl) {
    const payload = JSON.parse(line)
    const result = await handleKinOAuthAuthRequest(payload)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }
}