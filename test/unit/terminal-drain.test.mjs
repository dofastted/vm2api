import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter, once } from 'node:events'
import { WebSocket } from 'ws'
import { createClusterRoutes } from '../../src/lib/cluster/cluster-routes.mjs'
import { createSlotShell } from '../../src/lib/vm/slot-shell.mjs'

test('cluster terminal drain waits for a pending SSH channel and closes it before returning', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let closed = 0
  const stream = new EventEmitter()
  stream.close = () => {
    closed += 1
  }
  const routes = createClusterRoutes({
    manager: {
      consumeShellTicket: () => true,
      openShell: async () => {
        await gate
        return stream
      },
    },
  })
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => routes.handleUpgrade(req, socket, head))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/panel/cluster/nodes/node-a/shell?ticket=t`)
  try {
    await once(ws, 'open')
    const disconnected = once(ws, 'close')
    let drained = false
    const draining = routes.drain().then(() => {
      drained = true
    })
    await disconnected
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(drained, false, 'a channel that is still opening belongs to the drain')
    release()
    await draining
    assert.equal(closed, 1)
  } finally {
    release()
    ws.terminate()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('slot terminal drain waits for login readiness and rejects the pending upgrade', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-drain-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', 'vm-02.json'), JSON.stringify({ id: 'vm-02' }))
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const shell = createSlotShell({
    projectRoot: root,
    authLoginReady: async () => {},
    upgradeLoginReady: () => gate,
  })
  const seen = []
  const socket = { write: (data) => seen.push(String(data)), destroy() {} }
  try {
    const login = await shell.issueTicket('vm-02', { login: true })
    shell.handleUpgrade({ url: `/api/panel/vms/vm-02/shell?ticket=${login.ticket}&login=1` }, socket, Buffer.alloc(0))
    let drained = false
    const draining = shell.drain().then(() => {
      drained = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(drained, false)
    release()
    await draining
    assert.match(seen[0], /^HTTP\/1\.1 503 /)
    assert.equal((await shell.issueTicket('vm-02')).error.code, 'control_plane_draining')
  } finally {
    release()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
