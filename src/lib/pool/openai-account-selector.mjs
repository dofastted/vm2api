/**
 * OpenAI account decision, ported from codex-proxy-rs
 * `gateway-core` AccountSelector (`selection.rs`).
 *
 * Eligibility, then session affinity as a preferred account, then the
 * highest weight band. `smart` is the default strategy.
 */

export const SMART_LOAD_WEIGHT = 1
export const SMART_QUOTA_WEIGHT = 0.8
export const SMART_FAILURE_WEIGHT = 1
export const SMART_LATENCY_WEIGHT = 0.5
export const SMART_SCORE_TOLERANCE = 0.05
export const SMART_LATENCY_HALF_SCORE_MS = 10_000

const STRATEGIES = new Set(['smart', 'quota_reset_priority', 'round_robin', 'sticky'])

function asId(value) {
  return String(value || '')
}

function weightOf(candidate) {
  const weight = Number(candidate?.weight)
  if (!Number.isFinite(weight)) return 1
  return weight
}

function effectiveConcurrency(candidate, fallback) {
  const own = Number(candidate?.concurrency)
  const cap = Number.isFinite(own) && own > 0 ? own : Number(fallback)
  if (!Number.isFinite(cap) || cap <= 0) return 1
  return cap
}

export function capacityUtilization(candidate, defaultConcurrency) {
  return Number(candidate?.inFlight || 0) / effectiveConcurrency(candidate, defaultConcurrency)
}

export function smartScore(candidate, defaultConcurrency) {
  const load = 1 - Math.min(1, Math.max(0, capacityUtilization(candidate, defaultConcurrency)))
  const rank = candidate?.quotaRemainingRank
  const quota =
    rank == null || !Number.isFinite(Number(rank)) ? 0.5 : Math.min(10_000, Math.max(0, Number(rank))) / 10_000
  const failureBps = Math.min(10_000, Math.max(0, Number(candidate?.failureRateBps || 0)))
  const failure = 1 - failureBps / 10_000
  const latencyMs = Number(candidate?.firstOutputLatencyMs)
  const latency =
    Number.isFinite(latencyMs) && latencyMs > 0
      ? SMART_LATENCY_HALF_SCORE_MS / (SMART_LATENCY_HALF_SCORE_MS + latencyMs)
      : 1
  return (
    SMART_LOAD_WEIGHT * load +
    SMART_QUOTA_WEIGHT * quota +
    SMART_FAILURE_WEIGHT * failure +
    SMART_LATENCY_WEIGHT * latency
  )
}

export function schedulingBlocker(candidate, context = {}) {
  const scope = context.accountScope
  if (scope && typeof scope.allows === 'function' && !scope.allows(candidate.id)) {
    return 'outside_scope'
  }
  if (context.eligibility !== 'bypass' && String(candidate.status || 'normal') !== 'normal') {
    return 'local_availability'
  }
  const excluded = context.excludedAccountIds
  if (excluded && excluded.has(candidate.id)) return 'excluded'
  const cap = effectiveConcurrency(candidate, context.maxConcurrent)
  if (Number(candidate.inFlight || 0) >= cap) return 'concurrency_limit'
  const interval = Number(context.requestIntervalMs) || 0
  const started = Number(candidate.lastStartedAt)
  if (interval > 0 && Number.isFinite(started)) {
    const now = Number(context.now) || 0
    if (!(now - started >= interval)) return 'request_interval'
  }
  return null
}

function preferredOutcome(candidates, context, highestWeight) {
  const preferredId = context.preferredAccountId ? asId(context.preferredAccountId) : ''
  if (!preferredId) return { kind: 'not_requested', candidate: null, blocker: null }
  const candidate = candidates.find((item) => asId(item.id) === preferredId) || null
  if (!candidate) return { kind: 'missing', candidate: null, blocker: null }
  const blocker = schedulingBlocker(candidate, context)
  if (blocker) return { kind: 'blocked', candidate, blocker }
  if (!context.preferredOverridesWeight && weightOf(candidate) < highestWeight) {
    return { kind: 'blocked', candidate, blocker: 'lower_weight' }
  }
  return { kind: 'hit', candidate, blocker: null }
}

