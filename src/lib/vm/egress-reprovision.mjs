/**
 * Unified egress reprovision: tear every exit down and rebuild it on the current
 * pool, with gates in front so a destructive pass cannot start blind.
 *
 * Retiring a network cannot be undone, but the subnet a snapshot records can be
 * handed out again, producing an equivalent network. So rollback and rebuild are
 * one code path differing only in where target subnets come from -- which means
 * rollback is exercised by the same tests as the forward pass, instead of being
 * code that first runs on the day something breaks.
 *
 * Four gates, each independently checkable, none vouching for the one before it:
 *
 *   1 cleanup     clearing works (egress-residue.mjs)
 *   2 verify      cleanliness is provable, not assumed (egress-residue.mjs)
 *   3 dry run     a plan exists, is feasible, and is still current
 *   4 rebuild     only with 2 and 3 passed and the plan unexpired
 *
 * Runtime order differs from that: a topology snapshot has to land before any
 * destructive step, because it is the only thing that makes rollback possible.
 *
 * Scope is the egress layer plus the containers sitting on its networks. Helper
 * rebuild is delegated through `ensureEgress`, since the control plane holds the
 * binary paths, proxy records and credentials this module has no business knowing.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { portFromListenSpec } from './egress.mjs'
import {
  cleanupPlan,
  executeCleanup,
  isClean,
  isProtectedNetwork,
  pickIpv4Config,
  residueReport,
  scanResidue,
} from './egress-residue.mjs'
import {
  collectTakenSubnets,
  createSubnetAllocator,
  gatewayOf,
  overlaps,
  parseCidr,
  subnetPoolConfig,
} from './subnet-pool.mjs'

/** Separator that cannot appear in a docker name, subnet, bridge or label value. */
const FIELD = '\u0001'
const INSPECT_BATCH = 200

/**
 * Prefix for the folded local bridge. Every local-exit VM on a host shares it, so
 * it needs room for many containers rather than the gateway-plus-one a per-VM
 * SOCKS network needs. /20 matches what these bridges hold today (4094 addresses).
 */
export const DEFAULT_SHARED_PREFIX = 20

const TOPOLOGY_FORMAT = [
  '{{.Name}}',
  // Space-separated pairs: a dual-stack network carries an IPv6 entry too, and
  // concatenating them yields a string that parses as no subnet at all.
  '{{range .IPAM.Config}}{{.Subnet}}={{.Gateway}} {{end}}',
  '{{index .Options "com.docker.network.bridge.name"}}',
  '{{index .Options "com.docker.network.bridge.enable_ip_masquerade"}}',
  '{{index .Labels "kin.egress.vm"}}',
  '{{index .Labels "kin.egress.proxy"}}',
  '{{range $k,$v := .Containers}}{{$v.Name}}={{$v.IPv4Address}},{{end}}',
].join(FIELD)

function lines(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

function parseContainers(blob) {
  return String(blob || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const at = pair.lastIndexOf('=')
      const name = at >= 0 ? pair.slice(0, at) : pair
      const ip = at >= 0 ? pair.slice(at + 1) : ''
      return { name, ip: ip.split('/')[0] || '' }
    })
}

export function reprovisionDir(projectRoot, stamp) {
  return path.join(String(projectRoot || ''), 'data', 'run', 'reprovision', String(stamp))
}

/**
 * Everything needed to put the exits back: which network held which container at
 * which address, and which port pair each helper was started with.
 *
 * Captured from docker and the filesystem rather than from any database, so it
 * reflects what is actually there, including whatever drifted.
 */
