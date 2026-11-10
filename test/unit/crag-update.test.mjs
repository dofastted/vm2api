import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { updateCrag, cragUpdateInventory, localPanelApi } from '../../scripts/update-crag.mjs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { seedEncryptedPackage } from '../fixtures/crag-license.mjs'
import { verifyCragV2Tree } from '../../src/lib/vm/wrap-cli-runtime.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-update-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'src/config'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src/config/routing.json'), JSON.stringify({ inference: { dataplane: 'wrap' } }))
  fs.mkdirSync(path.join(root, 'vms'))
  const vms = [
    { id: 'vm-live', dataplane: 'crag', crag_kernel_version: 'v2', status: 'running', schedulable: true },
    { id: 'vm-stop', dataplane: 'crag', crag_kernel_version: 'v2', status: 'stopped', schedulable: false },
    { id: 'vm-cache', dataplane: 'wrap', status: 'running' },
    { id: 'vm-paused', dataplane: 'wrap', status: 'paused', schedulable: false },
    { id: 'vm-node', dataplane: 'wrap', status: 'paused', node_id: 'node-one', schedulable: false },
    { id: 'vm-codex', platform: 'openai', status: 'running' },
  ]
  const pkg = seedEncryptedPackage(root, { revision: 'old' })
  for (const vm of vms) {
    fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
    const dir = path.join(root, 'vms', vm.id, 'cli-home/.kin')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'kin-kernel'), `wrapper:${vm.id}`)
    if (['vm-live', 'vm-stop', 'vm-cache'].includes(vm.id))
      fs.cpSync(pkg, path.join(dir, 'crag-v2'), { recursive: true })
  }
  seedEncryptedPackage(root, { revision: 'new' })
  const calls = []
  const health = async () => ({
    healthy: true,
    license_valid: true,
    runtime_variant: 'crag-v2',
    active_requests: 0,
    continuations: 0,
    queued: 0,
  })
  const api = async (endpoint, body) => {
    calls.push({ endpoint, body })
    if (endpoint.endsWith('/sync')) {
      assert.deepEqual(body.ids, ['vm-live', 'vm-stop'])
      if (body.restart) {
        // Model the managed materializer without creating device credentials.
        for (const id of body.ids) {
          const dest = path.join(root, 'vms', id, 'cli-home/.kin/crag-v2')
          fs.rmSync(dest, { recursive: true })
          fs.cpSync(pkg, dest, { recursive: true })
        }
      }
      return { ok: true, failed_count: 0, changed_count: 2 }
    }
    return { paused: 2, restored: 2, drained: true, inflight: 0 }
  }
  const pull = async () => ({ ok: true, release: { tag: 'v2.0.1' } })
  const coreHashes = async () => [JSON.parse(fs.readFileSync(path.join(pkg, 'manifest.json'))).payload.plaintext_sha256]
  return { root, vms, pkg, calls, health, api, pull, coreHashes }
}

test('CRAG update refreshes every existing copy and keeps wrappers, selections and stopped/paused intent', async (t) => {
  const f = fixture(t)
  const before = f.vms.map((vm) => fs.readFileSync(path.join(f.root, 'vms', `${vm.id}.json`)))
  const result = await updateCrag(f.root, f)
  assert.equal(result.ok, true)
  assert.deepEqual(
    result.items.map((row) => row.action),
    ['cache', 'skip', 'sync', 'skip', 'skip', 'sync'],
  )
  for (const [i, vm] of f.vms.entries()) {
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'vms', `${vm.id}.json`)), before[i])
    assert.equal(
      fs.readFileSync(path.join(f.root, 'vms', vm.id, 'cli-home/.kin/kin-kernel'), 'utf8'),
      `wrapper:${vm.id}`,
    )
  }
  const cache = path.join(f.root, 'vms/vm-cache/cli-home/.kin/crag-v2')
  assert.equal(verifyCragV2Tree(cache).ok, true)
  assert.deepEqual(
    fs.readFileSync(path.join(cache, 'manifest.json')),
    fs.readFileSync(path.join(f.pkg, 'manifest.json')),
  )
  assert.match(f.calls[1].body.reason, /^crag_update_/)
  assert.equal(f.calls.at(-1).body.reason, f.calls[1].body.reason)
  assert.equal(fs.existsSync(path.join(f.root, 'share/crag/kernels/v2/.update-lock')), false)
})

