/**
 * Egress residue: what previous proxies leave behind, and how to prove it is gone.
 *
 * Deleting a proxy was never followed by a sweep, so every retired exit leaves a
 * docker network holding an address range forever. Measured on a dev host: 12
 * `kin-eg-*` networks, 11 with no containers, between them holding 6 ranges out of
 * docker's `172.17-172.31` /16 pool and 5 out of its `192.168.0.0/16` /20 pool.
 * That is the second cause of pool exhaustion, next to VM count.
 *
 * Residue comes in five classes. The last two matter most because the subnet
 * allocator cannot see them -- it reads docker and the host route table, neither of
 * which mentions an iptables chain or a stray bridge device:
 *
 *   network    kin-eg-<key> / kin-<id>-net holding a subnet
 *   rundir     data/run/egress/<key> holding a listen port pair
 *   container  the helper, under any of three naming generations
 *   iptables   KEG* chains and the FORWARD/INPUT rows that jump to them
 *   bridge     keg* devices left when a network removal did not finish
 *
 * Ownership is decided by label first (`kin.egress=1` plus `kin.egress.proxy` or
 * `kin.egress.vm`), name pattern second. Labels cover all three helper naming
 * generations at once, so a form nobody enumerated is still caught.
 *
 * Scanning is separate from acting, and `orphan` is separate from "delete me":
 * standalone sweeping only touches orphans, while a unified reprovision destroys
 * everything it finds. Callers inject the live proxy/VM ids, so this module needs
 * no database and can run as an inspection tool.
 */
import fs from 'node:fs'
import path from 'node:path'
import { LOCAL_EGRESS_ID, portFromListenSpec, proxyKey } from './egress.mjs'

export const RESIDUE_KINDS = ['network', 'rundir', 'container', 'iptables', 'bridge']

/** Networks this project owns. `kin-eg-<key>` is control-plane/local, `kin-<id>-net` is a node slot. */
const NETWORK_RE = /^(?:kin-eg-.+|kin-.+-net)$/
/** Three helper generations: control plane, node slot, and pre-1.3.88 node helpers. */
const CONTAINER_RE = /^(?:kin-cp-egress-.+|kin-.+-egress|kin-egress-.+)$/
const CHAIN_RE = /^KEG[A-Za-z0-9]+$/
const BRIDGE_RE = /^keg[A-Za-z0-9]+$/

const INSPECT_BATCH = 200
/** Separator that cannot appear in a docker name, subnet, bridge or label value. */
const FIELD = '\u0001'

const NETWORK_FORMAT = [
  '{{.Name}}',
  // Space-separated: a dual-stack network has an IPv6 entry too, and concatenating
  // them yields `172.90.27.0/24fd21:...::/64`, which parses as nothing.
  '{{range .IPAM.Config}}{{.Subnet}}={{.Gateway}} {{end}}',
  '{{index .Options "com.docker.network.bridge.name"}}',
  '{{len .Containers}}',
  '{{index .Labels "kin.egress.vm"}}',
  '{{index .Labels "kin.egress.proxy"}}',
].join(FIELD)

const CONTAINER_FORMAT = [
  '{{.Names}}',
  '{{.Label "kin.egress"}}',
  '{{.Label "kin.egress.proxy"}}',
  '{{.Label "kin.egress.vm"}}',
  '{{.State}}',
].join(FIELD)

