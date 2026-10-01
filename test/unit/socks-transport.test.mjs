import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import fetch from 'node-fetch'
import { createSocksProxyAgent } from '../../src/lib/vm/socks-transport.mjs'
import { normalizeSocksHost, socksProxyUrl } from '../../src/lib/vm/socks-address.mjs'
import { makeSocksFetch } from '../../src/lib/protocol/codex-models.mjs'
import { lookupProxyGeo } from '../../src/lib/vm/proxy-geo.mjs'
import { ProxyPool, parseSocks5Fields, parseSocks5Line } from '../../src/lib/vm/proxy-pool.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'

const execFileAsync = promisify(execFile)
const certPath = fileURLToPath(new URL('../fixtures/socks-transport-cert.pem', import.meta.url))
const cert = fs.readFileSync(certPath)
const key = fs.readFileSync(new URL('../fixtures/socks-transport-key.pem', import.meta.url))
const targetHost = 'transport.example.invalid'
const credentials = { username: 'test:@/%', password: 'test%/@:secret' }
const geoPayload = { query: '2001:db8::1', country: 'Test', timezone: 'Etc/UTC' }

async function listen(t, server, host, port = 0) {
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
  })
  server.listen(port, host)
  await once(server, 'listening')
  return server.address().port
}

async function upstream(t, secure = false) {
  const requests = []
  const handler = (req, res) => {
    requests.push({ host: req.headers.host, path: req.url })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(geoPayload))
  }
  const server = () => (secure ? https.createServer({ key, cert }, handler) : http.createServer(handler))
  // Separate loopback listeners on the same port, without a wildcard listener.
  const port = await listen(t, server(), '::1')
  await listen(t, server(), '127.0.0.1', port)
  return { port, requests }
}

/** Real SOCKS5 negotiation/authentication and TCP relay, confined to loopback. */
async function socksPeer(t, { host = '::1', targetPort, auth = null } = {}) {
  const peer = { connections: 0, authAttempts: [], requests: [] }
  const server = net.createServer((socket) => {
    peer.connections += 1
    socket.setTimeout(3000, () => socket.destroy())
    socket.on('error', () => {})
    let buffer = Buffer.alloc(0)
    let stage = 'greeting'
    function read(data) {
      buffer = Buffer.concat([buffer, data])
      while (true) {
        if (stage === 'greeting') {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
          const method = auth ? 2 : 0
          if (buffer[0] !== 5 || !buffer.subarray(2, 2 + buffer[1]).includes(method)) {
            socket.end(Buffer.from([5, 255]))
            return
          }
          buffer = buffer.subarray(2 + buffer[1])
          socket.write(Buffer.from([5, method]))
          stage = auth ? 'auth' : 'connect'
        } else if (stage === 'auth') {
          if (buffer.length < 2) return
          const userEnd = 2 + buffer[1]
          if (buffer.length < userEnd + 1 || buffer.length < userEnd + 1 + buffer[userEnd]) return
          const end = userEnd + 1 + buffer[userEnd]
          const attempt = {
            username: buffer.subarray(2, userEnd).toString(),
            password: buffer.subarray(userEnd + 1, end).toString(),
          }
          peer.authAttempts.push(attempt)
          if (buffer[0] !== 1 || attempt.username !== auth.username || attempt.password !== auth.password) {
            socket.end(Buffer.from([1, 1]))
            return
          }
          buffer = buffer.subarray(end)
          socket.write(Buffer.from([1, 0]))
          stage = 'connect'
        } else if (stage === 'connect') {
          if (buffer.length < 5) return
          const atyp = buffer[3]
          const offset = atyp === 3 ? 5 : 4
          const size = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? buffer[4] : 0
          if (!size || buffer[0] !== 5 || buffer[1] !== 1) {
            socket.destroy()
            return
          }
          if (buffer.length < offset + size + 2) return
          const address = buffer.subarray(offset, offset + size)
          const destination =
            atyp === 1
              ? [...address].join('.')
              : atyp === 4
                ? normalizeSocksHost(
                    Array.from({ length: 8 }, (_, i) => address.readUInt16BE(i * 2).toString(16)).join(':'),
                  )
                : address.toString()
          const port = buffer.readUInt16BE(offset + size)
          peer.requests.push({ host: destination, port, atyp })
          // The deliberately unresolvable test domain maps only inside this peer.
          if (port !== targetPort || ![targetHost, 'localhost', '127.0.0.1', '::1'].includes(destination)) {
            socket.end(Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, 0, 0]))
            return
          }
          const remaining = buffer.subarray(offset + size + 2)
          socket.removeListener('data', read)
          socket.pause()
          stage = 'tunnel'
          const relay = net.connect({ host: net.isIP(destination) ? destination : '::1', port })
          socket.on('close', () => relay.destroy())
          relay.on('error', () => socket.destroy())
          relay.on('connect', () => {
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
            if (remaining.length) relay.write(remaining)
            relay.pipe(socket)
            socket.pipe(relay)
            socket.resume()
          })
          return
        } else return
      }
    }
    socket.on('data', read)
  })
  peer.port = await listen(t, server, host)
  return peer
}

