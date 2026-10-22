import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter, once } from 'node:events'
import { mock } from 'node:test'
import { WebSocket } from 'ws'

const moduleUrl = new URL('../../src/lib/cluster/docker-remote.mjs', import.meta.url).href
const actual = await import(moduleUrl)
const tty = new EventEmitter()
tty.write = () => {}
tty.destroy = () => { tty.destroyRequested = true }
const running = process.env.VM2API_TERMINAL_INSPECT_RUNNING === 'true'
mock.module(moduleUrl, { namedExports: {
  ...actual,
  openExecTty: async () => ({ execId: 'synthetic-exec', stream: tty }),
  resizeExec: async () => {}, execDetached: async () => {},
  inspectExec: async () => ({ Running: running, ExitCode: running ? null : 0 }),
} })
const { createSlotShell } = await import('../../src/lib/vm/slot-shell.mjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-execution-'))
fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
fs.writeFileSync(path.join(root, 'vms', 'vm-02.json'), JSON.stringify({ id: 'vm-02' }))
const events = []
const shell = createSlotShell({ projectRoot: root, onExecutionState: async (_req, execution) => { events.push(execution) } })
const ticket = await shell.issueTicket('vm-02')
const server = http.createServer()
server.on('upgrade', (req, socket, head) => shell.handleUpgrade(req, socket, head))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/panel/vms/vm-02/shell?ticket=${ticket.ticket}`)
try {
  await once(ws, 'open')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(events[0]?.started, true)
  assert.equal(events[0]?.ended, false)
  assert.ok(events[0].requestId)
  const closed = once(ws, 'close')
  if (running) {
    ws.close()
    await closed
    assert.equal(events.some((execution) => execution.ended === true), false)
  }
  tty.emit('close')
  await shell.drain()
  await closed
  assert.equal(events.at(-1).ended, !running)
  assert.equal(events.at(-1).requestId, events[0].requestId)
} finally {
  tty.emit('close')
  ws.terminate()
  await shell.drain()
  await new Promise((resolve) => server.close(resolve))
  mock.restoreAll()
  fs.rmSync(root, { recursive: true, force: true })
}
