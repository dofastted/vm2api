import { describe, expect, it } from 'vitest'
import { seedSaveBody } from './seed-settings'
import { telemetryEnabled } from './telemetry-policy'

describe('seed save follows the telemetry bit', () => {
  it('drops contradictory mirrors so the switch stays on', () => {
    const body = seedSaveBody({
      telemetry_disabled: false,
      disable_nonessential_traffic: false,
      do_not_track: true,
      reject_client_settings: true,
      reject_client_metadata_identity: true,
      claude_setting: 'A=1',
    })
    expect(telemetryEnabled(body)).toBe(true)
    expect(body.disable_nonessential_traffic).toBe(true)
    expect(body.do_not_track).toBe(false)
  })
})
