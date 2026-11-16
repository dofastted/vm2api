/**
 * Run each Node test file in its own process.
 * `--test-isolation=process` is Node 24+; CI stays on Node 22 to match prod.
 *
 * Each file runs in its own process group with a wall-clock and resident-memory
 * budget, and is SIGKILLed when it exceeds either. A file stuck in native code
 * never runs node:test's SIGTERM handler, so a plain `timeout` cannot stop it,
 * and a runaway allocation can exhaust host memory within minutes.
 *   VM2API_TEST_FILE_TIMEOUT_MS  default 300000
 *   VM2API_TEST_FILE_MAX_RSS_MB  default 4096 (Linux only; 0 disables)
 */
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
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

const timeoutMs = positiveInt(process.env.VM2API_TEST_FILE_TIMEOUT_MS, 300_000)
const maxRssMb = positiveInt(process.env.VM2API_TEST_FILE_MAX_RSS_MB, 4096)
const pollMs = 500

function positiveInt(raw, fallback) {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

// Resident memory of every process in the group, in MiB; null where /proc is unavailable.
function groupRssMb(pgid) {
  let pids
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name))
  } catch {
    return null
  }
  let kb = 0
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) !== pgid) continue
      const match = /^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
      if (match) kb += Number(match[1])
    } catch {}
  }
  return kb / 1024
}

let current = null
function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {}
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (current) killGroup(current)
    process.exit(130)
  })
}

function runFile(file) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, ['--test', file], { stdio: 'inherit', env: process.env, detached: true })
    current = child
    let reason = null
    const stop = (why) => {
      if (reason) return
      reason = why
      killGroup(child)
    }
    const timer = setInterval(() => {
      if (timeoutMs && Date.now() - started > timeoutMs) return stop(`exceeded ${timeoutMs}ms`)
      const rss = maxRssMb ? groupRssMb(child.pid) : null
      if (rss !== null && rss > maxRssMb) stop(`resident memory ${Math.round(rss)}MB exceeded ${maxRssMb}MB`)
    }, pollMs)
    child.on('exit', (code) => {
      clearInterval(timer)
      current = null
      if (reason) console.error(`\n✖ ${file} killed: ${reason}`)
      resolve(!reason && code === 0)
    })
  })
}

const failures = []
for (const file of files) {
  if (!(await runFile(file))) failures.push(file)
}

if (failures.length) {
  // Every file above prints its own output, so the per-file stdio is far more than
  // one CI screen. List the failing files at the end to make the log actionable.
  console.error(`\n${failures.length}/${files.length} isolated test file(s) failed:`)
  for (const file of failures) console.error(`  - ${file}`)
  process.exit(1)
}