test('shared agent normalizes only socket hosts and preserves URL, credentials, DNS and options', () => {
  for (const host of ['[::1]', '127.0.0.1', 'localhost']) {
    for (const scheme of ['socks5', 'socks5h']) {
      const url = `${scheme}://test%3A%40%2F%25:test%25%2F%40%3Asecret@${host}:1080`
      const agent = createSocksProxyAgent(new URL(url), { timeout: 1234, keepAlive: true })
      assert.equal(agent.proxy.host, normalizeSocksHost(host))
      assert.ok(agent.proxyUrl === url, 'URL serialization remains intact')
      assert.equal(agent.proxy.userId, credentials.username)
      assert.equal(agent.proxy.password, credentials.password)
      assert.equal(agent.shouldLookup, scheme === 'socks5')
      assert.equal(agent.timeout, 1234)
      assert.equal(agent.keepAlive, true)
      agent.destroy()
    }
  }
  assert.throws(() => createSocksProxyAgent('http://[::1]:1080'), /"socks" protocol/)
  assert.throws(() => createSocksProxyAgent('socks5h://[::1:1080'), TypeError)
  assert.throws(() => createSocksProxyAgent('socks5h:///'), /invalid SOCKS proxy host/)
})

test('makeSocksFetch completes real IPv6/IPv4 SOCKS5 HTTP transport with remote DNS and escaped auth', async (t) => {
  const target = await upstream(t)
  for (const host of ['::1', '127.0.0.1']) {
    for (const scheme of ['socks5', 'socks5h']) {
      for (const auth of [null, credentials]) {
        await t.test(`${host} ${scheme} ${auth ? 'authenticated' : 'unauthenticated'}`, async (t) => {
          const peer = await socksPeer(t, { host, targetPort: target.port, auth })
          const proxyUrl = socksProxyUrl({ host, port: peer.port, ...auth }, scheme)
          const fetchFn = makeSocksFetch(proxyUrl, 3000)
          const res = await fetchFn(`http://${targetHost}:${target.port}/fetch`)
          assert.equal(res.status, 200)
          assert.deepEqual(await res.json(), geoPayload)
          assert.equal(peer.connections, 1)
          assert.deepEqual(peer.requests, [{ host: targetHost, port: target.port, atyp: 3 }])
          assert.deepEqual(peer.authAttempts, auth ? [credentials] : [])
        })
      }
    }
  }
  assert.equal(target.requests.length, 8)
})

test('SOCKS proxy and destination address families vary independently over real sockets', async (t) => {
  const target = await upstream(t)
  for (const [host, destination, atyp] of [
    ['::1', '127.0.0.1', 1],
    ['::1', '::1', 4],
    ['127.0.0.1', '::1', 4],
  ]) {
    const peer = await socksPeer(t, { host, targetPort: target.port })
    const authority = net.isIPv6(destination) ? `[${destination}]` : destination
    const res = await makeSocksFetch(socksProxyUrl({ host, port: peer.port }))(`http://${authority}:${target.port}/ip`)
    assert.deepEqual(await res.json(), geoPayload)
    assert.deepEqual(peer.requests, [{ host: destination, port: target.port, atyp }])
  }
})

