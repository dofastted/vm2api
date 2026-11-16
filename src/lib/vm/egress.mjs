/**
 * Remote SOCKS5: one docker net per proxy, kin-egress REDIRECTs that bridge.
 * Local egress (`px-local` / scheme=local) is the host default route. Do not
 * start kin-egress and do not treat a missing helper as "no proxy".
 * Slot start still attaches a masquerade net so the container is not on a
 * redirected SOCKS bridge.
 */
import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDb, isDbOpen } from '../db/database.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { toHostPath } from './host-path.mjs'
import { socksProxyUrl } from './socks-address.mjs'
import { assertProxyAllowed, proxyBlockedReason } from './proxy-policy.mjs'

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
  if (!prefix.length) return args
  return ['docker', 'run', '--rm', '--network', 'host', '--pid', 'host', '--privileged', 'nicolaka/netshoot', ...args]
}

function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  const probe = pidNamespaceCommand(['sh', '-c', `kill -0 ${n} 2>/dev/null`])
  return sh(probe).ok
}

function readPid(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim())
  } catch {
    return 0
  }
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

function processExeDeleted(pid) {
  const probe = pidNamespaceCommand(['sh', '-c', `readlink /proc/${Number(pid)}/exe 2>/dev/null`])
  const result = sh(probe)
  return (
    result.ok &&
    String(result.stdout || '')
      .trim()
      .endsWith(' (deleted)')
  )
}

function ownsEgressProcess(pid, configPath, { allowDeleted = false } = {}) {
  if (!pidAlive(pid)) return false
  // A replaced binary keeps the old inode in this process. Reusing it leaves
  // the new file unrun and its listen port permanently busy.
  if (!allowDeleted && processExeDeleted(pid)) return false
  const args = processText(pid, 'cmdline').split('\0').filter(Boolean)
  const configIndex = args.indexOf('-config')
  if (configIndex < 0 || !args[configIndex + 1]) return false
  const command = args.find((arg) => path.basename(String(arg || '')).startsWith('kin-egress'))
  if (!command) return false
  const argument = args[configIndex + 1]
  return (
    path.basename(argument) === path.basename(configPath) && argument.includes(path.basename(path.dirname(configPath)))
  )
}

function egressProcessPids() {
  const probe = pidNamespaceCommand([
    'sh',
    '-c',
    // The loop's status is the last /proc entry's grep; end with true so a non-matching tail is not a failed scan.
    'for dir in /proc/[1-9]*; do tr "\\0" " " < "$dir/cmdline" 2>/dev/null | grep -q kin-egress && basename "$dir"; done; true',
  ])
  const result = sh(probe)
  if (!result.ok) return []
  return result.stdout
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0)
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

const DOCKER_SOCK = '/var/run/docker.sock'
const EGRESS_CONTAINER_CFG_DIR = '/etc/kin-egress'
const EGRESS_CONTAINER_BIN_DIR = '/opt/kin-egress-bin'

/**
 * Where a control-plane kin-egress runs.
 *
 * `process`: a detached child of this Node process. Inside the vm2api container
 * that child still lives in the container's cgroup, so every `docker restart
 * vm2api` (deploy, upgrade, crash) killed every helper. Each SOCKS slot then had
 * no DNS and no TCP until a probe or the watchdog respawned it, and requests on
 * those slots failed with EAI_AGAIN.
 *
 * `container`: each helper is its own host-network container with a restart
 * policy, so it outlives control-plane restarts and the existing reuse path
 * keeps it. Chosen automatically when the control plane runs in Docker (the
 * compose file sets VM2API_CONTAINER_NAME and mounts the socket);
 * KIN_EGRESS_RUNTIME=process|container overrides.
 */
export function egressRuntime(env = process.env, sockExists = () => fs.existsSync(DOCKER_SOCK)) {
  const forced = String(env?.KIN_EGRESS_RUNTIME || '')
    .trim()
    .toLowerCase()
  if (forced === 'container' || forced === 'process') return forced
  return String(env?.VM2API_CONTAINER_NAME || '').trim() && sockExists() ? 'container' : 'process'
}

