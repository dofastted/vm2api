import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { sessionKeyToOAuth } from '../../src/lib/oauth/cookie-auth.mjs'

test('OAuth binary imports through an authenticated HTTP CONNECT proxy', {
  timeout: 30000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-authorize-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
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
        'subjectAltName=DNS:claude.ai,DNS:platform.claude.com',
      ],
      { stdio: 'ignore' },
    )
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    t.skip('openssl unavailable')
    return
  }
  const org = '12345678-1234-4234-8234-123456789abc'
  const upstream = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET' && req.url === '/api/organizations') {
      res.end(JSON.stringify([{ uuid: org, raven_type: 'team' }]))
      return
    }
    if (req.method === 'POST' && req.url === `/v1/oauth/${org}/authorize`) {
      const payload = JSON.parse(Buffer.concat(chunks).toString())
      if (payload.organization_uuid !== org) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid request format' } }))
        return
      }
      res.writeHead(403)
      res.end(
        JSON.stringify({ error: { type: 'permission_error', message: 'Session is not fresh enough to authorize' } }),
      )
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const sockets = new Set()
  const seen = []
  const proxy = http.createServer()
  proxy.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  })
  proxy.on('connect', async (req, socket, head) => {
    seen.push({ host: req.url, auth: req.headers['proxy-authorization'] })
    const { default: net } = await import('node:net')
    const target = net.connect(upstream.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) target.write(head)
      socket.pipe(target).pipe(socket)
    })
    sockets.add(target)
    target.on('close', () => {
      sockets.delete(target)
      socket.destroy()
    })
    target.on('error', () => socket.destroy())
    socket.on('close', () => target.destroy())
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all([
      new Promise((resolve) => proxy.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ])
  })
  const previousCerts = process.env.NODE_EXTRA_CA_CERTS
  process.env.NODE_EXTRA_CA_CERTS = cert
  t.after(() => {
    if (previousCerts === undefined) delete process.env.NODE_EXTRA_CA_CERTS
    else process.env.NODE_EXTRA_CA_CERTS = previousCerts
  })
  await assert.rejects(
    sessionKeyToOAuth('sk-ant-sid01-testaaaaaaaa', {
      proxyUrl: `http://fixture-user:p%40ss%3Aword@127.0.0.1:${proxy.address().port}`,
      timeoutMs: 5000,
    }),
    { code: 'session_stale_relogin' },
  )
  assert.deepEqual(
    seen.map((r) => r.host),
    ['claude.ai:443', 'platform.claude.com:443'],
  )
  assert(seen.every((r) => r.auth === `Basic ${Buffer.from('fixture-user:p@ss:word').toString('base64')}`))
})
