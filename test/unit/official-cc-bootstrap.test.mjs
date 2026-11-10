import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  dockerGatewayIp,
  officialCcUidGid,
  wipeOfficialFirstUseHome,
  materializeOfficialClaudeCredentials,
  summarizeOfficialCcHome,
  writeOfficialCcStatus,
  readOfficialCcStatus,
  officialCcShouldForceRefresh,
  buildOfficialCcDockerArgs,
  officialCcTurnSucceeded,
  DEFAULT_HELLO_PROMPT,
  DEFAULT_USAGE_PROMPT,
  OFFICIAL_USAGE_RETRIES,
  runOfficialCcUsage,
  collectOfficialCcAccount,
  DEFAULT_OFFICIAL_CC_CONFIG,
  normalizeOfficialCcConfig,
  loadOfficialCcConfig,
  applyOfficialCcConfig,
  scheduleOfficialCcBootstrap,
  officialCcShouldSkipAutoInit,
  officialCcShouldRestoreResident,
  restoreOfficialCcResident,
  restoreOfficialCcResidents,
  listOfficialCcVmIds,
  officialCcQuotaSucceeded,
  finalizeOfficialCcTelemetry,
} from '../../src/lib/oauth/official-cc-bootstrap.mjs'
import { OFFICIAL_CLI_VERSION } from '../../src/lib/identity/vm-identity.mjs'
import { CRS_OFFICIAL_CLI_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'

test('uid follows vm index', () => {
  assert.deepEqual(officialCcUidGid('vm-30'), { uid: 10030, gid: 987 })
})

test('first-use cleanup preserves native identity, settings, credentials and backlog', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-'))
  fs.mkdirSync(path.join(dir, '.claude', 'projects', '-home-kincli'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.claude', 'sessions'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({
      userID: 'old-user',
      machineID: 'old-machine',
      hasCompletedOnboarding: true,
    }),
  )
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{"theme":"dark"}')
  fs.writeFileSync(path.join(dir, '.claude', '.claude.json'), '{"userID":"nested-user"}')
  fs.writeFileSync(path.join(dir, '.claude', 'kin-seed.json'), '{"seed_policy":{"telemetry_disabled":true}}')
  fs.writeFileSync(path.join(dir, '.claude', 'kin-identity.json'), '{"device_id":"native-device"}')
  fs.mkdirSync(path.join(dir, '.claude', 'telemetry'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.claude', 'telemetry', 'queue.json'), '{"events":[{"id":"kept"}]}')
  fs.writeFileSync(
    path.join(dir, '.claude', 'credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: 'keep', refreshToken: 'keeprt' },
    }),
  )
  fs.writeFileSync(path.join(dir, '.claude', 'projects', '-home-kincli', 'sess.jsonl'), 'x')
  const wiped = wipeOfficialFirstUseHome(dir)
  assert.equal(wiped.wiped, true)
  assert.equal(wiped.kept_credentials, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).userID, 'old-user')
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'projects')), false)
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'), '{"theme":"dark"}')
  assert.equal(fs.readFileSync(path.join(dir, '.claude', '.claude.json'), 'utf8'), '{"userID":"nested-user"}')
  assert.equal(
    fs.readFileSync(path.join(dir, '.claude', 'kin-seed.json'), 'utf8'),
    '{"seed_policy":{"telemetry_disabled":true}}',
  )
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'kin-identity.json'), 'utf8'), '{"device_id":"native-device"}')
  assert.equal(
    fs.readFileSync(path.join(dir, '.claude', 'telemetry', 'queue.json'), 'utf8'),
    '{"events":[{"id":"kept"}]}',
  )
  const cred = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'credentials.json'), 'utf8'))
  assert.equal(cred.claudeAiOauth.accessToken, 'keep')
  assert.equal(summarizeOfficialCcHome(dir).has_user_id, true)
  const login = materializeOfficialClaudeCredentials(dir)
  assert.equal(login.wrote, true)
  assert.equal(login.linked, true)
  assert.equal(fs.lstatSync(path.join(dir, '.claude', '.credentials.json')).isSymbolicLink(), true)
  const official = JSON.parse(fs.readFileSync(path.join(dir, '.claude', '.credentials.json'), 'utf8'))
  assert.equal(official.claudeAiOauth.accessToken, 'keep')
  assert.equal(official.claudeAiOauth.refreshToken, 'keeprt')
  assert.equal(official.claudeAiOauth.kinGeneration, undefined)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('status file never stores tokens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-'))
  writeOfficialCcStatus(dir, {
    status: 'ok',
    vm_id: 'vm-30',
    access_token: 'sk-ant-oat01-LEAK',
    email: 'hide@example.com',
    error: 'x'.repeat(400),
    hello_ok: true,
    stats_ok: true,
    has_oauth_account: true,
    telemetry_published: true,
    telemetry_applied: false,
    telemetry_error: 'telemetry_not_ready',
    sidecar_reloaded: true,
    telemetry_touched: true,
  })
  const status = readOfficialCcStatus(dir)
  const raw = fs.readFileSync(path.join(dir, '.claude', 'kin-official-bootstrap.json'), 'utf8')
  assert.equal(status.status, 'ok')
  assert.equal(status.hello_ok, true)
  assert.equal(status.access_token, undefined)
  assert.equal(status.telemetry_published, true)
  assert.equal(status.telemetry_applied, false)
  assert.equal(status.telemetry_error, 'telemetry_not_ready')
  assert.equal(status.sidecar_reloaded, undefined)
  assert.equal(status.telemetry_touched, undefined)
  assert.equal(status.email, undefined)
  assert.ok(!raw.includes('sk-ant-oat01'))
  assert.ok(status.error.length <= 300)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('docker args use hello//usage bypassPermissions without CONNECT proxy', () => {
  const args = buildOfficialCcDockerArgs({
    vmId: 'vm-30',
    uid: 10030,
    gid: 987,
    timezone: 'America/Chicago',
    locale: 'en_US.UTF-8',
    prompt: DEFAULT_HELLO_PROMPT,
  })
  assert.ok(args.includes('kin-30'))
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions')
  assert.ok(args.includes(DEFAULT_HELLO_PROMPT))
  assert.equal(
    args.some((item) => String(item).includes('HTTP_PROXY') || String(item).includes('HTTPS_PROXY')),
    false,
  )
  assert.ok(args.includes('ANTHROPIC_BASE_URL='))
  // Bootstrap must not race the host Go Refresher. cli-node reads this name.
  assert.ok(args.includes('CLAUDE_CODE_HOST_REFRESH=1'))
  assert.ok(args.includes(`CLAUDE_CODE_VERSION=${OFFICIAL_CLI_VERSION}`))
  assert.ok(args.includes('USER_TYPE=external'))
  assert.equal(args.includes('CI=1'), false)
  assert.equal(args[args.indexOf('kin-30') + 1], '/home/kincli/.kin/cli-node')
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], CRS_OFFICIAL_CLI_SYSTEM)
  const usageArgs = buildOfficialCcDockerArgs({
    vmId: 'vm-30',
    uid: 10030,
    gid: 987,
    prompt: DEFAULT_USAGE_PROMPT,
  })
  assert.ok(usageArgs.includes('/usage'))
  // stream-json keeps the structured usage_report (server limits[]) the
  // plain json envelope drops.
  assert.equal(usageArgs[usageArgs.indexOf('--output-format') + 1], 'stream-json')
  assert.ok(usageArgs.includes('--verbose'))
  assert.equal(usageArgs[usageArgs.indexOf('--append-system-prompt') + 1], CRS_OFFICIAL_CLI_SYSTEM)
})

