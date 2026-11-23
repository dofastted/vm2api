/**
 * Local fixture verification for official-cc init → native policy publication.
 * Fixtures never opt a VM in, generate activity, or claim runtime activation.
 * Usage (on the gateway host):
 *   node scripts/verify-init-telemetry-sync.mjs
 *   VERIFY_LIVE=1 node scripts/verify-init-telemetry-sync.mjs   (or: --live)
 * KIN_VERIFY_BASE is the gateway origin (default http://127.0.0.1:8787); both live
 * checks append their own paths to it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeOfficialCcTelemetry, normalizeOfficialCcConfig } from '../src/lib/oauth/official-cc-bootstrap.mjs'
import { NONESSENTIAL_TRAFFIC_ENV_KEY } from '../src/lib/protocol/seed-policy.mjs'

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

const verifyBase = () => (process.env.KIN_VERIFY_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '')

/** KIN_API_KEY from `systemctl show -p Environment --value`; values may contain `=` (base64 padding). */
function masterKeyFrom(envText) {
  for (const pair of String(envText || '').split(/\s+/)) {
    const at = pair.indexOf('=')
    if (at > 0 && pair.slice(0, at) === 'KIN_API_KEY') return pair.slice(at + 1)
  }
  return ''
}

function codeOf(res) {
  return Number(res.status || 0)
}

async function liveHttp() {
  const base = verifyBase()
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

async function fixtureFinalize() {
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
  const credential = '{"claudeAiOauth":{"accessToken":"fixture-only"}}'
  const backlog = '{"events":[]}'
  fs.writeFileSync(path.join(home, '.claude', 'credentials.json'), credential)
  fs.mkdirSync(path.join(home, '.claude', 'telemetry'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', 'telemetry', 'queue.json'), backlog)
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
  const out = await finalizeOfficialCcTelemetry(root, vmId, { publish: false })
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  const kernel = JSON.parse(fs.readFileSync(path.join(runDir, 'kernel.json'), 'utf8'))
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
  const seed = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'kin-seed.json'), 'utf8'))
  record('saved explicit opt-in retained', vm.seed_policy?.telemetry_disabled === false && out.enabled === true)
  record('native routing configured without identity payload', !!kernel.telemetry && !kernel.telemetry.identity)
  record('native seed retains explicit consent', seed.seed_policy?.telemetry_disabled === false)
  record('fixture write is not publication or activation', out.wrote && !out.published && !out.applied)
  record('native telemetry keeps nonessential unset', settings.env?.[NONESSENTIAL_TRAFFIC_ENV_KEY] === undefined)
  record('controller fingerprint not overwritten', vm.fingerprint?.device_id === 'slot-preset')
  record(
    'native identity preserved',
    JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).userID === USER &&
    fs.existsSync(path.join(home, '.claude', '.claude.json')),
  )
  record(
    'credentials preserved',
    fs.readFileSync(path.join(home, '.claude', 'credentials.json'), 'utf8') === credential,
  )
  record(
    'backlog preserved',
    fs.readFileSync(path.join(home, '.claude', 'telemetry', 'queue.json'), 'utf8') === backlog,
  )
  record('no fabricated activity touch', !fs.existsSync(path.join(runDir, 'telemetry.touch')))
  record('no Go telemetry config created', !fs.existsSync(path.join(runDir, 'worker.json')))
  fs.rmSync(root, { recursive: true, force: true })
}

async function fixtureNoIdentity() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-verify-noid-'))
  const vmId = 'vm-97'
  const runDir = path.join(root, 'vms', vmId, 'run')
  fs.mkdirSync(path.join(root, 'vms', vmId, 'cli-home', '.claude'), { recursive: true })
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${vmId}.json`),
    JSON.stringify({
      id: vmId,
      seed_policy: { telemetry_disabled: true },
      fingerprint: { device_id: 'slot-only' },
    }),
  )
  const out = await finalizeOfficialCcTelemetry(root, vmId, { publish: false })
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${vmId}.json`), 'utf8'))
  const seed = JSON.parse(fs.readFileSync(path.join(root, 'vms', vmId, 'cli-home', '.claude', 'kin-seed.json'), 'utf8'))
  record('initialization preserves saved opt-out', saved.seed_policy.telemetry_disabled === true && !out.enabled)
  record('native seed remains disabled', seed.seed_policy.telemetry_disabled === true)
  record('missing identity never invents one', out.official === false)
  record('local write never claims applied', out.ok && !out.published && !out.applied)
  fs.rmSync(root, { recursive: true, force: true })
}

function liveFiles() {
  const routingFile = path.join(projectRoot, 'src/config/routing.json')
  const routing = JSON.parse(fs.readFileSync(routingFile, 'utf8'))
  const occ = normalizeOfficialCcConfig(routing.official_cc)
  record('routing.json telemetry publication is default off', occ.sync_telemetry === false)
  return occ.sync_telemetry === false
}

// Only called in live mode; the caller decides (`--live` or VERIFY_LIVE=1).
async function liveMasterRead() {
  const envText = await (await import('node:child_process')).execFileSync(
    'systemctl',
    ['show', 'kin-gateway', '-p', 'Environment', '--value'],
    {
      encoding: 'utf8',
    },
  )
  const master = masterKeyFrom(envText)
  if (!master) {
    record('master key present for routing GET', false, 'KIN_API_KEY missing')
    return
  }
  const res = await fetch(`${verifyBase()}/api/panel/routing`, {
    headers: { Authorization: `Bearer ${master}` },
  })
  const body = await res.json().catch(() => ({}))
  const occ = body?.data?.official_cc || body?.official_cc || {}
  record(
    'live GET /api/panel/routing keeps telemetry publication default off',
    res.status === 200 && occ.sync_telemetry === false,
    `http ${res.status}`,
  )
}

const live = process.argv.includes('--live') || process.env.VERIFY_LIVE === '1'
const previousRunRoot = process.env.KIN_SLOT_RUN_ROOT
try {
  delete process.env.KIN_SLOT_RUN_ROOT
  await fixtureFinalize()
  await fixtureNoIdentity()
} finally {
  if (previousRunRoot === undefined) delete process.env.KIN_SLOT_RUN_ROOT
  else process.env.KIN_SLOT_RUN_ROOT = previousRunRoot
}
liveFiles()
if (live) {
  await liveHttp()
  await liveMasterRead()
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
