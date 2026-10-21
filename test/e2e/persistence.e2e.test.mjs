/**
 * E2E: PostgreSQL persistence across gateway restarts + legacy JSON import.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGateway, api } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

function openDb(gw) {
  return gw.db
}

test('data survives a full gateway restart on the same data dir', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-persist-'))
  let gw = await startGateway({ project })
  let created
  try {
    // 1. create a managed API key
    const r = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'persist-e2e', quota_requests: 50 },
    })
    assert.equal(r.status, 201, r.text)
    created = r.json.item
    assert.match(created.key, /^sk-vm-/)

    // 2. run one inference with the managed key → usage + request log
    const m = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${created.key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'persist-ping' }] },
    })
    assert.equal(m.status, 200, m.text)
  } finally {
    await gw.stop()
  }

  // 3. restart on the same project/data dir
  gw = await startGateway({ project })
  try {
    const list = await api(gw, 'GET', '/api/panel/api-keys')
    assert.equal(list.status, 200)
    const found = (list.json.keys || []).find((k) => k.id === created.id)
    assert.ok(found, 'api key must survive restart')
    assert.equal(found.name, 'persist-e2e')
    assert.equal(found.requests, 1, 'usage counter persisted')
    assert.equal(found.quota_used, 1)

    const logs = await api(gw, 'GET', '/api/panel/request-logs?limit=20')
    assert.equal(logs.status, 200)
    const entry = (logs.json.items || []).find((l) => l.api_key_id === created.id)
    assert.ok(entry, 'request log row must survive restart')
    assert.equal(entry.status, 200)
    assert.equal(typeof logs.json.total, 'number')

    // stats endpoint aggregates from the DB
    const stats = await api(gw, 'GET', '/api/panel/request-logs/stats?bucket=day')
    assert.equal(stats.status, 200)
    assert.ok(stats.json.totals.requests >= 1)
    assert.ok(Array.isArray(stats.json.buckets))
  } finally {
    await gw.stop()
  }
})

test('vm credentials are mirrored into the vms table (入库)', async () => {
  const gw = await startGateway({})
  try {
    // seeded VM has oauth in vms/vm-sim-01.json — reconcile mirrors it at boot
    const db = openDb(gw)
    try {
      const row = await db.prepare('SELECT * FROM vms WHERE id = $1').get('vm-sim-01')
      assert.ok(row, 'vms row must exist')
      assert.equal(row.access_token, null)
      assert.equal(row.refresh_token, null)
      assert.equal(row.email, 'seed@kin.test')
      const vmJson = JSON.parse(row.vm_json)
      assert.equal(vmJson.claude.access_token, undefined)
      assert.equal(vmJson.claude.has_access, true)
      assert.equal(vmJson.claude.has_refresh, true)
      const active = await db.prepare("SELECT value FROM settings WHERE key = 'active_vm'").get()
      assert.equal(JSON.parse(active.value), 'vm-sim-01')
    } finally {
      // The gateway harness owns this connection.
    }

    // sessionKey import (fake) writes through persistOauthToVm → DB mirror updates
    const imp = await api(gw, 'POST', '/api/panel/vms/import', {
      body: { vm_id: 'vm-sim-01', sessionKey: 'sk-ant-sid01-' + 'e'.repeat(24), require_proxy: false },
    })
    assert.equal(imp.status, 200, imp.text)
    const db2 = openDb(gw)
    try {
      const row = await db2.prepare('SELECT access_token, session_key, vm_json FROM vms WHERE id = $1').get('vm-sim-01')
      assert.equal(row.access_token, null)
      assert.equal(row.session_key, null)
      const vmJson = JSON.parse(row.vm_json)
      assert.equal(vmJson.claude.session_key, undefined)
      assert.equal(vmJson.claude.has_access, true)
    } finally {
      // The gateway harness owns this connection.
    }
  } finally {
    await gw.stop()
  }
})

test('legacy JSON files are imported once at first boot', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-legacy-'))
  const dataDir = path.join(project, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  // seed legacy stores in the old JSON formats
  fs.writeFileSync(
    path.join(dataDir, 'api-keys.json'),
    JSON.stringify({
      version: 1,
      keys: [
        {
          id: 'key_oldjson',
          name: 'from-legacy-file',
          key: 'sk-kin-legacy-e2e-0001',
          status: 'active',
          max_concurrency: 2,
          quota_requests: 0,
          quota_used: 5,
          rpm: 0,
          expires_at: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          last_used_at: null,
          requests: 5,
          tokens_in: 100,
          tokens_out: 50,
        },
      ],
    }),
  )
  const day = new Date().toISOString().slice(0, 10)
  fs.mkdirSync(path.join(dataDir, 'request-logs'), { recursive: true })
  fs.writeFileSync(
    path.join(dataDir, 'request-logs', `${day}.jsonl`),
    JSON.stringify({
      id: 'log_oldjson',
      request_id: 'rid-oldjson',
      ts: new Date().toISOString(),
      status: 200,
      model: 'm-legacy',
    }) + '\n',
  )

  const gw = await startGateway({ project })
  try {
    // legacy key authenticates + shows in the panel
    const list = await api(gw, 'GET', '/api/panel/api-keys')
    const k = (list.json.keys || []).find((x) => x.id === 'key_oldjson')
    assert.ok(k, 'legacy api key imported')
    assert.equal(k.name, 'from-legacy-file')
    assert.equal(k.requests, 5)

    const m = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: 'Bearer sk-kin-legacy-e2e-0001' },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'legacy-key-works' }] },
    })
    assert.equal(m.status, 200, m.text)

    const logs = await api(gw, 'GET', '/api/panel/request-logs?q=rid-oldjson')
    assert.equal(logs.json.total, 1, 'legacy request log imported')

    // import flag recorded; original files untouched
    const db = openDb(gw)
    try {
      const flag = JSON.parse(
        (await db.prepare("SELECT value FROM settings WHERE key = 'legacy_import_done'").get()).value,
      )
      assert.equal(flag.counts.api_keys, 1)
      assert.equal(flag.counts.request_logs, 1)
    } finally {
      // The gateway harness owns this connection.
    }
    assert.ok(fs.existsSync(path.join(dataDir, 'api-keys.json')))
  } finally {
    await gw.stop()
  }

  // second boot must not duplicate
  const gw2 = await startGateway({ project })
  try {
    const list = await api(gw2, 'GET', '/api/panel/api-keys')
    const dupes = (list.json.keys || []).filter((x) => x.id === 'key_oldjson')
    assert.equal(dupes.length, 1, 'no duplicate import on second boot')
  } finally {
    await gw2.stop()
  }
})