test('native bootstrap runs the selected CLI without cli-node identity overrides', () => {
  for (const vm of [{ id: 'vm-30' }, { id: 'vm-30', node_id: 'node-a' }]) {
    const args = buildOfficialCcDockerArgs({
      vmId: vm.id,
      vm,
      uid: 10030,
      gid: 987,
      routing: { inference: { dataplane: 'crag', crag_kernel_version: 'v2' } },
    })
    assert.equal(
      args[args.indexOf('kin-30') + 1],
      vm.node_id
        ? '/opt/kin-live/crag-v2/claude-code-2.1.321/claude'
        : '/home/kincli/.kin/crag-v2/claude-code-2.1.321/claude',
    )
    assert.equal(
      args.some((arg) => arg.startsWith('CLAUDE_CODE_VERSION=')),
      false,
    )
    assert.equal(args.includes('--append-system-prompt'), false)
  }
})

test('native automated usage uses the slot OAuth endpoint, not a print-mode slash prompt', async () => {
  const result = await runOfficialCcUsage({
    turn: () => {
      throw new Error('native /usage must not run in print mode')
    },
    nativeUsage: async () => ({
      ok: true,
      body: {
        five_hour: { utilization: 10 },
        seven_day: { utilization: 20 },
        seven_day_sonnet: null,
        extra_usage: null,
      },
    }),
  })
  assert.equal(result.turn.ok, true)
  assert.equal(result.stats.five_hour.utilization, 0.1)
  assert.equal(result.stats.account_tier, null)
  const failed = await runOfficialCcUsage({
    nativeUsage: async () => ({ ok: false, body: { error: { code: 'usage_denied' } } }),
  })
  assert.equal(failed.turn.ok, false)
  assert.equal(
    officialCcQuotaSucceeded({ ...failed.stats, account_tier: 'pro', account_tier_source: 'profile' }),
    false,
  )
})

