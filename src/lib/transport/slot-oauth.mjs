import { spawn } from 'node:child_process'
import { randomUUID as cryptoRandomUUID } from 'node:crypto'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { postRustKernelTelemetryEvent } from './rust-kernel-client.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { slotExecArgv } from '../vm/slot-exec.mjs'

const WORKER_CONFIG = '/run/kin/worker.json'
const WORKER_BIN = '/usr/local/bin/kin-worker'
const OPS = new Set([
  'refresh',
  'usage',
  'profile',
  'models',
  'count-tokens',
  'reset-status',
  'reset-redeem',
  'guard-probe',
])

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
  }
}

export function runSlotProcess(argv, { stdin = '', timeoutMs = 45000, env, onStdoutLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.env.KIN_DOCKER_BIN || 'docker', argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(env ? { env } : {}),
    })
    const stdout = []
    const stderr = []
    let settled = false
    let timer = null
    let stdoutBytes = 0
    let stderrBytes = 0
    let outputLimit = false
    if (onStdoutLine) {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
      lines.on('line', onStdoutLine)
    }
    child.stdin?.on('error', () => {})

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= 1024 * 1024) stdout.push(chunk)
      else {
        outputLimit = true
        child.kill('SIGKILL')
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes <= 65536) stderr.push(chunk)
    })
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
        output_limit: outputLimit,
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

/**
 * Does the worker on this node keep the refresh attempt journal? Asked with an operation that reads no
 * config, no credential and does not touch the network. A worker built before the journal does not know
 * it and answers invalid_arguments, so only an explicit yes counts.
 */
export async function probeAttemptGuard(exec, opts = {}) {
  try {
    const result = await runSlotOauth(exec, 'guard-probe', { timeoutMs: 15000, ...opts })
    return result?.ok === true && result?.body?.attempt_guard === true
  } catch {
    return false
  }
}

const isInvalidArguments = (result) => lastJsonLine(result?.stdout)?.body?.error?.code === 'invalid_arguments'

export async function runSlotOauth(exec, op, opts = {}) {
  if (process.env.KIN_CRS_MOCK === '1') return null
  if (!OPS.has(op)) return failure('worker_op_invalid', `unsupported oauth operation: ${op}`)
  if (op !== 'refresh') return (await runSlotOauthProcess(exec, op, opts)).response
  // The worker's attempt journal is what makes a refresh safe to retry after a lost answer:
  // it refuses to send a refresh token whose last send never resolved. A worker built before
  // the journal rejects the flag as invalid_arguments before touching any token, so asking it
  // again without the flag is still its first real attempt.
  const guarded = await runSlotOauthProcess(exec, op, { ...opts, attemptGuard: true })
  if (!isInvalidArguments(guarded.raw)) return { ...guarded.response, attempt_guard: true }
  const legacy = await runSlotOauthProcess(exec, op, opts)
  return { ...legacy.response, attempt_guard: false }
}

/** One worker run: `raw` is the process result, `response` the mapped answer. */
async function runSlotOauthProcess(
  exec,
  op,
  {
    body,
    headers,
    force = false,
    attemptGuard = false,
    timeoutMs = 45000,
    runDocker = runSlotProcess,
    postTelemetry = postRustKernelTelemetryEvent,
  } = {},
) {
  const host = slotHost(exec?.vm)
  const vm = { ...(exec?.vm || {}), id: exec?.vmId || exec?.vm?.id }
  const user = host.execUser(vm)
  const argv = slotExecArgv(vm, [WORKER_BIN, 'oauth', op, '--config', WORKER_CONFIG], { interactive: true, user })
  if (force) argv.push('--force')
  if (attemptGuard) argv.push('--attempt-guard')

  const stdin =
    op === 'count-tokens'
      ? JSON.stringify({ body: body || {}, headers: headers || {} })
      : op === 'reset-redeem'
        ? JSON.stringify(body || {})
        : ''
  // Only the unique guest RT writer can prove an attempt happened: cache hits,
  // waiters and polls emit no notification. Preserve order without blocking stdout.
  let telemetry = Promise.resolve()
  let telemetryError = null
  const attempts = new Map()
  const onStdoutLine = (line) => {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (
      event?.type !== 'oauth_attempt' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.attempt_id)
    )
      return
    const prior = attempts.get(event.attempt_id)
    if (event.phase === 'start') {
      if (prior || attempts.size >= 64) return
      attempts.set(event.attempt_id, 'start')
    } else if (event.phase === 'success' || event.phase === 'failure') {
      if (prior !== 'start') return
      attempts.set(event.attempt_id, event.phase)
    } else return
    const notification = {
      event_id: cryptoRandomUUID(),
      kind: 'oauth',
      attempt_id: event.attempt_id,
      operation: 'refresh',
      phase: event.phase,
      ...(event.phase === 'failure'
        ? { error_code: /^[a-z][a-z0-9_]{0,63}$/.test(event.error_code) ? event.error_code : 'refresh_failed' }
        : {}),
    }
    telemetry = telemetry.then(async () => {
      try {
        const recorded = await postTelemetry(exec, notification, { timeoutMs: 20000 })
        if (!recorded?.ok) telemetryError = 'oauth_telemetry_unavailable'
      } catch {
        telemetryError = 'oauth_telemetry_unavailable'
      }
    })
  }
  let result
  try {
    result = await runDocker(argv, { stdin, timeoutMs, env: host.dockerEnv(), onStdoutLine })
  } catch (error) {
    result = { execError: String(error?.message || error).slice(0, 300) }
  }
  for (const [attempt_id, phase] of attempts) {
    if (phase === 'start')
      onStdoutLine(
        JSON.stringify({
          type: 'oauth_attempt',
          attempt_id,
          phase: 'failure',
          // Started but never reported back: the worker may or may not have sent the token.
          error_code: 'refresh_outcome_unknown',
        }),
      )
  }
  await telemetry
  const failed = (code, message) => ({
    ...failure(code, message),
    ...(telemetryError ? { telemetry_error: telemetryError } : {}),
  })
  const done = (response) => ({ raw: result, response })
  if (result?.execError) return done(failed('worker_exec_failed', result.execError))
  if (result?.timed_out) return done(failed('worker_timeout'))
  if (result?.output_limit) return done(failed('worker_output_limit'))
  // An older worker rejecting --attempt-guard did nothing; there is nothing to pull back.
  if (attemptGuard && isInvalidArguments(result)) return done(failed('invalid_arguments'))
  // A refresh rotates the RT where the slot keeps its credential; the local mirror must follow before anyone reads it.
  if (op === 'refresh' && exec.homeDir) {
    try {
      await host.afterRefresh(exec.vm, path.dirname(exec.homeDir))
    } catch (error) {
      return done(failed('credential_pull_failed', String(error?.message || error).slice(0, 300)))
    }
  }

  const payload = lastJsonLine(result?.stdout)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return done(failed('worker_output_invalid', String(result?.stderr || '').slice(0, 300)))
  }

  const status = Number.isInteger(payload.status) ? payload.status : Number(payload.status) || 0
  const response = {
    ok: !!payload.ok,
    status,
    body: payload.body && typeof payload.body === 'object' ? payload.body : {},
    headers: payload.headers && typeof payload.headers === 'object' ? payload.headers : {},
    via: 'slot-worker',
  }
  if (telemetryError) response.telemetry_error = telemetryError
  if (status === 0) response.transportError = true
  return done(response)
}
