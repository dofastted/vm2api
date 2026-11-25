import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
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
