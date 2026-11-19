import '../fixtures/kin-computer-test-env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'
import { buildVmDetail, buildVmList } from '../../src/lib/admin/panel-api.mjs'
import { antigravityPoolRuntime } from '../../src/lib/pool/antigravity-slot-pool.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

const routing = { antigravity: { enabled: true, models: ['gemini-example-low', 'gemini-example-medium'] } }
const vm = {
  id: 'vm-ag',
  platform: 'antigravity',
  family: 'antigravity',
  owner_user_id: 'u-1',
  runtime: { type: 'docker' },
}
const tenant = { panelUserId: 'u-1', panelUser: 'alice', panelRole: 'user' }
const admin = { apiKeyKind: 'master', panelRole: 'admin' }

function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ag-panel-'))
  fs.mkdirSync(path.join(project, 'vms'))
  fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  return project
}

function harness(project, who, body, extra = {}) {
  const response = new EventEmitter()
  const handler = createPanelHandler({
    cfg: { paths: { project } },
    routingConfig: routing,
    ...extra,
    requireAuth(req) {
      Object.assign(req, who)
      return true
    },
    readBody: async () => body,
    json(_res, status, payload) {
      Object.assign(response, { status, body: payload })
      return true
    },
  })
  return {
    response,
    async call(method, suffix) {
      const req = Object.assign(new EventEmitter(), { method, headers: {} })
      await handler(req, response, new URL(`http://localhost/api/panel/${suffix}`))
      return response
    },
  }
}

test('routing GET exposes Antigravity defaults and only normalized public configuration', async (t) => {
  const project = fixture(t)
  const defaults = {
    enabled: false,
    cli_bin: 'agy',
    models: [],
    max_sessions: 1,
    idle_ttl_seconds: 600,
    timeout_ms: 180000,
    queue_timeout_ms: 120000,
    affinity_wait_ms: 15000,
  }
  const h = harness(
    project,
    admin,
    {},
    {
      routingConfig: {},
      stickyRouter: { stats: () => ({}) },
    },
  )
  await h.call('GET', 'routing')
  assert.equal(h.response.status, 200)
  assert.deepEqual(h.response.body.data.antigravity, defaults)

  const configured = harness(
    project,
    admin,
    {},
    {
      routingConfig: {
        antigravity: {
          enabled: true,
          models: ['gemini-example-low', 'gemini-example-high'],
          token: 'private-cli-token',
          keyring: { password: 'private-keyring-password' },
        },
      },
      stickyRouter: { stats: () => ({}) },
    },
  )
  await configured.call('GET', 'routing')
  assert.equal(configured.response.status, 200)
  assert.deepEqual(configured.response.body.data.antigravity, {
    ...defaults,
    enabled: true,
    models: [
      { id: 'gemini-example', display_name: 'gemini-example', vendor: null, enabled: true, levels: ['low', 'high'] },
    ],
  })
  assert.doesNotMatch(JSON.stringify(configured.response.body), /private-cli-token|private-keyring-password/)
})