test('official hello success requires a parsed result, empty stdout is a failure', () => {
  assert.equal(officialCcTurnSucceeded({ code: 0, raw: '', slash: false }), false)
  assert.equal(officialCcTurnSucceeded({ code: 0, raw: 'not json', slash: false }), false)
  assert.equal(officialCcTurnSucceeded({ code: 0, raw: JSON.stringify({ is_error: true }), slash: false }), false)
  assert.equal(
    officialCcTurnSucceeded({ code: 0, raw: JSON.stringify({ type: 'result', is_error: false }), slash: false }),
    true,
  )
  assert.equal(officialCcTurnSucceeded({ code: 0, raw: '{"type":"result"}\n', slash: true }), true)
  assert.equal(officialCcTurnSucceeded({ code: 0, raw: '', slash: true }), false)
})

test('guest docker gateway is not container localhost', () => {
  const ip = dockerGatewayIp('vm-03')
  assert.match(ip, /^\d{1,3}(?:\.\d{1,3}){3}$/)
  const args = buildOfficialCcDockerArgs({
    vmId: 'vm-03',
    uid: 10003,
    gid: 987,
    prompt: DEFAULT_HELLO_PROMPT,
  })
  assert.equal(
    args.some((item) => String(item).includes('HTTP_PROXY') || String(item).includes('HTTPS_PROXY')),
    false,
  )
})

