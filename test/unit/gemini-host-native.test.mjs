import { execFileSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('native Gemini worker response parser and Unix-socket request client', { timeout: 15_000 }, () => {
  execFileSync('python3', [path.join(root, 'test/unit/gemini-host-native-smoke.py')], {
    cwd: root,
    stdio: 'pipe',
    timeout: 12_000,
  })
})
