/**
 * Keeps price and model catalogs current without a manual click:
 * - models.dev price snapshot (boot + daily);
 * - Claude ids from Anthropic `/v1/models` through a live OAuth slot;
 * - GPT ids from the ChatGPT Codex catalog through a Codex OAuth slot.
 * Results land in settings `model_catalog_sync` so the models page can show them.
 */
import path from 'node:path'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { runSlotOauth } from '../transport/slot-oauth.mjs'
import { getVm, listVms, vmHasClaudeCredential } from '../vm/vm-registry.mjs'
import { isCodexVm, isClaudeVm } from '../vm/vm-kind.mjs'
import { vmHasProxyPath } from '../oauth/credential-refresh-monitor.mjs'
import { seedModelCatalog } from '../protocol/models.mjs'
import { syncWorkerModelsIntoPolicy } from '../protocol/model-policy.mjs'
import { modelsDevMeta, syncModelsDev } from './price-catalog.mjs'
import { syncCodexCatalog } from './vm-test-chat.mjs'

export const CATALOG_SYNC_KEY = 'model_catalog_sync'
const MODELS_DEV_EVERY_MS = 24 * 3600_000
const UPSTREAM_EVERY_MS = 6 * 3600_000
const BOOT_DELAY_MS = 5_000
const HARD_DOWN = new Set(['stopped', 'dead', 'error', 'disabled'])
// Plan tiers see different model sets (Fable is Max-only); a few accounts cover the union.
const CLAUDE_ACCOUNTS_PER_SYNC = 3

export function readCatalogSync() {
  try {
    return new SettingsRepo().get(CATALOG_SYNC_KEY, null) || { claude: null, codex: null }
  } catch {
    return { claude: null, codex: null }
  }
}

function writeCatalogSync(platform, status) {
  const repo = new SettingsRepo()
  const cur = repo.get(CATALOG_SYNC_KEY, null) || { claude: null, codex: null }
  repo.set(CATALOG_SYNC_KEY, { ...cur, [platform]: status })
  return status
}

function syncStatus(status, { added = [], error = null } = {}) {
  return { at: new Date().toISOString(), status, added, error }
}

// listVms strips credentials; the exec needs the raw record's OAuth block.
function claudeCatalogTargets(projectRoot) {
  return listVms(projectRoot)
    .filter((vm) => vm?.id && isClaudeVm(vm) && !HARD_DOWN.has(String(vm.status || '').toLowerCase()))
    .map((vm) => getVm(projectRoot, vm.id))
    .filter((vm) => vm && vmHasClaudeCredential(vm) && vmHasProxyPath(vm))
}

/** Live Claude catalog → model_policy. */
export async function syncClaudeCatalog({ projectRoot, runOauth = runSlotOauth } = {}) {
  const targets = claudeCatalogTargets(projectRoot)
  if (!targets.length) return writeCatalogSync('claude', syncStatus('skipped', { error: 'no_claude_slot' }))
  const ids = new Set()
  let successes = 0
  let lastError = null
  for (const vm of targets) {
    if (successes >= CLAUDE_ACCOUNTS_PER_SYNC) break
    const exec = { vmId: vm.id, homeDir: path.join(projectRoot, 'vms', vm.id, 'cli-home'), oauth: vm.claude, vm }
    const res = await runOauth(exec, 'models', { timeoutMs: 30_000 })
    const list = Array.isArray(res?.body?.data) ? res.body.data : null
    if (!res?.ok || !list) {
      lastError = res?.body?.error?.code || `http_${res?.status || 0}`
      continue
    }
    successes++
    for (const row of list) if (row?.id) ids.add(String(row.id))
  }
  if (!successes) return writeCatalogSync('claude', syncStatus('error', { error: lastError || 'models_failed' }))
  const { added } = syncWorkerModelsIntoPolicy([...ids], {
    displayNameOf: (id) => modelsDevMeta('anthropic', id)?.name,
  })
  seedModelCatalog()
  return writeCatalogSync('claude', syncStatus('ok', { added }))
}

/** Live ChatGPT Codex catalog → gpt_model_policy. Timers never rotate OAuth; the panel button may. */
export async function syncGptCatalog({ projectRoot, vmId = '', catalogClientVersion = 'auto', rotate = false } = {}) {
  const result = await syncCodexCatalog({ projectRoot, vmId, rotate, catalogClientVersion })
  if (!result.ok) {
    const skipped = result.error === 'no_codex_slot' || result.error === 'proxy_required'
    writeCatalogSync('codex', syncStatus(skipped ? 'skipped' : 'error', { error: result.error }))
    return result
  }
  writeCatalogSync('codex', syncStatus('ok', { added: result.added || [] }))
  return result
}

/**
 * @param {{ projectRoot: string, codexCatalogVersion?: () => string, log?: (event: object) => void }} opts
 */
export function createCatalogMonitor({ projectRoot, codexCatalogVersion = () => 'auto', log = () => {} } = {}) {
  const timers = []
  let running = false
  const guard = (name, fn) => async () => {
    try {
      const out = await fn()
      log({ event: 'catalog-sync', job: name, status: out?.status ?? (out?.ok === false ? 'error' : 'ok') })
    } catch (error) {
      log({ event: 'catalog-sync', job: name, status: 'error', error: String(error?.message || error) })
    }
  }
  const modelsDev = guard('models.dev', () => syncModelsDev())
  const upstream = guard('upstream', async () => {
    const claude = await syncClaudeCatalog({ projectRoot })
    await syncGptCatalog({ projectRoot, catalogClientVersion: codexCatalogVersion() })
    return claude
  })

  return {
    start() {
      if (running) return
      running = true
      const boot = setTimeout(() => {
        void modelsDev().then(upstream)
      }, BOOT_DELAY_MS)
      boot.unref?.()
      timers.push(boot)
      for (const [fn, ms] of [
        [modelsDev, MODELS_DEV_EVERY_MS],
        [upstream, UPSTREAM_EVERY_MS],
      ]) {
        const t = setInterval(() => void fn(), ms)
        t.unref?.()
        timers.push(t)
      }
    },
    stop() {
      running = false
      for (const t of timers.splice(0)) {
        clearTimeout(t)
        clearInterval(t)
      }
    },
  }
}
