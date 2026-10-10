import test from 'node:test'
import assert from 'node:assert/strict'
import {
  publicAllocatedProxy,
  publicRuntimeView,
  publicSlotBoot,
  publicVmBootView,
} from '../../src/lib/admin/panel-api.mjs'

test('publicAllocatedProxy uses publicProxy and drops credentials', () => {
  const bound = {
    id: 'px-1',
    host: '1.2.3.4',
    port: 1080,
    username: 'alice',
    password: 's3cret',
    url: 'socks5://alice:s3cret@1.2.3.4:1080',
  }
  const pool = {
    state: {
      proxies: [{ id: 'px-1', host: '1.2.3.4', port: 1080, username: 'alice', password: 's3cret' }],
    },
    publicProxy(p) {
      return { id: p.id, host: p.host, port: p.port, has_auth: !!(p.username || p.password) }
    },
  }
  const view = publicAllocatedProxy(pool, bound)
  const raw = JSON.stringify(view)
  assert.equal(view.id, 'px-1')
  assert.equal(view.has_auth, true)
  assert.doesNotMatch(raw, /alice|s3cret|socks5:\/\//)
})

test('publicAllocatedProxy fallback omits url and password when pool miss', () => {
  const view = publicAllocatedProxy(null, {
    id: 'px-2',
    host: '9.9.9.9',
    port: 1081,
    username: 'bob',
    password: 'pw',
    url: 'socks5://bob:pw@9.9.9.9:1081',
    has_auth: true,
  })
  assert.equal(view.host, '9.9.9.9')
  assert.equal(view.has_auth, true)
  assert.equal(view.url, undefined)
  assert.equal(view.username, undefined)
  assert.equal(view.password, undefined)
})

test('publicSlotBoot and publicRuntimeView drop host infrastructure', () => {
  const boot = publicSlotBoot({
    ok: true,
    action: 'started',
    engine: 'rust',
    rust_ok: true,
    runtime: {
      container_id: 'abc123deadbeef',
      ip: '166.88.96.199',
      pid: 4242,
      worker_run_dir: '/opt/vm2api/vms/vm-01/run',
      worker_token_file: '/opt/vm2api/vms/vm-01/run/internal.token',
    },
    rust: { ok: true, skipped: false, health: { ok: true }, error: null },
  })
  const raw = JSON.stringify(boot)
  assert.equal(boot.ok, true)
  assert.equal(boot.action, 'started')
  assert.equal(boot.runtime, undefined)
  assert.doesNotMatch(raw, /abc123deadbeef|166\.88\.96\.199|internal\.token|\/opt\/vm2api/)

  const runtime = publicRuntimeView({
    type: 'docker',
    container: 'kin-01',
    container_id: 'abc123deadbeef',
    ip: '1.1.1.1',
    pid: 9,
    worker_run_dir: '/opt/vm2api/vms/vm-01/run',
    worker_token_file: '/secret',
    worker: 'rust',
    egress: 'explicit-socks5',
  })
  assert.deepEqual(runtime, {
    type: 'docker',
    worker: 'rust',
    egress: 'explicit-socks5',
  })
  assert.equal(publicRuntimeView('docker-container'), 'docker-container')
})

test('publicVmBootView exposes state without account or infrastructure identifiers', () => {
  const view = publicVmBootView({
    id: 'vm-01',
    name: 'primary',
    status: 'running',
    platform: 'anthropic',
    family: 'claude',
    inference_engine: 'rust',
    persona_preset: 'official_full',
    schedulable: true,
    schedule_disabled_reason: null,
    email: 'owner@example.com',
    account_uuid: 'account-secret',
    org_uuid: 'org-secret',
    proxy: { id: 'px-1', url: 'socks5://secret' },
    fingerprint: { device_id: 'device-secret' },
    runtime: { container: 'kin-01', ip: '10.0.0.2', pid: 42 },
    ip: '10.0.0.2',
    pid: 42,
    container: 'kin-01',
  })
  assert.deepEqual(view, {
    id: 'vm-01',
    name: 'primary',
    status: 'running',
    platform: 'anthropic',
    family: 'claude',
    inference_engine: 'rust',
    persona_preset: 'official_full',
    schedulable: true,
    schedule_disabled_reason: null,
    runtime_type: 'docker',
    machine: null,
  })
  assert.doesNotMatch(JSON.stringify(view), /owner@example|secret|kin-01|10\.0\.0\.2/)
})
