import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb } from '../../src/lib/db/database.mjs'
import { withDatabaseActivities } from '../maintenance-fixture.mjs'
import { ClusterManager } from '../../src/lib/cluster/cluster-manager.mjs'
import { SshLink } from '../../src/lib/cluster/ssh-link.mjs'
import { SocketRelay } from '../../src/lib/cluster/socket-relay.mjs'

async function fixture(t) {
  const db = getDb()
  const calls = []
  const sql = async (name) => {
    await db.query('SELECT 1')
    calls.push(name)
  }
  const manager = new ClusterManager({
    repo: {
      db,
      list: async () => [{ id: 'node-synthetic', host: 'synthetic.invalid', port: 22, username: 'synthetic' }],
      getSecrets: async () => {
        await sql('target')
        return { password: 'synthetic' }
      },
    },
    dataDir: '/tmp',
    logger: { log() {}, warn() {} },
    onLinkState: async () => sql('state'),
    onNodesChanged: async () => sql('nodes'),
  })
  manager.remoteHost = async () => sql('host')
  manager._checkHealth = async () => sql('health')
  manager._ensureGate = async () => sql('gate')
  t.mock.method(SshLink.prototype, 'start', () => {})
  t.mock.method(SshLink.prototype, 'stop', () => {})
  t.mock.method(SocketRelay.prototype, 'start', async () => {})
  t.mock.method(SocketRelay.prototype, 'stop', async () => {})
  let tick
  const interval = t.mock.method(globalThis, 'setInterval', (callback) => {
    tick = callback
    return { unref() {} }
  })
  try {
    await withDatabaseActivities([db], () => manager.start())
  } finally {
    interval.mock.restore()
  }
  t.after(() => manager.stop())
  return { manager, calls, tick, link: manager.links.get('node-synthetic') }
}

test('cluster health timers run in independent activities after startup', async (t) => {
  const fx = await fixture(t)
  await fx.tick()
  await fx.manager.stop()
  assert.deepEqual(fx.calls, ['health'])
})

test('SSH reconnect target reads enter a live activity', async (t) => {
  const fx = await fixture(t)
  const target = await fx.link.resolveTarget()
  assert.equal(target.host, 'synthetic.invalid')
  assert.deepEqual(fx.calls, ['target'])
})

test('link ready waits for host, health, gate and state callback activities', async (t) => {
  const fx = await fixture(t)
  fx.link.emit('state', 'ready')
  await fx.manager.stop()
  assert.deepEqual([...fx.calls].sort(), ['gate', 'health', 'host', 'state'])
})

test('node change hooks await asynchronous persistence in a fresh activity', async (t) => {
  const fx = await fixture(t)
  await fx.manager._nodesChanged()
  assert.deepEqual(fx.calls, ['nodes'])
})
