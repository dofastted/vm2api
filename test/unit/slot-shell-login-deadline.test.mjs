import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { createSlotShell } from '../../src/lib/vm/slot-shell.mjs'
import { seedEncryptedPackage } from '../fixtures/crag-license.mjs'
import { LOCAL_CRAG_CLAUDE } from '../../src/lib/vm/slot-engine.mjs'

// A stalled node SSH link wedges the native-login commit (read credentials +
// import) with no terminal frame, leaving the panel dialog in "waiting for
// confirmation" forever. The commit must carry a deadline so the panel can
// surface an error instead. Both paths below reuse the mock engine shape from
// slot-shell-kvm.test.mjs.

const PENDING_OAUTH = { access_token: 'fixture-access', refresh_token: 'fixture-refresh' }

/** A valid native-login credential JSON, framed the way the CLI writes it. */
function nativeCredentialOutput() {
  const oauth = {
    claudeAiOauth: {
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
      scopes: ['user:profile', 'user:inference'],
      expiresAt: Date.now() + 3600_000,
    },
  }
  return Buffer.concat([Buffer.from(JSON.stringify(oauth)), Buffer.from('\n\x1e\n'), Buffer.from('{}')])
}

/** Docker multiplexed stream frame: [stream(1=stdout), 0,0,0, size BE] + payload. */
function dockerFrame(payload) {
  const header = Buffer.alloc(8)
  header[0] = 1
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

function buildLoginHarness(t, { vmId = 'vm-01', runtime = 'docker', stallInspect = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-login-'))
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(
    path.join(root, 'vms', `${vmId}.json`),
    JSON.stringify({
      id: vmId,
      runtime: { type: runtime },
      // Local egress keeps hasBoundExit true without a real SOCKS5 pool.
      proxy: { id: 'px-local', scheme: 'local' },
      claude: {},
    }),
  )
  const client = path.join(root, 'vms', vmId, 'cli-home', path.posix.relative('/home/kincli', LOCAL_CRAG_CLAUDE))
  fs.mkdirSync(path.dirname(client), { recursive: true })
  fs.writeFileSync(client, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  // stageBundledAuthClaude materializes the CRAG v2 tree on first login.
  seedEncryptedPackage(root)
  const binDir = path.join(root, 'bin')
  fs.mkdirSync(binDir)
  fs.writeFileSync(
    path.join(binDir, 'docker'),
    '#!/bin/sh\n[ "$1" = inspect ] || exit 1\nprintf "true|123|bridge\\n"\n',
    { mode: 0o755 },
  )
  const previousPath = process.env.PATH
  process.env.PATH = `${binDir}:${previousPath}`
  t.after(() => {
    process.env.PATH = previousPath
    fs.rmSync(root, { recursive: true, force: true })
  })
  const sockets = new Set()
  const probe = { started: false }
  const engine = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    res.setHeader('content-type', 'application/json')
    if (/^\/containers\/[^/]+\/exec$/.test(req.url)) {
      // The native-oauth-result probe: exit 1 leaves the CLI grant unread.
      if (body.Cmd?.includes('native-oauth-result')) {
        probe.started = true
        res.writeHead(201).end(JSON.stringify({ Id: 'd'.repeat(64) }))
        return
      }
      res.writeHead(201).end(JSON.stringify({ Id: body.Tty ? 'a'.repeat(64) : 'b'.repeat(64) }))
    } else if (/^\/exec\/[a-f0-9]{64}\/start$/.test(req.url)) {
      // Non-TTY capture execs read a plain 200 with the multiplexed stream.
      // The native-oauth-result probe gets a valid credential so the commit
      // proceeds to importOauth — the step the deadline guards.
      res
        .writeHead(200)
        .end(req.url.startsWith(`/exec/${'d'.repeat(64)}`) ? dockerFrame(nativeCredentialOutput()) : undefined)
    } else if (/^\/exec\/[a-f0-9]{64}\/json$/.test(req.url)) {
      // The TTY login exec's exit-code inspect is the first node-link hop of
      // the commit; stalling it must still trip the deadline.
      if (stallInspect && req.url.startsWith(`/exec/${'a'.repeat(64)}`)) return
      res.end(JSON.stringify({ Running: false, ExitCode: 0 }))
    } else {
      res.end(JSON.stringify({ Running: false, ExitCode: 0 }))
    }
  })
  engine.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n')
    // End the hijacked stream right away: the panel sees the CLI process exit
    // and starts the post-login commit (credential read + import).
    socket.end()
  })
  return { root, engine, sockets, probe }
}

