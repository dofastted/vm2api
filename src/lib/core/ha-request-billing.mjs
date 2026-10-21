import { catalogIdCandidates, resolvePrice, validatePrice } from '../admin/price-catalog.mjs'
import { calculateCostAtPrice } from '../admin/pricing.mjs'
import { applyCacheTtlToUsage } from '../protocol/cache-ttl.mjs'
import { normalizeNodeReceipt } from './node-execution-proof.mjs'

function invalid() {
  throw Object.assign(new Error('invalid HA billing snapshot'), { code: 'ha_billing_snapshot_invalid' })
}
function text(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) invalid()
  return value
}

export function normalizeHaBillingSnapshot(value) {
  if (
    !value ||
    value.version !== 1 ||
    Object.keys(value).some(
      (key) => !['version', 'model', 'rate_multiplier', 'cache_ttl', 'requested_speed', 'resolved'].includes(key),
    ) ||
    !Number.isFinite(value.rate_multiplier) ||
    value.rate_multiplier < 0 ||
    ![null, '5m', '1h'].includes(value.cache_ttl) ||
    ![null, 'standard', 'fast'].includes(value.requested_speed)
  )
    invalid()
  const result = {
    version: 1,
    model: text(value.model),
    rate_multiplier: value.rate_multiplier,
    cache_ttl: value.cache_ttl,
    requested_speed: value.requested_speed,
    resolved: null,
  }
  if (value.resolved !== null) {
    const resolved = value.resolved
    if (
      !resolved ||
      resolved.platform !== 'anthropic' ||
      Object.keys(resolved).some(
        (key) => !['id', 'platform', 'source', 'version', 'mode_sources', 'price'].includes(key),
      )
    )
      invalid()
    const validated = validatePrice(resolved.price, { platform: 'anthropic' })
    if (!validated.ok) invalid()
    result.resolved = {
      id: text(resolved.id),
      platform: 'anthropic',
      source: resolved.source == null ? null : text(resolved.source),
      version: resolved.version == null ? null : text(resolved.version),
      mode_sources: {},
      price: validated.price,
    }
  }
  return result
}

/** Called synchronously for the actual outbound body, before its job bind permits node submission. */
export function captureHaBillingSnapshot({ model, rateMultiplier = 1, cacheTtl = null, requestedSpeed = null }) {
  return normalizeHaBillingSnapshot({
    version: 1,
    model,
    rate_multiplier: rateMultiplier,
    cache_ttl: cacheTtl,
    requested_speed: requestedSpeed,
    resolved: resolvePrice(model, { refresh: false }),
  })
}

export function priceHaReceipt(receipt, snapshot) {
  try {
    const observed = normalizeNodeReceipt(receipt)
    const captured = normalizeHaBillingSnapshot(snapshot)
    if (
      !observed.usage_complete ||
      !captured.resolved ||
      !catalogIdCandidates(observed.model, 'anthropic').includes(captured.resolved.id)
    )
      return { known: false }
    const usage = {
      ...observed.usage,
      ...(observed.speed ? { speed: observed.speed } : {}),
      ...(observed.service_tier ? { service_tier: observed.service_tier } : {}),
      requested_speed: captured.requested_speed,
    }
    const effective = captured.cache_ttl ? applyCacheTtlToUsage(usage, captured.cache_ttl) : usage
    const pricing = calculateCostAtPrice(effective, observed.model, captured.resolved)
    const actualCost = pricing.total_cost * captured.rate_multiplier
    if (!pricing.known || !Number.isFinite(pricing.total_cost) || !Number.isFinite(actualCost)) return { known: false }
    return { known: true, pricing, actualCost }
  } catch {
    return { known: false }
  }
}
