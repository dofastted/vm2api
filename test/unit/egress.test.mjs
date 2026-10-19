import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  LOCAL_EGRESS_ID,
  boundProxyUrl,
  bridgeName,
  chainName,
  dnsUpstreamChain,
  validDnsPrimary,
  egressEnabled,
  hasBoundExit,
  inspectEgressNetwork,
  inspectEgressProcess,
  iptablesPlan,
  isLocalEgressProxy,
  localEgressProxyUrl,
  localEgressStatus,
  egressListening,
  egressRunDir,
  proxyEgressReady,
  networkName,
  portsForProxy,
  slotNetworkForVm,
  startEgressProcess,
  stopEgressProcess,
  waitEgressExit,
  egressPidActive,
  ensureProxyEgress,
  waitPortReleased,
} from '../../src/lib/vm/egress.mjs'
import { hostProxyUrlForVm } from '../../src/lib/vm/slot-host.mjs'

// Process-ownership tests need the native helper so /proc/<pid>/exe identifies it.
const egressBin = process.env.KIN_EGRESS_BIN || path.resolve(import.meta.dirname, '../../bin/kin-egress')

async function waitForProcess(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('process state did not converge')
}

function egressFixture(t, proxyId = 'px-process') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-eg-process-'))
  const dir = egressRunDir(root, proxyId)
  fs.mkdirSync(dir, { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const base = {
    projectRoot: root,
    proxyId,
    proxyUrl: 'socks5h://192.0.2.1:1080',
    listenHost: '127.0.0.1',
    tcpPort: 0,
    dnsPort: 0,
    bin: egressBin,
  }
  const pidFile = path.join(dir, 'egress.pid')
  const configPath = path.join(dir, 'egress.json')
  const start = async (opts = {}) => {
    const result = await startEgressProcess({ ...base, ...opts })
    if (result.pid)
      t.after(() => {
        try {
          process.kill(result.pid, 'SIGTERM')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      })
    return result
  }
  return { root, dir, base, pidFile, configPath, start }
}

for (const sameConfig of [true, false]) {
  test(`a recycled PID is neither reused nor killed with ${sameConfig ? 'matching' : 'changed'} egress config`, {
    skip: process.platform !== 'linux',
  }, async (t) => {
    const fx = egressFixture(t)
    const sleeper = spawn('sleep', ['60'])
    const closed = once(sleeper, 'close')
    t.after(async () => {
      sleeper.kill('SIGTERM')
      await closed
    })
    await once(sleeper, 'spawn')
    fs.writeFileSync(fx.pidFile, String(sleeper.pid))
    fs.writeFileSync(
      fx.configPath,
      JSON.stringify({
        listen_tcp: '127.0.0.1:0',
        listen_dns: '127.0.0.1:0',
        proxy_url: sameConfig ? fx.base.proxyUrl : 'socks5h://192.0.2.2:1080',
      }),
    )
    const stale = inspectEgressProcess(fx.root, fx.base.proxyId)
    const started = await fx.start()
    assert.equal(started.ok, true)
    assert.equal(started.reused, false)
    assert.notEqual(started.pid, sleeper.pid)
    await waitForProcess(() => {
      try {
        return path.basename(fs.readlinkSync(`/proc/${started.pid}/exe`)) === 'kin-egress'
      } catch {
        return false
      }
    })
    assert.equal(inspectEgressProcess(fx.root, fx.base.proxyId).ok, true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(sleeper.signalCode, null)
    assert.equal(sleeper.exitCode, null)
    assert.equal(stale.ok, false, 'sleep is not an egress helper')
  })
}

test('stop discards a recycled PID without signaling its new owner', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const fx = egressFixture(t)
  const sleeper = spawn('sleep', ['60'])
  const closed = once(sleeper, 'close')
  t.after(async () => {
    sleeper.kill('SIGTERM')
    await closed
  })
  await once(sleeper, 'spawn')
  fs.writeFileSync(fx.pidFile, String(sleeper.pid))
  assert.equal(stopEgressProcess(fx.root, fx.base.proxyId).ok, true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fs.existsSync(fx.pidFile), false)
  assert.equal(sleeper.signalCode, null)
  assert.equal(sleeper.exitCode, null)
})

test('egress reload waits for the previous process to exit before spawning', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const fx = egressFixture(t)
  const original = await fx.start()
  await waitForProcess(() => {
    try {
      return path.basename(fs.readlinkSync(`/proc/${original.pid}/exe`)) === 'kin-egress'
    } catch {
      return false
    }
  })
  const replacement = await fx.start({ proxyUrl: 'socks5h://192.0.2.2:1080' })
  assert.equal(replacement.ok, true)
  assert.notEqual(replacement.pid, original.pid)
  assert.equal(egressPidActive(original.pid), false, 'old egress must exit before spawn returns')
  assert.equal(stopEgressProcess(fx.root, fx.base.proxyId).ok, true)
  await waitForProcess(() => !fs.existsSync(`/proc/${replacement.pid}`))
})

test('egress reload surfaces spawn failure after stopping the old helper', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const fx = egressFixture(t)
  const original = await fx.start()
  await waitForProcess(() => {
    try {
      return path.basename(fs.readlinkSync(`/proc/${original.pid}/exe`)) === 'kin-egress'
    } catch {
      return false
    }
  })
  const missing = path.join(fx.root, 'missing-kin-egress')
  const failed = await fx.start({ bin: missing, proxyUrl: 'socks5h://192.0.2.3:1080' })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /not found|spawn/i)
  assert.equal(egressPidActive(original.pid), false)
})

