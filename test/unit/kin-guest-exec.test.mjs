import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const SOURCE = path.resolve(import.meta.dirname, '../../docker/kin-kvm/kin-guest-exec')

function prepareHarness({ sshExit = 0, timeoutExit = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-guest-exec-'))
  const bin = path.join(root, 'bin')
  const key = path.join(root, 'id_ed25519')
  const timeoutLog = path.join(root, 'timeout.log')
  const sshLog = path.join(root, 'ssh.log')
  const remoteLog = path.join(root, 'remote.log')
  fs.mkdirSync(bin)
  fs.writeFileSync(key, 'fake-key\n', { mode: 0o600 })
  const timeoutFail =
    timeoutExit != null
      ? `exit ${timeoutExit}`
      : `shift
exec "$@"`
  fs.writeFileSync(
    path.join(bin, 'timeout'),
    `#!/bin/sh
echo "timeout $*" >> ${timeoutLog.replace(/'/g, `'\\''`)}
${timeoutFail}
`,
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(bin, 'ssh'),
    `#!/bin/sh
echo "ssh $*" >> ${sshLog.replace(/'/g, `'\\''`)}
remote=$1
shift
while [ $# -gt 0 ]; do
  case "$1" in
    root@127.0.0.1) shift; remote=$1; break ;;
    *) shift ;;
  esac
done
printf '%s' "$remote" > ${remoteLog.replace(/'/g, `'\\''`)}
exit ${sshExit}
`,
    { mode: 0o755 },
  )
  let script = fs.readFileSync(SOURCE, 'utf8')
  script = script.replace('KEY=/slot/kvm/id_ed25519', `KEY=${key}`)
  const execPath = path.join(root, 'kin-guest-exec')
  fs.writeFileSync(execPath, script, { mode: 0o755 })
  return { root, bin, execPath, timeoutLog, sshLog, remoteLog }
}

function runHarness(h, args, { env = {} } = {}) {
  for (const f of [h.timeoutLog, h.sshLog, h.remoteLog]) {
    try {
      fs.unlinkSync(f)
    } catch {
      /* absent */
    }
  }
  return spawnSync(h.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${h.bin}:${process.env.PATH}`, ...env },
  })
}

function remoteScript(h) {
  return fs.existsSync(h.remoteLog) ? fs.readFileSync(h.remoteLog, 'utf8') : ''
}

test('interactive foreground ssh is not wrapped in timeout', () => {
  const h = prepareHarness()
  const ran = runHarness(h, ['-i', '-t', '-u', '1000:1000', '--', '/bin/true'])
  assert.equal(ran.status, 0, ran.stderr)
  assert.equal(fs.existsSync(h.timeoutLog), false)
  assert.match(fs.readFileSync(h.sshLog, 'utf8'), /ssh /)
  fs.rmSync(h.root, { recursive: true, force: true })
})

test('non-interactive path still uses timeout 8', () => {
  const h = prepareHarness()
  const ran = runHarness(h, ['-u', '1000:1000', '--', '/bin/true'])
  assert.equal(ran.status, 0, ran.stderr)
  assert.match(fs.readFileSync(h.timeoutLog, 'utf8'), /^timeout 8 ssh /m)
  fs.rmSync(h.root, { recursive: true, force: true })
})

test('detach path still uses timeout 8', () => {
  const h = prepareHarness()
  const ran = runHarness(h, ['-d', '-u', '0', '--', '/bin/sh', '-c', 'true'])
  assert.equal(ran.status, 0, ran.stderr)
  assert.match(fs.readFileSync(h.timeoutLog, 'utf8'), /^timeout 8 ssh /m)
  fs.rmSync(h.root, { recursive: true, force: true })
})

test('-e preserves embedded newlines in remote export script', () => {
  const h = prepareHarness()
  const val = 'line1\nline2'
  const ran = runHarness(h, ['-e', `PROBE=${val}`, '-u', '1000:1000', '--', '/bin/sh', '-c', 'true'])
  assert.equal(ran.status, 0, ran.stderr)
  const remote = remoteScript(h)
  assert.equal((remote.match(/export PROBE=/g) || []).length, 1)
  assert.ok(remote.includes('line1') && remote.includes('line2'))
  assert.doesNotMatch(remote, /export line2/)
  fs.rmSync(h.root, { recursive: true, force: true })
})

test('multiline KIN_PANEL_RC-style env survives quoting', () => {
  const h = prepareHarness()
  const rc = 'if true; then\necho ok\nfi'
  const ran = runHarness(h, ['-e', `KIN_PANEL_RC=${rc}`, '-i', '-t', '--', '/bin/sh', '-c', 'true'])
  assert.equal(ran.status, 0, ran.stderr)
  const remote = remoteScript(h)
  assert.equal((remote.match(/export KIN_PANEL_RC=/g) || []).length, 1)
  assert.ok(remote.includes('if true; then') && remote.includes('echo ok'))
  fs.rmSync(h.root, { recursive: true, force: true })
})

test('kin-guest-exec applies wall-clock timeout only for detach and non-interactive', () => {
  const src = fs.readFileSync(SOURCE, 'utf8')
  assert.doesNotMatch(src, /if ! timeout 8 ssh "\$@" root@127\.0\.0\.1 "\$remote"/)
  assert.match(src, /if \[ "\$detach" -eq 1 \] \|\| \[ "\$interactive" -eq 0 \]; then/)
  assert.match(src, /else\s*\n\s*ssh "\$@" root@127\.0\.0\.1 "\$remote"/)
})

test('non-zero guest command exit is propagated (not masked as 0)', () => {
  const h = prepareHarness({ sshExit: 37 })
  const ran = runHarness(h, ['-u', '1000:1000', '--', '/bin/false'])
  assert.equal(ran.status, 37, ran.stderr)
  fs.rmSync(h.root, { recursive: true, force: true })
})

test('ssh failure 255 maps to exit 1 with guest ssh unavailable', () => {
  const h = prepareHarness({ sshExit: 255 })
  const ran = runHarness(h, ['-u', '1000:1000', '--', '/bin/true'])
  assert.equal(ran.status, 1, ran.stderr)
  assert.match(ran.stderr, /guest ssh unavailable/)
  fs.rmSync(h.root, { recursive: true, force: true })
})

test('timeout 124 maps to exit 1 with guest ssh unavailable', () => {
  const h = prepareHarness({ timeoutExit: 124 })
  const ran = runHarness(h, ['-u', '1000:1000', '--', '/bin/true'])
  assert.equal(ran.status, 1, ran.stderr)
  assert.match(ran.stderr, /guest ssh unavailable/)
  fs.rmSync(h.root, { recursive: true, force: true })
})

test('source does not use if ! run_ssh for exit capture', () => {
  const src = fs.readFileSync(SOURCE, 'utf8')
  assert.doesNotMatch(src, /if ! run_ssh/)
  assert.match(src, /if run_ssh "\$@"; then/)
})
