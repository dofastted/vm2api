import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { updateCrag, cragUpdateInventory, localPanelApi, runningCragHashes } from '../../scripts/update-crag.mjs'
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
  const payload_tag = 'payload-2026.11.20-crag-3.1.8'
  let items
  const api = async (endpoint, body) => {
    calls.push({ endpoint, body })
    if (endpoint === '/api/panel/kernels/crag-update') {
      assert.equal(body.background, true)
      items = body.targets.map(({ id, kernel, payload_tag: pin }) => {
        assert.equal(kernel, 'crag')
        assert.equal(pin, payload_tag)
        const vm = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8'))
        assert.equal(vm.dataplane, 'crag')
        if (!vm.node_id) {
          const dest = path.join(root, 'vms', id, 'cli-home/.kin/crag-v2')
          fs.rmSync(dest, { recursive: true, force: true })
          fs.cpSync(pkg, dest, { recursive: true })
        }
        return { id, ok: true, status: vm.status, payload_tag }
      })
      return { job_id: 'install-job' }
    }
    assert.equal(endpoint, '/api/panel/kernels/install?job_id=install-job')
    assert.equal(body, undefined)
    return { state: 'completed', report: { ok: true, items } }
  }
  const pull = async () => ({ ok: true, release: { tag: payload_tag, payload_tag } })
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
  assert.deepEqual(
    f.calls[0].body.targets.map(({ id }) => id),
    ['vm-live', 'vm-stop'],
  )
  assert.equal(f.calls.length, 2)
  assert.equal(fs.existsSync(path.join(f.root, 'share/crag/kernels/v2/.update-lock')), false)
})

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
  assert.equal((await updateCrag(f.root, f)).ok, true)
  assert.deepEqual(f.calls, [])
})

test('local KVM CRAG update replaces active and stopped packages through the managed install', async (t) => {
  const f = fixture(t)
  for (const id of ['vm-live', 'vm-stop']) {
    const file = path.join(f.root, 'vms', `${id}.json`)
    const record = JSON.parse(fs.readFileSync(file))
    fs.writeFileSync(file, JSON.stringify({ ...record, runtime: { type: 'kvm' } }))
  }
  const result = await updateCrag(f.root, f)
  assert.equal(result.ok, true)
  assert.equal(result.items.find((item) => item.id === 'vm-stop').status, 'stopped')
  assert.deepEqual(
    f.calls[0].body.targets.map(({ id }) => id),
    ['vm-live', 'vm-stop'],
  )
})

for (const type of ['docker', 'kvm']) {
  test(`running CRAG hashes use the ${type} execution boundary with a bounded probe`, async () => {
    const calls = []
    const hashes = await runningCragHashes(
      { id: 'vm-probe', runtime: { type, container: 'custom-runner' } },
      {
        execute: async (binary, argv, options) => {
          calls.push({ binary, argv, options })
          return { stdout: `${'a'.repeat(64)}  /proc/42/exe\n` }
        },
      },
    )
    assert.deepEqual(hashes, ['a'.repeat(64)])
    assert.equal(calls[0].binary, 'docker')
    if (type === 'kvm')
      assert.deepEqual(calls[0].argv.slice(0, 7), [
        'exec',
        'custom-runner',
        '/usr/local/bin/kin-guest-exec',
        '-u',
        '0',
        '--',
        'sh',
      ])
    else assert.deepEqual(calls[0].argv.slice(0, 4), ['exec', 'custom-runner', 'sh', '-c'])
    assert.equal(calls[0].options.timeout, 10_000)
  })
}

test('cluster slots use the panel install result and never probe a local container or package', async (t) => {
  const f = fixture(t)
  for (const vm of [f.vms[0], f.vms[1]]) {
    fs.writeFileSync(path.join(f.root, 'vms', `${vm.id}.json`), JSON.stringify({ ...vm, node_id: 'node-one' }))
    fs.rmSync(path.join(f.root, 'vms', vm.id, 'cli-home/.kin/crag-v2'), { recursive: true })
  }
  const report = await updateCrag(f.root, {
    ...f,
    coreHashes: () => assert.fail('集群槽不能探测本机 Docker'),
    health: () => assert.fail('集群槽不能探测本机套接字'),
  })
  assert.deepEqual(
    f.calls[0].body.targets.map(({ id }) => id),
    ['vm-live', 'vm-stop'],
  )
  for (const item of report.items.filter(({ action }) => action === 'sync')) {
    assert.equal(item.node_id, 'node-one')
    assert.equal(item.verified_by, 'panel_install')
    assert.equal(item.running_core_sha256, undefined)
  }
  assert.equal(report.items.find(({ id }) => id === 'vm-stop').status, 'stopped')
})

for (const [state, code, itemCode] of [
  ['completed', 'crag_install_failed', 'node_not_ready'],
  ['completed', 'crag_install_failed', 'crag_payload_changed'],
  ['unknown', 'crag_install_unconfirmed'],
]) {
  test(`installer result ${itemCode || state} is not treated as a successful update`, async (t) => {
    const f = fixture(t)
    const cache = path.join(f.root, 'vms/vm-cache/cli-home/.kin/crag-v2/manifest.json')
    const before = fs.readFileSync(cache)
    const api = async (endpoint, body) => {
      if (body) return f.api(endpoint, body)
      const result = await f.api(endpoint)
      if (state === 'unknown') return { state }
      if (itemCode === 'node_not_ready') Object.assign(result.report.items[0], { ok: false, code: itemCode })
      else result.report.items[0].payload_tag = 'another-release'
      return result
    }
    await assert.rejects(updateCrag(f.root, { ...f, api }), new RegExp(itemCode || code))
    assert.equal(f.calls.length, 2)
    assert.deepEqual(fs.readFileSync(cache), before)
  })
}

test('another updater cannot remove an in-flight update lock', async (t) => {
  const f = fixture(t)
  const lock = path.join(f.root, 'share/crag/kernels/v2/.update-lock')
  fs.mkdirSync(lock, { recursive: true })
  await assert.rejects(updateCrag(f.root, f), /EEXIST/)
  assert.equal(fs.existsSync(lock), true)
  assert.equal(cragUpdateInventory(f.root, { inference: { dataplane: 'wrap' } }).length, 6)
})

test('matching installed files cannot hide a stale running memfd core', async (t) => {
  const f = fixture(t)
  await updateCrag(f.root, f)
  f.calls.length = 0
  let replaced = false
  const api = async (endpoint, body) => {
    const result = await f.api(endpoint, body)
    if (!body) replaced = true
    return result
  }
  const coreHashes = async () => (replaced ? f.coreHashes() : ['0'.repeat(64)])
  assert.equal((await updateCrag(f.root, { ...f, api, coreHashes })).ok, true)
  assert.deepEqual(
    f.calls[0].body.targets.map(({ id }) => id),
    ['vm-live'],
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
    assert.equal(options.method, 'GET')
    assert.equal(options.body, undefined)
    assert.equal(options.headers.Authorization, 'Bearer loopback-fixture-key')
    return new Response(JSON.stringify({ ok: true, data: { verified: true } }))
  }
  assert.deepEqual(await localPanelApi(f.root)('/fixture'), { verified: true })
  assert.equal(fs.existsSync(path.join(f.root, '.env')), false)
})
