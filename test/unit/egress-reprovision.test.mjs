import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  captureTopology,
  estimateOutageSeconds,
  feasibility,
  markSnapshotDone,
  pendingSnapshots,
  planStillValid,
  readSnapshot,
  reprovision,
  reprovisionDir,
  reprovisionPlan,
  reprovisionPlanLines,
  rollback,
  topologyFingerprint,
  writeSnapshot,
} from '../../src/lib/vm/egress-reprovision.mjs'
import { scanResidue } from '../../src/lib/vm/egress-residue.mjs'
import { egressRunDir } from '../../src/lib/vm/egress.mjs'
import { parseCidr } from '../../src/lib/vm/subnet-pool.mjs'

const F = '\u0001'
const POOL = parseCidr('100.64.0.0/10')

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-reprov-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Mutable docker stand-in: it records commands and applies create/remove/stop so a
 * full reprovision can run end to end against it.
 *
 * It models the detail that matters here: a container's NetworkMode holds the *id*
 * of the network it was created with. Removing that network and creating a
 * same-named one leaves the container pointing at a dead id, so `start` fails
 * until the container is attached to the replacement explicitly.
 */
function fakeDocker({ nets = {}, ps = [], fail = {} } = {}) {
  let nextId = 1
  const table = {}
  for (const [name, d] of Object.entries(nets)) table[name] = { ...structuredClone(d), id: `id${nextId++}` }
  const containers = new Map(ps.map((c) => [c.name, { state: 'running', ...c }]))
  // Which network id each container was created against, and where it is attached.
  for (const [name, d] of Object.entries(table)) {
    for (const c of d.containers || []) {
      const rec = containers.get(c.name)
      if (rec) {
        rec.networkModeId = d.id
        rec.attachedTo = name
      }
    }
  }
  const calls = []
  const run = (args) => {
    calls.push(args)
    const [verb, action] = args
    if (fail.all) return { ok: false, stderr: 'docker unreachable' }
    if (verb === 'network' && action === 'ls') return { ok: true, stdout: Object.keys(table).join('\n') }
    if (verb === 'network' && action === 'inspect') {
      const fmt = args[3] || ''
      const names = args.slice(4).filter((n) => table[n])
      const out = names.map((n) => {
        const d = table[n]
        const cs = (d.containers || []).map((c) => `${c.name}=${c.ip}/20`).join(',')
        // Docker emits one `subnet=gateway` pair per IPAM entry; a dual-stack
        // network carries an IPv6 one alongside the IPv4.
        const ipam = `${[
          `${d.subnet || ''}=${d.gateway || ''}`,
          ...(d.ipv6 ? [`${d.ipv6}=${d.ipv6.replace(/::\/\d+$/, '::1')}`] : []),
        ].join(' ')} `
        // The topology format asks for more fields than the residue one.
        if (fmt.includes('enable_ip_masquerade')) {
          return [
            n,
            ipam,
            d.bridge || '',
            d.masquerade ? 'true' : 'false',
            d.vm || '',
            d.proxy || '',
            cs ? `${cs},` : '',
          ].join(F)
        }
        if (fmt.includes('|')) return `${d.subnet || ''}|${d.gateway || ''}`
        if (fmt.includes('len .Containers')) {
          return [n, ipam, d.bridge || '', String((d.containers || []).length), d.vm || '', d.proxy || ''].join(F)
        }
        return d.subnet || ''
      })
      return { ok: true, stdout: out.join('\n') }
    }
    if (verb === 'network' && action === 'create') {
      if (fail.create) return { ok: false, stderr: 'create refused' }
      const name = args[args.length - 1]
      const at = args.indexOf('--subnet')
      const gw = args.indexOf('--gateway')
      const br = args.find((a) => String(a).startsWith('com.docker.network.bridge.name='))
      table[name] = {
        id: `id${nextId++}`,
        subnet: at >= 0 ? args[at + 1] : '',
        gateway: gw >= 0 ? args[gw + 1] : '',
        bridge: br ? String(br).split('=')[1] : '',
        containers: [],
      }
      return { ok: true, stdout: name }
    }
    if (verb === 'network' && action === 'connect') {
      const [, , net, name] = args
      if (!table[net]) return { ok: false, stderr: `network ${net} not found` }
      const c = containers.get(name)
      if (!c) return { ok: false, stderr: 'No such container' }
      if (c.attachedTo === net) return { ok: false, stderr: 'endpoint with name already exists' }
      c.attachedTo = net
      const list = (table[net].containers ||= [])
      const gwAddr = table[net].gateway || ''
      const ip = gwAddr
        ? `${gwAddr.split('.').slice(0, 3).join('.')}.${Number(gwAddr.split('.')[3]) + 1 + list.length}`
        : ''
      if (!list.some((x) => x.name === name)) list.push({ name, ip })
      return { ok: true }
    }
    if (verb === 'network' && action === 'rm') {
      const name = args[2]
      if (fail.rm === name) return { ok: false, stderr: 'network has active endpoints' }
      for (const c of containers.values()) if (c.attachedTo === name) c.attachedTo = null
      delete table[name]
      return { ok: true }
    }
    if (verb === 'ps') {
      const out = [...containers.values()].map((c) =>
        [c.name, c.egress || '', c.proxy || '', c.vm || '', c.state].join(F),
      )
      return { ok: true, stdout: out.join('\n') }
    }
    if (verb === 'stop') {
      const c = containers.get(args[1])
      if (fail.stop === args[1]) return { ok: false, stderr: 'stop refused' }
      if (c) c.state = 'exited'
      return { ok: true }
    }
    if (verb === 'start') {
      if (fail.start === args[1]) return { ok: false, stderr: 'start refused' }
      const c = containers.get(args[1])
      if (!c) return { ok: false, stderr: 'No such container' }
      // Docker does not reattach by name: if the id in NetworkMode is gone and
      // nothing attached the container to a live network, start fails.
      const home = c.attachedTo && table[c.attachedTo]
      const modeAlive = Object.values(table).some((n) => n.id === c.networkModeId)
      if (c.networkModeId && !home && !modeAlive) {
        return { ok: false, stderr: `failed to set up container networking: network ${c.networkModeId} not found` }
      }
      c.state = 'running'
      return { ok: true }
    }
    if (verb === 'rm') {
      containers.delete(args[2])
      return { ok: true }
    }
    return { ok: true, stdout: '' }
  }
  return { run, calls, table, containers }
}