export function captureTopology({ projectRoot = '', runDocker, host = 'control-plane' } = {}) {
  const networks = []
  const ok = { networks: false, egress: true }
  if (typeof runDocker === 'function') {
    const ls = runDocker(['network', 'ls', '--format', '{{.Name}}'])
    if (ls?.ok) {
      const names = lines(ls.stdout).filter((n) => /^(?:kin-eg-.+|kin-.+-net)$/.test(n))
      ok.networks = true
      for (let i = 0; i < names.length; i += INSPECT_BATCH) {
        const r = runDocker(['network', 'inspect', '-f', TOPOLOGY_FORMAT, ...names.slice(i, i + INSPECT_BATCH)])
        if (!r?.ok) {
          ok.networks = false
          continue
        }
        for (const line of lines(r.stdout)) {
          const [name, ipam, bridge, masq, vm, proxy, containers] = line.split(FIELD)
          if (!name) continue
          const { subnet, gateway } = pickIpv4Config(ipam)
          networks.push({
            name,
            subnet: subnet || '',
            gateway: gateway || '',
            bridge: bridge || '',
            masquerade: masq === 'true',
            vm: vm || '',
            proxy: proxy || '',
            containers: parseContainers(containers),
          })
        }
      }
    }
  }

  const egress = []
  const base = path.join(String(projectRoot || ''), 'data', 'run', 'egress')
  let entries = []
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch (e) {
    if (e?.code !== 'ENOENT') ok.egress = false
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(base, entry.name)
    let cfg = null
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(dir, 'egress.json'), 'utf8'))
    } catch {
      cfg = null
    }
    egress.push({
      key: entry.name,
      dir,
      proxy_id: String(cfg?.proxy_id || ''),
      listen_tcp: String(cfg?.listen_tcp || ''),
      listen_dns: String(cfg?.listen_dns || ''),
      tcp: portFromListenSpec(cfg?.listen_tcp),
      dns: portFromListenSpec(cfg?.listen_dns),
    })
  }

  // One row per thing that has to come back, which is what the rebuild iterates.
  const bindings = networks.map((n) => {
    const key = n.name.startsWith('kin-eg-') ? n.name.slice('kin-eg-'.length) : ''
    const cfg = egress.find((e) => e.key === key)
    return {
      network: n.name,
      subnet: n.subnet,
      proxy_id: n.proxy || (key ? key : ''),
      vm_id: n.vm || '',
      masquerade: n.masquerade,
      containers: n.containers.map((c) => c.name),
      tcp: cfg?.tcp || 0,
      dns: cfg?.dns || 0,
    }
  })

  return { host, capturedAt: new Date().toISOString(), complete: ok.networks && ok.egress, networks, egress, bindings }
}

/**
 * Stable digest of the parts a plan depends on. Compared before a rebuild so a
 * plan made against a topology that has since moved is refused rather than
 * applied -- this repository is worked on concurrently, so that window is real.
 */
export function topologyFingerprint(topology) {
  const shape = [
    ...(topology?.networks || [])
      .map((n) =>
        [
          n.name,
          n.subnet,
          n.bridge,
          (n.containers || [])
            .map((c) => c.name)
            .sort()
            .join('|'),
        ].join(FIELD),
      )
      .sort(),
    ...(topology?.egress || []).map((e) => [e.key, e.tcp, e.dns].join(FIELD)).sort(),
  ].join('\n')
  return crypto.createHash('sha256').update(shape).digest('hex').slice(0, 32)
}

/** Networks a rebuild is responsible for putting back, protected ones included. */
function rebuildTargets(topology) {
  return (topology?.networks || []).map((n) => ({
    name: n.name,
    previousSubnet: n.subnet,
    bridge: n.bridge,
    masquerade: n.masquerade,
    proxy_id: n.proxy || (n.name.startsWith('kin-eg-') ? n.name.slice('kin-eg-'.length) : ''),
    vm_id: n.vm || '',
    containers: (n.containers || []).map((c) => c.name),
  }))
}

/**
 * Whether a rebuild may be attempted at all. Each check carries its own verdict
 * and detail, so a refusal says which gate it failed instead of just "no".
 *
 * Writability is deliberately not claimed: probing it would mean changing
 * something, which a dry run must not do. Read access is checked and the limit is
 * stated, rather than pretending the stronger thing was verified.
 */