async function openLoginShell(t, harness, { importOauth }) {
  const shell = createSlotShell({ projectRoot: harness.root, logger: { warn() {} }, importOauth })
  const panel = http.createServer()
  panel.on('upgrade', (req, socket, head) => shell.handleUpgrade(req, socket, head))
  for (const server of [harness.engine, panel]) {
    server.on('connection', (socket) => {
      harness.sockets.add(socket)
      socket.on('close', () => harness.sockets.delete(socket))
    })
  }
  harness.engine.listen(0, '127.0.0.1')
  await once(harness.engine, 'listening')
  panel.listen(0, '127.0.0.1')
  await once(panel, 'listening')
  const connect = net.connect
  t.mock.method(net, 'connect', (...args) =>
    args[0] === '/var/run/docker.sock' ? connect(harness.engine.address().port, '127.0.0.1') : connect(...args),
  )
  const ticket = await shell.issueTicket('vm-01', { login: true })
  assert.equal(ticket.ok, true, JSON.stringify(ticket))
  const ws = new WebSocket(
    `ws://127.0.0.1:${panel.address().port}/api/panel/vms/vm-01/shell?ticket=${ticket.ticket}&login=1`,
  )
  t.after(() => {
    ws.terminate()
    for (const socket of harness.sockets) socket.destroy()
    void Promise.all([harness.engine, panel].map((server) => new Promise((resolve) => server.close(resolve))))
  })
  return { shell, ws }
}

test('native login commit deadline reports a framed error when the node link stalls', async (t) => {
  process.env.KIN_LOGIN_COMMIT_DEADLINE_MS = '300'
  t.after(() => delete process.env.KIN_LOGIN_COMMIT_DEADLINE_MS)
  const harness = buildLoginHarness(t)
  // The import never resolves: the engine answered, the panel-side commit hangs.
  const { ws } = await openLoginShell(t, harness, {
    importOauth: () => new Promise(() => {}),
  })
  const frames = []
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw))))
  // The harness ends the hijacked exec stream on upgrade, so the commit path
  // starts as soon as the terminal opens. Keep the panel socket open and wait
  // for the framed error the deadline must produce.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (frames.some((f) => f.t === 'error')) break
    await delay(100)
  }
  const error = frames.find((f) => f.t === 'error')
  assert.ok(error, 'expected an error frame once the commit deadline elapsed')
  assert.match(error.message, /超时/)
})

test('native login commit deadline also covers a stalled exit-code inspect', async (t) => {
  process.env.KIN_LOGIN_COMMIT_DEADLINE_MS = '300'
  t.after(() => delete process.env.KIN_LOGIN_COMMIT_DEADLINE_MS)
  const harness = buildLoginHarness(t, { stallInspect: true })
  let imported = false
  const { ws } = await openLoginShell(t, harness, {
    importOauth: async () => {
      imported = true
      return { ok: true, official_cc_bootstrap: null }
    },
  })
  const frames = []
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw))))
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (frames.some((f) => f.t === 'error')) break
    await delay(100)
  }
  const error = frames.find((f) => f.t === 'error')
  assert.ok(error, 'expected an error frame when the exit-code inspect stalls')
  assert.match(error.message, /超时/)
  assert.equal(imported, false, 'a stalled inspect must not proceed to import')
})

test('native login commit completes normally inside the deadline', async (t) => {
  process.env.KIN_LOGIN_COMMIT_DEADLINE_MS = '30000'
  t.after(() => delete process.env.KIN_LOGIN_COMMIT_DEADLINE_MS)
  const harness = buildLoginHarness(t)
  let imported = 0
  const { ws } = await openLoginShell(t, harness, {
    importOauth: async () => {
      imported += 1
      return { ok: true, official_cc_bootstrap: null }
    },
  })
  const frames = []
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw))))
  // The commit must actually run and report success — "no error frame" alone
  // would also pass if the commit never started.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (frames.some((f) => f.t === 'login' || f.t === 'error')) break
    await delay(50)
  }
  assert.equal(
    frames.some((f) => f.t === 'error'),
    false,
    JSON.stringify(frames.filter((f) => f.t === 'error')),
  )
  const login = frames.find((f) => f.t === 'login')
  assert.ok(login, 'expected a login success frame')
  assert.equal(login.ok, true)
  assert.equal(imported, 1)
})
