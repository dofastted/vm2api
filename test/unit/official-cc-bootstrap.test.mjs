import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
  repairOfficialClaudeBinLink,
  repairProjectOfficialClaudeBins,
  officialCcQuotaSucceeded,
  finalizeOfficialCcTelemetry,
  buildOfficialCcResidentDockerArgs,
} from '../../src/lib/oauth/official-cc-bootstrap.mjs'

test('uid follows vm index', () => {
  assert.deepEqual(officialCcUidGid('vm-30'), { uid: 10030, gid: 987 })
})

test('wipe clears first-use files and keeps worker credentials', () => {
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
  assert.equal(fs.existsSync(path.join(dir, '.claude.json')), false)
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'projects')), false)
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'settings.json')), false)
  const cred = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'credentials.json'), 'utf8'))
  assert.equal(cred.claudeAiOauth.accessToken, 'keep')
  assert.equal(summarizeOfficialCcHome(dir).has_user_id, false)
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
  })
  const status = readOfficialCcStatus(dir)
  const raw = fs.readFileSync(path.join(dir, '.claude', 'kin-official-bootstrap.json'), 'utf8')
  assert.equal(status.status, 'ok')
  assert.equal(status.hello_ok, true)
  assert.equal(status.access_token, undefined)
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
  assert.ok(!args.some((item) => String(item).includes('8787')))
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
  assert.equal(normalizeOfficialCcConfig({}).sync_telemetry, true)
  assert.equal(normalizeOfficialCcConfig({ sync_telemetry: false }).sync_telemetry, false)
  assert.equal(normalizeOfficialCcConfig({}).resident, false)
  assert.equal(normalizeOfficialCcConfig({}).inference, 'cli-hop')
  assert.equal(normalizeOfficialCcConfig({ inference: 'http' }).inference, 'http')
  assert.equal(normalizeOfficialCcConfig({ resident: true }).resident, true)
})

test('resident docker args stay interactive without CONNECT proxy', () => {
  const args = buildOfficialCcResidentDockerArgs({
    vmId: 'vm-51',
    uid: 10051,
    gid: 987,
    timezone: 'America/Chicago',
    locale: 'en_US.UTF-8',
  })
  assert.ok(args.includes('kin-51'))
  assert.ok(args.includes('-d'))
  assert.ok(args.includes('-t'))
  assert.equal(
    args.some((item) => String(item).includes('HTTP_PROXY') || String(item).includes('HTTPS_PROXY')),
    false,
  )
  assert.equal(args[args.length - 1], '/home/kincli/.local/bin/claude')
  assert.ok(!args.includes('-p'))
  assert.ok(!args.includes('--print'))
  assert.ok(!args.includes('hello'))
  assert.ok(!args.includes('CI=1'))
})

test('official quota success accepts parsed /usage windows', () => {
  assert.equal(officialCcQuotaSucceeded({ ok: true, source: 'official-cc-usage-cli' }), true)
  assert.equal(officialCcQuotaSucceeded({ ok: false }), false)
})

