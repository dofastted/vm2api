import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertAuthLoginReady,
  extractAuthLoginUrl,
  isPersistentAuthLoginSession,
  officialLoginCredentialToOauth,
  resolveAuthLoginClaude,
} from '../../src/lib/oauth/claude-auth-login.mjs'
import { FULL_OAUTH_SCOPE } from '../../src/lib/oauth/oauth-contract.mjs'
import { prepareSlotOAuth } from '../../src/lib/oauth/guest-oauth-helper.mjs'

test('extractAuthLoginUrl reads the official manual CAI link', () => {
  const url =
    'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&scope=user%3Aprofile'
  const raw = `If the browser didn't open, visit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07`
  assert.equal(extractAuthLoginUrl(raw), url)
  const wrapped = 'https://claude.com/cai/oauth/authorize?code=true&\nclient_id=abc&state=xyz'
  assert.equal(extractAuthLoginUrl(wrapped), 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz')
})

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

test('auth login session stays reusable until force regenerate or login_ready', () => {
  const session = {
    alive: true,
    auth_url: 'https://claude.com/cai/oauth/authorize?code=true',
    expired: false,
    status: 'waiting_auth',
  }
  assert.equal(isPersistentAuthLoginSession(session), true)
  assert.equal(isPersistentAuthLoginSession(session, { force: true }), false)
  assert.equal(isPersistentAuthLoginSession({ ...session, status: 'login_ready' }), false)
  assert.equal(isPersistentAuthLoginSession({ ...session, alive: false }), false)
  assert.equal(
    isPersistentAuthLoginSession(session, { cliBin: '/home/kincli/.kin/crag-v2/claude-code-2.1.317/claude' }),
    false,
  )
  assert.equal(
    isPersistentAuthLoginSession({ ...session, cli_bin: '/native/claude' }, { cliBin: '/native/claude' }),
    true,
  )
  assert.equal(
    isPersistentAuthLoginSession({ ...session, cli_bin: '/native/claude' }, { cliBin: '/home/kincli/.kin/cli-node' }),
    false,
  )
})

test('auth uses native CC for wrap slots and honors an explicit executable', async () => {
  const vm = { id: 'vm-01', dataplane: 'wrap' }
  const native = resolveAuthLoginClaude(vm)
  assert.equal(native.native, true)
  assert.equal(native.bin, resolveAuthLoginClaude({ ...vm, dataplane: 'crag' }).bin)
  assert.match(native.bin, /crag-v2\/claude-code-[^/]+\/claude$/)
  const custom = "/opt/Claude Code/it's claude"
  assert.equal(resolveAuthLoginClaude(vm, custom).bin, custom)
  for (const invalid of ['claude', '/tmp/claude\n', '/tmp/claude\0', '/tmp/', 42]) {
    assert.throws(() => resolveAuthLoginClaude(vm, invalid), { code: 'invalid_claude_path' })
  }
  await assert.rejects(
    assertAuthLoginReady('/tmp/unused', vm, {
      inspect: () => ({ running: true }),
      cliBin: custom,
      cliExists: async () => false,
    }),
    { code: 'claude_cli_missing' },
  )
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
      { code: 'claude_cli_missing' },
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('prepareSlotOAuth reads the nested kernel health that startSlotReady actually returns', async () => {
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
  try {
    const ready = await prepareSlotOAuth({
      exec: seed('vm-11'),
      startReady: nested({ vm_telemetry: true, telemetry_ready: true }),
    })
    assert.equal(ready.configDir, '/home/kincli/.claude')

    await assert.rejects(() => prepareSlotOAuth({ exec: seed('vm-12'), startReady: nested(undefined) }), notReady)
    await assert.rejects(
      () =>
        prepareSlotOAuth({
          exec: seed('vm-13'),
          startReady: nested({ vm_telemetry: false, telemetry_ready: true }),
        }),
      notReady,
    )
    await assert.rejects(
      () =>
        prepareSlotOAuth({
          exec: seed('vm-14'),
          startReady: nested({ vm_telemetry: true, telemetry_ready: false }),
        }),
      notReady,
    )
    // startReady is injectable: a flat boot.rust.health must still pass.
    const flat = await prepareSlotOAuth({
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
