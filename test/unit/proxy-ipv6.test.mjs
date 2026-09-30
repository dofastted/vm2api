import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { ProxyPool, parseSocks5Fields, parseSocks5Line } from '../../src/lib/vm/proxy-pool.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { socksProxyUrl } from '../../src/lib/vm/socks-address.mjs'
import { boundProxyUrl } from '../../src/lib/vm/egress.mjs'
import { resolveImportProxy } from '../../src/lib/vm/proxy-resolve.mjs'
import { evaluateSlotGate } from '../../src/lib/pool/schedule-eligibility.mjs'
import { isCodexSlotReady, pickCodexSlots } from '../../src/lib/pool/codex-slot-pool.mjs'

function makePool(t) {
  const pool = new ProxyPool({ db: openDatabase({ dbPath: ':memory:' }) })
  pool.updateConfig({ enabled: false })
  t.after(() => {
    pool.stopScheduler()
    closeDatabase()
  })
  return pool
}

test('IPv6 aliases normalize and deduplicate after loading bracketed historical hosts', (t) => {
  const pool = makePool(t)
  const first = pool.importLines('socks5h://a%3Ab:p%40%3A%2F%25@[2001:0db8:0:0:0:0:0:1]:1080')
  const id = first.items[0].id
  const full = pool.getProxyByIdWithAuth(id)
  assert.equal(full.host, '2001:db8::1')
  assert.equal(full.username, 'a:b')
  assert.equal(full.password, 'p@:/%')
  assert.equal(full.url, 'socks5://a%3Ab:p%40%3A%2F%25@[2001:db8::1]:1080')
  assert.equal(parseSocks5Line(full.url).password, full.password)
  pool.db.prepare('UPDATE proxies SET host = ? WHERE id = ?').run('[2001:0db8::1]', id)
  pool.reload()
  assert.equal(pool.state.proxies[0].host, '2001:db8::1')
  const result = pool.importLines('', {
    fields: [{ host: '2001:db8::1', port: 1080, username: 'a:b', password: 'p@:/%' }],
  })
  assert.equal(result.added, 0)
  assert.equal(result.skip_details[0].reason, 'duplicate')
  assert.equal(socksProxyUrl(parseSocks5Fields({ host: '[::1]', port: '1080' })), 'socks5h://[::1]:1080')
})

test('bracketed IPv6 input works without changing hostname vendor credentials', () => {
  assert.equal(parseSocks5Line('[2001:db8::1]:1080:user:p:a').password, 'p:a')
  assert.equal(parseSocks5Line('user:pass@[::1]:1080').host, '::1')
  assert.equal(parseSocks5Line('abc:1080:def:abcdef').password, 'abcdef')
  assert.equal(parseSocks5Line('proxy.example:1080:user:p:a').password, 'p:a')
  for (const value of [
    '2001:db8::1:1080',
    '2001:db8:0:0:0:0:0:1:1080',
    '[::1:1080',
    '::1]:1080',
    '[127.0.0.1]:1080',
    'user:pass@::1:1080',
  ]) {
    assert.equal(parseSocks5Line(value), null, value)
  }
})

