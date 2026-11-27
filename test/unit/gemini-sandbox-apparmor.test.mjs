import { execFileSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('Gemini AppArmor profile preparation, inline unit attachment, and maintenance diagnostics', {
  timeout: 25_000,
}, () => {
  execFileSync('python3', ['-B', path.join(root, 'test/deploy/test_gemini_apparmor.py')], {
    cwd: root,
    stdio: 'pipe',
    timeout: 20_000,
  })
})

test('Gemini host sandbox probe, TTL cache, and OAuth early-exit classification', { timeout: 25_000 }, () => {
  execFileSync('python3', ['-B', path.join(root, 'test/unit/gemini-sandbox-apparmor.py')], {
    cwd: root,
    stdio: 'pipe',
    timeout: 20_000,
  })
})

test('Gemini maintenance runtime files, daemon -I import, and apparmor helper unit tests', {
  timeout: 45_000,
}, () => {
  for (const relative of [
    'test/unit/gemini-maintenance-runtime-files.py',
    'test/unit/gemini-maintenance-daemon-import.py',
    'test/unit/test_gemini_host_apparmor.py',
  ]) {
    execFileSync('python3', ['-B', path.join(root, relative)], {
      cwd: root,
      stdio: 'pipe',
      timeout: 30_000,
    })
  }
})