test('fresh ticket does not force-refresh before official login', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-'))
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true })
  const futureMs = Date.now() + 6 * 60 * 60 * 1000
  fs.writeFileSync(
    path.join(dir, '.claude', 'credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fresh',
        refreshToken: 'freshrt',
        expiresAt: futureMs,
      },
    }),
  )
  assert.equal(officialCcShouldForceRefresh(dir, {}), false)
  const pastMs = Date.now() - 60 * 1000
  fs.writeFileSync(
    path.join(dir, '.claude', 'credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'old',
        refreshToken: 'oldrt',
        expiresAt: pastMs,
      },
    }),
  )
  assert.equal(officialCcShouldForceRefresh(dir, {}), true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('status includes step and never tokens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-'))
  const status = writeOfficialCcStatus(dir, { status: 'running', step: 'hello', access_token: 'nope' })
  assert.equal(status.step, 'hello')
  assert.equal(status.access_token, undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('normalizeOfficialCcConfig fills defaults and clamps', () => {
  assert.deepEqual(normalizeOfficialCcConfig(), { ...DEFAULT_OFFICIAL_CC_CONFIG })
  const n = normalizeOfficialCcConfig({
    enabled: false,
    wipe: false,
    apply_seed: false,
    reconcile_fingerprint: false,
    timeout_ms: 10,
    memory: '99g',
    hello_prompt: '  hi  ',
    quota_via: 'cli',
    stats_prompt: '/stats',
  })
  assert.equal(n.enabled, false)
  assert.equal(n.wipe, false)
  assert.equal(n.apply_seed, false)
  assert.equal(n.reconcile_fingerprint, false)
  assert.equal(n.timeout_ms, DEFAULT_OFFICIAL_CC_CONFIG.timeout_ms)
  assert.equal(n.memory, '500m')
  assert.equal(n.hello_prompt, 'hi')
  // Retired keys are dropped: /usage in the slot is the only quota source.
  assert.equal('quota_via' in n, false)
  assert.equal('stats_prompt' in n, false)
  const okTimeout = normalizeOfficialCcConfig({ timeout_ms: 60000, memory: '4g' })
  assert.equal(okTimeout.timeout_ms, 60000)
  assert.equal(okTimeout.memory, '4g')
  assert.equal(normalizeOfficialCcConfig({}).sync_telemetry, false)
  assert.equal(normalizeOfficialCcConfig({ sync_telemetry: false }).sync_telemetry, false)
  assert.equal(normalizeOfficialCcConfig({}).resident, false)
  assert.equal(normalizeOfficialCcConfig({}).inference, 'cli-hop')
  assert.equal(normalizeOfficialCcConfig({ inference: 'http' }).inference, 'http')
  assert.equal(normalizeOfficialCcConfig({ resident: true }).resident, true)
})

test('official quota success accepts parsed /usage windows', () => {
  assert.equal(officialCcQuotaSucceeded({ ok: true, source: 'official-cc-usage-cli' }), true)
  assert.equal(officialCcQuotaSucceeded({ ok: false }), false)
})

test('applyOfficialCcConfig prefers explicit opts over routing', () => {
  const o = applyOfficialCcConfig(
    {
      prompt: 'hey',
      applySeed: false,
      wipe: false,
    },
    {
      hello_prompt: 'hello',
      apply_seed: true,
      wipe: true,
      timeout_ms: 120000,
      memory: '1g',
    },
  )
  assert.equal(o.prompt, 'hey')
  assert.equal(o.applySeed, false)
  assert.equal(o.wipe, false)
  assert.equal(o.timeoutMs, 120000)
  assert.equal(o.memory, '1g')
  assert.equal(o.resident, false)

  assert.equal(o.syncTelemetry, false)
  assert.equal(applyOfficialCcConfig({}, { sync_telemetry: false }).syncTelemetry, false)
})

test('loadOfficialCcConfig reads routing.json official_cc', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-'))
  const file = path.join(dir, 'routing.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      official_cc: { enabled: false, hello_prompt: 'ping', memory: '4g' },
    }),
  )
  const cfg = loadOfficialCcConfig(file)
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.hello_prompt, 'ping')
  assert.equal(cfg.memory, '4g')
  assert.equal(cfg.wipe, true)
  assert.equal(cfg.sync_telemetry, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('settings persist keeps sync_telemetry explicit on and off', () => {
  const on = normalizeOfficialCcConfig({ enabled: true, wipe: true })
  assert.equal(on.sync_telemetry, false)
  const off = normalizeOfficialCcConfig({ ...on, sync_telemetry: false })
  assert.equal(off.sync_telemetry, false)
  const back = normalizeOfficialCcConfig({ ...off, sync_telemetry: true, wipe: false })
  assert.equal(back.sync_telemetry, true)
  assert.equal(back.wipe, false)
})

test('schedule skips when auto init is disabled', () => {
  const r = scheduleOfficialCcBootstrap({
    vmId: 'vm-99',
    projectRoot: path.join(os.tmpdir(), 'kin-missing'),
    config: { enabled: false },
  })
  assert.equal(r.scheduled, false)
  assert.equal(r.reason, 'disabled')
})

function writeCompletedOfficialHome(root, vmId, { accountUuid = 'acc-1', email = 'same@example.com' } = {}) {
  const home = path.join(root, 'vms', vmId, 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({
      userID: 'u'.repeat(64),
      machineID: 'm'.repeat(64),
      oauthAccount: { accountUuid, emailAddress: email },
    }),
  )
  writeOfficialCcStatus(home, {
    status: 'ok',
    vm_id: vmId,
    hello_ok: true,
    usage_ok: true,
    official_login: true,
    has_user_id: true,
    has_machine_id: true,
    step: 'done',
  })
  return home
}

test('skip auto init after a completed first-time bootstrap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-skip-'))
  const vmId = 'vm-05'
  writeCompletedOfficialHome(root, vmId)
  const same = officialCcShouldSkipAutoInit(root, vmId, {
    incoming: { account_uuid: 'acc-1', email: 'same@example.com' },
  })
  assert.equal(same.skip, true)
  assert.equal(same.reason, 'already_initialized')
  const skipped = scheduleOfficialCcBootstrap({
    vmId,
    projectRoot: root,
    incomingOauth: { account_uuid: 'acc-1', email: 'same@example.com' },
    config: { enabled: true },
  })
  assert.equal(skipped.scheduled, false)
  assert.equal(skipped.reason, 'already_initialized')
  const scheduled = scheduleOfficialCcBootstrap({
    vmId,
    projectRoot: root,
    force: true,
    incomingOauth: { account_uuid: 'acc-1', email: 'same@example.com' },
    config: { enabled: true },
  })
  assert.equal(scheduled.scheduled, true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('auto init still runs when official IDs are missing or account changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-reskip-'))
  const vmId = 'vm-05'
  writeCompletedOfficialHome(root, vmId)
  const changed = officialCcShouldSkipAutoInit(root, vmId, {
    incoming: { account_uuid: 'acc-other', email: 'other@example.com' },
  })
  assert.equal(changed.skip, false)
  assert.equal(changed.reason, 'account_changed')
  fs.unlinkSync(path.join(root, 'vms', vmId, 'cli-home', '.claude.json'))
  const missing = officialCcShouldSkipAutoInit(root, vmId, {
    incoming: { account_uuid: 'acc-1' },
  })
  assert.equal(missing.skip, false)
  assert.equal(missing.reason, 'missing_official_ids')
  writeOfficialCcStatus(path.join(root, 'vms', vmId, 'cli-home'), { status: 'error', hello_ok: false })
  fs.writeFileSync(
    path.join(root, 'vms', vmId, 'cli-home', '.claude.json'),
    JSON.stringify({
      userID: 'u'.repeat(64),
      machineID: 'm'.repeat(64),
    }),
  )
  const incomplete = officialCcShouldSkipAutoInit(root, vmId, {})
  assert.equal(incomplete.skip, false)
  assert.equal(incomplete.reason, 'init_incomplete')
  fs.rmSync(root, { recursive: true, force: true })
})