const okIptables = () => ({ ok: true, stdout: '' })
const okIp = () => ({ ok: true, stdout: '' })
const denied = () => ({ ok: false, stderr: 'Permission denied (you must be root)' })

function liveTopologyDocker() {
  return fakeDocker({
    nets: {
      'kin-eg-px-a': {
        subnet: '172.23.0.0/16',
        gateway: '172.23.0.1',
        bridge: 'kega',
        proxy: 'px-a',
        containers: [{ name: 'kin-01', ip: '172.23.0.2' }],
      },
      'kin-eg-px-b': {
        subnet: '172.24.0.0/16',
        gateway: '172.24.0.1',
        bridge: 'kegb',
        proxy: 'px-b',
        containers: [],
      },
    },
    ps: [
      { name: 'kin-01', state: 'running' },
      { name: 'kin-cp-egress-px-a', egress: '1', proxy: 'px-a' },
    ],
  })
}

// ---------- topology snapshot ----------

test('a topology snapshot records which container sat where, at which address', (t) => {
  const root = tmpRoot(t)
  const dir = egressRunDir(root, 'px-a')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'egress.json'),
    JSON.stringify({ proxy_id: 'px-a', listen_tcp: '1.2.3.4:20100', listen_dns: '1.2.3.4:20101' }),
  )
  const d = liveTopologyDocker()

  const topo = captureTopology({ projectRoot: root, runDocker: d.run })

  assert.equal(topo.complete, true)
  assert.equal(topo.networks.length, 2)
  const a = topo.networks.find((n) => n.name === 'kin-eg-px-a')
  assert.equal(a.subnet, '172.23.0.0/16')
  assert.equal(a.gateway, '172.23.0.1')
  assert.deepEqual(a.containers, [{ name: 'kin-01', ip: '172.23.0.2' }])
  // The port pair a helper was started with has to survive into the snapshot.
  assert.deepEqual(
    topo.egress.map((e) => [e.key, e.tcp, e.dns]),
    [['px-a', 20100, 20101]],
  )
  const binding = topo.bindings.find((b) => b.network === 'kin-eg-px-a')
  assert.equal(binding.tcp, 20100)
  assert.deepEqual(binding.containers, ['kin-01'])
})

test('an incomplete capture is marked, so nothing plans against it', () => {
  const topo = captureTopology({ projectRoot: '/nonexistent', runDocker: fakeDocker({ fail: { all: true } }).run })
  assert.equal(topo.complete, false)
})

