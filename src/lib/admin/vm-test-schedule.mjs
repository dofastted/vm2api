import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import { validTimezone } from '../core/timezone.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { getVm, listVms } from '../vm/vm-registry.mjs'
import { listTestableModels } from './vm-test-chat.mjs'

export const VM_TEST_SCHEDULE_PREFIX = 'vm_test_schedule:'
export const VM_TEST_SCHEDULE_DEFAULT_KEY = 'vm_test_schedule_default'

const MAX_CRON_LENGTH = 120
const MAX_MODEL_LENGTH = 200
const MAX_PROMPT_LENGTH = 16_000
const MAX_ERROR_LENGTH = 300
const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const FREQUENCIES = new Set(['hourly', 'daily', 'weekly'])
const DEFAULT_PROMPT = 'hello'
const DEFAULT_MAX_TOKENS = 64
const DEFAULT_REASONING_EFFORT = 'medium'
/** #979: a preheat keeps its own small defaults; the dialog stays optional. */
export const SCHEDULE_MODES = new Set(['test', 'preheat'])
const PREHEAT_MAX_TOKENS = 64
/** How often the auto-renew sweep looks for elapsed 5h windows (Croner unref'd). */
const PREHEAT_RENEW_SWEEP_SEC = 60

export class VmTestScheduleError extends Error {
  constructor(message, code = 'invalid_test_schedule', status = 400) {
    super(message)
    this.name = 'VmTestScheduleError'
    this.code = code
    this.status = status
  }
}

function keyFor(vmId) {
  return `${VM_TEST_SCHEDULE_PREFIX}${vmId}`
}

function parseTime(value) {
  const match = String(value || '')
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null
  return { hour, minute }
}

function formatTime(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function normalizeWeekdays(values) {
  if (values == null) return []
  const list = Array.isArray(values) ? values : [values]
  const out = new Set()
  for (const raw of list) {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      throw new VmTestScheduleError('weekdays must be integers from 0 (Sunday) to 6 (Saturday)')
    }
    out.add(n)
  }
  const sorted = [...out].sort((a, b) => a - b)
  if (!sorted.length) throw new VmTestScheduleError('weekly schedule requires at least one weekday')
  return sorted
}

export function normalizeScheduleStructure(input = {}) {
  const frequency = String(input.frequency || '').trim()
  if (!FREQUENCIES.has(frequency)) {
    throw new VmTestScheduleError('frequency must be hourly, daily, or weekly')
  }
  const timezone = validTimezone(input.timezone)
  if (!timezone) throw new VmTestScheduleError('timezone must be a valid IANA timezone')

  if (frequency === 'hourly') {
    let minute = input.minute == null ? 0 : Number(input.minute)
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new VmTestScheduleError('minute must be an integer from 0 to 59')
    }
    return { frequency, minute, timezone }
  }

  const time = parseTime(input.time)
  if (!time) throw new VmTestScheduleError('time must be HH:MM in 24-hour format')
  if (frequency === 'daily') {
    return { frequency, time: formatTime(time.hour, time.minute), timezone }
  }
  const weekdays = normalizeWeekdays(input.weekdays)
  return { frequency, time: formatTime(time.hour, time.minute), weekdays, timezone }
}

export function compileStructuredSchedule(structure) {
  const normalized = normalizeScheduleStructure(structure)
  if (normalized.frequency === 'hourly') {
    return `${normalized.minute} * * * *`
  }
  const { hour, minute } = parseTime(normalized.time)
  if (normalized.frequency === 'daily') {
    return `${minute} ${hour} * * *`
  }
  return `${minute} ${hour} * * ${normalized.weekdays.join(',')}`
}

function tokenIsInt(value) {
  return /^\d+$/.test(String(value))
}

function tokenIsStar(value) {
  return value === '*'
}