function writeSlotCliNode(home) {
  const bin = path.join(home, '.kin', 'cli-node')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n')
}

test('resident restore skips incomplete, disabled, and already-running slots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-restore-'))
  const vmId = 'vm-13'
  const home = writeCompletedOfficialHome(root, vmId)
  writeSlotCliNode(home)
  fs.writeFileSync(
    path.join(root, 'vms', `${vmId}.json`),
    JSON.stringify({
      id: vmId,
      inference_engine: 'go',
      timezone: 'America/Chicago',
      locale: 'en_US.UTF-8',
    }),
  )
  const residentOn = { resident: true, inference: 'http' }
  assert.equal(
    officialCcShouldRestoreResident(root, vmId, {
      live: { running: false },
      config: residentOn,
    }).reason,
    'cli-hop',
  )
  assert.equal(
    officialCcShouldRestoreResident(root, vmId, {
      live: { running: false },
      config: { resident: false, inference: 'http' },
    }).reason,
    'cli-hop',
  )
  assert.equal(
    officialCcShouldRestoreResident(root, vmId, {
      live: { running: true },
      config: residentOn,
    }).reason,
    'cli-hop',
  )
  writeOfficialCcStatus(home, { ...readOfficialCcStatus(home), status: 'running', step: 'hello' })
  assert.equal(
    officialCcShouldRestoreResident(root, vmId, { live: { running: false }, config: residentOn }).reason,
    'cli-hop',
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('cli-hop slots do not restore official resident PTY', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-clihop-'))
  const vmId = 'vm-05'
  const home = writeCompletedOfficialHome(root, vmId)
  writeSlotCliNode(home)
  fs.writeFileSync(
    path.join(root, 'vms', `${vmId}.json`),
    JSON.stringify({ id: vmId, official_cc_inference: 'cli-hop', inference_engine: 'rust' }),
  )
  const gate = officialCcShouldRestoreResident(root, vmId, {
    live: { running: false },
    config: { inference: 'http', resident: true },
  })
  assert.equal(gate.restore, false)
  assert.equal(gate.reason, 'cli-hop')
  fs.rmSync(root, { recursive: true, force: true })
})

