import type { Price, PriceSource } from '@/types/panel-pricing'
import { fmtAgo } from '@/lib/format'
import { Fact, Metric } from './model-parts'
import type { CatalogFacts } from './policy'
import {
  fmtOpenaiRates,
  fmtPerM,
  openaiServiceModes,
  priceSourceLabel,
  tiersSummary,
} from './price-display'

/** Card metrics for a GPT model: upstream catalog facts, not Claude thinking / max_tokens knobs. */
export function OpenaiCardMetrics({ facts }: { facts: CatalogFacts }) {
  return (
    <div className='grid gap-2 text-xs sm:grid-cols-3'>
      <Metric label='上下文' value={facts.context} strong />
      <Metric label='推理' value={facts.defaultEffort} />
      <Metric label='档位' value={facts.tierNames} />
    </div>
  )
}

export function OpenaiPriceFacts({
  price,
  source,
}: {
  price: Price | null
  source: PriceSource | null
}) {
  const modes = openaiServiceModes(price)
  return (
    <>
      <Fact label='来源' value={priceSourceLabel(source)} />
      <Fact
        label='input / cached input / output'
        value={`${fmtOpenaiRates(price)} / 1M`}
        mono
      />
      {price ? (
        <>
          <Fact label='cache write' value={fmtPerM(price.cache_5m)} mono />
          <Fact label='长上下文' value={tiersSummary(price)} />
          <Fact
            label='服务档位价'
            value={modes.length ? modes.join(' / ') : '—'}
            mono
          />
        </>
      ) : null}
    </>
  )
}

export function OpenaiCapabilityFacts({
  facts,
  live,
}: {
  facts: CatalogFacts
  live: boolean
}) {
  const status = live ? '对外可见' : '未进入目录'
  if (!facts.synced) {
    return (
      <>
        <Fact label='上游目录' value='未同步，点「同步 GPT」获取' />
        <Fact label='目录状态' value={status} />
      </>
    )
  }
  return (
    <>
      <Fact label='上下文' value={facts.context} />
      <Fact label='最大上下文' value={facts.maxContext} />
      <Fact label='默认推理' value={facts.defaultEffort} />
      <Fact label='可选推理' value={facts.efforts} />
      <Fact label='服务档位' value={facts.tiers} />
      <Fact label='输入' value={facts.input} />
      <Fact label='网页搜索' value={facts.search} />
      <Fact label='并行工具调用' value={facts.parallel} />
      <Fact label='上游可见性' value={facts.visibility} />
      <Fact
        label='同步时间'
        value={fmtAgo(facts.syncedAt) || facts.syncedAt || '—'}
      />
      <Fact label='目录状态' value={status} />
    </>
  )
}
