import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import {
  normalizeNodeBinding,
  normalizeNodeCommand,
  normalizeNodeCompletion,
  sameNodeBinding,
} from '../core/node-execution-proof.mjs'

function failure(code) {
  return Object.assign(new Error(code.replaceAll('_', ' ')), { code })
}
function freeze(value) {
  for (const item of Object.values(value)) if (item && typeof item === 'object') freeze(item)
  return Object.freeze(value)
}
function wire(value) {
  return JSON.stringify(value, (key, item) => (key === 'generation' ? JSON.rawJSON(item) : item))
}
function parse(value) {
  return JSON.parse(value, (key, item, context) =>
    key === 'generation' && typeof item === 'number' ? context.source : item,
  )
}

// The gate reads the full request before replying OK. This Duplex sends HTTP
// immediately, while consuming only the bounded gate prefix before HTTP parses.
class ForwardSocket extends Duplex {
  constructor(socket) {
    super()
    this.target = socket
    let prefix = Buffer.alloc(0)
    let accepted = false
    socket.on('data', (chunk) => {
      if (!accepted) {
        prefix = Buffer.concat([prefix, chunk])
        const newline = prefix.indexOf(10)
        if (newline < 0) {
          if (prefix.length > 128) this.destroy(failure('slotgate_bad_reply'))
          return
        }
        if (newline > 128 || prefix.subarray(0, newline).toString() !== 'OK') {
          this.destroy(failure('slotgate_forward_rejected'))
          return
        }
        accepted = true
        chunk = prefix.subarray(newline + 1)
        prefix = null
      }
      if (chunk.length && !this.push(chunk)) socket.pause()
    })
    socket.once('end', () => {
      if (!accepted) this.destroy(failure('slotgate_bad_reply'))
      else this.push(null)
    })
    socket.once('error', (error) => this.destroy(error))
    socket.once('close', () => {
      if (!socket.readableEnded) this.destroy(failure('slotgate_disconnected'))
    })
  }
  _read() {
    this.target.resume()
  }
  _write(chunk, encoding, callback) {
    this.target.write(chunk, encoding, callback)
  }
  _final(callback) {
    this.target.end(callback)
  }
  _destroy(error, callback) {
    this.target.destroy()
    callback(error)
  }
  setTimeout(...args) {
    this.target.setTimeout(...args)
    return this
  }
  setNoDelay(...args) {
    this.target.setNoDelay(...args)
    return this
  }
  setKeepAlive(...args) {
    this.target.setKeepAlive(...args)
    return this
  }
  ref() {
    this.target.ref()
    return this
  }
  unref() {
    this.target.unref()
    return this
  }
}

/** Explicit, trusted configuration only. No KSG1, UDS or SSH fallback exists. */
export class SlotgateClient {
  constructor(config) {
    try {
      if (config?.trusted !== true || config.pgBindingReady !== true) throw failure('slotgate_capability_invalid')
      Object.defineProperty(this, 'nodeBinding', {
        value: freeze(
          normalizeNodeBinding({
            protocol: 'KSG2',
            nodeId: config.nodeId,
            vmId: config.vmId,
            kind: 'kernel',
            fence: config.fence,
          }),
        ),
        enumerable: true,
      })
      const link = config.link
      if (
        !link ||
        !net.isIP(link.address) ||
        !Number.isInteger(link.port) ||
        link.port < 1 ||
        link.port > 65535 ||
        typeof link.token !== 'string' ||
        !/^[\x21-\x7e]{1,256}$/.test(link.token) ||
        !/^[a-f0-9]{64}$/.test(link.certSha256)
      )
        throw failure('slotgate_capability_invalid')
      this.link = freeze({ address: link.address, port: link.port, token: link.token, certSha256: link.certSha256 })
    } catch {
      throw failure('slotgate_capability_invalid')
    }
    this.handles = new WeakSet()
  }

  assertBinding(acknowledgement, requestId) {
    try {
      if (
        acknowledgement?.bound !== true ||
        acknowledgement.requestId !== requestId ||
        !sameNodeBinding(acknowledgement.nodeBinding, this.nodeBinding)
      )
        throw failure('slotgate_binding_unconfirmed')
    } catch {
      throw failure('slotgate_binding_unconfirmed')
    }
  }

  _command(op, requestId, ticket) {
    const value = {
      op,
      vm_id: this.nodeBinding.vmId,
      fence: this.nodeBinding.fence,
      command_id: requestId,
      kind: this.nodeBinding.kind,
    }
    if (ticket) value.ticket = ticket
    return value
  }

