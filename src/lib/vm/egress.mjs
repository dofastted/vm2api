/**
 * Remote SOCKS5: one docker net per proxy, kin-egress REDIRECTs that bridge.
 * Local egress (`px-local` / scheme=local) is the host default route. Do not
 * start kin-egress and do not treat a missing helper as "no proxy".
 * Slot start still attaches a masquerade net so the container is not on a
 * redirected SOCKS bridge.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { resolveStoreDb } from '../db/database.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'

export const EGRESS_BIN = process.env.KIN_EGRESS_BIN || '/opt/kin-gateway/bin/kin-egress'
export const LOCAL_EGRESS_ID = 'px-local'

export function isLocalEgressProxy(proxy) {
  if (!proxy || typeof proxy !== 'object') return false
  const id = String(proxy.id || '').trim()
  const scheme = String(proxy.scheme || proxy.kind || '')
    .trim()
    .toLowerCase()
  const host = String(proxy.host || '')
    .trim()
    .toLowerCase()
  return id === LOCAL_EGRESS_ID || scheme === 'local' || host === 'local'
}

/** Remote SOCKS (url or host:port) or local egress. Empty URL is not "unbound". */
export function hasBoundExit(proxy) {
  if (isLocalEgressProxy(proxy)) return true
  if (!proxy || typeof proxy !== 'object') return false
  if (proxy.url) return true
  return !!(proxy.host && proxy.port)
}

/** Docker masquerade net for a local row. null when the row is not local egress. */
export function localEgressStatus(proxyOrId, run = docker) {
  const proxy = typeof proxyOrId === 'string' ? { id: proxyOrId } : proxyOrId
  if (!isLocalEgressProxy(proxy)) return null
  const id = String((typeof proxyOrId === 'string' ? proxyOrId : proxy?.id) || LOCAL_EGRESS_ID).trim()
  const net = inspectEgressNetwork(id || LOCAL_EGRESS_ID, run)
  if (net?.subnet) return { ok: true, mode: 'local', ...net }
  return { ok: false, reason: 'local_network_missing' }
}

export function proxyEgressReady(proxy, projectRoot, timeoutMs = 400) {
  // Direct exit. kin-egress not running is success, not egress_down.
  if (isLocalEgressProxy(proxy)) return { ok: true, mode: 'direct' }
  return egressListening(projectRoot, proxy?.id, timeoutMs)
}

export function egressEnabled(_env = process.env) {
  return true
}

export function proxyKey(proxyId) {
  return String(proxyId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
}

export function networkName(proxyId) {
  const id = proxyKey(proxyId)
  return id ? `kin-eg-${id}` : ''
}

/** Linux iface max 15 chars. */
export function bridgeName(proxyId) {
  const hex = proxyKey(proxyId)
    .replace(/^px-/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 12)
  return (`keg${hex}` || 'kegbridge').slice(0, 15)
}

export function chainName(proxyId) {
  const hex = proxyKey(proxyId)
    .replace(/^px-/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 12)
  return (`KEG${hex}` || 'KEG').slice(0, 28)
}

export function portsForProxy(proxyId) {
  const s = proxyKey(proxyId)
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  const n = (h >>> 0) % 8000
  return { tcp: 20000 + n * 2, dns: 20000 + n * 2 + 1 }
}

export function gatewayFromSubnet(subnet) {
  const m = String(subnet || '').match(/^(\d+\.\d+\.\d+)\.(\d+)\/\d+$/)
  return m ? `${m[1]}.1` : ''
}

export function iptablesPlan({ chain, bridge, subnet, tcpPort, dnsPort }) {
  const tcp = String(tcpPort)
  const dns = String(dnsPort)
  return {
    add: [
      ['-t', 'nat', '-N', chain],
      ['-t', 'nat', '-C', 'PREROUTING', '-i', bridge, '-j', chain],
      ['-t', 'nat', '-A', 'PREROUTING', '-i', bridge, '-j', chain],
      ['-t', 'nat', '-F', chain],
      ['-t', 'nat', '-A', chain, '-d', subnet, '-j', 'RETURN'],
      ['-t', 'nat', '-A', chain, '-p', 'tcp', '--dport', '53', '-j', 'REDIRECT', '--to-ports', dns],
      ['-t', 'nat', '-A', chain, '-p', 'udp', '--dport', '53', '-j', 'REDIRECT', '--to-ports', dns],
      ['-t', 'nat', '-A', chain, '-p', 'tcp', '-j', 'REDIRECT', '--to-ports', tcp],
      ['-t', 'filter', '-C', 'FORWARD', '-i', bridge, '!', '-d', subnet, '-j', 'DROP'],
      ['-t', 'filter', '-I', 'FORWARD', '1', '-i', bridge, '!', '-d', subnet, '-j', 'DROP'],
    ],
    del: [
      ['-t', 'nat', '-D', 'PREROUTING', '-i', bridge, '-j', chain],
      ['-t', 'nat', '-F', chain],
      ['-t', 'nat', '-X', chain],
      ['-t', 'filter', '-D', 'FORWARD', '-i', bridge, '!', '-d', subnet, '-j', 'DROP'],
    ],
  }
}

function sh(argv, { timeout = 15_000 } = {}) {
  try {
    const out = execFileSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, stdout: String(out || '').trim(), stderr: '' }
  } catch (e) {
    return {
      ok: false,
      stdout: String(e.stdout || '').trim(),
      stderr: String(e.stderr || e.message || '').trim(),
      code: e.status,
    }
  }
}

