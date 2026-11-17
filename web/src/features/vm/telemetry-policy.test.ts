import type { CragTelemetryState, VmTelemetryState } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { telemetryLive } from './seed-settings'
import { telemetryEnabled, telemetrySeedFlags } from './telemetry-policy'
import {
  telemetryPolicyConfirmed,
  telemetryStatusLabel,
} from './telemetry-status'

describe('telemetry reads one bit', () => {
  it('is on only when telemetry_disabled is false', () => {
    expect(telemetryEnabled({ telemetry_disabled: false })).toBe(true)
    expect(telemetryEnabled({ telemetry_disabled: true })).toBe(false)
    expect(telemetryEnabled({})).toBe(false)
    expect(telemetryEnabled(undefined)).toBe(false)
    expect(telemetryEnabled({ telemetry_disabled: 'false' })).toBe(false)
  })

  it('derives the other flags from that bit', () => {
    expect(telemetrySeedFlags(true)).toEqual({
      telemetry_disabled: false,
      disable_nonessential_traffic: true,
      do_not_track: false,
    })
    expect(telemetrySeedFlags(false)).toEqual({
      telemetry_disabled: true,
      disable_nonessential_traffic: false,
      do_not_track: true,
    })
  })
})

describe('native policy acknowledgment', () => {
  const observed = (partial: Partial<VmTelemetryState>): VmTelemetryState => ({
    enabled: false,
    state: 'disabled',
    pending_events: 0,
    last_upload_at: null,
    last_error: null,
    ...partial,
  })

  it('does not overwrite an observed disabled state with desired opt-in', () => {
    const view = telemetryLive(
      { seed_policy: { telemetry_disabled: false } },
      observed({})
    )
    expect(view.desired).toBe(true)
    expect(view.on).toBe(false)
    expect(view.confirmed).toBe(false)
    expect(view.tone).toBe('unknown')
  })

  it('requires native disabled state and an empty queue to confirm opt-out', () => {
    expect(telemetryPolicyConfirmed(undefined, false)).toBe(false)
    expect(
      telemetryPolicyConfirmed(observed({ pending_events: 3 }), false)
    ).toBe(false)
    expect(
      telemetryPolicyConfirmed(
        observed({ enabled: true, state: 'uploading' }),
        false
      )
    ).toBe(false)
    expect(telemetryPolicyConfirmed(observed({}), false)).toBe(true)
  })

  it('does not confuse an applied but credential-gated policy with actual upload', () => {
    const view = telemetryLive(
      { seed_policy: { telemetry_disabled: false } },
      observed({ enabled: true, state: 'waiting_credentials' })
    )
    expect(view.confirmed).toBe(true)
    expect(view.on).toBe(true)
    expect(
      telemetryPolicyConfirmed(observed({ state: 'unsupported' }), false)
    ).toBe(false)
  })

  it('shows CRAG policy acknowledgment without claiming upload or queue state', () => {
    const crag: CragTelemetryState = {
      state: 'launch_policy',
      enabled: true,
      error: null,
      upload_confirmed: false,
    }
    expect(telemetryPolicyConfirmed(crag, true)).toBe(true)
    expect(telemetryStatusLabel(crag, true)).toContain('未验证上传')
    const disabled = { ...crag, enabled: false }
    expect(telemetryPolicyConfirmed(disabled, false)).toBe(true)
    expect(telemetryStatusLabel(disabled, false)).not.toContain('队列')
    const pending = { ...crag, enabled: null, error: '需要重启' }
    expect(telemetryPolicyConfirmed(pending, false)).toBe(false)
    expect(telemetryStatusLabel(pending, true)).toBe('需要重启')
  })
})
