import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { parseVmDisplayName, VM_DISPLAY_NAME_MAX } from '../../src/lib/vm/vm-registry.mjs'

function seed(root, id, extra = {}) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  const vm = {
    id,
    name: '01',
    status: 'stopped',
    schedulable: false,
    policy: { maxConcurrency: 2 },
    ...extra,
  }
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(vm))
  return vm
}

function handler(project, body) {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project }, vm: { id: null } },
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
  })
  return { handlePanel, response }
}

test('parseVmDisplayName trims and keeps a distinct label', () => {
  assert.deepEqual(parseVmDisplayName('  测试槽  '), { ok: true, value: '测试槽' })
  assert.equal(parseVmDisplayName('').ok, false)
  assert.equal(parseVmDisplayName('   ').ok, false)
  assert.equal(parseVmDisplayName(12).ok, false)
  assert.equal(parseVmDisplayName('a\nb').ok, false)
  assert.equal(parseVmDisplayName('x'.repeat(VM_DISPLAY_NAME_MAX + 1)).ok, false)
  assert.equal(parseVmDisplayName('测'.repeat(VM_DISPLAY_NAME_MAX)).ok, true)
})

test('PATCH name updates the display label and keeps the creation id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-name-'))
  try {
    seed(root, 'vm-01', { kernel: 'ubuntu-24.04' })
    const { handlePanel, response } = handler(root, { name: '  测试槽  ' })
    await handlePanel({ method: 'PATCH' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 500))
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-01.json'), 'utf8'))
    assert.equal(saved.id, 'vm-01')
    assert.equal(saved.name, '测试槽')
    assert.equal(saved.status, 'stopped')
    assert.equal(saved.kernel, 'ubuntu-24.04')
    assert.equal(response.body?.data?.vm?.id, 'vm-01')
    assert.equal(response.body?.data?.vm?.name, '测试槽')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-测试槽.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PATCH name rejects an empty label without writing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-name-'))
  try {
    const before = seed(root, 'vm-01')
    const file = path.join(root, 'vms', 'vm-01.json')
    const { handlePanel, response } = handler(root, { name: '   ' })
    await handlePanel({ method: 'PATCH' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'invalid_name')
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), before)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PATCH name that looks like another slot does not change the id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-name-'))
  try {
    seed(root, 'vm-01')
    const { handlePanel, response } = handler(root, { name: 'vm-09' })
    await handlePanel({ method: 'PATCH' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 500))
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-01.json'), 'utf8'))
    assert.equal(saved.id, 'vm-01')
    assert.equal(saved.name, 'vm-09')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