test('waitEgressExit escalates SIGTERM to SIGKILL', { skip: process.platform !== 'linux' }, async (t) => {
  const sleeper = spawn('sleep', ['120'])
  const closed = once(sleeper, 'close')
  t.after(async () => {
    try {
      sleeper.kill('SIGKILL')
    } catch {}
    await closed
  })
  await once(sleeper, 'spawn')
  sleeper.kill('SIGTERM')
  const result = await waitEgressExit(sleeper.pid, { termTimeoutMs: 200, killGraceMs: 3000 })
  assert.equal(result.ok, true)
  assert.equal(egressPidActive(sleeper.pid), false)
})

test('an egress helper can be reused, replaced and stopped only by its own proxy', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const fx = egressFixture(t)
  const original = await fx.start()
  await waitForProcess(() => {
    try {
      return path.basename(fs.readlinkSync(`/proc/${original.pid}/exe`)) === 'kin-egress'
    } catch {
      return false
    }
  })
  const reused = await fx.start()
  assert.equal(reused.reused, true)
  assert.equal(reused.pid, original.pid)
  const other = egressRunDir(fx.root, 'px-other')
  fs.mkdirSync(other, { recursive: true })
  fs.writeFileSync(path.join(other, 'egress.pid'), String(original.pid))
  assert.equal(inspectEgressProcess(fx.root, 'px-other').ok, false)
  assert.equal(stopEgressProcess(fx.root, 'px-other').ok, true)
  assert.equal(inspectEgressProcess(fx.root, fx.base.proxyId).ok, true)
  const replacement = await fx.start({ proxyUrl: 'socks5h://192.0.2.2:1080' })
  assert.equal(replacement.reused, false)
  assert.notEqual(replacement.pid, original.pid)
  await waitForProcess(() => !fs.existsSync(`/proc/${original.pid}`))
  assert.equal(stopEgressProcess(fx.root, fx.base.proxyId).ok, true)
  await waitForProcess(() => !fs.existsSync(`/proc/${replacement.pid}`))
  assert.equal(stopEgressProcess(fx.root, fx.base.proxyId).ok, true)
  assert.equal(fs.existsSync(fx.pidFile), false)
})

