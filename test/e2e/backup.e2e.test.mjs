/**
 * E2E: local backup — manual create/list/download/restore/config,
 * automatic scheduled backup (boot catch-up), retention pruning.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { startGateway, api } from '../harness.mjs'

test('manual backup → download → mutate → restore rolls back', async () => {
  // disable auto backup so record counts stay deterministic
  const gw = await startGateway({ env: { KIN_BACKUP_DISABLED: '1' } })
  try {
    // state to protect
    const k1 = await api(gw, 'POST', '/api/panel/api-keys', { body: { name: 'kept' } })
    assert.equal(k1.status, 201)

    // 1. create backup
    const b = await api(gw, 'POST', '/api/panel/backups')
    assert.equal(b.status, 201, b.text)
    const rec = b.json.item
    assert.equal(rec.status, 'ok')
    assert.equal(rec.kind, 'manual')
    assert.ok(rec.size_bytes > 0)
    assert.ok(rec.includes.vms >= 1, 'vm files included')

    // 2. list
    const list = await api(gw, 'GET', '/api/panel/backups')
    assert.equal(list.status, 200)
    assert.ok(list.json.items.some((x) => x.id === rec.id))
    assert.equal(list.json.config.enabled, false) // env disabled
    assert.equal(list.json.restoring, false)

    // 3. download and verify the archive is a valid tar.gz containing the db
    const res = await fetch(`${gw.baseUrl}/api/panel/backups/${rec.id}/download`, {
      headers: { authorization: `Bearer ${gw.apiKey}` },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/gzip')
    const buf = Buffer.from(await res.arrayBuffer())
    assert.equal(buf.length, rec.size_bytes)
    // gzip magic
    assert.equal(buf[0], 0x1f)
    assert.equal(buf[1], 0x8b)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bak-dl-'))
    fs.writeFileSync(path.join(tmp, 'a.tar.gz'), buf)
    const tar = spawnSync('tar', ['-xzf', path.join(tmp, 'a.tar.gz'), '-C', tmp])
    assert.equal(tar.status, 0)
    assert.ok(fs.existsSync(path.join(tmp, 'db', 'postgres.dump')))
    assert.ok(fs.existsSync(path.join(tmp, 'manifest.json')))
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'))
    assert.equal(manifest.version, 2)
    fs.rmSync(tmp, { recursive: true, force: true })

    // 4. mutate state after the backup
    const k2 = await api(gw, 'POST', '/api/panel/api-keys', { body: { name: 'lost-after-restore' } })
    assert.equal(k2.status, 201)

    // 5. restore requires confirm
    const noConfirm = await api(gw, 'POST', `/api/panel/backups/${rec.id}/restore`, { body: {} })
    assert.equal(noConfirm.status, 400)
    assert.equal(noConfirm.json.error.code, 'confirm_required')

    const restored = await api(gw, 'POST', `/api/panel/backups/${rec.id}/restore`, { body: { confirm: true } })
    assert.equal(restored.status, 200, restored.text)
    assert.equal(restored.json.restored, rec.id)
    assert.ok(restored.json.pre_restore, 'pre_restore snapshot id returned')

    // 6. state rolled back — kept key survives, later key is gone
    const keys = await api(gw, 'GET', '/api/panel/api-keys')
    const names = (keys.json.keys || []).map((k) => k.name)
    assert.ok(names.includes('kept'))
    assert.ok(!names.includes('lost-after-restore'))

    // gateway still serves inference after restore
    const m = await api(gw, 'POST', '/v1/messages', {
      body: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'after-restore' }],
      },
    })
    assert.equal(m.status, 200, m.text)

    // ledger after restore still shows the pre_restore snapshot (undo path)
    const after = await api(gw, 'GET', '/api/panel/backups')
    assert.ok(
      after.json.items.some((x) => x.id === restored.json.pre_restore && x.kind === 'pre_restore'),
      'pre_restore record visible in panel after restore',
    )
  } finally {
    await gw.stop()
  }
})

test('restore rebinds billing, API scheduler, and routing config without restart', async () => {
  const gw = await startGateway({ env: { KIN_BACKUP_DISABLED: '1' } })
  try {
    const routingBefore = await api(gw, 'PUT', '/api/panel/routing', {
      body: {
        compatibility: { cache_ttl: '5m' },
        failover: { max_total_attempts: 2 },
      },
    })
    assert.equal(routingBefore.status, 200, routingBefore.text)

    const endpointBefore = await api(gw, 'POST', '/api/panel/api-endpoints', {
      body: {
        name: 'before-restore',
        base_url: 'https://before.invalid',
        api_key_entries: [{ api_key: 'sk-before-restore-secret' }],
        models: [{ name: 'upstream-before', alias: 'backup-model' }],
      },
    })
    assert.equal(endpointBefore.status, 201, endpointBefore.text)
    const endpointBeforeId = endpointBefore.json.item.id

    const keyResponse = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'api-model-catalog', category: 'api' },
    })
    assert.equal(keyResponse.status, 201, keyResponse.text)
    const apiKey = keyResponse.json.item.key

    await gw.db.exec('UPDATE groups SET rate_multiplier = 0 WHERE id = 1')

    const backup = await api(gw, 'POST', '/api/panel/backups')
    assert.equal(backup.status, 201, backup.text)
    const backupId = backup.json.item.id

    await gw.db.exec('UPDATE groups SET rate_multiplier = 2 WHERE id = 1')
    assert.equal((await api(gw, 'DELETE', `/api/panel/api-endpoints/${endpointBeforeId}`)).status, 200)
    const endpointAfter = await api(gw, 'POST', '/api/panel/api-endpoints', {
      body: {
        name: 'after-restore',
        base_url: 'https://after.invalid',
        api_key_entries: [{ api_key: 'sk-after-restore-secret' }],
        models: [{ name: 'upstream-after', alias: 'mutated-model' }],
      },
    })
    assert.equal(endpointAfter.status, 201, endpointAfter.text)
    const routingAfter = await api(gw, 'PUT', '/api/panel/routing', {
      body: {
        compatibility: { cache_ttl: '1h' },
        failover: { max_total_attempts: 12 },
      },
    })
    assert.equal(routingAfter.status, 200, routingAfter.text)

    const restored = await api(gw, 'POST', `/api/panel/backups/${backupId}/restore`, {
      body: { confirm: true },
    })
    assert.equal(restored.status, 200, restored.text)

    const routing = await api(gw, 'GET', '/api/panel/routing')
    assert.equal(routing.status, 200, routing.text)
    assert.equal(routing.json.data.compatibility.cache_ttl, '5m')
    assert.equal(routing.json.data.failover.max_total_attempts, 2)

    const models = await api(gw, 'GET', '/v1/models', {
      headers: { authorization: `Bearer ${apiKey}` },
    })
    assert.equal(models.status, 200, models.text)
    const modelIds = (models.json.data || []).map((model) => model.id)
    assert.ok(modelIds.includes('backup-model'))
    assert.ok(!modelIds.includes('mutated-model'))

    const requestId = `restore-rebind-${Date.now()}`
    const inference = await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-request-id': requestId },
      body: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'after runtime rebind' }],
      },
    })
    assert.equal(inference.status, 200, inference.text)
    const logs = await api(gw, 'GET', `/api/panel/request-logs?q=${requestId}&limit=10`)
    assert.equal(logs.status, 200, logs.text)
    const row = (logs.json.items || []).find((item) => item.request_id === requestId)
    assert.ok(row, 'request after restore must persist through the rebound log store')
    assert.equal(row.rate_multiplier, 0)
    assert.equal(row.actual_cost, 0)
  } finally {
    await gw.stop()
  }
})

test('backup config get/update via panel', async () => {
  const gw = await startGateway({ env: { KIN_BACKUP_DISABLED: '1' } })
  try {
    const g = await api(gw, 'GET', '/api/panel/backups/config')
    assert.equal(g.status, 200)
    assert.equal(g.json.config.interval_hours, 24)
    assert.equal(g.json.config.retention, 7)

    const put = await api(gw, 'PUT', '/api/panel/backups/config', {
      body: { interval_hours: 6, retention: 3 },
    })
    assert.equal(put.status, 200, put.text)
    assert.equal(put.json.config.interval_hours, 6)
    assert.equal(put.json.config.retention, 3)

    const bad = await api(gw, 'PUT', '/api/panel/backups/config', { body: { retention: 0 } })
    assert.equal(bad.status, 400)
  } finally {
    await gw.stop()
  }
})

test('automatic scheduled backup runs at boot catch-up (default enabled)', async () => {
  // default schedule is enabled; boot catch-up timer fires ~5s after start
  const gw = await startGateway({})
  try {
    let items = []
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
      const list = await api(gw, 'GET', '/api/panel/backups')
      items = list.json.items || []
      if (items.some((x) => x.kind === 'scheduled' && x.status === 'ok')) break
    }
    const auto = items.find((x) => x.kind === 'scheduled' && x.status === 'ok')
    assert.ok(auto, 'scheduled backup should run automatically after boot')
    assert.ok(fs.existsSync(auto.file_path))
    // next_auto_at now points ~interval ahead
    const list = await api(gw, 'GET', '/api/panel/backups')
    assert.ok(list.json.next_auto_at, 'next auto backup scheduled')
    assert.ok(Date.parse(list.json.next_auto_at) > Date.now() + 3600_000)
  } finally {
    await gw.stop()
  }
})

test('delete backup removes record + file', async () => {
  const gw = await startGateway({ env: { KIN_BACKUP_DISABLED: '1' } })
  try {
    const b = await api(gw, 'POST', '/api/panel/backups')
    const rec = b.json.item
    const del = await api(gw, 'DELETE', `/api/panel/backups/${rec.id}`)
    assert.equal(del.status, 200)
    assert.equal(fs.existsSync(rec.file_path), false)
    const list = await api(gw, 'GET', '/api/panel/backups')
    assert.ok(!list.json.items.some((x) => x.id === rec.id))
  } finally {
    await gw.stop()
  }
})