function tryParseStructuredCron(cron) {
  const parts = String(cron || '')
    .trim()
    .split(/\s+/)
  if (parts.length !== 5) return null
  const [minuteField, hourField, domField, monthField, dowField] = parts
  if (!tokenIsStar(domField) || !tokenIsStar(monthField)) return null

  if (tokenIsStar(hourField) && tokenIsStar(dowField) && tokenIsInt(minuteField)) {
    const minute = Number(minuteField)
    if (minute < 0 || minute > 59) return null
    return { frequency: 'hourly', minute }
  }

  if (tokenIsInt(minuteField) && tokenIsInt(hourField) && tokenIsStar(dowField)) {
    const minute = Number(minuteField)
    const hour = Number(hourField)
    if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null
    return { frequency: 'daily', time: formatTime(hour, minute) }
  }

  if (tokenIsInt(minuteField) && tokenIsInt(hourField) && !tokenIsStar(dowField)) {
    const minute = Number(minuteField)
    const hour = Number(hourField)
    if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null
    const weekdays = dowField
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        if (!tokenIsInt(part)) return NaN
        return Number(part)
      })
    if (weekdays.some((n) => !Number.isInteger(n) || n < 0 || n > 6)) return null
    const unique = [...new Set(weekdays)].sort((a, b) => a - b)
    if (!unique.length) return null
    return { frequency: 'weekly', time: formatTime(hour, minute), weekdays: unique }
  }

  return null
}

function assertCron(cron, timezone) {
  if (cron.length > MAX_CRON_LENGTH || cron.trim().split(/\s+/).length !== 5) {
    throw new VmTestScheduleError('cron must be a five-field expression')
  }
  let validator
  try {
    validator = new Cron(cron, { timezone, mode: '5-part', paused: true })
    if (!validator.nextRun()) throw new Error('no upcoming run')
  } catch (error) {
    throw new VmTestScheduleError(`invalid cron: ${String(error?.message || error).slice(0, 180)}`)
  } finally {
    validator?.stop()
  }
}

function defaultDialogParams(vm) {
  const models = listTestableModels(isCodexVm(vm) ? 'openai' : 'anthropic')
  const model = models[0]?.id || ''
  if (!model) {
    throw new VmTestScheduleError('no test model available for this vm', 'test_model_missing', 400)
  }
  if (isCodexVm(vm)) {
    return { model, prompt: DEFAULT_PROMPT, max_tokens: null, reasoning_effort: DEFAULT_REASONING_EFFORT }
  }
  return { model, prompt: DEFAULT_PROMPT, max_tokens: DEFAULT_MAX_TOKENS, reasoning_effort: null }
}

