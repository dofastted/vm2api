/**
 * Keeps price and model catalogs current without a manual click:
 * - models.dev price snapshot (boot + daily);
 * - Claude ids from Anthropic `/v1/models` through a live OAuth slot;
 * - GPT ids from the ChatGPT Codex catalog through a Codex OAuth slot;
 * - Gemini ids from live Gemini slots, Gemini API endpoints, and models.dev Google provider.
 * Results land in settings `model_catalog_sync` so the models page can show them.
 */
import path from 'node:path'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { runSlotOauth } from '../transport/slot-oauth.mjs'
import { getVm, listVms, vmHasClaudeCredential } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { vmHasProxyPath } from '../oauth/credential-refresh-monitor.mjs'
import { seedModelCatalog } from '../protocol/models.mjs'
import { syncWorkerModelsIntoPolicy } from '../protocol/model-policy.mjs'
import { isSyncableGeminiCatalogId, syncGeminiIdsIntoPolicy } from '../protocol/gemini-model-policy.mjs'
import { classifyAntigravityModel, indexAccountModelCatalog } from '../gemini/model-catalog.mjs'
import { fetchUpstreamModels } from './api-endpoints.mjs'
import { listModelsDevModels, modelsDevMeta, syncModelsDev } from './price-catalog.mjs'
import { syncCodexCatalog } from './vm-test-chat.mjs'

export const CATALOG_SYNC_KEY = 'model_catalog_sync'
const MODELS_DEV_EVERY_MS = 24 * 3600_000
const UPSTREAM_EVERY_MS = 6 * 3600_000
const BOOT_DELAY_MS = 5_000
const HARD_DOWN = new Set(['stopped', 'dead', 'error', 'disabled'])
// Plan tiers see different model sets (Fable is Max-only); a few accounts cover the union.
const CLAUDE_ACCOUNTS_PER_SYNC = 3
const GEMINI_SLOTS_PER_SYNC = 2

export function readCatalogSync() {
  try {
    const raw = new SettingsRepo().get(CATALOG_SYNC_KEY, null)
    return { claude: null, codex: null, gemini: null, ...(raw && typeof raw === 'object' ? raw : {}) }
  } catch {
    return { claude: null, codex: null, gemini: null }
  }
}

function writeCatalogSync(platform, status, settingsRepo = null) {
  try {
    const repo = settingsRepo || new SettingsRepo()
    const raw = repo.get(CATALOG_SYNC_KEY, null)
    const cur = { claude: null, codex: null, gemini: null, ...(raw && typeof raw === 'object' ? raw : {}) }
    repo.set(CATALOG_SYNC_KEY, { ...cur, [platform]: status })
  } catch {}
  return status
}

function syncStatus(status, { added = [], error = null } = {}) {
  return { at: new Date().toISOString(), status, added, error }
}

