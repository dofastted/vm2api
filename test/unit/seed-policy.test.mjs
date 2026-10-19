import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultSeedPolicy,
  standardSeedPolicy,
  buildSlotSettingsEnv,
  buildSeedSettingsEnv,
  stripLegacyScriptEnv,
  LEGACY_SCRIPT_ENV_KEYS,
  DEFAULT_CLAUDE_SETTING,
} from '../../src/lib/protocol/seed-policy.mjs'

test('default seed policy includes the editable claude setting', () => {
  assert.equal(defaultSeedPolicy().claude_setting, DEFAULT_CLAUDE_SETTING)
  assert.equal(defaultSeedPolicy({ claude_setting: 'FOO=bar\r\n' }).claude_setting, 'FOO=bar')
})

test('explicit opt-in removes telemetry kill switches; omitted policy retains them', () => {
  assert.equal(buildSlotSettingsEnv(standardSeedPolicy()).DISABLE_TELEMETRY, '1')
  assert.equal(buildSlotSettingsEnv(standardSeedPolicy({ telemetry_disabled: false })).DISABLE_TELEMETRY, undefined)
  const contradicted = defaultSeedPolicy({
    telemetry_disabled: false,
    disable_nonessential_traffic: false,
    do_not_track: true,
  })
  assert.equal(contradicted.telemetry_disabled, false)
  assert.equal(contradicted.disable_nonessential_traffic, true)
  assert.equal(contradicted.do_not_track, false)
  const off = buildSeedSettingsEnv({ telemetry_disabled: true, do_not_track: false })
  assert.equal(off.DO_NOT_TRACK, '1')
  assert.equal(buildSeedSettingsEnv({ telemetry_disabled: false, do_not_track: true }).DO_NOT_TRACK, undefined)
})

test('stripLegacyScriptEnv drops kill-switch and leftover Anthropic hop keys', () => {
  const clean = stripLegacyScriptEnv({
    DISABLE_TELEMETRY: '0',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080',
    ANTHROPIC_API_KEY: 'sk-old',
    ANTHROPIC_AUTH_TOKEN: 'old',
    ANTHROPIC_UNIX_SOCKET: '/tmp/old.sock',
    KEEP: 'yes',
  })
  for (const key of LEGACY_SCRIPT_ENV_KEYS) assert.equal(clean[key], undefined)
  assert.equal(clean.KEEP, 'yes')
})

test('buildSlotSettingsEnv is TZ/LANG plus contract, leftover extra cannot win', () => {
  const env = buildSlotSettingsEnv(
    {
      telemetry_disabled: false,
      extra_env: {
        DISABLE_TELEMETRY: '1',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9000',
        CUSTOM: 'ok',
      },
    },
    {
      timezone: 'America/Los_Angeles',
      locale: 'en_US.UTF-8',
      extra: { CLAUDE_CODE_USE_BEDROCK: '1', TZ: 'Asia/Shanghai' },
    },
  )
  assert.equal(env.DISABLE_TELEMETRY, undefined)
  assert.equal(env.ANTHROPIC_BASE_URL, undefined)
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '0')
  assert.equal(env.CLAUDE_CODE_USE_VERTEX, '0')
  assert.equal(env.TZ, 'America/Los_Angeles')
  assert.equal(env.LANG, 'en_US.UTF-8')
  assert.equal(env.LC_ALL, 'en_US.UTF-8')
  assert.equal(env.CUSTOM, 'ok')
  assert.equal(env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, '1')
})

test('buildSeedSettingsEnv delegates to slot env', () => {
  const off = buildSeedSettingsEnv({ telemetry_disabled: true })
  assert.equal(off.DISABLE_TELEMETRY, '1')
  assert.equal(off.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '0')
  assert.equal(off.CLAUDE_CODE_USE_BEDROCK, '0')
  assert.equal(off.CLAUDE_CODE_USE_VERTEX, '0')
  const on = buildSeedSettingsEnv({ telemetry_disabled: false })
  assert.equal(on.DISABLE_TELEMETRY, undefined)
  assert.equal(on.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1')
  assert.equal(on.CLAUDE_CODE_USE_BEDROCK, '0')
  assert.equal(on.CLAUDE_CODE_USE_VERTEX, '0')
})