test('routing PUT persists Antigravity settings and GET returns them for the settings panel', async (t) => {
  const project = fixture(t)
  const routingConfigPath = path.join(project, 'routing.json')
  const routingConfig = {}
  const stickyRouter = { stats: () => ({}), reloadConfig() {} }
  const runtime = createRoutingRuntime({
    cfg: { paths: { project } },
    routingConfigPath,
    routingConfig,
    stickyRouter,
    accountQuota: { reloadConfig() {}, applyTierConcurrency() {}, applyTierRpm() {} },
  })
  const expected = {
    enabled: true,
    cli_bin: '/home/kincli/.local/bin/agy',
    models: [
      {
        id: 'gemini-example',
        display_name: 'Gemini example',
        vendor: 'google',
        enabled: true,
        levels: ['low', 'medium'],
      },
    ],
    max_sessions: 3,
    idle_ttl_seconds: 900,
    timeout_ms: 240000,
    queue_timeout_ms: 90000,
    affinity_wait_ms: 0,
  }
  const h = harness(
    project,
    admin,
    { antigravity: { ...expected, token: 'private-cli-token' } },
    {
      cfg: { paths: { project }, limits: { max_body_bytes: 4096 } },
      routingConfig,
      stickyRouter,
      persistRoutingPatch: runtime.persistRoutingPatch,
    },
  )
  await h.call('PUT', 'routing')
  assert.equal(h.response.status, 200, JSON.stringify(h.response.body))
  assert.deepEqual(h.response.body.data.antigravity, expected)
  assert.deepEqual(JSON.parse(fs.readFileSync(routingConfigPath, 'utf8')).antigravity, expected)

  await h.call('GET', 'routing')
  assert.equal(h.response.status, 200)
  assert.deepEqual(h.response.body.data.antigravity, expected)
  assert.doesNotMatch(JSON.stringify(h.response.body), /private-cli-token/)
})

test('a pinned panel test on an Antigravity slot routes same-name Claude IDs to Antigravity', async (t) => {
  const project = fixture(t)
  const res = Object.assign(new EventEmitter(), { headersSent: false })
  const body = { model: 'claude-example', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
  let pickedFrom = null
  const handler = createHandleProtocol({
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      limits: { max_body_bytes: 1024 },
      paths: { project },
    },
    requireAuth: () => true,
    readBody: async () => body,
    json(_res, status, payload) {
      Object.assign(res, { status, body: payload })
    },
    requestLog: { start: () => ({ request_id: 'ag-pinned' }), finish() {} },
    stats: { errors: 0 },
    groupsRepo: { rateMultiplier: () => 1 },
    getRoutingConfig: () => ({ antigravity: { enabled: true, models: ['claude-example'] } }),
    antigravityOps: {
      listVms: (root) => {
        pickedFrom = root
        return []
      },
    },
    getFailoverRunner() {
      throw new Error('must not schedule Claude')
    },
  })
  await handler.handleProtocol(
    Object.assign(new EventEmitter(), { headers: { 'x-kin-vm': vm.id }, apiKeyKind: 'master' }),
    res,
    'anthropic.messages',
    '/v1/messages',
  )
  assert.equal(pickedFrom, project, JSON.stringify(res.body))
})

test('Antigravity OAuth routes bind the caller and return public session fields only', async (t) => {
  const project = fixture(t)
  const session = {
    session_id: 'auth-session-1',
    status: 'awaiting_code',
    auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=test',
    expires_at: Date.now() + 60000,
    authenticated: false,
  }
  const cases = [
    ['POST', 'start', {}, 'startAntigravityAuthLogin'],
    ['GET', 'session?session_id=auth-session-1', {}, 'readAntigravityAuthLogin'],
    ['POST', 'complete', { session_id: session.session_id, code: 'manual-code' }, 'completeAntigravityAuthLogin'],
    ['POST', 'cancel', { session_id: session.session_id }, 'cancelAntigravityAuthLogin'],
  ]
  for (const [method, suffix, body, override] of cases) {
    let calls = 0
    const h = harness(project, tenant, body, {
      routingConfig: { antigravity: { enabled: false } },
      [override]: async (input) => {
        calls++
        assert.equal(input.actor, 'id:u-1')
        assert.equal(input.vm.id, vm.id)
        assert.equal(input.projectRoot, project)
        if (override === 'startAntigravityAuthLogin') assert.equal(input.routing.antigravity.enabled, false)
        else assert.equal(input.sessionId, session.session_id)
        if (override === 'completeAntigravityAuthLogin') assert.equal(input.code, 'manual-code')
        return {
          ok: true,
          session: {
            ...session,
            access_token: 'provider-secret',
            refresh_token: 'provider-refresh',
            transcript: 'private-output',
          },
        }
      },
    })
    await h.call(method, `vms/vm-ag/antigravity/oauth/${suffix}`)
    assert.equal(h.response.status, 200, JSON.stringify(h.response.body))
    assert.equal(calls, 1)
    assert.deepEqual(h.response.body.data, session)
    assert.doesNotMatch(JSON.stringify(h.response.body), /provider-secret|provider-refresh|private-output/)
  }
  assert.equal(fs.readFileSync(path.join(project, 'vms', `${vm.id}.json`), 'utf8'), JSON.stringify(vm))
})

