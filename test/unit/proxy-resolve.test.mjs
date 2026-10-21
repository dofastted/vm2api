import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { resolveImportProxy } from '../../src/lib/vm/proxy-resolve.mjs'
import { hostProxyUrlForVm } from '../../src/lib/vm/slot-host.mjs'
import { startNodeEgressSocks, stopNodeEgressSocks } from '../../src/lib/cluster/node-egress-socks.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-resolve-'))
}

test('prefers pool credentials over host-only vm.proxy', async () => {
  const pool = await new ProxyPool({ dataDir: tmpDir() }).init()
  await pool.importLines('socks5://user:s3cret@10.0.0.5:1080')
  const id = pool.snapshot().proxies[0].id
  await pool.bind(id, 'vm-02')
  pool.stopScheduler()
  const resolved = resolveImportProxy({
    vm: { id: 'vm-02', proxy: { id, host: '10.0.0.5', port: 1080 } },
    proxyPool: pool,
  })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.proxyUrl, 'socks5h://user:s3cret@10.0.0.5:1080')
})

test('blocks import when bound proxy is fail or dead', async () => {
  const pool = await new ProxyPool({ dataDir: tmpDir() }).init()
  await pool.importLines('10.0.0.6:1080')
  const id = pool.snapshot().proxies[0].id
  await pool.bind(id, 'vm-03')
  await pool.setEnabled(id, false)
  pool.stopScheduler()
  const resolved = resolveImportProxy({
    vm: { id: 'vm-03', proxy: { id, host: '10.0.0.6', port: 1080, url: 'socks5h://10.0.0.6:1080' } },
    proxyPool: pool,
    overrideUrl: 'socks5h://evil.example:1080',
  })
  assert.equal(resolved.ok, false)
  assert.equal(resolved.blocked, true)
  assert.equal(resolved.reason, 'proxy_unavailable')
  assert.equal(resolved.proxyUrl, null)
})

test('falls back to vm.proxy.url when pool has no row', () => {
  const resolved = resolveImportProxy({
    vm: { id: 'vm-sim-01', proxy: { url: 'socks5h://127.0.0.1:19080', host: '127.0.0.1', port: 19080 } },
    proxyPool: { snapshot: () => ({ proxies: [] }), getProxyForVm: () => null },
  })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.proxyUrl, 'socks5h://127.0.0.1:19080')
})

test('reports proxy_required when nothing is bound', () => {
  const resolved = resolveImportProxy({
    vm: { id: 'vm-empty', proxy: null },
    proxyPool: { snapshot: () => ({ proxies: [] }), getProxyForVm: () => null },
  })
  assert.equal(resolved.ok, false)
  assert.equal(resolved.reason, 'proxy_required')
})

test('local egress is a bound exit without a SOCKS URL', () => {
  const resolved = resolveImportProxy({
    vm: {
      id: 'vm-01',
      proxy: { id: 'px-local', host: 'local', port: 0, scheme: 'local', url: null },
    },
    proxyPool: {
      snapshot: () => ({
        proxies: [{ id: 'px-local', host: 'local', port: 0, scheme: 'local', enabled: true, status: 'ok' }],
      }),
      getProxyForVm: () => ({ id: 'px-local', url: '', host: 'local', port: 0, scheme: 'local' }),
    },
  })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.direct, true)
  assert.equal(resolved.proxyUrl, '')
})

test('local Codex import carries the deployment proxy; local Claude stays direct', (t) => {
  const saved = process.env.HTTPS_PROXY
  process.env.HTTPS_PROXY = 'http://proxy.test:8443'
  t.after(() => {
    if (saved === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = saved
  })
  const proxy = { id: 'px-local', host: 'local', port: 0, scheme: 'local', url: null }
  const proxyPool = { snapshot: () => ({ proxies: [] }), getProxyForVm: () => null }
  const gpt = resolveImportProxy({ vm: { id: 'vm-gpt', platform: 'openai', proxy }, proxyPool })
  assert.equal(gpt.proxyUrl, 'http://proxy.test:8443')
  assert.equal(gpt.direct, true)
  assert.equal(resolveImportProxy({ vm: { id: 'vm-cc', platform: 'anthropic', proxy }, proxyPool }).proxyUrl, '')
})

test('node slot on local egress leaves through that node, never the control plane route', async (t) => {
  const proxy = { id: 'px-local', host: 'local', port: 0, scheme: 'local', url: null }
  const proxyPool = { snapshot: () => ({ proxies: [] }), getProxyForVm: () => null }
  const vm = { id: 'vm-n1', platform: 'anthropic', node_id: 'node-a', proxy }
  const missing = resolveImportProxy({ vm, proxyPool })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'proxy_unavailable')

  await startNodeEgressSocks({ clientFor: () => assert.fail('no CONNECT expected') })
  t.after(stopNodeEgressSocks)
  const resolved = resolveImportProxy({ vm, proxyPool })
  assert.equal(resolved.ok, true)
  const url = new URL(resolved.proxyUrl)
  assert.equal(url.protocol, 'socks5h:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.username, 'node-a')
  assert.equal(hostProxyUrlForVm(vm), resolved.proxyUrl)
  // Same node, same pool row, a control-plane slot still goes direct.
  assert.equal(resolveImportProxy({ vm: { ...vm, node_id: null }, proxyPool }).proxyUrl, '')
})

test('stale local egress failure is still a direct exit', () => {
  const resolved = resolveImportProxy({
    vm: {
      id: 'vm-01',
      proxy: { id: 'px-local', host: 'local', port: 0, scheme: 'local', url: null },
    },
    proxyPool: {
      snapshot: () => ({
        proxies: [{ id: 'px-local', host: 'local', scheme: 'local', enabled: true, status: 'dead' }],
      }),
      getProxyForVm: () => null,
    },
  })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.direct, true)
  assert.equal(resolved.proxyUrl, '')
})

test('operator-disabled local egress stays blocked', () => {
  const resolved = resolveImportProxy({
    vm: {
      id: 'vm-01',
      proxy: { id: 'px-local', host: 'local', port: 0, scheme: 'local' },
    },
    proxyPool: {
      snapshot: () => ({
        proxies: [{ id: 'px-local', host: 'local', scheme: 'local', enabled: false, status: 'ok' }],
      }),
      getProxyForVm: () => null,
    },
  })
  assert.equal(resolved.ok, false)
  assert.equal(resolved.blocked, true)
  assert.equal(resolved.reason, 'proxy_unavailable')
})
