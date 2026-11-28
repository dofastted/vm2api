import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PERSONA_TEMPLATES,
  setPresetFlag,
  setTemplateBlock,
} from '@/lib/persona-template'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { routingQueryOptions } from '@/features/settings/queries'
import { SystemPromptPage } from './index'
import {
  handleSlidingTabKeyDown,
  nextTabIndexForKey,
  splitLongPreviewBlock,
} from './prompt-presentation'
import { personaPreviewVarsQueryOptions } from './queries'
import {
  buildAnthropicRawJsonPayload,
  canShowRawJson,
  resolveRawJsonOpen,
} from './raw-json'
import { RawJsonDisclosure } from './raw-json-panel'
import { SlidingTabs } from './sliding-tabs'
import { SystemPreview } from './system-preview'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string
    children: React.ReactNode
    className?: string
  }) => (
    <a data-router-to={to} className={className}>
      {children}
    </a>
  ),
}))

function createSeededClient() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  qc.setQueryData(dashboardQueryOptions().queryKey, {
    vms: [{ id: 'vm-1', timezone: 'UTC' }],
  })
  qc.setQueryData(personaPreviewVarsQueryOptions('UTC').queryKey, {
    vars: {
      cli_version: '2.1.303',
      harness_303: 'OFFICIAL_HARNESS_CONTENT',
      guidance_303: 'OFFICIAL_GUIDANCE_CONTENT',
      env_303: '# Environment\n - Platform: linux',
      env_official: '# Environment\n - Platform: linux',
      env_instructions_303: 'LONG_ENV_INSTRUCTIONS',
      env_timezone: ' - Timezone: UTC',
      env_locale: ' - Language: en-US',
    },
  })
  qc.setQueryData(routingQueryOptions().queryKey, {
    compatibility: {
      persona_preset: 'official',
      craggemini_persona_preset: 'official_full',
    },
  })
  return qc
}

describe('SystemPromptPage brand labels', () => {
  it('renders only Anthropic and Google brand tabs with zero CRAG/Antigravity/cli-node copy', () => {
    const qc = createSeededClient()
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SystemPromptPage />
      </QueryClientProvider>
    )
    expect(html).toContain('aria-label="服务商"')
    expect(html).toContain('>Anthropic<')
    expect(html).toContain('>Google<')
    expect(html).not.toMatch(/crag|antigravity|cli-node|cli-hop|\bagy\b/i)
  })
})

describe('SlidingTabs WAI-ARIA roving tabIndex & keyboard navigation', () => {
  it('assigns tabIndex=0 only to the selected tab and -1 to inactive tabs across variants', () => {
    for (const variant of ['segmented', 'cards'] as const) {
      const html = renderToStaticMarkup(
        <SlidingTabs
          variant={variant}
          ariaLabel='测试切换'
          items={[
            { value: 'a', label: 'Alpha', description: 'First' },
            { value: 'b', label: 'Beta', description: 'Second' },
            { value: 'c', label: 'Gamma', description: 'Third' },
          ]}
          value='b'
          onChange={() => {}}
        />
      )
      expect(html).toMatch(
        /<button(?=[^>]*role="tab")(?=[^>]*aria-selected="false")(?=[^>]*tabindex="-1")[^>]*>[\s\S]*?Alpha/
      )
      expect(html).toMatch(
        /<button(?=[^>]*role="tab")(?=[^>]*aria-selected="true")(?=[^>]*tabindex="0")[^>]*>[\s\S]*?Beta/
      )
      expect(html).toMatch(
        /<button(?=[^>]*role="tab")(?=[^>]*aria-selected="false")(?=[^>]*tabindex="-1")[^>]*>[\s\S]*?Gamma/
      )
    }
  })

  it('computes cyclic Arrow, Home, and End indices accurately', () => {
    expect(nextTabIndexForKey('ArrowRight', 0, 4)).toBe(1)
    expect(nextTabIndexForKey('ArrowRight', 3, 4)).toBe(0)
    expect(nextTabIndexForKey('ArrowDown', 1, 4)).toBe(2)
    expect(nextTabIndexForKey('ArrowLeft', 0, 4)).toBe(3)
    expect(nextTabIndexForKey('ArrowUp', 2, 4)).toBe(1)
    expect(nextTabIndexForKey('Home', 3, 4)).toBe(0)
    expect(nextTabIndexForKey('End', 0, 4)).toBe(3)
    expect(nextTabIndexForKey('Enter', 1, 4)).toBeNull()
    expect(nextTabIndexForKey('ArrowRight', 0, 0)).toBeNull()
  })

  it('prevents default, calls onChange, and moves focus for tablist keyboard navigation', () => {
    const items = [
      { value: 'official' as const },
      { value: 'official_full' as const },
      { value: 'zero' as const },
      { value: 'custom' as const },
    ]
    const cases: [string, number, (typeof items)[number]['value']][] = [
      ['ArrowRight', 3, 'official'],
      ['ArrowDown', 0, 'official_full'],
      ['ArrowLeft', 0, 'custom'],
      ['ArrowUp', 2, 'official_full'],
      ['Home', 3, 'official'],
      ['End', 0, 'custom'],
    ]
    for (const [key, index, expected] of cases) {
      const preventDefault = vi.fn()
      const onChange = vi.fn()
      const focusItem = vi.fn()
      expect(
        handleSlidingTabKeyDown(
          { key, preventDefault },
          index,
          items,
          onChange,
          focusItem
        )
      ).toBe(true)
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenCalledWith(expected)
      expect(focusItem).toHaveBeenCalledWith(expected)
    }

    const preventDefault = vi.fn()
    const onChange = vi.fn()
    const focusItem = vi.fn()
    expect(
      handleSlidingTabKeyDown(
        { key: 'Enter', preventDefault },
        1,
        items,
        onChange,
        focusItem
      )
    ).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
    expect(focusItem).not.toHaveBeenCalled()
  })
})

