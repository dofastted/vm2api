/**
 * Keeps price and model catalogs current without a manual click:
 * - models.dev price snapshot (boot + daily);
 * - Claude ids from Anthropic `/v1/models` through a live OAuth slot;
 * - GPT ids from the ChatGPT Codex catalog through a Codex OAuth slot.
 * Results land in settings `model_catalog_sync` so the models page can show them.
 */
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { RuntimeSettings as SettingsRepo } from '../db/settings-state.mjs'
import { SettingsRepo as PersistentSettingsRepo } from '../db/repos/settings-repo.mjs'
import { RoutingConfigRepo } from '../db/repos/routing-config-repo.mjs'
import { backgroundTasksFor } from '../core/shared-background-tasks.mjs'
import { SharedVmOperations } from '../vm/shared-vm-operations.mjs'
import { runSlotOauth } from '../transport/slot-oauth.mjs'
import { getVm, listVms, vmHasClaudeCredential } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
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

async function writeCatalogSync(platform, status) {
  await new PersistentSettingsRepo().update(CATALOG_SYNC_KEY, (current) => ({
    ...(current || { claude: null, codex: null }),
    [platform]: status,
  }))
  return status
}

async function runCatalogTask(tasks, platform, scheduled, callback) {
  if (!tasks) return callback()
  const plan = scheduled
    ? { taskKey: `catalog:${platform}`, intervalMs: UPSTREAM_EVERY_MS }
    : { taskKey: `catalog:${platform}`, executionId: randomUUID() }
  const result = await tasks.run(plan, async () => {
    const value = await callback()
    return { terminal: value?.executionUncertain !== true, value, sharedResult: value }
  })
  return result.ran
    ? result.value
    : result.sharedResult || { ok: false, status: 'skipped', error: result.code, added: [] }
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
export async function syncClaudeCatalog({ projectRoot, runOauth = runSlotOauth, sharedTasks, scheduled = false } = {}) {
  const tasks = backgroundTasksFor(sharedTasks)
  return runCatalogTask(tasks, 'claude', scheduled, () =>
    syncClaudeCatalogOnce({ projectRoot, runOauth, mutations: tasks ? new SharedVmOperations(tasks.db) : null }),
  )
}

async function syncClaudeCatalogOnce({ projectRoot, runOauth, mutations }) {
  const targets = claudeCatalogTargets(projectRoot)
  if (!targets.length) return await writeCatalogSync('claude', syncStatus('skipped', { error: 'no_claude_slot' }))
  const ids = new Set()
  let successes = 0
  let lastError = null
  for (const vm of targets) {
    if (successes >= CLAUDE_ACCOUNTS_PER_SYNC) break
    let res
    const read = async () => {
      const current = getVm(projectRoot, vm.id) || vm
      const exec = {
        vmId: current.id,
        homeDir: path.join(projectRoot, 'vms', current.id, 'cli-home'),
        oauth: current.claude,
        vm: current,
      }
      const result = await runOauth(exec, 'models', { timeoutMs: 30_000 })
      return result && { ...result, vmOperationUncertain: result.transportError === true }
    }
    try {
      res = mutations ? await mutations.run(vm.id, read, { kind: 'claude_catalog' }) : await read()
    } catch (error) {
      if (!['vm_operation_active', 'vm_execution_active'].includes(error.code)) throw error
      lastError = error.code
      continue
    }
    if (res?.transportError || (!res && process.env.KIN_CRS_MOCK !== '1')) {
      return {
        ...(await writeCatalogSync(
          'claude',
          syncStatus('error', {
            error: res?.body?.error?.code || 'models_execution_unknown',
          }),
        )),
        executionUncertain: true,
      }
    }
    const list = Array.isArray(res?.body?.data) ? res.body.data : null
    if (!res?.ok || !list) {
      lastError = res?.body?.error?.code || `http_${res?.status || 0}`
      continue
    }
    successes++
    for (const row of list) if (row?.id) ids.add(String(row.id))
  }
  if (!successes) return await writeCatalogSync('claude', syncStatus('error', { error: lastError || 'models_failed' }))
  const { added } = await syncWorkerModelsIntoPolicy([...ids], {
    displayNameOf: (id) => modelsDevMeta('anthropic', id)?.name,
  })
  seedModelCatalog()
  return await writeCatalogSync('claude', syncStatus('ok', { added }))
}

/** Live ChatGPT Codex catalog → gpt_model_policy. Timers never rotate OAuth; the panel button may. */
export async function syncGptCatalog({
  projectRoot,
  vmId = '',
  catalogClientVersion = 'auto',
  rotate = false,
  sharedTasks,
  scheduled = false,
} = {}) {
  const tasks = backgroundTasksFor(sharedTasks)
  return runCatalogTask(tasks, 'codex', scheduled, async () => {
    if (tasks && scheduled) {
      const routing = await new RoutingConfigRepo(tasks.db).get()
      if (!routing)
        throw Object.assign(new Error('shared routing configuration missing'), { code: 'routing_config_unavailable' })
      catalogClientVersion = routing.config.codex?.catalog_client_version || 'auto'
    }
    return syncGptCatalogOnce({
      projectRoot,
      vmId,
      catalogClientVersion,
      rotate,
      mutations: tasks ? new SharedVmOperations(tasks.db) : undefined,
    })
  })
}

async function syncGptCatalogOnce({ projectRoot, vmId, catalogClientVersion, rotate, mutations }) {
  const result = await syncCodexCatalog({ projectRoot, vmId, rotate, catalogClientVersion, operations: mutations })
  if (!result.ok) {
    const skipped = result.error === 'no_codex_slot' || result.error === 'proxy_required'
    await writeCatalogSync('codex', syncStatus(skipped ? 'skipped' : 'error', { error: result.error }))
    return result
  }
  await writeCatalogSync('codex', syncStatus('ok', { added: result.added || [] }))
  return result
}

/**
 * @param {{ projectRoot: string, codexCatalogVersion?: () => string, log?: (event: object) => void }} opts
 */
export function createCatalogMonitor({
  projectRoot,
  codexCatalogVersion = () => 'auto',
  log = () => {},
  sharedTasks,
} = {}) {
  const tasks = backgroundTasksFor(sharedTasks)
  const timers = []
  let running = false
  const pending = new Set()
  const guard = (name, fn) => async () => {
    if (!running) return
    const operation = Promise.resolve().then(fn)
    pending.add(operation)
    try {
      const out = await operation
      log({ event: 'catalog-sync', job: name, status: out?.status ?? (out?.ok === false ? 'error' : 'ok') })
    } catch (error) {
      log({ event: 'catalog-sync', job: name, status: 'error', error: String(error?.message || error) })
    } finally {
      pending.delete(operation)
    }
  }
  const modelsDev = guard('models.dev', async () => await syncModelsDev({ sharedTasks: tasks, scheduled: true }))
  const upstream = guard('upstream', async () => {
    const claude = await syncClaudeCatalog({ projectRoot, sharedTasks: tasks, scheduled: true })
    await syncGptCatalog({
      projectRoot,
      catalogClientVersion: codexCatalogVersion(),
      sharedTasks: tasks,
      scheduled: true,
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
    async flush() {
      while (pending.size) await Promise.allSettled([...pending])
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