export function normalizeVmTestSchedule(input, vm) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new VmTestScheduleError('request body must be an object')
  }

  const enabled = input.enabled == null ? false : input.enabled
  if (typeof enabled !== 'boolean') throw new VmTestScheduleError('enabled must be a boolean')

  // #979: 'test' keeps the old behaviour; 'preheat' sends the same tiny real
  // request but skips when the window is already live. Unknown values reject.
  const mode = input.mode == null ? 'test' : String(input.mode)
  if (!SCHEDULE_MODES.has(mode)) throw new VmTestScheduleError('mode must be test or preheat')
  const autoRenew = input.auto_renew === true
  if (autoRenew && mode !== 'preheat') {
    throw new VmTestScheduleError('auto_renew requires mode=preheat')
  }

  let structure
  if (input.frequency != null) {
    structure = normalizeScheduleStructure(input)
  } else if (input.cron != null) {
    const timezone = validTimezone(input.timezone)
    if (!timezone) throw new VmTestScheduleError('timezone must be a valid IANA timezone')
    const parsed = tryParseStructuredCron(String(input.cron || '').trim())
    if (!parsed) {
      throw new VmTestScheduleError(
        'cron is not compatible with structured schedules; please re-select frequency and time',
      )
    }
    structure = normalizeScheduleStructure({ ...parsed, timezone })
  } else {
    throw new VmTestScheduleError('frequency is required')
  }

  const cron = compileStructuredSchedule(structure)
  assertCron(cron, structure.timezone)

  const model = String(input.model || '').trim()
  if (!model || model.length > MAX_MODEL_LENGTH) {
    throw new VmTestScheduleError('model is required and must be at most 200 characters')
  }
  const prompt = String(input.prompt ?? '').trim()
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
    throw new VmTestScheduleError('prompt is required and must be at most 16000 characters')
  }

  let maxTokens = input.max_tokens == null ? null : input.max_tokens
  if (maxTokens != null && (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 128_000)) {
    throw new VmTestScheduleError('max_tokens must be an integer from 1 to 128000')
  }

  let reasoningEffort = input.reasoning_effort == null ? null : String(input.reasoning_effort).trim()
  if (reasoningEffort === '') reasoningEffort = null
  if (reasoningEffort != null && !REASONING_EFFORTS.has(reasoningEffort)) {
    throw new VmTestScheduleError('reasoning_effort must be none, low, medium, high, xhigh, max, or ultra')
  }
  if (isCodexVm(vm)) {
    if (maxTokens != null || reasoningEffort == null) {
      throw new VmTestScheduleError('Codex schedules require reasoning_effort and omit max_tokens')
    }
  } else if (maxTokens == null || reasoningEffort != null) {
    throw new VmTestScheduleError('Claude schedules require max_tokens and omit reasoning_effort')
  }

  return {
    enabled,
    mode,
    auto_renew: autoRenew,
    ...structure,
    cron,
    model,
    prompt,
    max_tokens: maxTokens,
    reasoning_effort: reasoningEffort,
  }
}

/** Validated once before any slot is written, so a bad request never half-applies. */
function normalizeSyncTest(test, structure) {
  if (!test || typeof test !== 'object' || Array.isArray(test)) {
    throw new VmTestScheduleError('test must be an object')
  }
  if (typeof test.enabled !== 'boolean') throw new VmTestScheduleError('test.enabled must be a boolean')
  const codex = test.reasoning_effort != null && String(test.reasoning_effort).trim() !== ''
  const config = normalizeVmTestSchedule(
    {
      enabled: test.enabled,
      ...structure,
      model: test.model,
      prompt: test.prompt,
      max_tokens: test.max_tokens ?? null,
      reasoning_effort: test.reasoning_effort ?? null,
    },
    { platform: codex ? 'openai' : 'anthropic' },
  )
  return {
    enabled: config.enabled,
    codex,
    dialog: {
      model: config.model,
      prompt: config.prompt,
      max_tokens: config.max_tokens,
      reasoning_effort: config.reasoning_effort,
    },
  }
}

function compactError(error) {
  const code = String(error?.code || 'test_failed')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, 64)
  const message = String(error?.message || 'scheduled test failed')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
  return `${code}: ${message}`.slice(0, MAX_ERROR_LENGTH)
}

function nullableIso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString()
}

/** A preheat gate must never crash scheduling; probe failures read as unknown. */
function safeCall(fn) {
  try {
    return fn()
  } catch {
    return null
  }
}

function savedResult(raw = {}) {
  return {
    last_run_at: nullableIso(raw.last_run_at),
    last_ok: typeof raw.last_ok === 'boolean' ? raw.last_ok : null,
    last_duration_ms:
      Number.isSafeInteger(raw.last_duration_ms) && raw.last_duration_ms >= 0 ? raw.last_duration_ms : null,
    last_error:
      raw.last_error == null
        ? null
        : String(raw.last_error)
            .replace(/[\r\n\t]/g, ' ')
            .slice(0, MAX_ERROR_LENGTH),
    last_skipped: raw.last_skipped == null ? null : String(raw.last_skipped).slice(0, 64),
  }
}

