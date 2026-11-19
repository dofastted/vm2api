import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createDockerFrameDecoder } from '../../src/lib/cluster/docker-remote.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'
import { isCodexVm } from '../../src/lib/vm/vm-kind.mjs'
import { isKvmRuntime } from '../../src/lib/vm/runtime-kind.mjs'
import {
  DESKTOP_SOCKET,
  createSlotDesktop,
  desktopAction,
  desktopContainerBody,
  desktopNames,
  desktopUnsupported,
  singleFlight,
} from '../../src/lib/vm/slot-desktop.mjs'

const IMAGE = 'ghcr.io/example/kin-desktop:debian-12'

function frame(type, text) {
  const payload = Buffer.from(text)
  const head = Buffer.alloc(8)
  head[0] = type
  head.writeUInt32BE(payload.length, 4)
  return Buffer.concat([head, payload])
}

test('docker frame decoder demuxes stdout/stderr across chunk boundaries', () => {
  const seen = []
  const decode = createDockerFrameDecoder((type, buf) => seen.push([type, buf.toString()]))
  const wire = Buffer.concat([frame(1, 'RFB 003.008\n'), frame(2, 'warn'), frame(1, ''), frame(1, '\x03\r\x00')])
  // Feed byte by byte: frames must reassemble regardless of how the socket splits them.
  for (const b of wire) decode(Buffer.from([b]))
  assert.deepEqual(seen, [
    [1, 'RFB 003.008\n'],
    [2, 'warn'],
    [1, '\x03\r\x00'],
  ])
})

test('desktop companion joins the slot netns and keeps the slot hardening', () => {
  const vm = { id: 'vm-07', timezone: 'America/Chicago', locale: 'en_US.UTF-8' }
  const body = desktopContainerBody(vm, { slotId: 'abc123', image: IMAGE })
  assert.equal(body.Image, IMAGE)
  assert.equal(body.HostConfig.NetworkMode, 'container:abc123')
  assert.equal(body.HostConfig.ReadonlyRootfs, true)
  assert.deepEqual(body.HostConfig.CapDrop, ['ALL'])
  assert.deepEqual(body.HostConfig.SecurityOpt, ['no-new-privileges'])
  assert.equal(body.HostConfig.PortBindings, undefined, 'no port is ever published')
  assert.equal(body.ExposedPorts, undefined)
  assert.deepEqual(body.HostConfig.Mounts, [{ Type: 'volume', Source: 'kin-07-desktop-home', Target: '/home/desktop' }])
  assert.ok(body.Env.includes('TZ=America/Chicago'))
  assert.ok(body.Env.includes(`KIN_DESKTOP_SOCKET=${DESKTOP_SOCKET}`))
  assert.equal(body.Labels['kin.vm'], undefined, 'companion must stay out of slot listings')
  assert.equal(body.Labels['kin.companion'], 'desktop')
})

test('desktop companion falls back to UTC for an invalid timezone', () => {
  const body = desktopContainerBody({ id: 'vm-1', timezone: 'Mars/Base' }, { slotId: 'x', image: IMAGE })
  assert.ok(body.Env.includes('TZ=UTC'))
})

test('desktop names follow the recorded slot container', () => {
  assert.deepEqual(desktopNames({ id: 'vm-03' }), {
    slot: 'kin-03',
    container: 'kin-03-desktop',
    volume: 'kin-03-desktop-home',
  })
  assert.equal(desktopNames({ id: 'vm-03', runtime: { container: 'kin-custom' } }).container, 'kin-custom-desktop')
})

test('desktopAction follows the slot netns', () => {
  const slot = { Id: 's1', State: { Running: true, StartedAt: '2026-11-18T10:00:00Z' } }
  const good = {
    HostConfig: { NetworkMode: 'container:s1' },
    Config: { Image: IMAGE },
    State: { Running: true, StartedAt: '2026-11-18T10:00:05Z' },
  }
  assert.equal(desktopAction(slot, null, IMAGE), 'create')
  assert.equal(desktopAction(slot, good, IMAGE), 'ok')
  // Slot recreated: new container id, old netns is gone.
  assert.equal(desktopAction({ ...slot, Id: 's2' }, good, IMAGE), 'recreate')
  // Desktop image upgraded.
  assert.equal(desktopAction(slot, good, 'other:tag'), 'recreate')
  // Same tag re-pulled / rebuilt: the image id moved under the companion.
  assert.equal(desktopAction(slot, { ...good, Image: 'sha256:old' }, IMAGE, 'sha256:new'), 'recreate')
  assert.equal(desktopAction(slot, { ...good, Image: 'sha256:new' }, IMAGE, 'sha256:new'), 'ok')
  assert.equal(desktopAction(slot, { ...good, State: { Running: false } }, IMAGE), 'start')
  // Slot restarted in place after the companion: companion holds a stale netns.
  const restarted = { ...slot, State: { Running: true, StartedAt: '2026-11-18T11:00:00Z' } }
  assert.equal(desktopAction(restarted, good, IMAGE), 'restart')
})

