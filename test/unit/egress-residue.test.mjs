import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isClean,
  isProtectedNetwork,
  residueItems,
  residueReport,
  scanBridges,
  scanContainers,
  scanIptablesChains,
  scanNetworks,
  scanResidue,
  scanRunDirs,
} from '../../src/lib/vm/egress-residue.mjs'
import { egressRunDir } from '../../src/lib/vm/egress.mjs'

/** Field separator the scanner asks docker to emit between format fields. */
const F = '\u0001'

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-residue-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Stands in for `docker`. `nets` maps a network name to its inspect fields; `ps`
 * is the container table. Output mirrors what the real format strings produce.
 */
function fakeDocker({ nets = {}, ps = [], failLs = false, failInspect = false, failPs = false } = {}) {
  return (args) => {
    const [verb, action] = args
    if (verb === 'network' && action === 'ls') {
      if (failLs) return { ok: false, stderr: 'docker daemon unreachable' }
      return { ok: true, stdout: Object.keys(nets).join('\n') }
    }
    if (verb === 'network' && action === 'inspect') {
      if (failInspect) return { ok: false, stderr: 'inspect failed' }
      const out = args
        .slice(4)
        .filter((n) => nets[n])
        .map((n) => {
          const d = nets[n]
          return [n, d.subnet || '', d.bridge || '', String(d.containers ?? 0), d.vm || '', d.proxy || ''].join(F)
        })
      return { ok: true, stdout: out.join('\n') }
    }
    if (verb === 'ps') {
      if (failPs) return { ok: false, stderr: 'ps failed' }
      return {
        ok: true,
        stdout: ps
          .map((c) => [c.name, c.egress || '', c.proxy || '', c.vm || '', c.state || 'exited'].join(F))
          .join('\n'),
      }
    }
    return { ok: true, stdout: '' }
  }
}

function fakeIptables({ nat = [], filter = [], fail = false } = {}) {
  return (args) => {
    if (fail) return { ok: false, stderr: 'Permission denied (you must be root)' }
    const table = args[1]
    if (table === 'nat') return { ok: true, stdout: nat.join('\n') }
    if (table === 'filter') return { ok: true, stdout: filter.join('\n') }
    return { ok: true, stdout: '' }
  }
}

function fakeIp(devices = [], { fail = false } = {}) {
  return () => {
    if (fail) return { ok: false, stderr: 'ip: not found' }
    return {
      ok: true,
      stdout: devices
        .map((d, i) => `${i + 3}: ${d}: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP`)
        .join('\n'),
    }
  }
}

function writeRunDir(root, key, cfg) {
  const dir = egressRunDir(root, key)
  fs.mkdirSync(dir, { recursive: true })
  if (cfg) fs.writeFileSync(path.join(dir, 'egress.json'), JSON.stringify(cfg))
  return dir
}

function byName(items, name) {
  const found = items.find((i) => i.name === name)
  assert.ok(found, `expected an item named ${name}, got ${items.map((i) => i.name).join(', ')}`)
  return found
}

// ---------- networks ----------

test('an unused network whose owner is gone is residue, and carries what it holds', () => {
  const runDocker = fakeDocker({
    nets: { 'kin-eg-px-dead': { subnet: '172.23.0.0/16', bridge: 'kegdead', containers: 0 } },
  })
  const r = scanNetworks({ runDocker, live: {} })
  const item = byName(r.items, 'kin-eg-px-dead')

  assert.equal(r.ok, true)
  assert.equal(item.orphan, true)
  assert.equal(item.subnet, '172.23.0.0/16')
  assert.equal(item.bridge, 'kegdead')
  assert.match(item.reason, /no container attached and owner not live/)
})

test('a network with containers attached is never residue', () => {
  const runDocker = fakeDocker({
    nets: { 'kin-eg-px-busy': { subnet: '172.24.0.0/16', bridge: 'kegbusy', containers: 2 } },
  })
  const item = byName(scanNetworks({ runDocker, live: {} }).items, 'kin-eg-px-busy')

  assert.equal(item.orphan, false)
  assert.match(item.reason, /in use: 2 container/)
})

test('the shared local bridge is protected even with nothing attached', () => {
  assert.equal(isProtectedNetwork('kin-eg-px-local'), true)
  const runDocker = fakeDocker({
    nets: { 'kin-eg-px-local': { subnet: '192.168.144.0/20', bridge: 'keglocal', containers: 0 } },
  })
  const item = byName(scanNetworks({ runDocker, live: {} }).items, 'kin-eg-px-local')

  assert.equal(item.orphan, false)
  assert.equal(item.protected, true)
  // And it must never surface as something to delete.
  assert.deepEqual(residueItems({ networks: [item] }), [])
})

