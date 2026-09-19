import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDashboard, buildVmDetail, buildVmList, summarizeProxyPool } from '../../src/lib/admin/panel-api.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'

function tmpDir(prefix = 'kin-panel-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function fakeQuota() {
  return {
    config: { safety_ratio: 0.95 },
    snapshot: () => ({ accounts: [], safety_ratio: 0.95 }),
  }
}

function writeVm(project, rec) {
  const dir = path.join(project, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2))
}

test('summarizeProxyPool includes disconnect_on_error', () => {
  assert.deepEqual(summarizeProxyPool(null), {
    total: 0,
    free: 0,
    bound: 0,
    ok: 0,
    dead: 0,
    probing: false,
    disconnect_on_error: false,
  })
  const dir = tmpDir()
  const pool = new ProxyPool({ dataDir: dir })
  pool.importLines('10.0.0.9:1080')
  pool.updateConfig({ disconnect_on_error: true })
  pool.stopScheduler()
  const sum = summarizeProxyPool(pool)
  assert.equal(sum.total, 1)
  assert.equal(sum.free, 1)
  assert.equal(sum.disconnect_on_error, true)
})

test('dashboard and vm detail merge pool health onto bound VM', async () => {
  const project = tmpDir()
  const dataDir = path.join(project, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  writeVm(project, {
    id: 'vm-02',
    name: '02',
    status: 'stopped',
    proxy_cli_enabled: true,
    proxy: { id: 'px-will-replace', host: '10.9.9.9', port: 1080, scheme: 'socks5', url: 'socks5://10.9.9.9:1080' },
    claude: {},
    policy: { maxConcurrency: 4, weight: 1, priority: 8 },
  })
  const pool = new ProxyPool({ dataDir })
  pool.importLines('10.8.8.8:1080')
  const px = pool.snapshot().proxies[0]
  pool.bind(px.id, 'vm-02')
  const bound = pool.state.proxies[0]
  bound.status = 'ok'
  bound.latency_ms = 12
  bound.last_probe_at = '2026-01-01T00:00:00Z'
  bound.geo_ip = '203.0.113.9'
  bound.geo_country = 'Japan'
  bound.geo_country_code = 'JP'
  bound.geo_city = 'Shinjuku'
  bound.geo_timezone = 'Asia/Tokyo'
  bound.geo_checked_at = '2026-01-01T00:00:00Z'
  pool.save()
  pool.stopScheduler()

  const cfg = { paths: { project }, rewrite: { enabled: false }, base_url: 'http://127.0.0.1' }
  const quota = fakeQuota()
  const dash = await buildDashboard({
    cfg,
    accountQuota: quota,
    stickyRouter: { stats: () => ({ active_sessions: 0 }) },
    routingConfig: { sticky: { enabled: true }, quota: { safety_ratio: 0.95 } },
    stats: {},
    proxyPool: pool,
  })
  assert.equal(dash.ok, true)
  assert.equal(dash.data.proxy_pool.total, 1)
  assert.equal(dash.data.proxy_pool.bound, 1)
  const vm = dash.data.vms.find((item) => item.id === 'vm-02')
  assert.equal(vm.proxy_configured, true)
  assert.equal(vm.can_import_credential, true)
  assert.equal(vm.proxy.status, 'ok')
  assert.equal(vm.proxy.latency_ms, 12)
  assert.equal(vm.proxy.host, '10.8.8.8')
  assert.equal(vm.proxy.geo.timezone, 'Asia/Tokyo')
  assert.equal(vm.proxy.geo.country_code, 'JP')
  assert.equal(vm.proxy.url, undefined)
  const listed = await buildVmList({ cfg, accountQuota: quota, routingConfig: {}, proxyPool: pool })
  const listedVm = listed.data.items.find((item) => item.id === 'vm-02')
  assert.equal(listedVm.schedule_level, 8)
  assert.equal(listedVm.schedule_level_mode, 'manual')

  const detail = await buildVmDetail({ cfg, accountQuota: quota, id: 'vm-02', proxyPool: pool })
  assert.equal(detail.ok, true)
  assert.equal(detail.data.vm.proxy_configured, true)
  assert.equal(detail.data.vm.schedule_level, listedVm.schedule_level)
  assert.equal(detail.data.vm.schedule_level_mode, listedVm.schedule_level_mode)
  assert.equal(detail.data.proxy.status, 'ok')
  assert.equal(detail.data.proxy.geo.timezone, 'Asia/Tokyo')
  assert.equal(detail.data.proxy_pool.bound, 1)
})

test('dead bound proxy blocks credential import', async () => {
  const project = tmpDir()
  const dataDir = path.join(project, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  writeVm(project, {
    id: 'vm-03',
    name: '03',
    status: 'stopped',
    proxy: { id: 'px-dead', host: '10.7.7.7', port: 1080, url: 'socks5://10.7.7.7:1080' },
    claude: {},
    policy: {},
  })
  const pool = new ProxyPool({ dataDir })
  pool.importLines('10.7.7.7:1080')
  const id = pool.snapshot().proxies[0].id
  pool.bind(id, 'vm-03')
  pool.setEnabled(id, false)
  pool.stopScheduler()
  const cfg = { paths: { project }, rewrite: {}, base_url: '' }
  const detail = await buildVmDetail({ cfg, accountQuota: fakeQuota(), id: 'vm-03', proxyPool: pool })
  assert.equal(detail.data.vm.proxy_configured, true)
  assert.equal(detail.data.vm.can_import_credential, false)
  assert.equal(detail.data.vm.proxy.status, 'dead')
})

test('vm detail exposes Go credential ownership and Rust kernel health', async () => {
  const project = tmpDir()
  writeVm(project, {
    id: 'vm-rust',
    name: 'Rust slot',
    status: 'running',
    inference_engine: 'rust',
    claude: {},
    policy: {},
  })
  let healthCalls = 0
  const detail = await buildVmDetail({
    cfg: { paths: { project }, rewrite: {}, base_url: '' },
    accountQuota: fakeQuota(),
    id: 'vm-rust',
    routingConfig: { inference: { engine: 'go' } },
    kernelHealth: async ({ id }) => {
      healthCalls += 1
      assert.equal(id, 'vm-rust')
      return {
        go: { reachable: true, status: 200, worker_version: 'go-1.0.0' },
        rust: { reachable: true, status: 200, worker_version: 'rust-0.1.0' },
      }
    },
  })

  assert.equal(healthCalls, 1)
  assert.deepEqual(detail.data.kernel, {
    credential_owner: 'go',
    configured_engine: 'rust',
    resolved_engine: 'rust',
    active_engine: 'rust',
    go_health: { reachable: true, status: 200, worker_version: 'go-1.0.0' },
    rust_health: { reachable: true, status: 200, worker_version: 'rust-0.1.0' },
  })
})

test('GPT vm detail exposes codex_health and hides Claude kernel/official_cc', async () => {
  const project = tmpDir()
  writeVm(project, {
    id: 'vm-gpt',
    name: 'GPT slot',
    status: 'running',
    platform: 'openai',
    family: 'codex',
    claude: {},
    policy: {},
  })
  const detail = await buildVmDetail({
    cfg: { paths: { project }, rewrite: {}, base_url: '' },
    accountQuota: fakeQuota(),
    id: 'vm-gpt',
    routingConfig: { inference: { engine: 'rust' } },
    kernelHealth: async ({ id }) => {
      assert.equal(id, 'vm-gpt')
      return {
        codex: {
          reachable: true,
          worker_version: '0.1.0',
          engine: 'codex',
          proxy_ok: true,
          accounts: 1,
          vm_id: 'vm-gpt',
        },
      }
    },
  })
  assert.equal(detail.ok, true)
  assert.equal(detail.data.official_cc, null)
  assert.deepEqual(detail.data.kernel, {
    credential_owner: 'codex',
    configured_engine: null,
    resolved_engine: null,
    active_engine: null,
    go_health: null,
    rust_health: null,
    codex_health: {
      reachable: true,
      worker_version: '0.1.0',
      engine: 'codex',
      proxy_ok: true,
      accounts: 1,
      vm_id: 'vm-gpt',
    },
  })
})
