import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { UsageLogsView } from '../../src/lib/db/repos/usage-logs-view.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-log-export-'))
const db = openDatabase({ dbPath: path.join(root, 'logs.db') })
test.after(() => {
  closeDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

db.exec(`
  INSERT INTO users (id, email, username, password_hash) VALUES ('u1', 'a@x', 'alice', 'x'), ('u2', 'b@x', 'bob', 'x');
  INSERT INTO api_keys (id, name, key, user_id) VALUES ('k1', 'alice-key', 'sk-1', 'u1'), ('k2', 'bob-key', 'sk-2', 'u2');
`)

let seq = 0
function seed(rows) {
  const repo = new UsageLogsRepo(db)
  for (const r of rows) {
    seq++
    repo.insertSummary({
      id: `log_${String(seq).padStart(8, '0')}`,
      request_id: `req-${seq}`,
      created_at: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(),
      log_mode: 'normal',
      method: 'POST',
      path: '/v1/messages',
      protocol: 'anthropic.messages',
      model: 'claude-sonnet-4',
      status: 200,
      vm_id: 'vm-a',
      user_id: 'u1',
      api_key_id: 'k1',
      ...r,
    })
  }
}

seed([
  { session_id: 's1', status: 200 },
  { session_id: 's1', status: 500, error_code: 'upstream_error' },
  { session_id: 's1', status: 500, error_code: 'upstream_error', path: '/v1/chat/completions' },
  { session_id: 's2', status: 500, error_code: 'upstream_error' },
  { session_id: 's1', status: 200, attempt_count: 3, log_mode: 'debug' },
  { session_id: 's1', status: 401, error_code: 'invalid_api_key', vm_id: null },
  { session_id: 's9', user_id: 'u2', api_key_id: 'k2', status: 500, error_code: 'upstream_error' },
])

async function exportLogs(query, { role = 'admin', userId = null, headers = {} } = {}) {
  const out = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: root }, vm: { id: null } },
    requireAuth(req) {
      req.panelRole = role
      req.panelUser = role
      req.panelUserId = userId
      return true
    },
    json(_res, status, payload) {
      out.status = status
      out.body = payload
      return true
    },
    readBody: async () => ({}),
    proxyPool: { unbindVm() {} },
  })
  const url = `/api/panel/request-logs/export?format=jsonl&${query}`
  const res = {
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(body) {
      out.body = body
    },
  }
  await handlePanel({ method: 'GET', url, headers }, res, new URL(`http://localhost${url}`))
  assert.equal(out.status, 200, JSON.stringify(out.body).slice(0, 300))
  const rows = String(out.body || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  return { rows, headers: out.headers }
}

const ids = (rows) => rows.map((r) => r.request_id)

test('export honours the list filters the page sends (session, status code, endpoint)', async () => {
  const query = 'session_id=s1&status_code=500&endpoint=%2Fv1%2Fmessages'
  const { rows, headers } = await exportLogs(query)
  assert.deepEqual(ids(rows), ['req-2'])
  assert.equal(headers['x-kin-export-total'], '1')
  const listed = new UsageLogsView(db)
    .listBatch({ session_id: 's1', status_code: '500', endpoint: '/v1/messages' })
    .logs.map((r) => r.requestId)
  assert.deepEqual(ids(rows), listed)
})

test('export honours non-2xx, retry, debug and model filters like the list', async () => {
  assert.deepEqual(ids((await exportLogs('session_id=s1&exclude_status_200=1')).rows), ['req-3', 'req-2'])
  assert.deepEqual(ids((await exportLogs('min_attempt_count=2&log_mode=debug')).rows), ['req-5'])
  assert.deepEqual(ids((await exportLogs('model=claude-sonnet-4&session_id=s2')).rows), ['req-4'])
})

test('default muting hides auth errors unless include_muted is sent', async () => {
  assert.ok(!ids((await exportLogs('session_id=s1')).rows).includes('req-6'))
  assert.ok(ids((await exportLogs('session_id=s1&include_muted=1')).rows).includes('req-6'))
})

test('tenant export stays owner-scoped and ignores user_id', async () => {
  const { rows } = await exportLogs('user_id=u2', { role: 'user', userId: 'u1' })
  assert.ok(rows.length > 0)
  assert.ok(!ids(rows).includes('req-7'))
})

test('a trusted cross-origin console can read the export and its count headers', async (t) => {
  const prev = process.env.PANEL_CORS_ORIGINS
  process.env.PANEL_CORS_ORIGINS = 'https://panel.example.com'
  t.after(() => {
    if (prev == null) delete process.env.PANEL_CORS_ORIGINS
    else process.env.PANEL_CORS_ORIGINS = prev
  })
  const { headers } = await exportLogs('session_id=s2', { headers: { origin: 'https://panel.example.com' } })
  assert.equal(headers['access-control-allow-origin'], 'https://panel.example.com')
  assert.equal(headers['access-control-allow-credentials'], 'true')
  assert.match(headers['access-control-expose-headers'], /x-kin-export-total/)
  assert.equal(headers['x-kin-export-total'], '1')
})

test('legacy request-log keys still filter', async () => {
  assert.deepEqual(ids((await exportLogs('api_key_id=k2')).rows), ['req-7'])
  const errors = ids((await exportLogs('status=error&session_id=s1')).rows)
  assert.deepEqual(errors, ['req-3', 'req-2'])
  const since = new Date(Date.UTC(2026, 0, 1) + 6 * 1000).toISOString()
  assert.deepEqual(ids((await exportLogs(`since=${encodeURIComponent(since)}`)).rows), ['req-7'])
})

test('limit truncates and reports the full match count', async () => {
  const { rows, headers } = await exportLogs('session_id=s1&limit=1')
  assert.equal(rows.length, 1)
  assert.equal(headers['x-kin-export-total'], '4')
  assert.equal(headers['x-kin-export-truncated'], '1')
})
