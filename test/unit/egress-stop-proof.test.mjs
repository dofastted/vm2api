import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vmContext from 'node:vm'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { egressRunDir, startEgressProcess, stopProxyEgress } from '../../src/lib/vm/egress.mjs'
import * as egress from '../../src/lib/vm/egress.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-stop-proof-'))
  const dir = egressRunDir(root, 'synthetic')
  fs.mkdirSync(dir, { recursive: true })
  const script = path.join(root, 'kin-egress-fixture.mjs')
  fs.writeFileSync(
    script,
    "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 80)); setInterval(() => {}, 1000)\n",
  )
  const bin = path.join(root, 'kin-egress-fixture.sh')
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o700 })
  const pids = []
  t.after(() => {
    for (const pid of pids) {
      try {
        if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(root)) process.kill(pid, 'SIGKILL')
      } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const start = async () => {
    const result = await startEgressProcess({
      projectRoot: root,
      proxyId: 'synthetic',
      proxyUrl: 'socks5h://192.0.2.1:1080',
      listenHost: '127.0.0.1',
      tcpPort: 0,
      dnsPort: 0,
      bin,
    })
    if (result.pid) pids.push(result.pid)
    return result
  }
  return { root, dir, bin, pids, start }
}

const noDocker = {
  runDocker: () => ({ ok: false, stderr: 'Error: No such network: synthetic' }),
  runIptables: () => ({ ok: true, stdout: '' }),
}

test('new egress starts atomically persist observable execution identity', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const f = fixture(t)
  const result = await f.start()
  assert.equal(result.ok, true)
  const receipt = JSON.parse(fs.readFileSync(path.join(f.dir, 'egress.owner.json'), 'utf8'))
  assert.equal(receipt.pid, result.pid)
  assert.equal(receipt.proxy_id, 'synthetic')
  assert.equal(receipt.boot_id, fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim())
  assert.equal(receipt.pid_namespace, fs.readlinkSync('/proc/self/ns/pid'))
  assert.match(receipt.start_ticks, /^\d+$/)
})

test('receipt persistence failure after spawn is unknown and preserves its PID record', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const f = fixture(t)
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(f.dir, 'egress.owner.json'))
      throw Object.assign(new Error('synthetic receipt failure'), { code: 'EACCES' })
    return rename(from, to)
  })
  const result = await f.start()
  assert.equal(result.ok, false)
  assert.equal(result.vmOperationUncertain, true)
  assert.equal(Number(fs.readFileSync(path.join(f.dir, 'egress.pid'), 'utf8')), result.pid)
})

test('Kubernetes legacy or foreign-namespace PID records cannot prove the old helper ended', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const mode = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  t.after(() => {
    if (mode == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = mode
  })
  for (const foreign of [false, true]) {
    const f = fixture(t)
    const child = spawn(f.bin, ['-config', path.join(f.dir, 'egress.json')], { stdio: 'ignore' })
    const closed = once(child, 'close')
    await once(child, 'spawn')
    t.after(async () => {
      child.kill('SIGKILL')
      await closed
    })
    fs.writeFileSync(path.join(f.dir, 'egress.pid'), String(child.pid))
    fs.writeFileSync(path.join(f.dir, 'egress.json'), '{}')
    if (foreign)
      fs.writeFileSync(
        path.join(f.dir, 'egress.owner.json'),
        JSON.stringify({
          pid: child.pid,
          proxy_id: 'synthetic',
          boot_id: 'another-host',
          pid_namespace: 'pid:[foreign]',
          start_ticks: '1',
        }),
      )
    const result = await stopProxyEgress(f.root, 'synthetic', noDocker)
    assert.equal(result.ok, false)
    assert.equal(result.vmOperationUncertain, true)
    assert.equal(fs.existsSync(path.join(f.dir, 'egress.pid')), true)
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(child.exitCode, null)
    assert.equal(child.signalCode, null)
  }
})

test('confirmed egress stop waits for its recorded execution and clears its receipt', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const f = fixture(t)
  assert.equal((await f.start()).ok, true)
  const result = await egress.stopEgressProcessConfirmed(f.root, 'synthetic', { termTimeoutMs: 500, killGraceMs: 500 })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.ended, true)
  assert.equal(fs.existsSync(path.join(f.dir, 'egress.owner.json')), false)
  assert.equal(fs.existsSync(path.join(f.dir, 'egress.pid')), false)
})

test('an unreceipted helper using a recycled PID cannot be declared absent or signalled', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const f = fixture(t)
  const started = await f.start()
  const receipt = JSON.parse(fs.readFileSync(path.join(f.dir, 'egress.owner.json'), 'utf8'))
  receipt.start_ticks = String(BigInt(receipt.start_ticks) + 1n)
  fs.writeFileSync(path.join(f.dir, 'egress.owner.json'), JSON.stringify(receipt))
  const result = await egress.stopEgressProcessConfirmed(f.root, 'synthetic')
  assert.equal(result.ok, false)
  assert.equal(result.vmOperationUncertain, true)
  assert.equal(fs.existsSync(path.join(f.dir, 'egress.pid')), true)
  assert.equal(process.kill(started.pid, 0), true)
})

