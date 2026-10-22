import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vmContext from 'node:vm'
import {
  legacyServiceContainerBody,
  migrateRemoteContainer,
  needsLegacyServiceMigration,
} from '../../src/lib/cluster/remote-slot.mjs'

const oldSlot = {
  Id: 'old-slot-id',
  State: { Running: true },
  Config: {
    Image: 'vm2api/kin-slot-ubuntu:old',
    User: '1000:1000',
    Cmd: ['/opt/kin/kin-kernel', '--gateway-worker', '--config', '/run/kin/kernel.json'],
    Labels: { 'kin.vm': '1', 'kin.vm.layout': '2' },
  },
  HostConfig: {
    Binds: ['/srv/vm-05/run:/run/kin', '/srv/vm-05/old-worker:/usr/local/bin/kin-worker'],
    NetworkMode: 'kin-05-net',
    ReadonlyRootfs: true,
    RestartPolicy: { Name: 'unless-stopped' },
  },
  NetworkSettings: { Networks: { 'kin-05-net': { IPAddress: '172.20.0.2', Aliases: ['kin-05'] } } },
  Mounts: [{ Destination: '/run/kin', Source: '/srv/vm-05/run', RW: true }],
}

test('legacy container body replaces old service bind and preserves slot settings', () => {
  const body = legacyServiceContainerBody(oldSlot, {
    sourceDir: '/srv/vm-05/slot-bin',
    removeDestinations: ['/usr/local/bin/kin-worker'],
    layout: true,
  })
  assert.equal(body.Image, oldSlot.Config.Image)
  assert.equal(body.User, oldSlot.Config.User)
  assert.equal(body.Labels['kin.vm.layout'], '3')
  assert.deepEqual(body.HostConfig.Binds, ['/srv/vm-05/run:/run/kin', '/srv/vm-05/slot-bin:/opt/kin-live:ro'])
  assert.deepEqual(body.NetworkingConfig.EndpointsConfig['kin-05-net'].IPAMConfig, { IPv4Address: '172.20.0.2' })
  assert.equal(needsLegacyServiceMigration(oldSlot, { sourceDir: '/srv/vm-05/slot-bin' }), true)
})

test('legacy egress command points at the persistent service mount', () => {
  const body = legacyServiceContainerBody(oldSlot, {
    sourceDir: '/srv/vm-05/slot-bin',
    removeDestinations: ['/usr/local/bin/kin-egress'],
    command: ['/opt/kin-live/kin-egress', '-config', '/etc/kin-egress/egress.json'],
  })
  assert.deepEqual(body.Cmd, ['/opt/kin-live/kin-egress', '-config', '/etc/kin-egress/egress.json'])
})

test('legacy container body preserves egress capability drops for canReuse', () => {
  const egress = {
    ...oldSlot,
    HostConfig: {
      ...oldSlot.HostConfig,
      NetworkMode: 'host',
      CapDrop: ['ALL'],
      CapAdd: ['NET_ADMIN', 'NET_RAW'],
      SecurityOpt: ['no-new-privileges'],
    },
  }
  const body = legacyServiceContainerBody(egress, {
    sourceDir: '/srv/vm-05/slot-bin',
    removeDestinations: ['/usr/local/bin/kin-egress'],
    command: ['/opt/kin-live/kin-egress', '-config', '/etc/kin-egress/egress.json'],
  })
  assert.deepEqual(body.HostConfig.CapDrop, ['ALL'])
  assert.deepEqual(body.HostConfig.CapAdd, ['NET_ADMIN', 'NET_RAW'])
  assert.deepEqual(body.HostConfig.SecurityOpt, ['no-new-privileges'])
})

test('migration keeps the old container as a stopped rollback copy', async () => {
  const state = new Map([['kin-05', structuredClone(oldSlot)]])
  let sequence = 0
  const inspect = async (_docker, name) => state.get(name) || null
  const action = async (_docker, name, operation) => {
    const value = [...state.values()].find((item) => item.Id === name) || state.get(name)
    if (operation === 'stop') value.State.Running = false
    if (operation === 'start') value.State.Running = true
  }
  const rename = async (_docker, from, to) => {
    const value = state.get(from)
    state.delete(from)
    state.set(to, value)
  }
  const create = async (_docker, name, body) => {
    const id = `new-${++sequence}`
    state.set(name, {
      Id: id,
      State: { Running: false },
      Config: body,
      Mounts: [{ Destination: '/opt/kin-live', RW: false }],
    })
    return id
  }
  const disconnect = async () => {}
  const result = await migrateRemoteContainer(
    {},
    'kin-05',
    legacyServiceContainerBody(oldSlot, { sourceDir: '/srv/vm-05/slot-bin', layout: true }),
    { wasRunning: true, ops: { inspect, action, rename, create, disconnect } },
  )
  assert.equal(result.ok, true)
  assert.equal(result.action, 'migrated')
  assert.equal(state.get('kin-05').State.Running, true)
  assert.equal(state.get(result.backup).State.Running, false)
})

