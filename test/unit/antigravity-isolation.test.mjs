import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isCredentialRefreshTarget } from '../../src/lib/oauth/credential-refresh-monitor.mjs'
import { isUsageProbeTarget } from '../../src/lib/oauth/usage-probe-monitor.mjs'
import { isCliNodeGuardTarget } from '../../src/lib/vm/cli-node-guard.mjs'
import { installKernelTargets } from '../../src/lib/vm/kernel-install.mjs'
import { syncNativeTelemetry } from '../../src/lib/vm/vm-runtime.mjs'
import { retireLegacyTelemetry, readSlotProcessStatus } from '../../src/lib/vm/slot-process-status.mjs'
import { collectLivePanelCredentials } from '../../src/lib/admin/panel-live-credentials.mjs'
import {
  summarizeVm,
  vmHasClaudeCredential,
  vmHasSchedulableCredential,
  isVmScheduleReady,
} from '../../src/lib/vm/vm-registry.mjs'
import { resolveInferenceEngine, resolveOfficialCcInference } from '../../src/lib/vm/slot-engine.mjs'
import { isKernelWatchdogTarget } from '../../src/lib/transport/kernel-watchdog.mjs'
import {
  isVmTestScheduleTarget,
  normalizeVmTestSchedule,
  VmTestScheduleRunner,
  VM_TEST_SCHEDULE_PREFIX,
} from '../../src/lib/admin/vm-test-schedule.mjs'

const antigravity = {
  id: 'vm-ag-01',
  platform: 'antigravity',
  family: 'claude',
  codex_kernel: true,
  status: 'running',
  schedulable: true,
  has_token: true,
  has_refresh: true,
  inference_engine: 'rust',
  proxy: { url: 'socks5h://127.0.0.1:1080' },
  proxy_cli_enabled: true,
  seed_policy: { telemetry_disabled: false },
  claude: {
    email: 'old-claude@example.test',
    accessToken: 'must-not-leak-access',
    refreshToken: 'must-not-leak-refresh',
    has_access: true,
    has_refresh: true,
  },
  antigravity: { email: 'antigravity@example.test' },
}

function tempProject(t) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-isolation-'))
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
  return projectRoot
}

test('Antigravity never becomes a Claude maintenance or inference target from stale flags', () => {
  assert.equal(vmHasClaudeCredential(antigravity), false)
  assert.equal(vmHasSchedulableCredential(antigravity), false)
  assert.equal(isVmScheduleReady(antigravity, { allowMissingCredential: true }), false)
  assert.equal(isCredentialRefreshTarget(antigravity), false)
  assert.equal(isUsageProbeTarget(antigravity), false)
  assert.equal(isCliNodeGuardTarget(antigravity), false)
  assert.equal(resolveInferenceEngine(antigravity, { inference: { engine: 'rust' } }), null)
  assert.equal(resolveOfficialCcInference(antigravity, { inference: { engine: 'rust' } }), null)
  assert.equal(isKernelWatchdogTarget(antigravity, { inference: { engine: 'rust' } }), false)
})

test('Antigravity summary exposes its own metadata without inherited Claude credentials', () => {
  const summary = summarizeVm(antigravity)
  assert.equal(summary.platform, 'antigravity')
  assert.equal(summary.family, 'antigravity')
  assert.equal(summary.email, 'antigravity@example.test')
  assert.equal(summary.has_token, false)
  assert.equal(summary.has_refresh, false)
  assert.equal(summary.can_claude_reset, false)
  assert.equal(summary.schedulable, false)
  assert.equal(summary.inference_engine, 'antigravity')
  assert.equal(summary.schedule_disabled_reason, 'antigravity_official_login_required')
  assert.equal(summary.antigravity.credential_storage, 'slot-official-client')
  assert.equal(JSON.stringify(summary).includes('must-not-leak'), false)
  assert.equal(JSON.stringify(summary).includes('old-claude@example.test'), false)
})

test('Antigravity summary reads only confirmed public auth metadata without importing tokens', (t) => {
  const projectRoot = tempProject(t)
  const dir = path.join(projectRoot, 'vms', antigravity.id, 'run')
  fs.mkdirSync(dir, { recursive: true })
  const authPath = path.join(dir, 'antigravity-auth.json')
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      authenticated: true,
      updated_at: 123456,
      email: 'official@example.test',
      access_token: 'must-not-leak-access',
      refresh_token: 'must-not-leak-refresh',
    }),
  )
  const summary = summarizeVm(antigravity, projectRoot)
  assert.equal(summary.antigravity.authenticated, true)
  assert.equal(summary.antigravity.credential_state, 'authenticated')
  assert.equal(summary.antigravity.updated_at, 123456)
  assert.equal(summary.email, 'official@example.test')
  assert.equal(summary.has_token, false)
  assert.equal(summary.has_refresh, false)
  assert.doesNotMatch(JSON.stringify(summary), /must-not-leak/)
  assert.equal(vmHasSchedulableCredential(summary), true)
  assert.equal(summary.schedulable, true)
  fs.writeFileSync(authPath, JSON.stringify({ authenticated: false, updated_at: 123457 }))
  const loggedOut = summarizeVm(antigravity, projectRoot)
  assert.equal(loggedOut.email, null)
  assert.equal(loggedOut.antigravity.credential_state, 'unauthenticated')
  fs.writeFileSync(authPath, '{invalid-json')
  assert.equal(summarizeVm(antigravity, projectRoot).antigravity.authenticated, null)
})