test('process inspection permission failure retains its receipt and ownership', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const f = fixture(t)
  const started = await f.start()
  const read = fs.readFileSync
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === `/proc/${started.pid}/stat`) throw Object.assign(new Error('inspection denied'), { code: 'EACCES' })
    return read(file, ...args)
  })
  const result = await egress.stopEgressProcessConfirmed(f.root, 'synthetic')
  assert.equal(result.ok, false)
  assert.equal(result.vmOperationUncertain, true)
  assert.equal(fs.existsSync(path.join(f.dir, 'egress.owner.json')), true)
})

test('a failed signal retains both PID and execution receipt', { skip: process.platform !== 'linux' }, async (t) => {
  const f = fixture(t)
  const started = await f.start()
  const kill = process.kill
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === started.pid && signal === 'SIGTERM') throw Object.assign(new Error('signal denied'), { code: 'EPERM' })
    return kill(pid, signal)
  })
  const result = await egress.stopEgressProcessConfirmed(f.root, 'synthetic')
  assert.equal(result.ok, false)
  assert.equal(result.vmOperationUncertain, true)
  assert.equal(fs.existsSync(path.join(f.dir, 'egress.pid')), true)
  assert.equal(fs.existsSync(path.join(f.dir, 'egress.owner.json')), true)
})

