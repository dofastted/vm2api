#!/usr/bin/env node
/**
 * Phase 0 stepped benchmark orchestrator + automatic knee & bottleneck attribution + Markdown/JSON report generator.
 *
 * Ties together:
 * - Environment bootstrap (`bootstrap-sut.mjs` or existing `session.json`)
 * - Stepped open-loop load sweep (`load-runner.mjs`) with concurrent panel read/write load
 * - Full-spectrum telemetry diffing (`metrics-collector.mjs`: PG 18, Redis 8, SUT probes, PgLogWriter)
 * - End-of-sweep closed-loop zero-loss & zero-drift verification (`verify-closed-loop.mjs`)
 * - Automated knee detection & bottleneck attribution + Markdown/JSON baseline report rendering
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLoadStep } from './load-runner.mjs'
import { createMetricsCollector, diffSnapshots } from './metrics-collector.mjs'
import { verifyClosedLoop } from './verify-closed-loop.mjs'

const DEFAULT_STEPS = [600, 1500, 3000, 6000, 10000, 20000]
const DEFAULT_STEP_SEC = 20
const DEFAULT_COOLDOWN_SEC = 2
const DEFAULT_P95_OVERHEAD_SLA_MS = 250
const DEFAULT_PANEL_P95_SLA_MS = 500
const DEFAULT_MIN_RPM_RATIO = 0.9

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function fmt(v, digits = 2) {
  if (v == null || !Number.isFinite(Number(v))) return '-'
  return Number(v).toFixed(digits)
}

function fmtInt(v) {
  if (v == null || !Number.isFinite(Number(v))) return '-'
  return Math.round(Number(v)).toLocaleString('en-US')
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

/**
 * Evaluate a single step against SLA thresholds and return triggered knee reasons.
 */
export function evaluateStepHealth(
  step,
  {
    p95OverheadSlaMs = DEFAULT_P95_OVERHEAD_SLA_MS,
    panelP95SlaMs = DEFAULT_PANEL_P95_SLA_MS,
    minRpmRatio = DEFAULT_MIN_RPM_RATIO,
    maxNonInjectedErrorRate = 0,
  } = {},
) {
  const reasons = []
  const load = step.load || {}
  const targetRpm = num(step.targetRpm)
  const achievedRpm = num(load.achievedRpm)
  const mockAvgUpMs = step.telemetry?.mockUpstream?.avgUpstreamMsEnd
  const hasExactOverhead = Boolean(load.overheadMs)
  const p95ControlMs = hasExactOverhead
    ? num(load.overheadMs.p95)
    : mockAvgUpMs != null && mockAvgUpMs > 0
      ? Math.max(0, num(load.totalMs?.p95) - mockAvgUpMs)
      : num(load.totalMs?.p95)
  const nonInjectedErrRate = num(load.nonInjectedErrorRate)
  const nonInjectedErrs = num(load.nonInjectedErrors)

  if (load.saturated) {
    reasons.push(`inflight saturated (drops=${num(load.saturatedDrops)}, peak=${num(load.peakInflight)})`)
  }
  if (targetRpm > 0 && achievedRpm < targetRpm * minRpmRatio) {
    reasons.push(`achieved RPM ${fmt(achievedRpm, 1)} < ${(minRpmRatio * 100).toFixed(0)}% of target ${targetRpm}`)
  }
  if (nonInjectedErrRate > maxNonInjectedErrorRate || (maxNonInjectedErrorRate === 0 && nonInjectedErrs > 0)) {
    reasons.push(`non-injected errors=${nonInjectedErrs} (${(nonInjectedErrRate * 100).toFixed(3)}%)`)
  }
  if (p95ControlMs > p95OverheadSlaMs) {
    const metricName = hasExactOverhead
      ? 'overhead p95'
      : mockAvgUpMs != null && mockAvgUpMs > 0
        ? 'est. overhead p95'
        : 'total p95'
    reasons.push(`${metricName} ${fmt(p95ControlMs, 1)}ms > SLA ${p95OverheadSlaMs}ms`)
  }
  if (load.panel && num(load.panel.totalRequests) > 0) {
    if (num(load.panel.totalErrors) > 0) {
      reasons.push(`panel errors=${load.panel.totalErrors}/${load.panel.totalRequests}`)
    }
    if (num(load.panel.overallLatencyMs?.p95) > panelP95SlaMs) {
      reasons.push(`panel p95 ${fmt(load.panel.overallLatencyMs.p95, 1)}ms > SLA ${panelP95SlaMs}ms`)
    }
  }

  return {
    healthy: reasons.length === 0,
    reasons,
  }
}

