/**
 * /api/panel/cluster/* — HTTP routes (auth + ACL already enforced by the
 * panel handler) and the terminal WebSocket (auth by one-time ticket, because
 * browsers cannot put Authorization on a WebSocket handshake).
 */

import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import {
  containerAction,
  containerLogs,
  createAndStartContainer,
  dockerInfo,
  listContainers,
  removeContainer,
} from './docker-remote.mjs'
import { preflightNode, slotImageJob, startSlotImageBuild } from './placement.mjs'
import { ClusterError } from './ssh-link.mjs'
import { runtimeKind } from '../vm/runtime-kind.mjs'

function kernelOf(value) {
  const kernel = String(value || '').trim()
  if (!/^[a-z0-9.-]{1,32}$/.test(kernel)) throw new ClusterError(400, 'invalid_kernel', '缺少或非法的 kernel')
  return kernel
}

const PREFIX = '/api/panel/cluster'
const NODE_RE = /^\/api\/panel\/cluster\/nodes\/([a-z0-9-]{1,64})(\/.*)?$/
const SHELL_RE = /^\/api\/panel\/cluster\/nodes\/([a-z0-9-]{1,64})\/shell$/
const MAX_BODY = 64 * 1024

function clampInt(v, lo, hi, dflt) {
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

export function createClusterRoutes({ manager, json, readBody, ok, onExecutionState = null }) {
  function fail(res, err, respond = json) {
    const status = err instanceof ClusterError ? err.status : 500
    const code = err instanceof ClusterError ? err.code : 'cluster_error'
    return respond(res, status, { ok: false, error: { type: 'cluster', code, message: err.message || String(err) } })
  }

  async function route(req, res, url, respond = json) {
    const p = url.pathname
    const m = req.method

    if (p === `${PREFIX}/nodes` && m === 'GET') return respond(res, 200, ok({ items: manager.list() }))
    if (p === `${PREFIX}/local` && m === 'GET') {
      return respond(res, 200, ok(await manager.localStatus({ refresh: url.searchParams.get('refresh') === '1' })))
    }
    if (p === `${PREFIX}/nodes` && m === 'POST') {
      const body = await readBody(req, MAX_BODY)
      return respond(res, 201, ok(await manager.add(body)))
    }
    if (p === `${PREFIX}/nodes/probe` && m === 'POST') {
      const body = await readBody(req, MAX_BODY)
      return respond(res, 200, ok(await manager.probe(body)))
    }

    const nm = NODE_RE.exec(p)
    if (!nm) return false
    const id = nm[1]
    const sub = nm[2] || ''

    if (sub === '' && m === 'GET') return respond(res, 200, ok(manager.get(id)))
    if (sub === '' && m === 'PATCH') {
      const body = await readBody(req, MAX_BODY)
      return respond(res, 200, ok(await manager.update(id, body)))
    }
    if (sub === '/probe' && m === 'POST') {
      const body = await readBody(req, MAX_BODY)
      return respond(res, 200, ok(await manager.probeUpdate(id, body)))
    }
    if (sub === '' && m === 'DELETE') {
      await manager.remove(id)
      return respond(res, 200, ok({ id }))
    }
    if (sub === '/reconnect' && m === 'POST') return respond(res, 200, ok(manager.reconnect(id)))
    if (sub === '/direct-link' && m === 'PUT') {
      const body = await readBody(req, MAX_BODY)
      return respond(res, 200, ok(await manager.setDirectLink(id, body)))
    }
    if (sub === '/direct-link' && m === 'DELETE') return respond(res, 200, ok(await manager.clearDirectLink(id)))
    if (sub === '/shell-ticket' && m === 'POST') return respond(res, 200, ok(await manager.issueShellTicket(id)))

    if (sub === '/docker/info' && m === 'GET') return respond(res, 200, ok(await dockerInfo(manager.docker(id))))
    if (sub === '/preflight' && m === 'POST') {
      const body = await readBody(req, MAX_BODY)
      return respond(
        res,
        200,
        ok(
          await preflightNode(id, {
            kernel: kernelOf(body.kernel),
            runtime: runtimeKind({ runtime_type: body.runtime_type }),
          }),
        ),
      )
    }
    if (sub === '/slot-image' && m === 'POST') {
      const body = await readBody(req, MAX_BODY)
      manager.get(id)
      return respond(
        res,
        202,
        ok(
          startSlotImageBuild(id, kernelOf(body.kernel), { runtime: runtimeKind({ runtime_type: body.runtime_type }) }),
        ),
      )
    }
    if (sub === '/slot-image' && m === 'GET') {
      manager.get(id)
      return respond(
        res,
        200,
        ok(slotImageJob(id, kernelOf(url.searchParams.get('kernel')), url.searchParams.get('runtime_type'))),
      )
    }
    if (sub === '/docker/install' && m === 'POST') return respond(res, 202, ok(manager.startDockerInstall(id)))
    if (sub === '/docker/install' && m === 'GET') return respond(res, 200, ok(manager.get(id).install))
    if (sub === '/docker/containers' && m === 'GET') {
      return respond(res, 200, ok({ items: await listContainers(manager.docker(id)) }))
    }
    if (sub === '/docker/containers' && m === 'POST') {
      const body = await readBody(req, MAX_BODY)
      return respond(res, 201, ok(await createAndStartContainer(manager.docker(id), body)))
    }

    const cm = /^\/docker\/containers\/([^/]+)(?:\/(start|stop|restart|logs))?$/.exec(sub)
    if (cm) {
      const cid = decodeURIComponent(cm[1])
      const action = cm[2]
      if (!action && m === 'DELETE') {
        await removeContainer(manager.docker(id), cid)
        return respond(res, 200, ok({ id: cid }))
      }
      if (action === 'logs' && m === 'GET') {
        const tail = clampInt(url.searchParams.get('tail'), 1, 5000, 200)
        return respond(res, 200, ok(await containerLogs(manager.docker(id), cid, { tail })))
      }
      if (action && action !== 'logs' && m === 'POST') {
        await containerAction(manager.docker(id), cid, action)
        return respond(res, 200, ok({ id: cid, action }))
      }
    }
    return false
  }

  async function handle(req, res, url, respond = json) {
    if (!url.pathname.startsWith(`${PREFIX}/`)) return false
    try {
      const handled = await route(req, res, url, respond)
      if (handled === false)
        return respond(res, 404, { ok: false, error: { type: 'cluster', code: 'not_found', message: 'not found' } })
      return true
    } catch (err) {
      if (!(err instanceof ClusterError) && err?.status) {
        return respond(res, err.status, {
          ok: false,
          error: { type: 'cluster', code: 'bad_request', message: err.message },
        })
      }
      return fail(res, err, respond)
    }
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })
  const pending = new Set()
  let draining = false
  let drainError = null
  function track(task) {
    const tracked = Promise.resolve(task)
      .catch((error) => {
        drainError ||= error
      })
      .finally(() => pending.delete(tracked))
    pending.add(tracked)
  }

  function rejectUpgrade(socket, status, text) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }

  /** @returns {boolean} whether this upgrade belonged to the cluster shell */
  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url || '/', 'http://local')
    const sm = SHELL_RE.exec(url.pathname)
    if (!sm) return false
    const requestId = randomUUID()
    const reject = (status, text) => {
      if (!onExecutionState) return rejectUpgrade(socket, status, text)
      track(
        Promise.resolve()
          .then(() =>
            onExecutionState(req, {
              requestId,
              started: false,
              ended: true,
              reason: 'not_started',
              phase: 'complete',
            }),
          )
          .then(() => rejectUpgrade(socket, status, text)),
      )
    }
    if (draining) {
      reject(503, 'Service Unavailable')
      return true
    }
    const id = sm[1]
    const accept = (authorized) => {
      if (!authorized) return reject(401, 'Unauthorized')
      if (draining || socket.destroyed) return reject(503, 'Service Unavailable')
      const cols = clampInt(url.searchParams.get('cols'), 10, 500, 80)
      const rows = clampInt(url.searchParams.get('rows'), 5, 200, 24)
      wss.handleUpgrade(req, socket, head, (ws) => {
        track(new Promise((resolve) => ws.once('close', resolve)))
        track(attachShell(ws, id, { cols, rows }, req, requestId))
      })
    }
    const consumed = manager.consumeShellTicket(url.searchParams.get('ticket') || '', id)
    if (typeof consumed?.then === 'function') {
      track(consumed.then(accept, () => reject(503, 'Service Unavailable')))
    } else accept(consumed)
    return true
  }

  async function attachShell(ws, id, size, req, requestId) {
    // Listen before the channel opens: input/resize sent during the SSH round
    // trip would otherwise be dropped (ws does not buffer unhandled messages).
    const pending = []
    let stream = null
    let closed = false
    let started = false
    let completed = false
    const finish = async (ended, reason) => {
      if (completed) return
      completed = true
      await onExecutionState?.(req, { requestId, started, ended, reason, phase: 'complete' })
    }
    const apply = (msg) => {
      if (msg?.t === 'd' && typeof msg.d === 'string') stream.write(msg.d)
      else if (msg?.t === 'r') stream.setWindow(clampInt(msg.r, 5, 200, 24), clampInt(msg.c, 10, 500, 80), 0, 0)
    }
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return
      let msg
      try {
        msg = JSON.parse(raw.toString('utf8'))
      } catch {
        return
      }
      if (stream) apply(msg)
      else if (pending.length < 256) pending.push(msg)
    })
    ws.on('close', () => {
      closed = true
      stream?.close()
      if (stream) track(finish(false, 'client_closed'))
    })
    try {
      await onExecutionState?.(req, { requestId, started: true, ended: false, reason: 'started', phase: 'start' })
      if (closed || draining) {
        await finish(true, 'not_started')
        return
      }
      started = true
      stream = await manager.openShell(id, size)
    } catch (err) {
      await finish(!started, started ? 'ssh_open_failed' : 'not_started')
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'error', message: err.message }))
      ws.close(1011)
      return
    }
    stream.on('exit', () => track(finish(true, 'ssh_exit')))
    stream.on('close', () => {
      track(finish(false, 'ssh_channel_closed'))
      ws.close(1000)
    })
    if (closed) {
      stream.close()
      await finish(false, 'client_closed')
      return
    }
    stream.on('data', (chunk) => ws.readyState === ws.OPEN && ws.send(chunk))
    stream.stderr?.on('data', (chunk) => ws.readyState === ws.OPEN && ws.send(chunk))
    stream.on('exit', (code) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'exit', code })))
    for (const msg of pending.splice(0)) apply(msg)
  }

  function beginDrain() {
    draining = true
    for (const ws of wss.clients) ws.close(1001, 'Control plane is draining')
  }

  async function drain() {
    beginDrain()
    while (pending.size) await Promise.all([...pending])
    if (drainError) throw drainError
  }

  function terminate() {
    draining = true
    for (const ws of wss.clients) ws.terminate()
  }

  return { handle, handleUpgrade, beginDrain, drain, terminate }
}
