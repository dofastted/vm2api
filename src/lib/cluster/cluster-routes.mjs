/**
 * /api/panel/cluster/* — HTTP routes (auth + ACL already enforced by the
 * panel handler) and the terminal WebSocket (auth by one-time ticket, because
 * browsers cannot put Authorization on a WebSocket handshake).
 */

import { WebSocketServer } from 'ws'
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

export function createClusterRoutes({ manager, json, readBody, ok }) {
  function fail(res, err) {
    const status = err instanceof ClusterError ? err.status : 500
    const code = err instanceof ClusterError ? err.code : 'cluster_error'
    return json(res, status, { ok: false, error: { type: 'cluster', code, message: err.message || String(err) } })
  }

  async function route(req, res, url) {
    const p = url.pathname
    const m = req.method

    if (p === `${PREFIX}/nodes` && m === 'GET') return json(res, 200, ok({ items: manager.list() }))
    if (p === `${PREFIX}/local` && m === 'GET') {
      return json(res, 200, ok(await manager.localStatus({ refresh: url.searchParams.get('refresh') === '1' })))
    }
    if (p === `${PREFIX}/nodes` && m === 'POST') {
      const body = await readBody(req, MAX_BODY)
      return json(res, 201, ok(manager.add(body)))
    }
    if (p === `${PREFIX}/nodes/probe` && m === 'POST') {
      const body = await readBody(req, MAX_BODY)
      return json(res, 200, ok(await manager.probe(body)))
    }

    const nm = NODE_RE.exec(p)
    if (!nm) return false
    const id = nm[1]
    const sub = nm[2] || ''

    if (sub === '' && m === 'GET') return json(res, 200, ok(manager.get(id)))
    if (sub === '' && m === 'DELETE') {
      await manager.remove(id)
      return json(res, 200, ok({ id }))
    }
    if (sub === '/reconnect' && m === 'POST') return json(res, 200, ok(manager.reconnect(id)))
    if (sub === '/shell-ticket' && m === 'POST') return json(res, 200, ok(manager.issueShellTicket(id)))

    if (sub === '/docker/info' && m === 'GET') return json(res, 200, ok(await dockerInfo(manager.docker(id))))
    if (sub === '/preflight' && m === 'POST') {
      const body = await readBody(req, MAX_BODY)
      return json(
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
      return json(
        res,
        202,
        ok(
          startSlotImageBuild(id, kernelOf(body.kernel), { runtime: runtimeKind({ runtime_type: body.runtime_type }) }),
        ),
      )
    }
    if (sub === '/slot-image' && m === 'GET') {
      manager.get(id)
      return json(
        res,
        200,
        ok(slotImageJob(id, kernelOf(url.searchParams.get('kernel')), url.searchParams.get('runtime_type'))),
      )
    }
    if (sub === '/docker/install' && m === 'POST') return json(res, 202, ok(manager.startDockerInstall(id)))
    if (sub === '/docker/install' && m === 'GET') return json(res, 200, ok(manager.get(id).install))
    if (sub === '/docker/containers' && m === 'GET') {
      return json(res, 200, ok({ items: await listContainers(manager.docker(id)) }))
    }
    if (sub === '/docker/containers' && m === 'POST') {
      const body = await readBody(req, MAX_BODY)
      return json(res, 201, ok(await createAndStartContainer(manager.docker(id), body)))
    }

    const cm = /^\/docker\/containers\/([^/]+)(?:\/(start|stop|restart|logs))?$/.exec(sub)
    if (cm) {
      const cid = decodeURIComponent(cm[1])
      const action = cm[2]
      if (!action && m === 'DELETE') {
        await removeContainer(manager.docker(id), cid)
        return json(res, 200, ok({ id: cid }))
      }
      if (action === 'logs' && m === 'GET') {
        const tail = clampInt(url.searchParams.get('tail'), 1, 5000, 200)
        return json(res, 200, ok(await containerLogs(manager.docker(id), cid, { tail })))
      }
      if (action && action !== 'logs' && m === 'POST') {
        await containerAction(manager.docker(id), cid, action)
        return json(res, 200, ok({ id: cid, action }))
      }
    }
    return false
  }

  async function handle(req, res, url) {
    if (!url.pathname.startsWith(`${PREFIX}/`)) return false
    try {
      const handled = await route(req, res, url)
      if (handled === false)
        return json(res, 404, { ok: false, error: { type: 'cluster', code: 'not_found', message: 'not found' } })
      return true
    } catch (err) {
      if (!(err instanceof ClusterError) && err?.status) {
        return json(res, err.status, {
          ok: false,
          error: { type: 'cluster', code: 'bad_request', message: err.message },
        })
      }
      return fail(res, err)
    }
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })

  function rejectUpgrade(socket, status, text) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }

  /** @returns {boolean} whether this upgrade belonged to the cluster shell */
  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url || '/', 'http://local')
    const sm = SHELL_RE.exec(url.pathname)
    if (!sm) return false
    const id = sm[1]
    if (!manager.consumeShellTicket(url.searchParams.get('ticket') || '', id)) {
      rejectUpgrade(socket, 401, 'Unauthorized')
      return true
    }
    const cols = clampInt(url.searchParams.get('cols'), 10, 500, 80)
    const rows = clampInt(url.searchParams.get('rows'), 5, 200, 24)
    wss.handleUpgrade(req, socket, head, (ws) => attachShell(ws, id, { cols, rows }))
    return true
  }

  async function attachShell(ws, id, size) {
    // Listen before the channel opens: input/resize sent during the SSH round
    // trip would otherwise be dropped (ws does not buffer unhandled messages).
    const pending = []
    let stream = null
    let closed = false
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
    })
    try {
      stream = await manager.openShell(id, size)
    } catch (err) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'error', message: err.message }))
      ws.close(1011)
      return
    }
    if (closed) {
      stream.close()
      return
    }
    stream.on('data', (chunk) => ws.readyState === ws.OPEN && ws.send(chunk))
    stream.stderr?.on('data', (chunk) => ws.readyState === ws.OPEN && ws.send(chunk))
    stream.on('exit', (code) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'exit', code })))
    stream.on('close', () => ws.close(1000))
    for (const msg of pending.splice(0)) apply(msg)
  }

  return { handle, handleUpgrade }
}
