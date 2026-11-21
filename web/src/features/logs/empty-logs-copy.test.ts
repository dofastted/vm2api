import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('empty logs wording', () => {
  it('does not imply that no logs were collected', () => {
    const source = readFileSync(
      new URL('./virtualized-logs-table.tsx', import.meta.url),
      'utf8'
    )
    expect(source).toContain('本次查询未返回日志')
    expect(source).not.toContain('暂无数据')
  })
})