test('a running egress remains identifiable after its binary was replaced', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const fx = egressFixture(t)
  const bin = path.join(fx.root, 'kin-egress')
  fs.copyFileSync(egressBin, bin)
  fs.chmodSync(bin, 0o755)
  const started = await fx.start({ bin })
  await waitForProcess(() => {
    try {
      return fs.readlinkSync(`/proc/${started.pid}/exe`) === bin
    } catch {
      return false
    }
  })
  fs.unlinkSync(bin)
  assert.match(fs.readlinkSync(`/proc/${started.pid}/exe`), / \(deleted\)$/)
  assert.equal(inspectEgressProcess(fx.root, fx.base.proxyId).ok, true)
  assert.equal((await fx.start({ bin })).reused, true)
  assert.equal(stopEgressProcess(fx.root, fx.base.proxyId).ok, true)
  await waitForProcess(() => !fs.existsSync(`/proc/${started.pid}`))
})

test('redundant separators in an egress config path do not change its owner', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const fx = egressFixture(t)
  fs.writeFileSync(
    fx.configPath,
    JSON.stringify({ proxy_url: fx.base.proxyUrl, listen_tcp: '127.0.0.1:0', listen_dns: '127.0.0.1:0' }),
  )
  const child = spawn(egressBin, ['-config', fx.dir + '//egress.json'], { stdio: 'ignore' })
  const closed = once(child, 'close')
  t.after(async () => {
    child.kill('SIGTERM')
    await closed
  })
  await once(child, 'spawn')
  fs.writeFileSync(fx.pidFile, String(child.pid))
  assert.equal(inspectEgressProcess(fx.root, fx.base.proxyId).ok, true)
  const reused = await fx.start()
  assert.equal(reused.reused, true)
  assert.equal(reused.pid, child.pid)
  assert.equal(stopEgressProcess(fx.root, fx.base.proxyId).ok, true)
  await closed
})

test('names stay short and stable per proxy id', () => {
  assert.equal(networkName('px-a1b2c3d4'), 'kin-eg-px-a1b2c3d4')
  assert.ok(bridgeName('px-a1b2c3d4').length <= 15)
  assert.equal(bridgeName('px-a1b2c3d4'), bridgeName('px-a1b2c3d4'))
  assert.ok(chainName('px-a1b2c3d4').startsWith('KEG'))
})

test('ports are even/odd pair in 20000-35999', () => {
  const a = portsForProxy('px-a1b2c3d4')
  const b = portsForProxy('px-ffffffff')
  assert.equal(a.dns, a.tcp + 1)
  assert.ok(a.tcp >= 20000 && a.tcp < 36000)
  assert.notEqual(a.tcp, b.tcp)
})

test('iptables plan redirects tcp and dns, returns subnet, drops the rest', () => {
  const plan = iptablesPlan({
    chain: 'KEGa1b2c3d4',
    bridge: 'kega1b2c3d4',
    subnet: '172.31.0.0/24',
    tcpPort: 20010,
    dnsPort: 20011,
  })
  const joined = plan.add.map((row) => row.join(' '))
  assert.ok(joined.some((s) => s.includes('REDIRECT --to-ports 20010')))
  assert.ok(joined.some((s) => s.includes('--dport 53') && s.includes('20011')))
  assert.ok(joined.some((s) => s.includes('-p tcp --dport 53') && s.includes('20011')))
  assert.ok(joined.some((s) => s.includes('-F KEGa1b2c3d4')))
  assert.ok(joined.some((s) => s.includes('-d 172.31.0.0/24 -j RETURN')))
  assert.ok(joined.some((s) => s.includes('FORWARD') && s.includes('DROP')))
  assert.ok(plan.del.some((row) => row.includes('-X')))
})