  _connect(timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false
      const socket = tls.connect({
        host: this.link.address,
        port: this.link.port,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3',
        allowHalfOpen: true,
      })
      const fail = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        reject(error)
      }
      const timer = setTimeout(() => fail(failure('slotgate_timeout')), timeoutMs)
      socket.once('error', fail)
      socket.once('close', () => fail(failure('slotgate_disconnected')))
      socket.once('secureConnect', () => {
        const pin = socket.getPeerCertificate()?.fingerprint256?.replaceAll(':', '').toLowerCase()
        if (pin !== this.link.certSha256) return fail(failure('slotgate_cert_mismatch'))
        settled = true
        clearTimeout(timer)
        socket.off('error', fail)
        // Install an error observer until the protocol consumer attaches.
        socket.on('error', () => {})
        resolve(socket)
      })
    })
  }

  async _rpc(command, timeoutMs = 3000) {
    const socket = await this._connect(timeoutMs)
    return new Promise((resolve, reject) => {
      let settled = false
      let buffer = Buffer.alloc(0)
      const done = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.removeAllListeners('data')
        socket.destroy()
        if (error) reject(error)
        else resolve(value)
      }
      const timer = setTimeout(() => done(failure('slotgate_timeout')), timeoutMs)
      socket.once('error', (error) => done(error))
      socket.once('end', () => done(failure('slotgate_bad_reply')))
      socket.once('close', () => done(failure('slotgate_disconnected')))
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        const newline = buffer.indexOf(10)
        if (buffer.length > 8192) return done(failure('slotgate_bad_reply'))
        if (newline < 0) return
        try {
          const reply = parse(buffer.subarray(0, newline).toString())
          if (reply?.ok !== true) return done(failure('slotgate_proof_unavailable'))
          done(null, reply)
        } catch (error) {
          done(error)
        }
      })
      socket.write(`KSG2 ${this.link.token}\n${wire(command)}\n`)
    })
  }

  async prepare(requestId) {
    if (
      typeof requestId !== 'string' ||
      !requestId ||
      requestId.trim() !== requestId ||
      requestId.length > 256 ||
      /[\x00-\x1f\x7f]/.test(requestId)
    )
      throw failure('slotgate_request_invalid')
    const reply = await this._rpc(this._command('prepare', requestId))
    if (typeof reply.ticket !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(reply.ticket))
      throw failure('slotgate_bad_reply')
    const handle = freeze({ requestId, ticket: reply.ticket })
    this.handles.add(handle)
    return handle
  }

  async completion(handle) {
    if (!this.handles.has(handle)) throw failure('slotgate_ticket_invalid')
    const deadline = Date.now() + 1000
    for (;;) {
      const reply = await this._rpc(this._command('command', handle.requestId, handle.ticket))
      const command = normalizeNodeCommand(reply.command, {
        requestId: handle.requestId,
        nodeBinding: this.nodeBinding,
      })
      // A body can arrive just before the node's completion fsync. Retry only
      // this read; a mismatch, unknown or unavailable proof ends the wait.
      if (command.status !== 'pending' || !command.dispatched || Date.now() >= deadline)
        return normalizeNodeCompletion(command, { requestId: handle.requestId, nodeBinding: this.nodeBinding })
      await delay(50)
    }
  }

  forward(
    handle,
    { method = 'POST', requestPath, body, headers, signal, timeoutMs = 180000, timeoutMode = 'overall' },
  ) {
    if (
      !this.handles.has(handle) ||
      method !== 'POST' ||
      requestPath !== '/internal/v1/messages' ||
      body?.request_id !== handle.requestId
    )
      return Promise.reject(failure('slotgate_request_invalid'))
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body))
      if (payload.length > 15 * 1024 * 1024) return reject(failure('slotgate_request_invalid'))
      const agent = new http.Agent({ keepAlive: false })
      agent.createConnection = (_options, callback) => {
        this._connect(Math.min(3000, timeoutMs)).then((socket) => {
          if (request.destroyed) {
            socket.destroy()
            return
          }
          const forwarded = new ForwardSocket(socket)
          socket.write(`KSG2 ${this.link.token}\n${wire(this._command('forward', handle.requestId, handle.ticket))}\n`)
          callback(null, forwarded)
        }, callback)
      }
      let timer
      const request = http.request(
        {
          host: 'slotgate',
          path: requestPath,
          method,
          agent,
          signal,
          headers: {
            ...headers,
            'content-type': 'application/json',
            'content-length': payload.length,
            connection: 'close',
          },
        },
        (response) => {
          if (timeoutMode === 'first-byte') clearTimeout(timer)
          response.once('close', () => {
            clearTimeout(timer)
            agent.destroy()
          })
          resolve(response)
        },
      )
      timer = setTimeout(() => request.destroy(failure('worker_timeout')), Math.max(1, timeoutMs))
      request.once('error', (error) => {
        clearTimeout(timer)
        agent.destroy()
        reject(error)
      })
      request.end(payload)
    })
  }
}
