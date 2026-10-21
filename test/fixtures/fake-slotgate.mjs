import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'

export function syntheticFence(generation = '1') {
  return {
    generation,
    incarnation: 'synthetic-incarnation',
    executor: {
      kind: 'container',
      node_boot_id: 'synthetic-boot',
      container_id: 'a'.repeat(64),
      docker_daemon_id: 'synthetic-engine',
      started_at: '2026-10-21T00:00:00.000000001Z',
    },
  }
}

export const assistant = {
  id: 'synthetic-message', type: 'message', role: 'assistant',
  content: [{ type: 'text', text: 'synthetic answer' }], stop_reason: 'end_turn',
}
const wire = (value) => JSON.stringify(value, (key, item) => key === 'generation' ? JSON.rawJSON(String(item)) : item)

// A local protocol double, not a node/Docker or provider acceptance test.
export async function fakeSlotgate(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-ksg2-'))
  const keyPath = path.join(dir, 'key.pem')
  const certPath = path.join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
    '-out', certPath, '-days', '1', '-subj', '/CN=synthetic-slotgate',
  ], { stdio: 'ignore' })
  const cert = fs.readFileSync(certPath)
  const sockets = new Set()
  const commands = new Map()
  const requests = []
  const token = 'synthetic-local-slotgate-token'
  const server = tls.createServer({ key: fs.readFileSync(keyPath), cert, minVersion: 'TLSv1.3' }, (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    let buffer = Buffer.alloc(0)
    let command
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!command) {
        const first = buffer.indexOf(10)
        const second = buffer.indexOf(10, first + 1)
        if (first < 0 || second < 0) return
        if (buffer.subarray(0, first).toString() !== `KSG2 ${token}`) return socket.end('ERR auth\n')
        command = JSON.parse(buffer.subarray(first + 1, second).toString(), (key, value, context) =>
          key === 'generation' && typeof value === 'number' ? context.source : value)
        buffer = buffer.subarray(second + 1)
        requests.push(command)
        if (command.op === 'health') {
          const reply = typeof options.health === 'function' ? options.health(command) : options.health
          if (options.holdHealth) return
          return socket.end(wire(reply || {
            ok: true, fence: command.fence,
            manifest_revision: command.manifest_revision, manifest_digest: command.manifest_digest,
            health: { ok: true, engine: 'rust', healthy: true, ready_slots: 1,
              credential: { has_access: true, has_refresh: true, generation: 'credential-1',
                expires_at: 1981929600000, account_uuid: 'synthetic-account',
                org_uuid: 'synthetic-org', email: 'synthetic@example.invalid' } },
          }) + '\n')
        }
        if (command.op === 'prepare') {
          commands.set(command.command_id, { ticket: `ticket-${command.command_id}`, command })
          return socket.end(JSON.stringify({ ok: true, ticket: `ticket-${command.command_id}` }) + '\n')
        }
        if (command.op === 'command') {
          const held = commands.get(command.command_id)
          if (!held || held.ticket !== command.ticket) return socket.end('{"ok":false,"error":"ticket_invalid"}\n')
          const result = typeof options.status === 'function' ? options.status(command, held) : options.status
          return socket.end(wire(result || {
            ok: true,
            command: { id: command.command_id, fence: command.fence, status: 'completed', dispatched: true },
          }) + '\n')
        }
        if (command.op !== 'forward') return socket.end('ERR bad_request\n')
      }
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const headers = buffer.subarray(0, end).toString()
      const length = Number(/content-length: (\d+)/i.exec(headers)?.[1] || 0)
      if (buffer.length < end + 4 + length) return
      socket.removeAllListeners('data')
      const envelope = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString())
      const held = commands.get(command.command_id)
      if (!held || held.ticket !== command.ticket) return socket.end('ERR ticket_invalid\n')
      held.envelope = envelope
      held.headers = headers
      options.onForward?.(command, envelope)
      if (options.hold) return
      const payload = options.body || JSON.stringify(assistant)
      if (options.truncated) return socket.end(`OK\nHTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(payload) + 10}\r\n\r\n${payload}`)
      socket.end(`OK\nHTTP/1.1 ${options.statusCode || 200} Result\r\nContent-Type: ${options.sse ? 'text/event-stream' : 'application/json'}\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`)
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const config = {
    trusted: true, pgBindingReady: true, nodeId: 'node-synthetic', vmId: 'vm-synthetic',
    fence: syntheticFence(),
    link: { address: '127.0.0.1', port: server.address().port, token,
      certSha256: new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase() },
  }
  return { config, commands, requests }
}
