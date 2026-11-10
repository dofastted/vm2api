import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import http from 'node:http'
import { localDocker } from '../../src/lib/cluster/docker-remote.mjs'
import { raiseDockerSlotMemory } from '../../src/lib/vm/docker-slot-memory.mjs'
import { powerOnSlot } from '../../src/lib/vm/slot-recovery.mjs'
import { runtimePatch } from '../../src/lib/vm/vm-runtime.mjs'
import { getVm, patchVmRecord } from '../../src/lib/vm/vm-registry.mjs'

for (const type of ['docker', 'kvm']) {
  test(`runtime observation replaces stale stopped state (${type})`, () => {
    const vm = { id: 'vm-01', runtime: { type, stopped: true, pid: 7 } }
    runtimePatch(vm, { running: true, pid: 42, startedAt: '2026-01-01T00:00:00Z' })
    assert.equal(vm.runtime.stopped, false)
    assert.equal(vm.runtime.pid, 42)
    assert.equal(vm.runtime.started_at, '2026-01-01T00:00:00Z')
    runtimePatch(vm, { running: false, pid: 0 })
    assert.equal(vm.runtime.stopped, true)
    assert.equal(vm.runtime.pid, null)
  })
}

test('missing runtime observation does not claim a running container', () => {
  const vm = { id: 'vm-01' }
  runtimePatch(vm, null)
  assert.equal(vm.runtime.stopped, true)
  assert.equal(vm.runtime.pid, null)
})

function fixture(t, credential = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-state-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  const vm = {
    id: 'vm-01',
    status: 'stopped',
    runtime: { type: 'docker', stopped: true, pid: 7, started_at: 'old' },
    ...(credential ? { claude: { has_access: true, has_refresh: true } } : {}),
  }
  const file = path.join(root, 'vms', `${vm.id}.json`)
  fs.writeFileSync(file, JSON.stringify(vm))
  return {
    file,
    options: {
      projectRoot: root,
      id: vm.id,
      proxyPool: { ensureBoundToVm: () => ({ id: 'px-local', kind: 'local' }) },
      fillTimezone: async () => {},
    },
  }
}

for (const credential of [false, true]) {
  test(`power-on persists fresh runtime without changing credential gating (${credential})`, async (t) => {
    const { file, options } = fixture(t, credential)
    const runtime = { type: 'docker', stopped: false, pid: 42, started_at: 'new' }
    const result = await powerOnSlot({
      ...options,
      ops: { startSlotReady: async () => ({ ok: true, runtime }) },
    })
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(result.ok, true)
    assert.deepEqual(saved.runtime, runtime)
    assert.deepEqual(result.vm.runtime, runtime)
    assert.equal(saved.status, 'running')
    assert.equal(saved.schedulable, credential)
    assert.equal(saved.schedule_disabled_reason, credential ? null : 'no_credential')
  })
}

test('power-on persists the nested runtime returned by Codex boot', async (t) => {
  const { file, options } = fixture(t)
  const runtime = { type: 'docker', stopped: false, pid: 99, started_at: 'new' }
  const result = await powerOnSlot({
    ...options,
    ops: { startSlotReady: async () => ({ ok: true, engine: 'codex', docker: { ok: true, runtime } }) },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).runtime, runtime)
})

test('failed power-on never publishes successful runtime metadata', async (t) => {
  const { file, options } = fixture(t)
  const result = await powerOnSlot({
    ...options,
    ops: { startSlotReady: async () => ({ ok: false, error: 'injected failure', runtime: { pid: 42 } }) },
  })
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(result.ok, false)
  assert.equal(saved.status, 'stopped')
  assert.equal(saved.runtime.pid, 7)
  assert.equal(saved.runtime.stopped, true)
})

test('successful boot without runtime metadata preserves existing runtime', async (t) => {
  const { file, options } = fixture(t)
  const result = await powerOnSlot({ ...options, ops: { startSlotReady: async () => ({ ok: true }) } })
  assert.equal(result.ok, true)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).runtime.pid, 7)
})

test('power-on preserves a verified memory raise made while boot readiness is pending', async (t) => {
  const { file, options } = fixture(t)
  patchVmRecord(options.projectRoot, options.id, (record) => ({
    machine: { memory: '2g' },
    runtime: { ...record.runtime, memory: '2g' },
  }))
  const ready = Promise.withResolvers()
  const resume = Promise.withResolvers()
  t.after(() => resume.resolve())
  const starting = powerOnSlot({
    ...options,
    ops: {
      startSlotReady: async (vm) => {
        runtimePatch(vm, { running: true, pid: 42, startedAt: 'new' }, { memory: '2g' })
        const runtime = vm.runtime
        ready.resolve()
        await resume.promise
        return { ok: true, runtime }
      },
    },
  })
  await ready.promise
  let bytes = 2 * 1024 ** 3
  const socketPath = path.join(options.projectRoot, 'docker.sock')
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.url.endsWith('/update')) {
      bytes = JSON.parse(Buffer.concat(chunks)).Memory
      return res.end('{"Warnings":null}')
    }
    if (req.url.endsWith('/exec')) return res.writeHead(201).end(JSON.stringify({ Id: 'e'.repeat(64) }))
    if (req.url.endsWith('/start')) {
      const body = Buffer.from(String(bytes))
      const header = Buffer.alloc(8)
      header[0] = 1
      header.writeUInt32BE(body.length, 4)
      return res.end(Buffer.concat([header, body]))
    }
    res.end(
      JSON.stringify(
        req.url.startsWith('/exec/')
          ? { Running: false, ExitCode: 0 }
          : { Id: 'c'.repeat(64), HostConfig: { Memory: bytes, MemorySwap: bytes }, State: { Running: true } },
      ),
    )
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  const raised = await raiseDockerSlotMemory(options.projectRoot, getVm(options.projectRoot, options.id), '4g', {
    connect: localDocker(socketPath),
  })
  assert.equal(raised.ok, true)
  resume.resolve()
  const result = await starting
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(result.ok, true)
  assert.equal(saved.machine.memory, '4g')
  assert.equal(saved.runtime.memory, '4g')
  assert.equal(result.vm.runtime.memory, '4g')
  assert.equal(saved.runtime.pid, 42)
  assert.equal(saved.runtime.stopped, false)
  assert.equal(saved.runtime.started_at, 'new')
})
