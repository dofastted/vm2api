import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('Gemini maintenance checks the configured pinned egress path', { skip: process.getuid?.() !== 0 }, () => {
  execFileSync('python3', ['-B', fileURLToPath(new URL('./gemini-maintenance-egress.py', import.meta.url))], {
    stdio: 'pipe',
    timeout: 12_000,
  })
})
