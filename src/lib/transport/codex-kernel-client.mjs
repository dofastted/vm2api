/**
 * Codex kernel hop client. Same Unix-socket + internal token contract as
 * go-worker-client, socket is run/codex-kernel.sock.
 */
import path from 'node:path'
import { callGoWorker, streamGoWorker, workerHealth, workerPaths } from './go-worker-client.mjs'

export function codexKernelPaths(exec = {}) {
  const base = workerPaths(exec)
  const runDir = base.runDir
  return {
    runDir,
    socketPath: exec.vm?.runtime?.codex_kernel_socket || (runDir ? path.join(runDir, 'codex-kernel.sock') : null),
    tokenPath: base.tokenPath,
    configPath: runDir ? path.join(runDir, 'codex-kernel.json') : null,
    credentialPath: runDir ? path.join(path.dirname(runDir), 'codex-credentials.json') : null,
  }
}

export function withCodexKernelExec(exec) {
  const paths = codexKernelPaths(exec)
  return {
    ...exec,
    vm: {
      ...(exec?.vm || {}),
      runtime: {
        ...(exec?.vm?.runtime || {}),
        worker_socket: paths.socketPath,
        worker_token_file: paths.tokenPath,
        worker_run_dir: paths.runDir,
      },
    },
  }
}

function remapVia(result) {
  if (!result || typeof result !== 'object') return result
  return {
    ...result,
    via: String(result.via || 'go-worker').replace(/go-worker/g, 'codex-kernel'),
  }
}

async function dispatchCodex(opts, send) {
  let bound = false
  let startFailed = false
  let startError
  const result = await send({
    ...opts,
    exec: withCodexKernelExec(opts.exec),
    requestPath: '/internal/v1/codex/responses',
    onExecutionStart:
      typeof opts.onExecutionStart === 'function'
        ? async (execution) => {
            try {
              await opts.onExecutionStart(execution)
              bound = true
            } catch (error) {
              startFailed = true
              startError = error
              throw error
            }
          }
        : opts.onExecutionStart,
  })
  if (startFailed) throw startError
  if (typeof opts.onExecutionEnd === 'function' && (bound || typeof opts.onExecutionStart !== 'function')) {
    await opts.onExecutionEnd(result?.execution)
  }
  return remapVia(result)
}

export async function callCodexKernel(opts = {}) {
  return dispatchCodex(opts, callGoWorker)
}

export async function streamCodexKernel(opts = {}) {
  return dispatchCodex(opts, streamGoWorker)
}

export async function codexKernelHealth(exec, opts = {}) {
  const health = await workerHealth(withCodexKernelExec(exec), opts)
  if (health?.source) {
    return { ...health, source: String(health.source).replace(/go-worker/g, 'codex-kernel') }
  }
  return health
}
