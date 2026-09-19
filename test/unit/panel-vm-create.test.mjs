import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

function makeCreateHandler(project, body) {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project } },
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
    proxyPool: {
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
    assert.equal(vm.proxy_cli_enabled, false)
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`), 'utf8'))
    assert.equal(saved.seed_policy.telemetry_disabled, false)
    assert.equal(saved.proxy_required, false)
    assert.equal(saved.proxy, null)
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
    assert.equal(vm.timezone, 'Asia/Tokyo')
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${vm.id}.json`), 'utf8'))
    assert.equal(saved.timezone, 'Asia/Tokyo')
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
