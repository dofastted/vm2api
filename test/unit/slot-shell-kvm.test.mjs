import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { createSlotShell } from '../../src/lib/vm/slot-shell.mjs'

for (const runtime of ['kvm', 'docker']) {
  test(`${runtime} panel shell sends its home and working directory to the correct runtime`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-kvm-'))
    fs.mkdirSync(path.join(root, 'vms'))
    fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify({ id: 'vm-01', runtime: { type: runtime } }))
    const shell = createSlotShell({ projectRoot: root, logger: { warn() {} } })
    const sockets = new Set()
    const shellId = 'a'.repeat(64)
    const reapId = 'b'.repeat(64)
    let execBody
    const engine = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
      res.setHeader('content-type', 'application/json')
      if (req.url === '/containers/kin-01/exec') {
        if (body.Tty) execBody = body
        res.writeHead(201).end(JSON.stringify({ Id: body.Tty ? shellId : reapId }))
      } else if (req.url === `/exec/${reapId}/start`) {
        res.end('{}')
        engine.emit('reaped')
      } else {
        res.end(JSON.stringify({ ExitCode: 0 }))
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
      if (runtime === 'kvm') {
        assert.equal(execBody.Cmd[0], '/usr/local/bin/kin-guest-exec')
        const guestEnv = execBody.Cmd.flatMap((arg, i) => (arg === '-e' ? [execBody.Cmd[i + 1]] : []))
        assert.ok(guestEnv.includes('HOME=/home/kincli'))
        assert.ok(guestEnv.includes('CLAUDE_CONFIG_DIR=/home/kincli/.claude'))
        assert.equal(execBody.Cmd[execBody.Cmd.indexOf('-w') + 1], '/home/kincli')
        assert.deepEqual(execBody.Env, [])
      } else {
        assert.deepEqual(execBody.Cmd.slice(0, 2), ['/bin/sh', '-c'])
        assert.ok(execBody.Env.includes('TERM=xterm-256color'))
        assert.equal(
          execBody.Env.some((value) => /^(HOME|CLAUDE_CONFIG_DIR)=/.test(value)),
          false,
        )
      }
      assert.equal(Object.hasOwn(execBody, 'WorkingDir'), false)
      const closed = once(ws, 'close', { signal: AbortSignal.timeout(5_000) })
      const reaped = once(engine, 'reaped', { signal: AbortSignal.timeout(5_000) })
      ws.close()
      await Promise.all([closed, reaped])
      assert.deepEqual(shell.liveShellTokens(), [])
    } finally {
      ws?.terminate()
      for (const socket of sockets) socket.destroy()
      await Promise.all([engine, panel].map((server) => new Promise((resolve) => server.close(resolve))))
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}