test('the fingerprint tracks networks, containers and ports, and ignores order', (t) => {
  const root = tmpRoot(t)
  const topo = captureTopology({ projectRoot: root, runDocker: liveTopologyDocker().run })
  const same = structuredClone(topo)
  same.networks.reverse()

  assert.equal(topologyFingerprint(same), topologyFingerprint(topo), 'order must not matter')

  const moved = structuredClone(topo)
  moved.networks[0].subnet = '172.99.0.0/16'
  assert.notEqual(topologyFingerprint(moved), topologyFingerprint(topo))

  const detached = structuredClone(topo)
  detached.networks.find((n) => n.name === 'kin-eg-px-a').containers = []
  assert.notEqual(topologyFingerprint(detached), topologyFingerprint(topo))
})

// ---------- gate 3: feasibility ----------

function feasibleArgs(root, d) {
  const scan = scanResidue({ projectRoot: root, runDocker: d.run, runIptables: okIptables, runIp: okIp, live: {} })
  const topology = captureTopology({ projectRoot: root, runDocker: d.run })
  return { topology, scan, projectRoot: root, runDocker: d.run, runIptables: okIptables, runIp: okIp }
}

test('feasibility passes on a readable host with room in the pool', (t) => {
  const root = tmpRoot(t)
  const f = feasibility(feasibleArgs(root, liveTopologyDocker()))

  assert.equal(f.ok, true)
  const names = f.checks.map((c) => c.name).sort()
  assert.deepEqual(names, [
    'capacity',
    'no_pending_reprovision',
    'no_pool_conflict',
    'privileges',
    'residue_knowable',
    'topology_complete',
  ])
  // Every check states its finding, not just a verdict.
  for (const c of f.checks) assert.ok(c.detail.length > 0, `${c.name} carried no detail`)
})

test('feasibility refuses when the pool is too small for the rebuild', (t) => {
  const root = tmpRoot(t)
  // /24 split into /28 leaves 16 slots; reserve all of them.
  const f = feasibility({
    ...feasibleArgs(root, liveTopologyDocker()),
    pool: '100.64.0.0/24',
    prefix: 28,
    reserved: ['100.64.0.0/24'],
  })

  assert.equal(f.ok, false)
  const capacity = f.checks.find((c) => c.name === 'capacity')
  assert.equal(capacity.pass, false)
  assert.match(capacity.detail, /0 of 16 \/28 slot\(s\) free/)
})

test('a shared network is sized for many containers, not for one', (t) => {
  const root = tmpRoot(t)
  const d = fakeDocker({
    nets: {
      // The folded local bridge, shared by every local-exit VM on the host.
      'kin-eg-px-local': {
        subnet: '192.168.144.0/20',
        gateway: '192.168.144.1',
        bridge: 'keglocal',
        containers: [{ name: 'kin-cli', ip: '192.168.144.2' }],
      },
      'kin-eg-px-a': { subnet: '172.23.0.0/16', gateway: '172.23.0.1', bridge: 'kega', proxy: 'px-a', containers: [] },
    },
    ps: [{ name: 'kin-cli' }],
  })
  const { topology, scan } = feasibleArgs(root, d)
  const plan = reprovisionPlan({ topology, scan, runDocker: d.run, runIp: okIp })

  const local = plan.build.find((b) => b.network === 'kin-eg-px-local')
  const perVm = plan.build.find((b) => b.network === 'kin-eg-px-a')

  assert.equal(local.shared, true)
  assert.equal(perVm.shared, false)
  // A /28 would cut this host's local capacity from 4094 addresses to 14.
  assert.equal(parseCidr(local.subnet).prefix, 20)
  assert.equal(parseCidr(perVm.subnet).prefix, 28)
  // And the per-VM range must not fall inside the shared block.
  const l = parseCidr(local.subnet)
  const v = parseCidr(perVm.subnet)
  assert.ok(
    v.network + v.size - 1 < l.network || v.network > l.network + l.size - 1,
    `${perVm.subnet} overlaps the shared ${local.subnet}`,
  )
})