/** Control-plane helper container; `kin-egress-<key>` is taken by pre-1.3.88 node helpers. */
export function egressContainerName(proxyId) {
  return `kin-cp-egress-${proxyKey(proxyId)}`
}

/**
 * docker run argv for one helper. The digest covers everything that needs a new
 * container: config body, mounts and the binary on disk (an upgrade swaps it).
 * The image only supplies a root filesystem for the static binary, so it stays
 * out of the digest: a control-plane image bump must not cut every slot's exit.
 * `platform` pins the native image: the ARM64 control plane exports
 * DOCKER_DEFAULT_PLATFORM=linux/amd64 for slots, which `docker run` would inherit.
 */
export function egressContainerSpec({
  proxyId,
  body,
  hostDir,
  hostBinDir,
  binName,
  image,
  binFingerprint = '',
  platform = nativeDockerPlatform(),
}) {
  const name = egressContainerName(proxyId)
  const digest = crypto
    .createHash('sha256')
    .update([body, hostDir, hostBinDir, binName, binFingerprint].map(String).join('\0'))
    .digest('hex')
    .slice(0, 16)
  const args = [
    'run',
    '-d',
    '--name',
    name,
    '--network',
    'host',
    '--restart',
    'unless-stopped',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    // Same uid as the control plane that wrote the 0600 config; no capabilities.
    '--user',
    '0:0',
    '--log-driver',
    'local',
    '--log-opt',
    'max-size=10m',
    '--label',
    'kin.egress=1',
    '--label',
    'kin.egress.local=1',
    '--label',
    `kin.egress.proxy=${proxyId}`,
    '--label',
    `kin.egress.cfg=${digest}`,
    '--label',
    `kin.egress.bin=${binFingerprint}`,
    ...(platform ? ['--platform', platform] : []),
    '-v',
    `${hostDir}:${EGRESS_CONTAINER_CFG_DIR}:ro`,
    '-v',
    `${hostBinDir}:${EGRESS_CONTAINER_BIN_DIR}:ro`,
    '--entrypoint',
    `${EGRESS_CONTAINER_BIN_DIR}/${binName}`,
    image,
    '-config',
    `${EGRESS_CONTAINER_CFG_DIR}/egress.json`,
  ]
  return { name, digest, args }
}

/** Docker platform of this control plane; the helper image and binary are native to it. */
export function nativeDockerPlatform(arch = process.arch) {
  const name = { x64: 'amd64', arm64: 'arm64' }[arch]
  return name ? `linux/${name}` : ''
}

const binFingerprintCache = new Map()

/**
 * Content hash of the helper binary. The entrypoint re-copies bin/ on every start,
 * so size and mtime change on a plain restart; only the bytes mean an upgrade.
 * Cached per stat so the per-probe inspect path hashes once per binary swap.
 */