test('a live owner keeps its network, by label or by name', () => {
  const runDocker = fakeDocker({
    nets: {
      'kin-eg-px-keep': { subnet: '100.64.0.0/28', bridge: 'kegkeep', containers: 0 },
      'kin-07-net': { subnet: '100.64.0.16/28', bridge: 'keg0707070707', containers: 0, vm: 'vm-07' },
    },
  })
  const found = scanNetworks({ runDocker, live: { proxyIds: ['px-keep'], vmIds: ['vm-07'] } }).items

  assert.equal(byName(found, 'kin-eg-px-keep').orphan, false)
  assert.equal(byName(found, 'kin-07-net').orphan, false)
  assert.match(byName(found, 'kin-07-net').reason, /owner still live/)
})

test('networks outside this project are ignored entirely', () => {
  const runDocker = fakeDocker({
    nets: {
      bridge: { subnet: '172.17.0.0/16', bridge: 'docker0', containers: 0 },
      dsp_default: { subnet: '172.28.0.0/16', bridge: 'br-abc', containers: 0 },
      'kin-eg-px-dead': { subnet: '172.23.0.0/16', bridge: 'kegdead', containers: 0 },
    },
  })

  assert.deepEqual(
    scanNetworks({ runDocker, live: {} }).items.map((i) => i.name),
    ['kin-eg-px-dead'],
  )
})

test('an unreadable network list or a partial inspect is reported, not treated as empty', () => {
  assert.equal(scanNetworks({ runDocker: fakeDocker({ failLs: true }), live: {} }).ok, false)
  // A partial inventory is the dangerous case: some names came back, details did not.
  const partial = scanNetworks({
    runDocker: fakeDocker({ nets: { 'kin-eg-px-dead': { subnet: '172.23.0.0/16' } }, failInspect: true }),
    live: {},
  })
  assert.equal(partial.ok, false)
  assert.deepEqual(partial.items, [])
})

// ---------- run dirs ----------

test('a run directory whose network is gone is residue and still claims its ports', (t) => {
  // The px-test-b case measured on the dev host: network long gone, ports still held.
  const root = tmpRoot(t)
  writeRunDir(root, 'px-test-b', {
    proxy_id: 'px-test-b',
    listen_tcp: '192.168.160.1:20218',
    listen_dns: '192.168.160.1:20219',
  })
  const item = byName(scanRunDirs({ projectRoot: root, networks: [], live: {} }).items, 'px-test-b')

  assert.equal(item.orphan, true)
  assert.deepEqual(item.ports, [20218, 20219])
  assert.match(item.reason, /no matching docker network/)
})

test('a run directory with no readable config is residue', (t) => {
  // The px-e84acaf0 case: directory present, egress.json absent.
  const root = tmpRoot(t)
  writeRunDir(root, 'px-e84acaf0', null)
  const item = byName(scanRunDirs({ projectRoot: root, networks: [], live: {} }).items, 'px-e84acaf0')

  assert.equal(item.orphan, true)
  assert.deepEqual(item.ports, [])
  assert.match(item.reason, /no readable egress\.json/)
})

test('a run directory backed by a live network and owner is kept', (t) => {
  const root = tmpRoot(t)
  writeRunDir(root, 'px-live', { proxy_id: 'px-live', listen_tcp: '100.64.0.1:20300', listen_dns: '100.64.0.1:20301' })
  const networks = [{ name: 'kin-eg-px-live', bridge: 'keglive' }]
  const item = byName(scanRunDirs({ projectRoot: root, networks, live: { proxyIds: ['px-live'] } }).items, 'px-live')

  assert.equal(item.orphan, false)
  assert.match(item.reason, /network present and owner live/)
})