test('Claude telemetry stays disabled with an official identity and stale worker config on disk', async (t) => {
  const projectRoot = tempProject(t)
  const dir = path.join(projectRoot, 'vms', antigravity.id)
  fs.mkdirSync(path.join(dir, 'cli-home', '.claude'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'run'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'cli-home', '.claude.json'), JSON.stringify({ userID: 'a'.repeat(64) }))
  fs.writeFileSync(path.join(dir, 'run', 'worker.json'), JSON.stringify({ telemetry: { enabled: true } }))
  assert.deepEqual(syncNativeTelemetry(antigravity, projectRoot), {
    wrote: false,
    supported: false,
    enabled: false,
    error: 'telemetry_unsupported',
  })
  const calls = []
  const result = await retireLegacyTelemetry({
    projectRoot,
    vm: { ...antigravity, runtime: { type: 'docker' } },
    run: async (...args) => {
      calls.push(args)
      return { stdout: 'rust_pid1=0\ngo_worker_pid1=0\ngo_telemetry=0\n' }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.running, false)
  const status = await readSlotProcessStatus({
    projectRoot,
    vm: antigravity,
    health: async () => {
      throw new Error('Antigravity must not probe the Claude kernel')
    },
  })
  assert.equal(status.telemetry.state, 'unsupported')
  assert.equal(calls.length, 0)
})

test('live Claude credential collection skips Antigravity slots', async (t) => {
  const projectRoot = tempProject(t)
  const view = await collectLivePanelCredentials(projectRoot, [antigravity], { cacheMs: 0 })
  assert.equal(view.size, 0)
})

const scheduleConfig = {
  enabled: true,
  frequency: 'hourly',
  minute: 17,
  timezone: 'UTC',
  model: 'claude-haiku-4-5',
  prompt: 'hello',
  max_tokens: 32,
}

function scheduleFixture(vms, runTest = async () => ({ ok: true })) {
  const records = new Map()
  const settings = {
    get: (key) => structuredClone(records.get(key) ?? null),
    set: (key, value) => records.set(key, structuredClone(value)),
    remove: (key) => records.delete(key),
    all: () => Object.fromEntries(records),
  }
  const schedule = new VmTestScheduleRunner({ projectRoot: '/missing-project', settings, list: () => vms, runTest })
  return { schedule, records }
}

test('scheduled Claude and GPT tests exclude Antigravity from individual and bulk updates', (t) => {
  const claude = { id: 'vm-claude-01', platform: 'anthropic' }
  const gpt = { id: 'vm-gpt-01', platform: 'openai' }
  const unknown = { id: 'vm-unknown-01', platform: 'unsupported' }
  const { schedule, records } = scheduleFixture([claude, gpt, antigravity, unknown])
  t.after(() => schedule.stop())
  assert.equal(isVmTestScheduleTarget(antigravity), false)
  assert.throws(() => normalizeVmTestSchedule(scheduleConfig, antigravity), { code: 'platform_not_supported' })
  assert.throws(() => schedule.save(antigravity.id, scheduleConfig), { code: 'platform_not_supported' })
  assert.throws(() => schedule.applyScheduleStructure(antigravity.id, scheduleConfig), {
    code: 'platform_not_supported',
  })
  const result = schedule.syncSchedules({ scope: 'all', schedule: scheduleConfig })
  assert.deepEqual(result.updated, [claude.id, gpt.id])
  assert.deepEqual(result.unsupported, [antigravity.id, unknown.id])
  assert.equal(records.has(`${VM_TEST_SCHEDULE_PREFIX}${antigravity.id}`), false)
  assert.equal(records.has(`${VM_TEST_SCHEDULE_PREFIX}${unknown.id}`), false)
})

test('old Antigravity scheduled tests remain inactive after reload or platform changes', async (t) => {
  const vms = [{ ...antigravity, platform: 'anthropic' }]
  const calls = []
  const { schedule, records } = scheduleFixture(vms, async (...args) => calls.push(args))
  t.after(() => schedule.stop())
  schedule.save(antigravity.id, scheduleConfig)
  schedule.start()
  const job = schedule.jobs.get(antigravity.id)
  assert.ok(job)
  vms[0] = antigravity
  await job.trigger()
  assert.equal(calls.length, 0)
  assert.equal(schedule.jobs.has(antigravity.id), false)
  schedule.reload()
  assert.equal(schedule.jobs.size, 0)
  assert.equal(schedule.get(antigravity.id), null)
  assert.equal(records.has(`${VM_TEST_SCHEDULE_PREFIX}${antigravity.id}`), true)
})

test('kernel installation rejects Antigravity before lifecycle or credential changes', async (t) => {
  const projectRoot = tempProject(t)
  const file = path.join(projectRoot, 'vms', `${antigravity.id}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const original = JSON.stringify(antigravity)
  fs.writeFileSync(file, original)
  const result = await installKernelTargets({
    projectRoot,
    targets: [{ id: antigravity.id, kernel: 'cli-node' }],
    ops: {
      stopSlot() {
        throw new Error('must not stop Antigravity')
      },
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.items[0].code, 'kernel_platform_unsupported')
  assert.equal(fs.readFileSync(file, 'utf8'), original)
})
