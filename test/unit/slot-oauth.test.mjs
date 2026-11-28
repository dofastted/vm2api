import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'
import { buildPanelOauthConfig, resolvePanelOauthEgress, runSlotOauth } from '../../src/lib/transport/slot-oauth.mjs'

const localProxyVm = { id: 'vm-07', proxy: { id: 'px-local', kind: 'local' } }
const socksProxyVm = { id: 'vm-07', proxy: { id: 'px-1', url: 'socks5://user:pass@10.0.0.2:1080' } }

function makeSlotFixture(t, vm = localProxyVm) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-oauth-panel-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const slotDir = path.join(root, 'vms', vm.id)
  const homeDir = path.join(slotDir, 'cli-home')
  fs.mkdirSync(path.join(slotDir, 'run'), { recursive: true })
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
  return { root, slotDir, homeDir, exec: { vmId: vm.id, projectRoot: root, homeDir, vm } }
}

test('resolvePanelOauthEgress fails closed without a bound proxy and routes bound SOCKS5 / local egress', () => {
  assert.equal(resolvePanelOauthEgress({ id: 'vm-07' }).ok, false)
  assert.equal(resolvePanelOauthEgress({ id: 'vm-07' }).code, 'proxy_required')
  assert.equal(
    resolvePanelOauthEgress({ id: 'vm-07', proxy: { id: 'px-v6', url: 'socks5://[2001:db8::1]:1080' } }).code,
    'proxy_required',
  )
  assert.deepEqual(resolvePanelOauthEgress(socksProxyVm), {
    ok: true,
    egress_mode: 'socks',
    proxy_url: 'socks5h://user:pass@10.0.0.2:1080',
    proxy_required: true,
  })
  assert.deepEqual(resolvePanelOauthEgress(localProxyVm), {
    ok: true,
    egress_mode: 'transparent',
    proxy_url: '',
    proxy_required: false,
  })
})

test('runSlotOauth runs control-plane kin-worker with an ephemeral config and cleans it up', async (t) => {
  const { exec, homeDir } = makeSlotFixture(t, socksProxyVm)
  let seen = null
  let configContentDuringRun = null
  const result = await runSlotOauth(exec, 'usage', {
    workerBin: '/opt/vm2api/bin/kin-worker',
    runWorker: async (argv, options) => {
      seen = { argv, options }
      const cfgPath = argv[argv.indexOf('--config') + 1]
      configContentDuringRun = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      return { code: 0, stdout: '{"ok":true,"status":200,"body":{},"headers":{}}', stderr: '', timed_out: false }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.via, 'panel-worker')
  assert.equal(seen.options.bin, '/opt/vm2api/bin/kin-worker')
  assert.equal(seen.argv[0], 'oauth')
  assert.equal(seen.argv[1], 'usage')
  assert.equal(seen.argv[2], '--config')
  assert.equal(seen.argv.includes('exec'), false)
  assert.equal(fs.existsSync(seen.argv[3]), false, 'ephemeral panel oauth config must be deleted after exit')
  assert.equal(configContentDuringRun.vm_id, 'vm-07')
  assert.equal(configContentDuringRun.credential_path, path.resolve(homeDir, '.claude', 'credentials.json'))
  assert.equal(configContentDuringRun.egress_mode, 'socks')
  assert.equal(configContentDuringRun.proxy_url, 'socks5h://user:pass@10.0.0.2:1080')
  assert.equal(configContentDuringRun.proxy_required, true)
})

test('runSlotOauth fails closed with proxy_required when the VM has no bound proxy', async (t) => {
  const { exec } = makeSlotFixture(t, { id: 'vm-07' })
  let invoked = false
  const result = await runSlotOauth(exec, 'profile', {
    runWorker: async () => {
      invoked = true
      return { code: 0, stdout: '{"ok":true,"status":200,"body":{},"headers":{}}', stderr: '', timed_out: false }
    },
  })
  assert.equal(invoked, false)
  assert.equal(result.ok, false)
  assert.equal(result.body.error.code, 'proxy_required')
  assert.equal(result.via, 'panel-worker')
  assert.equal(result.transportError, true)
})

test('runSlotOauth sends count-tokens stdin and preserves worker metadata from run/worker.json', async (t) => {
  const { exec, slotDir } = makeSlotFixture(t, localProxyVm)
  fs.writeFileSync(
    path.join(slotDir, 'run', 'worker.json'),
    JSON.stringify({ oauth_user_agent: 'claude-code/2.1.321', cli_version: '2.1.321' }),
  )
  let seen = null
  const result = await runSlotOauth(exec, 'count-tokens', {
    body: { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] },
    headers: { 'anthropic-version': '2023-06-01' },
    timeoutMs: 1234,
    runWorker: async (argv, options) => {
      seen = { argv, options }
      return {
        code: 0,
        stdout: 'diagnostic line\n{"ok":true,"status":200,"body":{"input_tokens":12},"headers":{"x-test":"ok"}}\n',
        stderr: '',
        timed_out: false,
      }
    },
  })

  assert.equal(seen.argv[0], 'oauth')
  assert.equal(seen.argv[1], 'count-tokens')
  assert.equal(seen.options.panelConfig.oauth_user_agent, 'claude-code/2.1.321')
  assert.equal(seen.options.panelConfig.cli_version, '2.1.321')
  assert.deepEqual(JSON.parse(seen.options.stdin), {
    body: { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] },
    headers: { 'anthropic-version': '2023-06-01' },
  })
  assert.equal(seen.options.timeoutMs, 1234)
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    body: { input_tokens: 12 },
    headers: { 'x-test': 'ok' },
    via: 'panel-worker',
  })
})

