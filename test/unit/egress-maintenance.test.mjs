import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  collectLiveSet,
  maintenanceExecutors,
  reprovisionEgress,
  shellRunner,
  sweepEgress,
  verifyEgress,
} from '../../src/lib/vm/egress-maintenance.mjs'

const F = '\u0001'

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-egmaint-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Docker stand-in holding one orphaned network and one in-use network. */
function fakeDocker({ nets = {}, ps = [] } = {}) {
  const table = { ...nets }
  const removed = []
  const run = (args) => {
    const [verb, action] = args
    if (verb !== 'network' && verb !== 'ps' && verb !== 'rm') return { ok: true, stdout: '' }
    if (verb === 'ps') {
      return {
        ok: true,
        stdout: ps.map((c) => [c.name, c.egress || '', c.proxy || '', c.vm || '', 'exited'].join(F)).join('\n'),
      }
    }
    if (action === 'ls') return { ok: true, stdout: Object.keys(table).join('\n') }
    if (action === 'inspect') {
      const out = args
        .slice(4)
        .filter((n) => table[n])
        .map((n) => {
          const d = table[n]
          return [
            n,
            `${d.subnet}=${d.gateway || ''} `,
            d.bridge || '',
            String(d.containers ?? 0),
            d.vm || '',
            d.proxy || '',
          ].join(F)
        })
      return { ok: true, stdout: out.join('\n') }
    }
    if (action === 'rm') {
      removed.push(args[2])
      delete table[args[2]]
      return { ok: true }
    }
    return { ok: true, stdout: '' }
  }
  return { run, table, removed }
}

const okIptables = () => ({ ok: true, stdout: '' })
const okIp = () => ({ ok: true, stdout: '' })

function orphanWorld() {
  return fakeDocker({
    nets: {
      // Abandoned: nothing attached and its proxy is gone from the pool.
      'kin-eg-px-dead': { subnet: '172.23.0.0/16', gateway: '172.23.0.1', bridge: 'kegdead', containers: 0 },
      // Serving traffic.
      'kin-eg-px-live': { subnet: '172.24.0.0/16', gateway: '172.24.0.1', bridge: 'keglive', containers: 1 },
    },
  })
}

const LIVE = { proxyIds: ['px-live'], vmIds: ['vm-01'], proxies: [{ id: 'px-live' }], complete: true }

// ---------- live set ----------

test('a readable registry and pool give a complete live set', () => {
  const live = collectLiveSet({
    projectRoot: '/srv/kin',
    dataDir: '/srv/kin/data',
    listVms: () => [{ id: 'vm-01' }, { id: 'vm-02' }],
    openPool: () => ({ snapshot: () => ({ proxies: [{ id: 'px-a', url: 'socks5h://x' }, { id: 'px-b' }] }) }),
  })

  assert.equal(live.complete, true)
  assert.deepEqual(live.vmIds, ['vm-01', 'vm-02'])
  assert.deepEqual(live.proxyIds, ['px-a', 'px-b'])
  // Records come along: a reprovision hands the real proxy to the helper rebuild.
  assert.equal(live.proxies[0].url, 'socks5h://x')
})

test('an unreadable source makes the live set incomplete and says which', () => {
  const noVms = collectLiveSet({
    listVms: () => {
      throw new Error('registry missing')
    },
    openPool: () => ({ snapshot: () => ({ proxies: [] }) }),
  })
  assert.equal(noVms.complete, false)
  assert.match(noVms.reason, /vm registry unreadable: registry missing/)

  const noPool = collectLiveSet({
    listVms: () => [],
    openPool: () => {
      throw new Error('pool locked')
    },
  })
  assert.equal(noPool.complete, false)
  assert.match(noPool.reason, /proxy pool unreadable: pool locked/)
})

test('an empty registry is complete, not unknown', () => {
  // "Nothing is live" and "we cannot tell what is live" must not look alike.
  const live = collectLiveSet({ listVms: () => [], openPool: () => ({ snapshot: () => ({ proxies: [] }) }) })

  assert.equal(live.complete, true)
  assert.deepEqual(live.proxyIds, [])
})

// ---------- verify ----------

test('verify is read-only and reports what it judged against', (t) => {
  const root = tmpRoot(t)
  const d = orphanWorld()
  const before = JSON.stringify(d.table)

  const r = verifyEgress({ projectRoot: root, live: LIVE, runDocker: d.run, runIptables: okIptables, runIp: okIp })

  assert.equal(r.action, 'verify')
  assert.equal(r.clean, false)
  assert.equal(r.counts.network, 1, 'only the abandoned one counts')
  assert.deepEqual(r.live, { proxies: 1, vms: 1, complete: true })
  assert.equal(JSON.stringify(d.table), before, 'verify must change nothing')
  assert.deepEqual(d.removed, [])
})

