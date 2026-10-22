import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildWorkerTelemetry,
  telemetryUploadInterval,
  touchTelemetrySession,
  validateTelemetryRoutingPatch,
} from '../../src/lib/vm/worker-telemetry.mjs'
import { syncWorkerTelemetry } from '../../src/lib/vm/vm-runtime.mjs'
import { FULL_ENV_KEYS } from '../../src/lib/identity/telemetry-env.mjs'
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
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-02', 'cli-home', '.claude', 'kin-official-bootstrap.json'),
    JSON.stringify({ status: 'ok', finished_at: '2026-10-07T06:36:42.123Z' }),
  )
  const vm = {
    id: 'vm-02',
    seed_policy: { telemetry_disabled: false },
    fingerprint: { device_id: 'd2', session_id: 's2', shell: '/bin/zsh', vcs: 'git', runtimes: 'bun,node' },
  }
  const out = buildWorkerTelemetry(vm, root)
  assert.equal(out.enabled, true)
  assert.equal(out.identity.device_id, USER)
  assert.equal(out.identity.user_id, USER)
  assert.equal(out.identity.source, 'official-cc-init')
  assert.equal(out.betas, undefined)
  assert.equal(out.identity.betas, undefined)
  assert.equal(out.identity.env.shell, 'zsh')
  assert.equal(out.identity.env.vcs, 'git')
  assert.equal(out.identity.env.runtimes, 'bun,node')
  assert.equal(out.identity.env.build_time, '2026-10-07T06:36:42Z')
  assert.equal(out.identity.env.node_version, undefined)
  assert.equal(out.identity.env.is_running_with_bun, undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

test('machine id alone is not the 64-hex device id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-'))
  const home = path.join(root, 'vms', 'vm-02', 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ machineID: MACHINE, userID: 'not-64-hex' }))
  const out = buildWorkerTelemetry({ id: 'vm-02', seed_policy: { telemetry_disabled: false } }, root)
  assert.equal(out.enabled, false)
  assert.equal(out.reason, 'waiting_official_identity')
  fs.rmSync(root, { recursive: true, force: true })
})

test('current CLI writes only userID into CLAUDE_CONFIG_DIR and the sidecar still enables', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-'))
  const home = path.join(root, 'vms', 'vm-04', 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(
    path.join(home, '.claude', '.claude.json'),
    JSON.stringify({ userID: USER, oauthAccount: { accountUuid: 'acc-new', organizationUuid: 'org-new' } }),
  )
  const out = buildWorkerTelemetry({ id: 'vm-04', seed_policy: { telemetry_disabled: false } }, root)
  assert.equal(out.enabled, true)
  assert.equal(out.identity.user_id, USER)
  assert.equal(out.identity.account_uuid, 'acc-new')
  fs.rmSync(root, { recursive: true, force: true })
})

test('slot record official_user_id is the fallback when the CLI config is gone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-'))
  fs.mkdirSync(path.join(root, 'vms', 'vm-05', 'cli-home', '.claude'), { recursive: true })
  const out = buildWorkerTelemetry(
    {
      id: 'vm-05',
      seed_policy: { telemetry_disabled: false },
      fingerprint: { official_user_id: USER, identity_source: 'official-cc-init' },
    },
    root,
  )
  assert.equal(out.enabled, true)
  assert.equal(out.identity.user_id, USER)
  fs.rmSync(root, { recursive: true, force: true })
})

test('GPT slots never run the Claude sidecar even with a CLI userID on disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-'))
  writeOfficialHome(root, 'vm-codex-02')
  const out = buildWorkerTelemetry(
    { id: 'vm-codex-02', platform: 'openai', seed_policy: { telemetry_disabled: false } },
    root,
  )
  assert.equal(out.enabled, false)
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

test('upload interval comes from routing.json and falls back to 10 minutes', (t) => {
  const saved = process.env.KIN_ROUTING_FILE
  delete process.env.KIN_ROUTING_FILE
  t.after(() => {
    if (saved === undefined) delete process.env.KIN_ROUTING_FILE
    else process.env.KIN_ROUTING_FILE = saved
  })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-'))
  writeOfficialHome(root, 'vm-02')
  const vm = { id: 'vm-02', seed_policy: { telemetry_disabled: false } }
  assert.equal(buildWorkerTelemetry(vm, root).upload_interval_seconds, 600)
  fs.mkdirSync(path.join(root, 'src', 'config'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'src', 'config', 'routing.json'),
    JSON.stringify({ telemetry: { upload_interval_seconds: 7200 } }),
  )
  assert.equal(buildWorkerTelemetry(vm, root).upload_interval_seconds, 7200)
  assert.equal(
    buildWorkerTelemetry(vm, root, { telemetry: { upload_interval_seconds: 180 } }).upload_interval_seconds,
    180,
  )
  for (const bad of [0, 30, 90, 86_460, '600', null]) {
    assert.equal(telemetryUploadInterval({ telemetry: { upload_interval_seconds: bad } }), 600)
  }
  fs.rmSync(root, { recursive: true, force: true })
})

