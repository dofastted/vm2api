/** Panel `计费` tab payload: effective prices, sources, overrides and catalog health. */
import { getPolicyCatalogIds } from '../protocol/model-policy.mjs'
import { getGptPolicyCatalogIds, listImageToolModels } from '../protocol/gpt-model-policy.mjs'
import { readCatalogSync } from './catalog-monitor.mjs'
import { getModelsDevStatus, listPriceCatalog, listPriceOverrides, resolvePrice } from './price-catalog.mjs'

function policyPrices() {
  const ids = [...getPolicyCatalogIds(), ...getGptPolicyCatalogIds(), ...listImageToolModels().map((m) => m.id)]
  const out = {}
  for (const id of ids) {
    const hit = resolvePrice(id)
    out[id] = hit ? { id: hit.id, source: hit.source, effective: hit.price } : null
  }
  return out
}

export function buildPricing({ requestLog = null } = {}) {
  const policy = policyPrices()
  const inPolicy = new Set(Object.values(policy).flatMap((row) => (row ? [row.id] : [])))
  let unpriced = []
  try {
    unpriced = requestLog?.repo?.unpricedModels?.() || []
  } catch {
    unpriced = []
  }
  return {
    models: listPriceCatalog().map((entry) => ({ ...entry, in_policy: inPolicy.has(entry.id) })),
    models_dev: getModelsDevStatus(),
    overrides: listPriceOverrides(),
    unpriced,
    policy,
    catalog_sync: readCatalogSync(),
  }
}
