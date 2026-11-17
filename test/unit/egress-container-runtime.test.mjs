import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  egressContainerName,
  egressContainerSpec,
  egressRunDir,
  egressRuntime,
  inspectEgressProcess,
  nativeDockerPlatform,
  startEgressProcess,
  stopEgressProcess,
} from '../../src/lib/vm/egress.mjs'

/** Minimal docker CLI double: tracks helper containers by name. */
function fakeDocker() {
  const containers = new Map()
  const calls = []
  const run = (args) => {
    calls.push(args)
    const [cmd] = args
    if (cmd === 'inspect') {
      const name = args.at(-1)
      if (args[2] === '{{.Image}}') return { ok: true, stdout: 'sha256:selfimage' }
      const c = containers.get(name)
      if (!c) return { ok: false, stdout: '', stderr: `Error: No such object: ${name}` }
      return { ok: true, stdout: `${c.running}|${c.restarting}|${c.pid}|${c.digest}|${c.bin}` }
    }
    if (cmd === 'run') {
      const name = args[args.indexOf('--name') + 1]
      const label = (key) => args.find((a) => String(a).startsWith(`${key}=`)).split('=')[1]
      containers.set(name, {
        running: true,
        restarting: false,
        pid: 4242,
        digest: label('kin.egress.cfg'),
        bin: label('kin.egress.bin'),
        args,
      })
      return { ok: true, stdout: 'cid' }
    }
    if (cmd === 'rm') {
      const name = args.at(-1)
      if (!containers.delete(name)) return { ok: false, stderr: `Error: No such container: ${name}` }
      return { ok: true }
    }
    return { ok: false, stderr: `unexpected docker ${args.join(' ')}` }
  }
  const mutations = () => calls.filter((c) => c[0] === 'run' || c[0] === 'rm').length
  return { run, containers, calls, mutations }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-eg-ctr-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const binDir = path.join(root, 'bin')
  fs.mkdirSync(binDir)
  const bin = path.join(binDir, 'kin-egress')
  fs.writeFileSync(bin, 'static-binary-v1', { mode: 0o755 })
  const d = fakeDocker()
  const base = {
    projectRoot: root,
    proxyId: 'px-ctr',
    proxyUrl: 'socks5h://192.0.2.1:1080',
    listenHost: '192.168.176.1',
    tcpPort: 0,
    dnsPort: 0,
    bin,
    runtime: 'container',
    runDocker: d.run,
    hostPath: (p) => p.replace(root, '/srv/vm2api'),
  }
  const helper = () => d.containers.get('kin-cp-egress-px-ctr')
  return { root, bin, d, helper, start: (opts = {}) => startEgressProcess({ ...base, ...opts }) }
}

test('runtime is container inside the compose deployment and process elsewhere', () => {
  assert.equal(
    egressRuntime({}, () => true),
    'process',
  )
  assert.equal(
    egressRuntime({ VM2API_CONTAINER_NAME: 'vm2api' }, () => true),
    'container',
  )
  assert.equal(
    egressRuntime({ VM2API_CONTAINER_NAME: 'vm2api' }, () => false),
    'process',
  )
  assert.equal(
    egressRuntime({ VM2API_CONTAINER_NAME: 'vm2api', KIN_EGRESS_RUNTIME: 'process' }, () => true),
    'process',
  )
  assert.equal(
    egressRuntime({ KIN_EGRESS_RUNTIME: 'container' }, () => false),
    'container',
  )
})

test('helper container is a host-network, capability-free, self-restarting kin-egress', () => {
  const spec = egressContainerSpec({
    proxyId: 'px-556cf973',
    body: '{"a":1}\n',
    hostDir: '/opt/vm2api/data/run/egress/px-556cf973',
    hostBinDir: '/opt/vm2api/bin',
    binName: 'kin-egress',
    image: 'sha256:img',
    binFingerprint: '1:2',
  })
  assert.equal(spec.name, 'kin-cp-egress-px-556cf973')
  const a = spec.args
  const after = (flag) => a[a.indexOf(flag) + 1]
  assert.equal(after('--network'), 'host')
  assert.equal(after('--restart'), 'unless-stopped')
  assert.equal(after('--cap-drop'), 'ALL')
  assert.ok(a.includes('--read-only'))
  assert.equal(after('--entrypoint'), '/opt/kin-egress-bin/kin-egress')
  assert.ok(a.includes('/opt/vm2api/data/run/egress/px-556cf973:/etc/kin-egress:ro'))
  assert.ok(a.includes('/opt/vm2api/bin:/opt/kin-egress-bin:ro'))
  assert.deepEqual(a.slice(-3), ['sha256:img', '-config', '/etc/kin-egress/egress.json'])
  assert.ok(a.includes(`kin.egress.cfg=${spec.digest}`))
})

test('digest follows config and binary but not the control-plane image', () => {
  const base = {
    proxyId: 'px-x',
    body: 'b',
    hostDir: '/d',
    hostBinDir: '/b',
    binName: 'kin-egress',
    image: 'img-1',
    binFingerprint: '1:1',
  }
  const d0 = egressContainerSpec(base).digest
  assert.equal(egressContainerSpec({ ...base, image: 'img-2' }).digest, d0)
  assert.notEqual(egressContainerSpec({ ...base, body: 'c' }).digest, d0)
  assert.notEqual(egressContainerSpec({ ...base, binFingerprint: '2:1' }).digest, d0)
})