test('routing patch accepts whole minutes from 1 minute to 24 hours', () => {
  assert.deepEqual(validateTelemetryRoutingPatch({ telemetry: { upload_interval_seconds: 60 } }), [])
  assert.deepEqual(validateTelemetryRoutingPatch({ telemetry: { upload_interval_seconds: 86_400 } }), [])
  assert.deepEqual(validateTelemetryRoutingPatch({ sticky: {} }), [])
  for (const bad of [0, 59, 90, 86_460, '600', 600.5]) {
    assert.equal(validateTelemetryRoutingPatch({ telemetry: { upload_interval_seconds: bad } }).length, 1)
  }
  assert.equal(validateTelemetryRoutingPatch({ telemetry: [] }).length, 1)
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

test('sidecar env uses observed shell/runtimes and never guest hardware', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-hw-'))
  writeOfficialHome(root, 'vm-02')
  const vm = {
    id: 'vm-02',
    seed_policy: { telemetry_disabled: false },
    fingerprint: {
      device_id: 'd2',
      session_id: 's2',
      os_id: 'ubuntu',
      os_pretty: 'Ubuntu 24.04.4 LTS',
      kernel_release: '6.8.0-guest',
      hardware: {
        cpu_model: 'Intel(R) Xeon(R) CPU',
        cpu_cores: 4,
        memory_bytes: 4294967296,
        root_disk: '/dev/vda2',
        mac: '52:54:00:11:22:33',
        dmi: {
          manufacturer: 'Dell Inc.',
          product: 'OptiPlex 7090',
          version: '1.0',
          family: 'OptiPlex',
          serial: 'ABC123',
          uuid: '11111111-2222-3333-4444-555555555555',
        },
        shell: '/bin/zsh',
        package_managers: 'apt,pacman',
        runtimes: 'bun,node',
      },
    },
  }
  const out = buildWorkerTelemetry(vm, root)
  assert.equal(out.enabled, true)
  assert.equal(out.identity.shell, 'zsh')
  assert.equal(out.identity.package_managers, 'apt,pacman')
  assert.equal(out.identity.runtimes, 'bun,node')
  assert.equal(out.identity.env.shell, 'zsh')
  assert.equal(out.identity.env.package_managers, 'apt,pacman')
  assert.equal(out.identity.env.runtimes, 'bun,node')
  // Official CLI env carries none of these; they stay on the panel card only.
  for (const key of [
    'cpu_model',
    'cpu_cores',
    'memory_bytes',
    'root_disk',
    'mac',
    'dmi_manufacturer',
    'dmi_product',
    'dmi_version',
    'dmi_family',
    'dmi_serial',
    'dmi_uuid',
  ]) {
    assert.equal(Object.hasOwn(out.identity.env, key), false, key)
    assert.equal(Object.hasOwn(out.identity, key), false, key)
  }
  assert.deepEqual(
    Object.keys(out.identity.env).filter((key) => !FULL_ENV_KEYS.includes(key)),
    [],
  )
  assert.equal(out.identity.env.linux_kernel, '6.8.0-guest')
  fs.rmSync(root, { recursive: true, force: true })
})

test('old VMs without hardware keep previous telemetry env fallbacks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tel-old-'))
  writeOfficialHome(root, 'vm-02')
  const vm = {
    id: 'vm-02',
    seed_policy: { telemetry_disabled: false },
    fingerprint: { device_id: 'd2', session_id: 's2', shell: '/bin/zsh', runtimes: 'bun,node' },
  }
  const out = buildWorkerTelemetry(vm, root)
  assert.equal(out.enabled, true)
  assert.equal(out.identity.env.shell, 'zsh')
  assert.equal(out.identity.env.package_managers, '')
  assert.equal(out.identity.env.runtimes, 'bun,node')
  assert.equal(out.identity.env.cpu_model, undefined)
  assert.equal(out.identity.env.dmi_uuid, undefined)
  fs.rmSync(root, { recursive: true, force: true })
})
