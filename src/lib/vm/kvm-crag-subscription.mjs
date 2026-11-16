import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { slotRuntimeOwner } from '../oauth/oauth-credentials.mjs'
import { readCragSubscriptionFiles, readKvmCragLicense } from './crag-license.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { slotExecArgv, slotExecContainer } from './slot-exec.mjs'
import { isDockerInspectNotFound } from './docker-container.mjs'

let script
const MAX_PENDING_PROJECTIONS = 16
const queues = new Map()
const holds = new Map()
const localKvm = (vm) => process.platform === 'linux' && !vm?.node_id && isKvmRuntime(vm)
const failure = () =>
  Object.assign(new Error('CRAG guest subscription projection failed'), {
    status: 503,
    code: 'crag_subscription_projection_failed',
  })

export function holdKvmCragSubscriptionPublications(projectRoot) {
  const root = path.resolve(projectRoot)
  holds.set(root, (holds.get(root) || 0) + 1)
  let held = true
  return () => {
    if (!held) return
    held = false
    const remaining = holds.get(root) - 1
    if (remaining) holds.set(root, remaining)
    else holds.delete(root)
  }
}

function assertPublicationAllowed(projectRoot) {
  if (holds.has(path.resolve(projectRoot))) {
    throw Object.assign(failure(), { code: 'crag_subscription_sync_pending' })
  }
}

function guestScript() {
  script ??= fs.readFileSync(new URL('../../../docker/kin-kvm/guest/kin-crag-subscription', import.meta.url), 'utf8')
  return script
}

export function kvmCragSubscriptionStatusCommand(vm, machineId) {
  return ['python3', '-c', guestScript(), '--status', machineId, vm.id]
}

function runDockerExec(args, { input, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.env.KIN_DOCKER_BIN || 'docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let error = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    const finish = (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout: output, error })
    }
    child.stdout.on('data', (value) => {
      output = (output + value).slice(-4096)
    })
    child.stderr.on('data', (value) => {
      error = (error + value).slice(-4096)
    })
    child.once('error', () => finish(null))
    child.once('close', finish)
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

async function running(vm, run) {
  const result = await run(['container', 'inspect', '--format', '{{json .State.Running}}', slotExecContainer(vm)], {
    timeoutMs: 3000,
  })
  if (result?.ok) {
    const state = String(result.stdout || '').trim()
    if (state === 'true') return true
    if (state === 'false') return false
  } else if (result?.code === 1 && isDockerInspectNotFound({ ...result, stderr: result.stderr || result.error }))
    return false
  throw failure()
}

function exclusive(projectRoot, vm, work) {
  const key = `${path.resolve(projectRoot)}:${vm.id}`
  const queue = queues.get(key) || { pending: 0, tail: Promise.resolve() }
  if (queue.pending >= MAX_PENDING_PROJECTIONS) {
    return Promise.reject(
      Object.assign(new Error('CRAG guest license projection is busy'), {
        status: 503,
        code: 'crag_subscription_projection_busy',
      }),
    )
  }
  queue.pending++
  const next = queue.tail.catch(() => {}).then(work)
  queue.tail = next
  queues.set(key, queue)
  return next.finally(() => {
    queue.pending--
    if (queue.pending === 0) queues.delete(key)
  })
}

async function project(vm, action, files, run) {
  const { uid, gid } = slotRuntimeOwner(vm)
  const request = {
    action,
    vm_id: vm.id,
    machine_id: vm.fingerprint?.guest_machine_id,
    uid,
    gid,
    ...(['publish', 'publish-universal'].includes(action) && { wait_for_setup: true }),
    ...(files && { files }),
  }
  const result = await run(slotExecArgv(vm, ['python3', '-c', guestScript()], { user: '0', interactive: true }), {
    timeoutMs: 30_000,
    input: JSON.stringify(request),
  })
  if (!result?.ok) {
    const error = failure()
    const details = `${result?.error || ''}\n${result?.stderr || ''}`
    error.retryable =
      details.includes('guest ssh unavailable') ||
      (['publish', 'publish-universal'].includes(action) &&
        result?.code === 75 &&
        details.split('\n').some((line) => line.trim() === 'CRAG guest setup is not ready'))
    throw error
  }
  return true
}

function publishLocal(projectRoot, vm, run, subscriptionOnly) {
  if (!localKvm(vm)) return Promise.resolve(false)
  return exclusive(projectRoot, vm, async () => {
    if (subscriptionOnly) assertPublicationAllowed(projectRoot)
    if (!(await running(vm, run))) return false
    const readFiles = subscriptionOnly ? readCragSubscriptionFiles : readKvmCragLicense
    let files
    try {
      files = readFiles(projectRoot, vm)
      if (!files) return false
      const universal = Object.keys(files).length === 1 && files.permit?.startsWith('CRAGU1.')
      if (!universal) assertPublicationAllowed(projectRoot)
      await project(vm, universal ? 'publish-universal' : 'publish', files, run)
      if (!universal) assertPublicationAllowed(projectRoot)
      const current = readFiles(projectRoot, vm)
      if (JSON.stringify(current) !== JSON.stringify(files)) throw failure()
      return true
    } catch (error) {
      if (!error.retryable) {
        try {
          await project(vm, 'block', null, run)
        } catch {}
      }
      throw error
    }
  })
}

/** Guest grants live on tmpfs: the official native bootstrap rejects 9p license directories. */
export function publishKvmCragSubscription(projectRoot, vm, { runDockerExec: run = runDockerExec } = {}) {
  return publishLocal(projectRoot, vm, run, true)
}

/** Offline U1 and host S1 share managed mounts; only S1 depends on host mutation gates. */
export function publishLocalKvmCragLicense(projectRoot, vm, { runDockerExec: run = runDockerExec } = {}) {
  return publishLocal(projectRoot, vm, run, false)
}

/** Shares the publisher queue, so an older publish cannot clear a later revocation marker. */
export function blockKvmCragSubscription(projectRoot, vm, { runDockerExec: run = runDockerExec } = {}) {
  if (!localKvm(vm)) return Promise.resolve(false)
  return exclusive(projectRoot, vm, async () => (await running(vm, run)) && project(vm, 'block', null, run))
}

/** Only an authorized kernel switch calls this; an absent permit never clears a revocation marker. */
export function clearKvmCragSubscription(projectRoot, vm, { runDockerExec: run = runDockerExec } = {}) {
  if (!localKvm(vm)) return Promise.resolve(false)
  return exclusive(projectRoot, vm, async () => (await running(vm, run)) && project(vm, 'clear', null, run))
}