// listVms strips credentials; the exec needs the raw record's OAuth block.
function claudeCatalogTargets(projectRoot) {
  return listVms(projectRoot)
    .filter((vm) => vm?.id && !isCodexVm(vm) && !HARD_DOWN.has(String(vm.status || '').toLowerCase()))
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

function collectGeminiSlotModels(env, out) {
  if (!env || typeof env !== 'object') return
  const catalogIndex = indexAccountModelCatalog(env.account)
  for (const rawId of Array.isArray(env.models) ? env.models : []) {
    if (typeof rawId !== 'string' || !rawId.trim()) continue
    const hint = catalogIndex.get(rawId) || null
    const classified = classifyAntigravityModel(rawId, hint?.provider, hint?.quota_group)
    if (classified.provider !== 'google') continue
    if (!isSyncableGeminiCatalogId(classified.public_id)) continue
    out.set(classified.public_id.toLowerCase(), {
      id: classified.public_id,
      display_name: modelsDevMeta('google', classified.public_id)?.name || '',
      context: modelsDevMeta('google', classified.public_id)?.context || null,
    })
  }
}

/**
 * Sync latest Google Gemini models into `gemini_model_policy`.
 * Sources (merged, Gemini-only):
 * 1. Live authorized Gemini slots via host `list` / `models`;
 * 2. Enabled Gemini API endpoints via official `/v1beta/models`;
 * 3. `models.dev` `google` provider snapshot (refreshed when empty or requested).
 */
export async function syncGeminiCatalog({
  callGeminiHost = null,
  resolveGeminiProxy = null,
  apiEndpointStore = null,
  cfg = null,
  refreshModelsDev = false,
  fetchModelsDev = syncModelsDev,
  fetchEndpointModels = fetchUpstreamModels,
  settingsRepo = null,
} = {}) {
  const discovered = new Map()
  const sources = []
  let lastError = null

  if (typeof callGeminiHost === 'function') {
    try {
      const view = await callGeminiHost('list', {})
      const envs = Array.isArray(view?.environments) ? view.environments : []
      let liveFetched = 0
      for (const env of envs) {
        if (env?.auth_state !== 'authorized' || env.oauth_imported === true) continue
        if (env.models_discovered === true && Array.isArray(env.models) && env.models.length) {
          collectGeminiSlotModels(env, discovered)
        }
        if (liveFetched >= GEMINI_SLOTS_PER_SYNC || !env.id || !env.proxy_id) continue
        let proxyUrl = null
        try {
          proxyUrl = typeof resolveGeminiProxy === 'function' ? resolveGeminiProxy(env.proxy_id, env.id) : null
        } catch {
          proxyUrl = null
        }
        if (!proxyUrl) continue
        try {
          const refreshed = await callGeminiHost('models', {
            id: env.id,
            proxy_id: env.proxy_id,
            proxy_url: proxyUrl,
          })
          collectGeminiSlotModels(refreshed, discovered)
          liveFetched += 1
        } catch (err) {
          lastError = err?.code || String(err?.message || err)
        }
      }
      if (discovered.size > 0) sources.push('gemini_slot')
    } catch (err) {
      lastError = err?.code || String(err?.message || err)
    }
  }

  if (apiEndpointStore?.listRaw) {
    try {
      const rawEndpoints = apiEndpointStore.listRaw() || []
      const geminiEndpoints = rawEndpoints.filter(
        (ep) =>
          ep?.enabled !== false &&
          String(ep?.protocol || ep?.kind || '')
            .trim()
            .toLowerCase() === 'gemini',
      )
      for (const ep of geminiEndpoints.slice(0, 2)) {
        const activeKey = (ep.keys || []).find((k) => k?.enabled !== false && k?.api_key)
        if (!activeKey) continue
        try {
          const res = await fetchEndpointModels({
            cfg,
            kind: ep.kind || 'gemini',
            protocol: 'gemini',
            base_url: ep.base_url,
            api_key: activeKey.api_key,
            headers: ep.headers,
            auth_scheme: ep.auth_scheme,
            proxy_url: activeKey.proxy_url,
          })
          for (const row of res?.models || []) {
            const id = String(typeof row === 'string' ? row : row?.id || row?.name || '').trim()
            if (!isSyncableGeminiCatalogId(id)) continue
            const key = id.toLowerCase()
            if (!discovered.has(key)) {
              discovered.set(key, {
                id,
                display_name: (typeof row === 'object' && row?.display_name) || modelsDevMeta('google', id)?.name || '',
                context: modelsDevMeta('google', id)?.context || null,
              })
            }
          }
          if (res?.models?.length) sources.push('gemini_api')
        } catch (err) {
          lastError = err?.code || String(err?.message || err)
        }
      }
    } catch (err) {
      lastError = err?.code || String(err?.message || err)
    }
  }

  let mdGoogle = listModelsDevModels('google')
  if (refreshModelsDev || mdGoogle.length === 0) {
    try {
      await fetchModelsDev()
      mdGoogle = listModelsDevModels('google')
    } catch (err) {
      lastError = String(err?.message || err)
    }
  }
  if (mdGoogle.length) {
    for (const row of mdGoogle) {
      if (!isSyncableGeminiCatalogId(row.id)) continue
      const key = row.id.toLowerCase()
      const existing = discovered.get(key)
      discovered.set(key, {
        id: existing?.id || row.id,
        display_name: existing?.display_name || row.display_name || '',
        context: existing?.context || row.context || null,
      })
    }
    sources.push('models.dev')
  }

  if (!discovered.size) {
    const errCode = lastError || 'no_google_models'
    const status = writeCatalogSync(
      'gemini',
      syncStatus(lastError ? 'error' : 'skipped', { error: errCode }),
      settingsRepo,
    )
    return { ok: false, error: errCode, synced: 0, added: [], status }
  }

  const synced = syncGeminiIdsIntoPolicy([...discovered.values()], {
    displayNameOf: (id) => modelsDevMeta('google', id)?.name,
    contextOf: (id) => modelsDevMeta('google', id)?.context,
    source: 'google',
  })
  const status = writeCatalogSync('gemini', syncStatus('ok', { added: synced.added || [] }), settingsRepo)
  return {
    ok: true,
    synced: synced.synced,
    added: synced.added || [],
    ids: synced.ids || [],
    sources,
    status,
  }
}

/**
 * @param {{ projectRoot: string, codexCatalogVersion?: () => string, callGeminiHost?: Function | null, resolveGeminiProxy?: Function | null, getApiEndpointStore?: () => any, cfg?: any, log?: (event: object) => void }} opts
 */
export function createCatalogMonitor({
  projectRoot,
  codexCatalogVersion = () => 'auto',
  callGeminiHost = null,
  resolveGeminiProxy = null,
  getApiEndpointStore = null,
  cfg = null,
  log = () => {},
} = {}) {
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
    await syncGeminiCatalog({
      callGeminiHost,
      resolveGeminiProxy,
      apiEndpointStore: typeof getApiEndpointStore === 'function' ? getApiEndpointStore() : null,
      cfg,
    })
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