test('capacity accounts for the shared block swallowing per-VM slots', (t) => {
  const root = tmpRoot(t)
  const d = fakeDocker({
    nets: {
      'kin-eg-px-local': { subnet: '192.168.144.0/20', gateway: '192.168.144.1', bridge: 'keglocal', containers: [] },
    },
  })
  const f = feasibility({ ...feasibleArgs(root, d), pool: '100.64.0.0/16', prefix: 28, sharedPrefix: 20 })
  const capacity = f.checks.find((c) => c.name === 'capacity')

  assert.equal(f.ok, true)
  // Both budgets are reported, because they are drawn from the same pool.
  assert.match(capacity.detail, /1 shared, \d+ of 16 \/20 free/)
  assert.match(capacity.detail, /0 per-VM network\(s\)/)
})

test('feasibility refuses when something already occupies the pool', (t) => {
  const root = tmpRoot(t)
  const d = liveTopologyDocker()
  // A foreign network inside the target pool is a real conflict.
  d.table['some-other-project'] = { subnet: '100.64.0.0/16', bridge: 'br-x', containers: [] }
  const f = feasibility(feasibleArgs(root, d))

  assert.equal(f.ok, false)
  const conflict = f.checks.find((c) => c.name === 'no_pool_conflict')
  assert.equal(conflict.pass, false)
  assert.match(conflict.detail, /already inside 100\.64\.0\.0\/10; pick another pool/)
})

test('a range about to be torn down is not counted as a conflict with itself', (t) => {
  const root = tmpRoot(t)
  const d = fakeDocker({
    nets: {
      // Already on the new pool from an earlier pass: it will be removed, so it
      // must not block the rebuild.
      'kin-eg-px-a': { subnet: '100.64.5.0/28', gateway: '100.64.5.1', bridge: 'kega', proxy: 'px-a', containers: [] },
    },
  })
  const f = feasibility(feasibleArgs(root, d))

  assert.equal(f.checks.find((c) => c.name === 'no_pool_conflict').pass, true)
  assert.equal(f.ok, true)
})

test('feasibility refuses when a class cannot be read', (t) => {
  const root = tmpRoot(t)
  const d = liveTopologyDocker()
  const scan = scanResidue({ projectRoot: root, runDocker: d.run, runIptables: denied, runIp: okIp, live: {} })
  const topology = captureTopology({ projectRoot: root, runDocker: d.run })
  const f = feasibility({ topology, scan, projectRoot: root, runDocker: d.run, runIptables: denied, runIp: okIp })

  assert.equal(f.ok, false)
  const priv = f.checks.find((c) => c.name === 'privileges')
  assert.equal(priv.pass, false)
  assert.match(priv.detail, /cannot read: iptables/)
  // And the unknown residue class is called out separately.
  assert.equal(f.checks.find((c) => c.name === 'residue_knowable').pass, false)
})

test('privileges never claims write access it did not prove', (t) => {
  const root = tmpRoot(t)
  const f = feasibility(feasibleArgs(root, liveTopologyDocker()))
  const priv = f.checks.find((c) => c.name === 'privileges')

  assert.equal(priv.pass, true)
  assert.match(priv.detail, /write access is only proven at execution time/)
})

test('feasibility refuses while an unfinished reprovision is on disk', (t) => {
  const root = tmpRoot(t)
  const d = liveTopologyDocker()
  const dir = writeSnapshot({ projectRoot: root, stamp: 'stuck', topology: { networks: [] } })

  let f = feasibility(feasibleArgs(root, d))
  assert.equal(f.ok, false)
  const pending = f.checks.find((c) => c.name === 'no_pending_reprovision')
  assert.match(pending.detail, /unfinished reprovision at .*stuck; roll back or abandon/)

  // Closing it clears the block.
  markSnapshotDone(dir)
  assert.deepEqual(pendingSnapshots(root), [])
  f = feasibility(feasibleArgs(root, d))
  assert.equal(f.checks.find((c) => c.name === 'no_pending_reprovision').pass, true)
})

// ---------- gate 3: plan and staleness ----------

