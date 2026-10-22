import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GUARD_SCRIPT, createCliNodeGuard, isCliNodeGuardTarget } from '../../src/lib/vm/cli-node-guard.mjs'

// Real processes stand in for slot CLIs; a fake proc root carries their
// cmdline/environ so the guard's own shell policy decides who gets SIGKILL.
function slotFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-node-guard-'))
  const children = []
  t.after(() => {
    for (const child of children) child.kill('SIGKILL')
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    add(args, env) {
      const child = spawn('sleep', ['30'], { stdio: 'ignore' })
      children.push(child)
      const dir = path.join(root, String(child.pid))
      fs.mkdirSync(dir)
      fs.writeFileSync(path.join(dir, 'cmdline'), ['/home/kincli/.kin/cli-node', ...args, ''].join('\0'))
      if (env) fs.writeFileSync(path.join(dir, 'environ'), [...env, ''].join('\0'))
      return child
    },
    run(liveTokens = []) {
      const r = spawnSync('/bin/sh', ['-c', GUARD_SCRIPT, 'guard', ...liveTokens], {
        env: { ...process.env, KIN_GUARD_PROC: root },
        encoding: 'utf8',
      })
      assert.equal(r.status, 0, r.stderr)
    },
  }
}

const alive = (child) => {
  try {
    process.kill(child.pid, 0)
    return true
  } catch {
    return false
  }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 100))
}

test('keeps the kernel CLI, init bootstrap, setup-token and live panel CLIs including -p', async (t) => {
  const slot = slotFixture(t)
  const kernel = slot.add(['-p', '--output-format', 'stream-json'], ['CLAUDE_CODE_NATIVE_SLOTS=20'])
  const duplicate = slot.add(['-p', '--output-format', 'stream-json'], ['CLAUDE_CODE_NATIVE_SLOTS=20'])
  const hello = slot.add(['-p', 'hello', '--permission-mode', 'bypassPermissions'], ['KIN_OFFICIAL_CC=1'])
  const usage = slot.add(['/usage', '--print'], ['KIN_OFFICIAL_CC=1'])
  const setupToken = slot.add(['setup-token'], ['KIN_SETUP_TOKEN=1'])
  const authLogin = slot.add(['auth', 'login'], ['KIN_AUTH_LOGIN=1'])
  const panelPrint = slot.add(['-p', 'hello'], ['KIN_PANEL_SHELL=live'])
  const panelInteractive = slot.add([], ['KIN_PANEL_SHELL=live'])
  slot.run(['live'])
  await settle()
  assert.equal(alive(kernel), true)
  assert.equal(alive(duplicate), false)
  for (const child of [hello, usage, setupToken, authLogin, panelPrint, panelInteractive])
    assert.equal(alive(child), true)
})

test('kills leaked CLIs from closed panel shells and unmarked -p runs', async (t) => {
  const slot = slotFixture(t)
  const kernel = slot.add(['-p'], ['CLAUDE_CODE_NATIVE_SLOTS=20'])
  const closedPanel = slot.add(['-p', 'hello'], ['KIN_PANEL_SHELL=gone'])
  const stray = slot.add(['-p', 'hello'], ['HOME=/home/kincli'])
  slot.run([])
  await settle()
  assert.equal(alive(kernel), true)
  assert.equal(alive(closedPanel), false)
  assert.equal(alive(stray), false)
})

test('shared guard retains a panel CLI whose remote owner cannot be disproved', async (t) => {
  const slot = slotFixture(t)
  const panel = slot.add(['-p', 'hello'], ['KIN_PANEL_SHELL=other-controller'])
  slot.run(['--preserve-panel'])
  await settle()
  assert.equal(alive(panel), true)
})

test('keeps a not-yet-synced kernel CLI that still has the prefixed slots env', async (t) => {
  const slot = slotFixture(t)
  const kernel = slot.add(['-p'], ['CLAUDE_CODE_KIN_NATIVE_SLOTS=20'])
  const stray = slot.add(['-p', 'hello'], ['HOME=/home/kincli'])
  slot.run([])
  await settle()
  assert.equal(alive(kernel), true)
  assert.equal(alive(stray), false)
})

test('prefers the unprefixed kernel CLI over a leftover prefixed one', async (t) => {
  const slot = slotFixture(t)
  const oldKernel = slot.add(['-p'], ['CLAUDE_CODE_KIN_NATIVE_SLOTS=20'])
  const newKernel = slot.add(['-p'], ['CLAUDE_CODE_NATIVE_SLOTS=20'])
  slot.run([])
  await settle()
  assert.equal(alive(oldKernel), false)
  assert.equal(alive(newKernel), true)
})

test('leaves a CLI alone when its environ cannot be read', async (t) => {
  const slot = slotFixture(t)
  const unknown = slot.add(['-p', 'hello'], null)
  slot.run([])
  await settle()
  assert.equal(alive(unknown), true)
})

test('skips stopped / dead slots instead of exec-ing into a missing container', async () => {
  assert.equal(isCliNodeGuardTarget({ id: 'vm-01', status: 'stopped' }), false)
  assert.equal(isCliNodeGuardTarget({ id: 'vm-01', status: 'dead' }), false)
  assert.equal(isCliNodeGuardTarget({ id: 'vm-01', status: 'running' }), true)
  assert.equal(isCliNodeGuardTarget({ id: 'vm-01', status: 'paused' }), true)
  const warned = []
  const execed = []
  const guard = createCliNodeGuard({
    listTargets: () => [{ id: 'vm-01', status: 'stopped' }],
    exec: async (...args) => execed.push(args),
    logger: { warn: (m) => warned.push(m) },
  })
  await guard.tick()
  assert.deepEqual(execed, [])
  assert.deepEqual(warned, [])
})
