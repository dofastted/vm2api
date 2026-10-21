import { spawn } from 'node:child_process'
import path from 'node:path'
import { slotHost } from '../vm/slot-host.mjs'
import { slotExecArgv } from '../vm/slot-exec.mjs'
import { getDb, getActivityCoordinator } from '../db/database.mjs'
import { isKubernetesMode } from '../core/control-plane-mode.mjs'
import { getSharedBackgroundTasks } from '../core/shared-background-tasks.mjs'
import { SharedVmOperations } from '../vm/shared-vm-operations.mjs'
import { flushVmDbSync } from '../vm/vm-db-sync.mjs'
import { readWorkerCredentialFile } from '../oauth/oauth-credentials.mjs'
import {
  credentialGeneration,
  currentRefreshAdmission,
  getSharedCredentialRefresh,
} from '../oauth/shared-credential-refresh.mjs'

const WORKER_CONFIG = '/run/kin/worker.json'
const WORKER_BIN = '/usr/local/bin/kin-worker'
const OPS = new Set(['refresh', 'usage', 'profile', 'models', 'count-tokens', 'reset-status', 'reset-redeem'])

function failure(code, message = undefined) {
  const error = { code }
  if (message !== undefined) error.message = message
  return {
    ok: false,
    status: 0,
    body: { error },
    headers: {},
    via: 'slot-worker',
    transportError: true,
    attemptFinished: false,
  }
}

function runDockerProcess(argv, { stdin = '', timeoutMs = 45000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.env.KIN_DOCKER_BIN || 'docker', argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(env ? { env } : {}),
    })
    const stdout = []
    const stderr = []
    let settled = false
    let timer = null

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.on('data', (chunk) => stdout.push(chunk))
    child.stderr?.on('data', (chunk) => stderr.push(chunk))
    child.once('error', (error) => {
      finish({
        code: null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: String(error?.message || error).slice(0, 300),
        timed_out: false,
      })
    })
    child.once('close', (code) => {
      finish({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timed_out: false,
      })
    })

    const waitMs = Math.max(1, Number(timeoutMs) || 45000)
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      finish({
        code: null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timed_out: true,
      })
    }, waitMs)
    timer.unref?.()

    child.stdin?.end(stdin)
  })
}

function lastJsonLine(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) return null
  try {
    return JSON.parse(lines.at(-1))
  } catch {
    return null
  }
}

export function runSlotOauth(exec, op, options = {}) {
  if (!isKubernetesMode() || process.env.KIN_CRS_MOCK === '1') return runSlotOauthRaw(exec, op, options)
  const db = options.db || getDb()
  return getSharedBackgroundTasks(db).track(runSharedSlotOauth(db, exec, op, options))
}