test('verify still runs on an incomplete live set, and says so', (t) => {
  const root = tmpRoot(t)
  const d = orphanWorld()
  const r = verifyEgress({
    projectRoot: root,
    live: { proxyIds: [], vmIds: [], complete: false, reason: 'pool locked' },
    runDocker: d.run,
    runIptables: okIptables,
    runIp: okIp,
  })

  assert.equal(r.live.complete, false, 'the report has to disclose what it could not know')
  assert.equal(r.clean, false)
  // An attached container protects a network on its own, independently of the live
  // set, so losing the registry cannot make a serving exit look abandoned.
  assert.equal(r.counts.network, 1)
})

// ---------- sweep ----------

test('a sweep refuses on an incomplete live set rather than guessing', (t) => {
  const root = tmpRoot(t)
  const d = orphanWorld()
  const r = sweepEgress({
    projectRoot: root,
    live: { proxyIds: [], vmIds: [], complete: false, reason: 'pool locked' },
    runDocker: d.run,
    runIptables: okIptables,
    runIp: okIp,
    apply: true,
  })

  assert.equal(r.refused, true)
  assert.match(r.reason, /live set is incomplete \(pool locked\); every exit would look orphaned/)
  assert.deepEqual(d.removed, [], 'nothing may be removed while the live set is unknown')
})

test('a sweep is dry by default and names what it would clear', (t) => {
  const root = tmpRoot(t)
  const d = orphanWorld()
  const r = sweepEgress({ projectRoot: root, live: LIVE, runDocker: d.run, runIptables: okIptables, runIp: okIp })

  assert.equal(r.dryRun, true)
  assert.equal(r.planned, 1)
  assert.match(r.lines.join('\n'), /docker network rm kin-eg-px-dead/)
  assert.deepEqual(d.removed, [])
  assert.equal(r.clean, null, 'a dry run changed nothing to recheck')
})

test('an applied sweep clears only the abandoned exit and rechecks', (t) => {
  const root = tmpRoot(t)
  const d = orphanWorld()
  const r = sweepEgress({
    projectRoot: root,
    live: LIVE,
    runDocker: d.run,
    runIptables: okIptables,
    runIp: okIp,
    apply: true,
  })

  assert.equal(r.dryRun, false)
  assert.deepEqual(r.failed, [])
  assert.deepEqual(d.removed, ['kin-eg-px-dead'])
  assert.ok(d.table['kin-eg-px-live'], 'the exit serving traffic must survive')
  assert.equal(r.clean, true)
})

test('force takes an unknown live set at face value, but attachment still protects', (t) => {
  const root = tmpRoot(t)
  const d = orphanWorld()
  const r = sweepEgress({
    projectRoot: root,
    live: { proxyIds: [], vmIds: [], complete: false, reason: 'pool locked' },
    runDocker: d.run,
    runIptables: okIptables,
    runIp: okIp,
    apply: true,
    force: true,
  })

  assert.equal(r.refused, undefined, 'force bypasses the refusal')
  assert.equal(r.forced, true)
  // Force only waives the live-set check. A container sitting on a network is a
  // separate, stronger guard, so even a forced sweep leaves a serving exit alone.
  assert.deepEqual(d.removed, ['kin-eg-px-dead'])
  assert.ok(d.table['kin-eg-px-live'])
})

test('a sweep reports a stubborn resource instead of claiming success', (t) => {
  const root = tmpRoot(t)
  const d = orphanWorld()
  const stubborn = (args) =>
    args[0] === 'network' && args[1] === 'rm' ? { ok: false, stderr: 'network has active endpoints' } : d.run(args)

  const r = sweepEgress({
    projectRoot: root,
    live: LIVE,
    runDocker: stubborn,
    runIptables: okIptables,
    runIp: okIp,
    apply: true,
  })

  assert.equal(r.failed.length, 1)
  assert.match(JSON.stringify(r.failed), /active endpoints/)
  assert.equal(r.clean, false)
})

// ---------- reprovision ----------

test('a reprovision refuses on an incomplete live set', async () => {
  let called = false
  const r = await reprovisionEgress({
    projectRoot: '/srv/kin',
    live: { proxyIds: [], vmIds: [], complete: false, reason: 'pool locked' },
    apply: true,
    reprovision: async () => {
      called = true
      return {}
    },
  })

  assert.equal(r.refused, true)
  assert.match(r.reason, /refusing to tear down exits/)
  assert.equal(called, false, 'the orchestrator must not even be entered')
})

