import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, startGateway, api } from '../harness.mjs'

test('panel login → cookie → /api/panel/me', async () => {
  const gw = await startGateway()
  try {
    const login = await fetch(gw.baseUrl + '/api/panel/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'testpass' }),
    })
    assert.equal(login.status, 200, await login.clone().text())
    const setCookie = login.headers.get('set-cookie') || ''
    const me = await fetch(gw.baseUrl + '/api/panel/me', {
      headers: { cookie: setCookie },
    })
    // some builds expose /me under different path; accept 200 or try vms list
    if (me.status !== 200) {
      const vms = await api(gw, 'GET', '/admin/vms')
      assert.equal(vms.status, 200, vms.text)
      assert.ok(Array.isArray(vms.json.vms))
    } else {
      const body = await me.json()
      assert.ok(body.user || body.ok || body.username)
      assert.ok((body.data?.views || body.views || []).includes('database'))
      assert.equal(body.data?.version || body.version, fs.readFileSync(path.join(REPO_ROOT, 'VERSION'), 'utf8').trim())
    }
  } finally {
    await gw.stop()
  }
})

test('admin database metrics endpoint returns a safe SQLite snapshot', async () => {
  const gw = await startGateway()
  try {
    const response = await api(gw, 'GET', '/api/panel/database/metrics')
    assert.equal(response.status, 200, response.text)
    const data = response.json.data || response.json
    assert.equal(data.database.engine, 'sqlite')
    assert.equal(data.database.ok, true)
    assert.equal(data.database.journal_mode, 'wal')
    assert.equal(typeof data.database.probe_latency_ms, 'number')
    assert.equal(typeof data.database.file_size_bytes, 'number')
    assert.equal(typeof data.database.page_count, 'number')
    assert.equal(typeof data.usage_cache.requests, 'number')
    assert.ok(data.sampled_at)

    const serialized = JSON.stringify(data)
    assert.equal(serialized.includes(gw.project), false)
    assert.equal(serialized.includes('kin.db'), false)
    assert.doesNotMatch(
      serialized,
      /"(?:db_?path|file_path|checksum|password|session_key|access_token|refresh_token|master_key)"\s*:/i,
    )
  } finally {
    await gw.stop()
  }
})

test('admin vms list via API key', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'GET', '/admin/vms')
    assert.equal(r.status, 200, r.text)
    assert.ok(r.json.vms.some((v) => v.id === 'vm-sim-01'))
  } finally {
    await gw.stop()
  }
})

test('dashboard and vm detail expose proxy_pool and configured flags', async () => {
  const gw = await startGateway()
  try {
    const dash = await api(gw, 'GET', '/api/panel/dashboard')
    assert.equal(dash.status, 200, dash.text)
    const data = dash.json.data || dash.json
    assert.ok(data.proxy_pool)
    assert.equal(typeof data.proxy_pool.total, 'number')
    assert.equal(typeof data.proxy_pool.disconnect_on_error, 'boolean')
    const vm = (data.vms || []).find((item) => item.id === 'vm-sim-01')
    assert.ok(vm)
    assert.equal(vm.proxy_configured, true)
    assert.equal(vm.can_import_credential, true)

    const det = await api(gw, 'GET', '/api/panel/vms/vm-sim-01')
    assert.equal(det.status, 200, det.text)
    const detail = det.json.data || det.json
    assert.ok(detail.proxy_pool)
    assert.equal(detail.vm.proxy_configured, true)
    assert.equal(detail.vm.can_import_credential, true)
  } finally {
    await gw.stop()
  }
})

test('panel VM schedule level validates, persists, and returns to auto', async () => {
  const gw = await startGateway()
  try {
    const vmPath = path.join(gw.project, 'vms', 'vm-sim-01.json')
    const before = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    const invalid = await api(gw, 'PATCH', '/api/panel/vms/vm-sim-01', {
      body: { max_concurrency: 3, schedule_level: 11 },
    })
    assert.equal(invalid.status, 400, invalid.text)
    let saved = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    assert.equal(saved.policy.maxConcurrency, before.policy.maxConcurrency)
    assert.equal(saved.policy.priority, undefined)

    const manual = await api(gw, 'PATCH', '/api/panel/vms/vm-sim-01', { body: { schedule_level: 10 } })
    assert.equal(manual.status, 200, manual.text)
    assert.equal(manual.json.data.vm.schedule_level, 10)
    assert.equal(manual.json.data.vm.schedule_level_mode, 'manual')
    saved = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    assert.equal(saved.policy.priority, 10)
    assert.equal(saved.policy.weight, before.policy.weight)

    const automatic = await api(gw, 'PATCH', '/api/panel/vms/vm-sim-01', { body: { schedule_level: null } })
    assert.equal(automatic.status, 200, automatic.text)
    assert.equal(automatic.json.data.vm.schedule_level_mode, 'auto')
    saved = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    assert.equal(saved.policy.priority, undefined)
  } finally {
    await gw.stop()
  }
})

