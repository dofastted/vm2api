/**
 * Business wiring for egress maintenance: who is alive, and the refusal rules that
 * follow from not knowing.
 *
 * The residue scanner decides what is an orphan by asking which proxies and VMs are
 * live, and it takes that set from the caller so it needs no database of its own.
 * That makes the caller responsible for a safety-critical detail: an empty or
 * partial live set makes every resource look abandoned, so a sweep driven by one
 * would delete exits that are in use. Hence `complete`, and hence a sweep that
 * refuses rather than guesses.
 *
 * Verification is read-only and runs regardless -- a report built on a partial live
 * set is still worth reading, as long as it says so.
 */
import { execFileSync } from 'node:child_process'
import {
  cleanupPlan,
  cleanupPlanLines,
  executeCleanup,
  isClean,
  residueReport,
  scanResidue,
} from './egress-residue.mjs'

/** Shell runner shaped like the executors egress code takes: never throws. */
export function shellRunner({ timeout = 20_000 } = {}) {
  return (argv) => {
    try {
      const out = execFileSync(argv[0], argv.slice(1), {
        encoding: 'utf8',
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { ok: true, stdout: String(out || '').trim(), stderr: '' }
    } catch (e) {
      return { ok: false, stdout: String(e.stdout || '').trim(), stderr: String(e.stderr || e.message || '').trim() }
    }
  }
}

export function maintenanceExecutors(run = shellRunner()) {
  return {
    runDocker: (args) => run(['docker', ...args]),
    runIptables: (args) => run(['iptables', ...args]),
    runIp: (args) => run(['ip', ...args]),
  }
}

/**
 * Proxies and VMs that are still accounted for. `complete` is false when either
 * source could not be read, which is the difference between "nothing is live" and
 * "we do not know what is live".
 */
export function collectLiveSet({ projectRoot, dataDir, listVms, openPool } = {}) {
  const problems = []
  let vmIds = []
  let proxyIds = []
  let records = []

  try {
    vmIds = (listVms?.(projectRoot) || []).map((row) => String(row?.id || '')).filter(Boolean)
  } catch (e) {
    problems.push(`vm registry unreadable: ${String(e?.message || e).slice(0, 120)}`)
  }

  try {
    const pool = openPool?.({ dataDir })
    const proxies = pool?.snapshot?.()?.proxies || []
    proxyIds = proxies.map((p) => String(p?.id || '')).filter(Boolean)
    // Kept alongside the ids: a reprovision has to hand the real proxy record to
    // the helper rebuild, not just its name.
    records = proxies.filter((p) => p?.id)
  } catch (e) {
    problems.push(`proxy pool unreadable: ${String(e?.message || e).slice(0, 120)}`)
  }

  return {
    proxyIds,
    vmIds,
    proxies: records,
    complete: problems.length === 0,
    reason: problems.join('; '),
  }
}

/** Read-only: the five residue classes, with the live set it was judged against. */
export function verifyEgress({ projectRoot, live, runDocker, runIptables, runIp } = {}) {
  const scan = scanResidue({ projectRoot, runDocker, runIptables, runIp, live })
  const report = residueReport(scan)
  return {
    action: 'verify',
    clean: report.clean,
    live: { proxies: live?.proxyIds?.length || 0, vms: live?.vmIds?.length || 0, complete: !!live?.complete },
    unavailable: report.unavailable,
    counts: report.counts,
    lines: report.lines,
  }
}

/**
 * Clear orphaned egress resources. Dry by default.
 *
 * Refuses outright on an incomplete live set: every resource would look abandoned,
 * so this would delete exits that are serving traffic. `force` exists for an
 * operator who knows the registry is genuinely empty, and is never the default.
 */
export function sweepEgress({ projectRoot, live, runDocker, runIptables, runIp, apply = false, force = false } = {}) {
  if (!live?.complete && !force) {
    return {
      action: 'sweep',
      refused: true,
      reason: `live set is incomplete (${live?.reason || 'unknown'}); every exit would look orphaned`,
      hint: 'fix the source, or pass --force if the registry is genuinely empty',
    }
  }
  const scan = scanResidue({ projectRoot, runDocker, runIptables, runIp, live })
  const plan = cleanupPlan(scan, { orphansOnly: true })
  const result = executeCleanup(plan, { runDocker, runIptables, runIp, dryRun: !apply })
  const after = apply ? scanResidue({ projectRoot, runDocker, runIptables, runIp, live }) : null

  return {
    action: 'sweep',
    dryRun: !apply,
    forced: !live?.complete && force,
    planned: plan.length,
    lines: cleanupPlanLines(plan),
    done: result.done.length,
    failed: result.failed,
    // Only meaningful after a real pass; a dry run changed nothing to recheck.
    clean: after ? isClean(after) : null,
    unavailable: after ? residueReport(after).unavailable : residueReport(scan).unavailable,
  }
}

/**
 * Unified reprovision, wired to the control plane.
 *
 * The orchestrator deliberately knows nothing about binary paths, proxy records or
 * credentials, so the helper rebuild and the per-exit connectivity check arrive as
 * callbacks. Resolving them is this layer's job: both need the real proxy record,
 * which only the pool has.
 *
 * Refuses on an incomplete live set for the same reason a sweep does, and more
 * sharply -- this one tears down exits that are serving traffic.
 */
export async function reprovisionEgress({
  projectRoot,
  live,
  runDocker,
  runIptables,
  runIp,
  apply = false,
  force = false,
  snapshotDir,
  target = 'pool',
  ensureProxyEgress,
  proxyEgressReady,
  reprovision,
} = {}) {
  if (!live?.complete && !force) {
    return {
      action: 'reprovision',
      refused: true,
      reason: `live set is incomplete (${live?.reason || 'unknown'}); refusing to tear down exits`,
      hint: 'fix the source, or pass --force if the registry is genuinely empty',
    }
  }

  const byId = new Map((live?.proxies || []).map((p) => [String(p.id), p]))
  const helperFor = (entry) => byId.get(String(entry?.proxy_id || '')) || null

  const result = await reprovision({
    projectRoot,
    runDocker,
    runIptables,
    runIp,
    live,
    target,
    snapshotDir,
    dryRun: !apply,
    // A proxy the pool no longer knows gets no helper: its network is rebuilt so
    // the teardown is complete, but nothing is started against a record we lack.
    ensureEgress:
      typeof ensureProxyEgress === 'function'
        ? async (entry) => {
            const proxy = helperFor(entry)
            if (!proxy) return { ok: true, skipped: 'proxy no longer in the pool' }
            return ensureProxyEgress(projectRoot, proxy)
          }
        : undefined,
    verifyExit:
      typeof proxyEgressReady === 'function'
        ? async (entry) => {
            const proxy = helperFor(entry)
            if (!proxy) return { ok: true, detail: 'proxy no longer in the pool' }
            const r = proxyEgressReady(proxy, projectRoot)
            return { ok: r?.ok !== false, detail: r?.reason || r?.error || '' }
          }
        : undefined,
  })

  return {
    action: 'reprovision',
    dryRun: result.dryRun,
    target: result.target,
    forced: !live?.complete && force,
    ok: result.ok ?? null,
    aborted: !!result.aborted,
    snapshotDir: result.snapshotDir || null,
    phases: (result.phases || []).map((p) => ({ name: p.name, ok: p.ok, detail: p.detail })),
    feasibility: (result.feasibility?.checks || []).map((c) => ({ name: c.name, pass: c.pass, detail: c.detail })),
    lines: result.lines || [],
  }
}
