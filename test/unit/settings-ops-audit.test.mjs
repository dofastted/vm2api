import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { getDbEngine } from '../../src/lib/db/database.mjs'
import {
  buildNotifyConsoleLink,
  formatNotifyMessage,
  mergeNotifyConfig,
  normalizeNotifyConfig,
  notifyChannelsReady,
  publicNotifyConfig,
  sendNotifyTest,
} from '../../src/lib/admin/notify.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { buildUpdateStatus, clearReleaseCache, fetchLatestRelease } from '../../src/lib/admin/release.mjs'
import { isConsoleEntry } from '../../src/lib/http/web-dist.mjs'

test('P2-12: buildNotifyConsoleLink always targets a served console entry (/cc or /console)', () => {
  const cases = [
    ['https://panel.example.com', 'https://panel.example.com/cc#/cluster'],
    ['https://panel.example.com/', 'https://panel.example.com/cc#/cluster'],
    ['http://127.0.0.1:8787', 'http://127.0.0.1:8787/cc#/cluster'],
    ['https://panel.example.com/cc', 'https://panel.example.com/cc#/cluster'],
    ['https://panel.example.com/cc/', 'https://panel.example.com/cc#/cluster'],
    ['https://panel.example.com/console', 'https://panel.example.com/console#/cluster'],
    ['https://panel.example.com/console/', 'https://panel.example.com/console#/cluster'],
    ['https://panel.example.com/cc#/overview', 'https://panel.example.com/cc#/cluster'],
    ['', ''],
  ]
  for (const [input, expected] of cases) {
    const link = buildNotifyConsoleLink(input)
    assert.equal(link, expected, `input=${JSON.stringify(input)}`)
    if (link) {
      const parsed = new URL(link)
      assert.equal(isConsoleEntry(parsed.pathname), true, `${parsed.pathname} must be a valid console entry`)
      assert.equal(parsed.hash, '#/cluster')
    }
  }

  const msg = formatNotifyMessage(
    { type: 'pool_empty', title: '账号池无可用账号' },
    null,
    normalizeNotifyConfig({ console_url: 'https://panel.example.com' }),
  )
  assert.equal(msg.consoleLink, 'https://panel.example.com/cc#/cluster')
  assert.match(msg.text, /https:\/\/panel\.example\.com\/cc#\/cluster/)
})

test('P2-12: normalizeNotifyConfig clamps zero and negative ints to min while missing/blank use fallback', () => {
  const clamped = normalizeNotifyConfig({
    interval_sec: -5,
    cooldown_sec: 0,
    digest_sec: -100,
    min_available: 0,
    email: { port: -1 },
  })
  assert.equal(clamped.interval_sec, 15)
  assert.equal(clamped.cooldown_sec, 30)
  assert.equal(clamped.digest_sec, 300)
  assert.equal(clamped.min_available, 1)
  assert.equal(clamped.email.port, 1)

  const fallback = normalizeNotifyConfig({
    interval_sec: '',
    cooldown_sec: null,
    digest_sec: undefined,
    min_available: '   ',
    email: { port: 'invalid' },
  })
  assert.equal(fallback.interval_sec, 60)
  assert.equal(fallback.cooldown_sec, 300)
  assert.equal(fallback.digest_sec, 21600)
  assert.equal(fallback.min_available, 1)
  assert.equal(fallback.email.port, 587)
})

test('P2-12: email SMTP channel merges secrets safely, redacts pass, and reports readiness', async () => {
  const saved = normalizeNotifyConfig({
    email: {
      enabled: true,
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      user: 'ops@example.com',
      pass: 'super-secret',
      from: 'KIN <ops@example.com>',
      to: 'a@example.com, b@example.com',
    },
  })
  assert.equal(notifyChannelsReady(saved).email, true)
  const pub = publicNotifyConfig(saved)
  assert.equal(pub.email.pass, '')
  assert.equal(pub.email.pass_set, true)
  assert.deepEqual(pub.email.to, ['a@example.com', 'b@example.com'])

  const merged = mergeNotifyConfig(saved, {
    email: { enabled: true, host: 'smtp.example.com', pass: '', to: ['c@example.com'] },
  })
  assert.equal(merged.email.pass, 'super-secret')
  assert.deepEqual(merged.email.to, ['c@example.com'])

  await assert.rejects(
    sendNotifyTest(normalizeNotifyConfig({ email: { host: '', to: [] } }), 'email'),
    /email_not_configured/,
  )
})

test('P2-15: GET /api/panel/version honors ?refresh=1 and failed refreshes do not poison the 5-min cache', async (t) => {
  clearReleaseCache()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-ops-version-'))
  fs.writeFileSync(path.join(root, 'VERSION'), '1.4.200\n')
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '')

  const origFetch = globalThis.fetch
  let mode = 'v201'
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    if (mode === 'fail') return { ok: false, status: 503 }
    const tag = mode === 'v202' ? 'v1.4.202' : 'v1.4.201'
    return {
      ok: true,
      json: async () => ({ tag_name: tag, name: `vm2api ${tag}`, body: '' }),
    }
  }
  t.after(() => {
    globalThis.fetch = origFetch
    clearReleaseCache()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const invoke = async (urlPath) => {
    let response = null
    const handlePanel = createPanelHandler({
      cfg: { paths: { project: root } },
      runningVersion: '1.4.200',
      requireAuth(req) {
        req.panelUser = 'admin'
        req.panelRole = 'admin'
        return true
      },
      json(_res, status, body) {
        response = { status, body }
      },
    })
    await handlePanel({ method: 'GET' }, {}, new URL(`http://localhost${urlPath}`))
    return response
  }

  // 1. Initial call populates cache.
  const first = await invoke('/api/panel/version')
  assert.equal(first.status, 200)
  assert.equal(first.body.data.latest_tag, 'v1.4.201')
  assert.equal(fetchCalls, 1)

  // 2. Normal call within 5 minutes serves from cache without hitting GitHub.
  mode = 'v202'
  const cached = await invoke('/api/panel/version')
  assert.equal(cached.body.data.latest_tag, 'v1.4.201')
  assert.equal(fetchCalls, 1)

  // 3. ?refresh=1 bypasses the 5-minute cache and fetches v1.4.202.
  const refreshed = await invoke('/api/panel/version?refresh=1')
  assert.equal(refreshed.body.data.latest_tag, 'v1.4.202')
  assert.equal(refreshed.body.data.update_available, true)
  assert.equal(fetchCalls, 2)

  // 4. Refresh failure returns failed status without caching the error for 5 minutes.
  mode = 'fail'
  const failed = await invoke('/api/panel/version?refresh=1')
  assert.equal(failed.body.data.check_status, 'failed')
  assert.equal(failed.body.data.source_error, 'github_http_503')
  assert.equal(fetchCalls, 3)

  // 5. Subsequent normal call (no refresh=1) retries immediately and recovers.
  mode = 'v202'
  const recovered = await invoke('/api/panel/version')
  assert.equal(recovered.body.data.check_status, 'ok')
  assert.equal(recovered.body.data.source_error, null)
  assert.equal(recovered.body.data.latest_tag, 'v1.4.202')
  assert.equal(fetchCalls, 4)

  // Direct fetchLatestRelease check for network errors not renewing cache TTL.
  clearReleaseCache()
  await buildUpdateStatus({
    projectRoot: root,
    cacheMs: 0,
    now: () => 10_000,
    fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.4.202' }) }),
  })
  const errRes = await fetchLatestRelease({
    cacheMs: 0,
    now: () => 20_000,
    fetchImpl: async () => {
      throw new Error('timeout')
    },
  })
  assert.equal(errRes.error, 'timeout')
  const retryRes = await fetchLatestRelease({
    now: () => 20_500,
    fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.4.203' }) }),
  })
  assert.equal(retryRes.error, null)
  assert.equal(retryRes.cached, false)
  assert.equal(retryRes.release.tag, 'v1.4.203')
})

test('P2-14: backup panel routes expose engine, .pgdump MIME type, 422/503 restore status codes, and DELETE', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-ops-backup-routes-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const records = new Map()
  for (const [id, fileName, content] of [
    ['bak_pgdump', 'kin-backup-2026-11-26.pgdump', 'PGDMP-raw'],
    ['bak_targz', 'kin-backup-2026-11-26.tar.gz', 'gzip-tar'],
    ['bak_ndjson', 'kin-backup-2026-11-26.pg.ndjson.gz', 'gzip-ndjson'],
    ['bak_dbgz', 'kin-backup-2026-11-26.db.gz', 'gzip-db'],
  ]) {
    const filePath = path.join(tmpDir, fileName)
    fs.writeFileSync(filePath, content)
    records.set(id, {
      id,
      file_name: fileName,
      file_path: filePath,
      sha256: 'abc123',
      status: 'ok',
      file_exists: true,
    })
  }

  let nextRestoreError = null
  const removed = []
  const backupService = {
    isRestoring: false,
    list: () => [...records.values()],
    getSchedule: () => ({ enabled: true, interval_hours: 24, retention: 7 }),
    nextAutoAt: () => '2026-11-27T00:00:00.000Z',
    get: (id) => records.get(id) || null,
    async restoreBackup() {
      if (nextRestoreError) throw nextRestoreError
      return { ok: true, restored: 'bak_targz', pre_restore: 'bak_pre' }
    },
    remove: (id) => {
      if (!records.has(id)) return false
      records.delete(id)
      removed.push(id)
      return true
    },
  }

  const invoke = async (method, urlPath, body = {}) => {
    let jsonResponse = null
    const streamRes = new PassThrough()
    let streamStatus = null
    let streamHeaders = null
    streamRes.writeHead = (status, headers) => {
      streamStatus = status
      streamHeaders = headers
    }
    const handlePanel = createPanelHandler({
      cfg: { paths: { project: tmpDir } },
      backupService,
      readBody: async () => body,
      requireAuth(req) {
        req.panelUser = 'admin'
        req.panelRole = 'admin'
        return true
      },
      json(_res, status, payload) {
        jsonResponse = { status, body: payload }
      },
    })
    await handlePanel({ method, headers: {} }, streamRes, new URL(`http://localhost${urlPath}`))
    if (jsonResponse) return jsonResponse
    const chunks = []
    for await (const chunk of streamRes) chunks.push(chunk)
    return {
      status: streamStatus,
      headers: streamHeaders,
      raw: Buffer.concat(chunks).toString('utf8'),
    }
  }

  // 1. GET /api/panel/backups includes current DB engine
  const listed = await invoke('GET', '/api/panel/backups')
  assert.equal(listed.status, 200)
  assert.equal(listed.body.ok, true)
  assert.equal(listed.body.engine, getDbEngine())
  assert.equal(listed.body.items.length, 4)

  // 2. GET /download serves application/octet-stream for .pgdump and application/gzip for gzip archives
  const dlPgdump = await invoke('GET', '/api/panel/backups/bak_pgdump/download')
  assert.equal(dlPgdump.status, 200)
  assert.equal(dlPgdump.headers['content-type'], 'application/octet-stream')
  assert.equal(dlPgdump.headers['content-disposition'], 'attachment; filename="kin-backup-2026-11-26.pgdump"')
  assert.equal(dlPgdump.raw, 'PGDMP-raw')

  for (const id of ['bak_targz', 'bak_ndjson', 'bak_dbgz']) {
    const dl = await invoke('GET', `/api/panel/backups/${id}/download`)
    assert.equal(dl.status, 200)
    assert.equal(dl.headers['content-type'], 'application/gzip', `${id} must serve application/gzip`)
  }

  // 3. POST /restore maps backup_incompatible -> 422 and pg_restore_missing -> 503
  nextRestoreError = Object.assign(new Error('cross-engine archive'), { code: 'backup_incompatible' })
  const incompat = await invoke('POST', '/api/panel/backups/bak_pgdump/restore', { confirm: true })
  assert.equal(incompat.status, 422)
  assert.equal(incompat.body.error.code, 'backup_incompatible')

  nextRestoreError = Object.assign(new Error('pg_restore binary missing'), { code: 'pg_restore_missing' })
  const missingTool = await invoke('POST', '/api/panel/backups/bak_pgdump/restore', { confirm: true })
  assert.equal(missingTool.status, 503)
  assert.equal(missingTool.body.error.code, 'pg_restore_missing')

  // 4. DELETE /api/panel/backups/:id
  const delOk = await invoke('DELETE', '/api/panel/backups/bak_dbgz')
  assert.equal(delOk.status, 200)
  assert.deepEqual(delOk.body, { ok: true, deleted: 'bak_dbgz' })
  assert.deepEqual(removed, ['bak_dbgz'])

  const delMissing = await invoke('DELETE', '/api/panel/backups/bak_dbgz')
  assert.equal(delMissing.status, 404)
})

test('P2-14: server.mjs backupService.onRestored awaits ensureRedaction and request-log header is engine-agnostic', () => {
  const serverSrc = fs.readFileSync(path.join(process.cwd(), 'src/server.mjs'), 'utf8')
  assert.match(serverSrc, /import\s+\{\s*ensureRedaction\s*\}\s+from\s+['"]\.\/lib\/redaction\/runtime\.mjs['"]/)
  const onRestoredMatch = serverSrc.match(/backupService\.onRestored\(async\s*\(db\)\s*=>\s*\{([\s\S]*?)\n\}\)/)
  assert.ok(onRestoredMatch, 'backupService.onRestored should register an async callback')
  assert.match(
    onRestoredMatch[1],
    /try\s*\{\s*await ensureRedaction\(routingConfig,\s*\{\s*projectRoot:\s*cfg\.paths\.project\s*\}\)\s*\}\s*catch/,
    'onRestored must await ensureRedaction inside try/catch so failures log without breaking restore',
  )

  const requestLogHead = fs
    .readFileSync(path.join(process.cwd(), 'src/lib/admin/request-log.mjs'), 'utf8')
    .slice(0, 200)
  assert.doesNotMatch(requestLogHead, /SQLite-backed/i)
})