test('host INPUT allows only bridge subnet helper ports and removes the same rules', () => {
  const plan = iptablesPlan({
    chain: 'KEGa1b2c3d4',
    bridge: 'kega1b2c3d4',
    subnet: '172.31.0.0/24',
    tcpPort: 20010,
    dnsPort: 20011,
  })
  const allows = plan.add.filter((row) => row.includes('-I') && row.includes('INPUT'))
  assert.equal(allows.length, 2)
  for (const rule of allows) {
    const arg = (name) => rule[rule.indexOf(name) + 1]
    assert.equal(arg('INPUT'), '1') // Must precede the host's terminal REJECT.
    assert.equal(arg('-i'), 'kega1b2c3d4')
    assert.equal(arg('-s'), '172.31.0.0/24')
    assert.equal(arg('-d'), '172.31.0.0/24')
    assert.equal(arg('-j'), 'ACCEPT')
    if (arg('-p') === 'tcp') {
      assert.equal(arg('--dports'), '20010,20011')
    } else {
      assert.equal(arg('-p'), 'udp')
      assert.equal(arg('--dport'), '20011')
    }
    const spec = rule.slice(5)
    assert.ok(plan.add.some((row) => JSON.stringify(row) === JSON.stringify(['-t', 'filter', '-C', 'INPUT', ...spec])))
    assert.ok(plan.del.some((row) => JSON.stringify(row) === JSON.stringify(['-t', 'filter', '-D', 'INPUT', ...spec])))
  }
  assert.equal(plan.del.filter((row) => row.includes('INPUT')).length, allows.length)
})

test('slot network is bound proxy net and never host', () => {
  const vm = { proxy: { id: 'px-a1b2c3d4' } }
  assert.equal(slotNetworkForVm(vm, { KIN_VM_NETWORK: 'host' }), 'kin-eg-px-a1b2c3d4')
  assert.equal(slotNetworkForVm({}, { KIN_VM_NETWORK: 'host' }), '')
  assert.equal(egressEnabled({}), true)
  assert.equal(egressEnabled({ KIN_EGRESS: '0' }), true)
})

test('local egress is identified and has no SOCKS url', () => {
  assert.equal(isLocalEgressProxy({ id: LOCAL_EGRESS_ID }), true)
  assert.equal(isLocalEgressProxy({ scheme: 'local', host: 'local' }), true)
  assert.equal(isLocalEgressProxy({ host: '1.2.3.4', port: 1080 }), false)
  assert.equal(boundProxyUrl({ id: LOCAL_EGRESS_ID, host: 'local', port: 0 }), '')
  assert.equal(slotNetworkForVm({ proxy: { id: LOCAL_EGRESS_ID } }), 'kin-eg-px-local')
})

test('local egress proxy follows the Codex kernel env order for https', () => {
  assert.equal(localEgressProxyUrl({ HTTP_PROXY: 'http://h.test:1', http_proxy: 'http://h.test:2' }), '')
  assert.equal(localEgressProxyUrl({ ALL_PROXY: 'socks5://a.test:1080' }), 'socks5h://a.test:1080')
  assert.equal(localEgressProxyUrl({ all_proxy: 'http://b.test:2', ALL_PROXY: 'http://a.test:1' }), 'http://a.test:1')
  assert.equal(localEgressProxyUrl({ ALL_PROXY: 'http://a.test:1', https_proxy: 'http://s.test:3' }), 'http://s.test:3')
  assert.equal(
    localEgressProxyUrl({ https_proxy: 'http://s.test:3', HTTPS_PROXY: 'http://S.test:4' }),
    'http://S.test:4',
  )
})

