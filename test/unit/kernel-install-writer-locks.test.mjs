import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { installKernelTargets } from '../../src/lib/vm/kernel-install.mjs'
import { getVm, patchVmRecord } from '../../src/lib/vm/vm-registry.mjs'

const saved = Object.fromEntries(
  ['KIN_KERNEL_BIN', 'KIN_WRAP_CLI_ROOT', 'KIN_CRAG_V2_ROOT', 'KIN_SLOT_RUN_ROOT', 'KIN_NATIVE_CLI_ROOT'].map((key) => [
    key,
    process.env[key],
  ]),
)
before(() => {
  for (const key of Object.keys(saved)) delete process.env[key]
})
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
})
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const turn = () => new Promise(setImmediate)
function elf(payload) {
  const bytes = Buffer.alloc(96 + payload.length)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  bytes.writeUInt16LE(3, 16)
  bytes.writeUInt16LE(62, 18)
  bytes.writeUInt32LE(1, 20)
  bytes.write(payload, 96)
  return bytes
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-writer-lock-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = {
    id: 'vm-13',
    status: 'running',
    dataplane: 'wrap',
    runtime: { type: 'docker' },
    policy: { maxConcurrency: 2 },
  }
  const dir = path.join(root, 'vms', vm.id, 'cli-home', '.kin')
  const cli = path.join(root, 'share', 'wrap-cli')
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(cli, { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  fs.writeFileSync(path.join(dir, 'kin-kernel.bin'), 'busy-old-kernel')
  for (const name of ['cli-node', 'cc-node', 'kin-kernel.bin'])
    fs.writeFileSync(path.join(cli, name), elf(`cached-${name}`), { mode: 0o755 })
  return { root, vm, dir, cli }
}
function beginInstall(root, id) {
  const stopping = deferred()
  const resume = deferred()
  const operation = installKernelTargets({
    projectRoot: root,
    targets: [{ id, kernel: 'cli-node' }],
    ops: {
      async stopSlot() {
        stopping.resolve()
        await resume.promise
        return { ok: true }
      },
      suspendVmRuntimeRestart: () => ({ ok: true }),
    },
  })
  return { stopping: stopping.promise, resume: resume.resolve, operation }
}
function beginRequest(root, method, endpoint, body, extra = {}) {
  const response = {}
  const read = deferred()
  let restarted = 0
  let settled = false
  const handle = createPanelHandler({
    cfg: { paths: { project: root }, vm: { id: null } },
    routingConfig: {},
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
    readBody: async () => {
      read.resolve()
      return body
    },
    proxyPool: { unbindVm() {} },
    applyVmConcurrency(id, value) {
      return patchVmRecord(root, id, (record) => ({ policy: { ...record.policy, maxConcurrency: value } }))
    },
    kernelPolicyOps: {
      async restartRustKernel() {
        restarted++
        return { ok: true }
      },
    },
    ...extra,
  })
  const operation = handle({ method }, {}, new URL(`http://localhost/api/panel${endpoint}`)).then(() => {
    settled = true
  })
  return { operation, read: read.promise, response, restarts: () => restarted, settled: () => settled }
}

for (const mode of ['PATCH', 'slot-policy']) {
  test(`${mode} waits for the installer record lock before metadata, materialization or restart`, async (t) => {
    const { root, vm, dir } = fixture(t)
    const record = fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`))
    const install = beginInstall(root, vm.id)
    await install.stopping
    const request =
      mode === 'PATCH'
        ? beginRequest(root, 'PATCH', `/vms/${vm.id}`, { dataplane: 'cc', persona_preset: 'zero', max_concurrency: 7 })
        : beginRequest(root, 'POST', '/vms/slot-policy', { ids: [vm.id], dataplane: 'cc', persona_preset: 'zero' })
    try {
      await request.read
      await turn()
      assert.equal(request.settled(), false)
      assert.deepEqual(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`)), record)
      assert.equal(fs.readFileSync(path.join(dir, 'kin-kernel.bin'), 'utf8'), 'busy-old-kernel')
      assert.equal(fs.existsSync(path.join(root, 'vms', vm.id, 'run', 'kernel.json')), false)
      assert.equal(request.restarts(), 0)
    } finally {
      install.resume()
    }
    const installed = await install.operation
    await request.operation
    assert.equal(installed.ok, true, JSON.stringify(installed))
    assert.equal(request.response.status, 200, JSON.stringify(request.response.body))
    assert.equal(getVm(root, vm.id).status, 'stopped')
    assert.equal(getVm(root, vm.id).dataplane, 'cc')
    if (mode === 'PATCH') assert.equal(getVm(root, vm.id).policy.maxConcurrency, 7)
    const config = JSON.parse(fs.readFileSync(path.join(root, 'vms', vm.id, 'run', 'kernel.json')))
    assert.equal(config.dataplane, 'cc')
    assert.equal(config.persona_preset, 'zero')
    assert.equal(request.restarts(), 0, 'queued policy observes the stopped record, not stale running intent')
  })
}