function iptables(args) {
  return sh(['iptables', ...args], { timeout: 8_000 })
}

function docker(args, timeout = 30_000) {
  return sh(['docker', ...args], { timeout })
}

export function egressRunDir(projectRoot, proxyId) {
  return path.join(projectRoot, 'data', 'run', 'egress', proxyKey(proxyId))
}

function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch {
    return false
  }
}

function readPid(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim())
  } catch {
    return 0
  }
}
export function inspectEgressNetwork(proxyId, run = docker) {
  const name = networkName(proxyId)
  if (!name) return null
  const r = run(['network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Subnet}}|{{.Gateway}}{{end}}', name])
  if (!r.ok) return null
  const [subnet, gateway] = String(r.stdout || '').split('|')
  return {
    name,
    network: name,
    subnet: String(subnet || '').trim(),
    gateway: String(gateway || '').trim() || gatewayFromSubnet(String(subnet || '').trim()),
    bridge: bridgeName(proxyId),
  }
}

export function ensureEgressNetwork(proxyId, run = docker) {
  const name = networkName(proxyId)
  const br = bridgeName(proxyId)
  if (!name) return { ok: false, error: 'proxy_id_required' }
  const existing = inspectEgressNetwork(proxyId, run)
  if (existing?.subnet) return { ok: true, ...existing, reused: true }
  const created = run([
    'network',
    'create',
    '--ipv6=false',
    '--opt',
    `com.docker.network.bridge.name=${br}`,
    '--opt',
    'com.docker.network.bridge.enable_ip_masquerade=false',
    '--opt',
    'com.docker.network.bridge.enable_icc=false',
    name,
  ])
  if (!created.ok && !/already exists/i.test(created.stderr || '')) {
    return { ok: false, error: created.stderr || 'docker network create failed' }
  }
  const info = inspectEgressNetwork(proxyId, run)
  if (!info?.subnet) return { ok: false, error: 'egress network missing subnet' }
  return { ok: true, ...info, reused: false }
}

function applyIptables(plan, runIptables = iptables) {
  const checkIdx = plan.add.findIndex((a) => a.includes('-C'))
  // apply -N (ignore exists), skip -C pairs if already present, then -A/-I
  const add = plan.add
  for (let i = 0; i < add.length; i++) {
    const args = add[i]
    if (args.includes('-N')) {
      const r = runIptables(args)
      if (!r.ok && !/File exists|Chain already/i.test(r.stderr || '')) {
        /* continue; -N may fail if exists */
      }
      continue
    }
    if (args.includes('-C')) {
      const exists = runIptables(args)
      if (exists.ok) {
        i += 1
      }
      continue
    }
    const r = runIptables(args)
    if (!r.ok && !/already|exist/i.test(r.stderr || '')) {
      return { ok: false, error: r.stderr || `iptables ${args.join(' ')} failed` }
    }
  }
  void checkIdx
  return { ok: true }
}

function removeIptables(plan, runIptables = iptables) {
  for (const args of plan.del) {
    runIptables(args)
  }
  return { ok: true }
}

export const DNS_UPSTREAM_DEFAULT = 'https://1.1.1.1/dns-query'
export const DNS_UPSTREAM_OPTIONS = Object.freeze([
  DNS_UPSTREAM_DEFAULT,
  'https://dns.google/dns-query',
  '8.8.8.8:53',
  '1.1.1.1:53',
])