test('host hops: local Codex follows the deployment proxy, local Claude stays direct', (t) => {
  const saved = process.env.HTTPS_PROXY
  process.env.HTTPS_PROXY = 'http://proxy.test:8443'
  t.after(() => {
    if (saved === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = saved
  })
  const local = { id: LOCAL_EGRESS_ID, scheme: 'local', host: 'local', port: 0 }
  assert.equal(hostProxyUrlForVm({ id: 'vm-gpt', platform: 'openai', proxy: local }), 'http://proxy.test:8443')
  assert.equal(hostProxyUrlForVm({ id: 'vm-cc', platform: 'anthropic', proxy: local }), '')
  assert.equal(
    hostProxyUrlForVm({ id: 'vm-gpt', platform: 'openai', proxy: { host: '10.0.0.5', port: 1080 } }),
    'socks5h://10.0.0.5:1080',
  )
})

test('inspectEgressNetwork exposes name and network for slot start', () => {
  const info = inspectEgressNetwork('px-local', () => ({
    ok: true,
    stdout: '192.168.144.0/20|192.168.144.1',
  }))
  assert.equal(info.name, 'kin-eg-px-local')
  assert.equal(info.network, 'kin-eg-px-local')
  assert.equal(info.subnet, '192.168.144.0/20')
  assert.equal(info.gateway, '192.168.144.1')
})

test('inspectEgressProcess reports missing pid as not_running', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-eg-inspect-'))
  const st = inspectEgressProcess(root, 'px-deadbeef')
  assert.equal(st.ok, false)
  assert.equal(st.reason, 'not_running')
  fs.rmSync(root, { recursive: true, force: true })
})

test('local egress is a bound exit even when the SOCKS url is empty', () => {
  assert.equal(hasBoundExit({ id: LOCAL_EGRESS_ID, host: 'local', port: 0, url: null }), true)
  assert.equal(hasBoundExit({ scheme: 'local', host: '10.0.0.8', port: 1080 }), true)
  assert.equal(hasBoundExit({ host: '10.0.0.1', port: 1080 }), true)
  assert.equal(hasBoundExit({ host: '10.0.0.1' }), false)
  assert.equal(hasBoundExit(null), false)
})

test('local egress health follows the masquerade net for any local row', () => {
  const hit = localEgressStatus({ id: 'px-other', scheme: 'local' }, () => ({
    ok: true,
    stdout: '192.168.144.0/20|192.168.144.1',
  }))
  assert.equal(hit.ok, true)
  assert.equal(hit.mode, 'local')
  assert.equal(hit.name, 'kin-eg-px-other')
  const miss = localEgressStatus({ id: LOCAL_EGRESS_ID }, () => ({ ok: false, stderr: 'not found' }))
  assert.equal(miss.ok, false)
  assert.equal(miss.reason, 'local_network_missing')
  assert.equal(localEgressStatus({ id: 'px-socks', host: '10.0.0.1', port: 1080 }), null)
})

test('local egress readiness is direct and does not require kin-egress', () => {
  const ready = proxyEgressReady({ id: LOCAL_EGRESS_ID, scheme: 'local', host: 'local', port: 0 })
  assert.equal(ready.ok, true)
  assert.equal(ready.mode, 'direct')
  const listen = egressListening('/tmp/does-not-matter', LOCAL_EGRESS_ID)
  assert.equal(listen.ok, true)
  assert.equal(listen.mode, 'direct')
})

test('dns primary preserves auto and built-in fallback order', () => {
  const defaults = ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query', '8.8.8.8:53', '1.1.1.1:53']
  assert.equal(dnsUpstreamChain('auto'), '')
  assert.equal(validDnsPrimary('auto'), true)
  for (const primary of defaults) {
    assert.equal(validDnsPrimary(primary), true)
    assert.equal(dnsUpstreamChain(primary), [primary, ...defaults.filter((upstream) => upstream !== primary)].join(','))
  }
})

test('custom HTTPS DNS upstreams precede the unchanged default fallbacks', () => {
  for (const primary of [
    'https://cloudflare-dns.com/dns-query',
    'https://dns.example.com:8443/custom/path?key=a%2Cb',
    'https://9.9.9.9/dns-query',
    'https://[2606:4700:4700::1111]/dns-query',
    'https://[::1]:8443/dns-query',
    'https://DNS.Example.COM./dns-query',
  ]) {
    assert.equal(validDnsPrimary(primary), true, primary)
    assert.equal(
      dnsUpstreamChain(primary),
      `${primary},https://1.1.1.1/dns-query,https://8.8.8.8/dns-query,8.8.8.8:53,1.1.1.1:53`,
    )
  }
})