test('an absent run directory tree is nothing, not an unreadable one', () => {
  const r = scanRunDirs({ projectRoot: '/nonexistent-kin-root', networks: [] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.items, [])
})

// ---------- containers ----------

test('all three helper naming generations are recognised as residue', () => {
  const runDocker = fakeDocker({
    ps: [
      { name: 'kin-cp-egress-px-dead', egress: '1', proxy: 'px-dead' },
      { name: 'kin-09-egress', egress: '1', vm: 'vm-09' },
      // Pre-1.3.88 node helper, predating labels: caught by name alone.
      { name: 'kin-egress-px-ancient' },
      { name: 'some-unrelated-container' },
    ],
  })
  const found = scanContainers({ runDocker, networks: [], live: {} }).items

  assert.deepEqual(found.map((i) => i.name).sort(), ['kin-09-egress', 'kin-cp-egress-px-dead', 'kin-egress-px-ancient'])
  for (const i of found) assert.equal(i.orphan, true, `${i.name} should be residue`)
})

test('a helper whose owner is still live is kept', () => {
  const runDocker = fakeDocker({
    ps: [
      { name: 'kin-cp-egress-px-keep', egress: '1', proxy: 'px-keep', state: 'running' },
      { name: 'kin-09-egress', egress: '1', vm: 'vm-09', state: 'running' },
    ],
  })
  const found = scanContainers({ runDocker, networks: [], live: { proxyIds: ['px-keep'], vmIds: ['vm-09'] } }).items

  for (const i of found) {
    assert.equal(i.orphan, false)
    assert.match(i.reason, /owner still live/)
  }
})

test('an unreadable container table is reported', () => {
  assert.equal(scanContainers({ runDocker: fakeDocker({ failPs: true }), networks: [] }).ok, false)
})

// ---------- iptables ----------

test('a chain left behind after its network was deleted is residue', () => {
  // The half-cleanup case: the network is gone but the ruleset still steers its
  // bridge. Nothing in docker or the route table reveals this.
  const runIptables = fakeIptables({
    nat: [
      '-N KEGdeadbeef12',
      '-A PREROUTING -i kegdeadbeef12 -j KEGdeadbeef12',
      '-A KEGdeadbeef12 -p tcp -j REDIRECT --to-ports 20334',
    ],
    filter: ['-A FORWARD -i kegdeadbeef12 ! -d 100.64.0.0/28 -j DROP'],
  })
  const found = scanIptablesChains({ runIptables, networks: [] }).items

  assert.ok(found.length >= 2, 'both tables should report')
  for (const i of found) {
    assert.equal(i.orphan, true)
    assert.equal(i.bridge, 'kegdeadbeef12')
    assert.match(i.reason, /belongs to no network/)
  }
  // A row naming only the chain is still judged, via the chain/bridge tag pairing.
  const nat = found.find((i) => i.table === 'nat')
  assert.equal(nat.chain, 'KEGdeadbeef12')
  assert.ok(nat.rules.some((r) => r.includes('REDIRECT')))
})

test('a chain whose bridge still belongs to a network is kept', () => {
  const runIptables = fakeIptables({ nat: ['-N KEGlive1234', '-A PREROUTING -i keglive1234 -j KEGlive1234'] })
  const found = scanIptablesChains({ runIptables, networks: [{ name: 'kin-eg-px-live', bridge: 'keglive1234' }] }).items

  for (const i of found) {
    assert.equal(i.orphan, false)
    assert.match(i.reason, /still has a network/)
  }
})

test('unrelated iptables rules are ignored', () => {
  const runIptables = fakeIptables({
    nat: ['-P PREROUTING ACCEPT', '-A POSTROUTING -s 172.17.0.0/16 -j MASQUERADE'],
    filter: ['-A FORWARD -i docker0 -j ACCEPT'],
  })
  assert.deepEqual(scanIptablesChains({ runIptables, networks: [] }).items, [])
})

test('a ruleset that needs root reports not-ok rather than an empty clean result', () => {
  // Reading iptables needs root. Returning [] here would let an unreadable host
  // pass as clean, which is the whole failure mode this guards.
  const r = scanIptablesChains({ runIptables: fakeIptables({ fail: true }), networks: [] })
  assert.equal(r.ok, false)
  assert.deepEqual(r.items, [])
})

// ---------- bridges ----------

test('a keg device outliving its network is residue', () => {
  const found = scanBridges({ runIp: fakeIp(['lo', 'eth0', 'docker0', 'kegzombie12']), networks: [] }).items

  assert.deepEqual(
    found.map((i) => i.name),
    ['kegzombie12'],
  )
  assert.equal(found[0].orphan, true)
  assert.match(found[0].reason, /no docker network claims this bridge/)
})

test('a keg device claimed by a live network is kept', () => {
  const found = scanBridges({
    runIp: fakeIp(['keglive1234']),
    networks: [{ name: 'kin-eg-px-live', bridge: 'keglive1234' }],
  }).items

  assert.equal(found[0].orphan, false)
})

test('an unreadable link list is reported', () => {
  assert.equal(scanBridges({ runIp: fakeIp([], { fail: true }), networks: [] }).ok, false)
})

// ---------- full scan, clean judgement, report ----------

test('a fully clean host reports clean across all five classes', (t) => {
  const root = tmpRoot(t)
  const scan = scanResidue({
    projectRoot: root,
    runDocker: fakeDocker({
      nets: { 'kin-eg-px-live': { subnet: '100.64.0.0/28', bridge: 'keglive1234', containers: 1 } },
      ps: [{ name: 'kin-cp-egress-px-live', egress: '1', proxy: 'px-live', state: 'running' }],
    }),
    runIptables: fakeIptables({ nat: ['-N KEGlive1234', '-A PREROUTING -i keglive1234 -j KEGlive1234'] }),
    runIp: fakeIp(['keglive1234']),
    live: { proxyIds: ['px-live'] },
  })

  assert.deepEqual(scan.unavailable, [])
  assert.equal(isClean(scan), true)
  assert.equal(residueReport(scan).clean, true)
  assert.deepEqual(residueReport(scan).items, [])
})

test('deleting only the network leaves the host dirty', (t) => {
  // The reverse case that guards against inferring cleanliness from "network gone".
  const root = tmpRoot(t)
  const scan = scanResidue({
    projectRoot: root,
    // Network removed...
    runDocker: fakeDocker({ nets: {}, ps: [] }),
    // ...but its chain and bridge are still there.
    runIptables: fakeIptables({ nat: ['-N KEGlive1234', '-A PREROUTING -i keglive1234 -j KEGlive1234'] }),
    runIp: fakeIp(['keglive1234']),
    live: {},
  })

  assert.equal(isClean(scan), false, 'a half cleanup must not pass as clean')
  const report = residueReport(scan)
  assert.equal(report.counts.network, 0)
  assert.equal(report.counts.iptables, 1)
  assert.equal(report.counts.bridge, 1)
})

test('a class that cannot be read is never reported clean', (t) => {
  const root = tmpRoot(t)
  const scan = scanResidue({
    projectRoot: root,
    runDocker: fakeDocker({ nets: {}, ps: [] }),
    // No root: the ruleset is unknown, so cleanliness is unknown.
    runIptables: fakeIptables({ fail: true }),
    runIp: fakeIp([]),
    live: {},
  })

  assert.deepEqual(scan.unavailable, ['iptables'])
  assert.equal(isClean(scan), false, 'unknown must not read as clean')
  const report = residueReport(scan)
  assert.equal(report.clean, false)
  assert.deepEqual(report.items, [], 'there are no known orphans, yet it is still not clean')
  assert.match(report.lines.join('\n'), /iptables\s+\(not readable/)
})

test('missing executors are reported as unreadable classes', () => {
  const scan = scanResidue({ projectRoot: '/nonexistent-kin-root' })

  assert.deepEqual(scan.unavailable.sort(), ['bridge', 'container', 'iptables', 'network'])
  assert.equal(isClean(scan), false)
})

test('the report names each item, what it holds, and why it was judged', (t) => {
  const root = tmpRoot(t)
  writeRunDir(root, 'px-test-b', { proxy_id: 'px-test-b', listen_tcp: '1.2.3.4:20218', listen_dns: '1.2.3.4:20219' })
  const scan = scanResidue({
    projectRoot: root,
    runDocker: fakeDocker({
      nets: { 'kin-eg-px-dead': { subnet: '172.23.0.0/16', bridge: 'kegdead12345', containers: 0 } },
      ps: [{ name: 'kin-egress-px-ancient' }],
    }),
    runIptables: fakeIptables({ nat: ['-N KEGorphan1234'] }),
    runIp: fakeIp(['kegzombie1234']),
    live: {},
  })
  const report = residueReport(scan)

  assert.equal(report.clean, false)
  assert.deepEqual(report.counts, { network: 1, rundir: 1, container: 1, iptables: 1, bridge: 1 })
  const text = report.lines.join('\n')
  // Holdings must be visible, not just a name.
  assert.match(text, /network kin-eg-px-dead\s+subnet=172\.23\.0\.0\/16\s+bridge=kegdead12345/)
  assert.match(text, /rundir px-test-b\s+ports=20218,20219/)
  assert.match(text, /iptables KEGorphan1234\s+table=nat/)
  assert.match(text, /bridge kegzombie1234/)
  // Every line carries a reason in parentheses.
  for (const line of report.lines) assert.match(line, /\(.+\)$/)
})

test('residueItems can include in-use resources, which a unified rebuild needs', (t) => {
  const root = tmpRoot(t)
  const scan = scanResidue({
    projectRoot: root,
    runDocker: fakeDocker({
      nets: {
        'kin-eg-px-busy': { subnet: '172.24.0.0/16', bridge: 'kegbusy1234', containers: 2 },
        'kin-eg-px-local': { subnet: '192.168.144.0/20', bridge: 'keglocal123', containers: 1 },
      },
    }),
    live: { proxyIds: ['px-busy'] },
  })

  assert.deepEqual(residueItems(scan, { orphansOnly: true }), [])
  const all = residueItems(scan, { orphansOnly: false })
  assert.deepEqual(
    all.map((i) => i.name),
    ['kin-eg-px-busy'],
  )
  // Protected stays out even when everything is being torn down.
  assert.ok(!all.some((i) => i.name === 'kin-eg-px-local'))
})
