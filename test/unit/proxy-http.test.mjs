import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { ProxyPool, parseSocks5Line, parseSocks5Fields } from '../../src/lib/vm/proxy-pool.mjs'
import { boundProxyUrl } from '../../src/lib/vm/egress.mjs'
import { socksProxyEndpoint, socksProxyUrl } from '../../src/lib/vm/socks-address.mjs'

function makePool(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-http-proxy-'))
  const pool = new ProxyPool({ dataDir: dir })
  pool.stopScheduler()
  t.after(() => {
    pool.stopScheduler()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return pool
}

test('HTTP and HTTPS URI import preserves protocol, defaults and escaped credentials', () => {
  for (const scheme of ['http', 'https']) {
    const parsed = parseSocks5Line(`${scheme}://u%40x:p%3Aa@[::1]`)
    assert.equal(parsed.scheme, scheme)
    assert.equal(parsed.username, 'u@x')
    assert.equal(parsed.password, 'p:a')
    assert.equal(parsed.port, scheme === 'http' ? 80 : 443)
    assert.equal(socksProxyUrl(parsed), `${scheme}://u%40x:p%3Aa@[::1]:${parsed.port}`)
    assert.equal(socksProxyEndpoint({ url: `${scheme}://localhost` }), `localhost:${parsed.port}`)
    assert.equal(parseSocks5Fields({ scheme, host: 'proxy.example', port: 8080 }).scheme, scheme)
  }
  assert.equal(parseSocks5Line('ftp://user:pass@host:1234'), null)
  assert.equal(parseSocks5Fields({ scheme: 'ftp', host: 'host', port: 1234 }), null)
})

test('protocol-only edit preserves credentials and bindings and survives database reload', (t) => {
  const pool = makePool(t)
  pool.importLines('socks5://user:pass@127.0.0.1:8080')
  const id = pool.state.proxies[0].id
  pool.bind(id, 'vm-01')
  pool.reload() // Loaded rows have both protocol and scheme.
  for (const scheme of ['http', 'https', 'socks5']) {
    const result = pool.update(id, { scheme })
    assert.equal(result.ok, true)
    assert.equal(result.connection_changed, true)
    assert.deepEqual(result.proxy.bound_vm_ids, ['vm-01'])
    assert.equal(result.proxy.scheme, scheme)
    pool.reload()
    const proxy = pool.getProxyForVm('vm-01')
    assert.equal(proxy.scheme, scheme)
    assert.equal(proxy.url, `${scheme}://user:pass@127.0.0.1:8080`)
    assert.equal(boundProxyUrl(proxy), `${scheme === 'socks5' ? 'socks5h' : scheme}://user:pass@127.0.0.1:8080`)
  }
  assert.equal(pool.update(id, { scheme: 'ftp' }).ok, false)
  assert.equal(pool.getProxyByIdWithAuth(id).scheme, 'socks5')
})

test('same endpoint may have distinct protocol records without merging on import', (t) => {
  const pool = makePool(t)
  const text = ['socks5', 'http', 'https'].map((s) => `${s}://host:8080`).join('\n')
  assert.equal(pool.importLines(text).added, 3)
  pool.reload()
  assert.equal(pool.importLines(text).added, 0)
})

for (const status of [200, 407, 403]) {
  test(`HTTP health probe validates CONNECT response ${status}`, async (t) => {
    const pool = makePool(t)
    let request = ''
    const server = net.createServer((socket) => {
      socket.on('data', (data) => {
        request += data.toString()
        if (request.includes('\r\n\r\n')) {
          socket.write(`HTTP/1.1 ${status} Test\r\n`)
          setImmediate(() => socket.end('\r\n'))
        }
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const result = await pool._probeSocks({
      scheme: 'http',
      host: '127.0.0.1',
      port: server.address().port,
      username: 'u',
      password: 'p',
    })
    assert.equal(result.ok, status === 200)
    if (status === 407) assert.equal(result.error, 'proxy_auth_rejected')
    assert.match(request, /^CONNECT api\.anthropic\.com:443 HTTP\/1\.1/)
    assert.match(request, /Proxy-Authorization: Basic dTpw/)
  })
}