test('DNS upstream validation rejects unsafe or malformed URL boundaries', () => {
  for (const primary of [
    undefined,
    null,
    123,
    {},
    '',
    'bogus',
    '9.9.9.9:53',
    'http://dns.example.com/dns-query',
    'HTTPS://dns.example.com/dns-query',
    'hTtPs://dns.example.com/dns-query',
    'https://dns.example.com/dns-%query',
    'https:////dns.example.com/dns-query',
    'https://user:pass@dns.example.com/dns-query',
    'https://@dns.example.com/dns-query',
    'https://dns.example.com/dns-query#fragment',
    'https://dns.example.com/dns-query#',
    'https://dns.example.com/dns-query?key=a,b',
    'https://dns.example.com/dns-query,https://other.example/dns-query',
    ' https://dns.example.com/dns-query',
    'https://dns.example.com/dns-\nquery',
    'https://dns.example.com\\evil/dns-query',
    'https:///dns-query',
    'https://bad_host.example/dns-query',
    'https://-bad.example/dns-query',
    'https://bad-.example/dns-query',
    'https://dns..example/dns-query',
    `https://${'a'.repeat(64)}.example/dns-query`,
    `https://${Array(5).fill('a'.repeat(63)).join('.')}/dns-query`,
    'https://999.999.999.999/dns-query',
    'https://[not-ipv6]/dns-query',
    'https://2001:db8::1/dns-query',
    'https://dns.example.com:/dns-query',
    'https://dns.example.com:0/dns-query',
    'https://dns.example.com:65536/dns-query',
    'https://dns.example.com:bad/dns-query',
  ]) {
    assert.equal(validDnsPrimary(primary), false, String(primary))
    assert.equal(dnsUpstreamChain(primary), '', String(primary))
  }
})

test('egress config carries dns_upstream only when configured', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-dns-'))
  const base = {
    projectRoot: root,
    proxyUrl: 'socks5h://127.0.0.1:1',
    tcpPort: 20000,
    dnsPort: 20001,
    listenHost: '127.0.0.1',
    bin: '/bin/true',
  }
  const a = await startEgressProcess({ ...base, proxyId: 'px-a', dnsUpstream: '' })
  assert.equal(a.ok, true)
  assert.equal(JSON.parse(fs.readFileSync(a.configPath, 'utf8')).dns_upstream, undefined)
  const b = await startEgressProcess({ ...base, proxyId: 'px-b', dnsUpstream: '8.8.8.8:53,1.1.1.1:53' })
  assert.equal(JSON.parse(fs.readFileSync(b.configPath, 'utf8')).dns_upstream, '8.8.8.8:53,1.1.1.1:53')
  const c = await startEgressProcess({ ...base, proxyId: 'px-c', domainForward: true })
  assert.equal(JSON.parse(fs.readFileSync(c.configPath, 'utf8')).domain_forward, true)
  assert.equal(JSON.parse(fs.readFileSync(a.configPath, 'utf8')).domain_forward, undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

test('egress readiness checks the exact listener without opening a connection', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-listen-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let accepted = 0
  const listener = net.createServer((socket) => {
    accepted++
    socket.destroy()
  })
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => listener.close(resolve)))
  const proxyId = 'px-passive-probe'
  const dir = egressRunDir(root, proxyId)
  fs.mkdirSync(dir, { recursive: true })
  const config = path.join(dir, 'egress.json')
  fs.writeFileSync(config, JSON.stringify({ proxy_url: 'socks5h://192.0.2.1:1080', listen_tcp: '127.0.0.1:0' }))
  const helper = spawn(egressBin, ['-config', config], { stdio: ['ignore', 'ignore', 'pipe'] })
  const closed = once(helper, 'close')
  let helperLog = ''
  helper.stderr.on('data', (chunk) => {
    helperLog += chunk
  })
  t.after(async () => {
    helper.kill('SIGTERM')
    await closed
  })
  fs.writeFileSync(path.join(dir, 'egress.pid'), String(helper.pid))
  // exec precedes config loading. Wait for Serve before overwriting the file
  // so the helper cannot read the probe's deliberately incomplete config.
  await waitForProcess(() => helperLog.includes('kin-egress ready'))
  const port = listener.address().port
  fs.writeFileSync(config, JSON.stringify({ listen_tcp: `127.0.0.1:${port}` }))
  assert.equal(egressListening(root, proxyId).ok, true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(accepted, 0, 'readiness must not enter the transparent forwarding path')
  fs.writeFileSync(config, JSON.stringify({ listen_tcp: `127.0.0.2:${port}` }))
  assert.equal(egressListening(root, proxyId, 100).reason, 'not_listening')
})

