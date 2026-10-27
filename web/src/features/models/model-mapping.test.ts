import { describe, expect, it } from 'vitest'
import {
  AUTO_REVIEW_ALIAS,
  AUTO_REVIEW_DEFAULT,
  aliasProblem,
  mappingProblem,
  mappingRows,
  mappingTargets,
  rowsToMap,
} from './model-mapping'

const IMAGE_IDS = [
  'gpt-image-2.5-flare',
  'gpt-image-2.5-flare-2026-09-08',
  'gpt-image-2.5-sunburst',
]

describe('mappingRows / rowsToMap', () => {
  it('puts codex-auto-review first and keeps every other mapping', () => {
    const rows = mappingRows({
      'my-fast': 'gpt-6-luna',
      [AUTO_REVIEW_ALIAS]: 'gpt-6-sol',
      other: 'gpt-5.5',
    })
    expect(rows.map((r) => [r.alias, r.target, r.fixed])).toEqual([
      [AUTO_REVIEW_ALIAS, 'gpt-6-sol', true],
      ['my-fast', 'gpt-6-luna', false],
      ['other', 'gpt-5.5', false],
    ])
    expect(rowsToMap(rows)).toEqual({
      [AUTO_REVIEW_ALIAS]: 'gpt-6-sol',
      'my-fast': 'gpt-6-luna',
      other: 'gpt-5.5',
    })
  })

  it('leaves the default auto-review target out so it follows the server default', () => {
    const rows = mappingRows({})
    expect(rows).toEqual([
      { alias: AUTO_REVIEW_ALIAS, target: AUTO_REVIEW_DEFAULT, fixed: true },
    ])
    expect(rowsToMap(rows)).toEqual({})
  })

  it('drops rows whose alias is blank and trims aliases', () => {
    expect(
      rowsToMap([
        { alias: '  x ', target: 'gpt-6-sol', fixed: false },
        { alias: ' ', target: 'gpt-6-sol', fixed: false },
      ])
    ).toEqual({ x: 'gpt-6-sol' })
  })
})

describe('targets and problems', () => {
  it('only enabled GPT models are targets', () => {
    expect(
      mappingTargets([
        { id: 'gpt-6-luna' },
        { id: 'gpt-6-sol', enabled: false },
        { id: 'gpt-5.5', enabled: true },
      ])
    ).toEqual(['gpt-6-luna', 'gpt-5.5'])
    expect(mappingProblem('gpt-6-sol', ['gpt-6-luna'])).toBe('disabled')
    expect(mappingProblem('gpt-6-luna', ['gpt-6-luna'])).toBeNull()
  })

  it('aliasProblem mirrors the server rules', () => {
    const rows = mappingRows({ 'my-fast': 'gpt-6-luna' })
    const check = (alias: string, index = 5) =>
      aliasProblem(alias, rows, index, IMAGE_IDS)
    expect(check('')).toBe('empty')
    expect(check('my alias')).toBe('whitespace')
    expect(check('MY-FAST')).toBe('duplicate')
    expect(check('my-fast', 1)).toBeNull()
    expect(check('claude-opus-5-5')).toBe('anthropic')
    expect(check('anthropic.claude-sonnet-5')).toBe('anthropic')
    expect(check('sonnet-5')).toBe('anthropic')
    expect(check('gpt-image-2.5-flare-2026-09-08')).toBe('image_tool')
    expect(check('openai/gpt-image-2.5-sunburst')).toBe('image_tool')
    expect(check('gpt-5')).toBeNull()
  })
})
