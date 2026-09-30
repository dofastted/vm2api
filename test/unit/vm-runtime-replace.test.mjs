import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  shouldReplaceSlotContainer,
  proxyEndpointFromUrl,
  proxyEndpointFromVm,
  readWorkerProxyEndpoint,
  readWorkerEgressMode,
  isSlotProxyDesynced,
  reloadSlotWorker,
} from '../../src/lib/vm/vm-runtime.mjs'

const running = { running: true, networkMode: 'host', image: 'kin-os/ubuntu:24.04' }
const stopped = { running: false, networkMode: 'host', image: 'kin-os/ubuntu:24.04' }

test('running slot is never replaced unless recreate is explicit', () => {
  assert.equal(
    shouldReplaceSlotContainer({ existing: running, recreate: false, network: 'bridge', image: 'other' }),
    false,
  )
  assert.equal(
    shouldReplaceSlotContainer({ existing: running, recreate: true, network: 'host', image: running.image }),
    true,
  )
})

test('stopped slot is replaced only when net or image is wrong', () => {
  assert.equal(
    shouldReplaceSlotContainer({ existing: stopped, recreate: false, network: 'host', image: stopped.image }),
    false,
  )
  assert.equal(
    shouldReplaceSlotContainer({ existing: stopped, recreate: false, network: 'bridge', image: stopped.image }),
    true,
  )
  assert.equal(
    shouldReplaceSlotContainer({ existing: stopped, recreate: false, network: 'host', image: 'other' }),
    true,
  )
})

test('missing container is not replaced', () => {
  assert.equal(shouldReplaceSlotContainer({ existing: null, recreate: true }), false)
})

test('proxyEndpoint strips userinfo', () => {
  assert.equal(proxyEndpointFromUrl('socks5h://user:pass@72.1.181.43:5437'), '72.1.181.43:5437')
  assert.equal(proxyEndpointFromVm({ proxy: { host: '72.1.181.43', port: 5437 } }), '72.1.181.43:5437')
})

test('isSlotProxyDesynced compares worker.json to vm.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-proxy-sync-'))
  const vm = { id: 'vm-02', proxy: { host: '72.1.181.43', port: 5437, url: 'socks5://u:p@72.1.181.43:5437' } }
  fs.mkdirSync(path.join(root, 'vms', 'vm-02', 'run'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-02', 'run', 'worker.json'),
    JSON.stringify({
      proxy_url: 'socks5h://old:pass@154.9.177.229:5509',
    }),
  )
  assert.equal(readWorkerProxyEndpoint(root, 'vm-02'), '154.9.177.229:5509')
  assert.equal(isSlotProxyDesynced(vm, root), true)
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-02', 'run', 'worker.json'),
    JSON.stringify({
      proxy_url: 'socks5h://u:p@72.1.181.43:5437',
    }),
  )
  assert.equal(isSlotProxyDesynced(vm, root), false)
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-02', 'run', 'worker.json'),
    JSON.stringify({
      proxy_url: '',
      proxy_required: false,
    }),
  )
  assert.equal(isSlotProxyDesynced(vm, root), true)
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-02', 'run', 'worker.json'),
    JSON.stringify({
      proxy_url: '',
      proxy_required: false,
      egress_mode: 'transparent',
    }),
  )
  assert.equal(isSlotProxyDesynced(vm, root), false)
  fs.rmSync(path.join(root, 'vms', 'vm-02', 'run', 'worker.json'))
  assert.equal(readWorkerProxyEndpoint(root, 'vm-02'), undefined)
  assert.equal(isSlotProxyDesynced(vm, root), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('reload writes transparent egress for local exit without a SOCKS url', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-reload-local-'))
  const vm = {
    id: 'vm-09',
    proxy_cli_enabled: true,
    proxy: { id: 'px-local', scheme: 'local', host: 'local', port: 0, url: null },
  }
  const result = reloadSlotWorker(vm, root, { routing: {} })
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-09', 'run', 'worker.json'), 'utf8'))
  assert.equal(doc.proxy_url, '')
  assert.equal(doc.proxy_required, false)
  assert.equal(doc.egress_mode, 'transparent')
  assert.equal(readWorkerEgressMode(root, 'vm-09'), 'transparent')
  assert.notEqual(result.error, 'slot SOCKS5 proxy is required')
  fs.rmSync(root, { recursive: true, force: true })
})

test('IPv6 address spelling does not desynchronize a slot, a changed endpoint does', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ipv6-sync-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = { id: 'vm-03', proxy: { host: '[2001:0db8::1]', port: 1080 } }
  const run = path.join(root, 'vms', vm.id, 'run')
  fs.mkdirSync(run, { recursive: true })
  const config = path.join(run, 'worker.json')
  fs.writeFileSync(config, JSON.stringify({ proxy_url: 'socks5h://user:p%40ss@[2001:db8::1]:1080' }))
  assert.equal(isSlotProxyDesynced(vm, root), false)
  fs.writeFileSync(config, JSON.stringify({ proxy_url: 'socks5h://user:p%40ss@[2001:db8::2]:1080' }))
  assert.equal(isSlotProxyDesynced(vm, root), true)
})