function lines(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/**
 * First IPv4 `subnet=gateway` pair out of a dual-stack IPAM list. Docker templates
 * cannot filter by family, so all entries are emitted and the IPv6 ones dropped
 * here -- a concatenated `172.90.27.0/24fd21:...::/64` parses as nothing, which
 * would quietly keep a foreign range out of the conflict set.
 */
export function pickIpv4Config(blob) {
  for (const pair of String(blob || '').split(/\s+/)) {
    if (!pair) continue
    const [subnet, gateway] = pair.split('=')
    if (/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(String(subnet || ''))) {
      return { subnet, gateway: gateway || '' }
    }
  }
  return { subnet: '', gateway: '' }
}

function liveSets({ proxyIds = [], vmIds = [] } = {}) {
  return {
    proxies: new Set([...proxyIds].map((id) => String(id))),
    vms: new Set([...vmIds].map((id) => String(id))),
    proxyKeys: new Set([...proxyIds].map((id) => proxyKey(id))),
  }
}

/**
 * The folded local bridge is shared by every local row on the host and is never
 * residue, even with no container attached at the moment.
 */
export function isProtectedNetwork(name) {
  return String(name || '') === `kin-eg-${proxyKey(LOCAL_EGRESS_ID)}`
}

/** `kin-eg-<key>` → key; `kin-<id>-net` → null (that one is keyed by VM, not proxy). */
function proxyKeyOfNetwork(name) {
  const n = String(name || '')
  return n.startsWith('kin-eg-') ? n.slice('kin-eg-'.length) : null
}

export function scanNetworks({ runDocker, live = {} } = {}) {
  const l = liveSets(live)
  const ls = runDocker(['network', 'ls', '--format', '{{.Name}}'])
  if (!ls?.ok) return { ok: false, items: [] }
  const names = lines(ls.stdout).filter((n) => NETWORK_RE.test(n))
  const items = []
  let ok = true
  for (let i = 0; i < names.length; i += INSPECT_BATCH) {
    const batch = names.slice(i, i + INSPECT_BATCH)
    const r = runDocker(['network', 'inspect', '-f', NETWORK_FORMAT, ...batch])
    // A partial inventory must not be able to pass as clean.
    if (!r?.ok) {
      ok = false
      continue
    }
    for (const line of lines(r.stdout)) {
      const [name, ipam, bridge, count, labelVm, labelProxy] = line.split(FIELD)
      if (!name) continue
      const { subnet } = pickIpv4Config(ipam)
      const containers = Number(count) || 0
      const key = proxyKeyOfNetwork(name)
      const protected_ = isProtectedNetwork(name)
      // A label is the reliable owner; the name only tells us which family it is.
      const ownerLive =
        (labelVm && l.vms.has(labelVm)) ||
        (labelProxy && l.proxies.has(labelProxy)) ||
        (key !== null && l.proxyKeys.has(key))
      let reason = ''
      if (protected_) reason = 'protected: shared local bridge'
      else if (containers > 0) reason = `in use: ${containers} container(s) attached`
      else if (ownerLive) reason = 'owner still live'
      else reason = 'no container attached and owner not live'
      items.push({
        kind: 'network',
        name,
        subnet: subnet || '',
        bridge: bridge || '',
        containers,
        vm: labelVm || '',
        proxy: labelProxy || '',
        protected: protected_,
        orphan: !protected_ && containers === 0 && !ownerLive,
        reason,
      })
    }
  }
  return { ok, items }
}

/**
 * Run directories are a second state store that does not move with the networks,
 * so one can outlive the other in either direction. A directory whose network is
 * gone still claims its port pair, and ports have only 8000 slots.
 */
export function scanRunDirs({ projectRoot, networks = [], live = {} } = {}) {
  const base = path.join(String(projectRoot || ''), 'data', 'run', 'egress')
  let entries = []
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch (e) {
    // An absent tree is legitimately nothing; an unreadable one is not knowable.
    return { ok: e?.code === 'ENOENT', items: [] }
  }
  const l = liveSets(live)
  const haveNetwork = new Set(networks.map((n) => proxyKeyOfNetwork(n.name)).filter((k) => k !== null))
  const items = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const key = entry.name
    const dir = path.join(base, key)
    let cfg = null
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(dir, 'egress.json'), 'utf8'))
    } catch {
      cfg = null
    }
    const ports = [portFromListenSpec(cfg?.listen_tcp), portFromListenSpec(cfg?.listen_dns)].filter(Boolean)
    const networkPresent = haveNetwork.has(key)
    const ownerLive = l.proxyKeys.has(key) || (cfg?.proxy_id && l.proxies.has(String(cfg.proxy_id)))
    let reason = ''
    if (!cfg) reason = 'no readable egress.json'
    else if (!networkPresent) reason = 'no matching docker network'
    else if (!ownerLive) reason = 'owner not live'
    else reason = 'network present and owner live'
    items.push({
      kind: 'rundir',
      name: key,
      dir,
      proxy: String(cfg?.proxy_id || ''),
      ports,
      orphan: !cfg || !networkPresent || !ownerLive,
      reason,
    })
  }
  return { ok: true, items }
}

/**
 * Helpers run with `--network host`, so they never show up in a network's container
 * list and have to be scanned on their own.
 */
