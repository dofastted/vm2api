import { spawnSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  assertAuthLoginReady,
  officialLoginCredentialToOauth,
  nativeLoginLaunch,
  readNativeLoginOauth,
  resolveAuthLoginClaude,
} from '../../src/lib/oauth/claude-auth-login.mjs'
import { FULL_OAUTH_SCOPE } from '../../src/lib/oauth/oauth-contract.mjs'
import { prepareSlotOAuth } from '../../src/lib/oauth/guest-oauth-helper.mjs'
import { createImportCommit } from '../../src/lib/oauth/import-commit.mjs'

test('officialLoginCredentialToOauth keeps a full refresh grant and rejects setup tokens', () => {
  const oauth = officialLoginCredentialToOauth({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat-full',
      refreshToken: 'rt-full',
      expiresAt: Date.now() + 8 * 3600 * 1000,
      scopes: FULL_OAUTH_SCOPE.split(' '),
      email: 'user@example.com',
      accountUuid: 'acct-1',
      orgUuid: 'org-1',
      subscriptionType: 'max',
    },
  })
  assert.equal(oauth.type, 'oauth')
  assert.equal(oauth.mode, 'oauth')
  assert.equal(oauth.flavor, 'claude_code')
  assert.equal(oauth.source, 'claude-auth-login')
  assert.equal(oauth.refresh_token, 'rt-full')
  assert.equal(oauth.email, 'user@example.com')
  assert.equal(oauth.subscription_type, 'max')
  assert.match(oauth.scope, /user:profile/)
  assert.match(oauth.scope, /user:file_upload/)
  assert.throws(
    () =>
      officialLoginCredentialToOauth({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-' + 'a'.repeat(90),
          refreshToken: '',
          scopes: ['user:inference'],
        },
      }),
    /完整 OAuth/,
  )
  assert.throws(
    () => officialLoginCredentialToOauth({ claudeAiOauth: { accessToken: 'at', scopes: ['user:inference'] } }),
    /完整 OAuth/,
  )
})

