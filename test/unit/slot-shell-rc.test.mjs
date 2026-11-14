import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSlotShell, panelShellLaunch, terminalClaudeBin } from '../../src/lib/vm/slot-shell.mjs'
import { LOCAL_CRAG_CLAUDE, REMOTE_CRAG_CLAUDE } from '../../src/lib/vm/slot-engine.mjs'
import {
  ensureOfficialCredentialLink,
  readWorkerCredentialFile,
  writeWorkerCredentialFile,
} from '../../src/lib/oauth/oauth-credentials.mjs'
test('panel shell shortcuts use the selected Claude and ignore PATH aliases', () => {
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
  const { rc } = panelShellLaunch(bin)
  const rcPath = path.join(dir, 'rc')
  fs.writeFileSync(rcPath, `${rc}\n`)
  const ran = spawnSync(
    'bash',
    ['--rcfile', rcPath, '-ic', 'type claude; printf %s "$CLAUDE_CONFIG_DIR"; echo; claude --flag; usage'],
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
  assert.match(ran.stdout, /cli-node \/usage/)
  assert.doesNotMatch(ran.stdout, /DECOY/)
  assert.equal(fs.readlinkSync(path.join(home, '.claude.json')), '.claude/.claude.json')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('all inference kernels use native Claude for the interactive terminal', () => {
  assert.equal(terminalClaudeBin({ id: 'vm-local', dataplane: 'crag', crag_kernel_version: 'v2' }), LOCAL_CRAG_CLAUDE)
  assert.equal(
    terminalClaudeBin({ id: 'vm-remote', node_id: 'node-a', dataplane: 'crag', crag_kernel_version: 'v2' }),
    REMOTE_CRAG_CLAUDE,
  )
  assert.equal(terminalClaudeBin({ id: 'vm-wrap', dataplane: 'wrap' }), LOCAL_CRAG_CLAUDE)
  assert.equal(terminalClaudeBin({ id: 'vm-cc', dataplane: 'cc' }), LOCAL_CRAG_CLAUDE)
  assert.equal(terminalClaudeBin({ id: 'vm-remote', node_id: 'node-a', dataplane: 'wrap' }), REMOTE_CRAG_CLAUDE)
  assert.equal(
    terminalClaudeBin({ id: 'vm-kvm', dataplane: 'crag', crag_kernel_version: 'v2', runtime: { type: 'kvm' } }),
    LOCAL_CRAG_CLAUDE,
  )
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-crag-'))
  const binDir = path.join(dir, 'crag-v2')
  const bin = path.join(binDir, 'claude')
  fs.mkdirSync(binDir)
  fs.writeFileSync(bin, '#!/bin/sh\necho "crag-claude $*"\n', { mode: 0o755 })
  const { rc } = panelShellLaunch(bin)
  const rcPath = path.join(dir, 'rc')
  fs.writeFileSync(rcPath, `${rc}\n`)
  const ran = spawnSync('bash', ['--rcfile', rcPath, '-ic', 'claude --flag'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}`, KIN_PANEL_RCFILE: rcPath },
  })
  assert.equal(ran.status, 0, ran.stderr)
  assert.match(ran.stdout, /crag-claude --flag/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a legacy login marker cannot start credential exchange in the terminal', () => {
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
  assert.doesNotMatch(login.stdout, /cli-node auth login/)
  assert.doesNotMatch(plain.stdout, /auth login/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('native shell routes usage and cc to native Claude and directs login to the panel', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-native-'))
  try {
    const bin = path.join(dir, 'claude')
    fs.writeFileSync(bin, '#!/bin/sh\nprintf "native:%s:%s\\n" "$*" "${CLAUDE_CODE_VERSION-unset}"\n', { mode: 0o755 })
    const { rc } = panelShellLaunch(bin, { native: true })
    const ran = spawnSync('bash', ['-c', `${rc}\nusage\n/usage\ncc --version\nclaude auth login`], {
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, CLAUDE_CODE_VERSION: 'stale', KIN_PANEL_RCFILE: path.join(dir, 'rc') },
    })
    assert.equal(ran.status, 2, ran.stderr)
    assert.match(ran.stdout, /native:\/usage:unset/)
    assert.match(ran.stdout, /native:--version:unset/)
    assert.doesNotMatch(ran.stdout, /native:auth login/)
    assert.match(ran.stderr, /面板账号页/)
    const rcPath = path.join(dir, 'interactive-rc')
    fs.writeFileSync(rcPath, rc)
    const interactive = spawnSync('bash', ['--rcfile', rcPath, '-i'], {
      input: '/usage\nexit\n',
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, KIN_PANEL_RCFILE: rcPath },
    })
    assert.equal(interactive.status, 0, interactive.stderr)
    assert.match(interactive.stdout, /native:\/usage:unset/)
    assert.match(interactive.stderr, /\x1b\]133;A\x07/)
    assert.match(interactive.stderr, /\x1b\]133;C\x07/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
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

test('login tickets use the packaged native CLI and require a bound exit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-ticket-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const save = (vm) => fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  save({ id: 'vm-01', node_id: 'node-a', proxy: { id: 'px-local-node-a' } })
  save({ id: 'vm-02', proxy: { id: 'px-local' } })
  save({ id: 'vm-03' })
  const shell = createSlotShell({ projectRoot: root })
  try {
    const remote = await shell.issueTicket('vm-01', { login: true })
    const local = await shell.issueTicket('vm-02', { login: true })
    const ops = await shell.issueTicket('vm-02')
    assert.equal(remote.cli_bin, REMOTE_CRAG_CLAUDE)
    assert.equal(local.cli_bin, LOCAL_CRAG_CLAUDE)
    assert.equal(ops.cli_bin, local.cli_bin)
    assert.equal((await shell.issueTicket('vm-03', { login: true })).error.code, 'proxy_required')
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

test('panelShellLaunch rejects a non-absolute cli-node path', () => {
  assert.throws(() => panelShellLaunch('cli-node'), /invalid Claude CLI path/)
  assert.throws(() => panelShellLaunch('/tmp/a\nb'), /invalid Claude CLI path/)
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
  const ran = spawnSync('sh', ['-i'], {
    encoding: 'utf8',
    input: ':\nexit\n',
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
  assert.match(ran.stderr, /\x1b\]133;A\x07/)
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
