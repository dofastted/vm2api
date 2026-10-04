import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ProxyPool, parseSocks5Line, parseSocks5Fields } from '../../src/lib/vm/proxy-pool.mjs'
import { outboundProxyUrl, socksProxyUrl } from '../../src/lib/vm/socks-address.mjs'
import { boundProxyUrl } from '../../src/lib/vm/egress.mjs'
import { resolveImportProxy } from '../../src/lib/vm/proxy-resolve.mjs'

function poolFor(t) {
  const db = createDatabase({ dbPath: ':memory:' })
  const pool = new ProxyPool({ db })
  t.after(() => {
    pool.stopScheduler()
    db.close()
  })
  return pool
}

test('HTTP URL credentials are decoded without treating http as the username', () => {
  const p = parseSocks5Line('http://alice:p%40ss%3Aword@192.0.2.10:12323')
  assert.deepEqual(
    [p.scheme, p.host, p.port, p.username, p.password],
    ['http', '192.0.2.10', 12323, 'alice', 'p@ss:word'],
  )
  assert.equal(outboundProxyUrl(p), 'http://alice:p%40ss%3Aword@192.0.2.10:12323')
  assert.equal(parseSocks5Line('https://alice:pass@proxy.example').port, 443)
  assert.equal(parseSocks5Line('http://proxy.example').port, 80)
  assert.equal(parseSocks5Line('HTTPS://alice:pass@proxy.example:8443').scheme, 'https')
  const ipv6 = parseSocks5Line('http://alice:p%25@[2001:db8::1]:8080')
  assert.equal(outboundProxyUrl(ipv6), 'http://alice:p%25@[2001:db8::1]:8080')
})

test('explicit unsupported or malformed schemes never fall through to vendor credentials', () => {
  for (const url of [
    'ftp://alice:pass@192.0.2.10:21',
    'socks4://alice:pass@192.0.2.10:1080',
    'http://a:p@host:0',
    'http://a:p@host:65536',
    'http://a:%GG@host:80',
    'http://host/path',
    'http://host/?query=1',
    'http://host/#fragment',
  ]) {
    assert.equal(parseSocks5Line(url), null, url)
  }
  assert.equal(parseSocks5Fields({ protocol: 'ftp', host: 'host', port: 21 }), null)
  assert.equal(parseSocks5Fields({ protocol: 'http', scheme: 'socks5', host: 'host', port: 80 }), null)
  assert.equal(parseSocks5Fields({ protocol: 'http', host: 'host', port: 80 }).scheme, 'http')
  assert.throws(() => outboundProxyUrl({ scheme: 'ftp', host: 'host', port: 21 }), /unsupported proxy scheme/)
  assert.throws(() => socksProxyUrl({ url: 'http://host:80' }), /invalid SOCKS5 URL/)
})

test('HTTP protocol survives import, reload, binding, endpoint edit and explicit scheme change', (t) => {
  const pool = poolFor(t)
  const batch = pool.importLines(
    'http://alice:pass@192.0.2.10:8080\nsocks5://alice:pass@192.0.2.10:8080\nhttps://alice:pass@192.0.2.10:8080',
  )
  assert.equal(batch.added, 3)
  const id = batch.items[0].id
  pool.reload()
  assert.equal(pool.importLines('http://alice:pass@192.0.2.10:8080').added, 0)
  assert.equal(pool.bind(id, 'vm-fixture').ok, true)
  const proxy = pool.getProxyForVm('vm-fixture')
  assert.equal(proxy.scheme, 'http')
  assert.equal(boundProxyUrl(proxy), 'http://alice:pass@192.0.2.10:8080')
  assert.equal(resolveImportProxy({ vm: { id: 'vm-fixture', proxy }, proxyPool: pool }).proxyUrl, proxy.url)
  assert.equal(pool.update(id, { port: 8081 }).ok, true)
  pool.reload()
  assert.equal(pool.getProxyByIdWithAuth(id).url, 'http://alice:pass@192.0.2.10:8081')
  assert.equal(pool.update(id, { protocol: 'https' }).ok, true)
  pool.reload()
  assert.equal(pool.getProxyByIdWithAuth(id).url, 'https://alice:pass@192.0.2.10:8081')
  assert.equal(pool.update(id, { protocol: 'ftp' }).error, 'invalid_proxy')
  assert.doesNotMatch(JSON.stringify(pool.snapshot()), /alice|password|username/)
})

test('probing an HTTP exit sends no SOCKS5 greeting', async (t) => {
  const pool = poolFor(t)
  const chunks = []
  const server = net.createServer((socket) => socket.on('data', (data) => chunks.push(data)))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const result = pool.importLines(`http://127.0.0.1:${server.address().port}`)
  assert.equal((await pool.probeById(result.items[0].id)).probe.ok, true)
  assert.equal(chunks.length, 0)
})
