import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { bindPlacement, unbindPlacement } from '../../src/lib/cluster/placement.mjs'
import { queueSlotPush } from '../../src/lib/cluster/remote-slot-files.mjs'
import { runRemote } from '../../src/lib/cluster/remote-fs.mjs'
import { writeKernelConfig, syncClaudeKernelConfigs } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { getDb } from '../../src/lib/db/database.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

async function fixture(t, { preparationCode = 0 } = {}) {
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
  let sftpOpens = 0
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
    sftp: (callback) => {
      sftpOpens++
      callback(null, sftp)
    },
    exec: (command, callback) => {
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.close = () => {}
      callback(null, stream)
      queueMicrotask(() => {
        const code = typeof preparationCode === 'function' ? preparationCode(command) : preparationCode
        if (code !== null) stream.emit('exit', code)
        stream.emit('close')
      })
    },
  }
  const manager = {
    client: () => client,
    remoteHost: async () => ({ root: '/synthetic-node', uid: 1000, gid: 1000 }),
  }
  bindPlacement({ projectRoot: root, manager })
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
    finishFirst: (error) => waiting.shift()(error),
    writes,
    client,
    manager,
    sftpOpens: () => sftpOpens,
    operations: new SharedVmOperations(db),
    other: new SharedVmOperations(peer),
  }
}

test('a nonzero remote command exit is confirmed only after its channel closes', async () => {
  const stream = new EventEmitter()
  stream.stderr = new EventEmitter()
  stream.close = () => {}
  let settled = false
  const command = runRemote({ exec: (_command, callback) => callback(null, stream) }, 'synthetic command').finally(
    () => {
      settled = true
    },
  )
  command.catch(() => {})
  stream.emit('exit', 7)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  stream.emit('close')
  await assert.rejects(command, { code: 'remote_exec_failed', remoteCommandEnded: true })
})

test('a command timeout after exit without channel close has no terminal proof', async () => {
  const stream = new EventEmitter()
  stream.stderr = new EventEmitter()
  stream.close = () => {}
  const command = runRemote({ exec: (_command, callback) => callback(null, stream) }, 'synthetic command', {
    timeoutMs: 5,
  })
  stream.emit('exit', 7)
  await assert.rejects(command, (error) => {
    assert.equal(error.code, 'exec_timeout')
    assert.notEqual(error.remoteCommandEnded, true)
    return true
  })
})

test('a confirmed initial directory preparation failure ends the publication before SFTP starts', async (t) => {
  const f = await fixture(t, { preparationCode: 1 })
  const publication = queueSlotPush(f.vm, f.slotDir, ['run'], { logger: { warn() {} } })
  await assert.rejects(publication, (error) => {
    assert.equal(error.code, 'remote_exec_failed')
    assert.equal(error.remoteCommandEnded, true)
    assert.equal(error.publicationFinished, true)
    assert.notEqual(error.vmOperationUncertain, true)
    assert.notEqual(error.executionUncertain, true)
    return true
  })
  assert.equal(f.sftpOpens(), 0)
})

for (const code of [null, '1', Number.NaN]) {
  test(`preparation close without a safe integer exit (${String(code)}) retains unknown publication`, async (t) => {
    const f = await fixture(t, { preparationCode: code })
    await assert.rejects(queueSlotPush(f.vm, f.slotDir, ['run'], { logger: { warn() {} } }), (error) => {
      assert.notEqual(error.remoteCommandEnded, true)
      assert.notEqual(error.publicationFinished, true)
      assert.equal(error.vmOperationUncertain, true)
      assert.equal(error.executionUncertain, true)
      return true
    })
    assert.equal(f.sftpOpens(), 0)
  })
}

test('contradictory completed publication metadata cannot clear an existing unknown marker', async (t) => {
  const f = await fixture(t)
  const failure = Object.assign(new Error('synthetic contradictory completion proof'), {
    publicationFinished: true,
    vmOperationUncertain: true,
  })
  f.manager.client = () => {
    throw failure
  }
  await assert.rejects(queueSlotPush(f.vm, f.slotDir, ['run'], { logger: { warn() {} } }), {
    publicationFinished: true,
    vmOperationUncertain: true,
    executionUncertain: true,
  })
})