describe('RawJsonDisclosure lazy opt-in & 0注入 guard', () => {
  it('does not compute or mount raw JSON by default in non-zero modes', () => {
    const buildPayload = vi.fn(() => ({ hello: 'world' }))
    const html = renderToStaticMarkup(
      <RawJsonDisclosure mode='official_full' buildPayload={buildPayload} />
    )
    expect(html).toContain('加载 JSON 原始内容')
    expect(html).not.toContain('data-testid="raw-json-panel"')
    expect(buildPayload).not.toHaveBeenCalled()
  })

  it('lazily computes and displays formatted raw JSON only when opened', () => {
    const buildPayload = vi.fn(() => ({
      provider: 'anthropic',
      mode: 'official',
    }))
    const html = renderToStaticMarkup(
      <RawJsonDisclosure
        mode='official'
        buildPayload={buildPayload}
        controlledOpen
      />
    )
    expect(buildPayload).toHaveBeenCalledTimes(1)
    expect(html).toContain('隐藏 JSON 原始内容')
    expect(html).toContain('data-testid="raw-json-panel"')
    expect(html).toContain('&quot;provider&quot;: &quot;anthropic&quot;')
  })

  it('resets open state across non-zero mode round-trips and renders nothing in zero (0注入) mode', () => {
    expect(canShowRawJson('zero')).toBe(false)
    expect(canShowRawJson('official')).toBe(true)
    expect(canShowRawJson('official_full')).toBe(true)
    expect(canShowRawJson('custom')).toBe(true)

    // official (opened) -> official_full (sync collapsed + effect resets openForMode=null) -> official (stays closed)
    expect(resolveRawJsonOpen('official', 'official')).toBe(true)
    expect(resolveRawJsonOpen('official', 'official_full')).toBe(false)
    expect(resolveRawJsonOpen(null, 'official')).toBe(false)

    // official_full (opened) -> zero (sync collapsed + effect resets openForMode=null) -> official_full (stays closed)
    expect(resolveRawJsonOpen('official_full', 'official_full')).toBe(true)
    expect(resolveRawJsonOpen('official_full', 'zero')).toBe(false)
    expect(resolveRawJsonOpen('zero', 'zero')).toBe(false)
    expect(resolveRawJsonOpen(null, 'official_full')).toBe(false)

    // Verify RawJsonDisclosure resets openForMode and copied unconditionally on any [mode] change
    // so official (open) -> official_full -> official or official_full (open) -> zero -> official_full never leaks open state.
    const panelSrc = readFileSync(
      new URL('./raw-json-panel.tsx', import.meta.url),
      'utf8'
    )
    expect(panelSrc).toMatch(
      /useEffect\(\(\)\s*=>\s*\{\s*setOpenForMode\(null\)\s*setCopied\(false\)\s*\},\s*\[mode\]\)/
    )

    const buildPayload = vi.fn(() => ({ should_never_run: true }))
    const html = renderToStaticMarkup(
      <RawJsonDisclosure
        mode='zero'
        buildPayload={buildPayload}
        controlledOpen
      />
    )
    expect(html).toBe('')
    expect(buildPayload).not.toHaveBeenCalled()
  })
})

describe('splitLongPreviewBlock formatting', () => {
  it('keeps short blocks intact without expand control', () => {
    expect(splitLongPreviewBlock('line 1\nline 2')).toEqual({
      kind: 'short',
      head: 'line 1\nline 2',
    })
    expect(splitLongPreviewBlock('L1\nL2\nL3\nL4\n')).toEqual({
      kind: 'short',
      head: 'L1\nL2\nL3\nL4\n',
    })
  })

  it('splits multi-line blocks cleanly without a leading blank line in tail', () => {
    const text = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'].join('\n')
    expect(splitLongPreviewBlock(text)).toEqual({
      kind: 'lines',
      head: 'L1\nL2\nL3\nL4',
      tail: 'L5\nL6',
    })
  })

  it('breaks long single-line blocks at a word boundary and preserves full text for expansion', () => {
    const longSingleLine = Array.from(
      { length: 45 },
      (_, i) => `word${i}`
    ).join(' ')
    const split = splitLongPreviewBlock(longSingleLine)
    expect(split.kind).toBe('inline')
    if (split.kind === 'inline') {
      expect(split.full).toBe(longSingleLine)
      expect(split.excerpt.endsWith('…')).toBe(true)
      const beforeEllipsis = split.excerpt.slice(0, -1)
      expect(longSingleLine.startsWith(beforeEllipsis)).toBe(true)
      expect(longSingleLine[beforeEllipsis.length]).toBe(' ')
    }
  })
})

