import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null

async function relay(t, upstream) {
  const reservation = net.createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const child = spawn(python, ['-B', fileURLToPath(new URL('../../scripts/http_to_socks.py', import.meta.url))], {
    env: { ...process.env, KIN_SOCKS5: upstream, KIN_HTTP_BRIDGE_ADDR: `127.0.0.1:${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exit = once(child, 'exit')
    child.kill('SIGTERM')
    await exit
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge startup timeout')), 5000)
    child.stdout.once('data', () => {
      clearTimeout(timer)
      resolve()
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`bridge exited ${code}`))
    })
    child.once('error', reject)
  })
  return port
}

async function tunnel(port, target) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: target, agent: false })
    request.once('connect', (res, socket, head) => {
      if (head.length) socket.unshift(head)
      resolve({ status: res.statusCode, reason: res.statusMessage, socket })
    })
    request.once('error', reject)
    request.end()
  })
}

test('CLI CONNECT bridge uses HTTP credentials and preserves bytes arriving with response headers', {
  skip: !python,
  timeout: 10000,
}, async (t) => {
  const peers = new Set(),
    requests = []
  const proxy = http.createServer()
  proxy.on('connect', (req, socket) => {
    peers.add(socket)
    socket.on('close', () => peers.delete(socket))
    socket.on('error', () => {})
    requests.push({ target: req.url, auth: req.headers['proxy-authorization'] })
    socket.write('HTTP/1.1 200 OK\r\n\r\nhello')
    socket.on('data', (data) => socket.write(data))
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  t.after(() => {
    for (const s of peers) s.destroy()
    proxy.close()
  })
  const port = await relay(t, `http://fixture-user:p%40ss%3Aword@127.0.0.1:${proxy.address().port}`)
  const { status, reason, socket } = await tunnel(port, '[2001:db8::1]:443')
  t.after(() => socket.destroy())
  assert.equal(status, 200, reason)
  let received = Buffer.alloc(0)
  const done = new Promise((resolve) =>
    socket.on('data', (b) => {
      received = Buffer.concat([received, b])
      if (received.length === 9) resolve()
    }),
  )
  socket.write('ping')
  await done
  assert.equal(received.toString(), 'helloping')
  assert.deepEqual(requests, [
    { target: '[2001:db8::1]:443', auth: `Basic ${Buffer.from('fixture-user:p@ss:word').toString('base64')}` },
  ])
})

test('CLI bridge consumes a complete fragmented SOCKS reply without dropping tunneled bytes', {
  skip: !python,
  timeout: 10000,
}, async (t) => {
  const peers = new Set()
  const proxy = net.createServer((socket) => {
    peers.add(socket)
    socket.on('close', () => peers.delete(socket))
    socket.on('error', () => {})
    socket.once('data', () => {
      socket.write(Buffer.from([5]))
      setImmediate(() => socket.write(Buffer.from([0])))
      socket.once('data', () => {
        // IPv6 BND.ADDR is 16 bytes, followed by two port bytes and the tunnel banner.
        const reply = Buffer.concat([Buffer.from([5, 0, 0, 4]), Buffer.alloc(18), Buffer.from('hello')])
        socket.write(reply.subarray(0, 7))
        setImmediate(() => socket.write(reply.subarray(7)))
      })
    })
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  t.after(() => {
    for (const s of peers) s.destroy()
    proxy.close()
  })
  const port = await relay(t, `socks5h://127.0.0.1:${proxy.address().port}`)
  const { status, reason, socket } = await tunnel(port, 'target.invalid:443')
  t.after(() => socket.destroy())
  assert.equal(status, 200, reason)
  assert.equal((await once(socket, 'data'))[0].toString(), 'hello')
})