test('hostname proxy connects to IPv6-only loopback; Geo keeps local/remote destination DNS semantics', async (t) => {
  const target = await upstream(t)
  const peer = await socksPeer(t, { targetPort: target.port })
  const hostnameUrl = socksProxyUrl({ host: 'localhost', port: peer.port })
  const res = await makeSocksFetch(hostnameUrl)(`http://${targetHost}:${target.port}/hostname`)
  assert.deepEqual(await res.json(), geoPayload)
  for (const scheme of ['socks5', 'socks5h']) {
    const result = await lookupProxyGeo(socksProxyUrl({ host: '::1', port: peer.port }, scheme), {
      endpoint: `http://localhost:${target.port}/geo`,
    })
    assert.equal(result.ok, true)
    assert.equal(result.geo.ip, geoPayload.query)
    const request = peer.requests.at(-1)
    if (scheme === 'socks5') {
      assert.ok(net.isIP(request.host))
      assert.notEqual(request.atyp, 3)
    } else {
      assert.equal(request.host, 'localhost')
      assert.equal(request.atyp, 3)
    }
  }
  assert.equal(peer.connections, 3)
})

test('URL, structured and persisted bracketed proxies share fetch and real Geo transport', async (t) => {
  const target = await upstream(t)
  const peer = await socksPeer(t, { targetPort: target.port, auth: credentials })
  const url = socksProxyUrl({ host: '::1', port: peer.port, ...credentials })
  const pool = new ProxyPool({ db: openDatabase({ dbPath: ':memory:' }) })
  pool.updateConfig({ enabled: false, ipv6_enabled: true })
  t.after(() => {
    pool.stopScheduler()
    closeDatabase()
  })
  const id = pool.importLines(url).items[0].id
  pool.db.prepare('UPDATE proxies SET host = ? WHERE id = ?').run('[::1]', id)
  pool.reload()
  const records = [
    parseSocks5Line(url),
    parseSocks5Fields({ host: '[::1]', port: peer.port, ...credentials }),
    pool.getProxyByIdWithAuth(id),
  ]
  for (const record of records) {
    const proxyUrl = socksProxyUrl(record)
    const res = await makeSocksFetch(proxyUrl)(`http://${targetHost}:${target.port}/import`)
    assert.deepEqual(await res.json(), geoPayload)
    const geo = await lookupProxyGeo(proxyUrl, { endpoint: `http://${targetHost}:${target.port}/geo` })
    assert.equal(geo.ok, true)
    assert.equal(geo.geo.ip, geoPayload.query)
  }
  assert.equal(peer.connections, 6)
  assert.equal(target.requests.length, 6)
  assert.deepEqual(peer.authAttempts, Array(6).fill(credentials))
  assert.ok(peer.requests.every((req) => req.host === targetHost && req.atyp === 3))
})

test('IPv6 SOCKS HTTPS transport validates certificates for fetch and Geo', async (t) => {
  const target = await upstream(t, true)
  const peer = await socksPeer(t, { targetPort: target.port, auth: credentials })
  const proxyUrl = socksProxyUrl({ host: '::1', port: peer.port, ...credentials })
  const endpoint = `https://${targetHost}:${target.port}/tls`
  // No global TLS bypass: an untrusted certificate must still fail.
  await assert.rejects(makeSocksFetch(proxyUrl, 3000)(endpoint), /self.signed certificate/)
  const untrustedGeo = await lookupProxyGeo(proxyUrl, { endpoint })
  assert.equal(untrustedGeo.ok, false)
  assert.match(untrustedGeo.error, /^geo_transport_error:.*self.signed certificate/)
  assert.equal(target.requests.length, 0)
  // NODE_EXTRA_CA_CERTS is read at process startup. Trust only our test CA in a
  // child running the actual exported production transports, with no mock fetch.
  const script = `
    import assert from 'node:assert/strict';
    import { makeSocksFetch } from './src/lib/protocol/codex-models.mjs';
    import { lookupProxyGeo } from './src/lib/vm/proxy-geo.mjs';
    const proxyUrl = process.env.VM2API_TEST_PROXY_URL;
    const endpoint = process.env.VM2API_TEST_ENDPOINT;
    const res = await makeSocksFetch(proxyUrl)(endpoint);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).query, '2001:db8::1');
    const geo = await lookupProxyGeo(proxyUrl, { endpoint });
    assert.equal(geo.ok, true);
    assert.equal(geo.geo.ip, '2001:db8::1');
  `
  await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: certPath,
      VM2API_TEST_PROXY_URL: proxyUrl,
      VM2API_TEST_ENDPOINT: endpoint,
    },
    timeout: 10000,
  })
  assert.equal(target.requests.length, 2)
  assert.equal(peer.connections, 4)
  assert.ok(peer.requests.every((req) => req.host === targetHost && req.atyp === 3))
})

