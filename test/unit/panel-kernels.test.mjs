import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'
import { getVm } from '../../src/lib/vm/vm-registry.mjs'
import { cragLicenseDirectory } from '../../src/lib/vm/crag-license.mjs'
import { activateFixture, seedEncryptedPackage } from '../fixtures/crag-license.mjs'

const env = Object.fromEntries(
  ['KIN_SLOT_RUN_ROOT', 'KIN_CRAG_V2_ROOT', 'KIN_WRAP_CLI_ROOT', 'KIN_KERNEL_BIN'].map((key) => [
    key,
    process.env[key],
  ]),
)
before(() => {
  for (const key of Object.keys(env)) delete process.env[key]
})
after(() => {
  for (const [key, value] of Object.entries(env)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
})
function elf(payload) {
  const bytes = Buffer.alloc(96 + payload.length)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  bytes.writeUInt16LE(3, 16)
  bytes.writeUInt16LE(62, 18)
  bytes.writeUInt32LE(1, 20)
  bytes.write(payload, 96)
  return bytes
}
function writable(root) {
  if (!fs.existsSync(root)) return
  fs.chmodSync(root, 0o755)
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) writable(path.join(root, entry.name))
  }
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-kernels-'))
  t.after(() => {
    writable(root)
    fs.rmSync(root, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const vms = [
    { id: 'vm-13', status: 'running', dataplane: 'wrap', owner_user_id: 'owner-a' },
    { id: 'vm-14', status: 'running', dataplane: 'wrap', owner_user_id: 'owner-b' },
    { id: 'vm-gpt', status: 'running', platform: 'openai', family: 'codex', codex_kernel: true },
  ]
  for (const vm of vms) fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  const cli = path.join(root, 'share', 'wrap-cli')
  fs.mkdirSync(cli, { recursive: true })
  fs.writeFileSync(path.join(cli, 'kin-kernel.bin'), elf('cached-kernel'), { mode: 0o755 })
  fs.writeFileSync(path.join(cli, 'cli-node'), elf('cached-cli'), { mode: 0o755 })
  seedEncryptedPackage(root)
  return { root, vms }
}
async function route(root, method, endpoint, body, options = {}) {
  const response = {}
  const handle = createPanelHandler({
    cfg: { paths: { project: root } },
    routingConfig: {},
    requireAuth(req) {
      req.panelUser = 'fixture'
      req.panelRole = options.role || 'admin'
      req.panelUserId = 'owner-a'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => body,
    ...options.ctx,
  })
  await handle({ method }, {}, new URL(`http://localhost/api/panel/kernels${endpoint}`))
  return response
}

test('catalog has exactly two public products and lists licenses without initializing any identity', async (t) => {
  const { root, vms } = fixture(t)
  const records = vms.map((vm) => fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`)))
  const response = await route(root, 'GET', '')
  assert.equal(response.status, 200)
  assert.deepEqual(
    response.body.data.kernels.map((item) => item.id),
    ['cli-node', 'crag'],
  )
  assert.equal(response.body.data.kernels[0].paid, false)
  assert.equal(response.body.data.kernels[1].paid, true)
  assert.deepEqual(Object.keys(response.body.data.licenses).sort(), ['vm-13', 'vm-14'])
  assert.equal(response.body.data.licenses['vm-13'].valid, false)
  assert.doesNotMatch(
    JSON.stringify(response.body),
    /machine_code|device_public_key|private_key|registration\.code|wrapped_key|ciphertext|\/tmp\//,
  )
  for (const [index, vm] of vms.entries()) {
    assert.equal(fs.existsSync(path.join(root, 'vms', vm.id)), false)
    assert.deepEqual(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`)), records[index])
  }
})

test('catalog exposes authenticated license status and installed metadata but no registration material', async (t) => {
  const { root, vms } = fixture(t)
  const active = activateFixture(root, vms[0])
  const file = path.join(root, 'vms', 'vm-13.json')
  const vm = getVm(root, 'vm-13')
  vm.kernel_installation = { kernel: 'crag', version: 'v2', installed_at: '2026-11-01T00:00:00.000Z' }
  fs.writeFileSync(file, JSON.stringify(vm))
  const deviceFile = path.join(cragLicenseDirectory(root, vm), 'device.json')
  const before = fs.readFileSync(deviceFile)
  const response = await route(root, 'GET', '')
  assert.equal(response.body.data.licenses['vm-13'].valid, true)
  assert.equal(response.body.data.licenses['vm-13'].expires_at, active.license.expires_at)
  assert.deepEqual(response.body.data.installations['vm-13'], vm.kernel_installation)
  assert.doesNotMatch(
    JSON.stringify(response.body),
    /CRAGM1|CRAGL1|machine_code|device_public_key|private_key|wrapped_key|payload_key/,
  )
  assert.deepEqual(fs.readFileSync(deviceFile), before)
  assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-14')), false)
})