test('needsLegacyServiceMigration skips KVM slots already on the guest kin-live mount', () => {
  const kvmSlot = {
    ...oldSlot,
    HostConfig: { ...oldSlot.HostConfig, Binds: [`/srv/vm-05/slot-bin:/opt/kin-guest/opt/kin-live:ro`] },
    Mounts: [{ Destination: '/opt/kin-guest/opt/kin-live', Source: '/srv/vm-05/slot-bin', RW: false }],
  }
  assert.equal(needsLegacyServiceMigration(kvmSlot, { sourceDir: '/srv/vm-05/slot-bin' }), false)
  const legacyWorker = {
    ...oldSlot,
    Mounts: [{ Destination: '/usr/local/bin/kin-worker', Source: '/srv/vm-05/old-worker', RW: false }],
  }
  assert.equal(needsLegacyServiceMigration(legacyWorker, { sourceDir: '/srv/vm-05/slot-bin' }), true)
})

test('migration disconnects the legacy container before pinning the same network IP', async () => {
  const net = 'kin-05-net'
  const ip = '172.20.0.2'
  const occupancy = new Map([[net, { containerId: 'old-slot-id', ip }]])
  const events = []
  const slot = structuredClone(oldSlot)
  const state = new Map([['kin-05', slot]])
  let sequence = 0
  const inspect = async (_docker, name) => state.get(name) || null
  const action = async (_docker, name, operation) => {
    const value = [...state.values()].find((item) => item.Id === name) || state.get(name)
    if (!value) return
    if (operation === 'stop') value.State.Running = false
    if (operation === 'start') value.State.Running = true
  }
  const rename = async (_docker, from, to) => {
    const value = state.get(from)
    state.delete(from)
    state.set(to, value)
  }
  const disconnect = async (_docker, network, containerId) => {
    events.push(['disconnect', network, containerId])
    const held = occupancy.get(network)
    if (held?.containerId === containerId) occupancy.delete(network)
  }
  const create = async (_docker, name, body) => {
    events.push(['create', name])
    const pinned = body.NetworkingConfig?.EndpointsConfig?.[net]?.IPAMConfig?.IPv4Address
    const held = occupancy.get(net)
    if (held && held.ip === pinned) throw new Error('address already in use')
    const id = `new-${++sequence}`
    if (pinned) occupancy.set(net, { containerId: id, ip: pinned })
    state.set(name, { Id: id, State: { Running: false }, Config: body })
    return id
  }
  const body = legacyServiceContainerBody(slot, { sourceDir: '/srv/vm-05/slot-bin', layout: true })
  const result = await migrateRemoteContainer({}, 'kin-05', body, {
    wasRunning: true,
    ops: { inspect, action, rename, create, disconnect },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(events, [
    ['disconnect', net, 'old-slot-id'],
    ['create', 'kin-05'],
  ])
  assert.equal(occupancy.get(net)?.containerId, 'new-1')
  assert.equal(occupancy.get(net)?.ip, ip)
})

test('remote service refresh forwards the migrated binary digest to egress', async () => {
  const source = fs.readFileSync(new URL('../../src/lib/cluster/remote-slot.mjs', import.meta.url), 'utf8')
  const body = source.slice(
    source.indexOf('export async function restartRemoteServices('),
    source.indexOf('export async function stopRemoteSlot('),
  )
  const vm = { id: 'kin-05', node_id: 'node-a', runtime: { container: 'kin-05' } }
  let receivedDigest
  const restart = vmContext.runInNewContext(`${body.replace('export ', '')}; restartRemoteServices`, {
    vmNodeId: () => vm.node_id,
    nodeSession: async () => ({ host: {}, docker: {} }),
    remoteSlotDir: () => '/slots/kin-05',
    path,
    inspectContainerOrNull: async () => ({ State: { Running: true } }),
    logTelemetryContainerSkip: () => {},
    telemetryContainerSkip: () => ({ ok: true, skipped: true }),
    migrateRemoteServiceContainers: async () => ({ ok: true, migrated: [], binary_digest: 'new-binary-digest' }),
    pushSlotFiles: async () => {},
    runtimeKind: () => 'docker',
    slotExecCmd: () => ({ Cmd: ['true'], User: '1000:1000' }),
    slotExecArgv: (vm) => {
      assert.equal(vm.runtime.container, 'immutable-slot-id')
      return ['exec', 'immutable-slot-id', 'true']
    },
    inspectContainerOrNull: async () => ({ Id: 'immutable-slot-id', State: { Running: true } }),
    runRemote: async (_client, command) => assert.match(command, /immutable-slot-id/),
    shellQuote: (s) => `'${s}'`,
    slotImageSpec: () => ({ ref: 'slot-image' }),
    ensureRemoteEgress: async (_session, _vm, { binaryDigest }) => {
      receivedDigest = binaryDigest
      return { ok: true }
    },
    failure: (error) => ({ ok: false, error: error.message }),
  })
  const result = await restart(vm, '/project', { telemetryEnabled: false })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.binary_digest, 'new-binary-digest')
  assert.equal(receivedDigest, 'new-binary-digest')
})