test('Node boot restores dead residents without another hello', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-boot-'))
  const live = writeCompletedOfficialHome(root, 'vm-30')
  writeSlotCliNode(live)
  fs.writeFileSync(path.join(root, 'vms', 'vm-30.json'), JSON.stringify({ id: 'vm-30', inference_engine: 'go' }))
  const empty = writeCompletedOfficialHome(root, 'vm-31')
  writeOfficialCcStatus(empty, { status: 'error', hello_ok: false, step: 'hello' })
  fs.writeFileSync(path.join(root, 'vms', 'vm-31.json'), JSON.stringify({ id: 'vm-31', inference_engine: 'go' }))
  const started = []
  const summary = await restoreOfficialCcResidents(root, {
    config: { resident: true, inference: 'http' },
    inspect: (id) => ({ running: false, pid: null }),
    startResident: async (opts) => {
      started.push(opts.vmId)
      return { ok: true, guest_pid: 4242, host_pid: 99, bridge_port: 18030 }
    },
  })
  assert.deepEqual(started, [])

  assert.equal(summary.restored, 0)
  assert.equal(summary.skipped, 2)
  const already = await restoreOfficialCcResident(root, 'vm-30', {
    config: { resident: true, inference: 'http' },
    inspect: () => ({ running: true, pid: 4242 }),
    startResident: async () => {
      throw new Error('must not start again')
    },
  })

  assert.equal(already.reason, 'cli-hop')
  assert.deepEqual(listOfficialCcVmIds(root).sort(), ['vm-30', 'vm-31'])
  fs.rmSync(root, { recursive: true, force: true })
})

function usageLines(limits) {
  return [
    JSON.stringify({ type: 'assistant', usage_report: { rate_limits: { limits } } }),
    JSON.stringify({ type: 'result', result: 'ok' }),
  ].join('\n')
}

test('slot /usage retries at most twice when limits[] is missing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-usage-'))
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  const prompts = []
  const turn = async ({ prompt, outFile }) => {
    prompts.push(prompt)
    fs.writeFileSync(outFile, usageLines(null))
    return { ok: true, code: 0, timed_out: false }
  }
  const run = await runOfficialCcUsage({ turn, homeDir: home, retryDelayMs: 0 })
  assert.equal(run.attempts, OFFICIAL_USAGE_RETRIES + 1)
  assert.deepEqual(prompts, ['/usage', '/usage', '/usage'])
  assert.equal(run.stats.limits_present, false)
  fs.rmSync(home, { recursive: true, force: true })
})

test('slot /usage stops once Fable limits arrive', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-usage-'))
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  let n = 0
  const turn = async ({ outFile }) => {
    n += 1
    fs.writeFileSync(
      outFile,
      n === 1
        ? 'boom'
        : usageLines([
            { kind: 'session', percent: 10, resets_at: null },
            { kind: 'weekly_all', percent: 30, resets_at: null },
            { kind: 'weekly_scoped', percent: 21, resets_at: null, scope: { model: { display_name: 'Fable' } } },
          ]),
    )
    return { ok: n > 1, code: n > 1 ? 0 : 1, timed_out: false }
  }
  const run = await runOfficialCcUsage({ turn, homeDir: home, retryDelayMs: 0 })
  assert.equal(run.attempts, 2)
  assert.equal(run.stats.seven_day_oi.utilization, 0.21)
  fs.rmSync(home, { recursive: true, force: true })
})

