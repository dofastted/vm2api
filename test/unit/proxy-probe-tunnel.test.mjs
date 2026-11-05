import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { once } from 'node:events'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { ProxyPool, isLocalForwarderHost } from '../../src/lib/vm/proxy-pool.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'

/**
 * A row on 127.0.0.1 is a local forwarder: its listener stays up while the node
 * behind it dies, so the probe must CONNECT a real target instead of stopping
 * at the SOCKS5 greeting.
 */
const CONNECT_OK = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
const CONNECT_REFUSED = Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])
const TLS_FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'tls')

function closeServer(t, server) {
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    return new Promise((resolve) => server.close(resolve))
  })
}

function makePool(t) {
  const pool = new ProxyPool({ db: openDatabase({ dbPath: ':memory:' }) })
  pool.updateConfig({ enabled: false })
  t.after(() => {
    pool.stopScheduler()
    closeDatabase()
  })
  return pool
}

/**
 * Minimal SOCKS5 server: `greeting` decides the method reply, `connect` the
 * CONNECT verdict. Records every CONNECT target it was asked for.
 */
async function fakeSocks(t, { greeting = [5, 0], connect = () => CONNECT_OK, tunnel = true } = {}) {
  const seen = []
  const server = net.createServer((socket) => {
    let phase = 'greeting'
    let buf = Buffer.alloc(0)
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (true) {
        if (phase === 'greeting') {
          if (buf.length < 2) return
          const need = 2 + buf[1]
          if (buf.length < need) return
          buf = buf.subarray(need)
          socket.write(Buffer.from(greeting))
          phase = greeting[1] === 0x02 ? 'auth' : 'request'
          continue
        }
        if (phase === 'auth') {
          if (buf.length < 2) return
          const userLength = buf[1]
          if (buf.length < 3 + userLength) return
          const passwordLength = buf[2 + userLength]
          const need = 3 + userLength + passwordLength
          if (buf.length < need) return
          socket.write(Buffer.from([1, 0]))
          buf = buf.subarray(need)
          phase = 'request'
          continue
        }
        if (phase === 'request') {
          if (buf.length < 10) return
          const host = [...buf.subarray(4, 8)].join('.')
          const port = (buf[8] << 8) | buf[9]
          buf = buf.subarray(10)
          seen.push(`${host}:${port}`)
          const reply = connect(host, port)
          socket.write(reply)
          if (reply[1] === 0 && !tunnel) phase = 'silent'
          else if (reply[1] === 0 && port === 53) phase = 'tunnel'
          else if (reply[1] === 0) {
            phase = 'closed'
            socket.end()
          }
          continue
        }
        if (phase === 'tunnel') {
          if (buf.length < 2) return
          const need = 2 + buf.readUInt16BE(0)
          if (buf.length < need) return
          const query = buf.subarray(2, need)
          buf = buf.subarray(need)
          const response = Buffer.from(query)
          response[2] |= 0x80
          response[3] &= 0x0f
          const frame = Buffer.alloc(2 + response.length)
          frame.writeUInt16BE(response.length, 0)
          response.copy(frame, 2)
          socket.write(frame)
          continue
        }
        return
      }
    })
  })
  server.listen({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { port: server.address().port, seen }
}

/**
 * Serve a real TLS handshake behind a SOCKS5 bridge. CONNECT replies are not
 * enough for a forwarder: the client only becomes healthy after this bridge
 * carries the TLS handshake through to the local TLS server.
 */
async function fakeTlsSocks(t) {
  const seen = []
  const tlsServer = tls.createServer(
    {
      key: fs.readFileSync(path.join(TLS_FIXTURE_DIR, 'localhost-key.pem')),
      cert: fs.readFileSync(path.join(TLS_FIXTURE_DIR, 'localhost-cert.pem')),
    },
    (socket) => socket.end(),
  )
  tlsServer.listen({ host: '127.0.0.1', port: 0 })
  await once(tlsServer, 'listening')
  closeServer(t, tlsServer)

  const server = net.createServer((socket) => {
    let phase = 'greeting'
    let buf = Buffer.alloc(0)
    socket.on('error', () => {})
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (true) {
        if (phase === 'greeting') {
          if (buf.length < 2) return
          const need = 2 + buf[1]
          if (buf.length < need) return
          buf = buf.subarray(need)
          socket.write(Buffer.from([5, 0]))
          phase = 'request'
          continue
        }
        if (phase === 'request') {
          if (buf.length < 10) return
          const host = [...buf.subarray(4, 8)].join('.')
          const port = (buf[8] << 8) | buf[9]
          buf = buf.subarray(10)
          seen.push(`${host}:${port}`)
          if (port !== 443) {
            socket.write(CONNECT_REFUSED)
            socket.end()
            return
          }
          phase = 'bridged'
          socket.removeListener('data', onData)
          const upstream = net.connect(tlsServer.address().port, '127.0.0.1')
          upstream.once('connect', () => {
            socket.pipe(upstream)
            upstream.pipe(socket)
            socket.write(CONNECT_OK)
          })
          upstream.on('error', () => socket.destroy())
          continue
        }
        return
      }
    }
    socket.on('data', onData)
  })
  server.listen({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  closeServer(t, server)
  return { port: server.address().port, seen }
}

test('loopback rows classify as local forwarders, remote endpoints do not', () => {
  for (const host of [
    '127.0.0.1',
    'localhost',
    '::1',
    '[::1]',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.9',
    '::ffff:127.0.0.1',
  ])
    assert.equal(isLocalForwarderHost(host), true, host)
  for (const host of ['203.0.113.10', 'proxy.example.com', '8.8.8.8', '2001:4860:4860::8888'])
    assert.equal(isLocalForwarderHost(host), false, host)
})

test('a forwarder whose upstream is dead fails the probe instead of reporting health', async (t) => {
  const pool = makePool(t)
  const socks = await fakeSocks(t, { connect: () => CONNECT_REFUSED })
  const {
    items: [proxy],
  } = pool.importLines(`socks5h://127.0.0.1:${socks.port}`)

  const { probe } = await pool.probeById(proxy.id)

  assert.equal(probe.ok, false)
  assert.match(String(probe.error), /egress_unreachable/)
  // Both probe targets were attempted, so one blocked destination cannot fail a healthy exit.
  assert.deepEqual(socks.seen, ['1.1.1.1:443', '8.8.8.8:53'])
  assert.equal(pool.state.proxies[0].status, 'fail')
  assert.equal(pool.state.proxies[0].consecutive_failures, 1)
  // Never surface a loopback handshake time as the row's latency.
  assert.equal(pool.state.proxies[0].latency_ms, null)
})

test('a forwarder without a usable TLS tunnel falls back to DNS and reports tunnel latency', async (t) => {
  const pool = makePool(t)
  const socks = await fakeSocks(t, { connect: () => CONNECT_OK })
  const {
    items: [proxy],
  } = pool.importLines(`socks5h://127.0.0.1:${socks.port}`)

  const { probe } = await pool.probeById(proxy.id)

  assert.equal(probe.ok, true)
  assert.equal(typeof probe.latency_ms, 'number')
  assert.deepEqual(socks.seen, ['1.1.1.1:443', '8.8.8.8:53'])
  assert.equal(pool.state.proxies[0].status, 'ok')
})

test('a forwarder that carries a real TLS handshake is healthy without DNS fallback', async (t) => {
  const pool = makePool(t)
  const socks = await fakeTlsSocks(t)
  const {
    items: [proxy],
  } = pool.importLines(`socks5h://127.0.0.1:${socks.port}`)

  const { probe } = await pool.probeById(proxy.id)

  assert.equal(probe.ok, true)
  assert.equal(typeof probe.latency_ms, 'number')
  assert.deepEqual(socks.seen, ['1.1.1.1:443'])
  assert.equal(pool.state.proxies[0].status, 'ok')
})

test('a lazy CONNECT success without tunnel data is not health', async (t) => {
  const pool = makePool(t)
  pool.updateConfig({ probe_timeout_ms: 1000 })
  const socks = await fakeSocks(t, { tunnel: false })
  const {
    items: [proxy],
  } = pool.importLines(`socks5h://127.0.0.1:${socks.port}`)

  const { probe } = await pool.probeById(proxy.id)

  assert.equal(probe.ok, false)
  assert.match(String(probe.error), /egress_(tls|dns)_timeout/)
  assert.deepEqual(socks.seen, ['1.1.1.1:443', '8.8.8.8:53'])
  assert.equal(pool.state.proxies[0].status, 'fail')
})

test('0xff is an auth mismatch, not health', async (t) => {
  const pool = makePool(t)
  const socks = await fakeSocks(t, { greeting: [5, 0xff] })
  const {
    items: [proxy],
  } = pool.importLines(`socks5h://127.0.0.1:${socks.port}`)

  const { probe } = await pool.probeById(proxy.id)

  assert.equal(probe.ok, false)
  assert.match(String(probe.error), /proxy_auth_unsupported/)
  assert.equal(pool.state.proxies[0].status, 'fail')
  assert.deepEqual(socks.seen, [])
})

test('user/pass forwarders authenticate before the CONNECT verdict', async (t) => {
  const pool = makePool(t)
  const socks = await fakeSocks(t, { greeting: [5, 2], connect: () => CONNECT_OK })
  const {
    items: [proxy],
  } = pool.importLines(`socks5h://kin:secret@127.0.0.1:${socks.port}`)

  const { probe } = await pool.probeById(proxy.id)

  assert.equal(probe.ok, true)
  assert.deepEqual(socks.seen, ['1.1.1.1:443', '8.8.8.8:53'])
})