test('repairOfficialClaudeBinLink retargets host-dangling /home/kincli links', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-bin-'))
  const bin = path.join(dir, '.local', 'bin', 'claude')
  const ver = path.join(dir, '.local', 'share', 'claude', 'versions', '2.1.241')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.mkdirSync(path.dirname(ver), { recursive: true })
  fs.writeFileSync(ver, '#!/bin/sh\n')
  fs.symlinkSync('/home/kincli/.local/share/claude/versions/2.1.241', bin)
  const fixed = repairOfficialClaudeBinLink(dir)
  assert.equal(fixed.ok, true)
  assert.equal(fixed.repaired, true)
  assert.equal(fs.readlinkSync(bin), path.join('..', 'share', 'claude', 'versions', '2.1.241'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('repairProjectOfficialClaudeBins only rewrites dangling guest links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-fleet-'))
  const home = path.join(root, 'vms', 'vm-13', 'cli-home')
  const bin = path.join(home, '.local', 'bin', 'claude')
  const ver = path.join(home, '.local', 'share', 'claude', 'versions', '2.1.241')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.mkdirSync(path.dirname(ver), { recursive: true })
  fs.writeFileSync(ver, '#!/bin/sh\n')
  fs.symlinkSync('/home/kincli/.local/share/claude/versions/2.1.241', bin)
  const items = repairProjectOfficialClaudeBins(root)
  assert.equal(items.length, 1)
  assert.equal(items[0].repaired, true)
  fs.rmSync(root, { recursive: true, force: true })
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

  assert.equal(o.syncTelemetry, true)
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
  assert.equal(cfg.sync_telemetry, true)
  fs.rmSync(dir, { recursive: true, force: true })
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

test('finalizeOfficialCcTelemetry reloads the engine-aware slot after writing identity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-final-'))
  const vmId = 'vm-05'
  const home = path.join(root, 'vms', vmId, 'cli-home')
  const runDir = path.join(root, 'vms', vmId, 'run')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.mkdirSync(runDir, { recursive: true })
  const machine = 'aa'.repeat(32)
  const user = 'bb'.repeat(32)
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({
      machineID: machine,
      userID: user,
      oauthAccount: { accountUuid: 'acc-1', organizationUuid: 'org-1' },
    }),
  )
  fs.writeFileSync(
    path.join(home, '.claude', '.claude.json'),
    JSON.stringify({
      machineID: 'leftover-machine',
      userID: 'leftover-user',
    }),
  )
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({
      env: {
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DO_NOT_TRACK: '1',
      },
    }),
  )
  fs.writeFileSync(path.join(runDir, 'worker.json'), JSON.stringify({ vm_id: vmId, proxy_required: false }))
  const vmPath = path.join(root, 'vms', `${vmId}.json`)
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: vmId,
      inference_engine: 'rust',
      seed_policy: {
        telemetry_disabled: false,
        disable_nonessential_traffic: true,
        do_not_track: true,
      },
      fingerprint: { session_id: 'sess-5' },
    }),
  )
  let reloadCalls = 0
  const routing = { inference: { engine: 'rust' } }
  const out = await finalizeOfficialCcTelemetry(root, vmId, {
    routing,
    reloadSlot: async (vm, projectRoot, opts) => {
      reloadCalls += 1
      assert.equal(vm.id, vmId)
      assert.equal(projectRoot, root)
      assert.equal(opts.routing, routing)
      return { ok: true, rust_ok: true }
    },
  })
  assert.equal(out.seed_aligned, true)
  assert.equal(out.enabled, true)
  assert.equal(out.official, true)
  assert.equal(out.reloaded, true)
  assert.equal(reloadCalls, 1)
  assert.equal(out.touched, true)
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.seed_policy.telemetry_disabled, false)
  assert.equal(vm.seed_policy.disable_nonessential_traffic, true)
  assert.equal(vm.seed_policy.grove_enabled, false)
  assert.equal(vm.seed_policy.do_not_track, false)
  const worker = JSON.parse(fs.readFileSync(path.join(runDir, 'worker.json'), 'utf8'))
  assert.equal(worker.telemetry.enabled, true)
  assert.equal(worker.telemetry.identity.device_id, machine)
  assert.equal(worker.telemetry.identity.user_id, user)
  assert.equal(worker.telemetry.identity.source, 'official-cc-init')
  assert.equal(fs.existsSync(path.join(runDir, 'telemetry.touch')), true)
  assert.equal(fs.existsSync(path.join(home, '.claude', '.claude.json')), true)
  assert.equal(vm.fingerprint.official_machine_id, machine)
  assert.equal(vm.fingerprint.official_user_id, user)
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
  assert.equal(settings.env.DISABLE_TELEMETRY, undefined)
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1')
  assert.equal(settings.env.DO_NOT_TRACK, undefined)
  assert.equal(settings.grove_enabled, false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('finalize without official IDs keeps sidecar off', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-noid-'))
  const vmId = 'vm-99'
  const home = path.join(root, 'vms', vmId, 'cli-home')
  const runDir = path.join(root, 'vms', vmId, 'run')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'worker.json'), JSON.stringify({ vm_id: vmId, proxy_required: false }))
  fs.writeFileSync(
    path.join(root, 'vms', `${vmId}.json`),
    JSON.stringify({
      id: vmId,
      seed_policy: { telemetry_disabled: true },
      fingerprint: { device_id: 'slot-only', session_id: 'sess-99' },
    }),
  )
  const out = await finalizeOfficialCcTelemetry(root, vmId, { reload: false })
  assert.equal(out.enabled, false)
  assert.equal(out.official, false)
  assert.equal(out.reloaded, false)
  const worker = JSON.parse(fs.readFileSync(path.join(runDir, 'worker.json'), 'utf8'))
  assert.equal(worker.telemetry.enabled, false)
  assert.equal(worker.telemetry.reason, 'waiting_official_identity')
  fs.rmSync(root, { recursive: true, force: true })
})

test('settings persist keeps sync_telemetry explicit on and off', () => {
  const on = normalizeOfficialCcConfig({ enabled: true, wipe: true })
  assert.equal(on.sync_telemetry, true)
  const off = normalizeOfficialCcConfig({ ...on, sync_telemetry: false })
  assert.equal(off.sync_telemetry, false)
  const back = normalizeOfficialCcConfig({ ...off, sync_telemetry: true, wipe: false })
  assert.equal(back.sync_telemetry, true)
  assert.equal(back.wipe, false)
})

test('repo routing.json and the Vite console expose init telemetry sync', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const gw = path.resolve(here, '../..')
  const routing = JSON.parse(fs.readFileSync(path.join(gw, 'src/config/routing.json'), 'utf8'))
  assert.equal(routing.official_cc.sync_telemetry, true)
  assert.equal(routing.official_cc.resident, false)
  assert.equal(routing.official_cc.inference, 'cli-hop')
  assert.equal(routing.official_cc.memory, '500m')

  const pane = fs.readFileSync(path.join(gw, 'web/src/features/settings/official-cc-pane.tsx'), 'utf8')
  assert.match(pane, /id=\{`occ-\$\{key\}`\}/)
  assert.match(pane, /id='occ-resident'/)
  assert.match(pane, /sync_telemetry/)
  assert.match(pane, /同步遥测/)
  assert.match(pane, /hello 后常驻/)
  assert.match(pane, /500 MB（推荐）/)

  const nav = fs.readFileSync(path.join(gw, 'web/src/config/nav.ts'), 'utf8')
  assert.match(nav, /settings: '设置'/)

  const card = fs.readFileSync(path.join(gw, 'web/src/features/vm/official-cc-card.tsx'), 'utf8')
  assert.match(card, /telemetry: '写入遥测'/)
  assert.match(card, /already_initialized/)
  assert.match(card, /此槽已初装过/)
})

function writeOfficialClaudeBin(home) {
  const bin = path.join(home, '.local', 'bin', 'claude')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n')
}

test('resident restore skips incomplete, disabled, and already-running slots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-restore-'))
  const vmId = 'vm-13'
  const home = writeCompletedOfficialHome(root, vmId)
  writeOfficialClaudeBin(home)
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
  writeOfficialClaudeBin(home)
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
  writeOfficialClaudeBin(live)
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

test('bootstrap source never calls Anthropic from the host', () => {
  const src = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/lib/oauth/official-cc-bootstrap.mjs'),
    'utf8',
  )
  assert.equal(/probeVmUsage|host-anthropic|node-fetch/.test(src), false)
})
