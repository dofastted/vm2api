import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  formatMetadataUserId,
  loadVmIdentity,
  outboundDeviceId,
  OFFICIAL_CLAUDE_CLI_UA,
  OFFICIAL_CLI_VERSION,
} from '../../src/lib/identity/vm-identity.mjs'
import { applyCrsIdentityReplace } from '../../src/lib/identity/identity-rewrite.mjs'
import { REQUIRED_SEED_ENV, applyRequiredSeedEnv, buildSeedSettingsEnv } from '../../src/lib/protocol/seed-policy.mjs'

test('metadata.user_id is official JSON for current CLI', () => {
  const s = formatMetadataUserId({
    deviceId: 'a'.repeat(64),
    accountUuid: 'acc',
    sessionId: 'sess',
    email: 'slot@example.com',
  })
  const o = JSON.parse(s)
  assert.equal(o.device_id.length, 64)
  assert.equal(o.account_uuid, 'acc')
  assert.equal(o.session_id, 'sess')
  assert.equal(o.email, undefined)
  assert.equal(s.includes('@'), false)
})

test('identity replace overwrites client metadata with slot identity', () => {
  const id = {
    deviceId: 'd'.repeat(64),
    accountUuid: 'u',
    metadataUserId: formatMetadataUserId({ deviceId: 'd'.repeat(64), accountUuid: 'u', sessionId: 's' }),
  }
  const out = applyCrsIdentityReplace({ model: 'x', metadata: { user_id: 'windows-client' } }, id)
  assert.notEqual(out.metadata.user_id, 'windows-client')
  assert.ok(String(out.metadata.user_id).includes('account_uuid'))
})

test('loadVmIdentity builds settings from seed + timezone', () => {
  const id = loadVmIdentity({
    vmId: 'vm-1',
    homeDir: '/tmp/does-not-exist-kin',
    timezone: 'America/Los_Angeles',
    locale: 'en_US.UTF-8',
    oauth: { account_uuid: 'acc-1', org_uuid: 'org-1', email: 'a@b.c' },
    seedPolicy: { theme: 'dark', telemetry_disabled: true },
    vm: { fingerprint: { device_id: 'dev', session_id: 'sess-1' }, claude_code_version: '2.1.233' },
  })
  assert.equal(id.settings.theme, 'dark')
  assert.equal(id.settings.env.TZ, 'America/Los_Angeles')
  assert.equal(id.settings.env.DISABLE_TELEMETRY, '1')
  assert.equal(id.settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '0')
  assert.equal(id.settings.env.CLAUDE_CODE_USE_BEDROCK, '1')
  assert.equal(id.settings.env.CLAUDE_CODE_USE_VERTEX, '1')
  assert.equal(id.sessionId, 'sess-1')
  assert.equal(id.accountUuid, 'acc-1')
  assert.equal(id.email, 'a@b.c')
  assert.equal(id.cliVersion, OFFICIAL_CLI_VERSION)
  assert.equal(id.userAgent, OFFICIAL_CLAUDE_CLI_UA)
  assert.equal(JSON.parse(id.metadataUserId).email, undefined)
  assert.equal(id.metadataUserId.includes('@'), false)
})

test('identity replace uses the slot device_id', () => {
  const id = {
    deviceId: 'd'.repeat(64),
    accountUuid: 'u',
    sessionId: 's',
    metadataUserId: formatMetadataUserId({ deviceId: 'd'.repeat(64), accountUuid: 'u', sessionId: 's' }),
  }
  const inbound = {
    metadata: { user_id: JSON.stringify({ device_id: 'caller-dev', account_uuid: '', session_id: 'caller-sess' }) },
  }
  const out = applyCrsIdentityReplace({ model: 'x', metadata: inbound.metadata }, id, inbound)
  const uid = JSON.parse(out.metadata.user_id)
  assert.equal(uid.device_id, 'd'.repeat(64))
  assert.equal(uid.account_uuid, 'u')
})

