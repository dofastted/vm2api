/**
 * Per-unit circuit breaker.
 *
 * One VM credential is one unit. Half-open admits a single probe; a second
 * caller stays out until that probe finishes. 401, model 429, and quota
 * windows must not be recorded here.
 *
 * State is process-local and mirrored onto account runtime `model_states.__circuit`
 * when a repo is attached. Operator `schedulable` is never toggled.
 */

const CIRCUIT_KEY = '__circuit'

export class UnitCircuit {
  constructor({ repo = null, failureThreshold = 3, openMs = 30_000, now = () => Date.now() } = {}) {
    this.repo = repo
    this.failureThreshold = Math.max(1, Number(failureThreshold) || 3)
    this.openMs = Math.max(1, Number(openMs) || 30_000)
    this.now = now
    this.units = new Map()
  }

  bindRepo(repo) {
    this.repo = repo || null
  }

  configure({ failureThreshold, openMs } = {}) {
    if (failureThreshold != null) this.failureThreshold = Math.max(1, Number(failureThreshold) || 3)
    if (openMs != null) this.openMs = Math.max(1000, Number(openMs) || 30_000)
  }

  snapshot(accountId) {
    return this.units.get(accountId) || this._load(accountId)
  }

  /**
   * Read the gate without taking the half-open probe. Eligibility scans every
   * VM; only reserve() may call admit().
   */
  inspect(accountId, now = this.now()) {
    if (!accountId) return { ok: true, state: 'closed' }
    const unit = this._ensure(accountId, now)
    if (unit.state === 'closed') return { ok: true, state: 'closed' }
    if (unit.state === 'open') {
      return { ok: false, reason: 'circuit_open', until: unit.openUntil, state: 'open' }
    }
    if (unit.probeHeld) {
      return { ok: false, reason: 'circuit_probe', until: now + this.openMs, state: 'half_open' }
    }
    return { ok: true, state: 'half_open', probeAvailable: true }
  }

  /**
   * @returns {{ ok: true, state: string, probe?: boolean } | { ok: false, reason: string, until: number, state: string }}
   */
  admit(accountId, now = this.now()) {
    if (!accountId) return { ok: true, state: 'closed' }
    const unit = this._ensure(accountId, now)
    if (unit.state === 'closed') return { ok: true, state: 'closed' }
    if (unit.state === 'open') {
      if (now < unit.openUntil) {
        return { ok: false, reason: 'circuit_open', until: unit.openUntil, state: 'open' }
      }
      unit.state = 'half_open'
      unit.probeHeld = false
      this._save(accountId, unit)
    }
    if (unit.probeHeld) {
      return { ok: false, reason: 'circuit_probe', until: now + this.openMs, state: 'half_open' }
    }
    unit.probeHeld = true
    this._save(accountId, unit)
    return { ok: true, state: 'half_open', probe: true }
  }

  recordFailure(accountId, now = this.now()) {
    if (!accountId) return null
    const unit = this._ensure(accountId, now)
    if (unit.state === 'open' && now < unit.openUntil) return unit
    unit.failures += 1
    unit.probeHeld = false
    if (unit.state === 'half_open' || unit.failures >= this.failureThreshold) {
      unit.state = 'open'
      unit.openUntil = now + this.openMs
      unit.failures = this.failureThreshold
    }
    this._save(accountId, unit)
    return { ...unit }
  }

  releaseProbe(accountId) {
    const unit = this.units.get(accountId)
    if (!unit?.probeHeld) return
    unit.probeHeld = false
    this.units.set(accountId, unit)
  }

  recordSuccess(accountId) {
    if (!accountId) return null
    const unit = this._ensure(accountId, this.now())
    if (unit.state === 'half_open' || unit.probeHeld) {
      unit.state = 'closed'
      unit.failures = 0
      unit.openUntil = 0
      unit.probeHeld = false
      this._save(accountId, unit)
      return { ...unit }
    }
    if (unit.failures) {
      unit.failures = 0
      this._save(accountId, unit)
    }
    return { ...unit }
  }

  /** Panel view. Reads without taking the probe; open past its window reads as half_open. */
  view(accountId, now = this.now()) {
    const unit = accountId ? this._ensure(accountId, now) : { state: 'closed', failures: 0, openUntil: 0 }
    return {
      state: unit.state,
      failures: unit.failures,
      threshold: this.failureThreshold,
      open_until: unit.state === 'open' ? unit.openUntil : null,
      open_ms: this.openMs,
    }
  }

  /** Operator reset: close the unit and clear the failure streak. */
  reset(accountId) {
    if (!accountId) return null
    const unit = { state: 'closed', failures: 0, openUntil: 0, probeHeld: false }
    this._save(accountId, unit)
    return { ...unit }
  }

  _ensure(accountId, now) {
    let unit = this.units.get(accountId)
    if (!unit) unit = this._load(accountId)
    if (unit.state === 'open' && unit.openUntil && now >= unit.openUntil) {
      unit.state = 'half_open'
      unit.probeHeld = false
    }
    this.units.set(accountId, unit)
    return unit
  }

  _load(accountId) {
    const blank = { state: 'closed', failures: 0, openUntil: 0, probeHeld: false }
    try {
      const row = this.repo?.get?.(accountId)
      const saved = row?.model_states?.[CIRCUIT_KEY]
      if (!saved || typeof saved !== 'object') return { ...blank }
      return {
        state: saved.state === 'open' || saved.state === 'half_open' ? saved.state : 'closed',
        failures: Number(saved.failures) || 0,
        openUntil: Number(saved.openUntil) || 0,
        probeHeld: false,
      }
    } catch {
      return { ...blank }
    }
  }

  _save(accountId, unit) {
    this.units.set(accountId, unit)
    if (!this.repo?.get || !this.repo?.upsert) return
    try {
      const row = this.repo.get(accountId)
      if (!row?.vm_id) return
      const model_states = { ...(row.model_states || {}) }
      model_states[CIRCUIT_KEY] = {
        state: unit.state,
        failures: unit.failures,
        openUntil: unit.openUntil || 0,
      }
      this.repo.upsert({
        account_id: accountId,
        vm_id: row.vm_id,
        model_states,
        status: unit.state === 'open' ? 'cooldown' : row.status || 'ready',
      })
    } catch {
      /* runtime row may not exist yet; memory still gates this process */
    }
  }
}

export const unitCircuit = new UnitCircuit()
