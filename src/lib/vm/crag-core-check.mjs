import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { vmNodeId } from '../cluster/placement.mjs'
import { rustKernelHealth } from '../transport/rust-kernel-client.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { slotExecArgv } from './slot-exec.mjs'
import { verifyCragV2Tree } from './wrap-cli-runtime.mjs'

const execute = promisify(execFile)

export const CORE_WAIT_TIMEOUT_MS = 30_000
export const CORE_WAIT_INTERVAL_MS = 3_000

// Only a slot this host can enter has inspectable processes. A cluster node
// runs its own install lifecycle and is attested by the install receipt.
export const cragCoreCheckable = (vm) => process.platform === 'linux' && !vmNodeId(vm)

export async function runningCragCoreHashes(vm, { execute: run = execute } = {}) {
  const command =
    'for p in /proc/[0-9]*/exe; do case "$(readlink "$p" 2>/dev/null)" in *memfd:crag-v2-core*) sha256sum "$p" || exit 1;; esac; done'
  // Guest root can inspect memfds across guest users. A capability-dropped Docker
  // root cannot inspect kincli's processes, so keep that container's default user.
  const argv = slotExecArgv(vm, ['sh', '-c', command], isKvmRuntime(vm) ? { user: '0' } : {})
  const { stdout } = await run('docker', argv, { timeout: 10_000, maxBuffer: 64 * 1024 })
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      if (!/^[a-f0-9]{64}\s+\/proc\/\d+\/exe$/.test(line)) throw new Error('crag_process_hash_invalid')
      return line.slice(0, 64)
    })
}

// A v2 process pool may legitimately run several cores, but every one of them
// must come from the tree that was just installed.
export const matchingCragCore = (hashes, expected) => hashes.length > 0 && hashes.every((hash) => hash === expected)

export function matchingCragTree(dir, manifest, { verify = verifyCragV2Tree } = {}) {
  try {
    return verify(dir).ok && fs.readFileSync(path.join(dir, 'manifest.json')).equals(manifest)
  } catch {
    return false
  }
}

/**
 * Classify the cores a slot is running against the tree it should have.
 *
 * Cores spawn lazily, so "no core yet" is not evidence of a stale install and
 * must not be reported as a mismatch — that is what failed a whole CRAG update
 * on a slot that had merely just restarted, where an unchanged re-run passed.
 * A core running from a *different* tree is a real fault and fails at once
 * without burning the window.
 *
 * Resolves to one of:
 *   { ok: true,  state: 'verified', sha }   a core is live from this tree
 *   { ok: true,  state: 'pending' }         none up yet; install receipt stands
 *   { ok: false, state: 'mismatch', code, hashes }
 *   { ok: false, state: 'unknown',  code }  the slot could not be inspected
 */
export async function waitForCragCore(
  vm,
  expected,
  {
    coreHashes = runningCragCoreHashes,
    execute: run,
    sleep = delay,
    now = Date.now,
    timeoutMs = CORE_WAIT_TIMEOUT_MS,
    intervalMs = CORE_WAIT_INTERVAL_MS,
  } = {},
) {
  if (!/^[a-f0-9]{64}$/.test(expected || '')) return { ok: false, state: 'unknown', code: 'crag_core_expected_invalid' }
  const deadline = now() + Math.max(0, timeoutMs)
  let probeFailed = false
  for (;;) {
    let hashes
    try {
      hashes = await coreHashes(vm, run ? { execute: run } : {})
      probeFailed = false
    } catch {
      probeFailed = true
    }
    if (hashes?.length) {
      return matchingCragCore(hashes, expected)
        ? { ok: true, state: 'verified', sha: expected }
        : { ok: false, state: 'mismatch', code: 'crag_running_core_mismatch', hashes }
    }
    if (now() + intervalMs > deadline) break
    await sleep(intervalMs)
  }
  return probeFailed ? { ok: false, state: 'unknown', code: 'crag_core_probe_failed' } : { ok: true, state: 'pending' }
}

// Trust CRAG identity only from an authenticated internal probe, the contract
// `crag-runtime-inventory.mjs` already enforces. A plain 200 proves nothing
// about which runtime answered.
export async function cragSlotHealthy(exec, { health = rustKernelHealth, timeoutMs = 3000 } = {}) {
  const observed = await health(exec, { timeoutMs, requireInternalToken: true })
  return (
    observed?.internalTokenAuthenticated === true &&
    observed.status === 200 &&
    observed.ok === true &&
    observed.healthy === true &&
    observed.runtime_variant === 'crag-v2' &&
    observed.license_valid === true
  )
}
