import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PLAN_SYNC_SCRIPT,
  SLOT_CREDENTIALS,
  authoritativePlan,
  planToSync,
  queueSlotPlanSync,
  syncSlotSubscriptionType,
} from '../../src/lib/oauth/slot-plan-sync.mjs'

const python = spawnSync('python3', ['-c', 'import fcntl'], { stdio: 'ignore' }).status === 0

function credentialFile(t, oauth = {}, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-plan-sync-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'credentials.json')
  const doc = {
    type: 'setup_token',
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-fixture',
      refreshToken: 'rt-fixture',
      expiresAt: 1893456000000,
      subscriptionType: 'pro',
      rateLimitTier: 'default_claude_max_5x',
      kinGeneration: 5,
      ...oauth,
    },
    kinGeneration: 5,
    ...extra,
  }
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))
  fs.chmodSync(file, 0o600)
  return { dir, file }
}

const runScript = (file, plan) =>
  JSON.parse(execFileSync('python3', ['-I', '-c', PLAN_SYNC_SCRIPT, file, plan], { encoding: 'utf8' }).trim())

test('the slot edit changes only the plan and advances the generation like a worker save', { skip: !python }, (t) => {
  const { dir, file } = credentialFile(t)
  const before = Date.now()
  const result = runScript(file, 'max')
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(result.previous, 'pro')
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(doc.claudeAiOauth.subscriptionType, 'max')
  assert.equal(doc.claudeAiOauth.accessToken, 'sk-ant-oat01-fixture')
  assert.equal(doc.claudeAiOauth.refreshToken, 'rt-fixture')
  assert.equal(doc.claudeAiOauth.rateLimitTier, 'default_claude_max_5x')
  assert.ok(doc.claudeAiOauth.kinGeneration >= before)
  assert.equal(doc.kinGeneration, doc.claudeAiOauth.kinGeneration)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['credentials.json', 'credentials.json.lock'])

  const bytes = fs.readFileSync(file)
  assert.deepEqual(runScript(file, 'max'), { ok: true, changed: false, subscription_type: 'max' })
  assert.ok(fs.readFileSync(file).equals(bytes), 'an agreeing plan is not rewritten')
})

test('the slot edit waits for the worker credential lock', { skip: !python }, async (t) => {
  const { file } = credentialFile(t)
  const holder = spawn('python3', [
    '-c',
    'import fcntl,os,sys,time\nfd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT,0o600)\nfcntl.flock(fd,fcntl.LOCK_EX)\nprint("held",flush=True)\ntime.sleep(1.2)\n',
    `${file}.lock`,
  ])
  t.after(() => holder.kill('SIGKILL'))
  await new Promise((resolve) => holder.stdout.once('data', resolve))
  const started = Date.now()
  const result = await new Promise((resolve) => {
    const child = spawn('python3', ['-I', '-c', PLAN_SYNC_SCRIPT, file, 'max'])
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.on('close', () => resolve(JSON.parse(out.trim())))
  })
  assert.ok(Date.now() - started >= 800, 'the edit ran while another process held the lock')
  assert.equal(result.changed, true)
})

test('an API-key credential is left alone', { skip: !python }, (t) => {
  const { file } = credentialFile(t, {}, {})
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete doc.claudeAiOauth
  doc.anthropicApiKey = { apiKey: 'sk-ant-api-fixture' }
  fs.writeFileSync(file, JSON.stringify(doc))
  const bytes = fs.readFileSync(file)
  assert.deepEqual(runScript(file, 'max'), { ok: false, reason: 'no_oauth' })
  assert.ok(fs.readFileSync(file).equals(bytes))
})

