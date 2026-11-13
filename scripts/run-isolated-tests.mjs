/**
 * Run each Node test file in its own process.
 * `--test-isolation=process` is Node 24+; CI stays on Node 22 to match prod.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const suffix = process.argv[3] || '.test.mjs'
if (!dir) {
  console.error('usage: node scripts/run-isolated-tests.mjs <dir> [suffix] [test-name ...]')
  process.exit(2)
}

const available = readdirSync(dir).filter((name) => name.endsWith(suffix))
const selected = process.argv.slice(4).map((name) => (name.endsWith(suffix) ? name : `${name}${suffix}`))
const missing = selected.filter((name) => !available.includes(name))
if (missing.length) {
  console.error(`unknown test file(s) in ${dir}: ${missing.join(', ')}`)
  process.exit(2)
}

const files = available
  .filter((name) => !selected.length || selected.includes(name))
  .sort()
  .map((name) => path.join(dir, name))

if (!files.length) {
  console.error(`no *${suffix} files in ${dir}`)
  process.exit(2)
}

console.log(`Running ${files.length}/${available.length} isolated test files`)

let failed = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--test', file], {
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) failed += 1
}

if (failed) {
  console.error(`\n${failed}/${files.length} isolated test file(s) failed`)
  process.exit(1)
}