export function feasibility({
  topology,
  scan,
  projectRoot = '',
  runDocker,
  runIptables,
  runIp,
  pool,
  prefix,
  sharedPrefix = DEFAULT_SHARED_PREFIX,
  reserved = [],
} = {}) {
  const cfg = subnetPoolConfig()
  const poolCidr = pool || cfg.pool
  const poolPrefix = prefix || cfg.prefix
  const checks = []
  const add = (name, pass, detail) => checks.push({ name, pass, detail })

  // Networks about to be removed do not conflict with themselves.
  const doomed = new Set((topology?.networks || []).map((n) => n.subnet).filter(Boolean))
  const taken = collectTakenSubnets({ runDocker, runIp }).filter((c) => {
    const text = `${c.network}/${c.prefix}`
    return ![...doomed].some((d) => {
      const dc = parseCidr(d)
      return dc && dc.network === c.network && dc.prefix === c.prefix && text
    })
  })

  const parsedPool = parseCidr(poolCidr)
  const conflicts = parsedPool ? taken.filter((c) => overlaps(c, parsedPool)) : []
  add(
    'no_pool_conflict',
    !!parsedPool && conflicts.length === 0,
    parsedPool
      ? conflicts.length
        ? `${conflicts.length} range(s) already inside ${poolCidr}; pick another pool`
        : `${poolCidr} is free of host routes and foreign networks`
      : `pool ${poolCidr} is not a valid cidr`,
  )

  // Shared and per-VM networks draw different prefixes, so capacity is checked
  // against both: one /20 block for the folded local bridge swallows many /28 slots.
  const targets = rebuildTargets(topology)
  const needShared = targets.filter((t) => isProtectedNetwork(t.name)).length
  const needPerVm = targets.length - needShared
  let capacity = { total: 0, used: 0, sharedTotal: 0, sharedUsed: 0 }
  const sharedSubnets = []
  try {
    // Built only when a shared network is actually in the rebuild: a pool narrower
    // than the shared prefix is irrelevant when there is nothing shared to place.
    if (needShared > 0) {
      const sharedAlloc = createSubnetAllocator({
        pool: poolCidr,
        prefix: sharedPrefix,
        taken: [...taken, ...reserved],
      })
      capacity.sharedTotal = sharedAlloc.total
      capacity.sharedUsed = sharedAlloc.used
      for (const t of targets.filter((x) => isProtectedNetwork(x.name))) {
        sharedSubnets.push(sharedAlloc.allocate(t.name))
      }
    }
    const vmAlloc = createSubnetAllocator({
      pool: poolCidr,
      prefix: poolPrefix,
      taken: [...taken, ...reserved, ...sharedSubnets],
    })
    capacity.total = vmAlloc.total
    capacity.used = vmAlloc.used
  } catch (e) {
    capacity = { ...capacity, error: String(e?.message || e) }
  }
  const free = Math.max(0, capacity.total - capacity.used)
  const freeShared = Math.max(0, capacity.sharedTotal - capacity.sharedUsed)
  add(
    'capacity',
    !capacity.error && free >= needPerVm && freeShared >= needShared,
    capacity.error
      ? `cannot size ${poolCidr}: ${capacity.error}`
      : `${needPerVm} per-VM network(s), ${free} of ${capacity.total} /${poolPrefix} slot(s) free` +
          (needShared ? `; ${needShared} shared, ${freeShared} of ${capacity.sharedTotal} /${sharedPrefix} free` : '') +
          ` in ${poolCidr}`,
  )

  const readable = []
  const unreadable = []
  for (const [label, run, args] of [
    ['docker', runDocker, ['network', 'ls', '--format', '{{.Name}}']],
    ['iptables', runIptables, ['-t', 'nat', '-S']],
    ['ip', runIp, ['-o', 'link', 'show']],
  ]) {
    if (typeof run !== 'function') {
      unreadable.push(`${label} (no executor)`)
      continue
    }
    const r = run(args)
    if (r?.ok) readable.push(label)
    else unreadable.push(label)
  }
  add(
    'privileges',
    unreadable.length === 0,
    unreadable.length
      ? `cannot read: ${unreadable.join(', ')} -- iptables and link changes need root`
      : `readable: ${readable.join(', ')} (write access is only proven at execution time)`,
  )

  const pending = pendingSnapshots(projectRoot)
  add(
    'no_pending_reprovision',
    pending.length === 0,
    pending.length ? `unfinished reprovision at ${pending.join(', ')}; roll back or abandon it first` : 'none',
  )

  add(
    'topology_complete',
    topology?.complete === true,
    topology?.complete ? 'captured in full' : 'topology capture was incomplete; refusing to plan against it',
  )

  // A dirty host is allowed -- clearing it is the point -- but an unreadable class
  // means the teardown cannot be confirmed afterwards.
  const unknown = scan?.unavailable || []
  add(
    'residue_knowable',
    unknown.length === 0,
    unknown.length ? `cleanliness unknown for: ${unknown.join(', ')}` : 'all five residue classes readable',
  )

  return { ok: checks.every((c) => c.pass), checks, pool: poolCidr, prefix: poolPrefix, capacity }
}

