import test from 'node:test'
import assert from 'node:assert/strict'
import { cacheHitStats } from '../../src/lib/admin/cache-metrics.mjs'

test('anthropic hit rate is read over uncached plus cache buckets', () => {
  const s = cacheHitStats({ input_tokens: 100, cache_read_tokens: 80, cache_creation_tokens: 10 })
  assert.equal(s.prompt_tokens, 190)
  assert.equal(s.cache_hit_rate, 80 / 190)
})

test('openai hit rate is read over input that already includes cache', () => {
  const s = cacheHitStats({
    input_tokens: 100,
    cache_read_tokens: 80,
    cache_creation_tokens: 10,
    scheme: 'openai',
  })
  assert.equal(s.prompt_tokens, 100)
  assert.equal(s.cache_hit_rate, 80 / 100)
})
