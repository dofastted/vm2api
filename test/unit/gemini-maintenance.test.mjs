import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'
import { callGeminiMaintenance, createGeminiMaintenanceHandler } from '../../src/lib/gemini/maintenance.mjs'

const root = '/api/panel/gemini/maintenance'
const base = {
  available: true,
  install_dir: '/opt/vm2api',
  service: { installed: true, active: true },
  payload: { state: 'installed', version: '0.3.0-rc.2', cli_version: '1.5.9', activation_required: false, issue: null },
  releases: [
    {
      id: 'payload-2026.11.20-gemini-0.3.0-rc.2',
      version: '0.3.0-rc.2',
      cli_version: '1.5.9',
      installed: true,
      compatible: true,
    },
  ],
  rollback: { available: false, version: null },
  checks: [{ id: 'runtime', state: 'pass', code: null }],
  job: null,
}
const running = {
  id: 'job-test',
  action: 'diagnose',
  status: 'running',
  phase: 'verifying',
  error_code: null,
  started_at: '2026-11-22T00:00:00Z',
  finished_at: null,
}
const response = { setHeader() {} }
const json = (_res, status, body) => ({ status, body })

test('maintenance paths stay admin-only and browser input cannot become a host command', async () => {
  for (const role of ['user', 'super', 'admin']) {
    assert.equal(authorizePanelRoute('GET', root, role).ok, role === 'admin')
    assert.equal(authorizePanelRoute('POST', root + '/jobs', role).ok, role === 'admin')
  }
  let called = 0
  const handler = createGeminiMaintenanceHandler({
    json,
    readBody: async (req) => req.body,
    callMaintenance: async () => {
      called++
      return base
    },
  })
  for (const body of [
    null,
    [],
    {},
    { action: 'shell' },
    { action: 'install', command: 'id' },
    { action: 'install', url: 'https://untrusted.invalid' },
    { action: 'repair', install_dir: '/tmp/other' },
    { action: 'update_native', release_id: '../other' },
  ]) {
    const result = await handler({ method: 'POST', body }, response, root + '/jobs')
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'gemini_maintenance_invalid_request')
  }
  assert.equal(called, 0)
})

test('a real maintenance socket receives only the fixed operation and returns safe job state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gemini-maintenance-'))
  const socket = path.join(directory, 'control.sock')
  const previous = process.env.KIN_GEMINI_MAINTENANCE_SOCKET
  process.env.KIN_GEMINI_MAINTENANCE_SOCKET = socket
  const received = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      received.push([req.url, JSON.parse(Buffer.concat(chunks).toString())])
      res.statusCode = req.url === '/jobs' ? 202 : 200
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          ...base,
          job: req.url === '/jobs' ? { ...running, stdout: 'private child output' } : null,
          credentials: 'not an API field',
        }),
      )
    })
  })
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(socket, resolve))
    const handler = createGeminiMaintenanceHandler({
      json,
      readBody: async (req, limit) => {
        assert.equal(limit, 2048)
        return req.body
      },
    })
    const status = await handler({ method: 'GET' }, response, root)
    assert.equal(status.status, 200)
    assert.deepEqual(status.body.data, base)
    const job = await handler({ method: 'POST', body: { action: 'diagnose' } }, response, root + '/jobs')
    assert.equal(job.status, 200)
    assert.deepEqual(job.body.data.job, running)
    assert.doesNotMatch(JSON.stringify(job), /private child output|credentials/)
    assert.deepEqual(received, [
      ['/status', {}],
      ['/jobs', { action: 'diagnose' }],
    ])
  } finally {
    if (previous === undefined) delete process.env.KIN_GEMINI_MAINTENANCE_SOCKET
    else process.env.KIN_GEMINI_MAINTENANCE_SOCKET = previous
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('missing helper is a bootstrap prerequisite, not a successful install job', async () => {
  const handler = createGeminiMaintenanceHandler({
    json,
    readBody: async (req) => req.body,
    callMaintenance: async () => {
      throw Object.assign(new Error('private socket path'), { code: 'gemini_maintenance_unavailable' })
    },
  })
  const status = await handler({ method: 'GET' }, response, root)
  assert.deepEqual(status, {
    status: 200,
    body: { ok: true, data: { available: false, bootstrap_required: true, code: 'gemini_maintenance_unavailable' } },
  })
  const job = await handler({ method: 'POST', body: { action: 'install' } }, response, root + '/jobs')
  assert.equal(job.status, 503)
  assert.equal(job.body.error.code, 'gemini_maintenance_unavailable')
  assert.doesNotMatch(JSON.stringify(job), /private socket path/)
})

test('busy and incompatible host operations preserve their failure rather than inventing completion', async () => {
  for (const code of ['gemini_maintenance_busy', 'gemini_cli_incompatible']) {
    const handler = createGeminiMaintenanceHandler({
      json,
      readBody: async (req) => req.body,
      callMaintenance: async () => {
        throw Object.assign(new Error('internal details'), { status: 409, code })
      },
    })
    const result = await handler(
      { method: 'POST', body: { action: 'update_cli', release_id: base.releases[0].id } },
      response,
      root + '/jobs',
    )
    assert.equal(result.status, 409)
    assert.equal(result.body.error.code, code)
    assert.doesNotMatch(JSON.stringify(result), /internal details/)
  }
})

test('malformed host snapshots and oversized socket replies are rejected', async () => {
  const handler = createGeminiMaintenanceHandler({
    json,
    readBody: async () => ({}),
    callMaintenance: async () => ({ ...base, job: { ...running, phase: 'a secret token is not a phase' } }),
  })
  const result = await handler({ method: 'GET' }, response, root)
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'gemini_maintenance_protocol_error')
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gemini-maintenance-limit-'))
  const socket = path.join(directory, 'control.sock')
  const previous = process.env.KIN_GEMINI_MAINTENANCE_SOCKET
  process.env.KIN_GEMINI_MAINTENANCE_SOCKET = socket
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ data: 'x'.repeat(256 * 1024) })))
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(socket, resolve))
    await assert.rejects(callGeminiMaintenance('status'), { code: 'gemini_maintenance_protocol_error' })
  } finally {
    if (previous === undefined) delete process.env.KIN_GEMINI_MAINTENANCE_SOCKET
    else process.env.KIN_GEMINI_MAINTENANCE_SOCKET = previous
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('permission and transient failures do not request a root bootstrap', async () => {
  for (const code of [
    'gemini_maintenance_denied',
    'gemini_maintenance_timeout',
    'gemini_maintenance_transport_error',
    'gemini_maintenance_unsupported_platform',
    'gemini_maintenance_invalid_socket',
  ]) {
    const handler = createGeminiMaintenanceHandler({
      json,
      readBody: async () => ({}),
      callMaintenance: async () => {
        throw Object.assign(new Error('private detail'), { code })
      },
    })
    const result = await handler({ method: 'GET' }, response, root)
    assert.deepEqual(result.body.data, { available: false, bootstrap_required: false, code })
  }
})
