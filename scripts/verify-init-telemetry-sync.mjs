/**
 * Live / fixture verification for official-cc init → telemetry sync.
 * Fake keys and fake ~/.claude.json only. Never prints secrets.
 * Usage (on the gateway host):
 *   node scripts/verify-init-telemetry-sync.mjs
 *   VERIFY_LIVE=1 node scripts/verify-init-telemetry-sync.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeOfficialCcTelemetry, normalizeOfficialCcConfig } from '../src/lib/oauth/official-cc-bootstrap.mjs'
import { TELEMETRY_KILL_ENV_KEYS } from '../src/lib/protocol/seed-policy.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const rootGuess = path.resolve(here, '..')
const projectRoot =
  process.env.KIN_PROJECT_ROOT ||
  (fs.existsSync(path.join(rootGuess, 'src/lib/oauth/official-cc-bootstrap.mjs')) ? rootGuess : '/opt/kin-gateway')

const FAKE_KEY = 'sk-kin-deadbeefdeadbeefdeadbeefdeadbeef'
const FAKE_SESSION = 'sk-ant-sid01-FAKEVERIFYONLY-not-a-real-session'
const MACHINE = 'cc'.repeat(32)
const USER = 'dd'.repeat(32)
const results = []

function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail || '') })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${name}${detail ? `  ${detail}` : ''}`)
}

function codeOf(res) {
  return Number(res.status || 0)
}

async function liveHttp() {
  const base = process.env.KIN_VERIFY_BASE || 'http://127.0.0.1:8787'
  const headers = { Authorization: `Bearer ${FAKE_KEY}`, 'Content-Type': 'application/json' }
  const panel = await fetch(`${base}/api/panel/routing`, { headers })
  record('fake sk-kin cannot GET /api/panel/routing', [401, 403].includes(codeOf(panel)), `http ${codeOf(panel)}`)
  const models = await fetch(`${base}/v1/models`, { headers })
  record('fake sk-kin cannot GET /v1/models', [401, 403].includes(codeOf(models)), `http ${codeOf(models)}`)
  const seed = await fetch(`${base}/api/panel/vms/vm-99/seed-settings`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ telemetry_disabled: false }),
  })
  record('fake sk-kin cannot PUT seed-settings', [401, 403].includes(codeOf(seed)), `http ${codeOf(seed)}`)
  const login = await fetch(`${base}/api/panel/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'verify-fake', password: FAKE_SESSION }),
  })
  record('fake console login is rejected', codeOf(login) === 401, `http ${codeOf(login)}`)
  const health = await fetch(`${base}/health`)
  let healthOk = false
  try {
    const body = await health.json()
    healthOk = health.status === 200 && (body.ok === true || body.status === 'ok')
    record('GET /health', healthOk, `http ${health.status} status=${body.status || body.ok}`)
  } catch (e) {
    record('GET /health', false, String(e.message || e))
  }
}

function fixtureFinalize() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-verify-init-'))
  const vmId = 'vm-98'
  const home = path.join(root, 'vms', vmId, 'cli-home')
  const runDir = path.join(root, 'vms', vmId, 'run')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({
      machineID: MACHINE,
      userID: USER,
      oauthAccount: { accountUuid: 'acc-fake', organizationUuid: 'org-fake', emailAddress: 'fake@example.invalid' },
    }),
  )
  fs.writeFileSync(
    path.join(home, '.claude', '.claude.json'),
    JSON.stringify({
      machineID: 'leftover',
      userID: 'leftover',
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
      seed_policy: {
        telemetry_disabled: false,
        disable_nonessential_traffic: true,
        do_not_track: true,
      },
      fingerprint: { device_id: 'slot-preset', session_id: 'sess-fake' },
    }),
  )
  const out = finalizeOfficialCcTelemetry(root, vmId, { reload: false })
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  const worker = JSON.parse(fs.readFileSync(path.join(runDir, 'worker.json'), 'utf8'))
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
  const leftoverGone = !fs.existsSync(path.join(home, '.claude', '.claude.json'))
  const killGone = TELEMETRY_KILL_ENV_KEYS.every((k) => settings.env?.[k] == null)
  record(
    'fake official IDs enable sidecar without docker reload',
    out.enabled === true && out.official === true && out.reloaded === false,
  )
  record(
    'leftover seed flags cleared',
    vm.seed_policy?.telemetry_disabled === false &&
      vm.seed_policy?.disable_nonessential_traffic === false &&
      vm.seed_policy?.do_not_track === false,
  )
  record(
    'worker identity is official fake IDs',
    worker.telemetry?.identity?.device_id === MACHINE &&
      worker.telemetry?.identity?.user_id === USER &&
      worker.telemetry?.identity?.source === 'official-cc-init',
  )
  record('kill-switch env deleted from settings.json', killGone)
  record('leftover ~/.claude/.claude.json discarded', leftoverGone)
  record(
    'fingerprint overwritten by official machineID',
    vm.fingerprint?.official_machine_id === MACHINE && vm.fingerprint?.device_id === MACHINE,
  )
  record('telemetry.touch written', fs.existsSync(path.join(runDir, 'telemetry.touch')))
  fs.rmSync(root, { recursive: true, force: true })
}

function fixtureNoIdentity() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-verify-noid-'))
  const vmId = 'vm-97'
  const runDir = path.join(root, 'vms', vmId, 'run')
  fs.mkdirSync(path.join(root, 'vms', vmId, 'cli-home', '.claude'), { recursive: true })
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'worker.json'), JSON.stringify({ vm_id: vmId }))
  fs.writeFileSync(
    path.join(root, 'vms', `${vmId}.json`),
    JSON.stringify({
      id: vmId,
      seed_policy: { telemetry_disabled: true },
      fingerprint: { device_id: 'slot-only' },
    }),
  )
  const out = finalizeOfficialCcTelemetry(root, vmId, { reload: false })
  const worker = JSON.parse(fs.readFileSync(path.join(runDir, 'worker.json'), 'utf8'))
  record(
    'no official IDs keeps sidecar off',
    out.enabled === false && out.official === false && worker.telemetry?.enabled === false,
  )
  fs.rmSync(root, { recursive: true, force: true })
}

function liveFiles() {
  const routingFile = path.join(projectRoot, 'src/config/routing.json')
  const routing = JSON.parse(fs.readFileSync(routingFile, 'utf8'))
  const occ = normalizeOfficialCcConfig(routing.official_cc)
  record('routing.json sync_telemetry default on', occ.sync_telemetry === true)
  const pane = path.join(projectRoot, 'web/src/features/settings/official-cc-pane.tsx')
  const exists = fs.existsSync(pane)
  const html = exists ? fs.readFileSync(pane, 'utf8') : ''
  const htmlOk = exists && html.includes('occ-') && html.includes('同步遥测') && html.includes('sync_telemetry')
  record(`Vite official-cc pane ${pane}`, htmlOk)
  return htmlOk
}

async function liveMasterRead() {
  if (!process.env.VERIFY_LIVE) return
  const envText = await (await import('node:child_process')).execFileSync(
    'systemctl',
    ['show', 'kin-gateway', '-p', 'Environment', '--value'],
    {
      encoding: 'utf8',
    },
  )
  const master = String(envText || '')
    .split(/\s+/)
    .map((p) => p.split('='))
    .find((p) => p[0] === 'KIN_API_KEY')?.[1]
  if (!master) {
    record('master key present for routing GET', false, 'KIN_API_KEY missing')
    return
  }
  const res = await fetch(process.env.KIN_VERIFY_BASE || 'http://127.0.0.1:8787/api/panel/routing', {
    headers: { Authorization: `Bearer ${master}` },
  })
  const body = await res.json().catch(() => ({}))
  const occ = body?.data?.official_cc || body?.official_cc || {}
  record(
    'live GET /api/panel/routing sync_telemetry',
    res.status === 200 && occ.sync_telemetry !== false,
    `http ${res.status}`,
  )
}

const live = process.argv.includes('--live') || process.env.VERIFY_LIVE === '1'
fixtureFinalize()
fixtureNoIdentity()
liveFiles()
if (live) {
  await liveHttp()
  await liveMasterRead()
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
