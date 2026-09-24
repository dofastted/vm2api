import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import {
  LOCAL_EGRESS_ID,
  boundProxyUrl,
  bridgeName,
  chainName,
  egressEnabled,
  hasBoundExit,
  inspectEgressNetwork,
  inspectEgressProcess,
  iptablesPlan,
  isLocalEgressProxy,
  localEgressStatus,
  egressListening,
  proxyEgressReady,
  networkName,
  portsForProxy,
  slotNetworkForVm,
  egressConfig,
  egressConfigMatches,
  DNS_UPSTREAM_DEFAULT,
  readDnsUpstream,
} from '../../src/lib/vm/egress.mjs'

test('egress reads the persisted pool DNS choice', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-dns-choice-'))
  try {
    const pool = new ProxyPool({ dataDir: path.join(root, 'data') })
    pool.stopScheduler()
    assert.equal(readDnsUpstream(root), DNS_UPSTREAM_DEFAULT)
    assert.equal(pool.updateConfig({ dns_upstream: 'https://dns.google/dns-query' }).ok, true)
    assert.equal(readDnsUpstream(root), 'https://dns.google/dns-query')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('egress config defaults to Cloudflare DoH and accepts selected upstream', () => {
  const base = { proxyId: 'px-test', proxyUrl: 'socks5://127.0.0.1:1080', listenTcp: '172.20.0.1:20000', listenDns: '172.20.0.1:20001' }
  const defaultConfig = egressConfig(base)
  assert.equal(defaultConfig.dns_upstream, DNS_UPSTREAM_DEFAULT)
  const selected = egressConfig({ ...base, dnsUpstream: 'https://dns.google/dns-query' })
  assert.equal(selected.dns_upstream, 'https://dns.google/dns-query')
  assert.equal(egressConfigMatches(defaultConfig, selected), false)
  assert.equal(egressConfigMatches(selected, selected), true)
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
