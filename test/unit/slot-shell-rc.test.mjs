import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  adoptShellLogin,
  adoptLiveShellLogin,
  createLiveLoginAdoption,
  createSlotShell,
  panelShellLaunch,
  syncShellLoginCredentials,
} from '../../src/lib/vm/slot-shell.mjs'
import { FULL_OAUTH_SCOPE } from '../../src/lib/oauth/oauth-contract.mjs'
import { assertAuthLoginReady } from '../../src/lib/oauth/claude-auth-login.mjs'
import { OFFICIAL_CLI_VERSION } from '../../src/lib/identity/vm-identity.mjs'
import {
  ensureOfficialCredentialLink,
  readWorkerCredentialFile,
  writeWorkerCredentialFile,
  authLoginBlocksRefresh,
} from '../../src/lib/oauth/oauth-credentials.mjs'
test('claude in the panel shell runs cli-node and points config at .claude', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-rc-'))
  const bin = path.join(dir, 'cli-node')
  const decoyDir = path.join(dir, 'decoy')
  const home = path.join(dir, 'home')
  fs.mkdirSync(decoyDir)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', 'credentials.json'), '{}\n')
  fs.writeFileSync(path.join(home, '.claude', '.claude.json'), '{"oauthAccount":{}}\n')
  fs.writeFileSync(bin, '#!/bin/sh\necho "cli-node $*"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(decoyDir, 'claude'), '#!/bin/sh\necho DECOY\n', { mode: 0o755 })
  const { rc, cmd } = panelShellLaunch(bin)
  assert.match(cmd.at(-1), /bash --rcfile/)
  assert.match(rc, /CLAUDE_CONFIG_DIR/)
  assert.match(rc, /CLAUDE_CODE_HOST_REFRESH=1/)
  assert.match(rc, new RegExp(`CLAUDE_CODE_VERSION=${OFFICIAL_CLI_VERSION.replaceAll('.', '\\.')}`))
  assert.match(rc, /USER_TYPE=external/)
  const rcPath = path.join(dir, 'rc')
  fs.writeFileSync(rcPath, `${rc}\n`)
  const ran = spawnSync(
    'bash',
    ['--rcfile', rcPath, '-ic', 'type claude; printf %s "$CLAUDE_CONFIG_DIR"; echo; claude --flag'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${decoyDir}:${process.env.PATH}`,
        KIN_PANEL_RCFILE: rcPath,
      },
    },
  )
  assert.equal(ran.status, 0, ran.stderr)
  assert.match(ran.stdout, /claude is a function/)
  assert.match(ran.stdout, /cli-node --flag/)
  assert.doesNotMatch(ran.stdout, /DECOY/)
  assert.equal(fs.readlinkSync(path.join(home, '.claude', '.credentials.json')), 'credentials.json')
  assert.equal(fs.readlinkSync(path.join(home, '.claude.json')), '.claude/.claude.json')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('official login starts claude only when the panel login marker is set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-login-'))
  const bin = path.join(dir, 'cli-node')
  fs.writeFileSync(bin, '#!/bin/sh\necho "cli-node $*"\n', { mode: 0o755 })
  const { rc } = panelShellLaunch(bin)
  const rcPath = path.join(dir, 'rc')
  fs.writeFileSync(rcPath, `${rc}\n`)
  const script = ['set +e', rc, 'exit 0'].join('\n')
  const run = (env) =>
    spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}`, KIN_PANEL_RCFILE: rcPath, ...env },
    })
  const plain = run({})
  const login = run({ KIN_PANEL_LOGIN: '1' })
  assert.equal(plain.status, 0, plain.stderr)
  assert.doesNotMatch(plain.stdout, /cli-node/)
  assert.equal(login.status, 0, login.stderr)
  assert.match(login.stdout, /cli-node\s*$/m)
  assert.doesNotMatch(login.stdout, /auth login/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a fresh slot login links the official credential file onto the worker file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-cred-'))
  const home = path.join(root, 'cli-home')
  try {
    const linked = ensureOfficialCredentialLink(home, { create: true })
    assert.equal(linked.linked, true)
    const official = path.join(home, '.claude', '.credentials.json')
    assert.equal(fs.readlinkSync(official), 'credentials.json')
    fs.writeFileSync(
      official,
      JSON.stringify({
        claudeAiOauth: { accessToken: 'at-fresh', refreshToken: 'rt-fresh', scopes: ['user:profile'] },
      }),
    )
    assert.equal(readWorkerCredentialFile(home).refresh_token, 'rt-fresh')
    assert.equal(ensureOfficialCredentialLink(home).linked, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a newer official credential file is adopted before the old refresh token can be reused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-adopt-newer-'))
  const home = path.join(root, 'cli-home')
  const claude = path.join(home, '.claude')
  const worker = path.join(claude, 'credentials.json')
  const official = path.join(claude, '.credentials.json')
  try {
    fs.mkdirSync(claude, { recursive: true })
    fs.writeFileSync(
      worker,
      JSON.stringify({
        claudeAiOauth: { accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: 1_000 },
      }),
    )
    fs.writeFileSync(
      official,
      JSON.stringify({
        claudeAiOauth: { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: 2_000 },
      }),
    )
    const linked = ensureOfficialCredentialLink(home)
    assert.equal(linked.adopted, true)
    assert.equal(linked.linked, true)
    assert.equal(fs.readlinkSync(official), 'credentials.json')
    assert.equal(readWorkerCredentialFile(home).refresh_token, 'rt-new')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('cluster login prepare reconciles remote credentials instead of import push', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-cluster-prepare-'))
  try {
    const calls = []
    await syncShellLoginCredentials(
      root,
      { id: 'vm-07', node_id: 'node-a' },
      {
        phase: 'prepare',
        host: { kind: 'node' },
        reconcile: async () => {
          calls.push('reconcile')
          return { pulled: true }
        },
        ensureRemoteLink: async () => {
          calls.push('remote_link')
        },
      },
    )
    assert.deepEqual(calls, ['reconcile', 'remote_link'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an older official credential file does not replace the worker grant', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-keep-worker-'))
  const home = path.join(root, 'cli-home')
  const claude = path.join(home, '.claude')
  const official = path.join(claude, '.credentials.json')
  try {
    fs.mkdirSync(claude, { recursive: true })
    fs.writeFileSync(
      path.join(claude, 'credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'at-live', refreshToken: 'rt-live', expiresAt: 5_000 },
      }),
    )
    fs.writeFileSync(
      official,
      JSON.stringify({
        claudeAiOauth: { accessToken: 'at-stale', refreshToken: 'rt-stale', expiresAt: 1_000 },
      }),
    )
    const linked = ensureOfficialCredentialLink(home)
    assert.equal(linked.adopted, false)
    assert.equal(fs.readlinkSync(official), 'credentials.json')
    assert.equal(readWorkerCredentialFile(home).refresh_token, 'rt-live')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a grant that exists only in .credentials.json becomes the worker file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-dot-only-'))
  const home = path.join(root, 'cli-home')
  const official = path.join(home, '.claude', '.credentials.json')
  try {
    fs.mkdirSync(path.dirname(official), { recursive: true })
    fs.writeFileSync(
      official,
      JSON.stringify({
        claudeAiOauth: { accessToken: 'at-only', refreshToken: 'rt-only', expiresAt: 9_000 },
      }),
    )
    const linked = ensureOfficialCredentialLink(home)
    assert.equal(linked.adopted, true)
    assert.equal(readWorkerCredentialFile(home).refresh_token, 'rt-only')
    assert.equal(fs.readlinkSync(official), 'credentials.json')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an in-progress claude auth login blocks the host refresh', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-login-hold-'))
  const home = path.join(root, 'cli-home')
  const status = path.join(root, 'run', 'auth-login', 'status.json')
  try {
    fs.mkdirSync(path.dirname(status), { recursive: true })
    assert.equal(authLoginBlocksRefresh(home), false)
    fs.writeFileSync(status, JSON.stringify({ status: 'url_ready', expires_at: Date.now() + 60_000 }))
    assert.equal(authLoginBlocksRefresh(home), true)
    fs.writeFileSync(status, JSON.stringify({ status: 'login_ready', expires_at: Date.now() + 60_000 }))
    assert.equal(authLoginBlocksRefresh(home), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('cluster shell login pulls remote OAuth before adopt imports it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-cluster-adopt-'))
  const home = path.join(root, 'vms', 'vm-07', 'cli-home')
  const worker = path.join(home, '.claude', 'credentials.json')
  const grant = {
    claudeAiOauth: {
      accessToken: 'at-node',
      refreshToken: 'rt-node',
      expiresAt: Date.now() + 3600_000,
      scopes: FULL_OAUTH_SCOPE.split(' '),
      email: 'node@example.com',
    },
  }
  try {
    fs.mkdirSync(path.dirname(worker), { recursive: true })
    fs.writeFileSync(worker, '{}\n')
    const calls = []
    const host = {
      kind: 'node',
      afterRefresh: async () => {
        calls.push('adopt')
        fs.writeFileSync(worker, JSON.stringify(grant))
      },
    }
    await syncShellLoginCredentials(
      root,
      { id: 'vm-07', node_id: 'node-a' },
      {
        phase: 'prepare',
        host,
        reconcile: async () => {
          calls.push('reconcile')
          return { pulled: false, reason: 'same' }
        },
        ensureRemoteLink: async () => {
          calls.push('remote_link')
        },
      },
    )
    const adopted = await adoptShellLogin(
      root,
      { id: 'vm-07', node_id: 'node-a' },
      {
        loginHost: host,
        importOauth: async (input) => {
          calls.push('import')
          writeWorkerCredentialFile(home, input.oauth)
          return { ok: true }
        },
      },
    )
    assert.equal(adopted.imported, true)
    assert.deepEqual(calls, ['reconcile', 'remote_link', 'adopt', 'import'])
    assert.equal(readWorkerCredentialFile(home).refresh_token, 'rt-node')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('shell login is synced into the worker credential and the terminal keeps the link', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-adopt-'))
  const home = path.join(root, 'vms', 'vm-02', 'cli-home')
  const official = path.join(home, '.claude', '.credentials.json')
  try {
    fs.mkdirSync(path.dirname(official), { recursive: true })
    fs.writeFileSync(
      official,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'at-shell',
          refreshToken: 'rt-shell',
          expiresAt: Date.now() + 3600_000,
          scopes: ['user:profile', 'user:inference'],
          email: 'shell@example.com',
        },
      }),
    )
    const calls = []
    const adopted = await adoptShellLogin(
      root,
      { id: 'vm-02' },
      {
        importOauth: async (input) => {
          calls.push(input)
          writeWorkerCredentialFile(home, input.oauth)
          return { ok: true }
        },
      },
    )
    assert.equal(adopted.imported, true)
    assert.equal(adopted.linked, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].source, 'claude-auth-login')
    assert.equal(readWorkerCredentialFile(home).refresh_token, 'rt-shell')
    assert.equal(fs.readlinkSync(official), 'credentials.json')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a live interactive grant is imported once into the worker credential', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-live-'))
  const home = path.join(root, 'vms', 'vm-02', 'cli-home')
  const official = path.join(home, '.claude', '.credentials.json')
  const worker = path.join(home, '.claude', 'credentials.json')
  fs.mkdirSync(path.dirname(official), { recursive: true })
  fs.writeFileSync(worker, '{}\n')
  fs.symlinkSync('credentials.json', official)
  const calls = []
  const vm = { id: 'vm-02' }
  const importer = async (input) => {
    calls.push(input.oauth.refresh_token)
    writeWorkerCredentialFile(home, input.oauth)
    return { ok: true }
  }
  try {
    const empty = await adoptLiveShellLogin(root, vm, { importOauth: importer })
    assert.equal(empty.imported, false)
    fs.writeFileSync(
      official,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'at-live',
          refreshToken: 'rt-live',
          expiresAt: Date.now() + 3600_000,
          scopes: ['user:profile', 'user:inference'],
          email: 'live@example.com',
          subscriptionType: 'max',
        },
      }),
    )
    const first = await adoptLiveShellLogin(root, vm, { importOauth: importer })
    const second = await adoptLiveShellLogin(root, vm, {
      importOauth: importer,
      seen: first.refresh,
    })
    const stored = readWorkerCredentialFile(home)
    assert.equal(first.imported, true)
    assert.equal(second.imported, false)
    assert.deepEqual(calls, ['rt-live'])
    assert.equal(stored.refresh_token, 'rt-live')
    assert.equal(stored.subscription_type, 'max')
    assert.equal(fs.readlinkSync(official), 'credentials.json')
    assert.equal(fs.realpathSync(official), fs.realpathSync(worker))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a cluster grant is pulled before an empty local file can hide it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-live-node-'))
  const home = path.join(root, 'vms', 'vm-07', 'cli-home')
  const worker = path.join(home, '.claude', 'credentials.json')
  fs.mkdirSync(path.dirname(worker), { recursive: true })
  fs.writeFileSync(worker, '{}\n')
  const calls = []
  const host = {
    kind: 'node',
    afterRefresh: async () => {
      calls.push('pull')
      fs.writeFileSync(
        worker,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'at-node',
            refreshToken: 'rt-node',
            expiresAt: Date.now() + 3600_000,
            scopes: FULL_OAUTH_SCOPE.split(' '),
            email: 'node@example.com',
          },
        }),
      )
    },
  }
  try {
    const adopted = await adoptLiveShellLogin(
      root,
      { id: 'vm-07', node_id: 'node-a' },
      {
        loginHost: host,
        importOauth: async (input) => {
          calls.push(input.oauth.refresh_token)
          writeWorkerCredentialFile(home, input.oauth)
          return { ok: true }
        },
      },
    )
    assert.equal(adopted.imported, true)
    assert.equal(adopted.refresh, 'rt-node')
    assert.deepEqual(calls, ['pull', 'pull', 'rt-node'])
    assert.equal(readWorkerCredentialFile(home).refresh_token, 'rt-node')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a slow interactive import is shared by the next tick and close', async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const run = createLiveLoginAdoption({
    adopt: async (seen) => {
      calls += 1
      await gate
      return seen ? { imported: false, refresh: seen } : { imported: true, refresh: 'rt-1', seen }
    },
  })
  const first = run()
  const second = run(true)
  assert.equal(second, first)
  assert.equal(calls, 1)
  release()
  assert.deepEqual(await first, { imported: true, refresh: 'rt-1', seen: '' })
  assert.deepEqual(await run(), { imported: false, refresh: 'rt-1' })
  assert.equal(calls, 2)
})