test('a completed Antigravity login syncs the slot catalog without a manual click', async (t) => {
  const project = fixture(t)
  const synced = []
  const done = { ok: true, session: { session_id: 's-1', status: 'authenticated', authenticated: true } }
  const pending = { ok: true, session: { session_id: 's-1', status: 'awaiting_code', authenticated: false } }
  for (const result of [pending, done]) {
    const h = harness(
      project,
      tenant,
      { session_id: 's-1', code: 'manual-code' },
      {
        completeAntigravityAuthLogin: async () => result,
        syncAntigravityModels: async ({ vm: target }) => {
          synced.push(target.id)
          return { ok: true, models: [] }
        },
      },
    )
    await h.call('POST', 'vms/vm-ag/antigravity/oauth/complete')
    assert.equal(h.response.status, 200, JSON.stringify(h.response.body))
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(synced, ['vm-ag'])
})

test('foreign tenants and read-only operators cannot access any OAuth session endpoint', async (t) => {
  const project = fixture(t)
  for (const who of [
    { ...tenant, panelUserId: 'u-2' },
    { panelUser: 'operator', panelRole: 'super' },
  ]) {
    for (const [method, operation] of [
      ['POST', 'start'],
      ['GET', 'session'],
      ['POST', 'complete'],
      ['POST', 'cancel'],
    ]) {
      const reject = () => assert.fail('unauthorized caller reached authentication manager')
      const h = harness(
        project,
        who,
        { session_id: 'session-1', code: 'manual-code' },
        {
          startAntigravityAuthLogin: reject,
          readAntigravityAuthLogin: reject,
          completeAntigravityAuthLogin: reject,
          cancelAntigravityAuthLogin: reject,
        },
      )
      await h.call(method, `vms/vm-ag/antigravity/oauth/${operation}`)
      assert.equal(h.response.status, who.panelRole === 'super' ? 403 : 404)
    }
  }
})

test('OAuth rejects wrong platform and invalid callback fields before manager execution', async (t) => {
  const project = fixture(t)
  const reject = () => assert.fail('invalid input reached authentication manager')
  for (const [operation, body] of [
    ['start', { token: 'injected-token' }],
    ['complete', { session_id: '../other', code: 'manual-code' }],
    ['complete', { session_id: 'session-1', code: '' }],
    ['complete', { session_id: 'session-1', code: 123 }],
    ['complete', { session_id: 'session-1', code: 'manual-code', proxy: 'other-exit' }],
    ['cancel', {}],
  ]) {
    const h = harness(project, tenant, body, {
      startAntigravityAuthLogin: reject,
      completeAntigravityAuthLogin: reject,
      cancelAntigravityAuthLogin: reject,
    })
    await h.call('POST', `vms/vm-ag/antigravity/oauth/${operation}`)
    assert.equal(h.response.status, 400)
  }
  fs.writeFileSync(
    path.join(project, 'vms', 'vm-gpt.json'),
    JSON.stringify({ id: 'vm-gpt', platform: 'openai', owner_user_id: 'u-1' }),
  )
  const other = harness(project, tenant, {}, { startAntigravityAuthLogin: reject })
  await other.call('POST', 'vms/vm-gpt/antigravity/oauth/start')
  assert.equal(other.response.body.error.code, 'platform_mismatch')
})

test('OAuth manager failures preserve status and owner reassignment stops pending login', async (t) => {
  const project = fixture(t)
  const h = harness(
    project,
    tenant,
    {},
    {
      readAntigravityAuthLogin: async () => ({
        ok: false,
        status: 404,
        code: 'antigravity_auth_session_not_found',
        error: '授权会话不存在或已结束',
      }),
    },
  )
  await h.call('GET', 'vms/vm-ag/antigravity/oauth/session?session_id=missing')
  assert.equal(h.response.status, 404)
  assert.equal(h.response.body.error.code, 'antigravity_auth_session_not_found')
  let stopped
  const owner = harness(
    project,
    admin,
    { user_id: 'u-2' },
    {
      panelUsers: { getById: () => ({ id: 'u-2' }) },
      stopAntigravityAuthLogin: async (id) => {
        stopped = id
      },
    },
  )
  await owner.call('PATCH', 'vms/vm-ag/owner')
  assert.equal(owner.response.status, 200, JSON.stringify(owner.response.body))
  assert.equal(stopped, vm.id)
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, 'vms', `${vm.id}.json`), 'utf8')).owner_user_id, 'u-2')
})