export function scanContainers({ runDocker, networks = [], live = {} } = {}) {
  const r = runDocker(['ps', '-a', '--format', CONTAINER_FORMAT])
  if (!r?.ok) return { ok: false, items: [] }
  const l = liveSets(live)
  const networkNames = new Set(networks.map((n) => n.name))
  const items = []
  for (const line of lines(r.stdout)) {
    const [name, labelEgress, labelProxy, labelVm, state] = line.split(FIELD)
    if (!name) continue
    // Label first; the name pattern only catches pre-label containers.
    const owned = labelEgress === '1' || CONTAINER_RE.test(name)
    if (!owned) continue
    const ownerLive = (labelVm && l.vms.has(labelVm)) || (labelProxy && l.proxies.has(labelProxy))
    // A node helper is named after its slot, so its network should still be there.
    const slotNetwork = name.endsWith('-egress') ? `${name.slice(0, -'-egress'.length)}-net` : ''
    const networkPresent = slotNetwork ? networkNames.has(slotNetwork) : true
    let reason = ''
    if (ownerLive) reason = 'owner still live'
    else if (!networkPresent) reason = `slot network ${slotNetwork} is gone`
    else reason = 'owner not live'
    items.push({
      kind: 'container',
      name,
      state: state || '',
      proxy: labelProxy || '',
      vm: labelVm || '',
      orphan: !ownerLive,
      reason,
    })
  }
  return { ok: true, items }
}

/**
 * Bridges belonging to networks that will still be there afterwards. A network that
 * is itself residue does not count: its chain and device have to go in the same
 * pass, or one sweep leaves exactly the half-cleanup state this module guards
 * against and only the next scan notices.
 */
function survivingBridges(networks) {
  return new Set(
    networks
      .filter((n) => !n.orphan)
      .map((n) => n.bridge)
      .filter(Boolean),
  )
}

/**
 * The allocator cannot see iptables. `stopProxyEgress` does call `removeIptables`,
 * but a helper that dies outside that path leaves its chain and the PREROUTING row
 * that jumps to it, so this has to be read from the live ruleset.
 *
 * `chainName` and `bridgeName` are built from the same tag and differ only in the
 * case of their prefix, so a chain maps back to exactly one bridge. That is what
 * lets a row mentioning only the chain still be judged.
 */
export function scanIptablesChains({ runIptables, networks = [] } = {}) {
  const expected = survivingBridges(networks)
  const byTag = new Map()
  let ok = true
  for (const table of ['nat', 'filter']) {
    const r = runIptables(['-t', table, '-S'])
    // Reading the ruleset needs root. Without it, "found nothing" would be a lie.
    if (!r?.ok) {
      ok = false
      continue
    }
    for (const line of lines(r.stdout)) {
      const parts = line.split(/\s+/)
      const chain = parts.find((p) => CHAIN_RE.test(p))
      const bridge = parts.find((p) => BRIDGE_RE.test(p))
      if (!chain && !bridge) continue
      const tag = chain ? chain.slice(3) : bridge.slice(3)
      const key = `${table}${FIELD}${tag}`
      let rec = byTag.get(key)
      if (!rec) {
        rec = {
          kind: 'iptables',
          name: `KEG${tag}`,
          table,
          chain: '',
          bridge: `keg${tag}`,
          rules: [],
          orphan: false,
          reason: '',
        }
        byTag.set(key, rec)
      }
      if (chain) rec.chain = chain
      rec.rules.push(line)
    }
  }
  const items = []
  for (const rec of byTag.values()) {
    rec.orphan = !expected.has(rec.bridge)
    rec.reason = rec.orphan ? `bridge ${rec.bridge} belongs to no network` : `bridge ${rec.bridge} still has a network`
    items.push(rec)
  }
  return { ok, items }
}

/** A `keg*` device outliving its network, left when a removal did not finish. */
export function scanBridges({ runIp, networks = [] } = {}) {
  const r = runIp(['-o', 'link', 'show'])
  if (!r?.ok) return { ok: false, items: [] }
  const expected = survivingBridges(networks)
  const items = []
  for (const line of lines(r.stdout)) {
    // `3: kegabc123: <BROADCAST,MULTICAST> mtu 1500 ...`
    const m = line.match(/^\d+:\s*([^:@\s]+)/)
    const dev = m?.[1]
    if (!dev || !BRIDGE_RE.test(dev)) continue
    const orphan = !expected.has(dev)
    items.push({
      kind: 'bridge',
      name: dev,
      orphan,
      reason: orphan ? 'no surviving docker network claims this bridge' : 'claimed by a live network',
    })
  }
  return { ok: true, items }
}

