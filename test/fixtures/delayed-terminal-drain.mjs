import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter, once } from 'node:events'
import { mock } from 'node:test'
import { WebSocket } from 'ws'

const dockerModule = new URL('../../src/lib/cluster/docker-remote.mjs', import.meta.url).href
const actual = await import(dockerModule)
const tty = new EventEmitter()
tty.write = () => {}
// ssh2 sends EOF/CLOSE here; the peer may acknowledge the close later.
tty.destroy = () => { tty.destroyRequested = true }
mock.module(dockerModule, {
  namedExports: {
    ...actual,
    openExecTty: async () => ({ execId: 'synthetic-exec', stream: tty }),
    resizeExec: async () => {},
    execDetached: async () => {},
    inspectExec: async () => ({ ExitCode: 0 }),
  },
})
const { createSlotShell } = await import('../../src/lib/vm/slot-shell.mjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-delayed-close-'))
const home = path.join(root, 'vms', 'vm-02', 'cli-home', '.claude')
fs.mkdirSync(home, { recursive: true })
fs.writeFileSync(path.join(root, 'vms', 'vm-02.json'), JSON.stringify({ id: 'vm-02' }))
fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ claudeAiOauth: {
  accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
  expiresAt: Date.now() + 3600_000, scopes: ['user:profile', 'user:inference'],
} }))
let databaseClosed = false
let imports = 0
let writesAfterClose = 0
const shell = createSlotShell({
  projectRoot: root,
  authLoginReady: async () => {},
  upgradeLoginReady: async () => {},
  importOauth: async () => {
    imports += 1
    if (databaseClosed) writesAfterClose += 1
    return { ok: true }
  },
  logger: { warn() {} },
})
const ticket = await shell.issueTicket('vm-02', { login: true })
const server = http.createServer()
server.on('upgrade', (req, socket, head) => shell.handleUpgrade(req, socket, head))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/panel/vms/vm-02/shell?ticket=${ticket.ticket}&login=1`)
let pending
try {
  await once(ws, 'open')
  await new Promise((resolve) => setImmediate(resolve))
  let drained = false
  pending = shell.drain().then(() => { drained = true })
  await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 200))])
  const drainedBeforeTtyClose = drained
  databaseClosed = drained
  assert.equal(tty.destroyRequested, true)
  tty.emit('close')
  await pending
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(drainedBeforeTtyClose, false, 'drain returned before the SSH TTY close/final adoption')
  assert.equal(imports, 1)
  assert.equal(writesAfterClose, 0, 'OAuth import began after the drain allowed database closure')
} finally {
  tty.emit('close')
  await pending?.catch(() => {})
  ws.terminate()
  await new Promise((resolve) => server.close(resolve))
  mock.restoreAll()
  fs.rmSync(root, { recursive: true, force: true })
}