test('collectOfficialCcAccount reads tier from profile and model ids via slot worker', async () => {
  const ops = []
  const slotOauth = async (_exec, op) => {
    ops.push(op)
    if (op === 'profile') {
      return { ok: true, status: 200, body: { account: { has_claude_max: true }, organization: {} } }
    }
    return { ok: true, status: 200, body: { data: [{ id: 'claude-fable-5' }, { id: 'claude-sonnet-4-5' }] } }
  }
  const got = await collectOfficialCcAccount({ vmId: 'vm-01' }, { slotOauth })
  assert.deepEqual(ops.sort(), ['models', 'profile'])
  assert.equal(got.account_tier, 'max')
  assert.deepEqual(got.available_models, ['claude-fable-5', 'claude-sonnet-4-5'])
})

test('telemetry finalization preserves saved consent and VM-owned files without claiming activation', async (t) => {
  const previousRunRoot = process.env.KIN_SLOT_RUN_ROOT
  delete process.env.KIN_SLOT_RUN_ROOT
  t.after(() => {
    if (previousRunRoot === undefined) delete process.env.KIN_SLOT_RUN_ROOT
    else process.env.KIN_SLOT_RUN_ROOT = previousRunRoot
  })
  for (const telemetryDisabled of [undefined, true, false, 'false', 0]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-policy-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const vmId = 'vm-policy'
    const home = writeCompletedOfficialHome(root, vmId)
    const vmPath = path.join(root, 'vms', `${vmId}.json`)
    const vm = {
      id: vmId,
      kernel: 'ubuntu-24.04',
      seed_policy: telemetryDisabled === undefined ? {} : { telemetry_disabled: telemetryDisabled },
      fingerprint: { device_id: 'controller-device', session_id: 'controller-session' },
    }
    const vmBytes = JSON.stringify(vm)
    const identityBytes = fs.readFileSync(path.join(home, '.claude.json'), 'utf8')
    const credentialBytes = '{"claudeAiOauth":{"accessToken":"fixture-token"}}'
    const queueBytes = '{"events":[{"id":"preserved-event"}]}'
    fs.writeFileSync(vmPath, vmBytes)
    fs.writeFileSync(path.join(home, '.claude', 'credentials.json'), credentialBytes)
    fs.mkdirSync(path.join(home, '.claude', 'telemetry'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'telemetry', 'queue.json'), queueBytes)
    const out = await finalizeOfficialCcTelemetry(root, vmId, { publish: false })
    assert.equal(out.ok, true, out.error)
    assert.equal(out.enabled, telemetryDisabled === false)
    assert.equal(out.wrote, true)
    assert.equal(out.seed_aligned, true)
    assert.equal(out.published, false)
    assert.equal(out.applied, false)
    assert.equal(fs.readFileSync(vmPath, 'utf8'), vmBytes)
    assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), identityBytes)
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'credentials.json'), 'utf8'), credentialBytes)
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'telemetry', 'queue.json'), 'utf8'), queueBytes)
    const seed = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'kin-seed.json'), 'utf8'))
    assert.equal(seed.seed_policy.telemetry_disabled, telemetryDisabled !== false)
    const config = JSON.parse(fs.readFileSync(path.join(root, 'vms', vmId, 'run', 'kernel.json'), 'utf8'))
    assert.equal(config.telemetry.upload_interval_seconds, 600)
    assert.equal(config.telemetry.identity, undefined)
    assert.equal(fs.existsSync(path.join(root, 'vms', vmId, 'run', 'worker.json')), false)
    assert.equal(fs.existsSync(path.join(root, 'vms', vmId, 'run', 'telemetry.touch')), false)
  }
})

test('completed native userID does not require a legacy machineID or another initialization', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-user-only-'))
  try {
    const vmId = 'vm-native'
    const home = writeCompletedOfficialHome(root, vmId)
    const file = path.join(home, '.claude.json')
    const bytes = JSON.stringify({ userID: 'native-user', oauthAccount: { accountUuid: 'acc-1' } })
    fs.writeFileSync(file, bytes)
    const decision = officialCcShouldSkipAutoInit(root, vmId, { incoming: { account_uuid: 'acc-1' } })
    assert.equal(decision.skip, true)
    assert.equal(decision.reason, 'already_initialized')
    assert.equal(summarizeOfficialCcHome(home).has_machine_id, false)
    assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