test('runSlotOauth sends reset-redeem stdin without wrapping it', async (t) => {
  const { exec } = makeSlotFixture(t, localProxyVm)
  let seen = null
  await runSlotOauth(exec, 'reset-redeem', {
    body: {
      organization_uuid: '11111111-1111-4111-8111-111111111111',
      grant_id: 'grant_next',
      request_id: 'a'.repeat(64),
    },
    runWorker: async (argv, options) => {
      seen = { argv, options }
      return {
        code: 0,
        stdout: '{"ok":true,"status":200,"body":{"result":"reset"},"headers":{}}\n',
        stderr: '',
        timed_out: false,
      }
    },
  })
  assert.equal(seen.argv[1], 'reset-redeem')
  assert.deepEqual(JSON.parse(seen.options.stdin), {
    organization_uuid: '11111111-1111-4111-8111-111111111111',
    grant_id: 'grant_next',
    request_id: 'a'.repeat(64),
  })
})

test('runSlotOauth includes --force only when requested and seals + projects credentials after refresh', async (t) => {
  const { exec, root, slotDir, homeDir } = makeSlotFixture(t, localProxyVm)
  const vmPath = path.join(root, 'vms', `${localProxyVm.id}.json`)
  fs.writeFileSync(vmPath, JSON.stringify({ ...localProxyVm, claude: {} }))
  const credFile = path.join(homeDir, '.claude', 'credentials.json')
  const calls = []
  const synced = []
  const runWorker = async (argv) => {
    calls.push(argv)
    const tmp = `${credFile}.${calls.length}.tmp`
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: `at-rotated-${calls.length}`,
          refreshToken: `rt-rotated-${calls.length}`,
          expiresAt: Date.now() + 3600_000,
          email: 'strip-me@example.com',
        },
      }),
      { mode: 0o600 },
    )
    // Simulates Go worker atomicWrite: replaces even a 0444 sealed credentials.json.
    fs.renameSync(tmp, credFile)
    return {
      code: 0,
      stdout: '{"ok":true,"status":200,"body":{"refreshed":true},"headers":{}}',
      stderr: '',
      timed_out: false,
    }
  }
  const host = {
    kind: 'local',
    syncCredentials: async (vm, dir) => {
      synced.push({ id: vm.id, dir })
      return { pushed: true }
    },
  }
  const r1 = await runSlotOauth(exec, 'refresh', { runWorker, host })
  const r2 = await runSlotOauth(exec, 'refresh', { force: true, runWorker, host })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.ok(!calls[0].includes('--force'))
  assert.ok(calls[1].includes('--force'))
  assert.equal(synced.length, 2)
  assert.deepEqual(synced[0], { id: 'vm-07', dir: slotDir })
  assert.equal(fs.statSync(credFile).mode & 0o777, 0o444)
  assert.equal(fs.readlinkSync(path.join(homeDir, '.claude', '.credentials.json')), 'credentials.json')
  assert.doesNotMatch(fs.readFileSync(credFile, 'utf8'), /strip-me@example\.com|"email"/)
  const storedVm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(storedVm.claude.has_access, true)
  assert.equal(storedVm.claude.has_refresh, true)
})

test('runSlotOauth returns retryable credential_sync_failed if one-way projection fails after refresh', async (t) => {
  const { exec, homeDir } = makeSlotFixture(t, localProxyVm)
  writeWorkerCredentialFile(homeDir, {
    access_token: 'at-new',
    refresh_token: 'rt-new',
    expires_at: Date.now() + 3600_000,
  })
  let attempts = 0
  const result = await runSlotOauth(exec, 'refresh', {
    runWorker: async () => ({
      code: 0,
      stdout: '{"ok":true,"status":200,"body":{"refreshed":true},"headers":{}}',
      stderr: '',
      timed_out: false,
    }),
    host: {
      kind: 'node',
      syncCredentials: async () => {
        attempts += 1
        throw new Error('sftp broken')
      },
    },
  })
  assert.equal(attempts, 2, 'projection must retry once before failing')
  assert.equal(result.ok, false)
  assert.equal(result.body.error.code, 'credential_sync_failed')
  assert.equal(result.attempt_guard, true)
})

test('runSlotOauth parses the last non-empty JSON line', async (t) => {
  const { exec } = makeSlotFixture(t, localProxyVm)
  const result = await runSlotOauth(exec, 'usage', {
    runWorker: async () => ({
      code: 0,
      stdout: '\nworker started\n\n{"ok":true,"status":200,"body":{"five_hour":{"utilization":0.1}},"headers":{}}\n\n',
      stderr: '',
      timed_out: false,
    }),
  })
  assert.equal(result.body.five_hour.utilization, 0.1)
})

