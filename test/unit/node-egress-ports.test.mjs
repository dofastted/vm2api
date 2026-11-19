import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveRemoteEgressPorts, slotEgressNames } from '../../src/lib/cluster/remote-slot.mjs'
import { portsForProxy } from '../../src/lib/vm/egress.mjs'

const HOST = { root: '/srv/kin', uid: 0 }

/**
 * Stands in for the two SSH calls this path makes. `configs` maps a slot's egress
 * directory to its egress.json body; `allocated` is what the node reports as
 * already spoken for.
 */
function io({ configs = {}, allocated = [], listeners = [], readThrows = false, runThrows = false } = {}) {
  const calls = { reads: [], scripts: [] }
  return {
    calls,
    readFile: async (_client, file) => {
      calls.reads.push(file)
      if (readThrows) throw new Error('sftp down')
      const body = configs[file]
      return body === undefined ? null : Buffer.from(body)
    },
    run: async (_client, script) => {
      calls.scripts.push(script)
      if (runThrows) throw new Error('ssh down')
      return [...allocated, ...listeners].join('\n')
    },
  }
}

const session = { client: {}, host: HOST }

test('a slot that was already started keeps the pair it is listening on', async () => {
  // The iptables rows that REDIRECT into the helper were written with these
  // ports; moving them would point the rules at a port nothing listens on.
  const dir = '/srv/kin/vms/vm-07/egress'
  const h = io({
    configs: {
      [`${dir}/egress.json`]: JSON.stringify({
        proxy_id: 'px-a',
        listen_tcp: '100.64.0.1:31000',
        listen_dns: '100.64.0.1:31001',
      }),
    },
  })
  const r = await resolveRemoteEgressPorts(session, 'vm-07', dir, h)

  assert.deepEqual(r, { tcp: 31000, dns: 31001, reused: true })
  // A pair the hash would never pick, proving the recorded value won.
  assert.notEqual(r.tcp, portsForProxy('vm-07').tcp)
  // And it must not have gone looking for what else is taken.
  assert.deepEqual(h.calls.scripts, [])
})

test('a fresh exit on an empty node takes the bare hash', async () => {
  const dir = '/srv/kin/vms/vm-07/egress'
  const r = await resolveRemoteEgressPorts(session, 'vm-07', dir, io())

  assert.equal(r.reused, false)
  assert.deepEqual({ tcp: r.tcp, dns: r.dns }, portsForProxy('vm-07'))
})

test('a fresh exit steps past a pair another slot on the node holds', async () => {
  // The collision this fixes: the bare hash has 8000 slots and no check, so two
  // slots on a busy node can land on the same pair and have their traffic
  // redirected into each other's helper.
  const dir = '/srv/kin/vms/vm-07/egress'
  const wanted = portsForProxy('vm-07')
  const r = await resolveRemoteEgressPorts(session, 'vm-07', dir, io({ allocated: [wanted.tcp, wanted.dns] }))

  assert.equal(r.reused, false)
  assert.notEqual(r.tcp, wanted.tcp)
  assert.equal(r.tcp, wanted.tcp + 2, 'probing advances one slot at a time')
  assert.equal(r.dns, r.tcp + 1)
})

test('either half of a pair being taken is enough to move on', async () => {
  const dir = '/srv/kin/vms/vm-07/egress'
  const wanted = portsForProxy('vm-07')

  const onTcp = await resolveRemoteEgressPorts(session, 'vm-07', dir, io({ allocated: [wanted.tcp] }))
  assert.notEqual(onTcp.tcp, wanted.tcp)

  const onDns = await resolveRemoteEgressPorts(session, 'vm-07', dir, io({ allocated: [wanted.dns] }))
  assert.notEqual(onDns.tcp, wanted.tcp)
})

test('a port only showing up as a listener is avoided too', async () => {
  // Something else on the node holds the port without an egress.json: a foreign
  // service, or a helper whose config was lost.
  const dir = '/srv/kin/vms/vm-07/egress'
  const wanted = portsForProxy('vm-07')
  const r = await resolveRemoteEgressPorts(session, 'vm-07', dir, io({ listeners: [wanted.tcp] }))

  assert.notEqual(r.tcp, wanted.tcp)
})

test('many slots on one node all end up on distinct pairs', async () => {
  const allocated = []
  const seen = new Set()
  for (let i = 0; i < 400; i++) {
    const dir = `/srv/kin/vms/vm-${i}/egress`
    const r = await resolveRemoteEgressPorts(session, `vm-${i}`, dir, io({ allocated: [...allocated] }))
    assert.ok(!seen.has(r.tcp) && !seen.has(r.dns), `vm-${i} reused a port already handed out`)
    seen.add(r.tcp)
    seen.add(r.dns)
    allocated.push(r.tcp, r.dns)
  }
  assert.equal(seen.size, 800)
})

test('an unparsable or half-written config falls through to probing', async () => {
  const dir = '/srv/kin/vms/vm-07/egress'

  for (const body of ['not json', '{}', JSON.stringify({ listen_tcp: '1.2.3.4:20000' })]) {
    const h = io({ configs: { [`${dir}/egress.json`]: body } })
    const r = await resolveRemoteEgressPorts(session, 'vm-07', dir, h)
    assert.equal(r.reused, false, `expected probing for config ${body}`)
    assert.ok(h.calls.scripts.length > 0, 'it should have asked what is taken')
  }
})

test('an unreadable config or node still yields a usable pair', async () => {
  const dir = '/srv/kin/vms/vm-07/egress'

  const noRead = await resolveRemoteEgressPorts(session, 'vm-07', dir, io({ readThrows: true }))
  assert.deepEqual({ tcp: noRead.tcp, dns: noRead.dns }, portsForProxy('vm-07'))

  // A node that cannot be queried degrades to the hash rather than refusing to
  // bring the exit up.
  const noRun = await resolveRemoteEgressPorts(session, 'vm-07', dir, io({ runThrows: true }))
  assert.deepEqual({ tcp: noRun.tcp, dns: noRun.dns }, portsForProxy('vm-07'))
})

test('the taken-ports query reads the node own configs and listeners', async () => {
  const dir = '/srv/kin/vms/vm-07/egress'
  const h = io({ allocated: [20100] })
  await resolveRemoteEgressPorts(session, 'vm-07', dir, h)

  const script = h.calls.scripts.join('\n')
  // Ports are extracted on the node: a node at scale holds thousands of configs.
  assert.match(script, /\/srv\/kin\/vms'?\/\*\/egress\/egress\.json/)
  assert.match(script, /listen_\(tcp\|dns\)/)
  assert.match(script, /ss -ltnH/)
  // A missing glob or absent ss must not abort the script.
  assert.match(script, /2>\/dev\/null \|\| true/)
})

test('slotEgressNames still exposes the bare hash and keeps its other names', () => {
  // It stays a pure function: seven call sites depend on that, and only the
  // creation path resolves a real pair.
  const n = slotEgressNames('vm-07')

  assert.deepEqual(n.ports, portsForProxy('vm-07'))
  assert.equal(n.network, 'kin-07-net')
  assert.equal(n.egress, 'kin-07-egress')
  assert.ok(n.bridge.startsWith('keg') && n.bridge.length <= 15)
  assert.ok(n.chain.startsWith('KEG'))
})