test('confirmed auth metadata is visible while text remains disabled', async (t) => {
  const project = fixture(t)
  const runDir = path.join(project, 'vms', vm.id, 'run')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(
    path.join(runDir, 'antigravity-auth.json'),
    JSON.stringify({ authenticated: true, updated_at: Date.now() }),
  )
  const h = harness(
    project,
    tenant,
    {},
    {
      routingConfig: {},
      antigravityBridgeStatus: async () => ({ ok: false, code: 'antigravity_disabled', authenticated: null }),
    },
  )
  await h.call('GET', 'vms/vm-ag/antigravity/status')
  assert.equal(h.response.body.data.authenticated, true)
  assert.equal(h.response.body.data.enabled, false)
  assert.equal(h.response.body.data.ready, false)
  const record = { ...vm, schedulable: false, proxy: { id: 'px-test', host: '127.0.0.1', port: 1080 } }
  fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(record))
  const result = await buildVmDetail({ cfg: { paths: { project } }, id: vm.id, routingConfig: {} })
  assert.equal(result.data.vm.can_import_credential, true)
  assert.equal(result.data.vm.antigravity.authenticated, true)
  assert.equal(result.data.vm.has_token, false)
  assert.equal(result.data.vm.schedulable, false)
})

test('Antigravity panel list and detail preserve actual scheduling and independent model/concurrency policy', async (t) => {
  const project = fixture(t)
  const cfg = { paths: { project } }
  const routingConfig = { antigravity: { enabled: true, max_sessions: 2, models: ['gemini-example'] } }
  const record = {
    ...vm,
    status: 'running',
    schedulable: true,
    schedule_disabled_reason: 'antigravity_experimental_text_only',
    policy: {
      maxConcurrency: 3,
      concurrencyOverride: true,
      maxRpm: 12,
      rpmOverride: true,
      allowed_models: ['gemini-example'],
      weight: 7,
    },
  }
  const vmPath = path.join(project, 'vms', vm.id + '.json')
  fs.writeFileSync(vmPath, JSON.stringify(record))
  const runDir = path.join(project, 'vms', vm.id, 'run')
  fs.mkdirSync(runDir, { recursive: true })
  const authPath = path.join(runDir, 'antigravity-auth.json')
  fs.writeFileSync(authPath, JSON.stringify({ authenticated: true, updated_at: Date.now() }))
  antigravityPoolRuntime.reset()
  t.after(() => antigravityPoolRuntime.reset())
  const lease = antigravityPoolRuntime.acquire(vm.id, { concurrency: 2 })
  t.after(() => lease.release())
  const listed = await buildVmList({ cfg, routingConfig })
  const detail = await buildVmDetail({ cfg, id: vm.id, routingConfig })
  for (const view of [listed.data.items[0], detail.data.vm]) {
    assert.equal(view.schedulable, true)
    assert.equal(view.schedule_disabled_reason, null)
    assert.equal(view.antigravity.authenticated, true)
    assert.equal(view.max_concurrency, 2)
    assert.equal(view.max_sessions, 2)
    assert.equal(view.max_rpm, 12)
    assert.equal(view.concurrency_override, true)
    assert.equal(view.rpm_override, true)
    assert.equal(view.inflight, 1)
    assert.equal(view.rpm, 1)
    assert.equal(view.scheduling_inherited.max_concurrency, 2)
    assert.deepEqual(view.allowed_models, ['gemini-example'])
    assert.equal(view.weight, 7)
    assert.equal(view.has_token, false)
    assert.equal(view.quota_policy, null)
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(vmPath, 'utf8')), record)
  fs.writeFileSync(vmPath, JSON.stringify({ ...record, schedulable: false, schedule_disabled_reason: 'manual' }))
  const disabled = (await buildVmList({ cfg, routingConfig })).data.items[0]
  assert.equal(disabled.schedulable, false)
  assert.equal(disabled.schedule_disabled_reason, 'manual')
  fs.writeFileSync(authPath, JSON.stringify({ authenticated: false, updated_at: Date.now() }))
  const loggedOut = (await buildVmList({ cfg, routingConfig })).data.items[0]
  assert.equal(loggedOut.schedulable, false)
  assert.equal(loggedOut.schedule_disabled_reason, 'antigravity_official_login_required')
})

