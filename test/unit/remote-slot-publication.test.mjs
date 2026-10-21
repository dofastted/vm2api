import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { bindPlacement, unbindPlacement } from '../../src/lib/cluster/placement.mjs'
import { queueSlotPush } from '../../src/lib/cluster/remote-slot-files.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { getDb } from '../../src/lib/db/database.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-publication-'))
  const vm = { id: 'vm-synthetic', node_id: 'node-synthetic', timezone: 'UTC', status: 'stopped' }
  const slotDir = path.join(root, 'vms', vm.id)
  fs.mkdirSync(path.join(slotDir, 'run'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', vm.id + '.json'), JSON.stringify(vm))
  fs.writeFileSync(path.join(slotDir, 'run', 'worker.json'), '{}')
  let entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  let completed = false
  let failure = null
  const waiting = []
  const writes = []
  const sftp = new EventEmitter()
  Object.assign(sftp, {
    open: (_file, _flags, _attrs, callback) => callback(null, Buffer.from('synthetic-handle')),
    write: (_handle, _data, _offset, _length, _position, callback) => callback(null),
    fchmod: (_handle, _mode, callback) => callback(null),
    close: (_handle, callback) => callback(null),
    unlink: (_file, callback) => callback(null),
    ext_openssh_rename: (_from, to, callback) => {
      writes.push(to)
      entered()
      if (completed) callback(failure)
      else waiting.push(callback)
    },
  })
  const client = {
    sftp: (callback) => callback(null, sftp),
    exec: (_command, callback) => {
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.close = () => {}
      callback(null, stream)
      queueMicrotask(() => {
        stream.emit('exit', 0)
        stream.emit('close')
      })
    },
  }
  bindPlacement({
    projectRoot: root,
    manager: {
      client: () => client,
      remoteHost: async () => ({ root: '/synthetic-node', uid: 1000, gid: 1000 }),
    },
  })
  const finish = (error = null) => {
    completed = true
    failure = error
    for (const callback of waiting.splice(0)) callback(error)
  }
  const db = getDb()
  const peer = await createRepositoryTestDatabase({ connectionString: db.connectionString, schema: db.schema })
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  t.after(async () => {
    finish()
    unbindPlacement()
    await peer.close()
    if (previous == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    vm,
    slotDir,
    db,
    peer,
    started,
    finish,
    writes,
    operations: new SharedVmOperations(db),
    other: new SharedVmOperations(peer),
  }
}

test('queued SFTP errors reject the exact publication promise after logging', async (t) => {
  const f = await fixture(t)
  const logged = []
  const publication = queueSlotPush(f.vm, f.slotDir, ['run'], { logger: { warn: (line) => logged.push(line) } })
  await f.started
  f.finish(new Error('synthetic connection lost after write'))
  await assert.rejects(publication, { code: 'sftp_failed', vmOperationUncertain: true, executionUncertain: true })
  assert.equal(logged.length, 1)
})

test('kernel config publication keeps its VM claim until the original SFTP write completes', async (t) => {
  const f = await fixture(t)
  let ended = false
  const operation = f.operations.run(f.vm.id, async () => {
    const written = writeKernelConfig(f.root, f.vm, { token: 'synthetic-token' })
    await written.publication
    ended = true
  })
  try {
    await f.started
    const next = await f.other.tryAcquire({ vmId: f.vm.id })
    if (next.ok) await next.release()
    assert.equal(ended, false)
    assert.equal(next.ok, false)
  } finally {
    f.finish()
    await operation
  }
  const next = await f.other.tryAcquire({ vmId: f.vm.id })
  assert.equal(next.ok, true)
  await next.release()
})

test('an unconfirmed kernel config publication retains persistent VM ownership', async (t) => {
  const f = await fixture(t)
  const operation = f.operations.run(f.vm.id, async () => {
    const written = writeKernelConfig(f.root, f.vm, { token: 'synthetic-token' })
    await written.publication
  })
  operation.catch(() => {})
  await f.started
  f.finish(new Error('synthetic connection lost after write'))
  await assert.rejects(operation, { code: 'sftp_failed' })
  const row = await f.peer.prepare('SELECT released_at, uncertain_at FROM vm_operations').get()
  assert.equal(row.released_at, null)
  assert.notEqual(row.uncertain_at, null)
})

test('panel timezone publication completes before HTTP success and VM claim release', async (t) => {
  const f = await fixture(t)
  let response
  const handler = createPanelHandler({
    cfg: { paths: { project: f.root } },
    routingConfig: {},
    vmOperations: f.operations,
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    readBody: async () => ({ timezone: 'Europe/Paris' }),
    json(_res, status, body) {
      response = { status, body }
      return true
    },
  })
  const request = handler({ method: 'PATCH' }, {}, new URL('http://localhost/api/panel/vms/' + f.vm.id))
  try {
    await f.started
    assert.equal(
      await Promise.race([request.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 100))]),
      false,
    )
    assert.equal(response, undefined)
    const next = await f.other.tryAcquire({ vmId: f.vm.id })
    assert.equal(next.ok, false)
  } finally {
    f.finish()
    await request
  }
  assert.equal(response.status, 200)
})