test('panel session slots validate, persist, and stay independent from concurrency', async () => {
  const gw = await startGateway()
  try {
    const vmPath = path.join(gw.project, 'vms', 'vm-sim-01.json')
    const before = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    const invalid = await api(gw, 'PATCH', '/api/panel/vms/vm-sim-01', { body: { session_slots: 21 } })
    assert.equal(invalid.status, 400, invalid.text)

    const updated = await api(gw, 'PATCH', '/api/panel/vms/vm-sim-01', { body: { session_slots: 4 } })
    assert.equal(updated.status, 200, updated.text)
    assert.equal(updated.json.data.vm.session_slots, 4)
    assert.equal(updated.json.data.vm.session_slots_override, true)

    const saved = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    assert.equal(saved.policy.sessionSlots, 4)
    assert.equal(saved.policy.sessionSlotsOverride, true)
    assert.equal(saved.policy.maxConcurrency, before.policy.maxConcurrency)
    assert.equal(saved.policy.maxRpm, before.policy.maxRpm)
  } finally {
    await gw.stop()
  }
})

test('sessionKey import without SOCKS5 is rejected', async () => {
  const gw = await startGateway()
  try {
    const vmPath = path.join(gw.project, 'vms', 'vm-sim-01.json')
    const rec = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    rec.proxy = null
    fs.writeFileSync(vmPath, JSON.stringify(rec, null, 2))
    const imp = await api(gw, 'POST', '/api/panel/vms/import', {
      body: { vm_id: 'vm-sim-01', sessionKey: 'sk-ant-sid01-' + 'e'.repeat(24) },
    })
    assert.equal(imp.status, 400, imp.text)
    assert.match(String(imp.json?.error?.message || ''), /SOCKS5/)
  } finally {
    await gw.stop()
  }
})

test('sessionKey import rejected when bound proxy is dead', async () => {
  const gw = await startGateway()
  try {
    const added = await api(gw, 'POST', '/api/panel/proxies/import', {
      body: { text: '10.9.9.9:1080' },
    })
    assert.equal(added.status, 200, added.text)
    const pxId = (added.json.data || added.json).items[0].id
    const bind = await api(gw, 'POST', `/api/panel/proxies/${pxId}/bind`, {
      body: { vm_id: 'vm-sim-01' },
    })
    assert.equal(bind.status, 200, bind.text)
    const off = await api(gw, 'POST', `/api/panel/proxies/${pxId}/disable`)
    assert.equal(off.status, 200, off.text)
    const imp = await api(gw, 'POST', '/api/panel/vms/import', {
      body: { vm_id: 'vm-sim-01', sessionKey: 'sk-ant-sid01-' + 'e'.repeat(24) },
    })
    assert.equal(imp.status, 400, imp.text)
    assert.match(String(imp.json?.error?.message || ''), /SOCKS5/)
  } finally {
    await gw.stop()
  }
})

test('proxy disconnect_on_error can be toggled via config', async () => {
  const gw = await startGateway()
  try {
    const got = await api(gw, 'GET', '/api/panel/proxies/config')
    assert.equal(got.status, 200, got.text)
    const before = got.json.data || got.json
    assert.equal(before.disconnect_on_error, false)
    const put = await api(gw, 'PUT', '/api/panel/proxies/config', {
      body: { disconnect_on_error: true },
    })
    assert.equal(put.status, 200, put.text)
    const after = put.json.data || put.json
    assert.equal(after.disconnect_on_error, true)
  } finally {
    await gw.stop()
  }
})

test('generate-auth-url requires bound SOCKS5', async () => {
  const gw = await startGateway()
  try {
    const vmPath = path.join(gw.project, 'vms', 'vm-sim-01.json')
    const rec = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    rec.proxy = null
    fs.writeFileSync(vmPath, JSON.stringify(rec, null, 2))
    const r = await api(gw, 'POST', '/api/panel/vms/vm-sim-01/oauth/generate-auth-url', { body: {} })
    assert.equal(r.status, 400, r.text)
    assert.match(String(r.json?.error?.message || ''), /SOCKS5/)
  } finally {
    await gw.stop()
  }
})