test('Docker network inspection failure cannot be treated as absent during proxy teardown', async (t) => {
  const f = fixture(t)
  const result = await stopProxyEgress(f.root, 'synthetic', {
    ...noDocker,
    runDocker: () => ({ ok: false, stderr: 'permission denied connecting to Docker daemon' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.vmOperationUncertain, true)
})

test('a confirmed helper stop may retain the same network with known container endpoints', async (t) => {
  const f = fixture(t)
  let attempted = false
  const result = await stopProxyEgress(f.root, 'synthetic', {
    ...noDocker,
    runDocker: (args) => {
      if (args[1] === 'rm') {
        attempted = true
        return {
          ok: false,
          stderr: 'Error response from daemon: error while removing network: network synthetic has active endpoints',
        }
      }
      const containers = attempted ? { immutableContainer: { Name: 'kin-synthetic' } } : {}
      return { ok: true, stdout: '192.0.2.0/24|192.0.2.1|same-network-id|' + JSON.stringify(containers) }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.network_retained, true)
  assert.equal(result.ended, false) // standalone legacy compatibility is not a termination proof.
})

test('known attached endpoints retain their network without attempting removal', async (t) => {
  const f = fixture(t)
  const result = await stopProxyEgress(f.root, 'synthetic', {
    ...noDocker,
    runDocker: (args) => {
      assert.equal(args[1], 'inspect')
      return {
        ok: true,
        stdout: '192.0.2.0/24|192.0.2.1|same-network-id|{"immutableContainer":{"Name":"kin-synthetic"}}',
      }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.network_retained, true)
})

for (const mode of ['replacement', 'permission', 'malformed']) {
  test(`attached endpoints cannot conceal an unknown network identity (${mode})`, async (t) => {
    const f = fixture(t)
    let inspected = false
    const result = await stopProxyEgress(f.root, 'synthetic', {
      ...noDocker,
      runDocker: () => {
        if (!inspected) {
          inspected = true
          return {
            ok: true,
            stdout: '192.0.2.0/24|192.0.2.1|original-network-id|{"immutableContainer":{"Name":"kin-synthetic"}}',
          }
        }
        if (mode === 'permission') return { ok: false, stderr: 'permission denied connecting to Docker daemon' }
        return {
          ok: true,
          stdout:
            '192.0.2.0/24|192.0.2.1|' +
            (mode === 'replacement' ? 'replacement-network-id' : 'original-network-id') +
            '|' +
            (mode === 'malformed' ? '{"immutableContainer":{}}' : '{"immutableContainer":{"Name":"kin-synthetic"}}'),
        }
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.vmOperationUncertain, true)
  })
}

for (const mode of ['normal', 'noop', 'replacement']) {
  test(`proxy network teardown verifies immutable ID and observed absence (${mode})`, async (t) => {
    const f = fixture(t)
    let present = true
    const removed = []
    const result = await stopProxyEgress(f.root, 'synthetic', {
      ...noDocker,
      runDocker: (args) => {
        if (args[1] === 'rm') {
          removed.push(args.at(-1))
          if (mode !== 'noop') present = false
          return { ok: true, stdout: '' }
        }
        if (present) return { ok: true, stdout: '192.0.2.0/24|192.0.2.1|original-network-id' }
        if (mode === 'replacement' && args.at(-1) !== 'original-network-id')
          return { ok: true, stdout: '192.0.2.0/24|192.0.2.1|replacement-network-id' }
        return { ok: false, stderr: 'Error: No such network: synthetic' }
      },
    })
    assert.deepEqual(removed, ['original-network-id'])
    assert.equal(result.ok, mode === 'normal')
    if (mode !== 'normal') assert.equal(result.vmOperationUncertain, true)
  })
}

function remoteFixture({ noop = false, permission = false } = {}) {
  const source = fs.readFileSync(new URL('../../src/lib/cluster/remote-slot.mjs', import.meta.url), 'utf8')
  const body = source
    .slice(source.indexOf('export async function setRemoteProxyEgressEnabled('), source.indexOf('/** Where a network'))
    .replace('export ', '')
  let running = true
  const ids = []
  const stop = vmContext.runInNewContext(`${body}; setRemoteProxyEgressEnabled`, {
    nodeSession: async () => ({ docker: {} }),
    vmNodeId: () => 'node-synthetic',
    slotEgressNames: () => ({ egress: 'kin-egress-current' }),
    proxyKey: () => 'legacy',
    inspectContainerOrNull: async () => {
      if (permission) throw new Error('Docker access denied')
      return { Id: 'immutable-egress-id', State: { Running: running, Restarting: false, Pid: running ? 123 : 0 } }
    },
    containerAction: async (_docker, id) => {
      ids.push(id)
      if (!noop) running = false
    },
    remoteContainerStopped: (info) =>
      info.State?.Running === false && info.State?.Restarting === false && info.State?.Pid === 0,
    failure: (error) => ({ ok: false, error: error.message }),
  })
  return { stop, ids }
}

test('remote egress API acknowledgement requires observed immutable container termination', async () => {
  const f = remoteFixture({ noop: true })
  const result = await f.stop({ id: 'vm-synthetic', proxy: { id: 'synthetic' } }, '/synthetic', false)
  assert.equal(result.ok, false)
  assert.equal(result.vmOperationUncertain, true)
})

test('remote egress stop addresses immutable IDs and permission failures remain unknown', async () => {
  const f = remoteFixture()
  assert.equal((await f.stop({ id: 'vm-synthetic', proxy: { id: 'synthetic' } }, '/synthetic', false)).ok, true)
  assert.equal(f.ids[0], 'immutable-egress-id')
  const unknown = await remoteFixture({ permission: true }).stop({ id: 'vm-synthetic', proxy: {} }, '/synthetic', false)
  assert.equal(unknown.vmOperationUncertain, true)
})

test('a Kubernetes Codex exit-policy stop cannot infer another Pod kernel is absent', async () => {
  const source = fs.readFileSync(new URL('../../src/lib/vm/slot-host.mjs', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('  setProxyEgressEnabled: async'), source.indexOf('  localExitProxyUrl:'))
  const stop = vmContext.runInNewContext(`({${body}}).setProxyEgressEnabled`, {
    isCodexVm: () => true,
    stopCodexKernel: () => null,
    isKubernetesMode: () => true,
    finishCodexRecycle: async () => ({ exited: true }),
  })
  const result = await stop({ id: 'vm-synthetic' }, '/synthetic', false)
  assert.equal(result.ok, false)
  assert.equal(result.vmOperationUncertain, true)
})

test('Kubernetes fleet telemetry cannot bypass the persistent helper execution receipt', async () => {
  const source = fs.readFileSync(new URL('../../src/lib/vm/fleet-update.mjs', import.meta.url), 'utf8')
  const body = source
    .slice(
      source.indexOf('export async function restartLocalEgress('),
      source.indexOf('async function restartLocalServices('),
    )
    .replace('export ', '')
  let legacySignals = 0
  let starts = 0
  const restart = vmContext.runInNewContext(`${body}; restartLocalEgress`, {
    isLocalEgressProxy: () => false,
    isKubernetesMode: () => true,
    runExclusiveProxyEgress: (_root, _id, callback) => callback(),
    stopEgressProcessConfirmed: async () => ({
      ok: false,
      code: 'egress_owner_unreachable',
      vmOperationUncertain: true,
    }),
    inspectEgressProcess: () => ({ ok: false }),
    stopEgressProcess: () => {
      legacySignals++
      return { ok: true }
    },
    egressPidsForProxyConfig: () => [],
    drainEgressForProxyConfig: async () => ({ ok: true }),
    readEgressListenTcp: () => '',
    startProxyEgress: async () => {
      starts++
      return { ok: true }
    },
  })
  const result = await restart('/synthetic', { proxy: { id: 'synthetic' } })
  assert.equal(result.ok, false)
  assert.equal(result.vmOperationUncertain, true)
  assert.equal(legacySignals, 0)
  assert.equal(starts, 0)
})
