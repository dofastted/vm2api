import http from 'node:http'
import path from 'node:path'

const ROOT = '/api/panel/gemini/maintenance'
const ACTIONS = new Set(['diagnose', 'install', 'repair', 'recover', 'update_cli', 'update_native', 'rollback'])
const MAX_RESPONSE = 256 * 1024
const failure = (code, status = 503) => Object.assign(new Error(code), { code, status })
const codeOf = (value) => (typeof value === 'string' && /^gemini_[a-z0-9_]{1,80}$/.test(value) ? value : null)

export function callGeminiMaintenance(operation, body = {}) {
  const socketPath = process.env.KIN_GEMINI_MAINTENANCE_SOCKET || '/run/vm2api-gemini-maintenance/control.sock'
  if (process.platform !== 'linux' || process.arch !== 'x64') throw failure('gemini_maintenance_unsupported_platform')
  if (!path.isAbsolute(socketPath)) throw failure('gemini_maintenance_invalid_socket')
  const bytes = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path: '/' + operation,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) },
        signal: AbortSignal.timeout(8000),
      },
      async (response) => {
        try {
          const chunks = []
          let size = 0
          for await (const chunk of response) {
            size += chunk.length
            if (size > MAX_RESPONSE) throw failure('gemini_maintenance_protocol_error')
            chunks.push(chunk)
          }
          let result
          try {
            result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            throw failure('gemini_maintenance_protocol_error')
          }
          if (response.statusCode !== 200 && !(operation === 'jobs' && response.statusCode === 202)) {
            throw failure(
              codeOf(result?.code) || 'gemini_maintenance_failed',
              [400, 403, 409, 503].includes(response.statusCode) ? response.statusCode : 503,
            )
          }
          resolve(result)
        } catch (error) {
          response.destroy()
          reject(error)
        }
      },
    )
    request.on('error', (error) => {
      const code =
        error?.code === 'ABORT_ERR'
          ? 'gemini_maintenance_timeout'
          : ['EACCES', 'EPERM'].includes(error?.code)
            ? 'gemini_maintenance_denied'
            : ['ENOENT', 'ECONNREFUSED'].includes(error?.code)
              ? 'gemini_maintenance_unavailable'
              : 'gemini_maintenance_transport_error'
      reject(failure(code))
    })
    request.end(bytes)
  })
}

function snapshotView(raw) {
  if (
    raw?.available !== true ||
    typeof raw?.service?.installed !== 'boolean' ||
    typeof raw?.service?.active !== 'boolean' ||
    !raw?.payload ||
    !Array.isArray(raw.releases) ||
    !Array.isArray(raw.checks) ||
    !raw.rollback ||
    raw.releases.length > 64 ||
    raw.checks.length > 64
  ) {
    throw failure('gemini_maintenance_protocol_error')
  }
  const label = (value) => (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value) ? value : null)
  const timestamp = (value) =>
    typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : null
  let job = null
  if (raw.job != null) {
    if (
      !label(raw.job.id) ||
      !ACTIONS.has(raw.job.action) ||
      !['running', 'completed', 'failed'].includes(raw.job.status) ||
      !label(raw.job.phase) ||
      !timestamp(raw.job.started_at)
    )
      throw failure('gemini_maintenance_protocol_error')
    job = {
      id: raw.job.id,
      action: raw.job.action,
      status: raw.job.status,
      phase: raw.job.phase,
      error_code: codeOf(raw.job.error_code),
      started_at: raw.job.started_at,
      finished_at: timestamp(raw.job.finished_at),
    }
  }
  return {
    available: true,
    install_dir:
      typeof raw.install_dir === 'string' && /^\/[A-Za-z0-9._/-]{1,240}$/.test(raw.install_dir)
        ? raw.install_dir
        : null,
    service: { installed: raw.service.installed, active: raw.service.active },
    payload: {
      state: label(raw.payload.state) || 'unknown',
      version: label(raw.payload.version),
      cli_version: label(raw.payload.cli_version),
      activation_required: raw.payload.activation_required === true,
      issue: codeOf(raw.payload.issue),
    },
    releases: raw.releases.map((release) => {
      if (!label(release.id) || !label(release.version) || !label(release.cli_version))
        throw failure('gemini_maintenance_protocol_error')
      return {
        id: release.id,
        version: release.version,
        cli_version: release.cli_version,
        installed: release.installed === true,
        compatible: release.compatible === true,
      }
    }),
    rollback: { available: raw.rollback.available === true, version: label(raw.rollback.version) },
    checks: raw.checks.map((check) => {
      if (!label(check.id) || !['pass', 'fail', 'warning'].includes(check.state))
        throw failure('gemini_maintenance_protocol_error')
      return { id: check.id, state: check.state, code: codeOf(check.code) }
    }),
    job,
  }
}

export function createGeminiMaintenanceHandler({ json, readBody, callMaintenance = callGeminiMaintenance }) {
  return async (req, res, pathname) => {
    res.setHeader('Cache-Control', 'no-store')
    const ok = (data) => json(res, 200, { ok: true, data })
    const fail = (status, code) => json(res, status, { ok: false, error: { code, message: code } })
    const statusRequest = req.method === 'GET' && pathname === ROOT
    try {
      if (statusRequest) return ok(snapshotView(await callMaintenance('status', {})))
      if (pathname !== `${ROOT}/jobs`) return fail(404, 'not_found')
      if (req.method !== 'POST') return fail(405, 'method_not_allowed')
      const body = await readBody(req, 2048)
      if (
        !body ||
        Array.isArray(body) ||
        typeof body !== 'object' ||
        Object.keys(body).some((key) => !['action', 'release_id'].includes(key)) ||
        !ACTIONS.has(body.action) ||
        (body.release_id !== undefined &&
          (typeof body.release_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(body.release_id)))
      )
        return fail(400, 'gemini_maintenance_invalid_request')
      return ok(snapshotView(await callMaintenance('jobs', body)))
    } catch (error) {
      const code = codeOf(error?.code) || 'gemini_maintenance_failed'
      if (
        statusRequest &&
        [
          'gemini_maintenance_unavailable',
          'gemini_maintenance_denied',
          'gemini_maintenance_timeout',
          'gemini_maintenance_transport_error',
          'gemini_maintenance_unsupported_platform',
          'gemini_maintenance_invalid_socket',
        ].includes(code)
      )
        return ok({ available: false, bootstrap_required: code === 'gemini_maintenance_unavailable', code })
      return fail(error?.status === 413 ? 413 : [400, 403, 409].includes(error?.status) ? error.status : 503, code)
    }
  }
}
