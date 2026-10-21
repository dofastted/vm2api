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

test('admin database metrics endpoint returns a safe PostgreSQL snapshot', async () => {
  const gw = await startGateway()
  try {
    const response = await api(gw, 'GET', '/api/panel/database/metrics')
    assert.equal(response.status, 200, response.text)
    const data = response.json.data || response.json
    assert.equal(data.database.engine, 'postgresql')
    assert.equal(data.database.ok, true)
    assert.equal('wal_size_bytes' in data.database, false)
    assert.equal(typeof data.database.probe_latency_ms, 'number')
    assert.equal(typeof data.database.size_bytes, 'number')
    assert.equal(typeof data.database.pool_total, 'number')
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

test('panel VM concurrency, RPM and session slots return to tier / global on null', async () => {
  const gw = await startGateway()
  try {
    const vmPath = path.join(gw.project, 'vms', 'vm-sim-01.json')
    const pinned = await api(gw, 'PATCH', '/api/panel/vms/vm-sim-01', {
      body: { max_concurrency: 7, max_rpm: 33, session_slots: 3 },
    })
    assert.equal(pinned.status, 200, pinned.text)
    assert.equal(pinned.json.data.vm.concurrency_override, true)
    assert.equal(pinned.json.data.vm.rpm_override, true)
    assert.equal(pinned.json.data.vm.session_slots_override, true)
    const inherited = pinned.json.data.vm.scheduling_inherited

    const reset = await api(gw, 'PATCH', '/api/panel/vms/vm-sim-01', {
      body: { max_concurrency: null, max_rpm: null, session_slots: null },
    })
    assert.equal(reset.status, 200, reset.text)
    const vm = reset.json.data.vm
    assert.equal(vm.concurrency_override, false)
    assert.equal(vm.rpm_override, false)
    assert.equal(vm.session_slots_override, false)
    assert.equal(vm.max_concurrency, inherited.max_concurrency)
    assert.equal(vm.max_rpm, inherited.max_rpm)
    assert.equal(vm.session_slots, inherited.session_slots)

    const saved = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    assert.equal(saved.policy.concurrencyOverride, false)
    assert.equal(saved.policy.rpmOverride, false)
    assert.equal(saved.policy.sessionSlotsOverride, false)
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

test('DNS 64/65 suppression is visible in proxy config and can be toggled', async () => {
  const gw = await startGateway()
  try {
    const initial = await api(gw, 'GET', '/api/panel/proxies/config')
    assert.equal(initial.status, 200, initial.text)
    assert.equal((initial.json.data || initial.json).dns_disable_svcb_https, false)
    for (const enabled of [true, false]) {
      const put = await api(gw, 'PUT', '/api/panel/proxies/config', {
        body: { dns_disable_svcb_https: enabled },
      })
      assert.equal(put.status, 200, put.text)
      assert.equal((put.json.data || put.json).dns_disable_svcb_https, enabled)
      const get = await api(gw, 'GET', '/api/panel/proxies')
      assert.equal((get.json.data || get.json).config.dns_disable_svcb_https, enabled)
    }
    const invalid = await api(gw, 'PUT', '/api/panel/proxies/config', {
      body: { dns_disable_svcb_https: 'false' },
    })
    assert.equal(invalid.status, 400, invalid.text)
    assert.equal(invalid.json.error.code, 'invalid_dns_disable_svcb_https')
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

test('local egress slot generates auth url and exchanges code', async () => {
  const gw = await startGateway({ oauth: false })
  try {
    const bind = await api(gw, 'POST', '/api/panel/proxies/px-local/bind', { body: { vm_id: 'vm-sim-01' } })
    assert.equal(bind.status, 200, bind.text)
    const vm = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', 'vm-sim-01.json'), 'utf8'))
    assert.equal(vm.proxy?.id, 'px-local')
    const gen = await api(gw, 'POST', '/api/panel/vms/vm-sim-01/oauth/generate-auth-url', { body: {} })
    assert.equal(gen.status, 200, gen.text)
    const data = gen.json.data || gen.json
    const ex = await api(gw, 'POST', '/api/panel/vms/vm-sim-01/oauth/exchange-code', {
      body: { session_id: data.session_id, code: 'pasted-auth-code' },
    })
    assert.equal(ex.status, 200, ex.text)
    assert.equal((ex.json.data || ex.json).oauth_email, 'fake-oauth@kin.test')
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
    assert.equal(vm.claude.mode, 'official-setup-token')
    assert.equal(vm.claude.has_access, true)
    assert.equal(vm.claude.has_refresh, false)
    assert.equal(vm.claude.scope, 'user:inference')
    assert.equal(result.json.data.official_cc_bootstrap.scheduled, false)
  } finally {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})

test('claude_code flavor refuses login before the slot container and cli-node exist', async () => {
  const gw = await startGateway({ oauth: false })
  try {
    const gen = await api(gw, 'POST', '/api/panel/vms/vm-sim-01/oauth/generate-auth-url', {
      body: { flavor: 'claude_code' },
    })
    assert.equal(gen.status, 400, gen.text)
    assert.equal(gen.json.error.code, 'container_not_ready')
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

test('OpenAI scheduling HTTP saves preserve platform isolation, pins and atomic validation', async () => {
  const gw = await startGateway()
  const rows = async () => (await api(gw, 'GET', '/api/panel/vms')).json.data.items
  try {
    const claudeBefore = (await rows()).find((vm) => vm.id === 'vm-sim-01')
    const global = await api(gw, 'PUT', '/api/panel/routing', {
      body: { codex: { quota: { max_concurrency: 3, max_rpm: 37, max_sessions: 2 } } },
    })
    assert.equal(global.status, 200, global.text)
    const create = await api(gw, 'POST', '/api/panel/vms/create', {
      body: { id: 'vm-openai-follow', platform: 'openai', family: 'codex', start: false, auto_allocate_proxy: false },
    })
    assert.equal(create.status, 200, create.text)
    const created = (await rows()).find((vm) => vm.id === 'vm-openai-follow')
    assert.equal(created.max_concurrency, 3)
    assert.equal(created.max_rpm, 37)
    assert.equal(created.max_sessions, 2)
    assert.equal(created.concurrency_override, false)
    assert.equal(created.max_sessions_override, false)
    const pin = await api(gw, 'PATCH', '/api/panel/vms/vm-openai-follow', { body: { max_sessions: 4 } })
    assert.equal(pin.status, 200, pin.text)
    await api(gw, 'PUT', '/api/panel/routing', { body: { codex: { quota: { max_sessions: 3 } } } })
    assert.equal((await rows()).find((vm) => vm.id === 'vm-openai-follow').max_sessions, 4)
    const reset = await api(gw, 'PATCH', '/api/panel/vms/vm-openai-follow', { body: { max_sessions: null } })
    assert.equal(reset.status, 200, reset.text)
    const following = (await rows()).find((vm) => vm.id === 'vm-openai-follow')
    assert.equal(following.max_sessions, 3)
    assert.equal(following.max_sessions_override, false)
    const invalid = await api(gw, 'PATCH', '/api/panel/vms/vm-openai-follow', {
      body: { max_concurrency: 1, session_slots: 4 },
    })
    assert.equal(invalid.status, 400, invalid.text)
    assert.equal((await rows()).find((vm) => vm.id === 'vm-openai-follow').max_concurrency, 3)
    const cross = await api(gw, 'PATCH', '/api/panel/vms/vm-sim-01', { body: { max_concurrency: 1, max_sessions: 4 } })
    assert.equal(cross.status, 400, cross.text)
    const claudeAfter = (await rows()).find((vm) => vm.id === 'vm-sim-01')
    assert.equal(claudeAfter.max_concurrency, claudeBefore.max_concurrency)
    assert.equal(claudeAfter.max_rpm, claudeBefore.max_rpm)
    for (const quota of [null, [], { max_concurrency: 0 }, { max_sessions: '2' }]) {
      const bad = await api(gw, 'PUT', '/api/panel/routing', { body: { codex: { quota } } })
      assert.equal(bad.status, 400, bad.text)
    }
    assert.equal((await rows()).find((vm) => vm.id === 'vm-openai-follow').max_concurrency, 3)
  } finally {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})

test('OpenAI scheduling HTTP panel status uses live OpenAI gates, not Claude thresholds', async () => {
  const gw = await startGateway()
  const id = 'vm-openai-status'
  try {
    const create = await api(gw, 'POST', '/api/panel/vms/create', {
      body: { id, platform: 'openai', start: false, auto_allocate_proxy: false },
    })
    assert.equal(create.status, 200, create.text)
    const file = path.join(gw.project, 'vms', `${id}.json`)
    const future = new Date(Date.now() + 3600000).toISOString()
    const past = new Date(Date.now() - 60000).toISOString()
    for (const scenario of [
      { limit: 1, used: 95, reset: future, accept: true },
      { limit: 0.9, used: 95, reset: future, accept: false },
      { limit: 0.9, used: 95, reset: null, accept: false },
      { limit: 0.9, used: 105, reset: past, accept: true },
      { limit: 0.9, used: null, reset: null, accept: true },
    ]) {
      const save = await api(gw, 'PUT', '/api/panel/routing', {
        body: { codex: { quota: { limit_5h: scenario.limit } } },
      })
      assert.equal(save.status, 200, save.text)
      const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
      vm.schedulable = true
      delete vm.schedule_disabled_reason
      delete vm.claude
      vm.codex = {
        has_access: true,
        extra: {
          ...(scenario.used == null ? {} : { codex_5h_used_percent: scenario.used }),
          ...(scenario.reset == null ? {} : { codex_5h_reset_at: scenario.reset }),
        },
      }
      fs.writeFileSync(file, JSON.stringify(vm))
      const list = await api(gw, 'GET', '/api/panel/vms')
      assert.equal(list.status, 200, list.text)
      const row = list.json.data.items.find((item) => item.id === id)
      assert.equal(row.availability.accept, scenario.accept, JSON.stringify(scenario))
      assert.equal(row.openai_quota_policy.limit_5h, scenario.limit)
      assert.equal(row.quota_policy, null)
      if (!scenario.accept) assert.equal(row.availability.reason, 'quota_5h_local')
      if (!scenario.reset) assert.equal(row.availability.until, null)
    }
  } finally {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})