test('official login tickets check a cluster slot for its container cli-node', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-ticket-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify({ id: 'vm-01', node_id: 'node-a' }))
  fs.writeFileSync(path.join(root, 'vms', 'vm-02.json'), JSON.stringify({ id: 'vm-02' }))
  const inspected = []
  const shell = createSlotShell({
    projectRoot: root,
    logger: { warn() {} },
    authLoginReady: (projectRoot, vm) =>
      assertAuthLoginReady(projectRoot, vm, {
        inspect: (name) => {
          inspected.push(name)
          return null
        },
      }),
  })
  try {
    const remote = await shell.issueTicket('vm-01', { login: true })
    assert.equal(remote.ok, false)
    assert.notEqual(remote.error.code, 'remote_unsupported')
    const missing = await shell.issueTicket('vm-02', { login: true })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'container_not_ready')
    assert.ok(inspected.includes('kin-02'))
    const ops = await shell.issueTicket('vm-02')
    assert.equal(ops.ok, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an ops shell ticket cannot be upgraded into an official login', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-upgrade-'))
  fs.mkdirSync(path.join(root, 'vms', 'vm-02', 'cli-home', '.kin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', 'vm-02.json'), JSON.stringify({ id: 'vm-02' }))
  fs.writeFileSync(path.join(root, 'vms', 'vm-02', 'cli-home', '.kin', 'cli-node'), '')
  const shell = createSlotShell({ projectRoot: root, logger: { warn() {} } })
  const ops = await shell.issueTicket('vm-02')
  const seen = []
  const socket = {
    write(data) {
      seen.push(String(data))
    },
    destroy() {},
  }
  try {
    const handled = shell.handleUpgrade(
      { url: `/api/panel/vms/vm-02/shell?ticket=${ops.ticket}&login=1` },
      socket,
      Buffer.alloc(0),
    )
    assert.equal(handled, true)
    assert.match(seen[0], /^HTTP\/1\.1 409 /)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-02', 'cli-home', '.claude', 'credentials.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a stopped container rejects the official login upgrade', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-stopped-'))
  fs.mkdirSync(path.join(root, 'vms', 'vm-02', 'cli-home', '.kin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', 'vm-02.json'), JSON.stringify({ id: 'vm-02' }))
  fs.writeFileSync(path.join(root, 'vms', 'vm-02', 'cli-home', '.kin', 'cli-node'), '')
  const shell = createSlotShell({
    projectRoot: root,
    logger: { warn() {} },
    authLoginReady: async () => ({ container: 'kin-02', cli: '/opt/kin/cli-node' }),
    upgradeLoginReady: async () => {
      throw Object.assign(new Error('容器尚未创建或未运行'), { code: 'container_not_ready' })
    },
  })
  const login = await shell.issueTicket('vm-02', { login: true })
  const seen = []
  const socket = {
    write(data) {
      seen.push(String(data))
    },
    destroy() {},
  }
  try {
    assert.equal(login.ok, true)
    const handled = shell.handleUpgrade(
      { url: `/api/panel/vms/vm-02/shell?ticket=${login.ticket}&login=1` },
      socket,
      Buffer.alloc(0),
    )
    assert.equal(handled, true)
    await new Promise((resolve) => setImmediate(resolve))
    assert.match(seen[0], /^HTTP\/1\.1 409 /)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('panelShellLaunch rejects a non-absolute cli-node path', () => {
  assert.throws(() => panelShellLaunch('cli-node'), /invalid cli-node path/)
  assert.throws(() => panelShellLaunch('/tmp/a\nb'), /invalid cli-node path/)
})

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function writeLaunchRc(dir) {
  const bin = path.join(dir, 'cli-node')
  fs.writeFileSync(bin, '#!/bin/sh\necho "cli-node $*"\n', { mode: 0o755 })
  const { rc } = panelShellLaunch(bin)
  const rcPath = path.join(dir, 'rc')
  fs.writeFileSync(rcPath, `${rc}\n`)
  return rcPath
}

test('panel shell prints live 系统特征 before the prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-facts-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(home, '.bashrc'), 'set -e\n')
  const rcPath = writeLaunchRc(dir)
  const ran = spawnSync('bash', ['--rcfile', rcPath, '-ic', 'true'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      KIN_PANEL_RCFILE: rcPath,
      TERM: 'xterm',
    },
  })
  assert.equal(ran.status, 0, ran.stderr)
  assert.match(ran.stdout, /^系统特征$/m)
  const host = spawnSync('sh', ['-c', 'hostname 2>/dev/null || uname -n'], {
    encoding: 'utf8',
  }).stdout.trim()
  const krel = spawnSync('uname', ['-r'], { encoding: 'utf8' }).stdout.trim()
  const kmach = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim()
  assert.match(ran.stdout, new RegExp(`主机\\s+${escapeRe(host)}`))
  assert.match(ran.stdout, new RegExp(`内核\\s+${escapeRe(krel)}`))
  assert.match(ran.stdout, new RegExp(`架构\\s+${escapeRe(kmach)}`))
  assert.match(ran.stdout, /CPU\s+\S/)
  assert.match(ran.stdout, /核数\s+\d+/)
  assert.match(ran.stdout, /内存\s+\d+[GMk]/)
  assert.match(ran.stdout, /磁盘\s+\S/)
  assert.match(ran.stdout, /MAC\s+\S/)
  assert.match(ran.stdout, /厂商\s+\S/)
  assert.match(ran.stdout, /机器ID\s+(已采集|未采集)/)
  assert.match(ran.stdout, /Shell\s+bash/)
  if (fs.existsSync('/etc/os-release')) {
    const text = fs.readFileSync('/etc/os-release', 'utf8')
    const pretty = (text.match(/^PRETTY_NAME=(.*)$/m)?.[1] || '').replace(/^["']|["']$/g, '')
    if (pretty) assert.match(ran.stdout, new RegExp(escapeRe(pretty)))
  }
  if (fs.existsSync('/etc/machine-id')) {
    const mid = fs.readFileSync('/etc/machine-id', 'utf8').trim()
    if (mid) assert.doesNotMatch(ran.stdout, new RegExp(escapeRe(mid)))
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

test('panel shell 系统特征 still prints under sh -i fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-facts-sh-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home)
  const rcPath = writeLaunchRc(dir)
  const ran = spawnSync('sh', ['-ic', ':'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      ENV: rcPath,
      KIN_PANEL_RCFILE: rcPath,
      TERM: 'xterm',
    },
  })
  assert.equal(ran.status, 0, ran.stderr)
  assert.match(ran.stdout, /系统特征/)
  assert.match(ran.stdout, /机器ID\s+(已采集|未采集)/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('panel shell 系统特征 reads the slot computer and cgroup limits before the host', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-facts-computer-'))
  const home = path.join(dir, 'home')
  const hw = path.join(dir, 'kin-hardware')
  const dmi = path.join(dir, 'kin-dmi')
  const cg = path.join(dir, 'cgroup')
  for (const d of [home, hw, dmi, cg]) fs.mkdirSync(d)
  fs.writeFileSync(path.join(hw, 'cpu_brand'), 'Persona CPU i5-1135G7\n')
  fs.writeFileSync(path.join(hw, 'logical_cpus'), '8\n')
  fs.writeFileSync(path.join(hw, 'ram_bytes'), '8589934592\n')
  fs.writeFileSync(path.join(hw, 'mac'), '02:aa:bb:cc:dd:ee\n')
  fs.writeFileSync(path.join(dmi, 'sys_vendor'), 'Dell Inc.\n')
  fs.writeFileSync(path.join(dmi, 'product_name'), 'Inspiron 5502\n')
  fs.writeFileSync(path.join(cg, 'cpu.max'), '150000 100000\n')
  fs.writeFileSync(path.join(cg, 'memory.max'), '4294967296\n')
  // The rc deletes itself after one session, so each run gets a fresh one.
  const run = () => {
    const rcPath = writeLaunchRc(dir)
    return spawnSync('bash', ['--rcfile', rcPath, '-ic', 'true'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        KIN_PANEL_RCFILE: rcPath,
        KIN_HW_DIR: hw,
        KIN_DMI_DIR: dmi,
        KIN_CGROUP_DIR: cg,
        TERM: 'xterm',
      },
    })
  }
  let ran = run()
  assert.equal(ran.status, 0, ran.stderr)
  assert.match(ran.stdout, /CPU\s+Persona CPU i5-1135G7$/m)
  assert.match(ran.stdout, /核数\s+2$/m)
  assert.match(ran.stdout, /内存\s+4G$/m)
  assert.match(ran.stdout, /MAC\s+02:aa:bb:cc:dd:ee$/m)
  assert.match(ran.stdout, /厂商\s+Dell Inc\.$/m)
  assert.match(ran.stdout, /产品\s+Inspiron 5502$/m)
  fs.writeFileSync(path.join(cg, 'cpu.max'), 'max 100000\n')
  fs.writeFileSync(path.join(cg, 'memory.max'), 'max\n')
  ran = run()
  assert.equal(ran.status, 0, ran.stderr)
  assert.match(ran.stdout, /核数\s+8$/m)
  assert.match(ran.stdout, /内存\s+8G$/m)
  fs.rmSync(dir, { recursive: true, force: true })
})