/**
 * A full plan: what gets torn down, then what gets built, with the target subnets
 * already chosen. `target` picks where those come from -- the pool for a forward
 * pass, the snapshot for a rollback.
 *
 * Shared and per-VM networks get different prefixes. A SOCKS exit holds a gateway
 * and one slot container, so /28 is generous. The folded local bridge is shared by
 * every local-exit VM on the host -- it sits on a /20 today -- so handing it a /28
 * would cut that host's local capacity from 4094 addresses to 14. The shared range
 * is allocated first and reserved against the per-VM allocator, since one /20 block
 * covers many /28 slots.
 */
export function reprovisionPlan({
  topology,
  scan,
  target = 'pool',
  pool,
  prefix,
  sharedPrefix = DEFAULT_SHARED_PREFIX,
  runDocker,
  runIp,
  reserved = [],
} = {}) {
  const cfg = subnetPoolConfig()
  const poolCidr = pool || cfg.pool
  const poolPrefix = prefix || cfg.prefix
  const targets = rebuildTargets(topology)

  const teardown = scan ? cleanupPlan(scan, { orphansOnly: false }) : []
  const stopContainers = [...new Set(targets.flatMap((t) => t.containers))]

  const entry = (t, subnet) => ({
    network: t.name,
    subnet,
    gateway: gatewayOf(subnet),
    bridge: t.bridge,
    masquerade: t.masquerade,
    shared: isProtectedNetwork(t.name),
    proxy_id: t.proxy_id,
    vm_id: t.vm_id,
    containers: t.containers,
  })

  let build = []
  if (target === 'snapshot') {
    build = targets.map((t) => entry(t, t.previousSubnet))
  } else {
    const doomed = new Set(targets.map((t) => t.previousSubnet).filter(Boolean))
    const taken = collectTakenSubnets({ runDocker, runIp }).filter((c) => {
      return ![...doomed].some((d) => {
        const dc = parseCidr(d)
        return dc && dc.network === c.network && dc.prefix === c.prefix
      })
    })
    const shared = targets.filter((t) => isProtectedNetwork(t.name))
    const perVm = targets.filter((t) => !isProtectedNetwork(t.name))

    const sharedAlloc = createSubnetAllocator({
      pool: poolCidr,
      prefix: sharedPrefix,
      taken: [...taken, ...reserved],
    })
    const sharedBuild = shared.map((t) => entry(t, sharedAlloc.allocate(t.name)))

    const vmAlloc = createSubnetAllocator({
      pool: poolCidr,
      prefix: poolPrefix,
      taken: [...taken, ...reserved, ...sharedBuild.map((b) => b.subnet)],
    })
    build = [...sharedBuild, ...perVm.map((t) => entry(t, vmAlloc.allocate(t.name)))]
  }

  return {
    target,
    pool: poolCidr,
    prefix: poolPrefix,
    sharedPrefix,
    fingerprint: topologyFingerprint(topology),
    stopContainers,
    teardown,
    build,
  }
}

/** One line per step, in execution order, for a dry run or a confirmation prompt. */
export function reprovisionPlanLines(plan) {
  return [
    ...plan.stopContainers.map((c) => `stop       docker stop ${c}`),
    ...plan.teardown.flatMap((t) =>
      t.steps.map((s) => {
        if (t.kind === 'container' || t.kind === 'network') return `teardown   docker ${s.join(' ')}`
        if (t.kind === 'iptables') return `teardown   iptables ${s.join(' ')}`
        if (t.kind === 'bridge') return `teardown   ip ${s.join(' ')}`
        return `teardown   rm -rf ${s[0]}`
      }),
    ),
    ...plan.build.map(
      (b) => `build      docker network create --subnet ${b.subnet} --gateway ${b.gateway} ${b.network}`,
    ),
    ...plan.build.flatMap((b) => b.containers.map((c) => `start      docker start ${c}`)),
  ]
}

