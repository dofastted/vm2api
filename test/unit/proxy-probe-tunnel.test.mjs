import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { ProxyPool, isLocalForwarderHost } from '../../src/lib/vm/proxy-pool.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'

/**
 * A row on 127.0.0.1 is a local forwarder: its listener stays up while the node
 * behind it dies, so the probe must CONNECT a real target instead of stopping
 * at the SOCKS5 greeting.
 */
const CONNECT_OK = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
const CONNECT_REFUSED = Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])

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
async function fakeSocks(t, { greeting = [5, 0], connect = () => CONNECT_OK } = {}) {
  const seen = []
  const server = net.createServer((socket) => {
    let phase = 'greeting'
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      if (phase === 'greeting' && chunk[1] !== 0x01) {
        socket.write(Buffer.from(greeting))
        phase = greeting[1] === 0x02 ? 'auth' : 'request'
        return
      }
      if (phase === 'auth') {
        socket.write(Buffer.from([1, 0]))
        phase = 'request'
        return
      }
      if (chunk[1] === 0x01) {
        const host = [...chunk.subarray(4, 8)].join('.')
        const port = (chunk[8] << 8) | chunk[9]
        seen.push(`${host}:${port}`)
        socket.write(connect(host, port))
      }
    })
  })
  server.listen({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { port: server.address().port, seen }
}

test('loopback rows classify as local forwarders, remote endpoints do not', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '10.1.2.3', '172.20.0.1', '192.168.1.9', '::ffff:127.0.0.1'])
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

test('a forwarder whose tunnel works is healthy and its latency is the tunnel round trip', async (t) => {
  const pool = makePool(t)
  const socks = await fakeSocks(t, { connect: () => CONNECT_OK })
  const {
    items: [proxy],
  } = pool.importLines(`socks5h://127.0.0.1:${socks.port}`)

  const { probe } = await pool.probeById(proxy.id)

  assert.equal(probe.ok, true)
  assert.equal(typeof probe.latency_ms, 'number')
  assert.deepEqual(socks.seen, ['1.1.1.1:443'])
  assert.equal(pool.state.proxies[0].status, 'ok')
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
  assert.deepEqual(socks.seen, ['1.1.1.1:443'])
})
