import type { Price, PriceSource } from '@/types/panel-pricing'
import { fmtUsd } from '@/lib/format'

export const PRICE_SOURCE_LABEL: Record<PriceSource, string> = {
  override: '覆盖',
  'models.dev': 'models.dev',
  builtin: '内置',
}

export function priceSourceLabel(
  source: PriceSource | null | undefined
): string {
  if (!source) return '未定价'
  return PRICE_SOURCE_LABEL[source]
}

export function priceSourceVariant(
  source: PriceSource | null | undefined
): 'default' | 'secondary' | 'outline' {
  if (source === 'override') return 'default'
  if (source === 'models.dev') return 'secondary'
  return 'outline'
}

export function fmtPerM(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return fmtUsd(n, Math.abs(n) >= 1 ? 2 : 3)
}

/** input / output / cache read per 1M. */
export function fmtBaseRates(price: Price | null | undefined): string {
  if (!price) return '未定价'
  return [
    fmtPerM(price.input),
    fmtPerM(price.output),
    fmtPerM(price.cache_read),
  ].join(' / ')
}

/** OpenAI order: input / cached input / output per 1M. */
export function fmtOpenaiRates(price: Price | null | undefined): string {
  if (!price) return '未定价'
  return [
    fmtPerM(price.input),
    fmtPerM(price.cache_read),
    fmtPerM(price.output),
  ].join(' / ')
}

/** GPT Image token rates: input / cached input / output per 1M. */
export function fmtImageRates(price: Price | null | undefined): string {
  const image = price?.image
  if (!image) return '—'
  return [
    fmtPerM(image.input),
    fmtPerM(image.cache_read),
    fmtPerM(image.output),
  ].join(' / ')
}

export function cacheFillHint(
  platform: 'anthropic' | 'openai',
  field: 'cache_5m' | 'cache_1h',
  input: string
): string {
  const n = Number(input)
  const has = input.trim() !== '' && Number.isFinite(n) && n >= 0
  if (platform === 'anthropic') {
    if (field === 'cache_5m') {
      return has ? `缺省 ${fmtPerM(n * 1.25)}（1.25×input）` : '缺省 1.25×input'
    }
    return has ? `缺省 ${fmtPerM(n * 2)}（2×input）` : '缺省 2×input'
  }
  if (field === 'cache_5m') return '缺省 0（无 cache_write）'
  return '缺省与 5m 写入相同'
}

export function tiersSummary(price: Price | null | undefined): string {
  const tiers = price?.tiers
  if (!tiers?.length) return '—'
  return tiers
    .map((tier) => {
      const above =
        tier.above >= 1000
          ? `>${Math.round(tier.above / 1000)}k`
          : `>${tier.above}`
      if ('unpriced' in tier && tier.unpriced) return `${above} 未定价`
      return above
    })
    .join(' · ')
}

/** OpenAI service tiers with their own price (flex / priority); `fast` is the Anthropic mode. */
export function openaiServiceModes(
  price: Price | null | undefined
): Array<'flex' | 'priority'> {
  return (['flex', 'priority'] as const).filter((k) => price?.modes?.[k])
}

export function modeKeys(
  price: Price | null | undefined
): Array<'fast' | 'flex' | 'priority'> {
  if (!price?.modes) return []
  return (['fast', 'flex', 'priority'] as const).filter((k) => price.modes?.[k])
}