test('a forward plan targets the pool and lists teardown before build', (t) => {
  const root = tmpRoot(t)
  const d = liveTopologyDocker()
  const { topology, scan } = feasibleArgs(root, d)
  const plan = reprovisionPlan({ topology, scan, target: 'pool', runDocker: d.run, runIp: okIp })

  assert.equal(plan.target, 'pool')
  assert.equal(plan.build.length, 2)
  for (const b of plan.build) {
    const c = parseCidr(b.subnet)
    assert.ok(
      c.network >= POOL.network && c.network + c.size - 1 <= POOL.network + POOL.size - 1,
      `${b.subnet} escaped the pool`,
    )
    assert.equal(
      b.gateway,
      `${b.subnet.split('/')[0].split('.').slice(0, 3).join('.')}.${Number(b.subnet.split('/')[0].split('.')[3]) + 1}`,
    )
  }
  assert.deepEqual(plan.stopContainers, ['kin-01'])

  const text = reprovisionPlanLines(plan).join('\n')
  assert.ok(text.indexOf('stop') < text.indexOf('teardown'), 'containers stop before teardown')
  assert.ok(text.indexOf('teardown') < text.indexOf('build'), 'teardown precedes build')
  assert.ok(text.indexOf('build') < text.lastIndexOf('start'), 'build precedes start')
})

test('a rollback plan targets the ranges the snapshot recorded', (t) => {
  const root = tmpRoot(t)
  const d = liveTopologyDocker()
  const { topology, scan } = feasibleArgs(root, d)
  const plan = reprovisionPlan({ topology, scan, target: 'snapshot', runDocker: d.run, runIp: okIp })

  assert.equal(plan.target, 'snapshot')
  assert.deepEqual(plan.build.map((b) => [b.network, b.subnet]).sort(), [
    ['kin-eg-px-a', '172.23.0.0/16'],
    ['kin-eg-px-b', '172.24.0.0/16'],
  ])
})

test('an outage estimate scales with containers and networks', (t) => {
  const root = tmpRoot(t)
  const d = liveTopologyDocker()
  const { topology, scan } = feasibleArgs(root, d)
  const plan = reprovisionPlan({ topology, scan, runDocker: d.run, runIp: okIp })

  assert.equal(estimateOutageSeconds(plan, { perContainer: 4, perNetwork: 1 }), 1 * 4 + 2 * 1)
})

test('a plan is refused once the topology has moved underneath it', (t) => {
  const root = tmpRoot(t)
  const d = liveTopologyDocker()
  const { topology, scan } = feasibleArgs(root, d)
  const plan = reprovisionPlan({ topology, scan, runDocker: d.run, runIp: okIp })

  assert.equal(planStillValid(plan, topology).valid, true)

  // Someone adds a network between the dry run and the apply.
  d.table['kin-eg-px-c'] = {
    subnet: '172.25.0.0/16',
    gateway: '172.25.0.1',
    bridge: 'kegc',
    proxy: 'px-c',
    containers: [],
  }
  const moved = captureTopology({ projectRoot: root, runDocker: d.run })
  const verdict = planStillValid(plan, moved)

  assert.equal(verdict.valid, false)
  assert.notEqual(verdict.expected, verdict.actual)
})

test('a snapshot and its plan round-trip through disk', (t) => {
  const root = tmpRoot(t)
  const d = liveTopologyDocker()
  const { topology, scan } = feasibleArgs(root, d)
  const plan = reprovisionPlan({ topology, scan, runDocker: d.run, runIp: okIp })
  const dir = writeSnapshot({ projectRoot: root, stamp: 'abc', topology, plan })

  assert.equal(dir, reprovisionDir(root, 'abc'))
  const back = readSnapshot(dir)
  assert.equal(topologyFingerprint(back.topology), topologyFingerprint(topology))
  assert.equal(back.plan.fingerprint, plan.fingerprint)
  // It blocks the next reprovision until closed.
  assert.deepEqual(pendingSnapshots(root), [dir])
})

// ---------- gate 3: dry run ----------

test('a dry run reports the plan, stops at the gate and touches nothing', async (t) => {
  const root = tmpRoot(t)
  const d = liveTopologyDocker()
  const before = JSON.stringify(d.table)

  const r = await reprovision({
    projectRoot: root,
    runDocker: d.run,
    runIptables: okIptables,
    runIp: okIp,
    dryRun: true,
  })

  assert.equal(r.dryRun, true)
  assert.equal(r.feasibility.ok, true)
  assert.equal(r.plan.build.length, 2)
  assert.ok(r.lines.length > 0)
  assert.equal(phase(r, 'gate').detail, 'would proceed')

  // Nothing created, removed, stopped or started.
  assert.equal(JSON.stringify(d.table), before)
  for (const verb of ['create', 'rm', 'stop', 'start']) {
    assert.ok(
      !d.calls.some((a) => a.includes(verb) && a[0] !== 'network') &&
        !d.calls.some((a) => a[0] === 'network' && a[1] === verb),
      `a dry run must not issue ${verb}`,
    )
  }
  // And no snapshot directory was laid down.
  assert.deepEqual(pendingSnapshots(root), [])
})

