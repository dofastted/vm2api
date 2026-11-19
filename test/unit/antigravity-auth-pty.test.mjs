import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const driver = fileURLToPath(new URL('../../scripts/antigravity-auth-login-pty.py', import.meta.url))
const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=pty-test-state&code_challenge=pty-test-pkce'
const privateCode = '4/private-pty-test-authorization-code'
const privateToken = 'ya29.private-pty-test-provider-token'

const fakeCli = [
  'import json, os, pathlib, sys, time, tty',
  'root = pathlib.Path(os.environ["PTY_TEST_ROOT"])',
  '(root / "cli.pid").write_text(str(os.getpid()))',
  '(root / "terminal.json").write_text(json.dumps({"stdin": sys.stdin.isatty(), "stdout": sys.stdout.isatty()}))',
  'assert sys.stdin.isatty() and sys.stdout.isatty(), "official login requires a terminal"',
  'tty.setraw(sys.stdin.fileno())',
  'mode = os.environ["PTY_TEST_CLI_MODE"]',
  'if mode == "banner-only":',
  '    print("Welcome! Authentication successful! " + os.environ["PTY_TEST_TOKEN"], flush=True)',
  '    time.sleep(0.3)',
  '    sys.exit(0)',
  'print("Select login method", flush=True)',
  'selection = os.read(sys.stdin.fileno(), 1)',
  '(root / "selection.bin").write_bytes(selection)',
  'assert selection == bytes([13]), "driver must select the remote login method with Enter"',
  'url = os.environ["PTY_TEST_AUTH_URL"]',
  'sys.stdout.write(chr(27) + "]8;;" + url + chr(7) + "Open authorization page" + chr(27) + "]8;;" + chr(7))',
  'sys.stdout.flush()',
  'if mode == "waiting":',
  '    while True:',
  '        os.read(sys.stdin.fileno(), 1)',
  'received = b""',
  'while not received.endswith(bytes([13])):',
  '    part = os.read(sys.stdin.fileno(), 1)',
  '    if not part:',
  '        sys.exit(2)',
  '    received += part',
  '(root / "paste.bin").write_bytes(received)',
  'expected = bytes([27]) + b"[200~" + os.environ["PTY_TEST_CODE"].encode() + bytes([27]) + b"[201~" + bytes([13])',
  'assert received == expected, "authorization code must use bracketed paste"',
  'print("Welcome! Authentication successful! code=" + os.environ["PTY_TEST_CODE"] + " token=" + os.environ["PTY_TEST_TOKEN"], flush=True)',
  'if mode == "success":',
  '    (root / "authenticated.marker").write_text("ready")',
  '    while True:',
  '        time.sleep(10)',
  'time.sleep(0.3)',
  'sys.exit(0)',
].join('\n')

const fakeVerifier = [
  'import json, os, pathlib, sys, time',
  'root = pathlib.Path(os.environ["PTY_TEST_ROOT"])',
  '(root / "verifier.pid").write_text(str(os.getpid()))',
  'ready = (root / "authenticated.marker").exists()',
  'with (root / "probes.jsonl").open("a") as log:',
  '    log.write(json.dumps({"ready": ready, "pid": os.getpid()}) + chr(10))',
  'mode = os.environ["PTY_TEST_VERIFY_MODE"]',
  'if mode == "linger":',
  '    time.sleep(30)',
  'if mode == "reject":',
  '    print("MODEL ID: gemini-pro")',
  '    sys.exit(1)',
  'if mode == "empty":',
  '    print("   ")',
  '    sys.exit(0)',
  'if ready:',
  '    print("MODEL ID")',
  '    print("gemini-pro")',
  '    sys.exit(0)',
  'sys.exit(1)',
].join('\n')

async function until(predicate, description, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = predicate()
    if (result) return result
    await delay(10)
  }
  assert.fail('Timed out waiting for ' + description)
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

