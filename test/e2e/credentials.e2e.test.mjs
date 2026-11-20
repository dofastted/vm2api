import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startGateway, api, seedVm } from '../harness.mjs'

test('sessionKey import writes via persistOauthToVm (fake oauth)', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'POST', '/api/panel/vms/import', {
      body: {
        vm_id: 'vm-sim-01',
        sessionKey: 'sk-ant-sid-test-bbbbbbbb',
        require_proxy: false,
      },
    })
    assert.equal(r.status, 200, r.text)
    const rec = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', 'vm-sim-01.json'), 'utf8'))
    assert.equal(rec.claude.email, 'fake-oauth@kin.test')
    assert.equal(rec.claude.access_token, undefined)
    assert.equal(rec.claude.has_access, true)
    assert.equal(rec.claude.has_refresh, true)
    assert.equal(rec.claude.source, 'KIN_FAKE_SESSION_OAUTH')
    assert.ok(rec.claude._token_version)
    assert.equal(rec.claude.session_key, undefined)
  } finally {
    await gw.stop()
  }
})

test('Go slot worker owns refresh; gateway no longer harvests CLI credentials', async () => {
  const gw = await startGateway()
  try {
    const home = path.join(gw.project, 'vms', 'vm-sim-01', 'cli-home', '.claude')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(
      path.join(home, 'credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-HARVESTED',
          refreshToken: 'sk-ant-ort01-HARVESTED',
          expiresAt: Date.now() + 8 * 3600 * 1000,
        },
      }),
    )
    const r = await api(gw, 'POST', '/admin/vm/oauth/refresh', { body: {} })
    assert.equal(r.status, 200, r.text)
    assert.notEqual(r.json.grant_type, 'refresh_token')
    assert.equal(r.json.refresh_owner, 'go-slot-worker')
    assert.equal(r.json.proxy_required, true)
    const panelRefresh = await api(gw, 'POST', '/api/panel/vms/vm-sim-01/oauth/refresh', { body: {} })
    assert.equal(panelRefresh.status, 200, panelRefresh.text)
    assert.equal(panelRefresh.json.ok, true)
    assert.equal(panelRefresh.json.data.refresh_owner, 'go-slot-worker')
    assert.equal(panelRefresh.json.data.grant_type, undefined)
    assert.equal(panelRefresh.json.data.credential.has_refresh, true)
    assert.equal(panelRefresh.json.data.access_token, undefined)
    assert.equal(panelRefresh.json.data.refresh_token, undefined)
    assert.equal(panelRefresh.json.data.error, undefined)
    const missing = await api(gw, 'POST', '/api/panel/vms/vm-missing/oauth/refresh', { body: {} })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.ok, false)
    const rec = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', 'vm-sim-01.json'), 'utf8'))
    assert.ok(rec.claude.has_access || rec.claude.access_token)
  } finally {
    await gw.stop()
  }
})

test('reset destroys home and recreates the same slot without oauth', async () => {
  const gw = await startGateway()
  try {
    const home = path.join(gw.project, 'vms', 'vm-sim-01', 'cli-home', '.claude')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ leftover: true }))
    fs.writeFileSync(path.join(home, 'stale.txt'), 'wipe-me')
    const before = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', 'vm-sim-01.json'), 'utf8'))
    const r = await api(gw, 'POST', '/api/panel/vms/vm-sim-01/reset', { body: {} })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.data.recreated, true)
    const rec = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', 'vm-sim-01.json'), 'utf8'))
    assert.equal(rec.id, 'vm-sim-01')
    assert.equal(rec.name, before.name)
    assert.deepEqual(rec.claude, {})
    assert.equal(rec.schedulable, false)
    assert.ok(
      rec.schedule_disabled_reason === 'no_credential' ||
        /worker binary not found|runtime start failed/i.test(rec.schedule_disabled_reason || ''),
    )
    assert.equal(rec.proxy?.url, before.proxy?.url)
    assert.notEqual(rec.fingerprint?.device_id, before.fingerprint?.device_id)
    assert.equal(fs.existsSync(path.join(home, 'credentials.json')), false)
    assert.equal(fs.existsSync(path.join(home, 'stale.txt')), false)
    assert.equal(fs.existsSync(path.join(home, 'settings.json')), true)
  } finally {
    await gw.stop()
  }
})

test('panel exports and replaces slot credentials using account JSON', async () => {
  const gw = await startGateway()
  try {
    const empty = await api(gw, 'GET', '/api/panel/vms/vm-sim-01/oauth/credential')
    assert.equal(empty.status, 200, empty.text)
    assert.equal(empty.json.data.has_token, false)
    assert.equal(empty.json.data.export.type, 'sub2api-data')
    assert.equal(empty.json.data.export.accounts[0].platform, 'anthropic')

    const home = path.join(gw.project, 'vms', 'vm-sim-01', 'cli-home', '.claude')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(
      path.join(home, 'credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-EXPORT',
          refreshToken: 'sk-ant-ort01-EXPORT',
          expiresAt: 1787486457000,
          email: 'export@kin.test',
          accountUuid: 'acct-export',
          orgUuid: 'org-export',
        },
      }),
    )
    const got = await api(gw, 'GET', '/api/panel/vms/vm-sim-01/oauth/credential')
    assert.equal(got.status, 200, got.text)
    const exp = got.json.data.export
    assert.equal(got.json.data.has_token, true)
    assert.equal(exp.accounts[0].credentials.access_token, 'sk-ant-oat01-EXPORT')
    assert.equal(exp.accounts[0].credentials.expires_at, 1787486457)
    const detail = await api(gw, 'GET', '/api/panel/vms/vm-sim-01')
    assert.equal(detail.status, 200, detail.text)
    assert.equal(detail.json.data?.vm?.access_token, undefined)
    assert.equal(detail.json.data?.account?.access_token, undefined)

    const put = await api(gw, 'PUT', '/api/panel/vms/vm-sim-01/oauth/credential', {
      body: {
        accounts: [
          {
            platform: 'anthropic',
            type: 'oauth',
            credentials: {
              access_token: 'sk-ant-oat01-REPLACED',
              refresh_token: 'sk-ant-ort01-REPLACED',
              expires_at: 1787486999,
              email_address: 'replaced@kin.test',
            },
          },
        ],
      },
    })
    assert.equal(put.status, 200, put.text)
    assert.equal(put.json.data.official_cc_bootstrap?.reason, 'credential_edit')
    assert.equal(put.json.data.vm?.access_token, undefined)
    const rec = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', 'vm-sim-01.json'), 'utf8'))
    assert.equal(rec.claude.access_token, undefined)
    assert.equal(rec.claude.email, 'replaced@kin.test')
    assert.equal(rec.claude.has_access, true)
    const again = await api(gw, 'GET', '/api/panel/vms/vm-sim-01/oauth/credential')
    assert.equal(again.json.data.export.accounts[0].credentials.access_token, 'sk-ant-oat01-REPLACED')
    assert.equal(again.json.data.export.accounts[0].credentials.email, 'replaced@kin.test')

    const bad = await api(gw, 'PUT', '/api/panel/vms/vm-sim-01/oauth/credential', {
      body: { accounts: [{ platform: 'anthropic', type: 'oauth', credentials: {} }] },
    })
    assert.equal(bad.status, 400)
  } finally {
    await gw.stop()
  }
})