test('proxy authentication rejection never falls back to a direct HTTP request', async (t) => {
  const target = await upstream(t)
  const peer = await socksPeer(t, { targetPort: target.port, auth: credentials })
  const proxyUrl = socksProxyUrl({ host: '::1', port: peer.port, username: 'wrong', password: 'wrong' })
  const endpoint = `http://127.0.0.1:${target.port}/no-fallback`
  await assert.rejects(makeSocksFetch(proxyUrl, 3000)(endpoint), /Socks5 Authentication failed/)
  const geo = await lookupProxyGeo(proxyUrl, { endpoint })
  assert.equal(geo.ok, false)
  assert.match(geo.error, /^geo_transport_error:.*Socks5 Authentication failed/)
  assert.equal(peer.connections, 2)
  assert.equal(peer.requests.length, 0)
  assert.equal(target.requests.length, 0)
})

test('agent options still support trusted TLS through an IPv6 proxy', async (t) => {
  const target = await upstream(t, true)
  const peer = await socksPeer(t, { targetPort: target.port })
  const agent = createSocksProxyAgent(socksProxyUrl({ host: '::1', port: peer.port }), { ca: cert })
  t.after(() => agent.destroy())
  const res = await fetch(`https://${targetHost}:${target.port}/agent`, { agent })
  assert.deepEqual(await res.json(), geoPayload)
  assert.equal(peer.connections, 1)
})

test('invalid proxy configuration rejects fetch and returns a Geo transport error without direct fallback', async (t) => {
  const target = await upstream(t)
  const endpoint = `http://127.0.0.1:${target.port}/invalid-proxy`
  for (const proxyUrl of ['http://[::1]:1080', 'socks5h://[::1:1080', 'socks5h:///']) {
    await assert.rejects(makeSocksFetch(proxyUrl, 30000)(endpoint))
    const result = await lookupProxyGeo(proxyUrl, { endpoint })
    assert.equal(result.ok, false)
    assert.match(result.error, /^geo_transport_error:/)
  }
  assert.equal(target.requests.length, 0)
  // A rejected agent constructor must not leave a 30-second abort timer alive.
  await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
       import { makeSocksFetch } from './src/lib/protocol/codex-models.mjs';
       await assert.rejects(makeSocksFetch('socks5h://[::1:1080', 30000)('http://127.0.0.1:1'));`,
    ],
    { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 10000 },
  )
})

test('real pool Geo honors IPv6 policy and distinguishes forced transport from cached batch results', async (t) => {
  const target = await upstream(t)
  const peer = await socksPeer(t, { targetPort: target.port, auth: credentials })
  const endpoint = `http://[::1]:${target.port}/pool-geo`
  const pool = new ProxyPool({
    db: openDatabase({ dbPath: ':memory:' }),
    geoLookup: (url, options) => lookupProxyGeo(url, { ...options, endpoint }),
  })
  pool.updateConfig({ enabled: false })
  t.after(() => {
    pool.stopScheduler()
    closeDatabase()
  })
  const id = pool.importLines(socksProxyUrl({ host: '::1', port: peer.port, ...credentials })).items[0].id
  assert.equal((await pool.detectGeo(id, { force: true })).error, 'ipv6_disabled')
  let batch = await pool.detectGeoAll({ force: true })
  assert.equal(batch.results[0].error, 'ipv6_disabled')
  assert.equal(peer.connections, 0)

  pool.updateConfig({ ipv6_enabled: true })
  const fresh = await pool.detectGeo(id)
  assert.equal(fresh.ok, true)
  assert.equal(fresh.cached, false)
  assert.equal(fresh.geo.ip, geoPayload.query)
  assert.equal(peer.connections, 1)
  batch = await pool.detectGeoAll()
  assert.equal(batch.results[0].cached, true)
  assert.equal(peer.connections, 1)
  batch = await pool.detectGeoAll({ force: true })
  assert.equal(batch.results[0].ok, true)
  assert.equal(batch.results[0].cached, false)
  assert.equal(peer.connections, 2)

  pool.updateConfig({ ipv6_enabled: false })
  assert.equal((await pool.detectGeo(id)).error, 'ipv6_disabled')
  batch = await pool.detectGeoAll({ force: true })
  assert.equal(batch.results[0].error, 'ipv6_disabled')
  assert.equal(peer.connections, 2)
  assert.equal(target.requests.length, 2)
})
