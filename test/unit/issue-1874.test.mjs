import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  mergeVmTestSchedulePreserve,
  VM_TEST_SCHEDULE_PREFIX,
  VmTestScheduleRunner,
} from '../../src/lib/admin/vm-test-schedule.mjs'
import {
  fiveHourWindowFromCodexVm,
  preheatNextWindowEnd,
  preheatWindowState,
  resolvePreheatFiveHourWindow,
} from '../../src/lib/admin/vm-test-preheat-window.mjs'
import { parseResetMs } from '../../src/lib/pool/quota-window.mjs'

const codexVm = {
  id: 'vm-codex',
  platform: 'openai',
  codex: {
    has_access: true,
    extra: {
      codex_secondary_used_percent: 42,
      codex_secondary_window_minutes: 300,
      codex_secondary_reset_at: '2026-11-26T18:00:00.000Z',
      codex_primary_used_percent: 12,
      codex_primary_window_minutes: 10080,
      codex_primary_reset_at: '2026-12-01T00:00:00.000Z',
    },
  },
}

class MemorySettings {
  values = new Map()
  get(key, fallback = null) {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : fallback
  }
  set(key, value) {
    this.values.set(key, structuredClone(value))
    return value
  }
  remove(key) {
    this.values.delete(key)
  }
  all() {
    return Object.fromEntries([...this.values].map(([key, value]) => [key, structuredClone(value)]))
  }
}

const panelSaveBody = {
  enabled: true,
  frequency: 'daily',
  time: '09:00',
  timezone: 'Asia/Shanghai',
  model: 'gpt-5-codex',
  prompt: 'ping',
  reasoning_effort: 'medium',
}

test('mergeVmTestSchedulePreserve keeps preheat mode when the save body omits it', () => {
  const merged = mergeVmTestSchedulePreserve(panelSaveBody, {
    mode: 'preheat',
    auto_renew: true,
  })
  assert.equal(merged.mode, 'preheat')
  assert.equal(merged.auto_renew, true)
  const explicit = mergeVmTestSchedulePreserve({ ...panelSaveBody, mode: 'test' }, { mode: 'preheat' })
  assert.equal(explicit.mode, 'test')
})

test('VmTestScheduleRunner.save preserves preheat fields from the panel payload', () => {
  const settings = new MemorySettings()
  settings.set(`${VM_TEST_SCHEDULE_PREFIX}vm-codex`, {
    enabled: true,
    mode: 'preheat',
    auto_renew: true,
    frequency: 'daily',
    time: '09:00',
    timezone: 'Asia/Shanghai',
    cron: '0 9 * * *',
    model: 'gpt-5-codex',
    prompt: 'old',
    max_tokens: null,
    reasoning_effort: 'medium',
  })
  const schedule = new VmTestScheduleRunner({
    projectRoot: '/missing',
    settings: () => settings,
    list: () => [codexVm],
    runTest: async () => ({ ok: true }),
  })
  schedule.save('vm-codex', { ...panelSaveBody, prompt: 'new prompt' })
  const stored = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-codex`)
  assert.equal(stored.mode, 'preheat')
  assert.equal(stored.auto_renew, true)
  assert.equal(stored.prompt, 'new prompt')
})

test('resolvePreheatFiveHourWindow reads Codex extra instead of accountQuota.unified', () => {
  const quota = {
    snapshot: () => ({
      accounts: [{ vm_id: 'vm-codex', account_id: 'vm-codex', unified: { '5h': { utilization: 0, reset: null } } }],
    }),
  }
  const w5 = resolvePreheatFiveHourWindow(codexVm, { projectRoot: null, accountQuota: quota })
  assert.ok(w5.reset)
  assert.equal(Number(w5.utilization).toFixed(2), '0.42')
})

test('preheatNextWindowEnd returns Codex 5h reset without a Claude quota row', () => {
  const now = Date.parse('2026-11-26T12:00:00.000Z')
  const end = preheatNextWindowEnd(codexVm, { projectRoot: null, accountQuota: { snapshot: () => ({ accounts: [] }) } })
  assert.equal(end, Date.parse('2026-11-26T18:00:00.000Z'))
  const live = preheatWindowState(codexVm, {
    projectRoot: null,
    accountQuota: { snapshot: () => ({ accounts: [] }) },
    now,
  })
  assert.equal(live.windowLive, true)
  assert.equal(live.hasCredential, true)
})

test('fiveHourWindowFromCodexVm reads vm file extra on disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-1874-'))
  const vmId = 'vm-codex-disk'
  const vmDir = path.join(root, 'vms', vmId)
  fs.mkdirSync(vmDir, { recursive: true })
  const extra = {
    codex_secondary_used_percent: 5,
    codex_secondary_window_minutes: 300,
    codex_secondary_reset_at: '2026-11-27T10:00:00.000Z',
  }
  fs.writeFileSync(
    path.join(root, 'vms', `${vmId}.json`),
    JSON.stringify({ id: vmId, platform: 'openai', codex: { extra } }),
  )
  const w5 = fiveHourWindowFromCodexVm(root, { id: vmId, platform: 'openai', codex: { extra } })
  assert.equal(parseResetMs(w5.reset), Date.parse('2026-11-27T10:00:00.000Z'))
})
