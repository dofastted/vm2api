import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('wrap template wording', () => {
  it('names the template replacement instead of promoting the slot', () => {
    const source = readFileSync(
      new URL('./detail-ops-tab.tsx', import.meta.url),
      'utf8'
    )
    expect(source).toContain('设为 Wrap CLI 模板')
    expect(source).toContain("aria-describedby='wrap-template-help'")
    expect(source).toContain('用此槽的 Wrap CLI 文件替换现有模板。')
    expect(source).not.toContain('晋升母本')
  })
})