function phase(result, name) {
  const p = result.phases.find((x) => x.name === name)
  assert.ok(p, `expected a ${name} phase, got ${result.phases.map((x) => x.name).join(', ')}`)
  return p
}

// ---------- gate 4: rebuild ----------

test('a rebuild is refused outright when feasibility fails', async (t) => {
  const root = tmpRoot(t)
  const d = liveTopologyDocker()
  writeSnapshot({ projectRoot: root, stamp: 'stuck', topology: { networks: [] } })
  const before = JSON.stringify(d.table)

  const r = await reprovision({
    projectRoot: root,
    runDocker: d.run,
    runIptables: okIptables,
    runIp: okIp,
    dryRun: false,
  })

  assert.equal(r.aborted, true)
  assert.equal(phase(r, 'gate').ok, false)
  assert.match(phase(r, 'gate').detail, /refused: feasibility did not pass/)
  assert.equal(JSON.stringify(d.table), before, 'a refused rebuild must change nothing')
})

test('a rebuild moves every network onto the pool and brings containers back', async (t) => {
  const root = tmpRoot(t)
  const d = liveTopologyDocker()
  // An orphan run directory that should not survive the pass.
  const orphan = egressRunDir(root, 'px-gone')
  fs.mkdirSync(orphan, { recursive: true })
  fs.writeFileSync(
    path.join(orphan, 'egress.json'),
    JSON.stringify({ proxy_id: 'px-gone', listen_tcp: '1.2.3.4:20900' }),
  )

  const r = await reprovision({
    projectRoot: root,
    runDocker: d.run,
    runIptables: okIptables,
    runIp: okIp,
    dryRun: false,
  })

  assert.equal(phase(r, 'build').ok, true)
  assert.equal(phase(r, 'teardown').ok, true)

  // Every surviving egress network is on the new pool; none of the old ranges left.
  const subnets = Object.entries(d.table)
    .filter(([n]) => n.startsWith('kin-eg-'))
    .map(([, v]) => v.subnet)
  assert.equal(subnets.length, 2)
  for (const s of subnets) {
    const c = parseCidr(s)
    assert.ok(
      c.network >= POOL.network && c.network + c.size - 1 <= POOL.network + POOL.size - 1,
      `${s} is not on the pool`,
    )
  }
  // The container that was stopped is running again.
  assert.equal(d.containers.get('kin-01').state, 'running')
  // The orphan directory is gone, releasing its port.
  assert.equal(fs.existsSync(orphan), false)
})

test('a rebuild lands its snapshot before touching anything', async (t) => {
  const root = tmpRoot(t)
  const d = liveTopologyDocker()
  let snapshotAtFirstMutation = null
  const wrapped = (args) => {
    const mutating = args[0] === 'stop' || (args[0] === 'network' && (args[1] === 'rm' || args[1] === 'create'))
    if (mutating && snapshotAtFirstMutation === null) snapshotAtFirstMutation = pendingSnapshots(root).length
    return d.run(args)
  }

  await reprovision({ projectRoot: root, runDocker: wrapped, runIptables: okIptables, runIp: okIp, dryRun: false })

  assert.equal(snapshotAtFirstMutation, 1, 'the snapshot must exist before the first destructive call')
})