for (const checkOnly of [false, true]) {
  test(`legacy ${checkOnly ? 'read-only inspection' : 'sync'} cannot replace managed bytes during installer stop`, async (t) => {
    const { root, vm, dir, cli } = fixture(t)
    const install = beginInstall(root, vm.id)
    await install.stopping
    fs.writeFileSync(path.join(cli, 'kin-kernel.bin'), elf('new-release'))
    const request = beginRequest(root, 'POST', '/wrap-cli/sync', { restart: !checkOnly })
    try {
      await request.read
      await turn()
      assert.equal(request.settled(), false)
      assert.equal(fs.readFileSync(path.join(dir, 'kin-kernel.bin'), 'utf8'), 'busy-old-kernel')
      assert.equal(request.restarts(), 0)
      // All means the exact records visible when this operation was admitted.
      fs.writeFileSync(
        path.join(root, 'vms', 'vm-late.json'),
        JSON.stringify({ id: 'vm-late', status: 'stopped', dataplane: 'wrap' }),
      )
    } finally {
      install.resume()
    }
    const installed = await install.operation
    await request.operation
    assert.equal(installed.ok, true, JSON.stringify(installed))
    assert.equal(request.response.status, 200, JSON.stringify(request.response.body))
    assert.equal(request.response.body.data.total, 1)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-late', 'cli-home', '.kin')), false)
    assert.ok(fs.readFileSync(path.join(dir, 'kin-kernel.bin')).equals(elf('new-release')))
    assert.equal(request.restarts(), 0)
  })
}

test('explicit legacy dataplane selection defers metadata and sync together until installation finishes', async (t) => {
  const { root, vm, dir } = fixture(t)
  const record = fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`))
  const install = beginInstall(root, vm.id)
  await install.stopping
  const request = beginRequest(root, 'POST', '/dataplane', { ids: [vm.id], dataplane: 'cc', restart: false })
  try {
    await request.read
    await turn()
    assert.equal(request.settled(), false)
    assert.deepEqual(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`)), record)
    assert.equal(fs.readFileSync(path.join(dir, 'kin-kernel.bin'), 'utf8'), 'busy-old-kernel')
  } finally {
    install.resume()
  }
  const installed = await install.operation
  await request.operation
  assert.equal(installed.ok, true)
  assert.equal(request.response.status, 200, JSON.stringify(request.response.body))
  assert.equal(getVm(root, vm.id).dataplane, 'cc')
  assert.equal(getVm(root, vm.id).status, 'stopped')
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, 'vms', vm.id, 'run', 'kernel.json'))).dataplane,
    'wrap',
    'restart:false keeps legacy sync inspection-only even though explicit selection metadata changes',
  )
  assert.equal(request.restarts(), 0)
})