test('telemetry off writes kill-switch keys; telemetry on deletes them', () => {
  const pinned = applyRequiredSeedEnv({
    DISABLE_TELEMETRY: '0',
    CLAUDE_CODE_USE_BEDROCK: '',
    extra: 'keep',
  })
  assert.equal(pinned.DISABLE_TELEMETRY, '1')
  assert.equal(pinned.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '0')
  assert.equal(pinned.CLAUDE_CODE_USE_BEDROCK, '1')
  assert.equal(pinned.CLAUDE_CODE_USE_VERTEX, '1')
  assert.equal(pinned.extra, 'keep')
  const open = buildSeedSettingsEnv({
    telemetry_disabled: false,
    disable_nonessential_traffic: false,
    do_not_track: false,
    extra_env: { DISABLE_TELEMETRY: '0', CLAUDE_CODE_USE_VERTEX: '0' },
  })
  assert.equal(open.DO_NOT_TRACK, undefined)
  assert.equal(open.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1')
  for (const k of Object.keys(REQUIRED_SEED_ENV)) assert.equal(open[k], undefined)
  const id = loadVmIdentity({
    vmId: 'vm-1',
    homeDir: '/tmp/does-not-exist-kin',
    seedPolicy: {
      telemetry_disabled: false,
      extra_env: { DISABLE_TELEMETRY: '0', CLAUDE_CODE_USE_BEDROCK: '0' },
    },
    vm: { fingerprint: { device_id: 'dev', session_id: 'sess-1' } },
  })
  assert.equal(id.settings.env.DISABLE_TELEMETRY, undefined)
  assert.equal(id.settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1')
  assert.equal(id.settings.env.CLAUDE_CODE_USE_BEDROCK, undefined)
  assert.equal(id.settings.env.CLAUDE_CODE_USE_VERTEX, undefined)
  assert.equal(id.settings.env.DO_NOT_TRACK, undefined)
  assert.equal(id.settings.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, '1')
  assert.equal(id.settings.grove_enabled, false)
})

test('loadVmIdentity pins outbound UA to CLI 2.1.284', () => {
  const id = loadVmIdentity({
    vmId: 'vm-29',
    homeDir: '/tmp/does-not-exist-kin',
    vm: { id: 'vm-29', timezone: 'America/Los_Angeles', locale: 'en_US.UTF-8' },
  })
  assert.equal(id.cliVersion, '2.1.284')
  assert.equal(id.userAgent, 'claude-cli/2.1.284 (external, sdk-cli)')
  assert.equal(id.fingerprint.user_agent, 'claude-cli/2.1.284 (external, sdk-cli)')
  assert.equal(id.fingerprint.stainless_runtime_version, 'v26.3.0')
  assert.equal(id.fingerprint.stainless_package_version, '0.112.1')
  assert.equal(id.fingerprint.stainless_lang, 'js')
  assert.equal(id.fingerprint.stainless_os, 'Linux')
  assert.equal(id.fingerprint.stainless_arch, 'x64')
  assert.equal(id.fingerprint.stainless_runtime, 'node')
})

test('loadVmIdentity ignores leftover settings.env from old scripts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-leftover-env-'))
  const home = path.join(root, 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({
      env: {
        DISABLE_TELEMETRY: '1',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080',
        ANTHROPIC_API_KEY: 'old',
        FOO: 'leftover',
      },
    }),
  )
  const id = loadVmIdentity({
    vmId: 'vm-10',
    homeDir: home,
    timezone: 'America/Los_Angeles',
    locale: 'en_US.UTF-8',
    seedPolicy: {
      telemetry_disabled: false,
      extra_env: { ANTHROPIC_AUTH_TOKEN: 'nope', BAR: 'yes' },
    },
    vm: { kernel: 'ubuntu-24.04', fingerprint: { device_id: 'dev', session_id: 'sess-1' } },
  })
  assert.equal(id.settings.env.DISABLE_TELEMETRY, undefined)
  assert.equal(id.settings.env.ANTHROPIC_BASE_URL, undefined)
  assert.equal(id.settings.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(id.settings.env.ANTHROPIC_AUTH_TOKEN, undefined)
  assert.equal(id.settings.env.FOO, undefined)
  assert.equal(id.settings.env.BAR, 'yes')
  assert.equal(id.settings.env.TZ, 'America/Los_Angeles')
  fs.rmSync(root, { recursive: true, force: true })
})