function structureFromStored(raw, vm) {
  if (raw.frequency && FREQUENCIES.has(String(raw.frequency))) {
    try {
      return normalizeScheduleStructure({
        frequency: raw.frequency,
        minute: raw.minute,
        time: raw.time,
        weekdays: raw.weekdays,
        timezone: raw.timezone,
      })
    } catch {
      return { parse_error: true }
    }
  }
  const cron = String(raw.cron || '').trim()
  const timezone = validTimezone(raw.timezone)
  if (!cron || !timezone) return { parse_error: true }
  const parsed = tryParseStructuredCron(cron)
  if (!parsed) return { parse_error: true }
  try {
    return normalizeScheduleStructure({ ...parsed, timezone })
  } catch {
    return { parse_error: true }
  }
}

function publicStructure(structure) {
  if (structure?.parse_error) {
    return { parse_error: true, frequency: 'daily', time: '09:00', timezone: 'Asia/Shanghai' }
  }
  return structure
}

export class VmTestScheduleRunner {
  constructor({
    projectRoot,
    settings = () => null,
    runTest,
    list = () => listVms(projectRoot),
    now = () => Date.now(),
    /**
     * #979 preheat gates. Both are optional; without them a preheat plan
     * behaves like a plain scheduled test (always fires).
     *   windowState(vmId) -> { hasCredential, schedulable, windowLive, reason }
     *   nextWindowEnd(vmId) -> ms epoch of the recorded 5h reset, or null
     */
    windowState = null,
    nextWindowEnd = null,
  } = {}) {
    this.projectRoot = projectRoot
    this.settingsFactory = typeof settings === 'function' ? settings : () => settings
    this.runTest = runTest
    this.listVms = list
    this.now = now
    this.windowState = typeof windowState === 'function' ? windowState : null
    this.nextWindowEnd = typeof nextWindowEnd === 'function' ? nextWindowEnd : null
    this.jobs = new Map()
    this.running = new Set()
    this.started = false
    this.renewSweep = null
    /** vmId -> ms, when the auto-renew sweep last fired this slot. */
    this.renewFiredAt = new Map()
  }

  _settings() {
    const settings = this.settingsFactory()
    if (!settings || typeof settings.get !== 'function' || typeof settings.set !== 'function') {
      throw new Error('VM test schedule settings store is unavailable')
    }
    return settings
  }

  _vm(vmId) {
    return this.listVms().find((vm) => vm.id === vmId) || getVm(this.projectRoot, vmId)
  }

  _stored(vmId) {
    const raw = this._settings().get(keyFor(vmId))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const vm = this._vm(vmId)
    if (!vm) return null
    try {
      const structure = structureFromStored(raw, vm)
      if (structure.parse_error) return null
      const cron = String(raw.cron || compileStructuredSchedule(structure))
      assertCron(cron, structure.timezone)
      return {
        enabled: raw.enabled === true,
        mode: SCHEDULE_MODES.has(String(raw.mode)) ? String(raw.mode) : 'test',
        auto_renew: raw.auto_renew === true,
        ...structure,
        cron,
        model: String(raw.model || ''),
        prompt: String(raw.prompt || ''),
        max_tokens: raw.max_tokens ?? null,
        reasoning_effort: raw.reasoning_effort ?? null,
        ...savedResult(raw),
        revision: String(raw.revision || ''),
      }
    } catch {
      return null
    }
  }

  getDefaultTemplate() {
    const raw = this._settings().get(VM_TEST_SCHEDULE_DEFAULT_KEY)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    try {
      return normalizeScheduleStructure(raw)
    } catch {
      return null
    }
  }

  saveDefaultTemplate(input) {
    const structure = normalizeScheduleStructure(input)
    compileStructuredSchedule(structure)
    this._settings().set(VM_TEST_SCHEDULE_DEFAULT_KEY, structure)
    return structure
  }

  clearDefaultTemplate() {
    this._settings().remove?.(VM_TEST_SCHEDULE_DEFAULT_KEY)
    return null
  }

