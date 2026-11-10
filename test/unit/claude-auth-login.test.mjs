import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertAuthLoginReady,
  authLoginSessionDir,
  completeClaudeAuthLogin,
  extractAuthLoginUrl,
  isPersistentAuthLoginSession,
  officialLoginCredentialToOauth,
  startClaudeAuthLoginSession,
  stopClaudeAuthLoginSession,
} from '../../src/lib/oauth/claude-auth-login.mjs'
import { KVM_GUEST_EXEC } from '../../src/lib/vm/slot-exec.mjs'
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
  assert.equal(isPersistentAuthLoginSession(session, { cliBin: '/home/kincli/.kin/cli-node' }), true)
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

test('auth readiness checks the selected native CLI, never the installed standard CLI', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-auth-native-'))
  const vm = { id: 'vm-01', dataplane: 'crag', crag_kernel_version: 'v2' }
  const cli = path.join(root, 'vms/vm-01/cli-home/.kin/crag-v2/claude-code-2.1.321/claude')
  try {
    fs.mkdirSync(path.dirname(cli), { recursive: true })
    fs.writeFileSync(path.join(root, 'vms/vm-01/cli-home/.kin/cli-node'), '')
    await assert.rejects(assertAuthLoginReady(root, vm, { inspect: () => ({ running: true }) }), {
      code: 'claude_cli_missing',
    })
    fs.writeFileSync(cli, '')
    const ready = await assertAuthLoginReady(root, vm, { inspect: () => ({ running: true }) })
    assert.equal(ready.cli, cli)
    const inherited = await assertAuthLoginReady(
      root,
      { id: 'vm-01' },
      {
        inspect: () => ({ running: true }),
        routing: { inference: { dataplane: 'crag', crag_kernel_version: 'v2' } },
      },
    )
    assert.equal(inherited.cli, cli)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('native auth dispatch passes the selected executable and leaves its version untouched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-auth-native-start-'))
  const vm = { id: 'vm-01', dataplane: 'crag', crag_kernel_version: 'v2' }
  const cli = path.join(root, 'vms/vm-01/cli-home/.kin/crag-v2/claude-code-2.1.321/claude')
  try {
    fs.mkdirSync(path.dirname(cli), { recursive: true })
    fs.writeFileSync(cli, '')
    let env
    const result = await startClaudeAuthLoginSession({
      vm,
      projectRoot: root,
      inspect: () => ({ running: true }),
      prepare: async ({ exec }) => ({ exec }),
      stopSession: async () => {},
      spawnPty: (_bin, _args, opts) => {
        env = opts.env
        fs.writeFileSync(
          path.join(env.KIN_SESSION_DIR, 'status.json'),
          JSON.stringify({
            session_id: env.KIN_SESSION_ID,
            cli_bin: env.KIN_CLI_BIN,
            auth_url: 'https://claude.com/cai/oauth/authorize?native=1',
            status: 'waiting_auth',
            updated_at: Date.now(),
            expires_at: Number(env.KIN_EXPIRES_AT),
          }),
        )
        return { unref() {} }
      },
    })
    assert.match(result.auth_url, /native=1/)
    assert.equal(env.KIN_CLI_BIN, '/home/kincli/.kin/crag-v2/claude-code-2.1.321/claude')
    const argv = JSON.parse(env.KIN_DOCKER_ARGV)
    assert.deepEqual(argv.slice(-3), [env.KIN_CLI_BIN, 'auth', 'login'])
    assert.equal(
      argv.some((arg) => arg.startsWith('CLAUDE_CODE_VERSION=')),
      false,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('assertAuthLoginReady refuses a missing container and a missing cli-node', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-auth-login-ready-'))
  const stopped = () => ({ running: false })
  const running = () => ({ running: true })
  try {
    fs.mkdirSync(path.join(root, 'vms', 'vm-01'), { recursive: true })
    fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify({ id: 'vm-01' }))
    await assert.rejects(
      assertAuthLoginReady(root, { id: 'vm-01' }, { inspect: stopped }),
      (err) => err.code === 'container_not_ready',
    )
    const home = path.join(root, 'vms', 'vm-01', 'cli-home', '.kin')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'cli-node'), '')
    await assert.rejects(
      assertAuthLoginReady(root, { id: 'vm-01' }, { inspect: stopped }),
      (err) => err.code === 'container_not_ready',
    )
    await assert.rejects(
      assertAuthLoginReady(root, { id: 'vm-missing' }, { inspect: running }),
      (err) => err.code === 'cli_node_missing',
    )
    const remote = { id: 'vm-01', node_id: 'node-a' }
    await assert.rejects(
      assertAuthLoginReady(root, remote, { inspect: running }),
      (err) => err.code === 'container_unreadable',
    )
    assert.equal((await assertAuthLoginReady(root, { id: 'vm-01' }, { inspect: running })).container, 'kin-01')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a live login session is not reused after the container stops or cli-node disappears', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-auth-login-reuse-'))
  const vm = { id: 'vm-01', runtime: { type: 'docker' }, proxy: { id: 'px-local' } }
  const running = () => ({ running: true })
  const stopped = () => ({ running: false })
  const prepare = (options) =>
    prepareSlotOAuth({
      ...options,
      startReady: async () => ({
        ok: true,
        rust_ok: true,
        // startSlotReady nests it: { ok, engine, rust: { ok, reason, health } }
        rust: {
          ok: true,
          engine: 'rust',
          rust: { ok: true, health: { vm_telemetry: true, telemetry_ready: true } },
        },
      }),
    })
  try {
    const home = path.join(root, 'vms', 'vm-01', 'cli-home', '.kin')
    fs.mkdirSync(home, { recursive: true })
    const cli = path.join(home, 'cli-node')
    fs.writeFileSync(cli, '')
    fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify(vm))
    const dir = authLoginSessionDir(root, 'vm-01')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(root, 'vms', 'vm-01', 'run', 'kernel.json'),
      JSON.stringify({
        credential_path: '/home/kincli/.claude/credentials.json',
      }),
    )
    fs.writeFileSync(path.join(dir, 'pty.pid'), `${process.pid}\n`)
    fs.writeFileSync(
      path.join(dir, 'status.json'),
      JSON.stringify({
        session_id: 'live-login',
        auth_url: 'https://claude.com/cai/oauth/authorize?code=true&live=1',
        status: 'waiting_auth',
        expires_at: Date.now() + 60_000,
        updated_at: Date.now(),
      }),
    )
    const reused = await startClaudeAuthLoginSession({ vm, projectRoot: root, inspect: running, prepare })
    assert.equal(reused.reused, true)
    assert.equal(reused.session_id, 'live-login')
    await assert.rejects(
      () => startClaudeAuthLoginSession({ vm, projectRoot: root, inspect: stopped, prepare }),
      (err) => err.code === 'container_not_ready',
    )
    fs.rmSync(cli)
    await assert.rejects(
      () => startClaudeAuthLoginSession({ vm, projectRoot: root, inspect: running, prepare }),
      (err) => err.code === 'cli_node_missing',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('fake claude_code login returns the official CAI url and a full oauth grant', async () => {
  process.env.KIN_FAKE_SESSION_OAUTH = '1'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-auth-login-fake-'))
  try {
    fs.mkdirSync(path.join(root, 'vms', 'vm-01', 'cli-home', '.kin'), { recursive: true })
    fs.writeFileSync(path.join(root, 'vms', 'vm-01', 'cli-home', '.kin', 'cli-node'), '')
    const started = await startClaudeAuthLoginSession({
      vm: { id: 'vm-01' },
      projectRoot: root,
      inspect: () => ({ running: true }),
    })
    assert.equal(started.flavor, 'claude_code')
    assert.equal(started.source, 'claude-auth-login')
    assert.match(started.auth_url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true/)
    const cred = await completeClaudeAuthLogin({
      projectRoot: '/tmp/unused',
      vmId: 'vm-01',
      sessionId: started.session_id,
      code: 'pasted-code#state',
    })
    assert.equal(cred.email, 'fake-oauth@kin.test')
    assert.equal(cred.mode, 'oauth')
    assert.match(cred.scope, /user:file_upload/)
    assert.ok(cred.refresh_token)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    delete process.env.KIN_FAKE_SESSION_OAUTH
  }
})

test('stopClaudeAuthLoginSession pkills auth login, not setup-token', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-auth-login-stop-'))
  try {
    fs.mkdirSync(path.join(root, 'vms'))
    fs.writeFileSync(path.join(root, 'vms', 'vm-02.json'), JSON.stringify({ id: 'vm-02', runtime: { type: 'docker' } }))
    const seen = []
    await stopClaudeAuthLoginSession(root, 'vm-02', {
      execDetach: async (_connect, id, cmd) => {
        seen.push({ id, cmd })
      },
    })
    assert.equal(seen[0].id, 'kin-02')
    assert.deepEqual(seen[0].cmd.slice(0, 2), ['sh', '-lc'])
    assert.match(seen[0].cmd.at(-1), /auth login/)
    assert.match(seen[0].cmd.at(-1), /crag-v2\/claude-code-/)
    assert.match(seen[0].cmd.at(-1), /opt\/kin-live/)
    assert.doesNotMatch(seen[0].cmd.at(-1), /setup-token/)

    fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify({ id: 'vm-01', runtime: { type: 'kvm' } }))
    const kvm = []
    await stopClaudeAuthLoginSession(root, 'vm-01', {
      execDetach: async (_connect, _id, cmd) => {
        kvm.push(cmd)
      },
    })
    assert.equal(kvm[0][0], KVM_GUEST_EXEC)
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