const KIND_FIELD = {
  network: 'networks',
  rundir: 'rundirs',
  container: 'containers',
  iptables: 'iptables',
  bridge: 'bridges',
}

/**
 * Full inventory. Networks are scanned first because the other four classes are
 * judged against them.
 *
 * `unavailable` lists the classes that could not be read -- a missing executor, or
 * an iptables ruleset that needs root. Keeping that separate from "found nothing"
 * is what stops an unreadable host from passing the cleanliness gate.
 */
export function scanResidue({ projectRoot = '', runDocker, runIptables, runIp, live = {} } = {}) {
  const unavailable = []
  const take = (kind, available, run) => {
    if (!available) {
      unavailable.push(kind)
      return []
    }
    const r = run()
    if (!r.ok) unavailable.push(kind)
    return r.items
  }

  const networks = take('network', typeof runDocker === 'function', () => scanNetworks({ runDocker, live }))
  return {
    networks,
    rundirs: take('rundir', true, () => scanRunDirs({ projectRoot, networks, live })),
    containers: take('container', typeof runDocker === 'function', () => scanContainers({ runDocker, networks, live })),
    iptables: take('iptables', typeof runIptables === 'function', () => scanIptablesChains({ runIptables, networks })),
    bridges: take('bridge', typeof runIp === 'function', () => scanBridges({ runIp, networks })),
    unavailable,
  }
}

export function residueItems(scan, { orphansOnly = true } = {}) {
  const out = []
  for (const kind of RESIDUE_KINDS) {
    for (const item of scan?.[KIND_FIELD[kind]] || []) {
      if (orphansOnly && !item.orphan) continue
      // The shared local bridge is never *residue*, so a standalone sweep leaves it
      // alone. A unified reprovision is a different job: it moves every exit onto
      // the current pool, and sparing this one would leave a range of the old pool
      // held for good, which is the thing the reprovision exists to undo.
      if (orphansOnly && item.protected) continue
      out.push(item)
    }
  }
  return out
}

/**
 * Clean means no orphan in any of the five classes **and** all five were actually
 * readable. A class that could not be scanned leaves the answer unknown, which is
 * not the same as clean.
 */
export function isClean(scan) {
  if (scan?.unavailable?.length) return false
  return residueItems(scan, { orphansOnly: true }).length === 0
}

/**
 * Per-item lines carrying what it is, what it holds and why it was judged so. A
 * bare boolean would make a passing check indistinguishable from a missed one.
 */
export function residueReport(scan, { orphansOnly = true } = {}) {
  const items = residueItems(scan, { orphansOnly })
  const unavailable = scan?.unavailable || []
  const detail = (i) => {
    if (i.kind === 'network') return [i.subnet && `subnet=${i.subnet}`, i.bridge && `bridge=${i.bridge}`]
    if (i.kind === 'rundir') return [i.ports?.length && `ports=${i.ports.join(',')}`]
    if (i.kind === 'container') return [i.state && `state=${i.state}`]
    if (i.kind === 'iptables') return [`table=${i.table}`, i.bridge && `bridge=${i.bridge}`]
    return []
  }
  return {
    clean: isClean(scan),
    unavailable,
    counts: Object.fromEntries(RESIDUE_KINDS.map((k) => [k, items.filter((i) => i.kind === k).length])),
    items,
    lines: [
      ...items.map((i) => [`${i.kind} ${i.name}`, ...detail(i).filter(Boolean), `(${i.reason})`].join('  ')),
      ...unavailable.map((k) => `${k}  (not readable -- cleanliness unknown for this class)`),
    ],
  }
}

/**
 * Removal order, by dependency rather than by preference:
 *
 *   container  a network cannot be removed while something sits on it
 *   iptables   a rule steers a bridge, so the rule goes before the device
 *   network    removing it normally takes its bridge along
 *   bridge     whatever survived a removal that did not finish
 *   rundir     plain files, and freeing them releases the claimed port pair
 */
const CLEANUP_ORDER = ['container', 'iptables', 'network', 'bridge', 'rundir']

/**
 * Argument lists needed to retire one iptables chain.
 *
 * Rules inside the chain need no individual delete because `-F` clears them, but
 * every rule that jumps into the chain from PREROUTING/FORWARD/INPUT has to go
 * first -- `-X` refuses to drop a chain that is still referenced.
 */
