import { Children, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CragGeminiPanel } from './craggemini-panel'
import {
  CRAGGEMINI_SYSTEM_PROMPT_MAX,
  buildGoogleRawJsonPayload,
  cragGeminiGlobalPromptFromCompat,
  cragGeminiPersonaFromCompat,
  cragGeminiPromptProblem,
} from './google-prompt'
import { SlidingTabs } from './sliding-tabs'

function elements(
  node: ReactNode
): React.ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child)
      ? [child, ...elements(child.props.children)]
      : []
  )
}

describe('Google system prompt panel', () => {
  it('defaults to official_full, renders clean Google copy with zero CRAG/Antigravity/agy jargon, and hides raw JSON by default', () => {
    expect(cragGeminiPersonaFromCompat(undefined)).toBe('official_full')
    expect(
      cragGeminiPersonaFromCompat({ craggemini_persona_preset: 'zero' })
    ).toBe('zero')
    expect(
      cragGeminiGlobalPromptFromCompat({ craggemini_system_prompt: 'abc' })
    ).toBe('abc')

    const html = renderToStaticMarkup(
      <CragGeminiPanel compat={{}} onChange={() => {}} />
    )
    expect(html).toContain('官方提示词')
    expect(html).toContain('0注入')
    expect(html).toContain('全局系统提示词（可选）')
    expect(html).toContain('加载 JSON 原始内容')
    expect(html).not.toContain('data-testid="raw-json-panel"')
    expect(html).not.toMatch(
      /crag|antigravity|libagy_bridge|modelapiinterface|ModelRequest|\bagy\b/i
    )
  })

  it('omits the raw JSON loader and panel completely in zero (0注入) mode', () => {
    const html = renderToStaticMarkup(
      <CragGeminiPanel
        compat={{ craggemini_persona_preset: 'zero' }}
        onChange={() => {}}
      />
    )
    expect(html).toContain('0 注入直通模式')
    expect(html).not.toContain('加载 JSON 原始内容')
    expect(html).not.toContain('隐藏 JSON 原始内容')
    expect(html).not.toContain('data-testid="raw-json-toggle"')
    expect(html).not.toContain('data-testid="raw-json-panel"')
    expect(html).not.toMatch(/crag|antigravity|\bagy\b/i)
  })

  it('invokes onChange when switching mode or clearing global system prompt', () => {
    const onChange = vi.fn()
    const tree = CragGeminiPanel({
      compat: {
        craggemini_persona_preset: 'official_full',
        craggemini_system_prompt: 'Old',
      },
      onChange,
    })
    const all = elements(tree)
    const tabs = all.find((el) => el.type === SlidingTabs)
    expect(tabs).toBeDefined()
    ;(tabs!.props.onChange as (mode: 'official_full' | 'zero') => void)('zero')
    expect(onChange).toHaveBeenCalledWith({
      craggemini_persona_preset: 'zero',
      craggemini_system_prompt: 'Old',
    })

    const clearBtn = all.find(
      (el) =>
        typeof el.props.onClick === 'function' && el.props.variant === 'ghost'
    )
    expect(clearBtn).toBeDefined()
    ;(clearBtn!.props.onClick as () => void)()
    expect(onChange).toHaveBeenCalledWith({
      craggemini_persona_preset: 'official_full',
      craggemini_system_prompt: '',
    })
  })

  it('builds clean Google raw JSON payload on demand', () => {
    const payload = buildGoogleRawJsonPayload(
      'official_full',
      'Be terse.',
      true
    )
    expect(payload).toEqual({
      provider: 'google',
      mode: 'official_full',
      system_prompt: {
        official_base: '<Google 官方系统提示词与工作区规则（锁定原样）>',
        global_prompt: 'Be terse.',
        caller_system: '‹调用方 system›',
      },
    })
    expect(JSON.stringify(payload)).not.toMatch(/crag|antigravity|\bagy\b/i)
  })

  it('flags oversized global system prompt with clean Google label so SaveBar blocks before PUT /routing', () => {
    expect(
      cragGeminiPromptProblem({
        craggemini_system_prompt: 'x'.repeat(CRAGGEMINI_SYSTEM_PROMPT_MAX),
      })
    ).toBeNull()
    const problem = cragGeminiPromptProblem({
      craggemini_system_prompt: 'x'.repeat(CRAGGEMINI_SYSTEM_PROMPT_MAX + 1),
    })
    expect(problem).toBe(
      `Google 全局系统提示词超过 ${CRAGGEMINI_SYSTEM_PROMPT_MAX} 字符`
    )
    expect(problem).not.toMatch(/crag/i)
  })
})