test('container runtime creates the helper once and reuses it across control-plane restarts', async (t) => {
  const fx = fixture(t)
  const first = await fx.start()
  assert.equal(first.ok, true)
  assert.equal(first.reused, false)
  assert.equal(first.container, 'kin-cp-egress-px-ctr')
  assert.equal(first.pid, 0, 'caller must not filter listeners by a PID it cannot see')
  assert.ok(fx.helper().args.includes(`${egressRunDir('/srv/vm2api', 'px-ctr')}:/etc/kin-egress:ro`))
  assert.ok(fx.helper().args.includes('sha256:selfimage'))
  const cfgPath = path.join(egressRunDir(fx.root, 'px-ctr'), 'egress.json')
  assert.equal(fs.statSync(cfgPath).mode & 0o777, 0o600)
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).listen_dns, '192.168.176.1:0')
  assert.equal(fs.existsSync(path.join(egressRunDir(fx.root, 'px-ctr'), 'egress.pid')), false)

  // A restarted control plane asks again with the same config: nothing is touched.
  const before = fx.d.mutations()
  const again = await fx.start()
  assert.equal(again.ok, true)
  assert.equal(again.reused, true)
  assert.equal(fx.d.mutations(), before)
})

test('container runtime replaces the helper on config change, binary upgrade or crash loop', async (t) => {
  const fx = fixture(t)
  await fx.start()
  const d1 = fx.helper().digest

  const changed = await fx.start({ dnsUpstream: '8.8.8.8:53' })
  assert.equal(changed.reused, false)
  const d2 = fx.helper().digest
  assert.notEqual(d2, d1)
  assert.ok(fx.d.calls.some((c) => c[0] === 'rm' && c.includes('-f')))

  fs.writeFileSync(fx.bin, 'static-binary-v2-longer')
  const upgraded = await fx.start({ dnsUpstream: '8.8.8.8:53' })
  assert.equal(upgraded.reused, false)
  assert.notEqual(fx.helper().digest, d2)

  fx.helper().restarting = true
  const healed = await fx.start({ dnsUpstream: '8.8.8.8:53' })
  assert.equal(healed.reused, false)
  assert.equal(fx.helper().restarting, false)
})

test('container runtime inspect and stop act on the helper container', async (t) => {
  const fx = fixture(t)
  const opts = { runtime: 'container', runDocker: fx.d.run }
  assert.equal(inspectEgressProcess(fx.root, 'px-ctr', opts).reason, 'not_running')
  await fx.start()
  const st = inspectEgressProcess(fx.root, 'px-ctr', opts)
  assert.equal(st.ok, true)
  assert.equal(st.listen_tcp, '192.168.176.1:0')
  assert.equal(st.container, egressContainerName('px-ctr'))
  fx.helper().restarting = true
  assert.equal(inspectEgressProcess(fx.root, 'px-ctr', opts).ok, false)
  assert.equal(stopEgressProcess(fx.root, 'px-ctr', opts).ok, true)
  assert.equal(fx.helper(), undefined)
  // Already gone is still a successful stop.
  assert.equal(stopEgressProcess(fx.root, 'px-ctr', opts).ok, true)
})

test('container runtime refuses to start without the helper binary', async (t) => {
  const fx = fixture(t)
  const r = await fx.start({ bin: path.join(fx.root, 'missing') })
  assert.equal(r.ok, false)
  assert.match(r.error, /binary not found/)
  assert.equal(fx.d.containers.size, 0)
})

test('helper pins the native platform so the ARM64 slot default cannot reach it', async (t) => {
  assert.equal(nativeDockerPlatform('arm64'), 'linux/arm64')
  assert.equal(nativeDockerPlatform('x64'), 'linux/amd64')
  const spec = egressContainerSpec({
    proxyId: 'px-arm',
    body: 'b',
    hostDir: '/d',
    hostBinDir: '/b',
    binName: 'kin-egress',
    image: 'sha256:img',
    platform: 'linux/arm64',
  })
  const a = spec.args
  assert.equal(a[a.indexOf('--platform') + 1], 'linux/arm64')
  assert.ok(a.indexOf('--platform') < a.indexOf('sha256:img'))
  const fx = fixture(t)
  await fx.start()
  const args = fx.helper().args
  assert.equal(args[args.indexOf('--platform') + 1], nativeDockerPlatform())
})

test('restart re-copy of an unchanged binary keeps the helper', async (t) => {
  const fx = fixture(t)
  await fx.start()
  // docker-entrypoint ensure_bin: cp to .new, then mv over bin/ (new inode, new mtime, same bytes).
  const tmp = `${fx.bin}.new`
  fs.writeFileSync(tmp, 'static-binary-v1', { mode: 0o755 })
  const later = new Date(Date.now() + 60_000)
  fs.utimesSync(tmp, later, later)
  fs.renameSync(tmp, fx.bin)
  const before = fx.d.mutations()
  const again = await fx.start()
  assert.equal(again.reused, true)
  assert.equal(fx.d.mutations(), before)
})

test('inspect reports a surviving helper on a replaced binary as stale', async (t) => {
  const fx = fixture(t)
  const opts = { runtime: 'container', runDocker: fx.d.run, bin: fx.bin }
  await fx.start()
  assert.equal(inspectEgressProcess(fx.root, 'px-ctr', opts).ok, true)
  fs.writeFileSync(fx.bin, 'static-binary-v2')
  const st = inspectEgressProcess(fx.root, 'px-ctr', opts)
  assert.equal(st.ok, false)
  assert.equal(st.reason, 'stale_binary')
  // The repair path the probe and watchdog take recreates it on the new binary.
  const repaired = await fx.start()
  assert.equal(repaired.reused, false)
  assert.equal(inspectEgressProcess(fx.root, 'px-ctr', opts).ok, true)
})
