/**
 * Slot desktop companion: an optional browser desktop that shares a docker
 * slot's network namespace (`NetworkMode: container:<slot>`), so the browser
 * leaves through exactly the slot's egress (same exit IP, same DNS-over-TCP
 * redirect, UDP/QUIC dropped by the slot's egress rules). The slot image and
 * its read-only / cap-drop contract are untouched; the desktop lives in its own
 * container with its own memory and pids budget.
 *
 * Nothing listens on TCP: x11vnc serves RFB on a unix socket inside the
 * companion's private /tmp. The panel reaches it with a binary-safe docker exec
 * (`socat STDIO UNIX-CONNECT:…`) over the slot host's Engine API, so local and
 * cluster-node slots share one code path and no port is ever published.
 *
 * Joining a netns is resolved at container start, so a slot restart strands the
 * companion in the old namespace. `ensureSlotDesktop` restarts it whenever the
 * slot started after it, and is called on slot start / reload and before every
 * viewer session.
 */

import crypto from 'node:crypto'
import { WebSocketServer } from 'ws'
import {
  containerAction,
  createContainerRaw,
  ensureImage,
  imageIdOrNull,
  inspectContainerOrNull,
  openExecStream,
  removeContainer,
  removeVolume,
} from '../cluster/docker-remote.mjs'
import { validTimezone } from '../core/timezone.mjs'
import { OS_REGISTRY } from './os-catalog.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { slotHost } from './slot-host.mjs'
import { containerName } from './vm-runtime.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { getVm, patchVmRecord } from './vm-registry.mjs'

export const DESKTOP_IMAGE = String(process.env.KIN_DESKTOP_IMAGE || `${OS_REGISTRY}/kin-desktop:debian-12`)
export const DESKTOP_SOCKET = '/tmp/kin-desktop/vnc.sock'
const DESKTOP_MEMORY = parseBytes(process.env.KIN_DESKTOP_MEMORY, 1536 << 20)
const DESKTOP_PIDS = 1024
const DESKTOP_GEOMETRY = /^\d{3,4}x\d{3,4}x(16|24)$/.test(process.env.KIN_DESKTOP_GEOMETRY || '')
  ? process.env.KIN_DESKTOP_GEOMETRY
  : '1600x900x24'
const WS_RE = /^\/api\/panel\/vms\/([^/]+)\/desktop\/ws$/
const TICKET_TTL_MS = 30_000
const MAX_TICKETS = 64
const MAX_VIEWERS = 8
// Viewer input queued before the exec stream is up (RFB handshake is a few
// hundred bytes; anything near this is a misbehaving client).
const MAX_EARLY_BYTES = 1 << 20
// RFB framebuffer updates outrun a slow (cross-ocean) viewer; pause the exec
// stream above HIGH and resume once the socket drains below LOW, so ws send
// buffers stay bounded instead of growing with the backlog.
const WS_HIGH_WATER = 8 << 20
const WS_LOW_WATER = 1 << 20

function parseBytes(raw, dflt) {
  const m = /^(\d+)([kmg])?$/i.exec(String(raw || '').trim())
  if (!m) return dflt
  const mult = { k: 1 << 10, m: 1 << 20, g: 1 << 30 }[String(m[2] || '').toLowerCase()] || 1
  return Number(m[1]) * mult
}

function refuse(status, code, message) {
  return { ok: false, status, error: { code, message } }
}

export function desktopEnabled(vm) {
  return vm?.desktop?.enabled === true
}

/** Companion container and its persistent home volume, derived from the slot container name. */
export function desktopNames(vm) {
  const slot = vm?.runtime?.container || containerName(vm?.id)
  return { slot, container: `${slot}-desktop`, volume: `${slot}-desktop-home` }
}

/** @returns {null | {status:number, code:string, message:string}} why this slot cannot host a desktop */
export function desktopUnsupported(vm) {
  if (!vm) return { status: 404, code: 'vm_not_found', message: 'vm not found' }
  if (isCodexVm(vm)) return { status: 409, code: 'no_container', message: 'GPT 槽没有容器，无法挂载桌面' }
  if (isKvmRuntime(vm)) return { status: 409, code: 'kvm_unsupported', message: 'KVM 槽暂不支持伴生桌面' }
  if (slotHost(vm).native) return { status: 409, code: 'native_node_unsupported', message: '此节点不支持伴生桌面' }
  return null
}

