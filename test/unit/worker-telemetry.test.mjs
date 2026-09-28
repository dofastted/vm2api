import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildWorkerTelemetry, touchTelemetrySession } from '../../src/lib/vm/worker-telemetry.mjs'
import { syncWorkerTelemetry } from '../../src/lib/vm/vm-runtime.mjs'
import { slotRuntimeOwner } from '../../src/lib/oauth/oauth-credentials.mjs'

const MACHINE = 'aa'.repeat(32)
const USER = 'bb'.repeat(32)

function writeOfficialHome(root, vmId) {
  const home = path.join(root, 'vms', vmId, 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({
      machineID: MACHINE,
      userID: USER,
      oauthAccount: {
        accountUuid: 'acc-official',
        organizationUuid: 'org-official',
      },
    }),
  )
  return home
}

test('sidecar stays off without official identity', () => {
  const out = buildWorkerTelemetry(
    {
      id: 'vm-09',
      seed_policy: { telemetry_disabled: false },
      fingerprint: { device_id: 'slot-device', session_id: 'sess-9' },
    },
    os.tmpdir(),
  )
  assert.equal(out.enabled, false)
  assert.equal(out.reason, 'waiting_official_identity')
})

test('sidecar enables with official ~/.claude.json IDs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-'))
  writeOfficialHome(root, 'vm-02')
  const vm = {
    id: 'vm-02',
    seed_policy: { telemetry_disabled: false },
    fingerprint: { device_id: 'd2', session_id: 's2' },
  }
  const out = buildWorkerTelemetry(vm, root)
  assert.equal(out.enabled, true)
  assert.equal(out.identity.device_id, MACHINE)
  assert.equal(out.identity.user_id, USER)
  assert.equal(out.identity.source, 'official-cc-init')
  assert.equal(out.identity.cli_version, '2.1.284')
  assert.equal(out.identity.env.version, '2.1.284')
  assert.match(out.betas, /thinking-binding-controls-2026-08-01/)
  assert.match(out.betas, /advanced-tool-use-2025-11-20/)
  assert.match(out.betas, /mid-conversation-system-clear-at-2026-08-21/)
  assert.match(out.betas, /extended-cache-ttl-2025-04-11/)
  assert.doesNotMatch(out.betas, /fallback-credit-2026-06-01/)
  assert.doesNotMatch(out.betas, /context-1m/)
  assert.equal(out.identity.betas, out.betas)
  fs.rmSync(root, { recursive: true, force: true })
})

test('syncWorkerTelemetry writes enabled:true when official IDs exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-'))
  writeOfficialHome(root, 'vm-02')
  const vm = {
    id: 'vm-02',
    seed_policy: { telemetry_disabled: false },
    fingerprint: { device_id: 'd2', session_id: 's2' },
  }
  const runDir = path.join(root, 'vms', 'vm-02', 'run')
  fs.mkdirSync(runDir, { recursive: true })
  const cfgPath = path.join(runDir, 'worker.json')
  fs.writeFileSync(cfgPath, JSON.stringify({ vm_id: 'vm-02', proxy_required: false }))
  const out = syncWorkerTelemetry(vm, root)
  assert.equal(out.wrote, true)
  assert.equal(out.enabled, true)
  const doc = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  assert.equal(doc.telemetry.enabled, true)
  assert.equal(doc.proxy_required, false)
  const touch = touchTelemetrySession(root, 'vm-02')
  assert.equal(touch.wrote, true)
  assert.equal(fs.existsSync(path.join(runDir, 'telemetry.touch')), true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('syncWorkerTelemetry chowns the replaced worker.json to the slot uid', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-owner-'))
  writeOfficialHome(root, 'vm-02')
  const vm = {
    id: 'vm-02',
    seed_policy: { telemetry_disabled: false },
    fingerprint: { device_id: 'd2', session_id: 's2' },
  }
  const cfgPath = path.join(root, 'vms', 'vm-02', 'run', 'worker.json')
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
  fs.writeFileSync(cfgPath, JSON.stringify({ vm_id: 'vm-02', proxy_required: false }))
  const owner = slotRuntimeOwner(vm)
  const calls = []
  const chown = mock.method(fs, 'chownSync', (file, uid, gid) => {
    calls.push({ file, uid, gid })
  })
  try {
    const out = syncWorkerTelemetry(vm, root)
    assert.equal(out.wrote, true)
    const owned = calls.filter((call) => String(call.file).includes(`${path.sep}worker.json`))
    assert.ok(owned.length >= 1)
    assert.ok(owned.every((call) => call.uid === owner.uid && call.gid === owner.gid))
    assert.ok(owned.some((call) => call.file !== cfgPath && String(call.file).startsWith(`${cfgPath}.`)))
    assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).telemetry.enabled, true)
  } finally {
    chown.mock.restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