export function readDnsUpstream(projectRoot) {
  const db = resolveStoreDb({ dataDir: path.join(projectRoot, 'data') })
  const selected = new SettingsRepo(db).get('proxy_pool_config')?.dns_upstream
  return DNS_UPSTREAM_OPTIONS.includes(selected) ? selected : DNS_UPSTREAM_DEFAULT
}

export function egressConfig({ proxyId, proxyUrl, listenTcp, listenDns, dnsUpstream = DNS_UPSTREAM_DEFAULT }) {
  return {
    proxy_id: proxyId,
    proxy_url: proxyUrl,
    listen_tcp: listenTcp,
    listen_dns: listenDns,
    dns_upstream: dnsUpstream,
  }
}

export function egressConfigMatches(a, b) {
  return a?.listen_tcp === b.listen_tcp && a?.listen_dns === b.listen_dns &&
    a?.proxy_url === b.proxy_url &&
    (a?.dns_upstream || DNS_UPSTREAM_DEFAULT) === b.dns_upstream
}

export function startEgressProcess({ projectRoot, proxyId, proxyUrl, tcpPort, dnsPort, listenHost, dnsUpstream = DNS_UPSTREAM_DEFAULT, bin = EGRESS_BIN }) {
  if (!listenHost) return { ok: false, error: 'egress listen host required' }
  const dir = egressRunDir(projectRoot, proxyId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const pidFile = path.join(dir, 'egress.pid')
  const cfgPath = path.join(dir, 'egress.json')
  const listenTcp = `${listenHost}:${tcpPort}`
  const listenDns = `${listenHost}:${dnsPort}`
  const cfg = egressConfig({ proxyId, proxyUrl, listenTcp, listenDns, dnsUpstream })
  const existing = readPid(pidFile)
  if (existing && pidAlive(existing)) {
    try {
      const old = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      if (egressConfigMatches(old, cfg)) {
        return { ok: true, pid: existing, reused: true, configPath: cfgPath }
      }
    } catch {}
    try {
      process.kill(existing, 'SIGTERM')
    } catch {}
  }
  if (!fs.existsSync(bin)) {
    return { ok: false, error: `kin-egress binary not found: ${bin}` }
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  const child = spawn(bin, ['-config', cfgPath], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  fs.writeFileSync(pidFile, String(child.pid) + '\n', { mode: 0o600 })
  return { ok: true, pid: child.pid, reused: false, configPath: cfgPath, listen_tcp: listenTcp }
}

export function stopEgressProcess(projectRoot, proxyId) {
  const dir = egressRunDir(projectRoot, proxyId)
  const pidFile = path.join(dir, 'egress.pid')
  const pid = readPid(pidFile)
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  try {
    fs.rmSync(pidFile, { force: true })
  } catch {}
  return { ok: true }
}

export function inspectEgressProcess(projectRoot, proxyId) {
  const dir = egressRunDir(projectRoot, proxyId)
  const pid = readPid(path.join(dir, 'egress.pid'))
  if (!pid || !pidAlive(pid)) return { ok: false, pid: pid || null, reason: 'not_running' }
  let listenTcp = ''
  try {
    listenTcp = String(JSON.parse(fs.readFileSync(path.join(dir, 'egress.json'), 'utf8')).listen_tcp || '')
  } catch {
    listenTcp = ''
  }
  return { ok: true, pid, listen_tcp: listenTcp }
}

export function egressListening(projectRoot, proxyId, timeoutMs = 400) {
  if (isLocalEgressProxy(typeof proxyId === 'object' ? proxyId : { id: proxyId })) {
    return { ok: true, mode: 'direct' }
  }
  const st = inspectEgressProcess(projectRoot, proxyId)
  if (!st.ok) return st
  const spec = String(st.listen_tcp || '')
  const colon = spec.lastIndexOf(':')
  const host = colon > 0 ? spec.slice(0, colon) : ''
  const port = colon > 0 ? Number(spec.slice(colon + 1)) : 0
  if (!host || !Number.isFinite(port) || port <= 0) return { ok: false, pid: st.pid, reason: 'bad_listen' }
  if (!waitListen(host, port, timeoutMs)) return { ok: false, pid: st.pid, reason: 'not_listening' }
  return st
}

export function boundProxyUrl(proxy) {
  if (isLocalEgressProxy(proxy)) return ''
  if (proxy?.url) return String(proxy.url).replace(/^socks5:\/\//i, 'socks5h://')
  if (!proxy?.host || !proxy?.port) return ''
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : ''
  return `socks5h://${auth}${proxy.host}:${proxy.port}`
}

function waitListen(host, port, timeoutMs = 8000) {
  const start = Date.now()
  const h = host || '127.0.0.1'
  while (Date.now() - start < timeoutMs) {
    const r = sh(
      [
        'python3',
        '-c',
        `import socket,sys; s=socket.socket(); s.settimeout(0.2); sys.exit(0 if s.connect_ex(('${h}',${Number(port)}))==0 else 1)`,
      ],
      { timeout: 2000 },
    )
    if (r.ok) return true
    sh(['python3', '-c', 'import time; time.sleep(0.1)'], { timeout: 1000 })
  }
  return false
}

export function ensureLocalProxyEgress(proxy, { runDocker = docker } = {}) {
  const proxyId = proxy?.id || LOCAL_EGRESS_ID
  const name = networkName(proxyId)
  const br = bridgeName(proxyId)
  if (!name) return { ok: false, error: 'proxy_id_required' }
  const existing = inspectEgressNetwork(proxyId, runDocker)
  if (existing?.subnet) return { ok: true, mode: 'local', ...existing, reused: true, proxy_id: proxyId }
  const created = runDocker([
    'network',
    'create',
    '--ipv6=false',
    '--opt',
    `com.docker.network.bridge.name=${br}`,
    '--opt',
    'com.docker.network.bridge.enable_ip_masquerade=true',
    '--opt',
    'com.docker.network.bridge.enable_icc=false',
    name,
  ])
  if (!created.ok && !/already exists/i.test(created.stderr || '')) {
    return { ok: false, error: created.stderr || 'docker network create failed' }
  }
  const info = inspectEgressNetwork(proxyId, runDocker)
  if (!info?.subnet) return { ok: false, error: 'local egress network missing subnet' }
  return { ok: true, mode: 'local', ...info, reused: false, proxy_id: proxyId }
}

export function ensureProxyEgress(projectRoot, proxy, { runDocker = docker, runIptables = iptables, dnsUpstream } = {}) {
  if (isLocalEgressProxy(proxy)) return ensureLocalProxyEgress(proxy, { runDocker })
  const proxyId = proxy?.id
  const proxyUrl = boundProxyUrl(proxy)
  if (!proxyId || !proxyUrl) return { ok: false, error: 'bound SOCKS5 id and url required; refusing fallback' }
  const net = ensureEgressNetwork(proxyId, runDocker)
  if (!net.ok) return net
  const listenHost = net.gateway || gatewayFromSubnet(net.subnet)
  if (!listenHost) return { ok: false, error: 'egress network gateway missing' }
  const ports = portsForProxy(proxyId)
  const chain = chainName(proxyId)
  const plan = iptablesPlan({
    chain,
    bridge: net.bridge,
    subnet: net.subnet,
    tcpPort: ports.tcp,
    dnsPort: ports.dns,
  })
  const started = startEgressProcess({
    projectRoot,
    proxyId,
    proxyUrl,
    tcpPort: ports.tcp,
    dnsPort: ports.dns,
    listenHost,
    dnsUpstream: dnsUpstream ?? readDnsUpstream(projectRoot),
  })
  if (!started.ok) return started
  if (!waitListen(listenHost, ports.tcp))
    return { ok: false, error: `kin-egress ${listenHost}:${ports.tcp} did not listen` }
  const rules = applyIptables(plan, runIptables)
  if (!rules.ok) {
    stopEgressProcess(projectRoot, proxyId)
    return rules
  }
  return {
    ok: true,
    network: net.name,
    bridge: net.bridge,
    subnet: net.subnet,
    gateway: listenHost,
    ports,
    pid: started.pid,
    proxy_id: proxyId,
  }
}

export function stopProxyEgress(projectRoot, proxyId, { subnet, runDocker = docker, runIptables = iptables } = {}) {
  const net = inspectEgressNetwork(proxyId, runDocker)
  const plan = iptablesPlan({
    chain: chainName(proxyId),
    bridge: bridgeName(proxyId),
    subnet: subnet || net?.subnet || '0.0.0.0/0',
    tcpPort: portsForProxy(proxyId).tcp,
    dnsPort: portsForProxy(proxyId).dns,
  })
  removeIptables(plan, runIptables)
  stopEgressProcess(projectRoot, proxyId)
  if (net?.name) runDocker(['network', 'rm', net.name])
  return { ok: true }
}

export function slotNetworkForVm(vm, _env = process.env) {
  const id = vm?.proxy?.id
  if (!id) return ''
  return networkName(id)
}