test('the edit runs inside the slot as the worker user and reports its JSON line', { skip: !python }, async (t) => {
  const { file } = credentialFile(t)
  const vm = { id: 'vm-21', node_id: 'node-t', runtime: { type: 'kvm', container: 'kin-vm-21' } }
  const host = { dockerEnv: () => ({ DOCKER_HOST: 'unix:///fixture.sock' }), execUser: () => '10001:987' }
  let seen
  const result = await syncSlotSubscriptionType(vm, host, 'max', {
    runDocker: async (argv, { env }) => {
      seen = { argv, env }
      const command = argv.slice(argv.indexOf('--') + 1).map((part) => (part === SLOT_CREDENTIALS ? file : part))
      const out = execFileSync(command[0], command.slice(1), { encoding: 'utf8' })
      return { code: 0, stdout: out, stderr: '' }
    },
  })
  assert.equal(result.changed, true)
  assert.equal(seen.env.DOCKER_HOST, 'unix:///fixture.sock')
  assert.deepEqual(seen.argv.slice(0, 2), ['exec', 'kin-vm-21'])
  assert.deepEqual(seen.argv.slice(seen.argv.indexOf('-u'), seen.argv.indexOf('-u') + 2), ['-u', '10001:987'])
  assert.deepEqual(seen.argv.slice(-6), ['python3', '-I', '-c', PLAN_SYNC_SCRIPT, SLOT_CREDENTIALS, 'max'])
  assert.deepEqual(await syncSlotSubscriptionType(vm, { ...host, native: true }, 'max'), {
    ok: false,
    reason: 'unsupported_host',
  })
  assert.deepEqual(await syncSlotSubscriptionType(vm, host, 'team'), { ok: false, reason: 'invalid_plan' })
  const failed = await syncSlotSubscriptionType(vm, host, 'max', {
    runDocker: async () => ({ code: 126, stdout: '', stderr: 'python3: not found' }),
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'exec_failed')
})

function slotDirWithMirror(t, subscriptionType) {
  const slotDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kin-plan-slot-')), 'vm-21')
  t.after(() => fs.rmSync(path.dirname(slotDir), { recursive: true, force: true }))
  fs.mkdirSync(path.join(slotDir, 'cli-home', '.claude'), { recursive: true })
  fs.writeFileSync(
    path.join(slotDir, 'cli-home', '.claude', 'credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'a', subscriptionType } }),
  )
  return slotDir
}

test('only a profile-verified plan that differs from the slot copy is synced', (t) => {
  const profileMax = { claude: { account_tier: 'max', account_tier_source: 'profile' } }
  assert.equal(authoritativePlan(profileMax), 'max')
  assert.equal(authoritativePlan({ claude: { account_tier: 'max', account_tier_source: 'usage' } }), null)
  assert.equal(authoritativePlan({ account_tier: 'pro', account_tier_source: 'profile' }), 'pro')
  assert.equal(planToSync(profileMax, slotDirWithMirror(t, 'pro')), 'max')
  assert.equal(planToSync(profileMax, slotDirWithMirror(t, 'max')), null)
  assert.equal(planToSync(profileMax, path.join(os.tmpdir(), 'kin-plan-missing')), null)
})

test('a queued sync runs once per slot and corrects the local copy after the slot', async (t) => {
  const slotDir = slotDirWithMirror(t, 'pro')
  const vm = { id: 'vm-21', claude: { account_tier: 'max', account_tier_source: 'profile' } }
  const logs = []
  let calls = 0
  const logger = { warn: (line) => logs.push(JSON.parse(line)) }
  const sync = async () => {
    calls++
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { ok: true, changed: true, previous: 'pro', subscription_type: 'max' }
  }
  const first = queueSlotPlanSync(vm, slotDir, { execUser: () => '' }, { logger, sync })
  const second = queueSlotPlanSync(vm, slotDir, { execUser: () => '' }, { logger, sync })
  assert.equal(first, second)
  await first
  assert.equal(calls, 1)
  const local = JSON.parse(fs.readFileSync(path.join(slotDir, 'cli-home', '.claude', 'credentials.json'), 'utf8'))
  assert.equal(local.claudeAiOauth.subscriptionType, 'max')
  assert.deepEqual(logs, [
    { event: 'slot_plan_sync', vm_id: 'vm-21', plan: 'max', ok: true, changed: true, previous: 'pro', reason: null },
  ])
  assert.equal(queueSlotPlanSync(vm, slotDir, { execUser: () => '' }, { logger, sync }), null, 'already agrees')
  assert.equal(queueSlotPlanSync(vm, slotDirWithMirror(t, 'pro'), { native: true }, { logger, sync }), null)

  const failedDir = slotDirWithMirror(t, 'pro')
  await queueSlotPlanSync(
    vm,
    failedDir,
    { execUser: () => '' },
    { logger, sync: async () => ({ ok: false, reason: 'locked' }) },
  )
  const kept = JSON.parse(fs.readFileSync(path.join(failedDir, 'cli-home', '.claude', 'credentials.json'), 'utf8'))
  assert.equal(kept.claudeAiOauth.subscriptionType, 'pro', 'a failed slot edit leaves the mirror for the next pull')
})