function fixture(t, { cliMode = 'success', verifyMode = 'marker' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-real-pty-'))
  const cli = path.join(root, 'official-cli.py')
  const verifier = path.join(root, 'official-models.py')
  fs.writeFileSync(cli, fakeCli)
  fs.writeFileSync(verifier, fakeVerifier)
  const child = spawn('python3', [driver], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      KIN_ANTIGRAVITY_EXEC_ARGV: JSON.stringify(['python3', cli]),
      KIN_ANTIGRAVITY_VERIFY_ARGV: JSON.stringify(['python3', verifier]),
      PTY_TEST_ROOT: root,
      PTY_TEST_CLI_MODE: cliMode,
      PTY_TEST_VERIFY_MODE: verifyMode,
      PTY_TEST_AUTH_URL: authUrl,
      PTY_TEST_CODE: privateCode,
      PTY_TEST_TOKEN: privateToken,
    },
  })
  const events = []
  const invalidLines = []
  let stdout = ''
  let stderr = ''
  let buffered = ''
  let exit = null
  let spawnError = null
  child.stdin.on('error', () => undefined)
  child.on('error', (error) => {
    spawnError = error
  })
  child.on('close', (code, signal) => {
    exit = { code, signal }
  })
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    buffered += chunk
    while (buffered.includes('\n')) {
      const end = buffered.indexOf('\n')
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        invalidLines.push(line)
      }
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  function command(value) {
    assert.equal(exit, null, 'driver exited before accepting a command')
    child.stdin.write(JSON.stringify(value) + '\n')
  }
  async function waitFor(status) {
    return until(() => {
      if (spawnError) throw spawnError
      const event = events.find((item) => item.status === status)
      if (event) return event
      assert.equal(exit, null, 'driver exited before ' + status + ': ' + stdout + stderr)
      return false
    }, 'OAuth status ' + status)
  }
  async function waitForExit() {
    const result = await until(() => {
      if (spawnError) throw spawnError
      return exit
    }, 'PTY driver exit')
    assert.deepEqual(result, { code: 0, signal: null })
    assert.deepEqual(invalidLines, [], 'driver stdout must contain only JSON protocol events')
    assert.equal(buffered.trim(), '')
    assert.equal(stderr, '')
    assert.equal(stdout.includes(privateCode), false, 'authorization codes must not leave the PTY')
    assert.equal(stdout.includes(privateToken), false, 'provider tokens must not leave the PTY')
    return result
  }
  function pid(name) {
    const file = path.join(root, name + '.pid')
    return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : null
  }
  t.after(async () => {
    if (!exit && !spawnError) {
      command({ cancel: true })
      try {
        await until(() => exit, 'driver cleanup', 2500)
      } catch {
        child.kill('SIGKILL')
      }
    }
    for (const name of ['cli', 'verifier']) {
      const processId = pid(name)
      if (processId && alive(processId)) process.kill(processId, 'SIGKILL')
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, events, command, waitFor, waitForExit, pid }
}

const requiresPty = { skip: process.platform === 'win32', timeout: 10000 }

test(
  'real PTY drives menu, OSC8 URL and bracketed code, then verifies the official model catalog',
  requiresPty,
  async (t) => {
    const f = fixture(t)
    assert.equal((await f.waitFor('awaiting_code')).auth_url, authUrl)
    await until(() => fs.existsSync(path.join(f.root, 'probes.jsonl')), 'initial unauthenticated model check')
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'terminal.json'), 'utf8')), {
      stdin: true,
      stdout: true,
    })
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'selection.bin')), Buffer.from('\r'))
    f.command({ code: privateCode })
    await f.waitFor('authenticated')
    await f.waitForExit()
    assert.deepEqual(
      f.events.map((event) => event.status),
      ['awaiting_code', 'verifying', 'authenticated'],
    )
    assert.deepEqual(f.events.at(-1), { status: 'authenticated', authenticated: true })
    assert.deepEqual(
      fs.readFileSync(path.join(f.root, 'paste.bin')),
      Buffer.from('\x1b[200~' + privateCode + '\x1b[201~\r'),
    )
    const probes = fs.readFileSync(path.join(f.root, 'probes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(
      probes.some((probe) => probe.ready === false),
      'catalog initially requires login',
    )
    assert.ok(
      probes.some((probe) => probe.ready === true),
      'success follows a fresh catalog verification',
    )
    assert.equal(alive(f.pid('cli')), false, 'successful login also cleans up its interactive CLI')
  },
)

for (const verifyMode of ['reject', 'empty']) {
  test(
    'success banners and exit 0 do not authenticate when the model verifier is ' + verifyMode,
    requiresPty,
    async (t) => {
      const f = fixture(t, { cliMode: 'fake-success', verifyMode })
      await f.waitFor('awaiting_code')
      f.command({ code: privateCode })
      await f.waitForExit()
      assert.deepEqual(
        f.events.map((event) => event.status),
        ['awaiting_code', 'verifying', 'failed'],
      )
      assert.equal(
        f.events.some((event) => event.authenticated === true),
        false,
      )
      assert.equal(fs.existsSync(path.join(f.root, 'authenticated.marker')), false)
    },
  )
}

test(
  'an already-authenticated-looking welcome and clean CLI exit cannot bypass independent verification',
  requiresPty,
  async (t) => {
    const f = fixture(t, { cliMode: 'banner-only', verifyMode: 'reject' })
    await f.waitForExit()
    assert.deepEqual(
      f.events.map((event) => event.status),
      ['failed'],
    )
    assert.equal(
      f.events.some((event) => event.authenticated === true),
      false,
    )
  },
)

test('cancel terminates the real PTY child and any in-flight model verifier', requiresPty, async (t) => {
  const f = fixture(t, { cliMode: 'waiting', verifyMode: 'linger' })
  await f.waitFor('awaiting_code')
  await until(() => f.pid('verifier'), 'running model verifier')
  const cliPid = f.pid('cli')
  const verifierPid = f.pid('verifier')
  assert.equal(alive(cliPid), true)
  assert.equal(alive(verifierPid), true)
  f.command({ cancel: true })
  await f.waitForExit()
  assert.deepEqual(
    f.events.map((event) => event.status),
    ['awaiting_code'],
  )
  assert.equal(alive(cliPid), false)
  assert.equal(alive(verifierPid), false)
})
