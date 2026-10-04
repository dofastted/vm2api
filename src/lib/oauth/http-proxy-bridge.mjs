/**
 * Adapt an HTTP CONNECT exit to the bundled OAuth helper's SOCKS5-only input.
 * The listener is loopback-only, randomly authenticated, and scoped to one call.
 * Target TLS remains end-to-end inside the helper; only the proxy handshake changes.
 */
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { outboundProxyUrl } from '../vm/socks-address.mjs'

function read(socket, size) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('readable', ready)
      socket.off('close', closed)
      socket.off('end', closed)
      socket.off('error', failed)
    }
    const failed = (error) => {
      cleanup()
      reject(error)
    }
    const closed = () => failed(new Error('proxy connection closed'))
    const ready = () => {
      const data = socket.read(size)
      if (data !== null) {
        cleanup()
        resolve(data)
      } else if (socket.destroyed || socket.readableEnded) closed()
    }
    socket.on('readable', ready)
    socket.once('close', closed)
    socket.once('end', closed)
    socket.once('error', failed)
    ready()
  })
}

function connect(proxy, target, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const headers = { host: target }
    if (proxy.username || proxy.password) {
      const auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
      headers['proxy-authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`
    }
    const transport = proxy.protocol === 'https:' ? https : http
    const req = transport.request({
      hostname: proxy.hostname.replace(/^\[|\]$/g, ''),
      port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: target,
      headers,
      agent: false,
      signal,
      maxHeaderSize: 16384,
    })
    const timer = setTimeout(() => req.destroy(new Error('HTTP proxy CONNECT timeout')), timeoutMs)
    const finish = (error) => {
      clearTimeout(timer)
      reject(error)
    }
    req.once('error', finish)
    req.once('connect', (response, socket, head) => {
      clearTimeout(timer)
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`HTTP proxy CONNECT failed (${response.statusCode})`))
        return
      }
      if (head.length) socket.unshift(head)
      resolve(socket)
    })
    req.end()
  })
}

export async function withOAuthProxy(proxyUrl, run, { timeoutMs = 15000 } = {}) {
  if (!proxyUrl || !/^https?:\/\//i.test(proxyUrl)) return run(proxyUrl)
  const proxy = new URL(outboundProxyUrl({ url: proxyUrl }))
  const password = crypto.randomBytes(24).toString('hex')
  const timeout = Math.min(30000, Math.max(1000, Number(timeoutMs) || 15000))
  const clients = new Set()
  let lastProxyError = null
  const server = net.createServer((socket) => {
    clients.add(socket)
    socket.on('error', () => {})
    const controller = new AbortController()
    socket.once('close', () => {
      clients.delete(socket)
      controller.abort()
    })
    socket.setTimeout(timeout, () => socket.destroy())
    void (async () => {
      const greeting = await read(socket, 2)
      if (greeting[0] !== 5 || greeting[1] === 0) throw new Error('invalid SOCKS greeting')
      const methods = await read(socket, greeting[1])
      if (!methods.includes(2)) {
        socket.end(Buffer.from([5, 255]))
        return
      }
      socket.write(Buffer.from([5, 2]))
      const auth = await read(socket, 2)
      if (auth[0] !== 1 || auth[1] === 0) throw new Error('invalid SOCKS authentication')
      const username = (await read(socket, auth[1])).toString()
      const length = (await read(socket, 1))[0]
      if (length === 0) {
        socket.end(Buffer.from([1, 1]))
        return
      }
      const secret = (await read(socket, length)).toString()
      if (username !== 'oauth' || secret !== password) {
        socket.end(Buffer.from([1, 1]))
        return
      }
      socket.write(Buffer.from([1, 0]))
      const header = await read(socket, 4)
      if (header[0] !== 5 || header[1] !== 1 || header[2] !== 0) throw new Error('unsupported SOCKS command')
      let host
      if (header[3] === 1) host = [...(await read(socket, 4))].join('.')
      else if (header[3] === 3) host = (await read(socket, (await read(socket, 1))[0])).toString()
      else if (header[3] === 4) {
        const raw = await read(socket, 16)
        host = `[${Array.from({ length: 8 }, (_, i) => raw.readUInt16BE(i * 2).toString(16)).join(':')}]`
      } else throw new Error('unsupported SOCKS address')
      const port = (await read(socket, 2)).readUInt16BE()
      if (!host || /[\s/\\@?#\x00-\x1f\x7f]/.test(host) || (header[3] === 3 && host.includes(':')) || !port)
        throw new Error('invalid CONNECT target')
      const remote = await connect(proxy, `${host}:${port}`, controller.signal, timeout).catch((error) => {
        lastProxyError = error
        throw error
      })
      clients.add(remote)
      remote.on('error', () => socket.destroy())
      remote.once('close', () => {
        clients.delete(remote)
        socket.destroy()
      })
      socket.once('close', () => remote.destroy())
      if (socket.destroyed) {
        remote.destroy()
        return
      }
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
      socket.pipe(remote).pipe(socket)
    })().catch(() => socket.destroy())
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    return await run(`socks5h://oauth:${password}@127.0.0.1:${server.address().port}`)
  } catch (error) {
    if (lastProxyError) throw Object.assign(new Error(lastProxyError.message), { code: 'proxy_connect_failed' })
    throw error
  } finally {
    for (const socket of clients) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
}
