import { Children, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PERSONA_TEMPLATES,
  selectedPreviewBlocks,
} from '@/lib/persona-template'
import { Switch } from '@/components/ui/switch'
import { PromptFields } from './prompt-fields'
import {
  promptDisplayText,
  promptEditorBlocks,
  promptSourceBlocks,
  promptSourceText,
} from './prompt-presentation'

function elements(
  node: ReactNode
): React.ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child)
      ? [child, ...elements(child.props.children)]
      : []
  )
}

function render(preset: 'official' | 'official_full' | 'zero', compat = {}) {
  return renderToStaticMarkup(
    <PromptFields
      preset={preset}
      blocks={DEFAULT_PERSONA_TEMPLATES[preset]}
      compat={compat}
      server={{}}
      onBlocksChange={() => {}}
      onCompatChange={() => {}}
    />
  )
}

describe('prompt fields', () => {
  it('shows visual summaries with details instead of raw template inputs', () => {
    const html = render('official')
    expect(html).toContain('aria-label="system"')
    expect(html).toContain('核心提示词详情')
    expect(html).toContain('行为指引详情')
    expect(html).toContain('调用方提示词详情')
    expect(html).toContain(
      'You are Claude Code, Anthropic&#x27;s official CLI for Claude.'
    )
    expect(html).not.toContain('Claude Agent SDK')
    expect(html).not.toContain('303')
    expect(html).not.toContain('{{')
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('role=system')
    expect(html).not.toContain('role="switch"')
    for (const text of [
      '常驻约束内容',
      'usage 遮罩',
      'cache ttl',
      'cache scope',
      'JSONL',
      '块选择',
    ]) {
      expect(html).not.toContain(text)
    }
  })

  it('keeps the environment controls in the same editor, off by default for optional fields', () => {
    const html = render('official_full')
    expect(html).toContain('aria-label="环境注入"')
    expect(html).toMatch(
      /<button(?=[^>]*aria-label="加载环境")(?=[^>]*aria-checked="true")/
    )
    expect(html).toMatch(
      /<button(?=[^>]*aria-label="加载运行环境")(?=[^>]*aria-checked="true")/
    )
    expect(html).toMatch(
      /<button(?=[^>]*aria-label="加载模型附加句")(?=[^>]*aria-checked="false")/
    )
  })

  it('disables environment fields when the master switch is off', () => {
    const html = render('official_full', {
      persona_env_presets: { official_full: false },
      model_env_extra_presets: { official_full: true },
    })
    expect(html).toMatch(
      /<button(?=[^>]*aria-label="加载环境")(?=[^>]*aria-checked="false")/
    )
    expect(html).not.toContain('<textarea')
    expect(html).toMatch(
      /<button(?=[^>]*aria-label="加载模型附加句")(?=[^>]*disabled="")/
    )
    expect(html).toContain('环境注入段已移除；其余 system 保留。')
    expect(html).toContain('不发送「模型附加句」段')
    expect(html).toContain('system 末尾')
  })

  it('names the exact environment removal scope beside its switches', () => {
    const html = render('official_full')
    const at = selectedPreviewBlocks(
      DEFAULT_PERSONA_TEMPLATES.official_full,
      undefined,
      'official_full'
    ).findIndex((block) => block.id === 'env_official')
    expect(html).toContain('关闭将移除环境注入段；其余 system 保留。')
    expect(html).toContain('关闭将移除「运行环境」段')
    expect(html).toContain('不发送「模型附加句」段')
    expect(html).toContain(
      `aria-describedby="prompt-effect-official_full-${at}"`
    )
  })

  it('removes an edited literal field rather than just disabling its template variable', () => {
    const blocks = DEFAULT_PERSONA_TEMPLATES.official_full.map((block) =>
      block.id === 'env_extra' ? { ...block, text: 'LITERAL_EXTRA' } : block
    )
    const snapshot = structuredClone(blocks)
    const compat = {
      cache_ttl: '1h',
      model_env_extra_presets: { official_full: false },
    }
    const onCompatChange = vi.fn()
    const onBlocksChange = vi.fn()
    const tree = PromptFields({
      preset: 'official_full',
      blocks,
      compat,
      server: {},
      onBlocksChange,
      onCompatChange,
    })
    const toggle = elements(tree).find(
      (element) =>
        element.type === Switch &&
        element.props['aria-label'] === '加载模型附加句'
    )!
    expect(toggle.props.checked).toBe(true)
    ;(toggle.props.onCheckedChange as (enabled: boolean) => void)(false)
    const saved = onCompatChange.mock.calls[0][0]
    expect(saved).toMatchObject({
      cache_ttl: '1h',
      persona_block_presets: { official_full: { env_extra: false } },
    })
    expect(
      selectedPreviewBlocks(blocks, saved, 'official_full').some(
        (block) => block.id === 'env_extra'
      )
    ).toBe(false)
    expect(onBlocksChange).not.toHaveBeenCalled()
    expect(blocks).toEqual(snapshot)
  })

  it('keeps optional selections and top-level system unchanged when the master switch is disabled', () => {
    const compat = {
      cache_ttl: '1h',
      model_env_extra_presets: { official_full: true },
      persona_block_presets: { official_full: { env_extra: false } },
    }
    const snapshot = structuredClone(compat)
    const onCompatChange = vi.fn()
    const onBlocksChange = vi.fn()
    const tree = PromptFields({
      preset: 'official_full',
      blocks: DEFAULT_PERSONA_TEMPLATES.official_full,
      compat,
      server: {},
      onBlocksChange,
      onCompatChange,
    })
    const toggle = elements(tree).find(
      (element) =>
        element.type === Switch && element.props['aria-label'] === '加载环境'
    )!
    ;(toggle.props.onCheckedChange as (enabled: boolean) => void)(false)
    expect(onCompatChange.mock.calls[0][0]).toMatchObject({
      ...snapshot,
      persona_env_presets: { official_full: false },
    })
    expect(compat).toEqual(snapshot)
    expect(onBlocksChange).not.toHaveBeenCalled()
  })

  it('still exposes billing text in the billing-only preset', () => {
    expect(render('zero')).toContain('计费归因详情')
  })

  it('changes only text, preserving block order, cache breakpoints and other metadata', () => {
    const blocks = structuredClone(DEFAULT_PERSONA_TEMPLATES.official_full)
    const before = structuredClone(blocks)
    const onBlocksChange = vi.fn()
    const tree = PromptFields({
      preset: 'official_full',
      blocks,
      compat: {},
      server: {},
      onBlocksChange,
      onCompatChange: vi.fn(),
    })
    const field = elements(tree).find(
      (element) => element.props.label === '核心提示词'
    )!
    const save = field.props.onSave as (text: string) => void
    save('EDITED_HARNESS')
    expect(onBlocksChange).toHaveBeenCalledWith(
      before.map((block, index) =>
        index === 2 ? { ...block, text: 'EDITED_HARNESS' } : block
      )
    )
    expect(blocks).toEqual(before)
  })

  it('uses versionless editor aliases and restores canonical variables before saving', () => {
    const text =
      '{{agent_standing}}{{harness_303}}\n{{guidance_303}}\n{{env_303}}\n{{caller_system}}'
    const displayed = promptDisplayText(text)
    expect(displayed).not.toContain('303')
    expect(displayed).toContain('{{official_harness}}')
    expect(promptSourceText(displayed)).toBe(text)
    expect(promptSourceText(`${displayed}\nMY RULE`)).toBe(`${text}\nMY RULE`)
    expect(promptDisplayText('{{ HARNESS_303 }}')).toBe('{{official_harness}}')
    expect(promptSourceText('{{unknown}}')).toBe('{{unknown}}')
    expect(promptDisplayText('{{constructor}}{{__proto__}}')).toBe(
      '{{constructor}}{{__proto__}}'
    )
    expect(promptSourceText('{{constructor}}{{__proto__}}')).toBe(
      '{{constructor}}{{__proto__}}'
    )
    expect(promptDisplayText('{{main_prompt_303}}')).toBe('{{official_prompt}}')
    expect(promptSourceText('{{official_prompt}}')).toBe('{{main_prompt_303}}')
  })

  it('keeps advanced editor notes versionless without changing stored preset metadata', () => {
    for (const blocks of Object.values(DEFAULT_PERSONA_TEMPLATES)) {
      const shown = promptEditorBlocks(blocks)
      expect(JSON.stringify(shown)).not.toContain('303')
      expect(JSON.stringify(promptSourceBlocks(shown, blocks))).toBe(
        JSON.stringify(blocks)
      )
    }
  })

  it('enables saved disabled optional fields without changing unrelated compatibility settings', () => {
    const compat = {
      cc_entrypoint: 'cli',
      cache_ttl: '1h',
      model_env_extra: { model: 'KEEP' },
      persona_block_presets: {
        official_full: { env_extra: false },
        official: { identity: false },
      },
    }
    const snapshot = structuredClone(compat)
    const onCompatChange = vi.fn()
    const tree = PromptFields({
      preset: 'official_full',
      blocks: DEFAULT_PERSONA_TEMPLATES.official_full,
      compat,
      server: {},
      onBlocksChange: vi.fn(),
      onCompatChange,
    })
    const toggle = elements(tree).find(
      (element) =>
        element.type === Switch &&
        element.props['aria-label'] === '加载模型附加句'
    )!
    const change = toggle.props.onCheckedChange as (enabled: boolean) => void
    change(true)
    const saved = onCompatChange.mock.calls[0][0]
    expect(saved).toMatchObject({
      cc_entrypoint: 'cli',
      cache_ttl: '1h',
      model_env_extra: { model: 'KEEP' },
      model_env_extra_presets: { official_full: true },
      persona_block_presets: { official: { identity: false } },
    })
    expect(saved.persona_block_presets.official_full).toBeUndefined()
    expect(compat).toEqual(snapshot)
  })

  it('keeps saved environment blocks editable without silently deleting them from lean presets', () => {
    const html = renderToStaticMarkup(
      <PromptFields
        preset='official'
        blocks={[
          ...DEFAULT_PERSONA_TEMPLATES.official,
          { id: 'env', type: 'text', text: 'SAVED_ENV' },
        ]}
        compat={{}}
        server={{}}
        onBlocksChange={() => {}}
        onCompatChange={() => {}}
      />
    )
    expect(html).toContain('aria-label="环境注入"')
    expect(html).toContain('SAVED_ENV')
  })
})