/** Engine API create body. Pure: the slot container id pins the shared netns. */
export function desktopContainerBody(vm, { slotId, image = DESKTOP_IMAGE } = {}) {
  const { volume } = desktopNames(vm)
  return {
    Image: image,
    Env: [
      `TZ=${validTimezone(vm.timezone) || 'UTC'}`,
      `LANG=${vm.locale || 'en_US.UTF-8'}`,
      `KIN_DESKTOP_GEOMETRY=${DESKTOP_GEOMETRY}`,
      `KIN_DESKTOP_SOCKET=${DESKTOP_SOCKET}`,
    ],
    Labels: { 'kin.companion': 'desktop', 'kin.companion.vm': String(vm.id) },
    HostConfig: {
      NetworkMode: `container:${slotId}`,
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=512m' },
      Mounts: [{ Type: 'volume', Source: volume, Target: '/home/desktop' }],
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Memory: DESKTOP_MEMORY,
      MemorySwap: DESKTOP_MEMORY,
      PidsLimit: DESKTOP_PIDS,
      ShmSize: 256 << 20,
      RestartPolicy: { Name: 'no' },
    },
  }
}

/**
 * Decide what to do with an existing companion. Pure. `imageId` is the engine's
 * current id for `image`: a re-pulled or rebuilt tag keeps its name, so only the
 * id tells that the companion runs an outdated image.
 * @returns {'create'|'recreate'|'start'|'restart'|'ok'}
 */
export function desktopAction(slot, companion, image = DESKTOP_IMAGE, imageId = null) {
  if (!companion) return 'create'
  if (
    companion.HostConfig?.NetworkMode !== `container:${slot.Id}` ||
    companion.Config?.Image !== image ||
    (imageId && companion.Image !== imageId)
  ) {
    return 'recreate'
  }
  if (!companion.State?.Running) return 'start'
  const slotStarted = Date.parse(slot.State?.StartedAt || '') || 0
  const ownStarted = Date.parse(companion.State?.StartedAt || '') || 0
  return ownStarted < slotStarted ? 'restart' : 'ok'
}

const inFlight = new Map()

/**
 * Collapse concurrent calls sharing `key` into one in-flight promise. Pure
 * helper (exported for tests): the slot-start follow hook and a viewer ticket
 * routinely race on the same companion, and two parallel creates of one
 * container name lose to a 409 conflict.
 */
export function singleFlight(key, fn) {
  const running = inFlight.get(key)
  if (running) return running
  const p = Promise.resolve()
    .then(fn)
    .finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}

/** Bring the companion in line with the running slot. Idempotent; concurrent calls per companion share one run. */
export function ensureSlotDesktop(vm, opts = {}) {
  const unsupported = desktopUnsupported(vm)
  if (unsupported) return Promise.resolve({ ok: false, ...unsupported })
  const key = `${vm.node_id || 'local'}:${desktopNames(vm).container}`
  return singleFlight(key, () => ensureSlotDesktopOnce(vm, opts))
}

async function ensureSlotDesktopOnce(vm, { connect = slotHost(vm).dockerApi(), image = DESKTOP_IMAGE } = {}) {
  const names = desktopNames(vm)
  const slot = await inspectContainerOrNull(connect, names.slot)
  if (!slot?.State?.Running) {
    return { ok: false, status: 409, code: 'slot_not_running', message: '槽位容器未运行，先启动槽位' }
  }
  const companion = await inspectContainerOrNull(connect, names.container)
  const imageId = companion ? await imageIdOrNull(connect, image) : null
  const action = desktopAction(slot, companion, image, imageId)
  if (action === 'recreate') await removeContainer(connect, names.container)
  if (action === 'create' || action === 'recreate') {
    await ensureImage(connect, image)
    await createContainerRaw(connect, names.container, desktopContainerBody(vm, { slotId: slot.Id, image }))
    await containerAction(connect, names.container, 'start')
  } else if (action === 'start') {
    await containerAction(connect, names.container, 'start')
  } else if (action === 'restart') {
    await containerAction(connect, names.container, 'restart', { t: 5 })
  }
  return { ok: true, action, container: names.container }
}