export function egressBinFingerprint(bin) {
  let st
  try {
    st = fs.statSync(bin)
  } catch {
    return ''
  }
  const key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`
  const cached = binFingerprintCache.get(bin)
  if (cached?.key === key) return cached.value
  let value
  try {
    value = crypto.createHash('sha256').update(fs.readFileSync(bin)).digest('hex').slice(0, 16)
  } catch {
    return ''
  }
  binFingerprintCache.set(bin, { key, value })
  return value
}

/** null when the container does not exist. */
export function inspectEgressContainer(name, runDocker = docker) {
  const format =
    '{{.State.Running}}|{{.State.Restarting}}|{{.State.Pid}}|{{index .Config.Labels "kin.egress.cfg"}}|{{index .Config.Labels "kin.egress.bin"}}'
  const r = runDocker(['inspect', '-f', format, name])
  if (!r.ok) return null
  const [running, restarting, pid, digest, bin] = String(r.stdout || '')
    .trim()
    .split('|')
  return {
    name,
    running: running === 'true',
    restarting: restarting === 'true',
    pid: Number(pid) || 0,
    digest: String(digest || '').trim(),
    bin: String(bin || '').trim(),
  }
}

/** A crash loop reports Running too; only a settled helper counts. */
function egressContainerHealthy(info) {
  return !!(info?.running && !info.restarting)
}

let selfImageCache = ''

function selfImage(runDocker, env = process.env) {
  if (selfImageCache) return selfImageCache
  const name = String(env?.VM2API_CONTAINER_NAME || '').trim() || 'vm2api'
  const r = runDocker(['inspect', '-f', '{{.Image}}', name])
  if (r.ok && r.stdout) selfImageCache = String(r.stdout).trim()
  return selfImageCache
}

async function startEgressContainer({
  projectRoot,
  proxyId,
  cfg,
  tcpPort,
  dnsPort,
  listenHost,
  bin,
  runDocker,
  hostPath,
  image,
}) {
  const dir = egressRunDir(projectRoot, proxyId)
  const cfgPath = path.join(dir, 'egress.json')
  const binFingerprint = egressBinFingerprint(bin)
  if (!binFingerprint) return { ok: false, error: `kin-egress binary not found: ${bin}` }
  const imageRef = image || selfImage(runDocker)
  if (!imageRef) return { ok: false, error: 'egress_image_unknown' }
  const body = `${JSON.stringify(cfg, null, 2)}\n`
  const spec = egressContainerSpec({
    proxyId,
    body,
    hostDir: hostPath(dir),
    hostBinDir: hostPath(path.dirname(bin)),
    binName: path.basename(bin),
    image: imageRef,
    binFingerprint,
  })
  const done = (reused) => ({
    ok: true,
    pid: 0,
    reused,
    configPath: cfgPath,
    container: spec.name,
    listen_tcp: cfg.listen_tcp,
  })
  const existing = inspectEgressContainer(spec.name, runDocker)
  if (egressContainerHealthy(existing) && existing.digest === spec.digest && fs.existsSync(cfgPath)) return done(true)
  // A helper spawned by an older control plane (process runtime) still holds the ports.
  for (const pid of egressPidsForProxyConfig(projectRoot, proxyId)) {
    const stopped = await stopOwnedEgress(pid)
    if (!stopped.ok) return { ok: false, error: stopped.error, pid }
  }
  fs.rmSync(path.join(dir, 'egress.pid'), { force: true })
  if (existing) {
    const removed = runDocker(['rm', '-f', spec.name])
    if (!removed.ok && !/no such container/i.test(removed.stderr || '')) {
      return { ok: false, error: `egress_container_remove_failed: ${removed.stderr || 'docker rm failed'}` }
    }
  }
  for (const port of [tcpPort, dnsPort]) {
    if (!(port > 0)) continue
    const free = await waitPortReleased(listenHost, port)
    if (!free.ok) return { ok: false, error: free.error, port }
  }
  fs.writeFileSync(cfgPath, body, { mode: 0o600 })
  const created = runDocker(spec.args, 60_000)
  if (!created.ok) return { ok: false, error: `egress_container_failed: ${created.stderr || 'docker run failed'}` }
  // Readiness is the caller's waitListen; this process cannot see the helper's PID, so none is returned.
  return done(false)
}

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
  runtime = egressRuntime(),
  runDocker = docker,
  hostPath = (p) => toHostPath(p, { projectRoot }),
  image = '',
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
  if (runtime === 'container') {
    const cfg = { proxy_id: proxyId, proxy_url: proxyUrl, listen_tcp: listenTcp, listen_dns: listenDns }
    if (dnsUpstream) cfg.dns_upstream = dnsUpstream
    if (dnsEmptyTypes.length) cfg.dns_empty_types = dnsEmptyTypes
    if (domainForward) cfg.domain_forward = true
    return startEgressContainer({
      projectRoot,
      proxyId,
      cfg,
      tcpPort,
      dnsPort,
      listenHost,
      bin,
      runDocker,
      hostPath,
      image,
    })
  }
  const existing = readPid(pidFile)
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
    } catch {}
  }
  const portOwner = listenerPid(tcpPort)
  if (portOwner && !ownsEgressProcess(portOwner, cfgPath, { allowDeleted: true })) {
    return { ok: false, error: 'egress_port_busy', pid: portOwner }
  }
  const superseded = [
    ...new Set([...(configMatches ? [existing] : []), ...staleEgressPids(cfgPath), portOwner].filter(Boolean)),
  ]
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
  // Port 0 is ephemeral: no fixed port to resolve a listener from, so the spawned helper is the owner.
  const realPid = tcpPort > 0 ? await waitForListenerPid(listenHost, tcpPort) : spawned.pid
  if (!realPid) return { ok: false, error: `kin-egress ${listenTcp} did not listen` }
  fs.writeFileSync(pidFile, String(realPid) + '\n', { mode: 0o600 })
  return { ok: true, pid: realPid, reused: false, configPath: cfgPath, listen_tcp: listenTcp }
}

export function stopEgressProcess(projectRoot, proxyId, { runtime = egressRuntime(), runDocker = docker } = {}) {
  const dir = egressRunDir(projectRoot, proxyId)
  const pidFile = path.join(dir, 'egress.pid')
  const cfgPath = path.join(dir, 'egress.json')
  if (runtime === 'container') {
    const removed = runDocker(['rm', '-f', egressContainerName(proxyId)])
    if (!removed.ok && !/no such container/i.test(removed.stderr || ''))
      return { ok: false, error: 'egress_stop_failed' }
    // Fall through: a process-runtime helper from an older control plane may still run.
  }
  const pids = [...new Set(egressPidsForProxyConfig(projectRoot, proxyId))]
  const pending = []
  for (const pid of pids) {
    const signaled = sh(pidNamespaceCommand(['sh', '-c', `kill -TERM ${Number(pid)} 2>/dev/null`]))
    if (!signaled.ok && pidAlive(pid)) return { ok: false, error: 'egress_stop_failed' }
    if (ownsEgressProcess(pid, cfgPath, { allowDeleted: true })) pending.push(pid)
  }
  if (pending.length) return { ok: true, pending }
  try {
    fs.rmSync(pidFile, { force: true })
  } catch (error) {
    return { ok: false, error: `egress_pid_cleanup_failed: ${error.code || error.message}` }
  }
  return { ok: true, pending }
}

async function stopOwnedEgress(pid) {
  const signaled = sh(pidNamespaceCommand(['sh', '-c', `kill -TERM ${Number(pid)} 2>/dev/null`]))
  if (!signaled.ok && pidAlive(pid)) return { ok: false, error: 'egress_stop_failed' }
  return waitEgressExit(pid)
}

export function inspectEgressProcess(
  projectRoot,
  proxyId,
  { runtime = egressRuntime(), runDocker = docker, bin = EGRESS_BIN } = {},
) {
  if (runtime === 'container') {
    const container = egressContainerName(proxyId)
    const info = inspectEgressContainer(container, runDocker)
    if (!egressContainerHealthy(info)) return { ok: false, pid: info?.pid || null, reason: 'not_running', container }
    // A surviving helper keeps executing the replaced inode; report it down so probe and watchdog repair it,
    // as the process runtime does for a deleted executable.
    const current = egressBinFingerprint(bin)
    if (info.bin && current && info.bin !== current)
      return { ok: false, pid: info.pid, reason: 'stale_binary', container }
    return { ok: true, pid: info.pid, listen_tcp: readEgressListenTcp(projectRoot, proxyId), container }
  }
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
  const killed = sh(pidNamespaceCommand(['sh', '-c', `kill -KILL ${Number(pid)} 2>/dev/null`]))
  if (!killed.ok && pidAlive(pid)) return { ok: false, error: 'egress_kill_failed', pid }
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
  return runExclusiveProxyEgress(projectRoot, proxy?.id, () => startProxyEgress(projectRoot, proxy, opts))
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
    runDocker,
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
