import type { CragTelemetryState, Vm, VmTelemetryState } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { slotState } from '@/features/settings/telemetry-slot-state'
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

  it('shows CRAG policy acknowledgment and real upload verification states', () => {
    const legacyCrag: CragTelemetryState = {
      state: 'launch_policy',
      enabled: true,
      error: null,
      upload_confirmed: false,
    }
    expect(telemetryPolicyConfirmed(legacyCrag, true)).toBe(true)
    expect(telemetryStatusLabel(legacyCrag, true)).toContain('未验证上传')

    const waitingCrag: CragTelemetryState = {
      ...legacyCrag,
      upload_supported: true,
      last_upload_at: null,
      last_error: null,
    }
    expect(telemetryStatusLabel(waitingCrag, true)).toContain('等待首次上传')

    const verifiedCrag: CragTelemetryState = {
      ...waitingCrag,
      upload_confirmed: true,
      last_upload_at: '2026-11-26T00:05:00.000Z',
    }
    expect(telemetryStatusLabel(verifiedCrag, true)).toContain('已验证上传')

    const failedCrag: CragTelemetryState = {
      ...waitingCrag,
      upload_confirmed: false,
      last_error: 'http_403',
    }
    expect(telemetryStatusLabel(failedCrag, true)).toBe(
      'CRAG 上传失败 · http_403'
    )

    const vm: Vm = {
      id: 'vm-crag-01',
      status: 'running',
      resolved_dataplane: 'crag',
      seed_policy: { telemetry_disabled: false },
    }
    expect(
      slotState(vm, {
        data: { vm, kernel: { telemetry: verifiedCrag } },
        isPending: false,
        isError: false,
      }).live
    ).toBe('live')
    expect(
      slotState(vm, {
        data: { vm, kernel: { telemetry: failedCrag } },
        isPending: false,
        isError: false,
      }).live
    ).toBe('blocked')
    expect(
      slotState(vm, {
        data: { vm, kernel: { telemetry: waitingCrag } },
        isPending: false,
        isError: false,
      }).live
    ).toBe('policy')

    const disabled = { ...legacyCrag, enabled: false }
    expect(telemetryPolicyConfirmed(disabled, false)).toBe(true)
    expect(telemetryStatusLabel(disabled, false)).not.toContain('队列')
    const pending = { ...legacyCrag, enabled: null, error: '需要重启' }
    expect(telemetryPolicyConfirmed(pending, false)).toBe(false)
    expect(telemetryStatusLabel(pending, true)).toBe('需要重启')
  })
})
