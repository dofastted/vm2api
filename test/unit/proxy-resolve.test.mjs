import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { resolveImportProxy } from '../../src/lib/vm/proxy-resolve.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-resolve-'))
}

test('prefers pool credentials over host-only vm.proxy', () => {
  const pool = new ProxyPool({ dataDir: tmpDir() })
  pool.importLines('socks5://user:s3cret@10.0.0.5:1080')
  const id = pool.snapshot().proxies[0].id
  pool.bind(id, 'vm-02')
  pool.stopScheduler()
  const resolved = resolveImportProxy({
    vm: { id: 'vm-02', proxy: { id, host: '10.0.0.5', port: 1080 } },
    proxyPool: pool,
  })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.proxyUrl, 'socks5h://user:s3cret@10.0.0.5:1080')
})

test('blocks import when bound proxy is fail or dead', () => {
  const pool = new ProxyPool({ dataDir: tmpDir() })
  pool.importLines('10.0.0.6:1080')
  const id = pool.snapshot().proxies[0].id
  pool.bind(id, 'vm-03')
  pool.setEnabled(id, false)
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
