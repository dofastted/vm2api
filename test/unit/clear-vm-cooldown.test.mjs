import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearVmCooldown } from '../../src/lib/admin/panel-api.mjs'

function seedVm(project, id = 'vm-11') {
  const dir = path.join(project, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  const rec = {
    id,
    status: 'running',
    schedulable: true,
    account_uuid: 'acct-11',
    claude: { account_uuid: 'acct-11', has_refresh: true, has_access: true },
  }
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rec))
  return rec
}

test('clearVmCooldown 404s unknown slots', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cool-'))
  const out = await clearVmCooldown({ cfg: { paths: { project } }, id: 'vm-missing' })
  assert.equal(out.status, 404)
  assert.equal(out.body.ok, false)
})

test('clearVmCooldown drops runtime leftover and usage 429 flag', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cool-'))
  seedVm(project)
  const runtime = new Map()
  runtime.set('acct-11', {
    account_id: 'acct-11',
    vm_id: 'vm-11',
    status: 'cooldown',
    cooldown_until: Date.now() + 600_000,
    cooldown_reason: 'authentication_failed_after_refresh',
    model_states: { 'claude-opus-5': { cooldown_until: Date.now() + 60_000 } },
  })
  const accounts = new Map()
  accounts.set('acct-11', {
    account_id: 'acct-11',
    vm_id: 'vm-11',
    unified: {
      usage_rate_limited_until: new Date(Date.now() + 60_000).toISOString(),
      last_probe: { ok: true, source: 'official-cc-usage', rate_limited: true },
    },
  })
  const unbound = []
  let woken = 0
  const out = await clearVmCooldown({
    cfg: { paths: { project } },
    id: 'vm-11',
    accountQuota: {
      snapshot: () => ({ accounts: [...accounts.values()] }),
      repo: {
        get: (id) => accounts.get(id) || null,
        save: (row) => {
          accounts.set(row.account_id, row)
          return row
        },
      },
      runtimeRepo: {
        get: (id) => runtime.get(id) || null,
        clearAccountCooldown(id, { vmId } = {}) {
          const cur = runtime.get(id)
          if (!cur) return false
          runtime.set(id, {
            ...cur,
            vm_id: cur.vm_id || vmId,
            status: 'ready',
            cooldown_until: null,
            cooldown_reason: null,
            model_states: {},
          })
          return true
        },
      },
    },
    stickyRouter: {
      unbindByAccount: (arg) => unbound.push(arg),
    },
    poolScheduler: {
      notifyCapacity: () => {
        woken += 1
      },
    },
  })
  assert.equal(out.ok, true)
  assert.equal(out.data.cleared, true)
  assert.equal(out.data.cooldown_until, null)
  assert.equal(runtime.get('acct-11').cooldown_reason, null)
  assert.equal(runtime.get('acct-11').cooldown_until, null)
  assert.equal(accounts.get('acct-11').unified.usage_rate_limited_until, undefined)
  assert.equal(accounts.get('acct-11').unified.last_probe.rate_limited, false)
  assert.ok(unbound.some((item) => item.accountId === 'acct-11' && item.vmId === 'vm-11'))
  assert.equal(woken, 1)
})

test('clearVmCooldown drops the on-disk park and refreshes a rejected 5h window', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cool-'))
  const rec = seedVm(project)
  rec.claude.temp_unschedulable_until = Date.now() + 60_000
  rec.claude.temp_unschedulable_reason = 'quota_5h_header'
  rec.temp_unschedulable_until = rec.claude.temp_unschedulable_until
  rec.temp_unschedulable_reason = 'quota_5h_header'
  fs.writeFileSync(path.join(project, 'vms', 'vm-11.json'), JSON.stringify(rec))
  const accounts = new Map()
  accounts.set('acct-11', {
    account_id: 'acct-11',
    vm_id: 'vm-11',
    unified: {
      headers: {
        '5h': { utilization: 1, status: 'rejected', reset: '1790032800' },
      },
    },
  })
  const out = await clearVmCooldown({
    cfg: { paths: { project } },
    id: 'vm-11',
    accountQuota: {
      repo: {
        get: (id) => accounts.get(id) || null,
        save: (row) => {
          accounts.set(row.account_id, row)
          return row
        },
      },
    },
  })
  const saved = JSON.parse(fs.readFileSync(path.join(project, 'vms', 'vm-11.json'), 'utf8'))
  assert.equal(out.ok, true)
  assert.equal(out.data.refreshed, true)
  assert.equal(out.data.headers_refreshed, 1)
  assert.equal(out.data.temp_unschedulable_reason, null)
  assert.equal(saved.claude.temp_unschedulable_reason, undefined)
  assert.equal(accounts.get('acct-11').unified.headers['5h'].status, 'allowed')
  assert.equal(accounts.get('acct-11').unified.headers['5h'].stale_reason, 'operator_clear')
})
