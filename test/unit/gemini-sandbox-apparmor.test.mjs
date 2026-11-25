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