test('status remains read-only and VM detail never calls Claude health or process probes', async (t) => {
  const project = fixture(t)
  const h = harness(
    project,
    tenant,
    {},
    {
      antigravityBridgeStatus: async () => ({
        ready: false,
        authenticated: null,
        code: 'antigravity_bridge_unavailable',
      }),
    },
  )
  await h.call('GET', 'vms/vm-ag/antigravity/status')
  assert.equal(h.response.status, 200)
  assert.equal(h.response.body.data.authenticated, null)
  const result = await buildVmDetail({
    cfg: { paths: { project } },
    id: 'vm-ag',
    routingConfig: routing,
    kernelHealth() {
      throw new Error('must not inspect Claude kernel')
    },
    slotProcessStatus() {
      throw new Error('must not inspect Claude process')
    },
  })
  assert.equal(result.data.vm.id, 'vm-ag')
  assert.equal(result.data.vm.platform, 'antigravity')
  assert.equal(result.data.account, null)
  assert.equal(result.data.official_cc, null)
  assert.equal(result.data.kernel.credential_owner, 'antigravity')
})

test('AG creation defaults to stopped local Docker and never seeds Claude config', async (t) => {
  const project = fixture(t)
  const h = harness(project, admin, {
    platform: 'antigravity',
    status: 'running',
    auto_allocate_proxy: false,
    allowed_models: ['gemini-example'],
  })
  await h.call('POST', 'vms/create')
  assert.equal(h.response.status, 200, JSON.stringify(h.response.body))
  const saved = h.response.body.data.vm
  assert.equal(saved.platform, 'antigravity')
  assert.equal(saved.runtime_type, 'docker')
  assert.equal(saved.status, 'stopped')
  assert.equal(saved.schedulable, false)
  const stored = JSON.parse(fs.readFileSync(path.join(project, 'vms', `${saved.id}.json`), 'utf8'))
  assert.deepEqual(stored.policy.allowed_models, ['gemini-example'])
  assert.equal(fs.existsSync(path.join(project, 'vms', saved.id, 'cli-home', '.claude')), false)
})