test('a reprovision hands the real proxy record to both callbacks', async () => {
  const seen = { ensured: [], verified: [] }
  const live = {
    proxyIds: ['px-a'],
    vmIds: ['vm-01'],
    proxies: [{ id: 'px-a', url: 'socks5h://secret@host:1080' }],
    complete: true,
  }

  await reprovisionEgress({
    projectRoot: '/srv/kin',
    live,
    apply: true,
    ensureProxyEgress: async (root, proxy) => {
      seen.ensured.push([root, proxy])
      return { ok: true }
    },
    proxyEgressReady: (proxy, root) => {
      seen.verified.push([proxy, root])
      return { ok: true }
    },
    reprovision: async (opts) => {
      // Stand in for the orchestrator calling back once per rebuilt network.
      await opts.ensureEgress({ proxy_id: 'px-a', network: 'kin-eg-px-a' })
      const v = await opts.verifyExit({ proxy_id: 'px-a', network: 'kin-eg-px-a' })
      return { dryRun: false, ok: v.ok, target: 'pool', phases: [], feasibility: { checks: [] } }
    },
  })

  // The url matters: the helper cannot be rebuilt from an id alone.
  assert.equal(seen.ensured[0][1].url, 'socks5h://secret@host:1080')
  assert.equal(seen.ensured[0][0], '/srv/kin')
  assert.equal(seen.verified[0][0].id, 'px-a')
  assert.equal(seen.verified[0][1], '/srv/kin')
})

test('a proxy the pool no longer knows gets its network back but no helper', async () => {
  let ensured = 0
  const r = await reprovisionEgress({
    projectRoot: '/srv/kin',
    live: { proxyIds: ['px-a'], vmIds: [], proxies: [{ id: 'px-a' }], complete: true },
    apply: true,
    ensureProxyEgress: async () => {
      ensured += 1
      return { ok: true }
    },
    proxyEgressReady: () => ({ ok: true }),
    reprovision: async (opts) => {
      const e = await opts.ensureEgress({ proxy_id: 'px-vanished', network: 'kin-eg-px-vanished' })
      await opts.verifyExit({ proxy_id: 'px-vanished', network: 'kin-eg-px-vanished' })
      return {
        dryRun: false,
        ok: true,
        target: 'pool',
        phases: [{ name: 'helpers', ok: true, detail: e.skipped }],
        feasibility: { checks: [] },
      }
      // The teardown still happened, so nothing is left holding its old range.
    },
  })

  assert.equal(ensured, 0, 'no helper may be started against a record we do not have')
  assert.match(JSON.stringify(r.phases), /no longer in the pool/)
})

test('a dry reprovision passes the dry flag straight through', async () => {
  const r = await reprovisionEgress({
    projectRoot: '/srv/kin',
    live: LIVE,
    reprovision: async (opts) => {
      assert.equal(opts.dryRun, true)
      return { dryRun: true, target: 'pool', phases: [], feasibility: { checks: [] }, lines: ['build ...'] }
    },
  })

  assert.equal(r.dryRun, true)
  assert.deepEqual(r.lines, ['build ...'])
})

test('a rollback is driven by target and snapshot directory', async () => {
  let got = null
  await reprovisionEgress({
    projectRoot: '/srv/kin',
    live: LIVE,
    apply: true,
    target: 'snapshot',
    snapshotDir: '/srv/kin/data/run/reprovision/123',
    reprovision: async (opts) => {
      got = opts
      return { dryRun: false, ok: true, target: 'snapshot', phases: [], feasibility: { checks: [] } }
    },
  })

  assert.equal(got.target, 'snapshot')
  assert.equal(got.snapshotDir, '/srv/kin/data/run/reprovision/123')
})

// ---------- executors ----------

test('the shell runner reports failure instead of throwing', () => {
  const run = shellRunner()

  const ok = run(['node', '-e', 'process.stdout.write("hi")'])
  assert.equal(ok.ok, true)
  assert.equal(ok.stdout, 'hi')

  const bad = run(['node', '-e', 'process.exit(3)'])
  assert.equal(bad.ok, false)

  const missing = run(['definitely-not-a-real-binary-xyz'])
  assert.equal(missing.ok, false)
  assert.ok(missing.stderr.length > 0)
})

test('the executors front docker, iptables and ip', () => {
  const calls = []
  const execs = maintenanceExecutors((argv) => {
    calls.push(argv)
    return { ok: true, stdout: '' }
  })

  execs.runDocker(['network', 'ls'])
  execs.runIptables(['-t', 'nat', '-S'])
  execs.runIp(['-o', 'link', 'show'])

  assert.deepEqual(calls, [
    ['docker', 'network', 'ls'],
    ['iptables', '-t', 'nat', '-S'],
    ['ip', '-o', 'link', 'show'],
  ])
})