test('a successful pass closes its snapshot; a failed one keeps it for rollback', async (t) => {
  const root = tmpRoot(t)
  const ok = await reprovision({
    projectRoot: root,
    runDocker: liveTopologyDocker().run,
    runIptables: okIptables,
    runIp: okIp,
    dryRun: false,
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(pendingSnapshots(root), [], 'a clean pass should leave nothing pending')

  const root2 = tmpRoot(t)
  const broken = fakeDocker({
    nets: {
      'kin-eg-px-a': {
        subnet: '172.23.0.0/16',
        gateway: '172.23.0.1',
        bridge: 'kega',
        proxy: 'px-a',
        containers: [{ name: 'kin-01', ip: '172.23.0.2' }],
      },
    },
    ps: [{ name: 'kin-01' }],
    fail: { start: 'kin-01' },
  })
  const bad = await reprovision({
    projectRoot: root2,
    runDocker: broken.run,
    runIptables: okIptables,
    runIp: okIp,
    dryRun: false,
  })

  assert.equal(bad.ok, false)
  assert.equal(phase(bad, 'start').ok, false)
  assert.match(phase(bad, 'finish').detail, /snapshot kept at .* for rollback/)
  assert.deepEqual(pendingSnapshots(root2), [bad.snapshotDir], 'the snapshot has to survive for the rollback')
})

test('a rollback puts the recorded ranges back', async (t) => {
  const root = tmpRoot(t)
  const d = liveTopologyDocker()
  const original = Object.fromEntries(
    Object.entries(d.table)
      .filter(([n]) => n.startsWith('kin-eg-'))
      .map(([n, v]) => [n, v.subnet]),
  )

  const forward = await reprovision({
    projectRoot: root,
    runDocker: d.run,
    runIptables: okIptables,
    runIp: okIp,
    dryRun: false,
  })
  assert.equal(forward.ok, true)
  // Now on the pool, not on the original ranges.
  for (const [name, subnet] of Object.entries(original)) {
    assert.notEqual(d.table[name].subnet, subnet)
  }

  const back = await rollback({
    projectRoot: root,
    runDocker: d.run,
    runIptables: okIptables,
    runIp: okIp,
    snapshotDir: forward.snapshotDir,
  })

  assert.equal(phase(back, 'build').ok, true)
  for (const [name, subnet] of Object.entries(original)) {
    assert.equal(d.table[name].subnet, subnet, `${name} should be back on ${subnet}`)
  }
})

test('a teardown that is refused surfaces instead of being rebuilt over', async (t) => {
  const root = tmpRoot(t)
  const d = fakeDocker({
    nets: {
      'kin-eg-px-a': { subnet: '172.23.0.0/16', gateway: '172.23.0.1', bridge: 'kega', proxy: 'px-a', containers: [] },
    },
    fail: { rm: 'kin-eg-px-a' },
  })

  const r = await reprovision({
    projectRoot: root,
    runDocker: d.run,
    runIptables: okIptables,
    runIp: okIp,
    dryRun: false,
  })

  assert.equal(r.ok, false)
  assert.equal(phase(r, 'teardown').ok, false)
  assert.match(JSON.stringify(phase(r, 'teardown').failed), /active endpoints/)
})

test('helper rebuild and exit checks are delegated, and their failures reported', async (t) => {
  const root = tmpRoot(t)
  const seen = { helpers: [], checks: [] }
  const r = await reprovision({
    projectRoot: root,
    runDocker: liveTopologyDocker().run,
    runIptables: okIptables,
    runIp: okIp,
    dryRun: false,
    ensureEgress: async (entry) => {
      seen.helpers.push(entry.proxy_id)
      return { ok: true }
    },
    verifyExit: async (entry) => {
      seen.checks.push(entry.network)
      // One exit is unreachable and must be named, not swallowed.
      return entry.network === 'kin-eg-px-b' ? { ok: false, detail: 'no route' } : { ok: true }
    },
  })

  assert.deepEqual(seen.helpers.sort(), ['px-a', 'px-b'])
  assert.equal(seen.checks.length, 2)
  const check = phase(r, 'exit-check')
  assert.equal(check.ok, false)
  assert.match(check.detail, /1\/2 reachable/)
  assert.ok(check.results.some((x) => x.network === 'kin-eg-px-b' && x.ok === false && x.detail === 'no route'))
  assert.equal(r.ok, false, 'an unreachable exit must fail the pass')
})

test('a pass without delegates still runs, and says it skipped them', async (t) => {
  const root = tmpRoot(t)
  const r = await reprovision({
    projectRoot: root,
    runDocker: liveTopologyDocker().run,
    runIptables: okIptables,
    runIp: okIp,
    dryRun: false,
  })

  assert.match(phase(r, 'helpers').detail, /skipped: no ensureEgress/)
  assert.match(phase(r, 'exit-check').detail, /skipped: no verifyExit/)
  assert.equal(r.ok, true)
})

test('a rebuild leaves slot data, credentials and the registry untouched', async (t) => {
  const root = tmpRoot(t)
  // Stand-ins for the things a reprovision must never reach.
  const keep = {
    [path.join(root, 'data', 'vms.json')]: '{"vm-01":{"id":"vm-01"}}',
    [path.join(root, 'vms', 'vm-01', 'credentials.json')]: '{"token":"secret"}',
    [path.join(root, 'vms', 'vm-01', 'slot-data.bin')]: 'payload',
  }
  for (const [file, body] of Object.entries(keep)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
  }

  await reprovision({
    projectRoot: root,
    runDocker: liveTopologyDocker().run,
    runIptables: okIptables,
    runIp: okIp,
    dryRun: false,
  })

  for (const [file, body] of Object.entries(keep)) {
    assert.equal(fs.readFileSync(file, 'utf8'), body, `${file} must be byte-identical`)
  }
})

test('the pass rechecks cleanliness at the end using the same verifier', async (t) => {
  const root = tmpRoot(t)
  const r = await reprovision({
    projectRoot: root,
    runDocker: liveTopologyDocker().run,
    runIptables: okIptables,
    runIp: okIp,
    dryRun: false,
  })

  const recheck = phase(r, 'recheck')
  assert.equal(recheck.ok, true)
  assert.deepEqual(recheck.unavailable, [])
})

test('an unreadable class at the end fails the recheck rather than passing quietly', async (t) => {
  const root = tmpRoot(t)
  const d = liveTopologyDocker()
  // Readable through the gates, unreadable by the time the recheck runs. The
  // ensureEgress callback is the anchor: it fires after build, before recheck.
  let readable = true
  const flaky = () => (readable ? okIptables() : denied())

  const r = await reprovision({
    projectRoot: root,
    runDocker: d.run,
    runIptables: flaky,
    runIp: okIp,
    dryRun: false,
    ensureEgress: async () => {
      readable = false
      return { ok: true }
    },
  })

  assert.equal(phase(r, 'feasibility').ok, true, 'the gates must have passed while it was readable')
  assert.equal(phase(r, 'recheck').ok, false)
  assert.ok(phase(r, 'recheck').unavailable.includes('iptables'))
  assert.equal(r.ok, false, 'a pass that cannot confirm its own cleanup must not report success')
})

test('a successful rollback also closes the snapshot it recovered from', async (t) => {
  const root = tmpRoot(t)
  // A forward pass that cannot bring its container back leaves a snapshot open.
  const broken = fakeDocker({
    nets: {
      'kin-eg-px-a': {
        subnet: '172.23.0.0/16',
        gateway: '172.23.0.1',
        bridge: 'kega',
        proxy: 'px-a',
        containers: [{ name: 'kin-01', ip: '172.23.0.2' }],
      },
    },
    ps: [{ name: 'kin-01' }],
    fail: { start: 'kin-01' },
  })
  const forward = await reprovision({
    projectRoot: root,
    runDocker: broken.run,
    runIptables: okIptables,
    runIp: okIp,
    dryRun: false,
  })
  assert.equal(forward.ok, false)
  assert.deepEqual(pendingSnapshots(root), [forward.snapshotDir])

  // Rolling back from it resolves it. Leaving it open would block every later
  // reprovision on no_pending_reprovision with nothing left to recover.
  const healed = fakeDocker({
    nets: Object.fromEntries(Object.entries(broken.table).map(([k, v]) => [k, structuredClone(v)])),
    ps: [{ name: 'kin-01' }],
  })
  const back = await rollback({
    projectRoot: root,
    runDocker: healed.run,
    runIptables: okIptables,
    runIp: okIp,
    snapshotDir: forward.snapshotDir,
  })

  assert.equal(back.ok, true)
  assert.match(phase(back, 'finish').detail, /resolved/)
  assert.deepEqual(pendingSnapshots(root), [], 'neither the rollback nor its source may stay pending')

  // And the gate is clear again.
  const next = await reprovision({
    projectRoot: root,
    runDocker: healed.run,
    runIptables: okIptables,
    runIp: okIp,
    dryRun: true,
  })
  assert.equal(next.feasibility.checks.find((c) => c.name === 'no_pending_reprovision').pass, true)
})

test('two passes in the same millisecond get separate snapshot directories', (t) => {
  const root = tmpRoot(t)
  // Same-millisecond runs are the rollback-right-after-failure case. A collision
  // would overwrite the topology the rollback depends on.
  const a = writeSnapshot({ projectRoot: root, topology: { networks: [{ name: 'first' }] } })
  const b = writeSnapshot({ projectRoot: root, topology: { networks: [{ name: 'second' }] } })

  assert.notEqual(a, b, 'the second snapshot must not land on the first')
  assert.equal(readSnapshot(a).topology.networks[0].name, 'first', 'the first topology must survive')
  assert.equal(readSnapshot(b).topology.networks[0].name, 'second')
  assert.deepEqual(pendingSnapshots(root).sort(), [a, b].sort())
})