/** Rough outage estimate, so a dry run can say how long the exits will be down. */
export function estimateOutageSeconds(plan, { perContainer = 4, perNetwork = 1 } = {}) {
  return plan.stopContainers.length * perContainer + plan.build.length * perNetwork
}

export function pendingSnapshots(projectRoot) {
  const base = path.join(String(projectRoot || ''), 'data', 'run', 'reprovision')
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !fs.existsSync(path.join(base, e.name, 'done')))
      .map((e) => path.join(base, e.name))
      .sort()
  } catch {
    return []
  }
}

/**
 * Snapshot and plan land together, before anything is touched.
 *
 * The directory name must be unique even for two runs in the same millisecond --
 * a rollback fired straight after a failed pass is exactly that case, and a
 * collision would overwrite the topology the rollback depends on.
 */
export function writeSnapshot(options = {}) {
  const { projectRoot, topology, plan } = options
  // An explicit stamp is a caller naming the directory; only generated stamps get
  // a collision suffix.
  const named = options.stamp !== undefined
  const base = reprovisionDir(projectRoot, named ? options.stamp : Date.now())
  fs.mkdirSync(path.dirname(base), { recursive: true })
  let dir = base
  if (named) {
    fs.mkdirSync(dir, { recursive: true })
  } else {
    for (let n = 2; ; n++) {
      try {
        fs.mkdirSync(dir)
        break
      } catch (e) {
        if (e?.code !== 'EEXIST') throw e
        dir = `${base}-${n}`
      }
    }
  }
  fs.writeFileSync(path.join(dir, 'topology.json'), `${JSON.stringify(topology, null, 2)}\n`, { mode: 0o600 })
  if (plan) fs.writeFileSync(path.join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 })
  return dir
}

export function readSnapshot(dir) {
  const read = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    } catch {
      return null
    }
  }
  return { dir, topology: read('topology.json'), plan: read('plan.json') }
}