test('DNS override changes restart the helper and disabling clears the override', async (t) => {
  const fx = egressFixture(t, 'px-dns-override')
  const original = await fx.start()
  assert.equal(original.ok, true)
  await waitForProcess(() => inspectEgressProcess(fx.root, 'px-dns-override').ok)
  assert.equal((await fx.start()).reused, true)
  const enabled = await fx.start({ dnsEmptyTypes: [64, 65] })
  assert.equal(enabled.ok, true)
  assert.equal(enabled.reused, false)
  assert.notEqual(enabled.pid, original.pid)
  assert.deepEqual(JSON.parse(fs.readFileSync(fx.configPath, 'utf8')).dns_empty_types, [64, 65])
  await waitForProcess(() => inspectEgressProcess(fx.root, 'px-dns-override').ok)
  assert.equal((await fx.start({ dnsEmptyTypes: [64, 65] })).reused, true)
  const disabled = await fx.start()
  assert.equal(disabled.reused, false)
  assert.equal(JSON.parse(fs.readFileSync(fx.configPath, 'utf8')).dns_empty_types, undefined)
})

test('concurrent starts for one proxy spawn a single helper and record it', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-race-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const proxy = { id: 'px-race', url: 'socks5h://192.0.2.1:1080' }
  const ports = portsForProxy(proxy.id)
  const runDocker = (args) =>
    args[0] === 'network' && args[1] === 'inspect' ? { ok: true, stdout: '172.31.250.0/24|127.0.0.1' } : { ok: true }
  const runIptables = () => ({ ok: true })
  const opts = { runDocker, runIptables, dnsUpstream: '', dnsEmptyTypes: [], bin: egressBin }
  const results = await Promise.all([1, 2, 3].map(() => ensureProxyEgress(root, proxy, opts)))
  const pids = results.map((r) => r.pid).filter(Boolean)
  for (const pid of new Set(pids))
    t.after(() => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    })
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true, true],
    JSON.stringify(results),
  )
  assert.equal(new Set(pids).size, 1, `one helper expected, got ${pids}`)
  const recorded = Number(fs.readFileSync(path.join(egressRunDir(root, proxy.id), 'egress.pid'), 'utf8'))
  assert.equal(recorded, pids[0])
  assert.equal(egressPidActive(recorded), true)
  assert.equal(egressListening(root, proxy.id).ok, true, `listening on ${ports.tcp}`)
})

test('waitPortReleased returns at once for a free port without blocking the event loop', {
  skip: process.platform !== 'linux',
}, async () => {
  let ticks = 0
  const timer = setInterval(() => ticks++, 5)
  const started = Date.now()
  const result = await waitPortReleased('127.0.0.1', 1)
  const elapsed = Date.now() - started
  clearInterval(timer)
  assert.equal(result.ok, true)
  assert.ok(elapsed < 150, `took ${elapsed}ms`)
})

test('egress wait loops do not shell out to python3', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../../src/lib/vm/egress.mjs'), 'utf8')
  assert.equal(src.includes('python3'), false)
})