test('loadVmIdentity copies guest locale and timezone onto fingerprint', () => {
  const id = loadVmIdentity({
    vmId: 'vm-1',
    homeDir: '/tmp/does-not-exist-kin',
    vm: {
      fingerprint: {
        device_id: 'dev-keep',
        session_id: 'sess-1',
        locale: 'en_US.UTF-8',
        timezone: 'America/Los_Angeles',
        stainless_arch: 'x64',
      },
    },
  })
  assert.equal(id.locale, 'en_US.UTF-8')
  assert.equal(id.timezone, 'America/Los_Angeles')
  assert.equal(id.fingerprint.locale, 'en_US.UTF-8')
  assert.equal(id.fingerprint.timezone, 'America/Los_Angeles')
  assert.equal(id.settings.env.TZ, 'America/Los_Angeles')
  assert.equal(id.settings.env.LANG, 'en_US.UTF-8')
})

test('existing fingerprint device_id is not overwritten by leftover machineID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mid-'))
  const home = path.join(root, 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  const leftover = '24a52e29' + 'ab'.repeat(28)
  fs.writeFileSync(
    path.join(home, '.claude', '.claude.json'),
    JSON.stringify({
      machineID: leftover,
      userID: 'cc'.repeat(32),
    }),
  )
  const id = loadVmIdentity({
    vmId: 'vm-01',
    homeDir: home,
    vm: { fingerprint: { device_id: 'dev-keep', session_id: 'sess-keep' } },
  })
  const expected = crypto.createHash('sha256').update('dev-keep').digest('hex')
  assert.equal(id.deviceId, expected)
  assert.notEqual(id.deviceId, leftover)
  assert.equal(id.fingerprint.device_id, 'dev-keep')
  assert.equal(id.sessionId, 'sess-keep')
  fs.rmSync(root, { recursive: true, force: true })
})

test('64-hex device_id goes outbound as-is', () => {
  const hex = 'ab'.repeat(32)
  const id = loadVmIdentity({
    vmId: 'vm-05',
    vm: { fingerprint: { device_id: hex, session_id: 'sess-1' } },
  })
  assert.equal(id.deviceId, hex)
  assert.equal(outboundDeviceId(hex), hex)
  assert.equal(outboundDeviceId('dev-keep'), crypto.createHash('sha256').update('dev-keep').digest('hex'))
})

test('outbound email comes from slot credentials, not leftover claude.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-email-'))
  const home = path.join(root, 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(
    path.join(home, '.claude', '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'leftover@example.com', displayName: 'Old' },
    }),
  )
  fs.writeFileSync(
    path.join(home, '.claude', 'credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        email: 'slot@example.com',
        accountUuid: 'slot-acc',
        accessToken: 'live',
        refreshToken: 'livert',
      },
    }),
  )
  const id = loadVmIdentity({
    vmId: 'vm-02',
    homeDir: home,
    oauth: { email: 'mirrored@example.com' },
    vm: { fingerprint: { device_id: 'dev-keep', session_id: 'sess-keep' } },
  })
  assert.equal(id.email, 'slot@example.com')
  assert.equal(JSON.parse(id.metadataUserId).email, undefined)
  assert.equal(id.metadataUserId.includes('@'), false)
  const inbound = {
    metadata: {
      user_id: JSON.stringify({ device_id: 'caller', session_id: 's1' }),
      email: 'caller@example.com',
    },
  }
  const out = applyCrsIdentityReplace({ model: 'x', metadata: inbound.metadata }, id, inbound)
  const uid = JSON.parse(out.metadata.user_id)
  assert.equal(uid.email, undefined)
  assert.equal(String(out.metadata.user_id).includes('@'), false)
  assert.equal(out.metadata.email, undefined)
  fs.rmSync(root, { recursive: true, force: true })
})