/** Stop the viewer side only: the companion container goes, the browser profile volume stays. */
export async function stopSlotDesktop(vm, { connect = slotHost(vm).dockerApi() } = {}) {
  if (desktopUnsupported(vm)) return { ok: true, skipped: true }
  const { container } = desktopNames(vm)
  if (await inspectContainerOrNull(connect, container)) await removeContainer(connect, container)
  return { ok: true }
}

/** Slot reset / delete: drop the companion and its browser profile. */
export async function destroySlotDesktop(vm, { connect = slotHost(vm).dockerApi() } = {}) {
  if (desktopUnsupported(vm)) return { ok: true, skipped: true }
  const { volume } = desktopNames(vm)
  await stopSlotDesktop(vm, { connect })
  await removeVolume(connect, volume)
  return { ok: true }
}

export async function slotDesktopStatus(vm, { connect } = {}) {
  const unsupported = desktopUnsupported(vm)
  const base = { enabled: desktopEnabled(vm), supported: !unsupported, image: DESKTOP_IMAGE }
  if (unsupported) return { ...base, state: 'unsupported', reason: unsupported.code }
  const c = connect || slotHost(vm).dockerApi()
  const names = desktopNames(vm)
  const [slot, companion] = await Promise.all([
    inspectContainerOrNull(c, names.slot),
    inspectContainerOrNull(c, names.container),
  ])
  let state = 'absent'
  if (companion) {
    state = slot?.State?.Running && desktopAction(slot, companion) === 'ok' ? 'running' : 'stale'
  }
  return { ...base, state, container: names.container }
}

/**
 * Lifecycle hook for slot start / reload: never blocks or fails the slot.
 * First use may pull the desktop image, so this runs in the background.
 */
export function followSlotDesktop(vm, logger = console) {
  if (!desktopEnabled(vm) || desktopUnsupported(vm)) return
  void ensureSlotDesktop(vm).then(
    (r) => {
      if (!r.ok) logger.warn?.('[slot-desktop]', vm.id, r.code || r.message)
    },
    (e) => logger.warn?.('[slot-desktop]', vm.id, e?.message || e),
  )
}

/** Panel toggle: persist `desktop.enabled`, then converge the container. */
export async function setSlotDesktopEnabled(projectRoot, id, enabled) {
  const vm = getVm(projectRoot, id)
  const unsupported = desktopUnsupported(vm)
  if (unsupported) return { ok: false, ...unsupported }
  const next = patchVmRecord(projectRoot, id, { desktop: { ...(vm.desktop || {}), enabled } })
  if (!enabled) {
    await stopSlotDesktop(next)
    return { ok: true, enabled: false, state: 'absent' }
  }
  const r = await ensureSlotDesktop(next)
  // Enabled while the slot is stopped is valid: the next slot start brings it up.
  if (!r.ok && r.code !== 'slot_not_running') return r
  return { ok: true, enabled: true, state: r.ok ? 'running' : 'pending_slot_start' }
}

/**
 * Viewer: `POST /api/panel/vms/:id/desktop-ticket` (panel auth + ACL) trades the
 * session for a 30s single-use ticket; `GET /api/panel/vms/:id/desktop/ws?ticket=`
 * upgrades to a binary WebSocket carrying raw RFB, which noVNC speaks natively.
 */
