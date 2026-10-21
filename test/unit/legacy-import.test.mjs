import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase, getDb } from '../../src/lib/db/database.mjs'
import { runLegacyImport } from '../../src/lib/db/legacy-import.mjs'
import { ApiKeysRepo } from '../../src/lib/db/repos/api-keys-repo.mjs'
import { AccountsRepo } from '../../src/lib/db/repos/accounts-repo.mjs'
import { StickyRepo } from '../../src/lib/db/repos/sticky-repo.mjs'
import { ProxiesRepo } from '../../src/lib/db/repos/proxies-repo.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'

let root, dataDir

function seedLegacyFiles() {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(
    path.join(dataDir, 'api-keys.json'),
    JSON.stringify({
      version: 1,
      keys: [
        {
          id: 'key_legacy1',
          name: 'old',
          key: 'sk-kin-legacy-0001',
          status: 'active',
          max_concurrency: 4,
          quota_requests: 100,
          quota_used: 3,
          rpm: 0,
          expires_at: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          last_used_at: null,
          requests: 3,
          tokens_in: 300,
          tokens_out: 150,
        },
      ],
    }),
  )
  fs.writeFileSync(
    path.join(dataDir, 'account-stats.json'),
    JSON.stringify({
      accounts: {
        'acct-legacy': {
          account_id: 'acct-legacy',
          vm_id: 'vm-l1',
          email: 'l@x.io',
          max_concurrency: 2,
          requests: 7,
          tokens_in: 70,
          tokens_out: 35,
          unified: {
            '5h': { utilization: 0.3, reset: null, status: 'active' },
            '7d': { utilization: 0.1, reset: null, status: 'active' },
          },
          allocations: [
            { at: '2026-08-17T00:00:00Z', util_5h: 0.2, util_7d: 0.1, tokens_in: 10, tokens_out: 5 },
            { at: '2026-08-17T01:00:00Z', util_5h: 0.3, util_7d: 0.1, tokens_in: 20, tokens_out: 10 },
          ],
          last_blocked: null,
        },
      },
    }),
  )
  fs.writeFileSync(
    path.join(dataDir, 'sticky-map.json'),
    JSON.stringify({
      sessions: {
        'conv-legacy': {
          account_id: 'acct-legacy',
          vm_id: 'vm-l1',
          session_id: null,
          bound_at: Date.now(),
          expires_at: Date.now() + 3600_000,
          hits: 4,
        },
      },
    }),
  )
  fs.writeFileSync(
    path.join(dataDir, 'proxy-pool.json'),
    JSON.stringify({
      config: { probe_interval_min: 30, probe_timeout_ms: 8000, max_failures: 2, enabled: true },
      proxies: [
        {
          id: 'px-legacy',
          scheme: 'socks5',
          host: '10.9.9.9',
          port: 1080,
          username: 'u',
          password: 'p',
          raw: 'socks5://u:p@10.9.9.9:1080',
          status: 'ok',
          enabled: true,
          bound_vm_id: 'vm-l1',
          consecutive_failures: 0,
          latency_ms: 42,
          last_probe_at: null,
          last_error: null,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    }),
  )
  const day = new Date().toISOString().slice(0, 10)
  const rlDir = path.join(dataDir, 'request-logs')
  fs.mkdirSync(rlDir, { recursive: true })
  fs.writeFileSync(
    path.join(rlDir, `${day}.jsonl`),
    [
      JSON.stringify({ id: 'log_l1', request_id: 'rid-l1', ts: new Date().toISOString(), status: 200, model: 'm1' }),
      JSON.stringify({
        id: 'log_l2',
        request_id: 'rid-l2',
        ts: new Date().toISOString(),
        status: 500,
        error_code: 'x',
      }),
    ].join('\n') + '\n',
  )
  const dbgDir = path.join(rlDir, 'debug', day)
  fs.mkdirSync(dbgDir, { recursive: true })
  fs.writeFileSync(
    path.join(dbgDir, 'rid-l1.json'),
    JSON.stringify({ request_id: 'rid-l1', ts: new Date().toISOString(), inbound_body: { x: 1 } }),
  )

  const vmsDir = path.join(root, 'vms')
  fs.mkdirSync(vmsDir, { recursive: true })
  fs.writeFileSync(
    path.join(vmsDir, 'vm-l1.json'),
    JSON.stringify({
      id: 'vm-l1',
      name: 'legacy',
      status: 'running',
      claude: {
        access_token: 'sk-ant-oat01-LEG',
        refresh_token: 'sk-ant-ort01-LEG',
        email: 'l@x.io',
        account_uuid: 'acct-legacy',
      },
    }),
  )
  fs.writeFileSync(path.join(vmsDir, 'active.json'), JSON.stringify({ active_vm: 'vm-l1' }))
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-import-'))
  dataDir = path.join(root, 'data')
  await openDatabase({ dataDir })
})

afterEach(async () => {
  await closeDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

test('imports every legacy store and is idempotent', async () => {
  seedLegacyFiles()
  const res = await runLegacyImport({ dataDir, projectRoot: root })
  assert.equal(res.imported, true)
  assert.deepEqual(
    { ...res.counts },
    {
      api_keys: 1,
      accounts: 1,
      allocations: 2,
      sticky: 1,
      proxies: 1,
      request_logs: 2,
      request_log_debug: 1,
      vms: 1,
      errors: 0,
    },
  )
  const db = getDb()
  assert.equal((await new ApiKeysRepo(db).getById('key_legacy1')).tokens_in, 300)
  assert.equal((await new AccountsRepo(db).get('acct-legacy')).requests, 7)
  assert.equal(await new AccountsRepo(db).allocationCount('acct-legacy'), 2)
  assert.equal((await new StickyRepo(db).get('conv-legacy')).hits, 4)
  assert.equal((await new ProxiesRepo(db).loadAll())[0].bound_vm_id, 'vm-l1')
  assert.equal((await new ProxiesRepo(db).getConfig()).probe_interval_min, 30)
  assert.equal(await new UsageLogsRepo(db).count(), 2)
  assert.ok(await new UsageLogsRepo(db).getDebug('rid-l1'))
  const vmRow = await new VmsRepo(db).get('vm-l1')
  assert.equal(vmRow.access_token, null)
  assert.equal(vmRow.vm.claude.has_access, true)
  assert.equal(vmRow.vm.claude.access_token, undefined)
  assert.equal(await new VmsRepo(db).getActiveVmId(), 'vm-l1')

  // second run skips
  const res2 = await runLegacyImport({ dataDir, projectRoot: root })
  assert.equal(res2.imported, false)
  assert.ok(res2.already?.at)
  assert.equal(await new ApiKeysRepo(db).count(), 1)

  // original files untouched
  assert.ok(fs.existsSync(path.join(dataDir, 'api-keys.json')))
  assert.ok(fs.existsSync(path.join(dataDir, 'proxy-pool.json')))
})

test('missing files import cleanly with zero counts', async () => {
  const res = await runLegacyImport({ dataDir, projectRoot: root })
  assert.equal(res.imported, true)
  assert.equal(
    Object.values(res.counts).reduce((a, b) => a + b, 0),
    0,
  )
})

test('corrupt file is skipped, counted as error, others still import', async () => {
  seedLegacyFiles()
  fs.writeFileSync(path.join(dataDir, 'api-keys.json'), '{ not json')
  const res = await runLegacyImport({ dataDir, projectRoot: root })
  assert.equal(res.imported, true)
  assert.equal(res.counts.api_keys, 0)
  assert.ok(res.counts.errors >= 1)
  assert.equal(res.counts.accounts, 1)
  assert.equal(res.counts.vms, 1)
  assert.ok(await new SettingsRepo(getDb()).get('legacy_import_done'))
})