  _nextRun(schedule, job = this.jobs.get(schedule.vm_id)) {
    if (!schedule.enabled) return null
    let next = null
    try {
      next = job?.nextRun?.() || null
      if (!job) {
        const probe = new Cron(schedule.cron, {
          timezone: schedule.timezone,
          mode: '5-part',
          paused: true,
        })
        next = probe.nextRun()
        probe.stop()
      }
    } catch {}
    return next instanceof Date && Number.isFinite(next.getTime()) ? next.toISOString() : null
  }

  _public(vmId, schedule, raw = null) {
    if (!schedule && raw) {
      const structure = structureFromStored(raw, this._vm(vmId))
      return {
        parse_error: !!structure.parse_error,
        ...publicStructure(structure),
        enabled: raw.enabled === true,
        mode: SCHEDULE_MODES.has(String(raw.mode)) ? String(raw.mode) : 'test',
        auto_renew: raw.auto_renew === true,
        model: String(raw.model || ''),
        prompt: String(raw.prompt || ''),
        max_tokens: raw.max_tokens ?? null,
        reasoning_effort: raw.reasoning_effort ?? null,
        last_run_at: nullableIso(raw.last_run_at),
        last_ok: typeof raw.last_ok === 'boolean' ? raw.last_ok : null,
        last_duration_ms:
          Number.isSafeInteger(raw.last_duration_ms) && raw.last_duration_ms >= 0 ? raw.last_duration_ms : null,
        last_error: raw.last_error ?? null,
        last_skipped: raw.last_skipped || null,
        next_run_at: null,
        running: this.running.has(vmId),
      }
    }
    if (!schedule) return null
    const { cron: _cron, revision: _revision, ...rest } = schedule
    return {
      ...rest,
      parse_error: false,
      last_skipped: schedule.last_skipped || null,
      next_run_at: this._nextRun({ ...schedule, vm_id: vmId }),
      running: this.running.has(vmId),
    }
  }

  get(vmId) {
    const raw = this._settings().get(keyFor(vmId))
    const schedule = this._stored(vmId)
    if (schedule) return this._public(vmId, schedule)
    if (raw && typeof raw === 'object') return this._public(vmId, null, raw)
    return null
  }

  save(vmId, input) {
    if (!isValidVmId(vmId)) throw new VmTestScheduleError('invalid vm id', 'invalid_vm_id')
    const vm = this._vm(vmId)
    if (!vm) throw new VmTestScheduleError('vm not found', 'vm_not_found', 404)
    const previous = this._settings().get(keyFor(vmId)) || {}
    const config = normalizeVmTestSchedule(input, vm)
    this._settings().set(keyFor(vmId), { ...config, ...savedResult(previous), revision: randomUUID() })
    if (this.started) this._syncJob(vmId, config)
    return this.get(vmId)
  }

  applyScheduleStructure(vmId, structure, { preserveDialog = true } = {}) {
    if (!isValidVmId(vmId)) throw new VmTestScheduleError('invalid vm id', 'invalid_vm_id')
    const vm = this._vm(vmId)
    if (!vm) throw new VmTestScheduleError('vm not found', 'vm_not_found', 404)
    const normalized = normalizeScheduleStructure(structure)
    const cron = compileStructuredSchedule(normalized)
    assertCron(cron, normalized.timezone)
    const previous = this._settings().get(keyFor(vmId)) || {}
    let dialog
    if (preserveDialog && previous.model && previous.prompt) {
      dialog = {
        model: previous.model,
        prompt: previous.prompt,
        max_tokens: previous.max_tokens ?? null,
        reasoning_effort: previous.reasoning_effort ?? null,
      }
    } else {
      dialog = defaultDialogParams(vm)
    }
    const enabled = previous.enabled === true
    const config = normalizeVmTestSchedule(
      {
        enabled,
        ...normalized,
        ...dialog,
      },
      vm,
    )
    this._settings().set(keyFor(vmId), {
      ...config,
      enabled,
      ...savedResult(previous),
      revision: randomUUID(),
    })
    if (this.started) this._syncJob(vmId, config)
    return this.get(vmId)
  }