test('runSlotOauth maps timeout to a transport error', async (t) => {
  const { exec } = makeSlotFixture(t, localProxyVm)
  const result = await runSlotOauth(exec, 'profile', {
    timeoutMs: 5,
    runWorker: async () => ({ code: null, stdout: '', stderr: '', timed_out: true }),
  })
  assert.deepEqual(result, {
    ok: false,
    status: 0,
    body: { error: { code: 'worker_timeout' } },
    headers: {},
    via: 'panel-worker',
    transportError: true,
  })
})

test('runSlotOauth reports invalid worker output with stderr context', async (t) => {
  const { exec } = makeSlotFixture(t, localProxyVm)
  const result = await runSlotOauth(exec, 'models', {
    runWorker: async () => ({
      code: 1,
      stdout: 'not json\n',
      stderr: 'worker failed\nsecret details',
      timed_out: false,
    }),
  })
  assert.deepEqual(result, {
    ok: false,
    status: 0,
    body: { error: { code: 'worker_output_invalid', message: 'worker failed\nsecret details' } },
    headers: {},
    via: 'panel-worker',
    transportError: true,
  })
})

test('buildPanelOauthConfig ignores worker.json test_endpoints and custom URLs unless KIN_WORKER_TEST_ENDPOINTS=1', (t) => {
  const prev = process.env.KIN_WORKER_TEST_ENDPOINTS
  t.after(() => {
    if (prev === undefined) delete process.env.KIN_WORKER_TEST_ENDPOINTS
    else process.env.KIN_WORKER_TEST_ENDPOINTS = prev
  })
  delete process.env.KIN_WORKER_TEST_ENDPOINTS

  const maliciousWorkerJson = JSON.stringify({
    test_endpoints: true,
    egress_mode: 'transparent',
    proxy_url: '',
    proxy_required: false,
    anthropic_base_url: 'http://127.0.0.1:9999',
    oauth_token_url: 'http://127.0.0.1:9999/v1/oauth/token',
  })

  // Unbound VM must still fail closed with proxy_required even if slot tampered with run/worker.json.
  const unbound = makeSlotFixture(t, { id: 'vm-07' })
  fs.writeFileSync(path.join(unbound.slotDir, 'run', 'worker.json'), maliciousWorkerJson)
  const denied = buildPanelOauthConfig(unbound.exec)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'proxy_required')

  // Bound SOCKS5 VM must ignore injected test_endpoints / endpoint URLs from slot-writable run/worker.json.
  const bound = makeSlotFixture(t, socksProxyVm)
  fs.writeFileSync(path.join(bound.slotDir, 'run', 'worker.json'), maliciousWorkerJson)
  const sanitized = buildPanelOauthConfig(bound.exec)
  assert.equal(sanitized.ok, true)
  assert.equal(sanitized.config.test_endpoints, undefined)
  assert.equal(sanitized.config.anthropic_base_url, undefined)
  assert.equal(sanitized.config.oauth_token_url, undefined)
  assert.equal(sanitized.config.egress_mode, 'socks')
  assert.equal(sanitized.config.proxy_url, 'socks5h://user:pass@10.0.0.2:1080')

  // Explicit control-plane opt-in enables test_endpoints overrides from a regular worker.json.
  process.env.KIN_WORKER_TEST_ENDPOINTS = '1'
  const built = buildPanelOauthConfig(unbound.exec)
  assert.equal(built.ok, true)
  assert.equal(built.config.test_endpoints, true)
  assert.equal(built.config.anthropic_base_url, 'http://127.0.0.1:9999')
  assert.equal(built.config.oauth_token_url, 'http://127.0.0.1:9999/v1/oauth/token')

  // Even when KIN_WORKER_TEST_ENDPOINTS=1, a symlinked run/worker.json is never followed.
  const outsideFile = path.join(unbound.root, 'outside-worker.json')
  fs.writeFileSync(outsideFile, maliciousWorkerJson)
  const symlinked = makeSlotFixture(t, { id: 'vm-08' })
  fs.symlinkSync(outsideFile, path.join(symlinked.slotDir, 'run', 'worker.json'))
  const blockedLink = buildPanelOauthConfig(symlinked.exec)
  assert.equal(blockedLink.ok, false)
  assert.equal(blockedLink.code, 'proxy_required')
})

test('slot oauth guard prevents node-fetch Anthropic host calls', () => {
  const srcRoot = path.resolve('src')
  const files = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile() && file.endsWith('.mjs')) files.push(file)
    }
  }
  visit(srcRoot)
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    const hasNodeFetch = source.includes('node-fetch')
    const hasAnthropicHost =
      source.includes('api.anthropic.com') || source.includes('platform.claude.com/v1/oauth/token')
    assert.equal(
      hasNodeFetch && hasAnthropicHost,
      false,
      `forbidden host fetch in ${path.relative(process.cwd(), file)}`,
    )
  }
})