function selectInBand(eligible, context) {
  const strategy = STRATEGIES.has(context.strategy) ? context.strategy : 'smart'
  const fallbackConcurrency = context.maxConcurrent
  if (strategy === 'quota_reset_priority') {
    const ranked = [...eligible].sort((left, right) => {
      const leftReset = Number(left.quotaResetAt)
      const rightReset = Number(right.quotaResetAt)
      const leftMissing = !Number.isFinite(leftReset)
      const rightMissing = !Number.isFinite(rightReset)
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1
      if (!leftMissing && leftReset !== rightReset) return leftReset - rightReset
      const load = capacityUtilization(left, fallbackConcurrency) - capacityUtilization(right, fallbackConcurrency)
      if (load !== 0) return load
      const leftStarted = Number(left.lastStartedAt)
      const rightStarted = Number(right.lastStartedAt)
      const leftStartedMissing = !Number.isFinite(leftStarted)
      const rightStartedMissing = !Number.isFinite(rightStarted)
      if (leftStartedMissing !== rightStartedMissing) return leftStartedMissing ? -1 : 1
      if (!leftStartedMissing && leftStarted !== rightStarted) return leftStarted - rightStarted
      return asId(left.id).localeCompare(asId(right.id))
    })
    return ranked[0] || null
  }
  if (strategy === 'round_robin') {
    const ranked = [...eligible].sort((left, right) => asId(left.id).localeCompare(asId(right.id)))
    const cursor = Number(context.roundRobinCursor) || 0
    return ranked[cursor % ranked.length] || null
  }
  if (strategy === 'sticky') {
    const ranked = [...eligible].sort((left, right) => {
      const leftStarted = Number(left.lastStartedAt)
      const rightStarted = Number(right.lastStartedAt)
      const leftMissing = !Number.isFinite(leftStarted)
      const rightMissing = !Number.isFinite(rightStarted)
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1
      if (!leftMissing && leftStarted !== rightStarted) return rightStarted - leftStarted
      return asId(left.id).localeCompare(asId(right.id))
    })
    return ranked[0] || null
  }
  const scored = eligible.map((candidate) => ({
    candidate,
    score: smartScore(candidate, fallbackConcurrency),
  }))
  const best = scored.reduce((max, item) => (item.score > max ? item.score : max), -Infinity)
  const band = scored
    .filter((item) => best - item.score <= SMART_SCORE_TOLERANCE)
    .sort((left, right) => asId(left.candidate.id).localeCompare(asId(right.candidate.id)))
  const cursor = Number(context.roundRobinCursor) || 0
  return band[cursor % band.length]?.candidate || null
}

/**
 * One decision. `preferred` is `hit` when session affinity wins outright.
 */
export function selectOpenAIAccount(candidates, context = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  const eligible = list.filter((candidate) => !schedulingBlocker(candidate, context))
  if (!eligible.length) return null
  const highestWeight = eligible.reduce((max, candidate) => Math.max(max, weightOf(candidate)), -Infinity)
  const preferred = preferredOutcome(list, context, highestWeight)
  if (preferred.kind === 'hit') {
    return { candidate: preferred.candidate, preferred: 'hit', blocker: null }
  }
  const band = eligible.filter((candidate) => weightOf(candidate) === highestWeight)
  const candidate = selectInBand(band, context)
  if (!candidate) return null
  return {
    candidate,
    preferred: preferred.kind,
    blocker: preferred.blocker,
  }
}

/** Failover order: affinity first, then the same decision with that id excluded. */
export function orderOpenAIAccounts(candidates, context = {}) {
  const excluded = new Set(context.excludedAccountIds || [])
  const ids = []
  let preferred = context.preferredAccountId || null
  let outcome = 'not_requested'
  let blocker = null
  let cursor = Number(context.roundRobinCursor) || 0
  const pool = Array.isArray(candidates) ? candidates : []
  while (ids.length < pool.length) {
    const selection = selectOpenAIAccount(pool, {
      ...context,
      excludedAccountIds: excluded,
      preferredAccountId: preferred,
      roundRobinCursor: cursor,
    })
    if (!selection) break
    if (!ids.length) {
      outcome = selection.preferred
      blocker = selection.blocker
    }
    const id = asId(selection.candidate.id)
    ids.push(id)
    excluded.add(id)
    preferred = null
    cursor += 1
  }
  return { ids, preferred: outcome, blocker, cursor }
}
