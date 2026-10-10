import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'

function makeCreateHandler(project, body, proxyPool, accountQuota, extra = {}) {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project } },
    ...(accountQuota ? { accountQuota } : {}),
    ...(extra.routingConfig ? { routingConfig: extra.routingConfig } : {}),
    ...(extra.probeLocalKvm ? { probeLocalKvm: extra.probeLocalKvm } : {}),
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => body,
    proxyPool: proxyPool || {
      allocateForVm() {
        throw new Error('no healthy SOCKS5')
      },
      getProxyForVm() {
        return null
      },
    },
  })
  return { handlePanel, response }
}

test('import-style create succeeds without seed_policy or SOCKS5', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-create-'))
  try {
    const { handlePanel, response } = makeCreateHandler(root, {
      name: 'import-slot',
      start: false,
      auto_allocate_proxy: false,
    })
    const handled = await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(handled, true)
    assert.equal(response.status, 200, response.body?.error?.message || JSON.stringify(response.body))
    assert.equal(response.body?.ok, true)
    const vm = response.body?.data?.vm
    assert.ok(vm?.id, 'created vm id')
    assert.equal(vm.status, 'stopped')
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`), 'utf8'))
    assert.equal(saved.seed_policy.telemetry_disabled, false)
    assert.equal(saved.proxy_required, false)
    assert.equal(saved.proxy, null)
    assert.equal(saved.timezone, null)
    assert.equal(saved.timezone_source, 'auto')
    assert.equal(saved.fingerprint.timezone, '')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('create preserves Tokyo in the slot, fingerprint and settings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-create-tokyo-'))
  try {
    const { handlePanel, response } = makeCreateHandler(root, {
      name: 'tokyo-slot',
      timezone: ' asia/tokyo ',
      start: false,
      auto_allocate_proxy: false,
    })
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(response.status, 200, response.body?.error?.message || JSON.stringify(response.body))
    const id = response.body?.data?.vm?.id
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8'))
    assert.equal(saved.timezone, 'Asia/Tokyo')
    assert.equal(saved.fingerprint.timezone, 'Asia/Tokyo')
    assert.equal(saved.locale, 'en_US.UTF-8')
    const settings = JSON.parse(
      fs.readFileSync(path.join(root, 'vms', id, 'cli-home', '.claude', 'settings.json'), 'utf8'),
    )
    assert.equal(settings.env.TZ, 'Asia/Tokyo')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('create does not 409 when proxy allocation fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-create-proxy-'))
  try {
    const { handlePanel, response } = makeCreateHandler(root, {
      name: 'no-proxy',
      start: true,
      auto_allocate_proxy: true,
    })
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.notEqual(response.status, 409)
    assert.equal(response.status, 200, response.body?.error?.message || JSON.stringify(response.body))
    assert.equal(response.body?.data?.vm?.status, 'stopped')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('create preserves Tokyo timezone in the VM, fingerprint, and CLI seed files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-create-tokyo-'))
  try {
    const { handlePanel, response } = makeCreateHandler(root, {
      name: 'tokyo-slot',
      timezone: 'Asia/Tokyo',
      start: false,
      auto_allocate_proxy: false,
    })
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(response.status, 200, response.body?.error?.message || JSON.stringify(response.body))
    const vm = response.body?.data?.vm
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`), 'utf8'))
    assert.equal(saved.timezone, 'Asia/Tokyo')
    assert.equal(saved.timezone_source, 'manual')
    assert.equal(saved.fingerprint.timezone, 'Asia/Tokyo')
    assert.equal(saved.locale, 'en_US.UTF-8')
    const claudeDir = path.join(root, 'vms', vm.id, 'cli-home', '.claude')
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'))
    const seed = JSON.parse(fs.readFileSync(path.join(claudeDir, 'kin-seed.json'), 'utf8'))
    assert.equal(settings.env.TZ, 'Asia/Tokyo')
    assert.equal(seed.timezone, 'Asia/Tokyo')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('create returns the persisted VM when runtime start fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-create-boot-'))
  const proxy = {
    id: 'px-boot',
    host: '127.0.0.1',
    port: 1080,
    url: 'socks5://127.0.0.1:1080',
  }
  const prevPath = process.env.PATH
  process.env.PATH = '/var/empty'
  try {
    const { handlePanel, response } = makeCreateHandler(
      root,
      { name: 'boot-fail', start: true, auto_allocate_proxy: true },
      {
        allocateForVm() {
          return proxy
        },
        getProxyForVm() {
          return proxy
        },
        // A new slot without a requested zone takes its exit's.
        proxyTimezone() {
          return 'Europe/Berlin'
        },
      },
    )
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(response.status, 200, response.body?.error?.message || JSON.stringify(response.body))
    assert.equal(response.body?.ok, true)
    const vm = response.body?.data?.vm
    assert.ok(vm?.id)
    assert.equal(vm.status, 'error')
    assert.equal(typeof response.body?.data?.start_error, 'string')
    assert.ok(response.body.data.start_error)
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`), 'utf8'))
    assert.equal(saved.status, 'error')
    assert.ok(saved.schedule_disabled_reason)
    assert.equal(saved.timezone, 'Europe/Berlin')
    assert.equal(saved.timezone_source, 'proxy_geo')
  } finally {
    process.env.PATH = prevPath
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('auto-numbering skips ids a deleted VM left behind in account history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-create-history-'))
  try {
    fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
    fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify({ id: 'vm-01', name: '01' }))
    // vm-02 was deleted; its account row (with email and spend) still carries vm_id 'vm-02'.
    const accountQuota = { snapshot: () => ({ accounts: [{ account_id: 'uuid-old', vm_id: 'vm-02' }] }) }
    const { handlePanel, response } = makeCreateHandler(
      root,
      { start: false, auto_allocate_proxy: false },
      undefined,
      accountQuota,
    )
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(response.status, 200, response.body?.error?.message || JSON.stringify(response.body))
    assert.equal(response.body?.data?.vm?.id, 'vm-03', 'a fresh slot must not inherit vm-02 history')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('create binds an explicitly chosen exit instead of auto-allocating', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-create-exit-'))
  const pool = new ProxyPool({ dataDir: root, geoLookup: async () => ({ ok: false, error: 'offline' }) })
  pool.stopScheduler()
  try {
    const socks = pool.importLines('1.2.3.4:1080').items[0].id
    const local = pool.ensureLocal().proxy.id
    const { handlePanel, response } = makeCreateHandler(root, { start: false, proxy_id: local }, pool)
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(response.status, 200, response.body?.error?.message || JSON.stringify(response.body))
    const id = response.body?.data?.vm?.id
    assert.equal(pool.getProxyForVm(id)?.id, local)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8')).proxy.id, local)
    assert.deepEqual(
      pool.snapshot().proxies.find((p) => p.id === socks).bound_vm_ids,
      [],
      'the healthier SOCKS row must stay free',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('create stamps docker machine from routing defaults', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-create-machine-'))
  try {
    const { handlePanel, response } = makeCreateHandler(root, {
      name: 'docker-slot',
      start: false,
      auto_allocate_proxy: false,
    })
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(response.status, 200, response.body?.error?.message || JSON.stringify(response.body))
    const id = response.body?.data?.vm?.id
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8'))
    assert.equal(saved.runtime.type, 'docker')
    assert.equal(saved.machine.memory, '512m')
    assert.equal(saved.machine.vcpus, 2)
    assert.equal(response.body.data.vm.runtime_type, 'docker')
    assert.equal(response.body.data.vm.machine.memory, '512m')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('create refuses an unknown or full exit before writing the slot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-create-exit-bad-'))
  const pool = new ProxyPool({ dataDir: root, geoLookup: async () => ({ ok: false, error: 'offline' }) })
  pool.stopScheduler()
  try {
    const missing = makeCreateHandler(root, { id: 'vm-x', start: false, proxy_id: 'px-nope' }, pool)
    await missing.handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(missing.response.status, 404)

    const local = pool.ensureLocal().proxy.id
    pool.updateConfig({ bind_limit: 1 })
    pool.stopScheduler()
    pool.bind(local, 'vm-other')
    const full = makeCreateHandler(root, { id: 'vm-x', start: false, proxy_id: local }, pool)
    await full.handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(full.response.status, 409)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-x.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('create kvm returns 409 when local probe is unavailable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-create-kvm-denied-'))
  try {
    const { handlePanel, response } = makeCreateHandler(
      root,
      { name: 'kvm-slot', runtime_type: 'kvm', start: false, auto_allocate_proxy: false },
      undefined,
      undefined,
      { probeLocalKvm: async () => ({ ok: false, accel: null, error: '本机没有可用的 /dev/kvm' }) },
    )
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(response.status, 409)
    assert.equal(response.body?.error?.code, 'kvm_unavailable')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('create kvm persists runtime and machine when probe succeeds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-create-kvm-ok-'))
  try {
    const { handlePanel, response } = makeCreateHandler(
      root,
      {
        name: 'kvm-slot',
        runtime_type: 'kvm',
        start: false,
        auto_allocate_proxy: false,
        machine: { memory: '4g', vcpus: 4, disk_gb: 40 },
      },
      undefined,
      undefined,
      { probeLocalKvm: async () => ({ ok: true, accel: 'tcg', error: null }) },
    )
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(response.status, 200, response.body?.error?.message || JSON.stringify(response.body))
    const id = response.body?.data?.vm?.id
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8'))
    assert.equal(saved.runtime.type, 'kvm')
    assert.equal(saved.machine.memory, '4g')
    assert.equal(saved.machine.vcpus, 4)
    assert.equal(saved.machine.disk_gb, 40)
    assert.match(saved.machine.mac, /^52:54:00:/)
    assert.ok(saved.machine.smbios.uuid)
    assert.equal(response.body.data.vm.runtime_type, 'kvm')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('create rejects an invalid machine override with 400', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-create-machine-bad-'))
  try {
    const { handlePanel, response } = makeCreateHandler(root, {
      start: false,
      auto_allocate_proxy: false,
      machine: { memory: '3g' },
    })
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(response.status, 400)
    assert.equal(response.body?.error?.code, 'invalid_machine')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('create writes the requested locale into the slot and its fingerprint', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-create-locale-'))
  try {
    const { handlePanel, response } = makeCreateHandler(root, {
      start: false,
      auto_allocate_proxy: false,
      locale: 'ja_JP.UTF-8',
    })
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(response.status, 200, response.body?.error?.message || JSON.stringify(response.body))
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${response.body.data.vm.id}.json`), 'utf8'))
    assert.equal(saved.locale, 'ja_JP.UTF-8')
    assert.equal(saved.fingerprint.locale, 'ja_JP.UTF-8')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('create rejects an unknown locale before writing the slot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-create-locale-bad-'))
  try {
    const { handlePanel, response } = makeCreateHandler(root, { id: 'vm-x', start: false, locale: 'xx_YY' })
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(response.status, 400)
    assert.equal(response.body?.error?.code, 'invalid_locale')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-x.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('GET /vms/create-options is available to a tenant user', async () => {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: os.tmpdir() } },
    routingConfig: { vm: { memory: '4g', default_runtime: 'kvm', allow_tcg: true } },
    probeLocalKvm: async () => ({ ok: true, accel: 'tcg', error: null }),
    requireAuth(req) {
      req.panelUser = 'tenant'
      req.apiKeyKind = 'session'
      req.panelRole = 'user'
      req.panelUserId = 'u-1'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => ({}),
  })
  const handled = await handlePanel({ method: 'GET' }, {}, new URL('http://localhost/api/panel/vms/create-options'))
  assert.equal(handled, true)
  assert.equal(response.status, 200, response.body?.error?.message || JSON.stringify(response.body))
  assert.equal(response.body?.ok, true)
  assert.equal(response.body.data.vm.memory, '4g')
  assert.equal(response.body.data.vm.default_runtime, 'kvm')
  assert.deepEqual(response.body.data.kvm, { ok: true, accel: 'tcg', error: null })
})