export function createSlotDesktop({ projectRoot, logger = console, ops = {} } = {}) {
  const ensure = ops.ensureSlotDesktop || ensureSlotDesktop
  const openStream = ops.openExecStream || openExecStream
  const tickets = new Map()
  let viewers = 0
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 << 20,
    handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
  })

  async function issueTicket(vmId) {
    const vm = getVm(projectRoot, vmId)
    const unsupported = desktopUnsupported(vm)
    if (unsupported) return refuse(unsupported.status, unsupported.code, unsupported.message)
    if (!desktopEnabled(vm)) return refuse(409, 'desktop_disabled', '该槽未启用桌面，请先开启')
    if (viewers >= MAX_VIEWERS) return refuse(429, 'desktop_limit', `桌面会话已达上限 ${MAX_VIEWERS}`)
    let ready
    try {
      ready = await ensure(vm)
    } catch (e) {
      return refuse(502, 'desktop_start_failed', String(e?.message || e).slice(0, 240))
    }
    if (!ready.ok) return refuse(ready.status || 409, ready.code, ready.message)
    const now = Date.now()
    for (const [t, v] of tickets) if (v.exp <= now) tickets.delete(t)
    if (tickets.size >= MAX_TICKETS) return refuse(429, 'desktop_limit', '桌面 ticket 过多，请稍后再试')
    const ticket = crypto.randomBytes(24).toString('base64url')
    tickets.set(ticket, { vmId: vm.id, exp: now + TICKET_TTL_MS })
    return { ok: true, ticket, expires_in: TICKET_TTL_MS / 1000 }
  }

  function consumeTicket(ticket, vmId) {
    const entry = tickets.get(ticket)
    tickets.delete(ticket)
    if (!entry || entry.vmId !== vmId || entry.exp <= Date.now()) return null
    return entry
  }

  function rejectUpgrade(socket, status, text) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }

  /** @returns {boolean} whether this upgrade belonged to the slot desktop */
  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url || '/', 'http://local')
    const m = WS_RE.exec(url.pathname)
    if (!m) return false
    const vmId = decodeURIComponent(m[1])
    if (!consumeTicket(url.searchParams.get('ticket') || '', vmId)) {
      rejectUpgrade(socket, 401, 'Unauthorized')
      return true
    }
    const vm = getVm(projectRoot, vmId)
    if (desktopUnsupported(vm)) {
      rejectUpgrade(socket, 404, 'Not Found')
      return true
    }
    if (viewers >= MAX_VIEWERS) {
      rejectUpgrade(socket, 429, 'Too Many Requests')
      return true
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      viewers += 1
      void attach(ws, vm)
    })
    return true
  }

  async function attach(ws, vm) {
    let stream = null
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      viewers -= 1
      stream?.destroy()
      if (ws.readyState === ws.OPEN) ws.close()
    }
    ws.on('close', close)
    ws.on('error', close)
    // Bytes the viewer sends before the exec stream is up are queued, not lost (bounded).
    const early = []
    let earlyBytes = 0
    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (stream && !stream.destroyed) stream.write(buf)
      else if (!stream) {
        earlyBytes += buf.length
        if (earlyBytes > MAX_EARLY_BYTES) {
          if (ws.readyState === ws.OPEN) ws.close(1009, 'desktop_input_overflow')
          close()
          return
        }
        early.push(buf)
      }
    })
    let paused = false
    const onSent = () => {
      if (paused && ws.bufferedAmount < WS_LOW_WATER && stream && !stream.destroyed) {
        paused = false
        stream.resume()
      }
    }
    try {
      const { container } = desktopNames(vm)
      ;({ stream } = await openStream(slotHost(vm).dockerApi(), container, {
        cmd: ['socat', 'STDIO', `UNIX-CONNECT:${DESKTOP_SOCKET}`],
        onStdout: (chunk) => {
          if (ws.readyState !== ws.OPEN) return
          ws.send(chunk, { binary: true }, onSent)
          if (!paused && ws.bufferedAmount > WS_HIGH_WATER && stream && !stream.destroyed) {
            paused = true
            stream.pause()
          }
        },
        onStderr: (chunk) => logger.warn?.('[slot-desktop]', vm.id, String(chunk).trim().slice(0, 200)),
      }))
    } catch (e) {
      logger.warn?.('[slot-desktop] attach', vm.id, e?.message || e)
      if (ws.readyState === ws.OPEN) ws.close(1011, 'desktop_unavailable')
      close()
      return
    }
    if (closed) {
      stream.destroy()
      return
    }
    stream.on('close', close)
    stream.on('error', close)
    for (const buf of early.splice(0)) stream.write(buf)
  }

  return { issueTicket, handleUpgrade, viewerCount: () => viewers }
}
