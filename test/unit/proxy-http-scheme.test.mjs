import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { ProxyPool, parseSocks5Fields, parseSocks5Line } from '../../src/lib/vm/proxy-pool.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { socksProxyUrl } from '../../src/lib/vm/socks-address.mjs'

function makePool(t) {
  const pool = new ProxyPool({ db: openDatabase({ dbPath: ':memory:' }) })
  pool.updateConfig({ enabled: false })
  t.after(() => {
    pool.stopScheduler()
    closeDatabase()
  })
  return pool
}

test('parses http:// proxy lines and fields as scheme http', () => {
  const url = parseSocks5Line('http://us%3Aer:p%40ss@203.0.113.7:8080')
  assert.equal(url.scheme, 'http')
  assert.equal(url.host, '203.0.113.7')
  assert.equal(url.port, 8080)
  assert.equal(url.username, 'us:er')
  assert.equal(url.password, 'p@ss')
  assert.equal(parseSocks5Line('http://proxy.example').port, 80)
  assert.equal(parseSocks5Fields({ scheme: 'http', host: 'h.example', port: 3128 }).scheme, 'http')
  assert.equal(parseSocks5Fields({ protocol: 'socks5h', host: 'h.example', port: 1080 }).scheme, 'socks5')
  // Bare lines keep the SOCKS5 default.
  assert.equal(parseSocks5Line('203.0.113.7:8080').scheme, 'socks5')
})

test('rejects https://, unknown schemes and page URLs', () => {
  assert.equal(parseSocks5Line('https://203.0.113.7:8443'), null)
  assert.equal(parseSocks5Line('ftp://203.0.113.7:21'), null)
  assert.equal(parseSocks5Line('http://203.0.113.7:8080/path'), null)
  assert.equal(parseSocks5Fields({ scheme: 'https', host: 'h.example', port: 443 }), null)
})

test('http rows import, dedupe per scheme, serialize as http://, and keep scheme on edit', (t) => {
  const pool = makePool(t)
  const first = pool.importLines('http://u:p@203.0.113.7:8080\nu:p@203.0.113.7:8080\nhttp://u:p@203.0.113.7:8080')
  assert.equal(first.added, 2)
  assert.equal(first.skipped, 1)
  const httpRow = first.items.find((p) => p.scheme === 'http')
  assert.equal(httpRow.kind, 'http')
  const full = pool.getProxyByIdWithAuth(httpRow.id)
  assert.equal(full.scheme, 'http')
  assert.equal(full.url, 'http://u:p@203.0.113.7:8080')
  assert.equal(socksProxyUrl(full), 'http://u:p@203.0.113.7:8080')
  assert.equal(socksProxyUrl({ url: 'http://203.0.113.7' }), 'http://203.0.113.7:80')
  const edited = pool.update(httpRow.id, { port: 3128 })
  assert.equal(edited.ok, true)
  assert.equal(edited.proxy.scheme, 'http')
  assert.equal(pool.getProxyByIdWithAuth(httpRow.id).url, 'http://u:p@203.0.113.7:3128')
})

async function fakeHttpProxy(t, reply) {
  const seen = []
  const server = net.createServer((socket) => {
    socket.once('data', (data) => {
      seen.push(data.toString('latin1'))
      socket.end(reply)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  return { port: server.address().port, seen }
}

test('probes http proxies with CONNECT and Basic auth', async (t) => {
  const pool = makePool(t)
  const ok = await fakeHttpProxy(t, 'HTTP/1.1 200 Connection established\r\n\r\n')
  const row = pool.importLines(`http://user:secret@127.0.0.1:${ok.port}`).items[0]
  const { probe } = await pool.probeById(row.id)
  assert.equal(probe.ok, true)
  assert.match(ok.seen[0], /^CONNECT 1\.1\.1\.1:443 HTTP\/1\.1\r\n/)
  assert.match(ok.seen[0], new RegExp(`Proxy-Authorization: Basic ${Buffer.from('user:secret').toString('base64')}`))

  const denied = await fakeHttpProxy(t, 'HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
  const bad = pool.importLines(`http://user:wrong@127.0.0.1:${denied.port}`).items[0]
  assert.match((await pool.probeById(bad.id)).probe.error, /^proxy_auth_failed/)

  const socksPort = await fakeHttpProxy(t, Buffer.from([0x05, 0x00]))
  const wrong = pool.importLines(`http://127.0.0.1:${socksPort.port}`).items[0]
  assert.match((await pool.probeById(wrong.id)).probe.error, /^not_http_proxy/)
})