  /**
   * `test` copies the whole scheduled test (switch, model, prompt, token/effort).
   * A slot of the other kind (Claude vs Codex) keeps its own dialog params, since
   * a model of one kind cannot run on the other; switch and timing still apply.
   */
  syncSchedules({ scope, vmIds = [], schedule, test = null }) {
    const structure = normalizeScheduleStructure(schedule)
    const full = test == null ? null : normalizeSyncTest(test, structure)
    let targets = []
    if (scope === 'all') {
      targets = this.listVms().map((vm) => vm.id)
    } else if (scope === 'ids') {
      targets = [...new Set(vmIds.map((id) => String(id || '').trim()).filter(Boolean))]
      if (!targets.length) throw new VmTestScheduleError('vm_ids is required when scope is ids')
    } else {
      throw new VmTestScheduleError('scope must be all or ids')
    }

    const updated = []
    const missing = []
    for (const vmId of targets) {
      if (!this._vm(vmId)) {
        missing.push(vmId)
        continue
      }
      if (full) {
        this._applyFullTest(vmId, structure, full)
        updated.push(vmId)
        continue
      }
      const hadPlan = !!this._settings().get(keyFor(vmId))
      this.applyScheduleStructure(vmId, structure, { preserveDialog: hadPlan })
      if (!hadPlan) {
        const stored = this._settings().get(keyFor(vmId))
        if (stored) {
          this._settings().set(keyFor(vmId), { ...stored, enabled: false })
          this.jobs.get(vmId)?.stop()
          this.jobs.delete(vmId)
        }
      }
      updated.push(vmId)
    }
    return { updated, missing, schedule: structure }
  }

  _applyFullTest(vmId, structure, full) {
    const vm = this._vm(vmId)
    const previous = this._settings().get(keyFor(vmId)) || {}
    let dialog
    if (isCodexVm(vm) === full.codex) dialog = full.dialog
    else if (previous.model && previous.prompt) {
      dialog = {
        model: previous.model,
        prompt: previous.prompt,
        max_tokens: previous.max_tokens ?? null,
        reasoning_effort: previous.reasoning_effort ?? null,
      }
    } else dialog = defaultDialogParams(vm)
    const config = normalizeVmTestSchedule({ enabled: full.enabled, ...structure, ...dialog }, vm)
    this._settings().set(keyFor(vmId), { ...config, ...savedResult(previous), revision: randomUUID() })
    if (this.started) this._syncJob(vmId, config)
  }

  remove(vmId) {
    this.jobs.get(vmId)?.stop()
    this.jobs.delete(vmId)
    this._settings().remove?.(keyFor(vmId))
    return null
  }

  start() {
    this.started = true
    this.reload()
    this._startRenewSweep()
  }

  stop() {
    this.started = false
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()
    this._stopRenewSweep()
  }

  /**
   * #979 auto-renew: once the recorded 5h window has elapsed, fire one
   * preheat so the next window starts instead of waiting for the first
   * business request. The sweep itself is cheap (settings scan + probe);
   * the fired request reuses the same runTest path and window gates.
   */
  _startRenewSweep() {
    this._stopRenewSweep()
    if (!this.nextWindowEnd) return
    this.renewSweep = new Cron(
      `*/${PREHEAT_RENEW_SWEEP_SEC} * * * * *`,
      { mode: '6-part', catch: true, unref: true },
      () => this._sweepElapsedWindows().catch(() => {}),
    )
  }

  _stopRenewSweep() {
    this.renewSweep?.stop?.()
    this.renewSweep = null
    this.renewFiredAt.clear()
  }