/**
 * Attribute primary & secondary bottlenecks at the knee step (or highest step if all healthy).
 * Categories: `Atomics.wait`, `CPU/EventLoop`, `PostgreSQL`, `Redis`, `Panel`, `LoadGenerator`.
 */
export function attributeBottlenecks(step, { panelP95SlaMs = DEFAULT_PANEL_P95_SLA_MS } = {}) {
  const candidates = []
  const load = step?.load || {}
  const t = step?.telemetry || {}
  const probes = t.probes || null
  const pg = t.postgres || null
  const redis = t.redis || null
  const writer = t.pgLogWriter || null
  const panel = load.panel || null
  const elapsedSec = Math.max(0.001, num(t.elapsedSec, num(load.totalDurationSec, 1)))
  const instances = Math.max(1, num(probes?.instanceCount, 1))

  // 1. Atomics.wait (PgSyncDb synchronous worker blocking on main thread)
  if (probes) {
    const waitsPerReq = num(probes.atomicsWaitsPerReq)
    const waitBlockRatio = num(probes.atomicsWaitTotalMsDelta) / (elapsedSec * instances * 1000)
    if (waitsPerReq >= 0.5 || waitBlockRatio >= 0.1) {
      const score = Math.min(100, Math.round(waitBlockRatio * 120 + waitsPerReq * 15))
      candidates.push({
        category: 'Atomics.wait',
        score,
        evidence: `${fmt(waitsPerReq, 2)} waits/req, ${fmt(probes.atomicsWaitMsPerReq, 2)} ms/req (${(waitBlockRatio * 100).toFixed(1)}% main-thread blocked, max=${fmt(probes.atomicsWaitMaxMs, 1)}ms)`,
      })
    }
  }

  // 2. CPU / EventLoop saturation
  if (probes) {
    const elP95 = num(probes.eventLoopDelayMs?.p95)
    const cpuPerInstPct = num(probes.cpuPct) / instances
    if (elP95 >= 50 || cpuPerInstPct >= 80) {
      const score = Math.min(100, Math.round(Math.max(elP95 / 2, cpuPerInstPct)))
      candidates.push({
        category: 'CPU/EventLoop',
        score,
        evidence: `eventLoop p95=${fmt(elP95, 1)}ms (p99=${fmt(probes.eventLoopDelayMs?.p99, 1)}ms), CPU=${fmt(probes.cpuPct, 1)}% across ${instances} inst (${fmt(cpuPerInstPct, 1)}%/inst)`,
      })
    }
  }

  // 3. PostgreSQL I/O / connection / log-writer backpressure
  if (pg || writer) {
    const waitingConns = num(pg?.activityEnd?.waiting)
    const usageSeqScans = num(pg?.tablesDelta?.usage_logs?.seqScansDelta)
    const deadlocks = num(pg?.deadlocksDelta)
    const writerBackpressure =
      num(writer?.queuedEnd) > 0 ||
      num(writer?.overflowDirectDelta) > 0 ||
      num(writer?.fallbacksDelta) > 0 ||
      num(writer?.droppedDelta) > 0 ||
      num(writer?.errorsDelta) > 0
    const highWriteAmp = num(pg?.pgInsertsPerSec) + num(pg?.pgUpdatesPerSec) >= 500 || num(pg?.walMBPerSec) >= 20
    if (waitingConns > 0 || usageSeqScans > 0 || deadlocks > 0 || writerBackpressure || highWriteAmp) {
      let score = 30
      if (deadlocks > 0) score += 40
      if (waitingConns > 0) score += Math.min(35, waitingConns * 5)
      if (writerBackpressure) score += 35
      if (usageSeqScans > 0) score += 20
      if (highWriteAmp) score += 15
      const parts = []
      if (pg) {
        parts.push(`ins=${fmt(pg.pgInsertsPerSec, 1)}/s`, `upd=${fmt(pg.pgUpdatesPerSec, 1)}/s`)
        if (pg.walMBPerSec != null) parts.push(`WAL=${fmt(pg.walMBPerSec, 2)} MB/s`)
        if (waitingConns > 0) parts.push(`waitingConns=${waitingConns}`)
        if (usageSeqScans > 0) parts.push(`usage_logs seq_scans=+${usageSeqScans}`)
        if (deadlocks > 0) parts.push(`deadlocks=+${deadlocks}`)
      }
      if (writerBackpressure) {
        parts.push(
          `PgLogWriter(q=${num(writer.queuedEnd)}, overflow=${num(writer.overflowDirectDelta)}, fallback=${num(writer.fallbacksDelta)}, dropped=${num(writer.droppedDelta)})`,
        )
      }
      candidates.push({
        category: 'PostgreSQL',
        score: Math.min(100, score),
        evidence: parts.join(', '),
      })
    }
  }

  // 4. Redis memory eviction / AOF fsync stalls / slow commands
  if (redis) {
    const evicted = num(redis.evictedKeysDelta)
    const aofStalls = num(redis.aofDelayedFsyncDelta)
    const topSlow = redis.topCommandStatsDelta?.[0] || null
    const slowCmd = topSlow && num(topSlow.usecPerCall) >= 2_000
    if (evicted > 0 || aofStalls > 0 || slowCmd) {
      let score = 25
      if (evicted > 0) score += 45
      if (aofStalls > 0) score += 35
      if (slowCmd) score += 25
      const parts = [`ops=${fmt(redis.redisOpsPerSec, 1)}/s`, `mem=${fmt(redis.usedMemoryEndMb, 1)}MB`]
      if (evicted > 0) parts.push(`evicted=+${evicted}`)
      if (aofStalls > 0) parts.push(`aof_delayed_fsync=+${aofStalls}`)
      if (slowCmd) parts.push(`topCmd=${topSlow.cmd}(${fmt(topSlow.usecPerCall, 0)}us/call)`)
      candidates.push({
        category: 'Redis',
        score: Math.min(100, score),
        evidence: parts.join(', '),
      })
    }
  }

  // 5. Panel query contention
  if (panel && num(panel.totalRequests) > 0) {
    const panelP95 = num(panel.overallLatencyMs?.p95)
    const panelErrs = num(panel.totalErrors)
    if (panelErrs > 0 || panelP95 > panelP95SlaMs) {
      const score = Math.min(100, (panelErrs > 0 ? 50 : 20) + Math.round(panelP95 / 20))
      candidates.push({
        category: 'Panel',
        score,
        evidence: `panel p95=${fmt(panelP95, 1)}ms, errors=${panelErrs}/${panel.totalRequests}`,
      })
    }
  }

  // 6. Client-side load generator lag / saturation with idle SUT
  if (load.saturated && candidates.length === 0) {
    candidates.push({
      category: 'LoadGenerator',
      score: 40,
      evidence: `inflight cap reached (${num(load.peakInflight)}/${num(load.maxInflight)}) with maxScheduleLag=${fmt(load.maxScheduleLagMs, 1)}ms and no SUT saturation signals`,
    })
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates
}

/**
 * Inspect all completed steps to find Peak Healthy RPM, Knee RPM, and ranked bottleneck attribution.
 */
export function detectKneeAndAttribution(steps = [], thresholds = {}) {
  let peakHealthyRpm = 0
  let kneeStep = null
  const evaluatedSteps = []

  for (const step of steps) {
    const health = evaluateStepHealth(step, thresholds)
    const attributions = attributeBottlenecks(step, thresholds)
    const entry = {
      targetRpm: step.targetRpm,
      achievedRpm: step.load?.achievedRpm ?? 0,
      healthy: health.healthy,
      reasons: health.reasons,
      attributions,
    }
    evaluatedSteps.push(entry)
    if (health.healthy) {
      if (!kneeStep) peakHealthyRpm = Math.max(peakHealthyRpm, num(step.targetRpm))
    } else if (!kneeStep) {
      kneeStep = entry
    }
  }

  const focusStep = kneeStep || evaluatedSteps[evaluatedSteps.length - 1] || null
  const primaryBottleneck = focusStep?.attributions?.[0] || null
  const secondaryBottlenecks = focusStep?.attributions?.slice(1) || []

  return {
    peakHealthyRpm,
    kneeDetected: Boolean(kneeStep),
    kneeTargetRpm: kneeStep ? kneeStep.targetRpm : null,
    kneeAchievedRpm: kneeStep ? kneeStep.achievedRpm : null,
    kneeReasons: kneeStep ? kneeStep.reasons : [],
    primaryBottleneck,
    secondaryBottlenecks,
    steps: evaluatedSteps,
  }
}

/**
 * Render a concise, data-rich Phase 0 Markdown baseline report.
 */
export function renderPhase0Report(report) {
  const lines = []
  const meta = report.meta || {}
  const analysis = report.analysis || {}
  const steps = report.steps || []
  const closedLoop = report.closedLoop || null

  lines.push(`# Phase 0 20K RPM Baseline Report${meta.label ? ` — ${meta.label}` : ''}`)
  lines.push('')
  lines.push(`- **Generated**: ${meta.generatedAtIso || new Date().toISOString()}`)
  lines.push(`- **SUT Directory**: \`${meta.sutDir || 'attached-session'}\``)
  lines.push(`- **SUT Instances**: ${meta.instances ?? 1}`)
  lines.push(`- **Corpus**: \`${meta.corpus || '-'}\``)
  lines.push(`- **Steps (RPM)**: ${(meta.steps || []).join(', ')} (${meta.stepSec ?? '-'}s/step)`)
  lines.push(`- **Panel Pollers**: ${meta.panelPollers ?? 0}`)
  lines.push('')

  lines.push('## Executive Summary')
  lines.push('')
  lines.push(`| Metric | Value |`)
  lines.push(`| --- | --- |`)
  lines.push(`| Peak Healthy Target RPM | **${fmtInt(analysis.peakHealthyRpm)}** |`)
  lines.push(
    `| Knee Point | ${analysis.kneeDetected ? `**${fmtInt(analysis.kneeTargetRpm)} RPM** (achieved ${fmt(analysis.kneeAchievedRpm, 1)} RPM)` : 'None detected within sweep'} |`,
  )
  lines.push(
    `| Primary Bottleneck | ${analysis.primaryBottleneck ? `**${analysis.primaryBottleneck.category}** — ${analysis.primaryBottleneck.evidence}` : 'None observed'} |`,
  )
  if (analysis.kneeReasons?.length) {
    lines.push(`| Knee Triggers | ${analysis.kneeReasons.join('; ')} |`)
  }
  lines.push(
    `| Closed-Loop Integrity | ${closedLoop ? (closedLoop.passed ? '**PASS** (0 loss, 0 drift)' : `**FAIL** (${closedLoop.failures.join('; ')})`) : 'Not run'} |`,
  )
  lines.push('')

  lines.push('## Proxy Throughput & Control-Plane Overhead')
  lines.push('')
  lines.push(
    '| Target RPM | Achieved RPM | Ratio | MB/s | Total p50/p95/p99 (ms) | Overhead p50/p95/p99 (ms) | TTFT p95 (ms) | Non-Inj Err | Saturated | Status |',
  )
  lines.push('| ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | :---: | :---: |')
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const l = s.load || {}
    const evalEntry = analysis.steps?.[i]
    const tot = l.totalMs || {}
    const ovh = l.overheadMs || null
    const mockAvgUpMs = s.telemetry?.mockUpstream?.avgUpstreamMsEnd
    const ovhStr = ovh
      ? `${fmt(ovh.p50, 1)} / ${fmt(ovh.p95, 1)} / ${fmt(ovh.p99, 1)}`
      : mockAvgUpMs != null && mockAvgUpMs > 0
        ? `~${fmt(Math.max(0, num(tot.p50) - mockAvgUpMs), 1)} / ~${fmt(Math.max(0, num(tot.p95) - mockAvgUpMs), 1)} / ~${fmt(Math.max(0, num(tot.p99) - mockAvgUpMs), 1)}`
        : '-'
    const totStr = `${fmt(tot.p50, 1)} / ${fmt(tot.p95, 1)} / ${fmt(tot.p99, 1)}`
    const errStr = `${l.nonInjectedErrors ?? 0} (${((l.nonInjectedErrorRate ?? 0) * 100).toFixed(2)}%)`
    const statusStr = evalEntry ? (evalEntry.healthy ? 'OK' : 'KNEE') : '-'
    lines.push(
      `| ${fmtInt(s.targetRpm)} | ${fmt(l.achievedRpm, 1)} | ${((l.achievedRatio ?? 0) * 100).toFixed(1)}% | ${fmt(l.throughputTotalMBps, 2)} | ${totStr} | ${ovhStr} | ${fmt(l.ttftMs?.p95, 1)} | ${errStr} | ${l.saturated ? 'YES' : 'no'} | ${statusStr} |`,
    )
  }
  lines.push('')

  // Panel Concurrent Load table
  const hasPanel = steps.some((s) => (s.load?.panel?.totalRequests ?? 0) > 0)
  if (hasPanel) {
    lines.push('## Concurrent Panel Read/Write Latency')
    lines.push('')
    lines.push('| Target RPM | Pollers | Total Reqs | Errors | Overall p50/p95/p99 (ms) | Slowest Endpoint (p95 ms) |')
    lines.push('| ---: | ---: | ---: | ---: | --- | --- |')
    for (const s of steps) {
      const p = s.load?.panel
      if (!p) continue
      const lat = p.overallLatencyMs || {}
      let slowest = '-'
      let maxP95 = -1
      for (const [ep, epStats] of Object.entries(p.byEndpoint || {})) {
        const epP95 = num(epStats.latencyMs?.p95)
        if (epP95 > maxP95) {
          maxP95 = epP95
          slowest = `${ep} (${fmt(epP95, 1)}ms, err=${epStats.errors})`
        }
      }
      lines.push(
        `| ${fmtInt(s.targetRpm)} | ${p.pollers ?? 0} | ${fmtInt(p.totalRequests)} | ${p.totalErrors ?? 0} | ${fmt(lat.p50, 1)} / ${fmt(lat.p95, 1)} / ${fmt(lat.p99, 1)} | ${slowest} |`,
      )
    }
    lines.push('')
  }

  // System Telemetry table
  lines.push('## System Telemetry (SUT Probes, PostgreSQL 18, Redis 8, PgLogWriter)')
  lines.push('')
  lines.push(
    '| Target RPM | EL p95 (ms) | Atomics.wait /req (ms/req) | CPU % | RSS MB | PG ins/s | PG upd/s | WAL MB/s | PG act/wait | Redis ops/s | Redis MB (evict) | LogWriter q/ovf/drop |',
  )
  lines.push('| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | :---: | ---: | --- | :---: |')
  for (const s of steps) {
    const t = s.telemetry || {}
    const pr = t.probes
    const pg = t.postgres
    const rd = t.redis
    const lw = t.pgLogWriter
    const awStr = pr ? `${fmt(pr.atomicsWaitsPerReq, 2)} (${fmt(pr.atomicsWaitMsPerReq, 2)}ms)` : '-'
    const pgAct = pg?.activityEnd ? `${pg.activityEnd.active}/${pg.activityEnd.waiting}` : '-'
    const rdMem = rd ? `${fmt(rd.usedMemoryEndMb, 1)} (${rd.evictedKeysDelta})` : '-'
    const lwStr = lw ? `${lw.queuedEnd}/${lw.overflowDirectDelta}/${lw.droppedDelta}` : '-'
    lines.push(
      `| ${fmtInt(s.targetRpm)} | ${fmt(pr?.eventLoopDelayMs?.p95, 1)} | ${awStr} | ${fmt(pr?.cpuPct, 1)} | ${fmt(pr?.rssEndMb, 1)} | ${fmt(pg?.pgInsertsPerSec, 1)} | ${fmt(pg?.pgUpdatesPerSec, 1)} | ${fmt(pg?.walMBPerSec, 2)} | ${pgAct} | ${fmt(rd?.redisOpsPerSec, 1)} | ${rdMem} | ${lwStr} |`,
    )
  }
  lines.push('')

  // Closed-Loop Integrity section
  if (closedLoop) {
    lines.push('## Closed-Loop Zero-Loss & Zero-Drift Verification')
    lines.push('')
    const c = closedLoop.checks || {}
    lines.push(`- **Overall Verdict**: ${closedLoop.passed ? 'PASS' : 'FAIL'}`)
    if (closedLoop.drain) {
      lines.push(
        `- **Drain Window**: ${closedLoop.drain.drained ? 'stabilized' : 'timed out'} in ${closedLoop.drain.elapsedMs}ms (${closedLoop.drain.polls} polls)`,
      )
    }
    lines.push('')
    lines.push('| Check | Verdict | Details |')
    lines.push('| --- | :---: | --- |')
    if (c.usageLogs) {
      lines.push(
        `| PG \`usage_logs\` | ${c.usageLogs.passed ? 'PASS' : 'FAIL'} | expected=${fmtInt(c.usageLogs.expectedCompleted)}, actual=${fmtInt(c.usageLogs.actualUsageLogs)}, missing=${fmtInt(c.usageLogs.missingRows)}, lossRate=${(c.usageLogs.lossRate * 100).toFixed(4)}% |`,
      )
    }
    if (c.apiKeyBilling) {
      lines.push(
        `| PG \`api_keys\` Billing | ${c.apiKeyBilling.passed ? 'PASS' : 'FAIL'} | keysChecked=${c.apiKeyBilling.totalKeysChecked}, drifted=${c.apiKeyBilling.driftedKeyCount}, reqs=${c.apiKeyBilling.totals?.apiKeysQuotaRequestsUsed}/${c.apiKeyBilling.totals?.usageLogsOkCount} |`,
      )
    }
    if (c.pgLogWriter) {
      const w = c.pgLogWriter.counters
      const detail = w
        ? `queued=${w.queued}, overflowDirect=${w.overflowDirect}, fallbacks=${w.fallbacks}, dropped=${w.dropped}, errors=${w.errors}`
        : c.pgLogWriter.note || 'not available'
      lines.push(`| \`PgLogWriter\` | ${c.pgLogWriter.passed ? 'PASS' : 'FAIL'} | ${detail} |`)
    }
    if (c.redis) {
      const detail = c.redis.available
        ? `evicted_keys=${c.redis.evictedKeys}, ${c.redis.inflightKey} orphans=${c.redis.liveInflightOrphans}`
        : 'Redis not configured'
      lines.push(`| Redis Integrity | ${c.redis.passed ? 'PASS' : 'FAIL'} | ${detail} |`)
    }
    lines.push('')
  }

  // Bottleneck Attribution details
  if (analysis.primaryBottleneck || analysis.secondaryBottlenecks?.length) {
    lines.push('## Bottleneck Attribution')
    lines.push('')
    const all = [analysis.primaryBottleneck, ...(analysis.secondaryBottlenecks || [])].filter(Boolean)
    for (let i = 0; i < all.length; i++) {
      const item = all[i]
      lines.push(`${i + 1}. **${item.category}** (score=${item.score}): ${item.evidence}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

async function defaultStartBenchEnv(opts) {
  const mod = await import('./bootstrap-sut.mjs')
  if (typeof mod.startBenchEnv !== 'function') {
    throw new Error('bootstrap-sut.mjs does not export startBenchEnv')
  }
  const handle = await mod.startBenchEnv(opts)
  return {
    session: handle.session || handle,
    async stop() {
      if (typeof mod.stopBenchEnv === 'function') {
        await mod.stopBenchEnv(handle)
      } else if (typeof handle.stop === 'function') {
        await handle.stop()
      }
    },
  }
}

/**
 * Execute the full Phase 0 stepped sweep, telemetry diffing, closed-loop audit, and report generation.
 */
export async function runPhase0(options = {}) {
  const {
    steps = DEFAULT_STEPS,
    stepSec = DEFAULT_STEP_SEC,
    warmupSec = 0,
    cooldownSec = DEFAULT_COOLDOWN_SEC,
    sutDir = process.cwd(),
    instances = 1,
    vms = 200,
    keys = 100,
    pgUrl = '',
    redisUrl = undefined,
    ttftMs = undefined,
    streamMs = undefined,
    faultRate = undefined,
    mockWorkers = undefined,
    corpusPath = path.resolve(process.cwd(), '.local/bench-20k/corpus/corpus-100k.jsonl'),
    templates = null,
    session = null,
    sessionPath = '',
    workers = Math.min(4, Math.max(1, Math.floor(os.cpus().length / 2))),
    maxInflight = 12_000,
    routing = 'sticky',
    proxyPath = '/v1/messages',
    panelPollers = 20,
    panelMinIntervalMs = 3_000,
    panelMaxIntervalMs = 5_000,
    panelEnableWrites = true,
    p95OverheadSlaMs = DEFAULT_P95_OVERHEAD_SLA_MS,
    panelP95SlaMs = DEFAULT_PANEL_P95_SLA_MS,
    minRpmRatio = DEFAULT_MIN_RPM_RATIO,
    maxNonInjectedErrorRate = 0,
    stopOnKnee = false,
    skipClosedLoop = false,
    drainTimeoutMs = 15_000,
    outReport = '',
    label = '',
    // Injectable hooks for deterministic unit tests
    startEnvImpl = defaultStartBenchEnv,
    runLoadStepImpl = runLoadStep,
    createCollectorImpl = createMetricsCollector,
    verifyClosedLoopImpl = verifyClosedLoop,
  } = options

  let envHandle = null
  let activeSession = session
  if (!activeSession && sessionPath) {
    activeSession = JSON.parse(fs.readFileSync(path.resolve(sessionPath), 'utf8'))
  }
  if (!activeSession) {
    envHandle = await startEnvImpl({
      sutDir,
      instances,
      vms,
      keys,
      ...(pgUrl ? { pgUrl } : {}),
      ...(redisUrl !== undefined ? { redisUrl } : {}),
      ...(ttftMs !== undefined ? { ttftMs } : {}),
      ...(streamMs !== undefined ? { streamMs } : {}),
      ...(faultRate !== undefined ? { faultRate } : {}),
      ...(mockWorkers !== undefined ? { mockWorkers } : {}),
    })
    activeSession = envHandle.session
  }

  const collector = createCollectorImpl({
    pgUrl: activeSession.pgUrl || '',
    redisUrl: activeSession.redisUrl || '',
    probeStatsUrls: activeSession.probeStatsUrls || [],
    sutUrls: activeSession.sutUrls || [],
    adminCookie: activeSession.adminCookie || '',
    mockUpstreamUrl: activeSession.mockUpstreamUrl || '',
  })

  try {
    // Optional brief warmup step (excluded from measured steps, included in closed-loop totals)
    let cumulativeExpectedLogs = 0
    const sweepStartIso = new Date().toISOString()
    const baselineSnap = await collector.snapshot()

    if (warmupSec > 0 && steps.length > 0) {
      const warmRes = await runLoadStepImpl({
        corpusPath: templates ? undefined : corpusPath,
        templates,
        sutUrls: activeSession.sutUrls,
        apiKeys: activeSession.apiKeys,
        proxyPath,
        targetRpm: Math.min(600, steps[0]),
        durationSec: warmupSec,
        maxInflight,
        workers: 1,
        routing,
        panelPollers: 0,
      })
      cumulativeExpectedLogs += Math.max(0, warmRes.completedCount - warmRes.transportErrors)
      if (cooldownSec > 0) await sleep(cooldownSec * 1000)
    }

    const stepResults = []
    const thresholds = { p95OverheadSlaMs, panelP95SlaMs, minRpmRatio, maxNonInjectedErrorRate }

    for (let idx = 0; idx < steps.length; idx++) {
      const targetRpm = steps[idx]
      await collector.resetProbes().catch(() => {})
      const beforeSnap = await collector.snapshot()

      const load = await runLoadStepImpl({
        corpusPath: templates ? undefined : corpusPath,
        templates,
        sutUrls: activeSession.sutUrls,
        apiKeys: activeSession.apiKeys,
        proxyPath,
        targetRpm,
        durationSec: stepSec,
        maxInflight,
        workers,
        routing,
        panelPollers,
        adminCookie: activeSession.adminCookie || '',
        tenantCookies: activeSession.tenantCookies || [],
        panelMinIntervalMs,
        panelMaxIntervalMs,
        panelEnableWrites,
      })

      const afterSnap = await collector.snapshot()
      const telemetry = diffSnapshots(beforeSnap, afterSnap, { completedRequests: load.completedCount })

      cumulativeExpectedLogs += Math.max(0, load.completedCount - load.transportErrors)

      const stepRecord = {
        stepIndex: idx + 1,
        targetRpm,
        load,
        telemetry,
      }
      stepResults.push(stepRecord)

      const health = evaluateStepHealth(stepRecord, thresholds)
      if (stopOnKnee && !health.healthy) {
        break
      }
      if (idx < steps.length - 1 && cooldownSec > 0) {
        await sleep(cooldownSec * 1000)
      }
    }

    let closedLoop = null
    if (!skipClosedLoop) {
      closedLoop = await verifyClosedLoopImpl({
        pgUrl: activeSession.pgUrl || '',
        redisUrl: activeSession.redisUrl || '',
        sutUrls: activeSession.sutUrls || [],
        adminCookie: activeSession.adminCookie || '',
        expectedCompleted: cumulativeExpectedLogs,
        sinceIso: sweepStartIso,
        baselineEvictedKeys: baselineSnap?.redis?.evictedKeys ?? 0,
        baselinePgLogWriter: baselineSnap?.panelStats?.pgLogWriter ?? null,
        drainTimeoutMs,
      })
    }

    const analysis = detectKneeAndAttribution(stepResults, thresholds)
    const report = {
      meta: {
        generatedAtIso: new Date().toISOString(),
        label,
        sutDir: activeSession.sutDir || sutDir,
        instances: activeSession.sutUrls?.length || instances,
        corpus: templates ? '<in-memory>' : corpusPath,
        steps,
        stepSec,
        warmupSec,
        cooldownSec,
        workers,
        maxInflight,
        panelPollers,
        thresholds,
      },
      analysis,
      steps: stepResults,
      closedLoop,
    }

    const markdown = renderPhase0Report(report)
    if (outReport) {
      const mdPath = path.resolve(outReport)
      const jsonPath = mdPath.endsWith('.md') ? `${mdPath.slice(0, -3)}.json` : `${mdPath}.json`
      fs.mkdirSync(path.dirname(mdPath), { recursive: true })
      fs.writeFileSync(mdPath, markdown, 'utf8')
      fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8')
      report.artifacts = { markdownPath: mdPath, jsonPath }
    }

    return { report, markdown }
  } finally {
    await collector.close().catch(() => {})
    if (envHandle) {
      await envHandle.stop().catch(() => {})
    }
  }
}

export function parsePhase0Args(argv = process.argv.slice(2)) {
  const args = {
    steps: DEFAULT_STEPS,
    stepSec: DEFAULT_STEP_SEC,
    warmupSec: 0,
    cooldownSec: DEFAULT_COOLDOWN_SEC,
    sutDir: process.cwd(),
    instances: 1,
    vms: 200,
    keys: 100,
    pgUrl: '',
    redisUrl: undefined,
    ttftMs: undefined,
    streamMs: undefined,
    faultRate: undefined,
    mockWorkers: undefined,
    corpus: path.resolve(process.cwd(), '.local/bench-20k/corpus/corpus-100k.jsonl'),
    session: '',
    workers: Math.min(4, Math.max(1, Math.floor(os.cpus().length / 2))),
    maxInflight: 12_000,
    routing: 'sticky',
    panelPollers: 20,
    panelWrites: true,
    p95OverheadSlaMs: DEFAULT_P95_OVERHEAD_SLA_MS,
    panelP95SlaMs: DEFAULT_PANEL_P95_SLA_MS,
    minRpmRatio: DEFAULT_MIN_RPM_RATIO,
    stopOnKnee: false,
    skipClosedLoop: false,
    drainTimeoutMs: 15_000,
    outReport: '',
    label: '',
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = () => argv[++i]
    if (flag === '--steps') {
      args.steps = next()
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    } else if (flag === '--step-sec') args.stepSec = Number(next())
    else if (flag === '--warmup-sec') args.warmupSec = Number(next())
    else if (flag === '--cooldown-sec') args.cooldownSec = Number(next())
    else if (flag === '--sut-dir') args.sutDir = next()
    else if (flag === '--instances') args.instances = Number(next())
    else if (flag === '--vms') args.vms = Number(next())
    else if (flag === '--keys') args.keys = Number(next())
    else if (flag === '--pg-url') args.pgUrl = next()
    else if (flag === '--redis-url') args.redisUrl = next()
    else if (flag === '--ttft-ms') args.ttftMs = Number(next())
    else if (flag === '--stream-ms') args.streamMs = Number(next())
    else if (flag === '--fault-rate') args.faultRate = Number(next())
    else if (flag === '--mock-workers') args.mockWorkers = Number(next())
    else if (flag === '--corpus') args.corpus = next()
    else if (flag === '--session') args.session = next()
    else if (flag === '--workers') args.workers = Number(next())
    else if (flag === '--max-inflight') args.maxInflight = Number(next())
    else if (flag === '--routing') args.routing = next()
    else if (flag === '--panel-pollers') args.panelPollers = Number(next())
    else if (flag === '--no-panel-writes') args.panelWrites = false
    else if (flag === '--p95-sla-ms') args.p95OverheadSlaMs = Number(next())
    else if (flag === '--panel-p95-sla-ms') args.panelP95SlaMs = Number(next())
    else if (flag === '--min-rpm-ratio') args.minRpmRatio = Number(next())
    else if (flag === '--stop-on-knee') args.stopOnKnee = true
    else if (flag === '--skip-closed-loop') args.skipClosedLoop = true
    else if (flag === '--drain-timeout-ms') args.drainTimeoutMs = Number(next())
    else if (flag === '--out-report') args.outReport = next()
    else if (flag === '--label') args.label = next()
  }
  return args
}

const isDirectCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectCli) {
  ;(async () => {
    const args = parsePhase0Args()
    const { report, markdown } = await runPhase0({
      steps: args.steps,
      stepSec: args.stepSec,
      warmupSec: args.warmupSec,
      cooldownSec: args.cooldownSec,
      sutDir: args.sutDir,
      instances: args.instances,
      vms: args.vms,
      keys: args.keys,
      pgUrl: args.pgUrl,
      redisUrl: args.redisUrl,
      ttftMs: args.ttftMs,
      streamMs: args.streamMs,
      faultRate: args.faultRate,
      mockWorkers: args.mockWorkers,
      corpusPath: args.corpus,
      sessionPath: args.session,
      workers: args.workers,
      maxInflight: args.maxInflight,
      routing: args.routing,
      panelPollers: args.panelPollers,
      panelEnableWrites: args.panelWrites,
      p95OverheadSlaMs: args.p95OverheadSlaMs,
      panelP95SlaMs: args.panelP95SlaMs,
      minRpmRatio: args.minRpmRatio,
      stopOnKnee: args.stopOnKnee,
      skipClosedLoop: args.skipClosedLoop,
      drainTimeoutMs: args.drainTimeoutMs,
      outReport: args.outReport,
      label: args.label,
    })
    process.stdout.write(`${markdown}\n`)
    if (report.closedLoop && !report.closedLoop.passed) {
      process.exitCode = 2
    }
  })().catch((err) => {
    process.stderr.write(`${err?.stack || err?.message || String(err)}\n`)
    process.exitCode = 1
  })
}
