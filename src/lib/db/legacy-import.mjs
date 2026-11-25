/**
 * One-time import of legacy JSON stores into SQLite.
 *
 * Sources (all optional — skipped when missing/corrupt):
 *   data/api-keys.json          → api_keys
 *   data/account-stats.json     → accounts + account_allocations
 *   data/sticky-map.json        → sticky_sessions
 *   data/proxy-pool.json        → proxies + settings.proxy_pool_config
 *   data/request-logs/*.jsonl   → request_logs   (recent retainDays)
 *   data/request-logs/debug/**  → request_log_debug
 *   vms/*.json + active.json    → vms + settings.active_vm
 *
 * Idempotent: guarded by settings.legacy_import_done. Original files are
 * left untouched as a rollback safety net (they are no longer read/written,
 * except vms/*.json which stay the runtime mirror surface).
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getDb, withSavepoint, withTransaction } from './database.mjs'
import { SettingsRepo } from './repos/settings-repo.mjs'
import { ApiKeysRepo } from './repos/api-keys-repo.mjs'
import { AccountsRepo } from './repos/accounts-repo.mjs'
import { StickyRepo } from './repos/sticky-repo.mjs'
import { ProxiesRepo } from './repos/proxies-repo.mjs'
import { VmsRepo } from './repos/vms-repo.mjs'
import { UsageLogsRepo } from './repos/usage-logs-repo.mjs'
import { isVmRecordFile } from '../vm/vm-file.mjs'

const IMPORT_FLAG = 'legacy_import_done'

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined // corrupt (≠ missing)
  }
}

export function runLegacyImport({ dataDir, projectRoot, db = null, retainDays = 7 } = {}) {
  const d = db || getDb()
  const settings = new SettingsRepo(d)
  const existing = settings.get(IMPORT_FLAG)
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

  withTransaction(d, () => {
    const runIsolated = (name, fn) => {
      try {
        withSavepoint(d, name, fn)
      } catch {
        counts.errors += 1
      }
    }

    // --- api keys ---
    runIsolated('imp_api_keys', () => {
      const raw = readJson(path.join(dataDir, 'api-keys.json'))
      if (raw === undefined) counts.errors += 1
      const repo = new ApiKeysRepo(d)
      for (const k of raw?.keys || []) {
        if (!k?.id || !k?.key || repo.getById(k.id) || repo.getByKey(k.key)) continue
        // legacy `quota_used` was a request counter; the column is USD now
        const { quota_used, ...rest } = k
        repo.insert({
          ...rest,
          quota_requests_used: k.quota_requests_used ?? quota_used ?? 0,
          category: String(k.category || 'oauth').toLowerCase() === 'api' ? 'api' : 'oauth',
        })
        counts.api_keys += 1
      }
    })

    // --- account stats ---
    runIsolated('imp_accounts', () => {
      const raw = readJson(path.join(dataDir, 'account-stats.json'))
      if (raw === undefined) counts.errors += 1
      const repo = new AccountsRepo(d)
      for (const acc of Object.values(raw?.accounts || {})) {
        if (!acc?.account_id || repo.get(acc.account_id)) continue
        repo.insert(acc)
        counts.accounts += 1
        for (const alloc of acc.allocations || []) {
          repo.addAllocation(acc.account_id, alloc)
          counts.allocations += 1
        }
      }
    })

    // --- sticky sessions ---
    runIsolated('imp_sticky', () => {
      const raw = readJson(path.join(dataDir, 'sticky-map.json'))
      if (raw === undefined) counts.errors += 1
      const repo = new StickyRepo(d)
      for (const [key, ent] of Object.entries(raw?.sessions || {})) {
        if (!key || repo.get(key)) continue
        repo.upsert(key, ent)
        counts.sticky += 1
      }
    })

    // --- proxy pool ---
    runIsolated('imp_proxies', () => {
      const raw = readJson(path.join(dataDir, 'proxy-pool.json'))
      if (raw === undefined) counts.errors += 1
      if (raw?.proxies?.length || raw?.config) {
        const repo = new ProxiesRepo(d)
        if (raw.config) repo.setConfig(raw.config)
        const current = repo.loadAll()
        if (!current.length && Array.isArray(raw.proxies)) {
          repo.replaceAll(raw.proxies)
          counts.proxies = raw.proxies.length
        }
      }
    })

    // --- request logs (normal summaries, recent days) ---
    runIsolated('imp_request_logs', () => {
      const repo = new UsageLogsRepo(d)
      const root = path.join(dataDir, 'request-logs')
      if (fs.existsSync(root)) {
        const cutoff = Date.now() - retainDays * 86400_000
        for (const f of fs.readdirSync(root)) {
          if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue
          const dayMs = Date.parse(f.slice(0, 10) + 'T00:00:00Z')
          if (Number.isFinite(dayMs) && dayMs < cutoff) continue
          try {
            const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n').filter(Boolean)
            for (const line of lines) {
              runIsolated('imp_reqlog_row', () => {
                const rec = JSON.parse(line)
                if (!rec?.id) rec.id = 'log_' + crypto.randomBytes(6).toString('hex')
                if (repo.insertSummaryIfAbsent(rec)) counts.request_logs += 1
              })
            }
          } catch {
            counts.errors += 1
          }
        }
        // --- debug records ---
        const dbgRoot = path.join(root, 'debug')
        if (fs.existsSync(dbgRoot)) {
          for (const day of fs.readdirSync(dbgRoot)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
            const dayMs = Date.parse(day + 'T00:00:00Z')
            if (Number.isFinite(dayMs) && dayMs < cutoff) continue
            const dir = path.join(dbgRoot, day)
            let files = []
            try {
              files = fs.readdirSync(dir).filter((x) => x.endsWith('.json'))
            } catch {
              continue
            }
            for (const f of files) {
              runIsolated('imp_debug_row', () => {
                const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
                const reqId = rec?.request_id || f.replace(/\.json$/, '')
                if (repo.insertDebugIfAbsent(reqId, rec?.ts || new Date(dayMs).toISOString(), rec)) {
                  counts.request_log_debug += 1
                }
              })
            }
          }
        }
      }
    })

    // --- vms + active ---
    runIsolated('imp_vms', () => {
      const repo = new VmsRepo(d)
      const vmsDir = projectRoot ? path.join(projectRoot, 'vms') : null
      if (vmsDir && fs.existsSync(vmsDir)) {
        for (const f of fs.readdirSync(vmsDir)) {
          if (!isVmRecordFile(f)) continue
          runIsolated('imp_vm_row', () => {
            const file = path.join(vmsDir, f)
            const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
            if (!vm?.id || repo.get(vm.id)) return
            const st = fs.statSync(file)
            repo.upsertFromVmJson(vm, { mtimeMs: st.mtimeMs })
            counts.vms += 1
          })
        }
        const active = readJson(path.join(vmsDir, 'active.json'))
        if (active?.active_vm) repo.setActiveVmId(active.active_vm)
      }
    })

    settings.set(IMPORT_FLAG, { at: new Date().toISOString(), counts })
  })

  return { imported: true, counts }
}
