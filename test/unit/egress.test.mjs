import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
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
  localEgressStatus,
  egressListening,
  egressRunDir,
  proxyEgressReady,
  networkName,
  portsForProxy,
  slotNetworkForVm,
  startEgressProcess,
} from '../../src/lib/vm/egress.mjs'

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

test('dns primary puts the chosen upstream first and keeps the rest as fallback', () => {
  assert.equal(dnsUpstreamChain('auto'), '')
  assert.equal(dnsUpstreamChain('bogus'), '')
  assert.equal(
    dnsUpstreamChain('8.8.8.8:53'),
    '8.8.8.8:53,https://1.1.1.1/dns-query,https://8.8.8.8/dns-query,1.1.1.1:53',
  )
  assert.equal(validDnsPrimary('auto'), true)
  assert.equal(validDnsPrimary('https://1.1.1.1/dns-query'), true)
  assert.equal(validDnsPrimary('9.9.9.9:53'), false)
})

test('egress config carries dns_upstream only when configured', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-dns-'))
  const base = {
    projectRoot: root,
    proxyUrl: 'socks5h://127.0.0.1:1',
    tcpPort: 20000,
    dnsPort: 20001,
    listenHost: '127.0.0.1',
    bin: '/bin/true',
  }
  const a = startEgressProcess({ ...base, proxyId: 'px-a', dnsUpstream: '' })
  assert.equal(a.ok, true)
  assert.equal(JSON.parse(fs.readFileSync(a.configPath, 'utf8')).dns_upstream, undefined)
  const b = startEgressProcess({ ...base, proxyId: 'px-b', dnsUpstream: '8.8.8.8:53,1.1.1.1:53' })
  assert.equal(JSON.parse(fs.readFileSync(b.configPath, 'utf8')).dns_upstream, '8.8.8.8:53,1.1.1.1:53')
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
  fs.writeFileSync(path.join(dir, 'egress.pid'), String(process.pid))
  const config = path.join(dir, 'egress.json')
  const port = listener.address().port
  fs.writeFileSync(config, JSON.stringify({ listen_tcp: `127.0.0.1:${port}` }))
  assert.equal(egressListening(root, proxyId).ok, true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(accepted, 0, 'readiness must not enter the transparent forwarding path')
  fs.writeFileSync(config, JSON.stringify({ listen_tcp: `127.0.0.2:${port}` }))
  assert.equal(egressListening(root, proxyId, 100).reason, 'not_listening')
})
