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

// Driven from here because nothing else runs it: CI's only Python discovery is
// `test/deploy -p test_native_cli.py`, and test:ci's standing set is 12 keywords
// that do not include this area. Without a driver the resident-eligibility cases
// pass on a developer's machine and never run again.
test('resident pre-warming skips accounts blocked by eligibility', { timeout: 15_000 }, () => {
  execFileSync('python3', ['-B', path.join(root, 'test/unit/gemini-host-resident.py')], {
    cwd: root,
    stdio: 'pipe',
    timeout: 12_000,
  })
})
