import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { buildVmDetail, buildVmList } from '../../src/lib/admin/panel-api.mjs'
import { runVmTestChat } from '../../src/lib/admin/vm-test-chat.mjs'
import { SchedulerPoolsRepo } from '../../src/lib/db/repos/scheduler-pools-repo.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { SchedulerRuntime } from '../../src/lib/scheduler/scheduler-runtime.mjs'

const PERMANENT_MS = 8e15

function tmpDir(prefix = 'kin-node-cooldown-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function fakeQuota() {
  return {
    config: { safety_ratio: 0.95 },
    snapshot: () => ({ accounts: [], safety_ratio: 0.95 }),
  }
}

function writeVm(project, rec) {
  const dir = path.join(project, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2))
}

function makeRuntime(t) {
  const dir = tmpDir()
  const apiKeyStore = new ApiKeyStore({ dataDir: dir })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const repo = new SchedulerPoolsRepo(apiKeyStore.db)
  const runtime = new SchedulerRuntime({
    cfg: { paths: { project: dir, data: dir } },
    apiKeyStore,
    getDb: () => apiKeyStore.db,
    telemetryIntervalMs: 0,
  })
  return { runtime, repo }
}

function penalty(repo, over = {}) {
  repo.upsertNodePenalty({
    node_type: 'claude_vm',
    node_id: 'vm-06',
    model_scope: '*',
    reason: 'content_filter_refusal',
    cooldown_until_ms: Date.now() + 225_000,
    ladder_step: 1,
    ...over,
  })
}

test('activeNodePenalties returns timed node-level cooldowns of Claude slots only', (t) => {
  const { runtime, repo } = makeRuntime(t)
  const now = Date.now()
  penalty(repo)
  penalty(repo, { node_id: 'vm-model', model_scope: 'claude-opus-5' })
  penalty(repo, { node_id: 'vm-forever', cooldown_until_ms: PERMANENT_MS })
  penalty(repo, { node_id: 'vm-expired', cooldown_until_ms: now - 1000 })
  penalty(repo, { node_type: 'gemini_env', node_id: 'gem-1' })

  const found = runtime.activeNodePenalties(now)
  assert.deepEqual([...found.keys()], ['vm-06'])
  assert.equal(found.get('vm-06').reason, 'content_filter_refusal')
  assert.ok(found.get('vm-06').until > now)
})

test('activeNodePenalties is empty without a database', () => {
  const runtime = new SchedulerRuntime({ cfg: {}, getDb: () => null, telemetryIntervalMs: 0 })
  assert.equal(runtime.activeNodePenalties().size, 0)
})

test('PoolScheduler.nodePenalties delegates to the runtime and tolerates its absence', () => {
  const until = Date.now() + 60_000
  const ps = Object.create(PoolScheduler.prototype)
  ps.schedulerRuntime = { activeNodePenalties: () => new Map([['vm-06', { until, reason: 'x' }]]) }
  assert.equal(ps.nodePenalties().get('vm-06').until, until)
  ps.schedulerRuntime = null
  assert.equal(ps.nodePenalties().size, 0)
})

