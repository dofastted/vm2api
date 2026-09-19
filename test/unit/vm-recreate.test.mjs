import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { US_TIMEZONES } from '../../src/lib/core/timezone.mjs'
import { buildRecreatedVmRecord, recreateVmFiles } from '../../src/lib/vm/vm-recreate.mjs'
import { destroyVmRuntime } from '../../src/lib/vm/vm-runtime.mjs'

test('recreated record keeps slot identity and drops credentials', () => {
  const prev = {
    id: 'vm-07',
    name: '07',
    kernel: 'debian-12',
    timezone: 'America/Chicago',
    timezone_source: 'manual',
    locale: 'en_US.UTF-8',
    note: 'keep me',
    proxy: { id: 'px-7', url: 'socks5h://127.0.0.1:1080' },
    policy: { maxConcurrency: 12, weight: 3, priority: 9, inflight: 4, allowed_models: ['claude-sonnet-5'] },
    claude: { email: 'old@kin.test', has_access: true },
    fingerprint: { device_id: 'old-dev', session_id: 'old-sess' },
    stats: { calls: 9 },
    created_at: '2026-01-01T00:00:00.000Z',
    seed_policy: { telemetry_disabled: false, theme: 'light' },
    proxy_cli_enabled: true,
    utilization_5h: 0.9,
    account_tier: 'max',
    inference_engine: 'rust',
    persona_preset: 'zero',
  }
  const next = buildRecreatedVmRecord(prev)
  assert.equal(next.id, 'vm-07')
  assert.equal(next.name, '07')
  assert.equal(next.kernel, 'debian-12')
  assert.equal(next.timezone, 'America/Chicago')
  assert.equal(next.timezone_source, 'manual')
  assert.deepEqual(next.proxy, prev.proxy)
  assert.equal(next.policy.maxConcurrency, 12)
  assert.equal(next.policy.weight, 3)
  assert.equal(next.policy.priority, 9)
  assert.equal(next.policy.inflight, 0)
  assert.deepEqual(next.policy.allowed_models, ['claude-sonnet-5'])
  assert.deepEqual(next.claude, {})
  assert.equal(next.platform, 'anthropic')
  assert.equal(next.family, 'claude')
  assert.deepEqual(next.stats, {})
  assert.equal(next.created_at, prev.created_at)
  assert.equal(next.schedulable, false)
  assert.equal(next.schedule_disabled_reason, 'no_credential')
  assert.notEqual(next.fingerprint.device_id, 'old-dev')
  assert.match(next.fingerprint.device_id, /^[0-9a-f]{64}$/)
  assert.match(next.fingerprint.hostname, /^debian-[0-9a-f]{4}$/)
  assert.match(next.fingerprint.guest_machine_id, /^[0-9a-f]{32}$/)
  assert.equal(next.utilization_5h, undefined)
  assert.equal(next.account_tier, undefined)
  assert.equal(next.seed_policy.telemetry_disabled, false)
  assert.equal(next.inference_engine, 'rust')
  assert.equal(next.persona_preset, 'zero')
})

test('recreated records preserve and normalize non-US timezones', () => {
  for (const timezone of ['Asia/Tokyo', ' asia/tokyo ']) {
    const next = buildRecreatedVmRecord({ id: 'vm-07', timezone })
    assert.equal(next.timezone, 'Asia/Tokyo')
    assert.equal(next.fingerprint.timezone, 'Asia/Tokyo')
  }
})

test('recreated records use the generated US fallback for missing or invalid timezones', () => {
  for (const timezone of [undefined, 'Invalid/Zone', 'America/Not_A_Zone', '+09:00']) {
    const next = buildRecreatedVmRecord({ id: 'vm-07', timezone })
    assert.ok(US_TIMEZONES.includes(next.timezone))
    assert.equal(next.fingerprint.timezone, next.timezone)
  }
})

test('recreateVmFiles wipes home leftover and reseeds settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-recreate-'))
  const id = 'vm-03'
  const home = path.join(root, 'vms', id, 'cli-home', '.claude')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'credentials.json'), '{"claudeAiOauth":{}}')
  fs.writeFileSync(path.join(root, 'vms', `${id}-chat.json`), '{"x":1}')
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      name: '03',
      kernel: 'ubuntu-24.04',
      timezone: 'Asia/Tokyo',
      locale: 'en_US.UTF-8',
      proxy: { id: 'px-3', url: 'socks5h://127.0.0.1:1080' },
      policy: { maxConcurrency: 8, weight: 1 },
      claude: { email: 'wipe@kin.test' },
      seed_policy: { telemetry_disabled: true },
      created_at: '2026-02-01T00:00:00.000Z',
    }),
  )
  const { vm } = recreateVmFiles(root, JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8')))
  assert.equal(vm.id, id)
  assert.equal(vm.claude.email, undefined)
  assert.equal(fs.existsSync(path.join(home, 'credentials.json')), false)
  assert.equal(fs.existsSync(path.join(root, 'vms', `${id}-chat.json`)), false)
  const settings = JSON.parse(
    fs.readFileSync(path.join(root, 'vms', id, 'cli-home', '.claude', 'settings.json'), 'utf8'),
  )
  assert.equal(settings.env.DISABLE_TELEMETRY, '1')
  assert.equal(settings.env.TZ, 'Asia/Tokyo')
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8'))
  assert.equal(saved.proxy.id, 'px-3')
  assert.equal(saved.timezone, 'Asia/Tokyo')
  assert.equal(saved.fingerprint.timezone, 'Asia/Tokyo')
  assert.match(saved.fingerprint.device_id, /^[0-9a-f]{64}$/)
  assert.equal(
    fs.readFileSync(path.join(root, 'vms', id, 'machine-id'), 'utf8').trim(),
    saved.fingerprint.guest_machine_id,
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('destroy missing container is a no-op', () => {
  const r = destroyVmRuntime({ id: 'vm-missing-slot' })
  assert.equal(r.ok, true)
  assert.equal(r.action, 'absent')
})
