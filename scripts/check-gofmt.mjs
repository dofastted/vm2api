import { execFileSync } from 'node:child_process'

// Keep this list in sync with the CI gofmt step (.github/workflows/test.yml):
// a local `npm run format:check` must catch what CI rejects.
const DIRS = ['worker', 'api-kernel', 'redact']

let files
try {
  files = execFileSync('gofmt', ['-l', ...DIRS], {
    encoding: 'utf8',
  }).trim()
} catch (error) {
  // gofmt ships with the Go toolchain; without it this check cannot pass and the
  // raw ENOENT stack is unreadable. Fail with an actionable message instead.
  if (error.code === 'ENOENT') {
    console.error('gofmt not found on PATH. Install Go (https://go.dev/dl/) or skip this check.')
    process.exit(2)
  }
  throw error
}
if (!files) process.exit(0)
console.error(`gofmt needed:\n${files}`)
process.exit(1)