/** Marks a snapshot finished so it stops blocking the next reprovision. */
export function markSnapshotDone(dir) {
  try {
    fs.writeFileSync(path.join(dir, 'done'), `${new Date().toISOString()}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * Refuse a plan whose topology has moved since it was made. Applying a stale plan
 * would tear down networks the plan never saw, or rebuild ones already gone.
 */
export function planStillValid(plan, topology) {
  const now = topologyFingerprint(topology)
  return { valid: plan?.fingerprint === now, expected: plan?.fingerprint || '', actual: now }
}

function createNetworkArgs(entry) {
  return [
    'network',
    'create',
    '--ipv6=false',
    '--subnet',
    entry.subnet,
    ...(entry.gateway ? ['--gateway', entry.gateway] : []),
    ...(entry.bridge ? ['--opt', `com.docker.network.bridge.name=${entry.bridge}`] : []),
    '--opt',
    `com.docker.network.bridge.enable_ip_masquerade=${entry.masquerade ? 'true' : 'false'}`,
    '--opt',
    'com.docker.network.bridge.enable_icc=false',
    ...(entry.vm_id ? ['--label', `kin.egress.vm=${entry.vm_id}`] : []),
    entry.network,
  ]
}

/**
 * Tear every exit down and build it back. `target` decides where subnets come
 * from: `pool` for a forward pass, `snapshot` for a rollback -- the same steps
 * either way, so the rollback path is covered by the same tests.
 *
 * Nothing destructive happens until the gates pass. `dryRun` stops right at the
 * gate and reports the plan, having touched nothing.
 *
 * A container's IP is not preserved across the rebuild. It is not a VM's durable
 * identity (the registry stores none, and `enable_icc=false` forbids VM-to-VM
 * traffic), so docker reassigning one inside the new range is harmless; the
 * subnet, gateway and iptables rows are what have to line up, and they are
 * rebuilt together.
 */
export async function reprovision({
  projectRoot = '',
  host = 'control-plane',
  runDocker,
  runIptables,
  runIp,
  live = {},
  target = 'pool',
  dryRun = true,
  pool,
  prefix,
  snapshotDir,
  ensureEgress,
  verifyExit,
  stamp,
} = {}) {
  const phases = []
  const record = (name, ok, detail, extra = {}) => {
    phases.push({ name, ok, detail, ...extra })
    return ok
  }

  // A rollback replays a snapshot; a forward pass reads the host as it stands.
  const fromSnapshot = target === 'snapshot'
  const restored = fromSnapshot && snapshotDir ? readSnapshot(snapshotDir) : null
  const topology = restored?.topology || captureTopology({ projectRoot, runDocker, host })
  record(
    'topology',
    !!topology && (fromSnapshot || topology.complete === true),
    fromSnapshot ? `from ${snapshotDir}` : topology?.complete ? 'captured in full' : 'capture incomplete',
    { networks: topology?.networks?.length || 0 },
  )

  const scan = scanResidue({ projectRoot, runDocker, runIptables, runIp, live })
  const report = residueReport(scan, { orphansOnly: false })
  record('verify', true, report.clean ? 'already clean' : `${report.items.length} resource(s) present`, {
    unavailable: report.unavailable,
  })

  const feasible = fromSnapshot
    ? { ok: true, checks: [{ name: 'rollback', pass: true, detail: 'a rollback is permitted regardless' }] }
    : feasibility({ topology, scan, projectRoot, runDocker, runIptables, runIp, pool, prefix })
  record(
    'feasibility',
    feasible.ok,
    feasible.ok
      ? 'all checks passed'
      : feasible.checks
          .filter((c) => !c.pass)
          .map((c) => `${c.name}: ${c.detail}`)
          .join('; '),
    { checks: feasible.checks },
  )

  const plan =
    restored?.plan && fromSnapshot
      ? reprovisionPlan({ topology, scan, target, pool, prefix, runDocker, runIp })
      : reprovisionPlan({ topology, scan, target, pool, prefix, runDocker, runIp })
  const lines = reprovisionPlanLines(plan)
  record(
    'plan',
    plan.build.length > 0 || plan.teardown.length > 0,
    `${plan.teardown.length} teardown, ${plan.build.length} build`,
    {
      outageSeconds: estimateOutageSeconds(plan),
      lines,
    },
  )

  if (dryRun) {
    record('gate', feasible.ok, feasible.ok ? 'would proceed' : 'blocked', { dryRun: true })
    return { dryRun: true, target, topology, plan, report, feasibility: feasible, phases, lines }
  }

  if (!feasible.ok) {
    record('gate', false, 'refused: feasibility did not pass')
    return { dryRun: false, target, topology, plan, report, feasibility: feasible, phases, aborted: true }
  }

  // Passed through as-is: an absent stamp lets writeSnapshot generate one and
  // de-collide it. Forcing `Date.now()` here would name every directory
  // explicitly, which skips that and lets a rollback fired in the same
  // millisecond land on the snapshot it is recovering from.
  const dir = writeSnapshot({ projectRoot, stamp, topology, plan })
  record('snapshot', true, dir)

  // Everything past here is destructive, and the snapshot is already on disk.
  const stopped = []
  const failed = []
  for (const name of plan.stopContainers) {
    const r = runDocker(['stop', name])
    if (r?.ok || /No such container/i.test(String(r?.stderr || ''))) stopped.push(name)
    else failed.push({ step: `stop ${name}`, error: String(r?.stderr || '').slice(0, 160) })
  }
  record('stop', failed.length === 0, `${stopped.length} stopped`, { failed: [...failed] })

  const torn = executeCleanup(plan.teardown, { runDocker, runIptables, runIp, dryRun: false })
  record('teardown', torn.failed.length === 0, `${torn.done.length} removed, ${torn.failed.length} failed`, {
    failed: torn.failed,
  })

  const built = []
  const buildFailed = []
  for (const entry of plan.build) {
    const r = runDocker(createNetworkArgs(entry))
    if (r?.ok || /already exists/i.test(String(r?.stderr || ''))) built.push(entry)
    else buildFailed.push({ step: `create ${entry.network}`, error: String(r?.stderr || '').slice(0, 160) })
  }
  record(
    'build',
    buildFailed.length === 0,
    `${built.length} network(s) on ${plan.target === 'snapshot' ? 'snapshot ranges' : plan.pool}`,
    { failed: buildFailed },
  )

  const started = []
  const startFailed = []
  for (const entry of built) {
    for (const name of entry.containers) {
      // A container's NetworkMode holds the *id* of the network it was created
      // with, not its name, so a same-named replacement means nothing to it:
      // start fails with `network <id> not found`. It has to be attached to the
      // new network explicitly first. This is also why the existing slot
      // migration path rebuilds containers rather than reconnecting them.
      const attach = runDocker(['network', 'connect', entry.network, name])
      if (!attach?.ok && !/already exists|endpoint with name|already connected/i.test(String(attach?.stderr || ''))) {
        startFailed.push({
          step: `connect ${name} to ${entry.network}`,
          error: String(attach?.stderr || '').slice(0, 160),
        })
        continue
      }
      const r = runDocker(['start', name])
      if (r?.ok) started.push(name)
      else startFailed.push({ step: `start ${name}`, error: String(r?.stderr || '').slice(0, 160) })
    }
  }
  record('start', startFailed.length === 0, `${started.length} started`, { failed: startFailed })

  if (typeof ensureEgress === 'function') {
    const helperFailed = []
    for (const entry of built) {
      if (!entry.proxy_id) continue
      try {
        const r = await ensureEgress(entry)
        if (r && r.ok === false) helperFailed.push({ step: `egress ${entry.proxy_id}`, error: String(r.error || '') })
      } catch (e) {
        helperFailed.push({ step: `egress ${entry.proxy_id}`, error: String(e?.message || e).slice(0, 160) })
      }
    }
    record('helpers', helperFailed.length === 0, `${built.length - helperFailed.length} rebuilt`, {
      failed: helperFailed,
    })
  } else {
    record('helpers', true, 'skipped: no ensureEgress supplied; helpers rebuild on next ensure')
  }

  if (typeof verifyExit === 'function') {
    const results = []
    for (const entry of built) {
      try {
        const r = await verifyExit(entry)
        results.push({ network: entry.network, vm: entry.vm_id, ok: r?.ok !== false, detail: r?.detail || '' })
      } catch (e) {
        results.push({
          network: entry.network,
          vm: entry.vm_id,
          ok: false,
          detail: String(e?.message || e).slice(0, 160),
        })
      }
    }
    const bad = results.filter((r) => !r.ok)
    record('exit-check', bad.length === 0, `${results.length - bad.length}/${results.length} reachable`, { results })
  } else {
    record('exit-check', true, 'skipped: no verifyExit supplied')
  }

  // What was just rebuilt is live by definition. Judging the recheck against only
  // the caller's `live` would make a successful pass report its own fresh networks
  // as residue, since they sit there with nothing attached yet.
  const rebuiltLive = {
    proxyIds: [...(live.proxyIds || []), ...built.map((b) => b.proxy_id).filter(Boolean)],
    vmIds: [...(live.vmIds || []), ...built.map((b) => b.vm_id).filter(Boolean)],
  }
  const after = scanResidue({ projectRoot, runDocker, runIptables, runIp, live: rebuiltLive })
  const afterReport = residueReport(after)
  record('recheck', isClean(after), afterReport.clean ? 'clean' : afterReport.lines.join('; ') || 'residue remains', {
    unavailable: afterReport.unavailable,
  })

  const allOk = phases.every((p) => p.ok)
  if (allOk) {
    markSnapshotDone(dir)
    // A rollback that succeeded has served the purpose of the snapshot it came
    // from, so that one closes too. Leaving it open would block every later
    // reprovision on `no_pending_reprovision` with nothing left to recover.
    const closedSource = fromSnapshot && snapshotDir && snapshotDir !== dir && markSnapshotDone(snapshotDir)
    record('finish', true, closedSource ? `snapshot closed, and ${snapshotDir} resolved` : 'snapshot closed')
  } else {
    record('finish', false, `snapshot kept at ${dir} for rollback`)
  }

  return { dryRun: false, target, topology, plan, report, feasibility: feasible, snapshotDir: dir, phases, ok: allOk }
}

/** Rollback is the same pass with the snapshot as its source of target subnets. */
export async function rollback(options = {}) {
  return reprovision({ ...options, target: 'snapshot', dryRun: options.dryRun ?? false })
}
