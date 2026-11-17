import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { readKvmCragLicense } from './crag-license.mjs'
import { slotExecArgv } from './slot-exec.mjs'
import { slotHost } from './slot-host.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { publishLocalKvmCragLicense } from './kvm-crag-subscription.mjs'

let guestScript
const published = new Map()
const publishing = new Map()

function callbackRunner(vm, run) {
  return (argv, { input, timeoutMs = 4000 } = {}) =>
    new Promise((resolve) => {
      let inputError
      const child = run(
        process.env.KIN_DOCKER_BIN || 'docker',
        argv,
        { env: slotHost(vm).dockerEnv(), timeout: timeoutMs, maxBuffer: 4096 },
        (error, stdout = '', stderr = '') =>
          resolve({
            ok: !error && !inputError,
            code: error ? (typeof error.code === 'number' ? error.code : null) : inputError ? null : 0,
            stdout,
            stderr,
          }),
      )
      child.stdin?.on('error', (error) => {
        inputError = error
      })
      child.stdin?.end(input)
    })
}

export async function publishKvmCragLicense(projectRoot, vm, { force = false, run = execFile, runDockerExec } = {}) {
  if (!vm?.node_id && isKvmRuntime(vm)) {
    return publishLocalKvmCragLicense(projectRoot, vm, {
      ...(runDockerExec ? { runDockerExec } : run !== execFile ? { runDockerExec: callbackRunner(vm, run) } : {}),
    })
  }
  const files = readKvmCragLicense(projectRoot, vm)
  if (!files) return false
  const input = JSON.stringify(files)
  const digest = createHash('sha256').update(input).digest('hex')
  const key = JSON.stringify([projectRoot, vm.node_id, vm.id, vm.runtime?.container_id, vm.runtime?.started_at])
  const active = publishing.get(key)
  if (active) {
    if (active.digest !== digest) throw new Error('crag_guest_license_changed')
    return active.work
  }
  if (!force && published.get(key) === digest) return true
  published.delete(key)
  guestScript ??= fs.readFileSync(new URL('../../../docker/kin-kvm/guest/kin-crag-license', import.meta.url), 'utf8')
  const argv = slotExecArgv(vm, ['python3', '-c', guestScript], { user: '0', interactive: true })
  const work = (
    runDockerExec
      ? runDockerExec(argv, { input, timeoutMs: 4000 }).then((result) => {
          if (!result?.ok) {
            const error = new Error('crag_guest_license_sync_failed')
            error.retryable = `${result?.error || ''}\n${result?.stderr || ''}`.includes('guest ssh unavailable')
            throw error
          }
        })
      : new Promise((resolve, reject) => {
          let inputError
          const child = run(
            process.env.KIN_DOCKER_BIN || 'docker',
            argv,
            { env: slotHost(vm).dockerEnv(), timeout: 4000, maxBuffer: 4096 },
            (error) => (error || inputError ? reject(new Error('crag_guest_license_sync_failed')) : resolve()),
          )
          child.stdin.on('error', (error) => {
            inputError = error
          })
          child.stdin.end(input)
        })
  ).then(() => {
    published.set(key, digest)
    if (published.size > 1024) published.delete(published.keys().next().value)
    return true
  })
  publishing.set(key, { digest, work })
  try {
    return await work
  } finally {
    publishing.delete(key)
  }
}
