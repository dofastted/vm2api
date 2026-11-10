import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { raiseDockerSlotMemory } from '../../src/lib/vm/docker-slot-memory.mjs'
import { localDocker } from '../../src/lib/cluster/docker-remote.mjs'

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

async function memoryDaemon(t, root, { onUpdate = async () => {} } = {}) {
  let memory = 512 * 1024 ** 2
  const requests = []
  const containerId = 'c'.repeat(64)
  const execId = 'e'.repeat(64)
  const socketPath = path.join(root, 'docker.sock')
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    const body = raw ? JSON.parse(raw) : null
    requests.push({ path: req.url, body })
    if (req.url.endsWith('/update')) {
      await onUpdate()
      memory = body.Memory
      return res.end('{"Warnings":null}')
    }
    if (req.url.endsWith('/exec')) return res.writeHead(201).end(JSON.stringify({ Id: execId }))
    if (req.url.endsWith('/start')) {
      const data = Buffer.from(String(memory))
      const header = Buffer.alloc(8)
      header[0] = 1
      header.writeUInt32BE(data.length, 4)
      return res.end(Buffer.concat([header, data]))
    }
    res.end(
      JSON.stringify(
        req.url.startsWith('/exec/')
          ? { Running: false, ExitCode: 0 }
          : { Id: containerId, HostConfig: { Memory: memory, MemorySwap: memory }, State: { Running: true } },
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
  return { connect: localDocker(socketPath), requests }
}

test('PATCH vm memory raises docker limit through HTTP and returns memory_raise payload', async (t) => {
  const root = tmpProject('vm-01')
  try {
    const { connect } = await memoryDaemon(t, root)
    const { handlePanel, response } = handler(
      root,
      { machine: { memory: '1g' } },
      {
        raiseDockerSlotMemory: (projectRoot, vm, memory, opts) =>
          raiseDockerSlotMemory(projectRoot, vm, memory, { ...opts, connect }),
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

test('PATCH vm memory waits for the asynchronous transaction before replying', async (t) => {
  const root = tmpProject('vm-01')
  const entered = Promise.withResolvers()
  const resume = Promise.withResolvers()
  t.after(() => {
    resume.resolve()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const { handlePanel, response } = handler(
    root,
    { memory: '1g' },
    {
      raiseDockerSlotMemory: async () => {
        entered.resolve()
        await resume.promise
        return { ok: false, code: 'docker_update_failed', message: 'injected async failure' }
      },
    },
  )
  const pending = patchVm(handlePanel)
  await entered.promise
  assert.equal(response.status, undefined)
  resume.resolve()
  await pending
  assert.equal(response.status, 502)
  assert.equal(response.body.error.code, 'docker_update_failed')
})

test('same-slot memory requests serialize and the second request rechecks saved memory', async (t) => {
  const root = tmpProject('vm-01')
  const entered = Promise.withResolvers()
  const resume = Promise.withResolvers()
  t.after(() => {
    resume.resolve()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const api = await memoryDaemon(t, root, {
    onUpdate: async () => {
      entered.resolve()
      await resume.promise
    },
  })
  const extra = {
    raiseDockerSlotMemory: (projectRoot, vm, memory, opts) =>
      raiseDockerSlotMemory(projectRoot, vm, memory, { ...opts, connect: api.connect }),
  }
  const first = handler(root, { memory: '1g' }, extra)
  const second = handler(root, { memory: '1g' }, extra)
  const pendingFirst = patchVm(first.handlePanel)
  await entered.promise
  const pendingSecond = patchVm(second.handlePanel)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(second.response.status, undefined)
  assert.equal(api.requests.filter((r) => r.path.endsWith('/update')).length, 1)
  resume.resolve()
  await Promise.all([pendingFirst, pendingSecond])
  assert.equal(first.response.status, 200, JSON.stringify(first.response.body))
  assert.equal(second.response.status, 400)
  assert.equal(second.response.body.error.code, 'memory_not_increased')
  assert.equal(api.requests.filter((r) => r.path.endsWith('/update')).length, 1)
})

test('memory requests for different slots can enter their transactions concurrently', async (t) => {
  const root = tmpProject('vm-01')
  fs.copyFileSync(path.join(root, 'vms', 'vm-01.json'), path.join(root, 'vms', 'vm-02.json'))
  const secondFile = path.join(root, 'vms', 'vm-02.json')
  const secondRecord = JSON.parse(fs.readFileSync(secondFile))
  fs.writeFileSync(secondFile, JSON.stringify({ ...secondRecord, id: 'vm-02', name: 'vm-02' }))
  const entered = new Set()
  const bothEntered = Promise.withResolvers()
  const resume = Promise.withResolvers()
  t.after(() => {
    resume.resolve()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const extra = {
    raiseDockerSlotMemory: async (_project, vm) => {
      entered.add(vm.id)
      if (entered.size === 2) bothEntered.resolve()
      await resume.promise
      return { ok: false, code: 'docker_update_failed', message: 'injected async failure' }
    },
  }
  const first = handler(root, { memory: '1g' }, extra)
  const second = handler(root, { memory: '1g' }, extra)
  const pending = [patchVm(first.handlePanel), patchVm(second.handlePanel, 'vm-02')]
  await bothEntered.promise
  assert.deepEqual([...entered].sort(), ['vm-01', 'vm-02'])
  assert.equal(first.response.status, undefined)
  assert.equal(second.response.status, undefined)
  resume.resolve()
  await Promise.all(pending)
})

test('PATCH preserves application and rollback uncertainty in the error payload', async (t) => {
  const root = tmpProject('vm-01')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const state = {
    application_state: 'applied_unverified',
    config_unchanged: true,
    rollback_attempted: false,
    rollback_succeeded: false,
    before_memory: '512m',
    before_swap_bytes: -1,
    observed_memory_swap: 1024 ** 3,
  }
  const { handlePanel, response } = handler(
    root,
    { memory: '1g' },
    {
      raiseDockerSlotMemory: async () => ({
        ok: false,
        code: 'cgroup_memory_unverified',
        message: 'cannot verify',
        ...state,
      }),
    },
  )
  await patchVm(handlePanel)
  assert.equal(response.status, 502)
  for (const [key, value] of Object.entries(state)) assert.equal(response.body.error[key], value, key)
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
