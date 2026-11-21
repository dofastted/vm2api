import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('retry hop wording', () => {
  it('keeps the zero explanation on the hop slider', () => {
    const source = readFileSync(
      new URL('./pool-pane.tsx', import.meta.url),
      'utf8'
    )
    const start = source.indexOf("id='failover-same-hop'")
    const block = source.slice(start, source.indexOf('/>', start))
    expect(block).toContain("format={(ms) => (ms ? fmtDuration(ms) : '0 ms')}")
    expect(block).toContain(
      "desc='仅限制按耗时判定的重试；设为 0 时不进行这类重试。'"
    )
    expect(block).not.toContain('不限')
  })
})
