import { describe, expect, it } from 'vitest'
import {
  claudeSettingKeys,
  seedDraftOf,
  seedSaveBody,
  settingsRows,
  telemetryLive,
} from './seed-settings'

const settings = {
  env: {
    TZ: 'Asia/Shanghai',
    LANG: 'en_US.UTF-8',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0',
    CLAUDE_CODE_USE_BEDROCK: '0',
    DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
    CUSTOM_FLAG: 'kept',
  },
  theme: 'dark',
  autoUpdates: false,
}

describe('current slot settings', () => {
  it('lists the file env, marking lines also named in claude.setting', () => {
    const rows = settingsRows(
      settings,
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\n# note\n'
    )
    expect(
      rows.map((row) => [row.key, row.value, row.inClaudeSetting])
    ).toEqual([
      ['TZ', 'Asia/Shanghai', false],
      ['LANG', 'en_US.UTF-8', false],
      ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '0', true],
      ['CLAUDE_CODE_USE_BEDROCK', '0', false],
      ['DISABLE_TELEMETRY', '1', false],
      ['DO_NOT_TRACK', '1', false],
      ['CUSTOM_FLAG', 'kept', false],
      ['theme', 'dark', false],
      ['autoUpdates', 'false', false],
    ])
  })

  it('does not invent rows when the file is missing', () => {
    expect(settingsRows(null, 'TZ=UTC')).toEqual([])
    expect(claudeSettingKeys('# only\n\nNOT A KEY\nOK=1')).toEqual(
      new Set(['OK'])
    )
  })
})

describe('seed draft', () => {
  it('shows reject flags from the current policy, not a preset', () => {
    const draft = seedDraftOf({
      seed_policy: {
        telemetry_disabled: false,
        reject_client_settings: false,
        reject_client_metadata_identity: true,
      },
      claude_setting: 'A=1\r\nB=2\r\n',
    })
    expect(draft.reject_client_settings).toBe(false)
    expect(draft.reject_client_metadata_identity).toBe(true)
    expect(draft.telemetry_disabled).toBe(false)
    expect(draft.claude_setting).toBe('A=1\nB=2\n')
    expect(seedSaveBody(draft)).toMatchObject({
      telemetry_disabled: false,
      disable_nonessential_traffic: true,
      do_not_track: false,
      reject_client_settings: false,
      reject_client_metadata_identity: true,
      claude_setting: 'A=1\nB=2',
    })
  })

  it('keeps an explicit false identity flag instead of defaulting it on', () => {
    const draft = seedDraftOf({
      seed_policy: { reject_client_metadata_identity: false },
    })
    expect(draft.reject_client_metadata_identity).toBe(false)
    expect(draft.reject_client_settings).toBe(true)
  })

  it('keeps a missing or empty claude.setting empty', () => {
    expect(
      seedDraftOf({
        seed_policy: { claude_setting: 'FROM_POLICY=1' },
        claude_setting: '',
      }).claude_setting
    ).toBe('')
    expect(
      seedDraftOf({ seed_policy: { claude_setting: 'FROM_POLICY=1' } })
        .claude_setting
    ).toBe('')
  })
})

describe('telemetry lamp', () => {
  it('stays off while a process is still running', () => {
    const live = telemetryLive(
      { seed_policy: { telemetry_disabled: true } },
      { enabled: true, running: true }
    )
    expect(live).toMatchObject({ on: false, running: true, tone: 'off' })
    expect(live.label).toBe('未启用')
  })

  it('stays on when the process has not started', () => {
    const live = telemetryLive(
      { seed_policy: { telemetry_disabled: false } },
      { enabled: false, running: false }
    )
    expect(live).toMatchObject({
      on: true,
      running: false,
      tone: 'on',
      label: '已开启 · 进程未运行',
    })
  })

  it('does not call a missing observation off', () => {
    expect(telemetryLive({}, null)).toMatchObject({
      on: null,
      running: null,
      tone: 'unknown',
    })
  })
})