describe('SystemPreview showcase & Mode 1 live preview updates', () => {
  it('hides raw JSON by default in non-zero modes while exposing the opt-in loader button', () => {
    const qc = createSeededClient()
    for (const preset of ['official', 'official_full', 'custom'] as const) {
      const blocks =
        preset === 'custom'
          ? DEFAULT_PERSONA_TEMPLATES.official
          : DEFAULT_PERSONA_TEMPLATES[preset]
      const html = renderToStaticMarkup(
        <QueryClientProvider client={qc}>
          <SystemPreview preset={preset} blocks={blocks} compat={{}} />
        </QueryClientProvider>
      )
      expect(html).toContain('加载 JSON 原始内容')
      expect(html).not.toContain('data-testid="raw-json-panel"')
      expect(html).not.toMatch(/crag|antigravity|cli-node|\bagy\b/i)
    }
  })

  it('renders 0注入 callout with prompt_version identity and omits raw JSON controls completely', () => {
    const qc = createSeededClient()
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SystemPreview
          preset='zero'
          blocks={DEFAULT_PERSONA_TEMPLATES.zero}
          compat={{}}
        />
      </QueryClientProvider>
    )
    expect(html).toContain('data-testid="zero-inject-callout"')
    expect(html).toContain('0 注入直通模式')
    expect(html).toContain('prompt_version')
    expect(html).toContain('0 块')
    expect(html).toContain('调用方原样直通')
    expect(html).not.toContain('加载 JSON 原始内容')
    expect(html).not.toContain('隐藏 JSON 原始内容')
    expect(html).not.toContain('data-testid="raw-json-toggle"')
    expect(html).not.toContain('data-testid="raw-json-panel"')
  })

  it('updates live layer preview accurately when Mode 1 toggles harness, guidance, and env sub-switches', () => {
    const qc = createSeededClient()
    const defaultHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SystemPreview
          preset='official'
          blocks={DEFAULT_PERSONA_TEMPLATES.official}
          compat={{}}
        />
      </QueryClientProvider>
    )
    expect(defaultHtml).toContain('计费归因')
    expect(defaultHtml).toContain('身份')
    expect(defaultHtml).not.toContain('OFFICIAL_HARNESS_CONTENT')
    expect(defaultHtml).not.toContain('OFFICIAL_GUIDANCE_CONTENT')
    expect(defaultHtml).not.toContain('# Environment')

    let compat: Record<string, unknown> = {}
    compat = setTemplateBlock(compat, 'official', 'harness', true, {})
    compat = setTemplateBlock(compat, 'official', 'guidance', true, {})
    compat = setPresetFlag(
      compat,
      'persona_guidance_presets',
      'official',
      true,
      {}
    )
    compat = setPresetFlag(compat, 'persona_env_presets', 'official', true, {})
    compat = setPresetFlag(
      compat,
      'persona_timezone_presets',
      'official',
      true,
      {}
    )
    compat = setPresetFlag(
      compat,
      'persona_env_instructions_presets',
      'official',
      true,
      {}
    )

    const toggledHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SystemPreview
          preset='official'
          blocks={DEFAULT_PERSONA_TEMPLATES.official}
          compat={compat}
        />
      </QueryClientProvider>
    )
    expect(toggledHtml).toContain('OFFICIAL_HARNESS_CONTENT')
    expect(toggledHtml).toContain('OFFICIAL_GUIDANCE_CONTENT')
    expect(toggledHtml).toContain('# Environment')
    expect(toggledHtml).toContain('LONG_ENV_INSTRUCTIONS')
    expect(toggledHtml).toContain('Timezone: UTC')
  })

  it('builds structured Anthropic raw JSON payload cleanly when requested', () => {
    const payload = buildAnthropicRawJsonPayload('official_full', [
      {
        id: 'identity',
        text: 'You are Claude Code.',
        hide: false,
        ttl: '',
        scope: '',
        placeholder: false,
        region: 'system',
      },
      {
        id: 'harness',
        text: 'Core rules',
        hide: false,
        ttl: '',
        scope: 'global',
        placeholder: false,
        region: 'system',
      },
      {
        id: 'env',
        text: '# Environment',
        hide: false,
        ttl: '',
        scope: '',
        role: 'system',
        placeholder: false,
        region: 'messages · role=system',
      },
    ])
    expect(payload).toEqual({
      provider: 'anthropic',
      mode: 'official_full',
      system: [
        { id: 'identity', type: 'text', text: 'You are Claude Code.' },
        {
          id: 'harness',
          type: 'text',
          text: 'Core rules',
          cache_control: { type: 'ephemeral', scope: 'global' },
        },
      ],
      environment_messages: [
        { id: 'env', role: 'system', type: 'text', text: '# Environment' },
      ],
    })
  })
})
