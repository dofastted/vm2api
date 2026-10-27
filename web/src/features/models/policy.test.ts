import { describe, expect, it } from 'vitest'
import { catalogFacts } from './policy'

describe('catalogFacts', () => {
  it('reports 未同步 instead of seed constants', () => {
    const facts = catalogFacts({
      id: 'gpt-6-luna',
      capabilities: { context_window: 272000 },
    })
    expect(facts.synced).toBe(false)
    expect(facts.context).toBe('未同步')
    expect(facts.efforts).toBe('未同步')
  })

  it('formats synced upstream facts with OpenAI terms', () => {
    const facts = catalogFacts({
      id: 'gpt-6-luna',
      catalog: {
        context_window: 272000,
        max_context_window: 1050000,
        default_reasoning_level: 'medium',
        supported_reasoning_levels: ['low', 'medium', 'high'],
        service_tiers: [
          { id: 'priority', name: 'fast' },
          { id: 'flex', name: 'flex' },
        ],
        input_modalities: ['text', 'image'],
        supports_search_tool: true,
        supports_parallel_tool_calls: false,
        visibility: 'hide',
        synced_at: '2026-10-22T00:00:00.000Z',
      },
    })
    expect(facts).toMatchObject({
      synced: true,
      context: '272K',
      maxContext: '1.05M',
      defaultEffort: 'medium',
      efforts: 'low / medium / high',
      tierNames: 'fast / flex',
      tiers: 'fast（priority） / flex',
      input: '文本 / 图像',
      search: '支持',
      parallel: '不支持',
      visibility: '隐藏',
    })
  })

  it('distinguishes an empty tier list from a missing one', () => {
    expect(
      catalogFacts({ id: 'a', catalog: { service_tiers: [] } }).tiers
    ).toBe('无')
    expect(catalogFacts({ id: 'a', catalog: {} }).tiers).toBe('—')
    expect(
      catalogFacts({ id: 'a', catalog: { service_tiers: [] } }).tierNames
    ).toBe('无')
  })
})
