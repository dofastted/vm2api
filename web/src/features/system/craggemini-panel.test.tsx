import { Children, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  CragGeminiPanel,
  cragGeminiGlobalPromptFromCompat,
  cragGeminiPersonaFromCompat,
} from './craggemini-panel'

function elements(
  node: ReactNode
): React.ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child)
      ? [child, ...elements(child.props.children)]
      : []
  )
}

describe('CragGeminiPanel', () => {
  it('defaults to official_full and renders both modes', () => {
    expect(cragGeminiPersonaFromCompat(undefined)).toBe('official_full')
    expect(cragGeminiPersonaFromCompat({ craggemini_persona_preset: 'zero' })).toBe('zero')
    expect(cragGeminiGlobalPromptFromCompat({ craggemini_system_prompt: 'abc' })).toBe('abc')

    const html = renderToStaticMarkup(<CragGeminiPanel compat={{}} onChange={() => {}} />)
    expect(html).toContain('官方提示词')
    expect(html).toContain('0提示词')
    expect(html).toContain('ModelRequest.SystemPrompt')
    expect(html).toContain('AGENTS.md')
  })

  it('invokes onChange when switching mode or editing global system prompt', () => {
    const onChange = vi.fn()
    const tree = CragGeminiPanel({
      compat: { craggemini_persona_preset: 'official_full', craggemini_system_prompt: 'Old' },
      onChange,
    })
    const all = elements(tree)
    const zeroTab = all.find(
      (el) => el.type === 'button' && el.props.role === 'tab' && el.props['aria-selected'] === false
    )
    expect(zeroTab).toBeDefined()
    ;(zeroTab!.props.onClick as () => void)()
    expect(onChange).toHaveBeenCalledWith({
      craggemini_persona_preset: 'zero',
      craggemini_system_prompt: 'Old',
    })

    const clearBtn = all.find(
      (el) => typeof el.props.onClick === 'function' && el.props.variant === 'ghost'
    )
    expect(clearBtn).toBeDefined()
    ;(clearBtn!.props.onClick as () => void)()
    expect(onChange).toHaveBeenCalledWith({
      craggemini_persona_preset: 'official_full',
      craggemini_system_prompt: '',
    })
  })
})
