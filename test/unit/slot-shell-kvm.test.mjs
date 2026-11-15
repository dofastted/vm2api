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
import { writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'
import { LOCAL_CRAG_CLAUDE } from '../../src/lib/vm/slot-engine.mjs'

for (const runtime of ['kvm', 'docker']) {
  test(`${runtime} panel shell sends its home and working directory to the correct runtime`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-kvm-'))
    fs.mkdirSync(path.join(root, 'vms'))
    fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify({ id: 'vm-01', runtime: { type: runtime } }))
    const client = path.join(root, 'vms', 'vm-01', 'cli-home', path.posix.relative('/home/kincli', LOCAL_CRAG_CLAUDE))
    fs.mkdirSync(path.dirname(client), { recursive: true })
    fs.writeFileSync(client, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeWorkerCredentialFile(path.join(root, 'vms', 'vm-01', 'cli-home'), {
      access_token: 'fixture-access',
      refresh_token: 'fixture-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    })
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
    })
    const shell = createSlotShell({ projectRoot: root, logger: { warn() {} } })
    const sockets = new Set()
    const shellId = 'a'.repeat(64)
    const reapId = 'b'.repeat(64)
    const probeId = 'c'.repeat(64)
    let execBody
    let probeBody
    const engine = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
      res.setHeader('content-type', 'application/json')
      if (req.url === '/containers/kin-01/exec') {
        if (body.Tty) execBody = body
        const probe = body.Cmd?.includes('auth-cli')
        if (probe) probeBody = body
        res.writeHead(201).end(JSON.stringify({ Id: body.Tty ? shellId : probe ? probeId : reapId }))
      } else if (req.url === `/exec/${probeId}/start`) {
        res.end()
      } else if (req.url === `/exec/${reapId}/start`) {
        res.end('{}')
        engine.emit('reaped')
      } else {
        res.end(JSON.stringify({ Running: false, ExitCode: 0 }))
      }
    })
    engine.on('upgrade', (_req, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nslot-shell-ready\r\n',
      )
    })
    const panel = http.createServer()
    panel.on('upgrade', (req, socket, head) => shell.handleUpgrade(req, socket, head))
    for (const server of [engine, panel]) {
      server.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
    }
    let ws
    try {
      engine.listen(0, '127.0.0.1')
      await once(engine, 'listening')
      panel.listen(0, '127.0.0.1')
      await once(panel, 'listening')
      const connect = net.connect
      // 只替换 Docker 传输，真实执行 ticket、WebSocket 升级及 attach 参数组装。
      t.mock.method(net, 'connect', (...args) =>
        args[0] === '/var/run/docker.sock' ? connect(engine.address().port, '127.0.0.1') : connect(...args),
      )
      const ticket = await shell.issueTicket('vm-01')
      assert.equal(ticket.ok, true)
      ws = new WebSocket(`ws://127.0.0.1:${panel.address().port}/api/panel/vms/vm-01/shell?ticket=${ticket.ticket}`)
      const [output] = await once(ws, 'message', { signal: AbortSignal.timeout(5_000) })
      assert.equal(String(output), 'slot-shell-ready\r\n')
      assert.equal(execBody.Tty, true)
      assert.ok(probeBody.Cmd.includes(LOCAL_CRAG_CLAUDE))
      assert.equal(probeBody.Tty, false)
      if (runtime === 'kvm') {
        assert.equal(execBody.Cmd[0], '/usr/local/bin/kin-guest-exec')
        const guestEnv = execBody.Cmd.flatMap((arg, i) => (arg === '-e' ? [execBody.Cmd[i + 1]] : []))
        assert.ok(guestEnv.includes('HOME=/home/kincli'))
        assert.ok(guestEnv.includes('CLAUDE_CONFIG_DIR=/home/kincli/.claude'))
        assert.equal(execBody.Cmd[execBody.Cmd.indexOf('-w') + 1], '/home/kincli')
        assert.deepEqual(execBody.Env, [])
        assert.equal(probeBody.Cmd[0], '/usr/local/bin/kin-guest-exec')
      } else {
        assert.deepEqual(execBody.Cmd.slice(0, 2), ['/bin/sh', '-c'])
        assert.ok(execBody.Env.includes('TERM=xterm-256color'))
        assert.ok(execBody.Env.includes('HOME=/home/kincli'))
        assert.ok(execBody.Env.includes('CLAUDE_CONFIG_DIR=/home/kincli/.claude'))
      }
      if (runtime === 'kvm') assert.equal(Object.hasOwn(execBody, 'WorkingDir'), false)
      else assert.equal(execBody.WorkingDir, '/home/kincli')
      const closed = once(ws, 'close', { signal: AbortSignal.timeout(5_000) })
      const reaped = once(engine, 'reaped', { signal: AbortSignal.timeout(5_000) })
      ws.close()
      await Promise.all([closed, reaped])
      // The engine receives the reap request before closeExec processes its response and releases the token.
      for (let i = 0; i < 100 && shell.liveShellTokens().length; i++) await delay(10)
      assert.deepEqual(shell.liveShellTokens(), [])
    } finally {
      ws?.terminate()
      for (const socket of sockets) socket.destroy()
      await Promise.all([engine, panel].map((server) => new Promise((resolve) => server.close(resolve))))
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}