for (const field of ['active_requests', 'continuations', 'queued']) {
  test(`CRAG update rejects occupied ${field}, restores only its hold and never restarts`, async (t) => {
    const f = fixture(t)
    await assert.rejects(
      updateCrag(f.root, { ...f, health: async () => ({ ...(await f.health()), [field]: 1 }) }),
      /not_idle/,
    )
    assert.equal(
      f.calls.some(({ body }) => body.restart === true),
      false,
    )
    assert.equal(f.calls.at(-1).endpoint, '/api/panel/vms/schedule/resume')
  })
}

test('CRAG download failure never holds scheduling or changes installed bytes', async (t) => {
  const f = fixture(t)
  await assert.rejects(
    updateCrag(f.root, { ...f, pull: async () => ({ ok: false, code: 'crag_v2_authority_mismatch' }) }),
    /authority_mismatch/,
  )
  assert.deepEqual(f.calls, [])
})

test('CRAG update is idempotent and does not pause or restart already current slots', async (t) => {
  const f = fixture(t)
  await updateCrag(f.root, f)
  f.calls.length = 0
  const api = async (endpoint, body) => {
    f.calls.push({ endpoint, body })
    return { ok: true, changed_count: 0, failed_count: 0 }
  }
  assert.equal((await updateCrag(f.root, { ...f, api })).ok, true)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].body.restart, false)
})

test('unsupported cluster CRAG fails before downloading and another updater cannot remove its lock', async (t) => {
  const f = fixture(t)
  const file = path.join(f.root, 'vms/vm-live.json')
  fs.writeFileSync(file, JSON.stringify({ ...f.vms[0], node_id: 'node-one' }))
  await assert.rejects(updateCrag(f.root, { ...f, pull: () => assert.fail('must preflight') }), /unsupported_placement/)
  const lock = path.join(f.root, 'share/crag/kernels/v2/.update-lock')
  fs.mkdirSync(lock)
  await assert.rejects(updateCrag(f.root, f), /EEXIST/)
  assert.equal(fs.existsSync(lock), true)
  assert.equal(cragUpdateInventory(f.root, { inference: { dataplane: 'wrap' } }).length, 6)
})

test('matching installed files cannot hide a stale running memfd core', async (t) => {
  const f = fixture(t)
  await updateCrag(f.root, f)
  f.calls.length = 0
  let reloaded = false
  const api = async (endpoint, body) => {
    f.calls.push({ endpoint, body })
    if (endpoint.endsWith('/reload')) reloaded = true
    if (endpoint.endsWith('/hold')) return { drained: true, inflight: 0 }
    return { ok: true, changed_count: 0, failed_count: 0 }
  }
  const coreHashes = async () => (reloaded ? f.coreHashes() : ['0'.repeat(64)])
  assert.equal((await updateCrag(f.root, { ...f, api, coreHashes })).ok, true)
  assert.equal(f.calls.filter(({ endpoint }) => endpoint.endsWith('/reload')).length, 1)
  assert.equal(
    f.calls.some(({ body }) => body.restart === true),
    false,
  )
})

test('native systemd update reads only existing service key/port when .env is absent', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const f = fixture(t)
  const service = spawn(process.execPath, ['-e', "console.log('ready');setTimeout(()=>{},30000)"], {
    env: { ...process.env, VM2API_API_KEY: '', KIN_API_KEY: 'loopback-fixture-key', PORT: '16888' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => service.kill())
  await once(service.stdout, 'data')
  const bin = path.join(f.root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s\\n' '${service.pid}'\n`, { mode: 0o755 })
  const keys = ['PATH', 'PORT', 'VM2API_API_KEY', 'KIN_API_KEY']
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const fetchBefore = globalThis.fetch
  t.after(() => {
    globalThis.fetch = fetchBefore
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })
  process.env.PATH = `${bin}:${process.env.PATH}`
  for (const key of keys.slice(1)) delete process.env[key]
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:16888/fixture')
    assert.equal(options.headers.Authorization, 'Bearer loopback-fixture-key')
    return new Response(JSON.stringify({ ok: true, data: { verified: true } }))
  }
  assert.deepEqual(await localPanelApi(f.root)('/fixture', {}), { verified: true })
  assert.equal(fs.existsSync(path.join(f.root, '.env')), false)
})