test('malformed historical IPv6 hosts cannot silently probe localhost', async (t) => {
  const pool = makePool(t)
  let connections = 0
  const sockets = new Set()
  const server = net.createServer((socket) => {
    connections += 1
    sockets.add(socket)
    socket.once('data', () => socket.write(Buffer.from([5, 0])))
    socket.on('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  const {
    items: [proxy],
  } = pool.importLines(`127.0.0.1:${server.address().port}`)
  pool.db.prepare('UPDATE proxies SET host = ? WHERE id = ?').run('[::1', proxy.id)
  pool.reload()
  const result = await pool.probeById(proxy.id)
  assert.equal(result.probe.error, 'invalid_proxy_host')
  assert.equal(connections, 0)
})

test('IPv6 policy survives reload and preserves binding and health instead of reallocating', async (t) => {
  const pool = makePool(t)
  const {
    items: [ipv6],
  } = pool.importLines('[2001:db8::1]:1080\n127.0.0.1:1080')
  assert.equal(pool.bind(ipv6.id, 'vm-01').error, 'ipv6_disabled')
  assert.equal(pool.allocateForVm('vm-02').host, '127.0.0.1')
  assert.equal((await pool.detectGeo(ipv6.id)).error, 'ipv6_disabled')
  assert.throws(() => boundProxyUrl({ host: '::1', port: 1080 }), { code: 'ipv6_disabled' })
  pool.updateConfig({ ipv6_enabled: true })
  assert.equal(pool.bind(ipv6.id, 'vm-01').ok, true)
  const proxy = pool.state.proxies.find((p) => p.id === ipv6.id)
  Object.assign(proxy, { status: 'ok', latency_ms: 20, last_probe_at: '2026-10-01T00:00:00Z', consecutive_failures: 2 })
  const history = { status: proxy.status, last_probe_at: proxy.last_probe_at, failures: proxy.consecutive_failures }
  pool.updateConfig({ ipv6_enabled: false, disconnect_on_error: true })
  pool.reload()
  assert.equal(pool.snapshot().config.ipv6_enabled, false)
  assert.equal(pool.getProxyForVm('vm-01'), null)
  assert.equal(pool.ensureBoundToVm('vm-01', ipv6.id), null)
  assert.equal(pool.ensureBoundToVm('vm-03', ipv6.id), null)
  assert.equal(pool.allocateForVm('vm-01'), null)
  assert.equal(pool.reportRuntimeFailure('vm-01', 'connection_closed').reason, 'ipv6_disabled')
  const result = await pool.probeById(ipv6.id)
  assert.equal(result.probe.scope, 'policy')
  assert.equal(result.proxy.blocked_reason, 'ipv6_disabled')
  assert.deepEqual(result.proxy.bound_vm_ids, ['vm-01'])
  assert.deepEqual(
    {
      status: result.proxy.status,
      last_probe_at: result.proxy.last_probe_at,
      failures: result.proxy.consecutive_failures,
    },
    history,
  )
  const vm = { id: 'vm-01', proxy: pool.getProxyByIdWithAuth(ipv6.id) }
  assert.equal(
    resolveImportProxy({ vm, proxyPool: pool, overrideUrl: 'socks5h://127.0.0.1:1080' }).reason,
    'ipv6_disabled',
  )
  assert.equal(evaluateSlotGate(vm).reason, 'ipv6_disabled')
  const codex = { ...vm, platform: 'openai', has_token: true, status: 'running' }
  assert.equal(isCodexSlotReady(codex), false)
  assert.equal(pickCodexSlots([codex], { pin: codex.id }).error, 'ipv6_disabled')
  pool.updateConfig({ ipv6_enabled: true })
  pool.reload()
  assert.equal(pool.getProxyForVm('vm-01').id, ipv6.id)
  assert.equal(boundProxyUrl(vm.proxy), 'socks5h://[2001:db8::1]:1080')
})

test('URL-imported IPv6 probes connect only when enabled and closing cancels in-flight sockets', async (t) => {
  const pool = makePool(t)
  const sockets = new Set()
  let connections = 0
  const server = net.createServer((socket) => {
    sockets.add(socket)
    connections += 1
    socket.on('close', () => sockets.delete(socket))
    const respond = connections === 1
    socket.on('data', () => {
      if (respond) socket.write(Buffer.from([5, 0]))
    })
  })
  server.listen({ host: '::1', port: 0 })
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  const {
    items: [proxy],
  } = pool.importLines(`socks5h://[::1]:${server.address().port}`)
  assert.equal((await pool.probeById(proxy.id)).probe.error, 'ipv6_disabled')
  assert.equal((await pool.probeAll()).total, 0)
  assert.equal(connections, 0)
  pool.updateConfig({ ipv6_enabled: true })
  assert.equal((await pool.probeById(proxy.id)).probe.ok, true)
  const history = pool.state.proxies[0].last_probe_at
  const connected = once(server, 'connection')
  const pending = pool.probeById(proxy.id)
  const [socket] = await connected
  const closed = once(socket, 'close')
  pool.updateConfig({ ipv6_enabled: false })
  assert.equal((await pending).probe.error, 'ipv6_disabled')
  await closed
  assert.equal(pool.state.proxies[0].status, 'ok')
  assert.equal(pool.state.proxies[0].last_probe_at, history)
  assert.equal(pool.state.proxies[0].consecutive_failures, 0)
})