test('only successful native login exposes its fresh private grant', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-auth-login-test-'))
  const bin = path.join(root, 'claude')
  const config = path.join(root, 'login')
  const launch = nativeLoginLaunch(bin, config)
  const grant = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      scopes: ['user:profile', 'user:inference'],
      expiresAt: Date.now() + 3600_000,
    },
  })
  const run = (args, env = process.env) => {
    const { status, stdout } = spawnSync(args[0], args.slice(1), { encoding: 'utf8', env })
    return { exitCode: status, stdout }
  }
  const env = { ...process.env, ...Object.fromEntries(launch.env.map((pair) => pair.split('='))) }
  const stub = "#!/bin/sh\nprintf '%s' " + `'${grant}' > "$CLAUDE_CONFIG_DIR/.credentials.json"\n`
  try {
    fs.writeFileSync(bin, stub + 'exit 1\n', { mode: 0o755 })
    assert.equal(run(launch.cmd, env).exitCode, 1)
    await assert.rejects(readNativeLoginOauth(run, config), { code: 'auth_login_incomplete' })
    fs.rmSync(config, { recursive: true })
    fs.writeFileSync(bin, stub)
    assert.equal(run(launch.cmd, env).exitCode, 0)
    assert.equal(fs.statSync(config).mode & 0o777, 0o700)
    const oauth = await readNativeLoginOauth(run, config)
    assert.equal(oauth.refresh_token, 'new-refresh')
    assert.equal(oauth.source, 'claude-auth-login')
    assert.match(resolveAuthLoginClaude({ id: 'vm-01', dataplane: 'wrap' }), /crag-v2\/claude-code-[^/]+\/claude$/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('native login publishes the grant and existing CC link without probing the inference worker', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-auth-login-publish-'))
  const priorMock = process.env.KIN_CRS_MOCK
  delete process.env.KIN_CRS_MOCK
  const id = 'vm-01'
  const slot = path.join(root, 'vms', id)
  const vmPath = `${slot}.json`
  const home = path.join(slot, 'cli-home', '.claude')
  const run = path.join(slot, 'run')
  fs.mkdirSync(run, { recursive: true })
  const socket = path.join(run, 'kernel.sock')
  let probes = 0
  const server = http.createServer((_req, res) => {
    probes++
    res.end(JSON.stringify({ ok: false, engine: 'rust', cli_pid: 1, ready_slots: 1 }))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
    if (priorMock === undefined) delete process.env.KIN_CRS_MOCK
    else process.env.KIN_CRS_MOCK = priorMock
  })
  const existing = { id, status: 'running', dataplane: 'crag', runtime: { kernel_socket: socket } }
  fs.writeFileSync(vmPath, JSON.stringify(existing))
  const { commitImportedOauth } = createImportCommit({ cfg: { paths: { project: root } } })
  const oauth = officialLoginCredentialToOauth({
    accessToken: 'native-test-access',
    refreshToken: 'native-test-refresh',
    expiresAt: Date.now() + 3_600_000,
    scopes: ['user:profile', 'user:inference'],
    email: 'native-test@example.test',
  })
  const result = await commitImportedOauth({
    vmId: id,
    vmPath,
    existing,
    oauth,
    fromNativeLogin: true,
    skipOfficialCc: true,
  })
  assert.equal(result.ok, true, result.error?.message)
  assert.equal(probes, 0)
  const panel = JSON.parse(fs.readFileSync(vmPath, 'utf8')).claude
  assert.equal(panel.email, 'native-test@example.test')
  assert.equal(panel.has_refresh, true)
  assert.equal(panel.refresh_token, undefined)
  assert.equal(fs.readlinkSync(path.join(home, '.credentials.json')), 'credentials.json')
  const grant = JSON.parse(fs.readFileSync(path.join(home, '.credentials.json'), 'utf8'))
  assert.equal(grant.claudeAiOauth.refreshToken, 'native-test-refresh')
})

test('auth readiness refuses stopped containers and never falls back to cli-node', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-auth-login-ready-'))
  const vm = { id: 'vm-01', dataplane: 'wrap' }
  try {
    const home = path.join(root, 'vms', vm.id, 'cli-home', '.kin')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'cli-node'), '', { mode: 0o755 })
    await assert.rejects(
      assertAuthLoginReady(root, vm, {
        inspect: () => ({ running: false }),
      }),
      { code: 'container_not_ready' },
    )
    await assert.rejects(
      assertAuthLoginReady(root, vm, {
        inspect: () => ({ running: true }),
        cliExists: async (bin) => fs.existsSync(path.join(home, path.posix.relative('/home/kincli/.kin', bin))),
      }),
      { code: 'crag_v2_package_missing' },
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('prepareSlotOAuth requires runtime readiness, not telemetry acknowledgement after startup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-auth-login-runtime-'))
  const seed = (id) => {
    fs.mkdirSync(path.join(root, 'vms', id, 'run'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({ id, runtime: { type: 'docker' }, proxy: { id: 'px-local' } }),
    )
    fs.writeFileSync(
      path.join(root, 'vms', id, 'run', 'kernel.json'),
      JSON.stringify({ credential_path: '/home/kincli/.claude/credentials.json' }),
    )
    return { vmId: id, projectRoot: root }
  }
  // Real startSlotReady → { ok, rust_ok, rust: { ok, engine, rust: { ok, reason, health } } }
  const nested = (health) => async () => ({
    ok: true,
    rust_ok: true,
    rust: { ok: true, engine: 'rust', rust: { ok: true, health } },
  })
  const notReady = (err) => err.code === 'oauth_runtime_not_ready'
  const prepare = (options) =>
    prepareSlotOAuth({
      ...options,
      readHealth: async () => ({ ok: true, vm_telemetry: true, telemetry_ready: true }),
    })
  try {
    const ready = await prepare({
      exec: seed('vm-11'),
      startReady: nested({ vm_telemetry: true, telemetry_ready: true }),
    })
    assert.equal(ready.configDir, '/home/kincli/.claude')

    for (const health of [undefined, { vm_telemetry: false }, { vm_telemetry: true, telemetry_ready: false }]) {
      const context = await prepare({ exec: seed('vm-12'), startReady: nested(health) })
      assert.equal(context.configDir, '/home/kincli/.claude')
    }
    await assert.rejects(
      () =>
        prepare({
          exec: seed('vm-13'),
          startReady: async () => ({ ok: true, rust_ok: false, rust: { ok: false } }),
        }),
      notReady,
    )
    await assert.rejects(
      () =>
        prepare({
          exec: seed('vm-14'),
          startReady: async () => ({ ok: true, rust: { ok: true, skipped: true } }),
        }),
      notReady,
    )
    // startReady is injectable: a flat boot.rust.health must still pass.
    const flat = await prepare({
      exec: seed('vm-15'),
      startReady: async () => ({
        ok: true,
        rust_ok: true,
        rust: { ok: true, health: { vm_telemetry: true, telemetry_ready: true } },
      }),
    })
    assert.equal(flat.configDir, '/home/kincli/.claude')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
