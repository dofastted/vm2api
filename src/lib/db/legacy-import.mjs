/** One-time import of pre-database JSON files. Originals are never modified. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getDb, withTransaction, withSavepoint } from './database.mjs'
import { SettingsRepo } from './repos/settings-repo.mjs'
import { ApiKeysRepo } from './repos/api-keys-repo.mjs'
import { AccountsRepo } from './repos/accounts-repo.mjs'
import { StickyRepo } from './repos/sticky-repo.mjs'
import { ProxiesRepo } from './repos/proxies-repo.mjs'
import { VmsRepo } from './repos/vms-repo.mjs'
import { UsageLogsRepo } from './repos/usage-logs-repo.mjs'
import { isVmRecordFile } from '../vm/vm-file.mjs'

export async function runLegacyImport({ dataDir, projectRoot, db = getDb(), retainDays = 7 } = {}) {
  const settings = new SettingsRepo(db)
  const existing = await settings.get('legacy_import_done')
  if (existing) return { imported: false, already: existing }
  const counts = {
    api_keys: 0,
    accounts: 0,
    allocations: 0,
    sticky: 0,
    proxies: 0,
    request_logs: 0,
    request_log_debug: 0,
    vms: 0,
    errors: 0,
  }
  return withTransaction(db, async () => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext(current_database()),hashtext($1))', [
      `vm2api:legacy-import:${db.schema}`,
    ])
    const already = await settings.get('legacy_import_done')
    if (already) return { imported: false, already }
    const safe = async (fn) => {
      try {
        return await withSavepoint(db, fn)
      } catch {
        counts.errors++
        return null
      }
    }
    const read = (file) => {
      if (!fs.existsSync(file)) return null
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        counts.errors++
        return null
      }
    }
    const keys = new ApiKeysRepo(db)
    for (const record of read(path.join(dataDir, 'api-keys.json'))?.keys || [])
      await safe(async () => {
        if (!record?.id || !record?.key || (await keys.getById(record.id)) || (await keys.getByKey(record.key))) return
        const { quota_used, ...rest } = record
        await keys.insert({
          ...rest,
          quota_requests_used: record.quota_requests_used ?? quota_used ?? 0,
          category: String(record.category || 'oauth').toLowerCase() === 'api' ? 'api' : 'oauth',
        })
        counts.api_keys++
      })
    const accounts = new AccountsRepo(db)
    for (const account of Object.values(read(path.join(dataDir, 'account-stats.json'))?.accounts || {}))
      await safe(async () => {
        if (!account?.account_id || (await accounts.get(account.account_id))) return
        await accounts.insert(account)
        for (const allocation of account.allocations || []) await accounts.addAllocation(account.account_id, allocation)
        counts.accounts++
        counts.allocations += (account.allocations || []).length
      })
    const sticky = new StickyRepo(db)
    for (const [key, record] of Object.entries(read(path.join(dataDir, 'sticky-map.json'))?.sessions || {}))
      await safe(async () => {
        if (!key || (await sticky.get(key))) return
        await sticky.upsert(key, record)
        counts.sticky++
      })
    const proxies = read(path.join(dataDir, 'proxy-pool.json'))
    if (proxies)
      await safe(async () => {
        const repo = new ProxiesRepo(db)
        if (proxies.config) await repo.setConfig(proxies.config)
        if (!(await repo.loadAll()).length && Array.isArray(proxies.proxies)) {
          await repo.replaceAll(proxies.proxies)
          counts.proxies = proxies.proxies.length
        }
      })
    const logs = new UsageLogsRepo(db)
    const root = path.join(dataDir, 'request-logs')
    const cutoff = Date.now() - retainDays * 86400_000
    const recent = (day) => {
      const ms = Date.parse(day + 'T00:00:00Z')
      return Number.isFinite(ms) && ms >= cutoff
    }
    if (fs.existsSync(root)) {
      for (const file of fs.readdirSync(root)) {
        if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) || !recent(file.slice(0, 10))) continue
        for (const line of fs.readFileSync(path.join(root, file), 'utf8').split('\n').filter(Boolean))
          await safe(async () => {
            const record = JSON.parse(line)
            record.id ||= 'log_' + crypto.randomBytes(6).toString('hex')
            if (await logs.insertSummaryIfAbsent(record)) counts.request_logs++
          })
      }
      const debug = path.join(root, 'debug')
      if (fs.existsSync(debug))
        for (const day of fs.readdirSync(debug)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !recent(day)) continue
          const dir = path.join(debug, day)
          if (!fs.statSync(dir).isDirectory()) continue
          for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')))
            await safe(async () => {
              const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
              if (
                await logs.insertDebugIfAbsent(
                  record.request_id || file.slice(0, -5),
                  record.ts || day + 'T00:00:00Z',
                  record,
                )
              )
                counts.request_log_debug++
            })
        }
    }
    const dir = projectRoot && path.join(projectRoot, 'vms')
    if (dir && fs.existsSync(dir)) {
      const vms = new VmsRepo(db)
      for (const file of fs.readdirSync(dir).filter(isVmRecordFile))
        await safe(async () => {
          const name = path.join(dir, file)
          const vm = JSON.parse(fs.readFileSync(name, 'utf8'))
          if (!vm?.id || (await vms.get(vm.id))) return
          await vms.upsertFromVmJson(vm, { mtimeMs: fs.statSync(name).mtimeMs })
          counts.vms++
        })
      const active = read(path.join(dir, 'active.json'))
      if (active?.active_vm) await vms.setActiveVmId(active.active_vm)
    }
    await settings.set('legacy_import_done', { at: new Date().toISOString(), counts })
    return { imported: true, counts }
  })
}
