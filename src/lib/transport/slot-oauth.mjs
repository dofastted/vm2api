import { spawn } from 'node:child_process'
import path from 'node:path'
import { slotHost } from '../vm/slot-host.mjs'
import { slotExecArgv } from '../vm/slot-exec.mjs'

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

export async function runSlotOauth(
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
  }
  if (status === 0) response.transportError = true
  return response
}
