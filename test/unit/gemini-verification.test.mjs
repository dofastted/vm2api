import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('Gemini verification links remain available without changing paid-tier eligibility', () => {
  execFileSync('python3', ['-B', fileURLToPath(new URL('./gemini-verification.py', import.meta.url))], {
    stdio: 'pipe',
    timeout: 12_000,
  })
})