  async _sweepElapsedWindows() {
    if (!this.started) return
    const all = this._settings().all?.() || {}
    const now = this.now()
    for (const key of Object.keys(all)) {
      if (!key.startsWith(VM_TEST_SCHEDULE_PREFIX)) continue
      const vmId = key.slice(VM_TEST_SCHEDULE_PREFIX.length)
      const raw = all[key]
      if (!raw || raw.enabled !== true || raw.auto_renew !== true) continue
      const endMs = safeCall(() => this.nextWindowEnd(vmId))
      if (!Number.isFinite(endMs) || endMs <= 0) continue
      // Fire once per elapsed window: arm again only after a fresh end is seen.
      const firedAt = this.renewFiredAt.get(vmId) || 0
      if (firedAt >= endMs) continue
      if (endMs > now) continue
      if (!this._vm(vmId)) continue
      this.renewFiredAt.set(vmId, endMs)
      await this._run(vmId)
    }
  }

  reload() {
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()
    const all = this._settings().all?.() || {}
    for (const key of Object.keys(all)) {
      if (!key.startsWith(VM_TEST_SCHEDULE_PREFIX)) continue
      const vmId = key.slice(VM_TEST_SCHEDULE_PREFIX.length)
      const vm = this._vm(vmId)
      if (!vm) {
        this._settings().remove?.(key)
        continue
      }
      const schedule = this._stored(vmId)
      if (schedule?.enabled) this._syncJob(vmId, schedule)
    }
  }

  _syncJob(vmId, schedule) {
    this.jobs.get(vmId)?.stop()
    this.jobs.delete(vmId)
    if (!this.started || !schedule.enabled || !this._vm(vmId)) return
    const job = new Cron(schedule.cron, { timezone: schedule.timezone, mode: '5-part', catch: true, unref: true }, () =>
      this._run(vmId),
    )
    this.jobs.set(vmId, job)
  }

  async _run(vmId) {
    if (!this.started || this.running.has(vmId)) return
    if (!this._vm(vmId)) {
      this.remove(vmId)
      return
    }
    const schedule = this._stored(vmId)
    if (!schedule?.enabled) return
    const startedAt = this.now()
    // #979: a preheat never fires into a live window, and never retries a
    // slot the pool already parked (no ticket, dead grant, 不可调度).
    if (schedule.mode === 'preheat') {
      const gate = this._preheatGate(vmId)
      if (!gate.fire) {
        this._recordRun(vmId, schedule, startedAt, { ok: null, skipped: gate.reason })
        return
      }
    }
    this.running.add(vmId)
    let result
    try {
      result = await this.runTest(vmId, {
        model: schedule.model,
        prompt: schedule.prompt,
        max_tokens: schedule.max_tokens,
        reasoning_effort: schedule.reasoning_effort,
      })
    } catch (error) {
      result = { ok: false, error }
    } finally {
      this.running.delete(vmId)
    }
    if (!this.started) return
    this._recordRun(vmId, schedule, startedAt, result)
  }

  /** Why a preheat did not fire: { fire: false, reason } or { fire: true }. */
  _preheatGate(vmId) {
    const probe = this.windowState ? safeCall(() => this.windowState(vmId)) : null
    if (probe && probe.hasCredential === false) return { fire: false, reason: 'no_credential' }
    if (probe && probe.schedulable === false) return { fire: false, reason: 'slot_not_schedulable' }
    if (probe && probe.windowLive === true) return { fire: false, reason: 'window_live' }
    return { fire: true }
  }

  /** Persist last_run_* fields. A skipped preheat keeps ok=null + reason. */
  _recordRun(vmId, schedule, startedAt, result) {
    const current = this._settings().get(keyFor(vmId))
    if (!current || String(current.revision || '') !== schedule.revision || !this._vm(vmId)) return
    const duration = Number(result?.duration_ms)
    const lastDuration =
      Number.isSafeInteger(duration) && duration >= 0 ? duration : Math.max(0, this.now() - startedAt)
    const skipped = result?.skipped || null
    const lastOk = skipped ? null : result?.ok === true
    this._settings().set(keyFor(vmId), {
      ...current,
      last_run_at: new Date(startedAt).toISOString(),
      last_ok: lastOk,
      last_duration_ms: lastDuration,
      last_error: lastOk === false ? compactError(result?.error) : skipped ? `skipped: ${skipped}` : null,
      last_skipped: skipped,
    })
  }
}