test('desktop is refused for slots without a docker netns', () => {
  const codex = { id: 'vm-1', platform: 'openai', family: 'codex' }
  const kvm = { id: 'vm-2', runtime: { type: 'kvm' } }
  assert.equal(isCodexVm(codex), true)
  assert.equal(isKvmRuntime(kvm), true)
  assert.equal(desktopUnsupported(codex).code, 'no_container')
  assert.equal(desktopUnsupported(kvm).code, 'kvm_unsupported')
  assert.equal(desktopUnsupported(null).code, 'vm_not_found')
  assert.equal(desktopUnsupported({ id: 'vm-3' }), null)
})

test('desktop routes are admin-only', () => {
  for (const [method, p] of [
    ['GET', '/api/panel/vms/vm-01/desktop'],
    ['POST', '/api/panel/vms/vm-01/desktop'],
    ['POST', '/api/panel/vms/vm-01/desktop-ticket'],
  ]) {
    assert.equal(authorizePanelRoute(method, p, 'user').ok, false, `${method} ${p} user`)
    assert.equal(authorizePanelRoute(method, p, 'admin').ok, true, `${method} ${p} admin`)
  }
})

function projectWith(vms) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-desktop-'))
  fs.mkdirSync(path.join(root, 'vms'))
  for (const vm of vms) fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  return root
}

function fakeSocket() {
  const s = new PassThrough()
  s.written = ''
  s.write = (chunk) => {
    s.written += String(chunk)
    return true
  }
  s.destroy = () => {
    s.destroyed = true
  }
  return s
}

test('desktop ticket requires the toggle and is single use', async () => {
  const root = projectWith([{ id: 'vm-01' }, { id: 'vm-02', desktop: { enabled: true } }])
  let ensured = 0
  const desk = createSlotDesktop({
    projectRoot: root,
    ops: {
      ensureSlotDesktop: async () => {
        ensured += 1
        return { ok: true, action: 'ok' }
      },
    },
  })
  const off = await desk.issueTicket('vm-01')
  assert.equal(off.ok, false)
  assert.equal(off.error.code, 'desktop_disabled')

  const on = await desk.issueTicket('vm-02')
  assert.equal(on.ok, true)
  assert.equal(ensured, 1, 'issuing a ticket converges the companion first')

  // Wrong slot burns the ticket.
  const sock = fakeSocket()
  const req = { url: `/api/panel/vms/vm-01/desktop/ws?ticket=${on.ticket}`, headers: {} }
  assert.equal(desk.handleUpgrade(req, sock, Buffer.alloc(0)), true)
  assert.match(sock.written, /^HTTP\/1\.1 401/)
  const again = fakeSocket()
  desk.handleUpgrade(
    { url: `/api/panel/vms/vm-02/desktop/ws?ticket=${on.ticket}`, headers: {} },
    again,
    Buffer.alloc(0),
  )
  assert.match(again.written, /^HTTP\/1\.1 401/)

  // Unrelated paths are left to other upgrade handlers.
  assert.equal(desk.handleUpgrade({ url: '/api/panel/vms/vm-02/shell', headers: {} }, fakeSocket(), null), false)
})

test('desktop ticket surfaces a stopped slot', async () => {
  const root = projectWith([{ id: 'vm-05', desktop: { enabled: true } }])
  const desk = createSlotDesktop({
    projectRoot: root,
    ops: {
      ensureSlotDesktop: async () => ({ ok: false, status: 409, code: 'slot_not_running', message: 'x' }),
    },
  })
  const r = await desk.issueTicket('vm-05')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'slot_not_running')
})

test('singleFlight collapses concurrent ensures of one companion', async () => {
  let runs = 0
  let release
  const gate = new Promise((r) => {
    release = r
  })
  const work = async () => {
    runs += 1
    await gate
    return { ok: true, action: 'create' }
  }
  // Slot-start follow hook and a viewer ticket hit the same companion together.
  const a = singleFlight('local:kin-07-desktop', work)
  const b = singleFlight('local:kin-07-desktop', work)
  const other = singleFlight('local:kin-08-desktop', work)
  release()
  const [ra, rb] = await Promise.all([a, b, other])
  assert.equal(runs, 2, 'one run per companion, not per caller')
  assert.equal(ra, rb)
  // Settled: the next call starts a fresh run.
  await singleFlight('local:kin-07-desktop', work)
  assert.equal(runs, 3)
})

test('desktop viewer drops a client flooding input before the exec stream is up', async (t) => {
  const root = projectWith([{ id: 'vm-02', desktop: { enabled: true } }])
  let openStream
  const opened = new Promise((r) => {
    openStream = r
  })
  const desk = createSlotDesktop({
    projectRoot: root,
    logger: { warn() {} },
    ops: {
      ensureSlotDesktop: async () => ({ ok: true, action: 'ok' }),
      // The exec stream never comes up during the flood.
      openExecStream: () => opened,
    },
  })
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => desk.handleUpgrade(req, socket, head))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    openStream({ stream: new PassThrough() })
    server.closeAllConnections?.()
    server.close()
  })
  const issued = await desk.issueTicket('vm-02')
  assert.equal(issued.ok, true)
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/panel/vms/vm-02/desktop/ws?ticket=${issued.ticket}`,
    'binary',
  )
  await once(ws, 'open')
  assert.equal(desk.viewerCount(), 1)
  const chunk = Buffer.alloc(256 << 10)
  for (let i = 0; i < 8; i += 1) ws.send(chunk)
  const [code] = await once(ws, 'close')
  assert.equal(code, 1009)
  assert.equal(desk.viewerCount(), 0, 'the viewer slot is released')
})
