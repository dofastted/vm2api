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
import { getDb, isDbOpen } from '../db/database.mjs'
import { RuntimeSettings as SettingsRepo } from '../db/settings-state.mjs'
import { socksProxyUrl } from './socks-address.mjs'
import { assertProxyAllowed, proxyBlockedReason } from './proxy-policy.mjs'
import { atomicWriteJson } from './vm-file.mjs'
import { isKubernetesMode } from '../core/control-plane-mode.mjs'

export const EGRESS_BIN = process.env.KIN_EGRESS_BIN || '/opt/kin-gateway/bin/kin-egress'
export const LOCAL_EGRESS_ID = 'px-local'
const LOCAL_EGRESS_NODE_PREFIX = `${LOCAL_EGRESS_ID}-`

/**
 * Local egress is one pool row per VPS: `px-local` for the control plane,
 * `px-local-<nodeId>` for each cluster node. Bind capacity, probe and geo are
 * then per machine, while every local row on a host shares the same docker
 * bridge (see egressArtifactId).
 */
export function localEgressIdForNode(nodeId) {
  const key = String(nodeId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
  return key ? `${LOCAL_EGRESS_NODE_PREFIX}${key}` : LOCAL_EGRESS_ID
}

export function isLocalEgressId(proxyId) {
  const id = String(proxyId || '').trim()
  return id === LOCAL_EGRESS_ID || id.startsWith(LOCAL_EGRESS_NODE_PREFIX)
}

/** Node a local row belongs to; null for the control plane (or a non-local id). */
export function localEgressNodeId(proxyId) {
  const id = String(proxyId || '').trim()
  return id.startsWith(LOCAL_EGRESS_NODE_PREFIX) ? id.slice(LOCAL_EGRESS_NODE_PREFIX.length) || null : null
}

export function isLocalEgressProxy(proxy) {
  if (!proxy || typeof proxy !== 'object') return false
  const id = String(proxy.id || '').trim()
  if (isLocalEgressId(id)) return true
  const scheme = String(proxy.scheme || proxy.kind || '')
    .trim()
    .toLowerCase()
  const host = String(proxy.host || '')
    .trim()
    .toLowerCase()
  return scheme === 'local' || host === 'local'
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
  const blocked = proxyBlockedReason(proxy)
  if (blocked) return { ok: false, reason: blocked }
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

// Each host has a single local masquerade bridge, whichever per-node local row a slot holds.
function egressArtifactId(proxyId) {
  return isLocalEgressId(proxyId) ? LOCAL_EGRESS_ID : proxyId
}

export function networkName(proxyId) {
  const id = proxyKey(egressArtifactId(proxyId))
  return id ? `kin-eg-${id}` : ''
}

/** Linux iface max 15 chars. */
export function bridgeName(proxyId) {
  const hex = proxyKey(egressArtifactId(proxyId))
    .replace(/^px-/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 12)
  return (`keg${hex}` || 'kegbridge').slice(0, 15)
}

export function chainName(proxyId) {
  const hex = proxyKey(egressArtifactId(proxyId))
    .replace(/^px-/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 12)
  return (`KEG${hex}` || 'KEG').slice(0, 28)
}

export function portsForProxy(proxyId) {
  const s = proxyKey(egressArtifactId(proxyId))
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
  // REDIRECT delivers bridge traffic to host INPUT. Allow only this proxy's
  // subnet and helper ports, ahead of host default-reject rules (e.g. Oracle).
  const inputRules = [
    [
      '-i',
      bridge,
      '-s',
      subnet,
      '-d',
      subnet,
      '-p',
      'tcp',
      '-m',
      'multiport',
      '--dports',
      `${tcp},${dns}`,
      '-j',
      'ACCEPT',
    ],
    ['-i', bridge, '-s', subnet, '-d', subnet, '-p', 'udp', '--dport', dns, '-j', 'ACCEPT'],
  ]
  return {
    add: [
      // Fail closed even while the helper starts or the NAT chain is rebuilt.
      ['-t', 'filter', '-C', 'FORWARD', '-i', bridge, '!', '-d', subnet, '-j', 'DROP'],
      ['-t', 'filter', '-I', 'FORWARD', '1', '-i', bridge, '!', '-d', subnet, '-j', 'DROP'],
      ['-t', 'nat', '-N', chain],
      ['-t', 'nat', '-C', 'PREROUTING', '-i', bridge, '-j', chain],
      ['-t', 'nat', '-A', 'PREROUTING', '-i', bridge, '-j', chain],
      ['-t', 'nat', '-F', chain],
      ['-t', 'nat', '-A', chain, '-d', subnet, '-j', 'RETURN'],
      ['-t', 'nat', '-A', chain, '-p', 'tcp', '--dport', '53', '-j', 'REDIRECT', '--to-ports', dns],
      ['-t', 'nat', '-A', chain, '-p', 'udp', '--dport', '53', '-j', 'REDIRECT', '--to-ports', dns],
      ['-t', 'nat', '-A', chain, '-p', 'tcp', '-j', 'REDIRECT', '--to-ports', tcp],
      ...inputRules.flatMap((rule) => [
        ['-t', 'filter', '-C', 'INPUT', ...rule],
        ['-t', 'filter', '-I', 'INPUT', '1', ...rule],
      ]),
    ],
    del: [
      ['-t', 'nat', '-D', 'PREROUTING', '-i', bridge, '-j', chain],
      ['-t', 'nat', '-F', chain],
      ['-t', 'nat', '-X', chain],
      ['-t', 'filter', '-D', 'FORWARD', '-i', bridge, '!', '-d', subnet, '-j', 'DROP'],
      ...inputRules.map((rule) => ['-t', 'filter', '-D', 'INPUT', ...rule]),
    ],
  }
}

function commandPrefix(name) {
  const raw = String(process.env.KIN_EGRESS_CMD_PREFIX || '').trim()
  if (!raw || !['ss', 'iptables'].includes(name)) return []
  return raw.split(/\s+/).filter(Boolean)
}

function sh(argv, { timeout = 15_000 } = {}) {
  const command = [...commandPrefix(argv[0]), ...argv]
  try {
    const out = execFileSync(command[0], command.slice(1), {
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

/** True when pid exists and is not a zombie (Linux). Used by tests and stop/reload paths. */
export function egressPidActive(pid) {
  return pidAlive(pid)
}

function pidNamespaceCommand(args) {
  const prefix = commandPrefix('ss')
  if (isKubernetesMode() || !prefix.length) return args
  return ['docker', 'run', '--rm', '--network', 'host', '--pid', 'host', '--privileged', 'nicolaka/netshoot', ...args]
}

function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  if (!isKubernetesMode() && commandPrefix('ss').length) {
    return sh(pidNamespaceCommand(['sh', '-c', `kill -0 ${n} 2>/dev/null`])).ok
  }
  try {
    process.kill(n, 0)
  } catch {
    return false
  }
  if (process.platform === 'linux') {
    try {
      const state = fs.readFileSync(`/proc/${n}/stat`, 'utf8').split(' ')[2]
      if (state === 'Z') return false
    } catch {
      return false
    }
  }
  return true
}

function readPid(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim())
  } catch {
    return 0
  }
}

function processExe(pid) {
  const exe = fs.readlinkSync(`/proc/${pid}/exe`)
  const deleted = exe.endsWith(' (deleted)')
  return { path: deleted ? exe.slice(0, -' (deleted)'.length) : exe, deleted }
}

function processText(pid, file) {
  const probe = pidNamespaceCommand(['sh', '-c', `cat /proc/${Number(pid)}/${file} 2>/dev/null`])
  const result = sh(probe)
  return result.ok ? result.stdout : ''
}

function listenerPid(port) {
  const probe = sh(['ss', '-H', '-ltnp', `sport = :${Number(port)}`], { timeout: 2000 })
  const match = probe.stdout.match(/pid=(\d+)/)
  return match ? Number(match[1]) : 0
}

function ownsEgressProcess(pid, configPath, { allowDeleted = false } = {}) {
  if (!isKubernetesMode() && commandPrefix('ss').length) {
    if (!pidAlive(pid)) return false
    const args = processText(pid, 'cmdline').split('\0')
    const index = args.indexOf('-config')
    if (index <= 0 || !args[index + 1] || !args.some((arg) => path.basename(arg).startsWith('kin-egress'))) return false
    const argument = args[index + 1]
    const cwd = sh(pidNamespaceCommand(['readlink', `/proc/${Number(pid)}/cwd`]))
    if (!path.isAbsolute(argument) && !cwd.ok) return false
    return (
      path.resolve(path.isAbsolute(argument) ? argument : path.join(cwd.stdout, argument)) === path.resolve(configPath)
    )
  }
  if (!pidAlive(pid)) return false
  try {
    // PID files survive container restarts; a live PID may belong to another
    // process or another proxy. Verify both before reusing or signaling it.
    // A replaced binary keeps the old inode in this process. Reusing it leaves
    // the new file unrun and its listen port permanently busy.
    const exe = processExe(pid)
    if (exe.deleted && !allowDeleted) return false
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    const configIndex = args.indexOf('-config')
    if (
      !args.some((arg) => path.basename(String(arg || '').replace(/ \(deleted\)$/, '')).startsWith('kin-egress')) ||
      configIndex <= 0 ||
      !args[configIndex + 1]
    )
      return false
    const argument = args[configIndex + 1]
    const actualConfig = path.isAbsolute(argument)
      ? path.resolve(argument)
      : path.resolve(fs.readlinkSync(`/proc/${pid}/cwd`), argument)
    return path.normalize(actualConfig) === path.normalize(path.resolve(configPath))
  } catch {
    return false
  }
}

function egressProcessPids() {
  if (!isKubernetesMode() && commandPrefix('ss').length) {
    const probe = pidNamespaceCommand([
      'sh',
      '-c',
      'for dir in /proc/[1-9]*; do tr "\\0" " " < "$dir/cmdline" 2>/dev/null | grep -q kin-egress && basename "$dir"; done',
    ])
    const result = sh(probe)
    if (!result.ok) return []
    return result.stdout
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  }
  if (process.platform !== 'linux') return []
  const pids = []
  for (const name of fs.readdirSync('/proc')) {
    if (!/^[1-9][0-9]*$/.test(name)) continue
    try {
      const args = fs.readFileSync(`/proc/${name}/cmdline`).toString('utf8').split('\0')
      if (args.some((arg) => path.basename(arg.replace(/ \(deleted\)$/, '')).startsWith('kin-egress')))
        pids.push(Number(name))
    } catch {
      // Raced with exit, or a process whose /proc we cannot read.
    }
  }
  return pids
}

function staleEgressPids(configPath, exceptPid = 0) {
  const wanted = path.resolve(configPath)
  return egressProcessPids().filter(
    (pid) => pid !== exceptPid && ownsEgressProcess(pid, wanted, { allowDeleted: true }),
  )
}

/** Live kin-egress PIDs bound to one proxy config (stale pidfiles included). */
export function egressPidsForProxyConfig(projectRoot, proxyId) {
  const dir = egressRunDir(projectRoot, proxyId)
  const cfgPath = path.join(dir, 'egress.json')
  const recorded = readPid(path.join(dir, 'egress.pid'))
  const pids = new Set(staleEgressPids(cfgPath))
  if (ownsEgressProcess(recorded, cfgPath, { allowDeleted: true })) pids.add(recorded)
  return [...pids]
}

export function readEgressListenTcp(projectRoot, proxyId) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(egressRunDir(projectRoot, proxyId), 'egress.json'), 'utf8'))
    return String(cfg.listen_tcp || '')
  } catch {
    return ''
  }
}
export function inspectEgressNetwork(proxyId, run = docker, { strict = false, target = null } = {}) {
  const name = target || networkName(proxyId)
  if (!name) return null
  const r = run([
    'network',
    'inspect',
    '-f',
    '{{range .IPAM.Config}}{{.Subnet}}|{{.Gateway}}{{end}}|{{.Id}}|{{json .Containers}}',
    name,
  ])
  if (!r.ok) {
    if (
      strict &&
      !/^(?:Error(?: response from daemon)?: )?(?:No such network: [^\r\n]+|network [^\r\n]+ not found)$/i.test(
        r.stderr || '',
      )
    ) {
      throw Object.assign(new Error(r.stderr || 'Docker network inspection failed'), { code: 'egress_network_unknown' })
    }
    return null
  }
  const [subnet, gateway, id, attached] = String(r.stdout || '').split('|')
  if (strict && !id?.trim())
    throw Object.assign(new Error('Docker network identity unavailable'), { code: 'egress_network_unknown' })
  let containers = null
  if (attached) {
    try {
      containers = JSON.parse(attached)
      if (
        !containers ||
        Array.isArray(containers) ||
        typeof containers !== 'object' ||
        Object.values(containers).some((item) => !item || typeof item.Name !== 'string' || !item.Name)
      )
        throw new Error('Invalid Docker network endpoints')
    } catch (error) {
      if (strict) throw Object.assign(error, { code: 'egress_network_unknown' })
      containers = null
    }
  }
  return {
    name,
    id: id?.trim() || null,
    containers,
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

function removeIptables(plan, runIptables = iptables, { strict = false } = {}) {
  for (const args of plan.del) {
    const result = runIptables(args)
    if (strict && !result.ok && !/Bad rule|No chain\/target\/match by that name/i.test(result.stderr || '')) {
      return { ok: false, error: result.stderr || 'iptables removal unconfirmed' }
    }
  }
  return { ok: true }
}

// Must mirror DefaultDNSUpstreams in worker/internal/egress/server.go.
export const DNS_UPSTREAMS = Object.freeze([
  'https://1.1.1.1/dns-query',
  'https://8.8.8.8/dns-query',
  '8.8.8.8:53',
  '1.1.1.1:53',
])
export const DNS_PRIMARY_AUTO = 'auto'

export function validDnsPrimary(value) {
  if (value === DNS_PRIMARY_AUTO || DNS_UPSTREAMS.includes(value)) return true
  // The upstream chain is comma-delimited. Reject URL forms that URL() would
  // silently normalize or that cannot be carried unchanged to kin-egress.
  if (typeof value !== 'string' || /[\s\x00-\x1f\x7f\\,#]/.test(value)) return false
  if (/%(?![a-f0-9]{2})/i.test(value)) return false
  const authority = /^https:\/\/(\[[^\]]+\]|[^/:?#]+)(?::([0-9]+))?(?:[/?]|$)/.exec(value)
  if (!authority || authority[1].includes('@')) return false
  if (authority[2] != null && (Number(authority[2]) < 1 || Number(authority[2]) > 65535)) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) return false
    // URL() validates bracketed IPv6 literals and numeric IPv4 addresses.
    if (authority[1].startsWith('[')) return true
    const host = authority[1].replace(/\.$/, '')
    return host.length <= 253 && host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  } catch {
    return false
  }
}

// Operator picks which DNS to try first; the rest stay behind it as fallback.
// 'auto' -> '' so kin-egress uses its built-in order.
export function dnsUpstreamChain(primary) {
  if (primary === DNS_PRIMARY_AUTO || !validDnsPrimary(primary)) return ''
  return [primary, ...DNS_UPSTREAMS.filter((u) => u !== primary)].join(',')
}

export function configuredDnsUpstream() {
  if (!isDbOpen()) return ''
  try {
    return dnsUpstreamChain(new SettingsRepo(getDb()).get('proxy_pool_config')?.dns_primary)
  } catch {
    return ''
  }
}

export function configuredDnsEmptyTypes() {
  if (!isDbOpen()) return []
  return new SettingsRepo(getDb()).get('proxy_pool_config')?.dns_disable_svcb_https === true ? [64, 65] : []
}

const EGRESS_POLL_MS = 50
const egressWaitLock = new Int32Array(new SharedArrayBuffer(4))

function sleepMsSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return
  Atomics.wait(egressWaitLock, 0, 0, Math.min(Math.floor(ms), 2_147_483_647))
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function startEgressProcess({
  projectRoot,
  proxyId,
  proxyUrl,
  tcpPort,
  dnsPort,
  listenHost,
  bin = EGRESS_BIN,
  dnsUpstream = '',
  dnsEmptyTypes = [],
  domainForward = false,
}) {
  const blocked = proxyBlockedReason({ url: proxyUrl })
  if (blocked) return { ok: false, error: blocked }
  if (!listenHost) return { ok: false, error: 'egress listen host required' }
  const dir = egressRunDir(projectRoot, proxyId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const pidFile = path.join(dir, 'egress.pid')
  const cfgPath = path.join(dir, 'egress.json')
  const listenTcp = `${listenHost}:${tcpPort}`
  const listenDns = `${listenHost}:${dnsPort}`
  const existing = readPid(pidFile)
  let owner
  try {
    owner = isKubernetesMode() ? egressOwnerSnapshot(projectRoot, proxyId) : { legacy: true, pid: existing }
  } catch (error) {
    return egressOwnerUnknown(error, existing)
  }
  const configMatches = ownsEgressProcess(existing, cfgPath)
  if (configMatches) {
    try {
      const old = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      if (
        old.listen_tcp === listenTcp &&
        old.listen_dns === listenDns &&
        old.proxy_url === proxyUrl &&
        (old.dns_upstream || '') === dnsUpstream &&
        JSON.stringify(old.dns_empty_types || []) === JSON.stringify(dnsEmptyTypes) &&
        !!old.domain_forward === !!domainForward &&
        staleEgressPids(cfgPath, existing).length === 0
      ) {
        return { ok: true, pid: existing, reused: true, configPath: cfgPath }
      }
    } catch (error) {
      if (isKubernetesMode()) return egressOwnerUnknown(error, existing)
    }
  }
  if (!owner.legacy && (owner.receipt || isKubernetesMode())) {
    const stopped = await stopEgressProcessConfirmed(projectRoot, proxyId)
    if (!stopped.ok) return stopped
  }
  const portOwner = owner.legacy ? listenerPid(tcpPort) : null
  if (portOwner && !ownsEgressProcess(portOwner, cfgPath, { allowDeleted: true }))
    return { ok: false, error: 'egress_port_busy', pid: portOwner }
  const superseded = owner.legacy
    ? [...new Set([...(configMatches ? [existing] : []), ...staleEgressPids(cfgPath), portOwner].filter(Boolean))]
    : []
  for (const pid of superseded) {
    const stopped = await stopOwnedEgress(pid)
    if (!stopped.ok) return { ok: false, error: stopped.error, pid }
  }
  if (tcpPort > 0) {
    const portFree = await waitPortReleased(listenHost, tcpPort)
    if (!portFree.ok) return { ok: false, error: portFree.error, pid: superseded[0] || existing }
  }
  if (dnsPort > 0) {
    const dnsFree = await waitPortReleased(listenHost, dnsPort)
    if (!dnsFree.ok) return { ok: false, error: dnsFree.error, pid: superseded[0] || existing }
  }
  if (!fs.existsSync(bin)) {
    return { ok: false, error: `kin-egress binary not found: ${bin}` }
  }
  const cfg = {
    proxy_id: proxyId,
    proxy_url: proxyUrl,
    listen_tcp: listenTcp,
    listen_dns: listenDns,
  }
  if (dnsUpstream) cfg.dns_upstream = dnsUpstream
  if (dnsEmptyTypes.length) cfg.dns_empty_types = dnsEmptyTypes
  if (domainForward) cfg.domain_forward = true
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  const spawned = await spawnDetachedEgress(bin, cfgPath)
  if (!spawned.ok) return spawned
  const realPid =
    !isKubernetesMode() && commandPrefix('ss').length && tcpPort > 0
      ? await waitForListenerPid(listenHost, tcpPort)
      : spawned.pid
  if (!realPid) return { ok: false, error: `kin-egress ${listenTcp} did not listen` }
  try {
    fs.writeFileSync(pidFile, String(realPid) + '\n', { mode: 0o600 })
    if (process.platform === 'linux') {
      const identity = readEgressIdentity(realPid, cfgPath)
      if (!identity || identity.state === 'Z' || identity.other)
        throw new Error('Egress execution identity was not recorded')
      atomicWriteJson(
        path.join(dir, 'egress.owner.json'),
        {
          ...egressExecutionDomain(),
          proxy_id: proxyId,
          pid: realPid,
          start_ticks: identity.start_ticks,
        },
        { mode: 0o600 },
      )
    } else if (isKubernetesMode()) throw new Error('Egress execution identity is unavailable on this platform')
  } catch (error) {
    return { ...egressOwnerUnknown(error, realPid), code: 'egress_receipt_persist_failed' }
  }
  return { ok: true, pid: realPid, reused: false, configPath: cfgPath, listen_tcp: listenTcp }
}

export function stopEgressProcess(projectRoot, proxyId) {
  const dir = egressRunDir(projectRoot, proxyId)
  const pidFile = path.join(dir, 'egress.pid')
  const pids = [...new Set(egressPidsForProxyConfig(projectRoot, proxyId))]
  const pending = []
  for (const pid of pids) {
    if (!isKubernetesMode() && commandPrefix('ss').length) {
      const signaled = sh(pidNamespaceCommand(['sh', '-c', `kill -TERM ${Number(pid)} 2>/dev/null`]))
      if (!signaled.ok) {
        if (pidAlive(pid)) return { ok: false, error: 'egress_stop_failed' }
        continue
      }
    } else {
      try {
        process.kill(pid, 'SIGTERM')
      } catch (error) {
        if (error.code === 'ESRCH') continue
        return { ok: false, error: `egress_stop_failed: ${error.code || error.message}` }
      }
    }
    pending.push(pid)
  }
  if (pending.length) return { ok: true, pending }
  try {
    fs.rmSync(pidFile, { force: true })
  } catch (error) {
    return { ok: false, error: `egress_pid_cleanup_failed: ${error.code || error.message}` }
  }
  return { ok: true, pending }
}

function egressOwnerUnknown(error, pid = null) {
  return {
    ok: false,
    code: 'egress_owner_unreachable',
    error: String(error?.message || error),
    pid,
    vmOperationUncertain: true,
  }
}

function egressExecutionDomain() {
  if (process.platform !== 'linux') throw new Error('Egress execution domain is not observable')
  return {
    boot_id: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    pid_namespace: fs.readlinkSync('/proc/self/ns/pid'),
  }
}

function readEgressIdentity(pid, configPath) {
  let stat
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null
    throw error
  }
  const fields = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)
  if (!/^\d+$/.test(fields[19] || '')) throw new Error('Egress process start identity is unavailable')
  const identity = { pid, state: fields[0], start_ticks: fields[19] }
  if (identity.state === 'Z') return identity
  try {
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    const index = args.indexOf('-config')
    const argument = args[index + 1]
    if (
      index <= 0 ||
      !argument ||
      !args.some((arg) => path.basename(arg.replace(/ \(deleted\)$/, '')).startsWith('kin-egress'))
    ) {
      return { ...identity, other: true }
    }
    const actual = path.isAbsolute(argument)
      ? path.resolve(argument)
      : path.resolve(fs.readlinkSync(`/proc/${pid}/cwd`), argument)
    if (actual !== path.resolve(configPath)) return { ...identity, other: true }
    processExe(pid) // A permission error is unknown, never absence.
    return identity
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') {
      try {
        const latest = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        if (
          latest
            .slice(latest.lastIndexOf(')') + 1)
            .trim()
            .split(/\s+/)[0] === 'Z'
        )
          return { ...identity, state: 'Z' }
      } catch (absent) {
        if (absent.code === 'ENOENT' || absent.code === 'ESRCH') return null
      }
    }
    throw error
  }
}

function egressOwnerSnapshot(projectRoot, proxyId) {
  const dir = egressRunDir(projectRoot, proxyId)
  const config = path.join(dir, 'egress.json')
  let pid = null
  try {
    pid = Number(fs.readFileSync(path.join(dir, 'egress.pid'), 'utf8').trim())
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid egress PID record')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  let receipt = null
  try {
    receipt = JSON.parse(fs.readFileSync(path.join(dir, 'egress.owner.json'), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!receipt) {
    if (!isKubernetesMode()) return { legacy: true, pid }
    if (pid || egressPidsForProxyConfig(projectRoot, proxyId).length)
      throw new Error('Egress PID has no execution identity receipt')
    return { receipt: null, pid: null }
  }
  const domain = egressExecutionDomain()
  if (
    receipt.proxy_id !== proxyId ||
    !Number.isSafeInteger(receipt.pid) ||
    receipt.pid <= 0 ||
    typeof receipt.start_ticks !== 'string' ||
    !/^\d+$/.test(receipt.start_ticks) ||
    receipt.boot_id !== domain.boot_id ||
    receipt.pid_namespace !== domain.pid_namespace ||
    (pid && pid !== receipt.pid)
  )
    throw new Error('Egress execution owner is not observable in this PID namespace')
  const identity = readEgressIdentity(receipt.pid, config)
  if (identity && identity.start_ticks !== receipt.start_ticks && !identity.other && identity.state !== 'Z') {
    throw new Error('An unreceipted egress helper reused the recorded PID')
  }
  if (identity?.start_ticks === receipt.start_ticks && identity.other)
    throw new Error('Egress process execution changed')
  for (const other of egressPidsForProxyConfig(projectRoot, proxyId)) {
    if (other !== receipt.pid) throw new Error('An additional egress process has no execution identity receipt')
  }
  return { receipt, identity, pid: receipt.pid }
}

/** Confirm the recorded execution ended; never signal a reused PID or another Pod's namespace. */
export async function stopEgressProcessConfirmed(
  projectRoot,
  proxyId,
  { termTimeoutMs = EGRESS_STOP_TIMEOUT_MS, killGraceMs = EGRESS_KILL_GRACE_MS } = {},
) {
  try {
    const owner = egressOwnerSnapshot(projectRoot, proxyId)
    if (owner.legacy) {
      const drained = await drainEgressForProxyConfig(projectRoot, proxyId)
      if (!drained.ok) return { ...drained, vmOperationUncertain: true }
      return { ...stopEgressProcess(projectRoot, proxyId), ended: false, legacy: true }
    }
    const config = path.join(egressRunDir(projectRoot, proxyId), 'egress.json')
    const ended = () => {
      if (!owner.receipt) return true
      const current = readEgressIdentity(owner.pid, config)
      if (!current || current.state === 'Z') return true
      if (current.start_ticks !== owner.receipt.start_ticks) {
        if (!current.other) throw new Error('An unreceipted egress helper reused the recorded PID')
        return true
      }
      if (current.other) throw new Error('Egress process execution changed')
      return false
    }
    for (const [signal, timeout] of [
      ['SIGTERM', termTimeoutMs],
      ['SIGKILL', killGraceMs],
    ]) {
      if (ended()) break
      try {
        process.kill(owner.pid, signal)
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
      const deadline = Date.now() + timeout
      while (!ended() && Date.now() < deadline) await delay(EGRESS_POLL_MS)
    }
    if (!ended()) throw new Error('Egress process termination was not confirmed')
    for (const file of ['egress.pid', 'egress.owner.json'])
      fs.rmSync(path.join(egressRunDir(projectRoot, proxyId), file), { force: true })
    return { ok: true, ended: true }
  } catch (error) {
    return egressOwnerUnknown(error)
  }
}

async function stopOwnedEgress(pid) {
  if (!isKubernetesMode() && commandPrefix('ss').length) {
    const signaled = sh(pidNamespaceCommand(['sh', '-c', `kill -TERM ${Number(pid)} 2>/dev/null`]))
    if (!signaled.ok && pidAlive(pid)) return { ok: false, error: 'egress_stop_failed' }
    return waitEgressExit(pid)
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (error.code !== 'ESRCH') return { ok: false, error: `egress_stop_failed: ${error.code || error.message}` }
  }
  return await waitEgressExit(pid)
}

export function inspectEgressProcess(projectRoot, proxyId) {
  const dir = egressRunDir(projectRoot, proxyId)
  const pid = readPid(path.join(dir, 'egress.pid'))
  if (!ownsEgressProcess(pid, path.join(dir, 'egress.json'))) {
    return { ok: false, pid: pid || null, reason: 'not_running' }
  }
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
  assertProxyAllowed(proxy)
  return socksProxyUrl(proxy)
}

// reqwest's order for an https destination; HTTP_PROXY only covers http:// destinations.
const LOCAL_PROXY_ENV_KEYS = Object.freeze(['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'])

/**
 * Deployment proxy behind a local Codex slot. A host-launched Codex kernel would
 * read these variables on its own while node-fetch ignores them, splitting one
 * account across two exits; Node resolves the URL once and hands the kernel the
 * same value. NO_PROXY does not apply: the exit is chosen per slot, not per host.
 */
export function localEgressProxyUrl(env = process.env) {
  for (const key of LOCAL_PROXY_ENV_KEYS) {
    const value = String(env?.[key] || '').trim()
    if (value) return value.replace(/^socks5:\/\//i, 'socks5h://')
  }
  return ''
}

const EGRESS_STOP_TIMEOUT_MS = 8000
const EGRESS_KILL_GRACE_MS = 3000

function egressProcessAbsent(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return true
  if (process.platform === 'linux') {
    try {
      return !fs.existsSync(`/proc/${n}`)
    } catch {
      return true
    }
  }
  return !pidAlive(n)
}

async function waitEgressReap(pid, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (egressProcessAbsent(pid)) return { ok: true }
    await delay(EGRESS_POLL_MS)
  }
  return { ok: false, error: 'egress_reap_timeout', pid }
}

/** Wait for an egress PID to exit after SIGTERM, then SIGKILL if needed. */
export async function waitEgressExit(
  pid,
  { termTimeoutMs = EGRESS_STOP_TIMEOUT_MS, killGraceMs = EGRESS_KILL_GRACE_MS } = {},
) {
  if (egressProcessAbsent(pid)) return { ok: true }
  const termStart = Date.now()
  while (Date.now() - termStart < termTimeoutMs) {
    if (egressProcessAbsent(pid)) return { ok: true }
    if (!pidAlive(pid)) break
    await delay(EGRESS_POLL_MS)
  }
  if (egressProcessAbsent(pid)) return { ok: true }
  if (!isKubernetesMode() && commandPrefix('ss').length) {
    const killed = sh(pidNamespaceCommand(['sh', '-c', `kill -KILL ${Number(pid)} 2>/dev/null`]))
    if (!killed.ok && pidAlive(pid)) return { ok: false, error: 'egress_kill_failed', pid }
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if (error.code === 'ESRCH') return await waitEgressReap(pid, killGraceMs)
      return { ok: false, error: `egress_kill_failed: ${error.code || error.message}`, pid }
    }
  }
  const reaped = await waitEgressReap(pid, killGraceMs)
  if (!reaped.ok) return reaped
  return { ok: true }
}

export async function drainEgressForProxyConfig(projectRoot, proxyId) {
  for (const pid of egressPidsForProxyConfig(projectRoot, proxyId)) {
    const stopped = await stopOwnedEgress(pid)
    if (!stopped.ok) return stopped
  }
  return { ok: true }
}

export async function waitPortReleased(host, port, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!portListening(host, port)) return { ok: true }
    await delay(EGRESS_POLL_MS)
  }
  return { ok: false, error: 'egress_port_busy', port }
}

async function waitForListenerPid(host, port, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const probe = sh(['ss', '-H', '-ltnp', `sport = :${Number(port)}`], { timeout: 2000 })
    const match = probe.stdout.match(/pid=(\d+)/)
    if (match) return Number(match[1])
    await delay(100)
  }
  return 0
}

function spawnDetachedEgress(bin, cfgPath) {
  return new Promise((resolve) => {
    const child = spawn(bin, ['-config', cfgPath], { detached: true, stdio: 'ignore' })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    child.once('error', (error) => {
      finish({ ok: false, error: `egress_spawn_failed: ${error.code || error.message}` })
    })
    child.once('spawn', () => {
      child.unref()
      finish({ ok: true, pid: child.pid })
    })
    setTimeout(() => {
      if (child.pid) {
        child.unref()
        finish({ ok: true, pid: child.pid })
        return
      }
      finish({ ok: false, error: 'egress_spawn_failed: no pid' })
    }, 500)
  })
}

function portListening(host, port, ownerPid = 0) {
  const h = host || '127.0.0.1'
  // A TCP connect is traffic to the transparent forwarder, not a passive
  // readiness check. Inspect LISTEN sockets without entering its data path.
  const probe = ownerPid
    ? ['ss', '-H', '-ltnp', `sport = :${Number(port)}`]
    : ['ss', '-H', '-ltn', `sport = :${Number(port)}`]
  const r = sh(probe, { timeout: 2000 })
  return (
    r.ok &&
    r.stdout.split('\n').some((line) => {
      const fields = line.trim().split(/\s+/)
      const local = fields[3]
      const addressMatches =
        local === `${h}:${port}` || local === `0.0.0.0:${port}` || local === `*:${port}` || local === `[::]:${port}`
      if (!addressMatches) return false
      if (!ownerPid) return true
      return new RegExp(`pid=${ownerPid}(?:\\D|$)`).test(fields.at(-1) || '')
    })
  )
}

function waitListen(host, port, timeoutMs = 8000, ownerPid = 0) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (portListening(host, port, ownerPid)) return true
    sleepMsSync(100)
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

const egressStarts = new Map()

/**
 * One stop/start sequence per proxy at a time. The pid file is written only after
 * spawn, and fleet refresh stops every helper for the config before starting.
 */
export async function runExclusiveProxyEgress(projectRoot, proxyId, fn) {
  const key = egressRunDir(projectRoot || '', proxyId || '')
  const run = (egressStarts.get(key) || Promise.resolve()).then(() => fn())
  const tail = run.catch(() => {})
  egressStarts.set(key, tail)
  try {
    return await run
  } finally {
    if (egressStarts.get(key) === tail) egressStarts.delete(key)
  }
}

export async function ensureProxyEgress(projectRoot, proxy, opts = {}) {
  if (isLocalEgressProxy(proxy)) return ensureLocalProxyEgress(proxy, { runDocker: opts.runDocker })
  return await runExclusiveProxyEgress(
    projectRoot,
    proxy?.id,
    async () => await startProxyEgress(projectRoot, proxy, opts),
  )
}

export async function startProxyEgress(
  projectRoot,
  proxy,
  {
    runDocker = docker,
    runIptables = iptables,
    dnsUpstream = configuredDnsUpstream(),
    dnsEmptyTypes = configuredDnsEmptyTypes(),
    bin,
    ports,
    listenHost: listenHostOverride,
  } = {},
) {
  const blocked = proxyBlockedReason(proxy)
  if (blocked) return { ok: false, error: blocked }
  const proxyId = proxy?.id
  const proxyUrl = boundProxyUrl(proxy)
  if (!proxyId || !proxyUrl) return { ok: false, error: 'bound SOCKS5 id and url required; refusing fallback' }
  const net = ensureEgressNetwork(proxyId, runDocker)
  if (!net.ok) return net
  const listenHost = listenHostOverride || net.gateway || gatewayFromSubnet(net.subnet)
  if (!listenHost) return { ok: false, error: 'egress network gateway missing' }
  const selectedPorts = ports || portsForProxy(proxyId)
  const chain = chainName(proxyId)
  const plan = iptablesPlan({
    chain,
    bridge: net.bridge,
    subnet: net.subnet,
    tcpPort: selectedPorts.tcp,
    dnsPort: selectedPorts.dns,
  })
  const rules = applyIptables(plan, runIptables)
  if (!rules.ok) return rules
  const started = await startEgressProcess({
    projectRoot,
    proxyId,
    proxyUrl,
    tcpPort: selectedPorts.tcp,
    dnsPort: selectedPorts.dns,
    listenHost,
    dnsUpstream,
    dnsEmptyTypes,
    domainForward: proxy?.domain_forward === true,
    ...(bin ? { bin } : {}),
  })
  if (!started.ok) return started
  if (!waitListen(listenHost, selectedPorts.tcp, 8000, selectedPorts.tcp > 0 ? started.pid : 0))
    return { ok: false, error: `kin-egress ${listenHost}:${selectedPorts.tcp} did not listen`, pid: started.pid }
  return {
    ok: true,
    network: net.name,
    bridge: net.bridge,
    subnet: net.subnet,
    gateway: listenHost,
    ports: selectedPorts,
    pid: started.pid,
    proxy_id: proxyId,
  }
}

export function stopProxyEgress(projectRoot, proxyId, { subnet, runDocker = docker, runIptables = iptables } = {}) {
  // A node's local row owns nothing here; its bridge name is the control plane's px-local one.
  if (localEgressNodeId(proxyId)) return { ok: true, skipped: 'node_local' }
  return runExclusiveProxyEgress(projectRoot, proxyId, async () => {
    try {
      const net = inspectEgressNetwork(proxyId, runDocker, { strict: true })
      const stopped = await stopEgressProcessConfirmed(projectRoot, proxyId)
      if (!stopped.ok) return stopped
      const plan = iptablesPlan({
        chain: chainName(proxyId),
        bridge: bridgeName(proxyId),
        subnet: subnet || net?.subnet || '0.0.0.0/0',
        tcpPort: portsForProxy(proxyId).tcp,
        dnsPort: portsForProxy(proxyId).dns,
      })
      const rules = removeIptables(plan, runIptables, { strict: true })
      if (!rules.ok) return { ...rules, vmOperationUncertain: true }
      if (net) {
        const retained = () => {
          const byId = inspectEgressNetwork(proxyId, runDocker, { strict: true, target: net.id })
          const byName = inspectEgressNetwork(proxyId, runDocker, { strict: true })
          if (
            byId?.id !== net.id ||
            byName?.id !== net.id ||
            !Object.keys(byId.containers || {}).length ||
            !Object.keys(byName.containers || {}).length
          )
            throw new Error('Attached egress network identity was not confirmed')
          return { ok: true, ended: stopped.ended, network_retained: true, ...(stopped.legacy ? { legacy: true } : {}) }
        }
        // Unbinding edits VM metadata; an idle container may intentionally remain
        // attached until its next recreation. Its network is not an active helper.
        if (Object.keys(net.containers || {}).length) return retained()
        const removed = runDocker(['network', 'rm', net.id])
        if (
          !removed.ok &&
          /^Error response from daemon: error while removing network: network [^\r\n]+ has active endpoints(?:[^\r\n]*)$/i.test(
            String(removed.stderr || '').trim(),
          )
        )
          return retained()
        if (
          inspectEgressNetwork(proxyId, runDocker, { strict: true, target: net.id }) ||
          inspectEgressNetwork(proxyId, runDocker, { strict: true })
        ) {
          throw new Error('Egress network removal was not confirmed')
        }
      }
      return { ok: true, ended: stopped.ended, ...(stopped.legacy ? { legacy: true } : {}) }
    } catch (error) {
      return egressOwnerUnknown(error)
    }
  })
}

export function slotNetworkForVm(vm, _env = process.env) {
  const id = vm?.proxy?.id
  if (!id) return ''
  return networkName(id)
}