test('vm list and detail show a Rust node_cooldown as cooling, not available', async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, 'data'), { recursive: true })
  writeVm(project, {
    id: 'vm-06',
    status: 'running',
    schedulable: true,
    claude: { has_access: true, has_refresh: true },
  })
  writeVm(project, {
    id: 'vm-07',
    status: 'running',
    schedulable: true,
    claude: { has_access: true, has_refresh: true },
  })
  const cfg = { paths: { project }, rewrite: { enabled: false }, base_url: 'http://127.0.0.1' }
  const until = Date.now() + 225_000
  const poolScheduler = {
    snapshot: () => ({}),
    nodePenalties: () => new Map([['vm-06', { until, reason: 'content_filter_refusal', ladder_step: 1 }]]),
  }

  const listed = await buildVmList({ cfg, accountQuota: fakeQuota(), routingConfig: {}, poolScheduler })
  const cooling = listed.data.items.find((item) => item.id === 'vm-06')
  const healthy = listed.data.items.find((item) => item.id === 'vm-07')

  assert.equal(cooling.cooldown_until, until)
  assert.match(cooling.cooldown_reason, /^node_cooldown:content_filter_refusal$/)
  assert.equal(cooling.node_cooldown.reason, 'content_filter_refusal')
  assert.ok(cooling.node_cooldown.left_ms > 0 && cooling.node_cooldown.left_ms <= 225_000)
  assert.equal(cooling.availability.key, 'cool')
  assert.equal(cooling.availability.accept, false)

  assert.equal(healthy.node_cooldown, null)
  assert.notEqual(healthy.availability.key, 'cool')

  const detail = await buildVmDetail({ cfg, accountQuota: fakeQuota(), id: 'vm-06', poolScheduler })
  assert.equal(detail.data.vm.node_cooldown.reason, 'content_filter_refusal')
  assert.equal(detail.data.vm.availability.key, 'cool')
})

test('vm list without a scheduler penalty source is unchanged', async () => {
  const project = tmpDir()
  fs.mkdirSync(path.join(project, 'data'), { recursive: true })
  writeVm(project, {
    id: 'vm-08',
    status: 'running',
    schedulable: true,
    claude: { has_access: true, has_refresh: true },
  })
  const cfg = { paths: { project }, rewrite: { enabled: false }, base_url: 'http://127.0.0.1' }
  const listed = await buildVmList({ cfg, accountQuota: fakeQuota(), routingConfig: {} })
  const vm = listed.data.items.find((item) => item.id === 'vm-08')
  assert.equal(vm.node_cooldown, null)
  assert.equal(vm.cooldown_until, null)
})

async function startBusyServer(t) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
      // drain
    }
    calls.push({ url: req.url, vm: req.headers['x-kin-vm'] })
    res.writeHead(529, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'overloaded_error',
          code: 'upstream_overloaded',
          message: 'pinned node claude_vm:vm-06 is busy',
        },
      }),
    )
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, calls }
}

function seedChatVm(project) {
  writeVm(project, {
    id: 'vm-06',
    name: 'vm-06',
    status: 'running',
    schedulable: true,
    proxy_cli_enabled: true,
    proxy: { id: 'proxy-vm-06', url: 'socks5h://127.0.0.1:1080', host: '127.0.0.1', port: 1080 },
    claude: {
      access_token: 'sk-ant-oat01-test',
      refresh_token: 'sk-ant-ort01-test',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      account_uuid: 'acct-test',
    },
  })
  fs.mkdirSync(path.join(project, 'src/config'), { recursive: true })
  fs.writeFileSync(path.join(project, 'src/config/routing.json'), JSON.stringify({}))
}

test('test-chat reports node_cooldown instead of a generic pinned-node-busy overload', async (t) => {
  const project = tmpDir()
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  seedChatVm(project)
  const { baseUrl, calls } = await startBusyServer(t)

  const run = (nodePenalty) =>
    runVmTestChat({
      projectRoot: project,
      vmId: 'vm-06',
      model: 'claude-haiku-4-5',
      prompt: 'hi',
      max_tokens: 16,
      baseUrl,
      apiKey: 'k',
      nodePenalty,
    })

  const cooled = await run({ until: Date.now() + 125_000, reason: 'content_filter_refusal' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].vm, 'vm-06')
  assert.equal(cooled.ok, false)
  assert.equal(cooled.error.code, 'node_cooldown')
  assert.match(cooled.error.message, /node_cooldown/)
  assert.match(cooled.error.message, /content_filter_refusal/)
  assert.match(cooled.error.message, /2 分/)
  assert.match(cooled.error.upstream_message, /pinned node claude_vm:vm-06 is busy/)

  // Without a known cooldown the scheduler's own message is left untouched.
  const plain = await run(null)
  assert.equal(plain.ok, false)
  assert.notEqual(plain.error.code, 'node_cooldown')
  assert.match(plain.error.message, /pinned node claude_vm:vm-06 is busy/)
})
