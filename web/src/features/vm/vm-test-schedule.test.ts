import { describe, expect, it } from 'vitest'
import {
  reconcileSchedule,
  type FormState,
  type TestSchedule,
} from './vm-test-schedule'

const stored = (over: Partial<TestSchedule> = {}): TestSchedule => ({
  enabled: false,
  frequency: 'hourly',
  minute: 0,
  timezone: 'Asia/Shanghai',
  model: 'claude-haiku-5-5',
  prompt: 'hello',
  max_tokens: 64,
  reasoning_effort: null,
  last_run_at: null,
  last_ok: null,
  last_duration_ms: null,
  last_error: null,
  next_run_at: null,
  running: false,
  ...over,
})

const formOf = (s: TestSchedule, over: Partial<FormState> = {}): FormState => ({
  enabled: s.enabled,
  structure: {
    frequency: s.frequency,
    minute: s.minute,
    time: '09:00',
    weekdays: [1],
    timezone: s.timezone,
  },
  model: s.model,
  prompt: s.prompt,
  maxTokens: s.max_tokens ?? 0,
  reasoningEffort: '',
  codex: false,
  ...over,
})

describe('scheduled test form follows changes made elsewhere', () => {
  it('a plan enabled elsewhere replaces an untouched form', () => {
    const base = stored()
    expect(
      reconcileSchedule(formOf(base), base, stored({ enabled: true }))
    ).toBe('adopt')
  })

  it('a refresh with the same plan or bookkeeping-only changes keeps the form', () => {
    const base = stored()
    expect(
      reconcileSchedule(
        formOf(base),
        base,
        stored({ last_run_at: '2026-10-18T00:00:00Z', last_ok: true })
      )
    ).toBe('keep')
  })

  it('never overwrites edits in progress; warns instead', () => {
    const base = stored()
    const editing = formOf(base, { prompt: 'edited' })
    expect(reconcileSchedule(editing, base, stored({ enabled: true }))).toBe(
      'stale'
    )
  })

  it('after a sync the form already shows the new plan', () => {
    const base = stored()
    const next = stored({ enabled: true })
    expect(reconcileSchedule(formOf(next), base, next)).toBe('track')
  })

  it('extra prompts and interval timing count as plan content', () => {
    const base = stored({
      frequency: 'interval',
      time: '09:00',
      interval_minutes: 300,
      jitter_min_minutes: 0,
      jitter_max_minutes: 60,
      prompts: ['hello', 'second'],
    })
    const form = formOf(base, {
      structure: {
        frequency: 'interval',
        time: '09:00',
        interval_minutes: 300,
        jitter_min_minutes: 0,
        jitter_max_minutes: 60,
        timezone: base.timezone,
      },
      extraPrompts: ['second'],
    })
    expect(reconcileSchedule(form, base, base)).toBe('keep')
    const moved = stored({ ...base, interval_minutes: 120 })
    expect(reconcileSchedule(form, base, moved)).toBe('adopt')
    expect(
      reconcileSchedule({ ...form, extraPrompts: ['other'] }, base, moved)
    ).toBe('stale')
  })
})