test('AG rejects unrelated generic credential mutations', async (t) => {
  const project = fixture(t)
  for (const [method, suffix, body] of [
    ['POST', 'vms/import', { vm_id: vm.id, token: 'secret' }],
    ['POST', 'vms/vm-ag/oauth/refresh', {}],
    ['POST', 'vms/vm-ag/activate', {}],
    ['POST', 'vms/vm-ag/credential/clear', {}],
    ['PATCH', 'vms/vm-ag', { inference_engine: 'rust' }],
    ['PUT', 'model-policy', { platform: 'antigravity', policy: {} }],
  ]) {
    const h = harness(project, admin, body)
    await h.call(method, suffix)
    assert.equal(h.response.status, 400, `${suffix}: ${JSON.stringify(h.response.body)}`)
  }
})

test('AG slot concurrency follows max_sessions unless PATCH pins it within that ceiling', async (t) => {
  const project = fixture(t)
  const vmPath = path.join(project, 'vms', `${vm.id}.json`)
  // Records created by earlier releases carry maxConcurrency 1 without an override flag.
  fs.writeFileSync(vmPath, JSON.stringify({ ...vm, policy: { maxConcurrency: 1, maxRpm: 0, maxSessions: 1 } }))
  const routingConfig = { antigravity: { ...routing.antigravity, max_sessions: 4 } }
  const concurrencyOf = async () =>
    (await buildVmList({ cfg: { paths: { project } }, routingConfig })).data.items[0].max_concurrency
  assert.equal(await concurrencyOf(), 4)

  const pin = harness(project, admin, { max_concurrency: 2 }, { routingConfig })
  await pin.call('PATCH', 'vms/vm-ag')
  assert.equal(pin.response.status, 200, JSON.stringify(pin.response.body))
  assert.equal(pin.response.body.data.vm.max_concurrency, 2)
  assert.equal(pin.response.body.data.vm.concurrency_override, true)
  assert.equal(await concurrencyOf(), 2)

  for (const body of [{ max_concurrency: 5 }, { max_concurrency: 0 }, { max_concurrency: 1, max_rpm: 3 }]) {
    const rejected = harness(project, admin, body, { routingConfig })
    await rejected.call('PATCH', 'vms/vm-ag')
    assert.equal(rejected.response.status, 400, JSON.stringify(body))
  }
  assert.equal(await concurrencyOf(), 2)

  const follow = harness(project, admin, { max_concurrency: null }, { routingConfig })
  await follow.call('PATCH', 'vms/vm-ag')
  assert.equal(follow.response.status, 200, JSON.stringify(follow.response.body))
  assert.equal(await concurrencyOf(), 4)
  assert.equal(JSON.parse(fs.readFileSync(vmPath, 'utf8')).policy.concurrencyOverride, false)
})

test('generic AG requests use independent admission and never use the Claude scheduler', async () => {
  for (const enabled of [false, true]) {
    const res = Object.assign(new EventEmitter(), { headersSent: false })
    const body = { model: 'gemini-example', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
    const handler = createHandleProtocol({
      cfg: { rewrite: { enabled: false }, intercept: { rules: [] }, limits: { max_body_bytes: 1024 }, paths: {} },
      requireAuth: () => true,
      readBody: async () => body,
      json(_res, status, payload) {
        Object.assign(res, { status, body: payload })
      },
      requestLog: { start: () => ({ request_id: 'ag-unsupported' }), finish() {} },
      stats: { errors: 0 },
      groupsRepo: { rateMultiplier: () => 1 },
      getRoutingConfig: () => ({ antigravity: { enabled, models: ['gemini-example'] } }),
      antigravityOps: { listVms: () => [] },
      getHealthMonitor: () => ({
        decide() {
          throw new Error('must not use cached Claude health')
        },
      }),
      getFailoverRunner() {
        throw new Error('must not schedule Claude')
      },
    })
    await handler.handleProtocol(
      Object.assign(new EventEmitter(), { headers: {}, apiKeyKind: 'master' }),
      res,
      'anthropic.messages',
      '/v1/messages',
    )
    assert.equal(res.status, 503, JSON.stringify(res.body))
    assert.equal(res.body.error.code, enabled ? 'no_antigravity_vm' : 'antigravity_disabled')
  }
})
