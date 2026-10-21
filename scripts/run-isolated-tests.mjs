/**
 * Run each Node test file in its own process.
 * `--test-isolation=process` is Node 24+; CI stays on Node 22 to match prod.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const suffix = process.argv[3] || '.test.mjs'
if (!dir) {
  console.error('usage: node scripts/run-isolated-tests.mjs <dir> [suffix]')
  process.exit(2)
}

const files = readdirSync(dir)
  .filter((name) => name.endsWith(suffix))
  .sort()
  .map((name) => path.join(dir, name))

if (!files.length) {
  console.error(`no *${suffix} files in ${dir}`)
  process.exit(2)
}

let failed = 0
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const offline = /(?:sqlite-legacy|db-migration-sub2api)\.test\.mjs$/.test(file)
  const database =
    !offline &&
    /db\/|database\.mjs|api-keys\.mjs|panel-users\.mjs|account-quota\.mjs|sticky-router\.mjs|proxy-pool\.mjs|request-log\.mjs|api-endpoints\.mjs|thinking-owner\.mjs|harness\.mjs/.test(
      source,
    )
  const args = database ? ['--import', './test/pg-setup.mjs', '--test', file] : ['--test', file]
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    timeout: 90_000,
    env: process.env,
  })
  if (result.status !== 0) {
    failed += 1
    if (result.error?.code === 'ETIMEDOUT') console.error(`test file timed out: ${file}`)
  }
}

if (failed) {
  console.error(`\n${failed}/${files.length} isolated test file(s) failed`)
  process.exit(1)
}
