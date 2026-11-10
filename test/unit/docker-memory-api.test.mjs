import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import {
  execCapture,
  localDocker,
  updateContainerMemory,
  withDockerDeadline,
} from '../../src/lib/cluster/docker-remote.mjs'

const EXEC_ID = 'e'.repeat(64)

function frame(kind, text) {
  const body = Buffer.from(text)
  const header = Buffer.alloc(8)
  header[0] = kind
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

async function daemon(t, handle) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-memory-api-'))
  const socket = path.join(dir, 'docker.sock')
  const connections = new Set()
  const requests = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    const body = raw ? JSON.parse(raw) : null
    requests.push({ method: req.method, path: req.url, body })
    handle(req, res, body)
  })
  server.on('connection', (socket) => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
  })
  await new Promise((resolve) => server.listen(socket, resolve))
  t.after(async () => {
    for (const socket of connections) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { connect: localDocker(socket), requests, connections }
}

function execDaemon(t, { output = frame(1, '1073741824\n'), status = 200, exitCode = 0, running = false } = {}) {
  return daemon(t, (req, res) => {
    if (req.url.endsWith('/exec')) {
      res.writeHead(201).end(JSON.stringify({ Id: EXEC_ID }))
    } else if (req.url.endsWith('/start')) {
      res.writeHead(status)
      // Arbitrary HTTP boundaries must not be mistaken for Docker frame boundaries.
      res.write(output.subarray(0, 3))
      setImmediate(() => res.end(output.subarray(3)))
    } else {
      res.end(JSON.stringify({ Running: running, ExitCode: exitCode }))
    }
  })
}

test('memory update uses structured bytes and preserves Docker warnings', async (t) => {
  const api = await daemon(t, (_req, res) => res.end(JSON.stringify({ Warnings: ['swap accounting disabled'] })))
  assert.deepEqual(await updateContainerMemory(api.connect, 'kin-test', { memory: 1024 ** 3, memorySwap: -1 }), {
    warnings: ['swap accounting disabled'],
  })
  assert.deepEqual(api.requests, [
    { method: 'POST', path: '/containers/kin-test/update', body: { Memory: 1024 ** 3, MemorySwap: -1 } },
  ])
})

for (const status of [404, 500]) {
  test(`memory update rejects Docker HTTP ${status}`, async (t) => {
    const api = await daemon(t, (_req, res) => res.writeHead(status).end(JSON.stringify({ message: 'update refused' })))
    await assert.rejects(updateContainerMemory(api.connect, 'kin-test', { memory: 1024 ** 3, memorySwap: 1024 ** 3 }), {
      code: 'docker_api_error',
      status: status === 404 ? 404 : 502,
      message: 'update refused',
    })
  })
}

test('capture splits stdout/stderr, joins UTF-8 bytes and verifies nonzero exit', async (t) => {
  const utf = Buffer.from('内存')
  const api = await execDaemon(t, {
    output: Buffer.concat([frame(1, utf.subarray(0, 2)), frame(2, 'cat failed'), frame(1, utf.subarray(2))]),
    exitCode: 1,
  })
  assert.deepEqual(await execCapture(api.connect, 'kin-test', ['cat', '/sys/fs/cgroup/memory.max']), {
    stdout: '内存',
    stderr: 'cat failed',
    exitCode: 1,
  })
  assert.deepEqual(api.requests[0].body, {
    Cmd: ['cat', '/sys/fs/cgroup/memory.max'],
    Tty: false,
    AttachStdout: true,
    AttachStderr: true,
  })
  assert.deepEqual(api.requests[1].body, { Detach: false, Tty: false })
  assert.equal(api.requests[2].path, `/exec/${EXEC_ID}/json`)
})

for (const fields of [{ running: true }, { exitCode: null }]) {
  test(`capture refuses unconfirmed exec completion ${JSON.stringify(fields)}`, async (t) => {
    const api = await execDaemon(t, fields)
    await assert.rejects(execCapture(api.connect, 'kin-test', ['cat', '/sys/fs/cgroup/memory.max']), {
      code: 'docker_exec_unverified',
    })
  })
}

for (const output of [Buffer.from('plain text'), frame(1, '123').subarray(0, 10), Buffer.from([1, 0])]) {
  test(`capture rejects incomplete or malformed frame ${output.toString('hex')}`, async (t) => {
    const api = await execDaemon(t, { output })
    await assert.rejects(execCapture(api.connect, 'kin-test', ['cat', '/sys/fs/cgroup/memory.max']), {
      code: 'docker_exec_invalid_output',
    })
  })
}

test('capture bounds payload output and wire buffering', async (t) => {
  const api = await execDaemon(t, { output: frame(1, 'x'.repeat(8192)) })
  await assert.rejects(
    execCapture(api.connect, 'kin-test', ['cat', '/sys/fs/cgroup/memory.max'], { maxOutputBytes: 32 }),
    {
      code: 'docker_exec_output_limit',
    },
  )
})

test('capture enforces the payload limit even when wire buffering fits', async (t) => {
  const api = await execDaemon(t, { output: frame(1, 'x'.repeat(33)) })
  await assert.rejects(
    execCapture(api.connect, 'kin-test', ['cat', '/sys/fs/cgroup/memory.max'], { maxOutputBytes: 32 }),
    {
      code: 'docker_exec_output_limit',
    },
  )
})

test('capture preserves HTTP errors instead of interpreting them as frames', async (t) => {
  const api = await execDaemon(t, { output: Buffer.from('{"message":"container stopped"}'), status: 409 })
  await assert.rejects(execCapture(api.connect, 'kin-test', ['cat', '/sys/fs/cgroup/memory.max']), {
    code: 'docker_api_error',
    status: 409,
  })
})

test('deadline includes connector wait and destroys late streams without starting work', async () => {
  let finishConnect
  let started = false
  const result = withDockerDeadline(
    () => new Promise((resolve) => (finishConnect = resolve)),
    async (connect) => {
      await connect()
      started = true
    },
    30,
  )
  await assert.rejects(result, { code: 'docker_timeout' })
  const late = new PassThrough()
  finishConnect(late)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(late.destroyed, true)
  assert.equal(started, false)
})

test('memory update deadline closes a connected stalled request', async (t) => {
  const api = await daemon(t, (_req, res) => res.writeHead(200).flushHeaders())
  await assert.rejects(
    updateContainerMemory(api.connect, 'kin-test', { memory: 1024 ** 3, memorySwap: 1024 ** 3 }, { timeoutMs: 50 }),
    { code: 'docker_timeout' },
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(api.connections.size, 0)
})

test('memory update cannot be sent after a late connector resolves', async (t) => {
  const api = await daemon(t, (_req, res) => res.end('{"Warnings":null}'))
  let release
  const result = updateContainerMemory(
    () => new Promise((resolve) => (release = resolve)),
    'kin-test',
    { memory: 1024 ** 3, memorySwap: 1024 ** 3 },
    { timeoutMs: 30 },
  )
  await assert.rejects(result, { code: 'docker_timeout' })
  const socket = await api.connect()
  release(socket)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(socket.destroyed, true)
  assert.equal(api.requests.length, 0)
})

test('capture deadline closes a running exec stream', async (t) => {
  const api = await daemon(t, (req, res) => {
    if (req.url.endsWith('/exec')) return res.writeHead(201).end(JSON.stringify({ Id: EXEC_ID }))
    res.writeHead(200).write(frame(1, 'waiting'))
  })
  await assert.rejects(execCapture(api.connect, 'kin-test', ['cat', '/sys/fs/cgroup/memory.max'], { timeoutMs: 50 }), {
    code: 'docker_timeout',
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(api.connections.size, 0)
  assert.equal(api.requests.length, 2)
})

test('capture deadline spans create, start and inspect and cleans up streams', async (t) => {
  const api = await daemon(t, (req, res) => {
    if (req.url.endsWith('/exec')) return res.writeHead(201).end(JSON.stringify({ Id: EXEC_ID }))
    if (req.url.endsWith('/start')) return res.end(frame(1, '1073741824'))
    res.writeHead(200).flushHeaders()
  })
  await assert.rejects(execCapture(api.connect, 'kin-test', ['cat', '/sys/fs/cgroup/memory.max'], { timeoutMs: 50 }), {
    code: 'docker_timeout',
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(api.connections.size, 0)
})