async function runSharedSlotOauth(db, exec, op, options) {
  const readCurrent = async () => {
    const credential = readWorkerCredentialFile(exec.homeDir)
    if (!credential) throw Object.assign(new Error('credential unavailable'), { code: 'credential_required' })
    return { credential, generation: credentialGeneration(credential) }
  }
  const current = await readCurrent()
  const admission = options.admission || currentRefreshAdmission(db)
  const vmId = exec.vmId || exec.vm?.id
  const accountId =
    options.accountId ||
    admission?.accountId ||
    current.credential.account_uuid ||
    exec.vm?.claude?.account_uuid ||
    vmId
  if (op === 'refresh') {
    const outcome = await getSharedCredentialRefresh(db).run(
      {
        platform: 'claude',
        vmId,
        accountId,
        expectedGeneration: options.expectedGeneration === undefined ? current.generation : options.expectedGeneration,
        admission,
      },
      {
        readCurrent,
        refresh: async () => {
          const value = await runSlotOauthRaw(exec, op, options)
          return { finished: value?.attemptFinished === true, value }
        },
        publish: async (_previous, value) => {
          await options.publishCredential?.(value)
          await flushVmDbSync()
          return readCurrent()
        },
      },
    )
    if (outcome.unknown)
      return {
        ...(outcome.value || failure('credential_refresh_unknown')),
        attemptFinished: false,
        credentialRefreshUnknown: true,
      }
    if (!outcome.shared) return outcome.value
    return {
      ok: outcome.value?.ok === true,
      status: outcome.value?.ok ? 200 : 400,
      body: outcome.value?.ok ? { refreshed: false } : { error: { code: outcome.value?.error || 'refresh_failed' } },
      headers: {},
      via: 'slot-worker',
      attemptFinished: true,
    }
  }
  const activity = await getActivityCoordinator(db)?.admit({ kind: 'slot_oauth', requestId: op })
  let entered = false
  let finished = false
  let result
  try {
    const invoke = () =>
      new SharedVmOperations(db).run(
        vmId,
        async () => {
          entered = true
          result = await runSlotOauthRaw(exec, op, options)
          if (result?.attemptFinished === true && exec.homeDir)
            await slotHost(exec.vm).afterRefresh(exec.vm, path.dirname(exec.homeDir))
          await flushVmDbSync()
          finished = result?.attemptFinished === true
          return { ...result, vmOperationUncertain: result?.attemptFinished !== true }
        },
        { kind: `oauth_${op}`, accountId, admission },
      )
    return await (activity ? activity.run(invoke) : invoke())
  } finally {
    if (entered && !finished) await activity?.markUncertain('slot_oauth_unknown')
    else await activity?.complete({ ended: true, reason: entered ? 'slot_oauth_completed' : 'slot_oauth_not_started' })
  }
}

async function runSlotOauthRaw(
  exec,
  op,
  { body, headers, force = false, timeoutMs = 45000, runDocker = runDockerProcess } = {},
) {
  if (process.env.KIN_CRS_MOCK === '1') return null
  if (!OPS.has(op)) return failure('worker_op_invalid', `unsupported oauth operation: ${op}`)

  const host = slotHost(exec?.vm)
  const vm = { ...(exec?.vm || {}), id: exec?.vmId || exec?.vm?.id }
  const user = host.execUser(vm)
  const argv = slotExecArgv(vm, [WORKER_BIN, 'oauth', op, '--config', WORKER_CONFIG], { interactive: true, user })
  if (force) argv.push('--force')

  const stdin =
    op === 'count-tokens'
      ? JSON.stringify({ body: body || {}, headers: headers || {} })
      : op === 'reset-redeem'
        ? JSON.stringify(body || {})
        : ''
  let result
  try {
    result = await runDocker(argv, { stdin, timeoutMs, env: host.dockerEnv() })
  } catch (error) {
    return failure('worker_exec_failed', String(error?.message || error).slice(0, 300))
  }
  if (result?.timed_out) return failure('worker_timeout')
  // A refresh rotates the RT where the slot keeps its credential; the local mirror must follow before anyone reads it.
  if (op === 'refresh' && exec.homeDir) {
    try {
      await host.afterRefresh(exec.vm, path.dirname(exec.homeDir))
    } catch (error) {
      return failure('credential_pull_failed', String(error?.message || error).slice(0, 300))
    }
  }

  const payload = lastJsonLine(result?.stdout)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return failure('worker_output_invalid', String(result?.stderr || '').slice(0, 300))
  }

  const status = Number.isInteger(payload.status) ? payload.status : Number(payload.status) || 0
  const response = {
    ok: !!payload.ok,
    status,
    body: payload.body && typeof payload.body === 'object' ? payload.body : {},
    headers: payload.headers && typeof payload.headers === 'object' ? payload.headers : {},
    via: 'slot-worker',
    attemptFinished:
      result?.code === 0 &&
      payload.refresh_unknown !== true &&
      payload.body?.error?.code !== 'upstream_transport_error' &&
      ((payload.ok && status >= 200 && status < 300) ||
        status >= 400 ||
        ['config_failed', 'proxy_required', 'credential_required'].includes(payload.body?.error?.code)),
  }
  if (status === 0) response.transportError = true
  return response
}