for (const role of ['user', 'super']) {
  for (const [method, endpoint] of [
    ['GET', ''],
    ['POST', '/pull'],
    ['POST', '/install'],
  ]) {
    test(`${role} cannot access kernel ${method} ${endpoint || 'inventory'}`, async (t) => {
      const { root } = fixture(t)
      const response = await route(
        root,
        method,
        endpoint,
        { kernel: 'cli-node', targets: [{ id: 'vm-14', kernel: 'cli-node' }] },
        {
          role,
          ctx: {
            readBody() {
              assert.fail('authorization must precede body parsing')
            },
            fetchImpl() {
              assert.fail('no download')
            },
            kernelInstallOps: {
              stopSlot() {
                assert.fail('no stop')
              },
            },
          },
        },
      )
      assert.equal(response.status, 403)
      assert.equal(authorizePanelRoute(method, `/api/panel/kernels${endpoint}`, role).ok, false)
    })
  }
}

for (const body of [
  {},
  { targets: [] },
  { targets: [{ id: '', kernel: 'cli-node' }] },
  {
    targets: [
      { id: 'vm-13', kernel: 'cli-node' },
      { id: 'vm-13', kernel: 'crag' },
    ],
  },
  {
    targets: [
      { id: 'vm-13', kernel: 'cli-node' },
      { id: 'missing', kernel: 'crag' },
    ],
  },
]) {
  test(`route rejects invalid complete scope before stop: ${JSON.stringify(body)}`, async (t) => {
    const { root, vms } = fixture(t)
    const records = vms.map((vm) => fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`)))
    const response = await route(root, 'POST', '/install', body, {
      ctx: {
        kernelInstallOps: {
          stopSlot() {
            assert.fail('no partial scope stop')
          },
        },
      },
    })
    assert.ok([400, 404].includes(response.status))
    assert.equal(response.body.ok, false)
    for (const [index, vm] of vms.entries())
      assert.deepEqual(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`)), records[index])
  })
}

test('install route changes only explicit Claude target, returns partial outcomes, and never activates paid identity', async (t) => {
  const { root } = fixture(t)
  const untouched = fs.readFileSync(path.join(root, 'vms', 'vm-gpt.json'))
  const stopped = []
  const response = await route(
    root,
    'POST',
    '/install',
    {
      targets: [
        { id: 'vm-13', kernel: 'cli-node' },
        { id: 'vm-14', kernel: 'crag' },
      ],
    },
    {
      ctx: {
        kernelInstallOps: {
          stopSlot(vm) {
            stopped.push(vm.id)
            return { ok: true }
          },
          suspendVmRuntimeRestart() {
            return { ok: true }
          },
        },
      },
    },
  )
  assert.equal(response.status, 200)
  const report = response.body.data
  assert.equal(report.total, 2)
  assert.equal(report.ok_count, 1)
  assert.equal(report.failed_count, 1)
  assert.equal(report.ok, false)
  assert.deepEqual(stopped, ['vm-13'])
  assert.equal(report.items[0].stopped, true)
  assert.equal(report.items[1].stopped, false)
  assert.equal(report.items[1].code, 'license_unconfigured')
  assert.equal(getVm(root, 'vm-13').status, 'stopped')
  assert.equal(getVm(root, 'vm-14').status, 'running')
  assert.equal(fs.existsSync(cragLicenseDirectory(root, { id: 'vm-14' })), false)
  assert.deepEqual(fs.readFileSync(path.join(root, 'vms', 'vm-gpt.json')), untouched)
})

function releaseFetch() {
  const payloads = { 1: elf('pulled-kernel'), 2: elf('pulled-cli') }
  return async (url) => {
    const href = String(url)
    if (href.endsWith('/releases/latest'))
      return new Response(
        JSON.stringify({
          tag_name: 'v1.2.3',
          assets: [
            {
              name: 'kin-kernel',
              size: payloads['1'].length,
              url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/1',
            },
            {
              name: 'cli-node',
              size: payloads['2'].length,
              url: 'https://api.github.com/repos/dofastted/vm2api/releases/assets/2',
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    const payload = payloads[href.split('/').pop()]
    assert.ok(payload, `unexpected request: ${href}`)
    return new Response(payload, { headers: { 'content-length': String(payload.length) } })
  }
}

test('pull route updates cache only and returns actionable paid asset failure without fallback', async (t) => {
  const { root, vms } = fixture(t)
  const records = vms.map((vm) => fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`)))
  const options = {
    ctx: {
      fetchImpl: releaseFetch(),
      kernelInstallOps: {
        stopSlot() {
          assert.fail('pull cannot stop VMs')
        },
      },
    },
  }
  const pulled = await route(root, 'POST', '/pull', { kernel: 'cli-node' }, options)
  assert.equal(pulled.status, 200, JSON.stringify(pulled.body))
  assert.equal(pulled.body.data.kernel.id, 'cli-node')
  assert.equal(pulled.body.data.kernel.version, '1.2.3')
  assert.equal(pulled.body.data.release.tag, 'v1.2.3')
  const paid = await route(root, 'POST', '/pull', { kernel: 'crag' }, options)
  assert.notEqual(paid.status, 200)
  assert.match(paid.body.error.code, /crag.*asset.*missing/)
  const inventory = await route(root, 'GET', '')
  assert.equal(inventory.body.data.kernels[1].ready, true, 'missing paid release must preserve local signed package')
  for (const [index, vm] of vms.entries()) {
    assert.deepEqual(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`)), records[index])
    assert.equal(fs.existsSync(path.join(root, 'vms', vm.id)), false)
  }
})