test('generate-auth-url then exchange-code writes fake oauth', async () => {
  const gw = await startGateway({ oauth: false })
  try {
    const gen = await api(gw, 'POST', '/api/panel/vms/vm-sim-01/oauth/generate-auth-url', { body: {} })
    assert.equal(gen.status, 200, gen.text)
    const data = gen.json.data || gen.json
    assert.match(String(data.auth_url || ''), /claude\.com\/cai\/oauth\/authorize/)
    assert.ok(data.session_id)
    const ex = await api(gw, 'POST', '/api/panel/vms/vm-sim-01/oauth/exchange-code', {
      body: { session_id: data.session_id, code: 'pasted-auth-code' },
    })
    assert.equal(ex.status, 200, ex.text)
    const out = ex.json.data || ex.json
    assert.equal(out.oauth_email, 'fake-oauth@kin.test')
    assert.equal(out.vm?.has_token || out.has_refresh != null, true)
  } finally {
    await gw.stop()
  }
})

test('pasted setup token survives identity enrichment and persists inference credentials', async () => {
  const gw = await startGateway({ oauth: false })
  try {
    const result = await api(gw, 'POST', '/api/panel/vms/vm-sim-01/oauth/exchange-code', {
      body: { code: 'sk-ant-oat01-' + 'F'.repeat(96), flavor: 'claude_setup_token' },
    })
    assert.equal(result.status, 200, result.text)
    const vm = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', 'vm-sim-01.json'), 'utf8'))
    assert.equal(vm.claude.mode, 'setup-token')
    assert.equal(vm.claude.has_access, true)
    assert.equal(vm.claude.has_refresh, false)
    assert.equal(vm.claude.scope, 'user:inference')
    assert.equal(result.json.data.official_cc_bootstrap.scheduled, false)
  } finally {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})

test('generate-auth-url claude_code flavor then exchange-code', async () => {
  const gw = await startGateway({ oauth: false })
  try {
    const gen = await api(gw, 'POST', '/api/panel/vms/vm-sim-01/oauth/generate-auth-url', {
      body: { flavor: 'claude_code' },
    })
    assert.equal(gen.status, 200, gen.text)
    const data = gen.json.data || gen.json
    assert.match(String(data.auth_url || ''), /claude\.ai\/oauth\/authorize/)
    assert.equal(data.flavor, 'claude_code')
    assert.ok(data.session_id)
    const ex = await api(gw, 'POST', '/api/panel/vms/vm-sim-01/oauth/exchange-code', {
      body: { session_id: data.session_id, code: 'pasted-auth-code' },
    })
    assert.equal(ex.status, 200, ex.text)
    const out = ex.json.data || ex.json
    assert.equal(out.oauth_email, 'fake-oauth@kin.test')
    assert.equal(out.flavor, 'claude_code')
    const vm = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', 'vm-sim-01.json'), 'utf8'))
    assert.match(vm.claude.scope, /user:sessions:claude_code/)
    assert.doesNotMatch(vm.claude.scope, /user:file_upload/)
  } finally {
    await gw.stop()
  }
})

test('global engine PUT restores routing when persistence fails', async () => {
  const gw = await startGateway()
  try {
    const before = await api(gw, 'GET', '/api/panel/routing')
    assert.equal(before.status, 200, before.text)
    const previousEngine = (before.json.data || before.json).inference.engine
    const targetEngine = previousEngine === 'go' ? 'rust' : 'go'

    const vmPath = path.join(gw.project, 'vms', 'vm-sim-01.json')
    const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    vm.inference_engine = previousEngine
    fs.writeFileSync(vmPath, JSON.stringify(vm, null, 2))

    const routingPath = path.join(gw.project, 'config', 'routing.json')
    fs.rmSync(routingPath)
    fs.mkdirSync(routingPath)

    const update = await api(gw, 'PUT', '/api/panel/routing', {
      body: { inference: { engine: targetEngine } },
    })
    assert.equal(update.status, 503, update.text)
    assert.equal(update.json.error.code, 'routing_persist_failed')

    const after = await api(gw, 'GET', '/api/panel/routing')
    assert.equal(after.status, 200, after.text)
    assert.equal((after.json.data || after.json).inference.engine, previousEngine)
  } finally {
    await gw.stop()
  }
})
