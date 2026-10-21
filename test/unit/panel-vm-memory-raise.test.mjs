import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { raiseDockerSlotMemory } from '../../src/lib/vm/docker-slot-memory.mjs'

function tmpProject(id, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-mem-'))
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      status: 'running',
      machine: { memory: '512m' },
      runtime: { type: 'docker', memory: '512m' },
      ...extra,
    }),
  )
  return root
}

function handler(project, body, extra = {}) {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project } },
    routingConfig: { vm: { memory: '512m' } },
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
    proxyPool: { unbindVm() {} },
    accountQuota: { snapshot: () => ({ accounts: [] }) },
    ...extra,
  })
  return { handlePanel, response }
}

const patchVm = (handlePanel, id = 'vm-01') =>
  handlePanel({ method: 'PATCH' }, {}, new URL(`http://localhost/api/panel/vms/${id}`))

function mockExec() {
  return (argv) => {
    if (argv.includes('update')) return { ok: true, stdout: '', stderr: '' }
    if (argv.includes('inspect')) return { ok: true, stdout: `${1024 ** 3} ${1024 ** 3} true`, stderr: '' }
    if (argv.includes('exec')) return { ok: true, stdout: String(1024 ** 3), stderr: '' }
    return { ok: false, stderr: 'unexpected' }
  }
}

test('PATCH vm memory raises docker limit and returns memory_raise payload', async () => {
  const root = tmpProject('vm-01')
  try {
    const execImpl = mockExec()
    const { handlePanel, response } = handler(
      root,
      { machine: { memory: '1g' } },
      {
        raiseDockerSlotMemory: (projectRoot, vm, memory, opts) =>
          raiseDockerSlotMemory(projectRoot, vm, memory, { ...opts, execImpl }),
      },
    )
    await patchVm(handlePanel)
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 500))
    assert.equal(response.body?.data?.memory_raise?.memory, '1g')
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-01.json'), 'utf8'))
    assert.equal(saved.machine.memory, '1g')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PATCH vm memory rejects kvm slots', async () => {
  const root = tmpProject('vm-kvm', { runtime_type: 'kvm', runtime: { type: 'kvm', memory: '512m' } })
  try {
    const { handlePanel, response } = handler(root, { memory: '1g' })
    await patchVm(handlePanel, 'vm-kvm')
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'kvm_memory_raise_forbidden')
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-kvm.json'), 'utf8'))
    assert.equal(saved.machine.memory, '512m')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PATCH vm memory rejects invalid values without persisting', async () => {
  const root = tmpProject('vm-03')
  try {
    const { handlePanel, response } = handler(root, { memory: '3g' })
    await patchVm(handlePanel, 'vm-03')
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'invalid_memory')
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-03.json'), 'utf8'))
    assert.equal(saved.machine.memory, '512m')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('standalone memory errors preserve the original failure without a database fixture', async () => {
  const root = tmpProject('memory-error')
  const failure = new Error('synthetic memory failure')
  try {
    const { handlePanel } = handler(root, { memory: '1g' }, {
      raiseDockerSlotMemory: () => { throw failure },
    })
    await assert.rejects(patchVm(handlePanel, 'memory-error'), (error) => error === failure)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