function iptablesSteps(item) {
  const steps = []
  let declared = false
  for (const rule of item.rules || []) {
    const parts = String(rule).trim().split(/\s+/)
    if (parts[0] === '-N') {
      declared = true
      continue
    }
    if (parts[0] !== '-A') continue
    // `-A KEGxxx ...` lives inside the chain; -F takes care of it.
    if (CHAIN_RE.test(parts[1])) continue
    steps.push(['-t', item.table, '-D', ...parts.slice(1)])
  }
  const chain = item.chain || item.name
  if ((declared || item.chain) && CHAIN_RE.test(chain)) {
    steps.push(['-t', item.table, '-F', chain])
    steps.push(['-t', item.table, '-X', chain])
  }
  return steps
}

/**
 * What it would take to clear a scan, in dependency order. Pure: it plans, it does
 * not act, so the same plan backs both the standalone sweep and the dry run.
 *
 * Scope is the egress layer only. A unified reprovision still has to detach and
 * stop the VM containers itself before handing their networks here, since those
 * are not egress resources and never appear in a scan.
 */
export function cleanupPlan(scan, { orphansOnly = true } = {}) {
  const items = residueItems(scan, { orphansOnly })
  const plan = []
  for (const kind of CLEANUP_ORDER) {
    for (const item of items.filter((i) => i.kind === kind)) {
      let steps = []
      if (kind === 'container') steps = [['rm', '-f', item.name]]
      else if (kind === 'iptables') steps = iptablesSteps(item)
      else if (kind === 'network') steps = [['network', 'rm', item.name]]
      else if (kind === 'bridge') steps = [['link', 'delete', item.name]]
      else if (kind === 'rundir') steps = [[item.dir]]
      if (!steps.length) continue
      plan.push({ kind, name: item.name, item, steps })
    }
  }
  return plan
}

/** One-line preview per planned action, for a dry run or a confirmation prompt. */
export function cleanupPlanLines(plan) {
  const render = (entry) =>
    entry.steps.map((s) => {
      if (entry.kind === 'container' || entry.kind === 'network') return `docker ${s.join(' ')}`
      if (entry.kind === 'iptables') return `iptables ${s.join(' ')}`
      if (entry.kind === 'bridge') return `ip ${s.join(' ')}`
      return `rm -rf ${s[0]}`
    })
  return plan.flatMap((entry) => render(entry).map((cmd) => `${entry.kind} ${entry.name}  ${cmd}`))
}

/**
 * Run a plan. `dryRun` reports exactly what would happen and touches nothing, which
 * is what the gate before a reprovision needs.
 *
 * Failures are collected and reported rather than thrown, so one stubborn network
 * does not strand the rest half-removed -- but they are never swallowed: a caller
 * that sees a non-empty `failed` must not treat the host as clean.
 */
export function executeCleanup(plan, { runDocker, runIptables, runIp, removeDir, dryRun = true } = {}) {
  const done = []
  const failed = []
  const rmdir =
    removeDir ||
    ((dir) => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

  for (const entry of plan) {
    if (dryRun) {
      done.push({ kind: entry.kind, name: entry.name, dryRun: true })
      continue
    }
    const errors = []
    for (const step of entry.steps) {
      try {
        if (entry.kind === 'rundir') {
          rmdir(step[0])
          continue
        }
        const run = entry.kind === 'iptables' ? runIptables : entry.kind === 'bridge' ? runIp : runDocker
        if (typeof run !== 'function') {
          errors.push(`no executor for ${entry.kind}`)
          continue
        }
        const r = run(step)
        // Already absent is the desired state, not a failure. Removing a network
        // takes its bridge along, so the later `ip link delete` normally finds
        // nothing -- that is success, phrased by the tool as an error.
        const benign = /No chain\/target\/match|does not exist|No such|not found|Cannot find device/i
        if (!r?.ok && !benign.test(String(r?.stderr || ''))) {
          errors.push(
            String(r?.stderr || `${entry.kind} step failed`)
              .trim()
              .slice(0, 200),
          )
        }
      } catch (e) {
        errors.push(String(e?.message || e).slice(0, 200))
      }
    }
    if (errors.length) failed.push({ kind: entry.kind, name: entry.name, errors })
    else done.push({ kind: entry.kind, name: entry.name })
  }
  return { dryRun, done, failed }
}