test('queued SFTP errors reject the exact publication promise after logging', async (t) => {
  const f = await fixture(t)
  const logged = []
  const publication = queueSlotPush(f.vm, f.slotDir, ['run'], { logger: { warn: (line) => logged.push(line) } })
  await f.started
  f.finish(new Error('synthetic connection lost after write'))
  await assert.rejects(publication, { code: 'sftp_failed', vmOperationUncertain: true, executionUncertain: true })
  assert.equal(logged.length, 1)
})

test('a later SFTP failure cannot become a completed publication from command-level metadata', async (t) => {
  const f = await fixture(t)
  const publication = queueSlotPush(f.vm, f.slotDir, ['run'], { logger: { warn() {} } })
  await f.started
  f.finish(Object.assign(new Error('synthetic interrupted SFTP'), { remoteCommandEnded: true }))
  await assert.rejects(publication, (error) => {
    assert.equal(error.code, 'sftp_failed')
    assert.notEqual(error.publicationFinished, true)
    assert.equal(error.vmOperationUncertain, true)
    assert.equal(error.executionUncertain, true)
    return true
  })
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

test('a fleet config publication waits for every original push before reporting one failure', async (t) => {
  const f = await fixture(t)
  const second = { ...f.vm, id: 'vm-second' }
  fs.mkdirSync(path.join(f.root, 'vms', second.id, 'run'), { recursive: true })
  fs.writeFileSync(path.join(f.root, 'vms', second.id + '.json'), JSON.stringify(second))
  const result = syncClaudeKernelConfigs(f.root, {})
  let ended = false
  const publication = result.publication.then(
    () => {
      ended = true
    },
    (error) => {
      ended = true
      throw error
    },
  )
  publication.catch(() => {})
  try {
    await f.started
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.writes.length, 2)
    f.finishFirst(new Error('synthetic first publication disconnect'))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(ended, false)
  } finally {
    f.finish()
  }
  await assert.rejects(publication, { code: 'sftp_failed' })
  assert.equal(ended, true)
  assert.equal(JSON.stringify(result).includes('publication'), false)
})

test('a fleet publication prioritizes an unknown failure after an earlier confirmed preparation failure', async (t) => {
  const f = await fixture(t, { preparationCode: (command) => (command.includes('/vm-synthetic/') ? 1 : 0) })
  const second = { ...f.vm, id: 'vm-z-unknown' }
  fs.mkdirSync(path.join(f.root, 'vms', second.id, 'run'), { recursive: true })
  fs.writeFileSync(path.join(f.root, 'vms', second.id + '.json'), JSON.stringify(second))
  const result = syncClaudeKernelConfigs(f.root, {})
  let settled = false
  const publication = result.publication.finally(() => {
    settled = true
  })
  publication.catch(() => {})
  await f.started
  assert.equal(settled, false)
  f.finish(new Error('synthetic later SFTP disconnect'))
  await assert.rejects(publication, (error) => {
    assert.equal(error.code, 'sftp_failed')
    assert.notEqual(error.publicationFinished, true)
    assert.equal(error.vmOperationUncertain, true)
    assert.equal(error.executionUncertain, true)
    return true
  })
})

test('a fleet with only confirmed preparation failures retains complete publication proof', async (t) => {
  const f = await fixture(t, { preparationCode: 1 })
  const second = { ...f.vm, id: 'vm-z-ended' }
  fs.mkdirSync(path.join(f.root, 'vms', second.id, 'run'), { recursive: true })
  fs.writeFileSync(path.join(f.root, 'vms', second.id + '.json'), JSON.stringify(second))
  const result = syncClaudeKernelConfigs(f.root, {})
  await assert.rejects(result.publication, (error) => {
    assert.equal(error.code, 'remote_exec_failed')
    assert.equal(error.publicationFinished, true)
    assert.notEqual(error.vmOperationUncertain, true)
    assert.notEqual(error.executionUncertain, true)
    return true
  })
  assert.equal(f.sftpOpens(), 0)
})
