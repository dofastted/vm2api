import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import nodeFetch from 'node-fetch'
import { createSocksProxyAgent } from '../../src/lib/vm/proxy-agent.mjs'
import { withOAuthProxy } from '../../src/lib/oauth/http-proxy-bridge.mjs'

async function peer(t, handle) {
  const sockets = new Set()
  const server = http.createServer()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  })
  server.on('connect', handle)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    for (const s of sockets) s.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  return `http://alice:p%40ss%3Aword@127.0.0.1:${server.address().port}`
}

test('OAuth SOCKS adapter uses authenticated HTTP CONNECT with remote DNS and preserves tunnel bytes', async (t) => {
  const seen = []
  const proxy = await peer(t, (req, socket) => {
    seen.push({ target: req.url, auth: req.headers['proxy-authorization'] })
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok'))
  })
  let localPort
  await withOAuthProxy(proxy, async (url) => {
    localPort = Number(new URL(url).port)
    const agent = createSocksProxyAgent(url)
    try {
      assert.equal(await (await nodeFetch('http://oauth-target.invalid/organizations', { agent })).text(), 'ok')
    } finally {
      agent.destroy()
    }
  })
  assert.deepEqual(seen, [
    { target: 'oauth-target.invalid:80', auth: `Basic ${Buffer.from('alice:p@ss:word').toString('base64')}` },
  ])
  const socket = net.connect(localPort, '127.0.0.1')
  const [error] = await once(socket, 'error')
  assert.equal(error.code, 'ECONNREFUSED')
})

test('HTTP authentication errors do not fall back to a direct request or leak proxy credentials', async (t) => {
  const proxy = await peer(t, (_req, socket) =>
    socket.end('HTTP/1.1 407 private-password-must-not-leak\r\ncontent-length: 0\r\n\r\n'),
  )
  await assert.rejects(
    withOAuthProxy(proxy, async (url) => {
      const agent = createSocksProxyAgent(url)
      try {
        await nodeFetch('http://not-resolved-locally.invalid/', { agent })
      } finally {
        agent.destroy()
      }
    }),
    (error) =>
      error.code === 'proxy_connect_failed' &&
      /407/.test(error.message) &&
      !/alice|p@ss|private-password/.test(error.message),
  )
})

test('SOCKS and explicit direct settings pass through unchanged', async () => {
  for (const value of ['socks5h://user:pass@proxy.invalid:1080', '', null]) {
    assert.equal(await withOAuthProxy(value, async (received) => received), value)
  }
})

test('local adapter rejects unauthenticated clients and closes on callback failure', async (t) => {
  let upstreamConnections = 0
  const proxy = await peer(t, (_req, socket) => {
    upstreamConnections++
    socket.destroy()
  })
  await assert.rejects(
    withOAuthProxy(proxy, async (url) => {
      const socket = net.connect(Number(new URL(url).port), '127.0.0.1')
      await once(socket, 'connect')
      socket.write(Buffer.from([5, 1, 0]))
      assert.deepEqual((await once(socket, 'data'))[0], Buffer.from([5, 255]))
      socket.destroy()
      throw new Error('fixture cancellation')
    }),
    /fixture cancellation/,
  )
  assert.equal(upstreamConnections, 0)
})
