import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HealthPane } from './health-pane'

function renderHealthPane({
  compatibility = {},
  healthProbe,
}: {
  compatibility?: Record<string, unknown>
  healthProbe?: Record<string, unknown>
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(HealthPane, {
          title: 'Health',
          failover: {},
          healthProbe,
          compatibility,
          onFailoverChange() { },
          onHealthProbeChange() { },
          onCompatibilityChange() { },
        })
      )
    )
  } finally {
    client.clear()
  }
}

function renderMinTokens(config: Record<string, unknown>) {
  return renderHealthPane({ compatibility: { min_max_tokens: config } })
}

describe('max_tokens mode display', () => {
  it.each([
    [{ mode: 'preserve' }, true],
    [{ mode: 'unchanged' }, true],
    [{ mode: '不改' }, true],
    [{ tier: 'preserve' }, true],
    [{ mode: ' preserve ' }, true],
    [{ no_raise: true }, true],
    [{ raise: false }, true],
    [{ mode: 'floor', no_raise: true }, false],
    [{ mode: 'default', raise: false }, false],
    [{ mode: 'raise', no_raise: true }, false],
    [{ mode: 'unknown', no_raise: true }, true],
    [{}, false],
  ] as const)('matches backend mode precedence for %j', (config, preserve) => {
    const html = renderMinTokens(config)
    const control = html.match(/<button[^>]*aria-label="不抬升"[^>]*>/)?.[0]
    expect(control).toBeDefined()
    expect(control).toContain(`aria-checked="${preserve}"`)
    expect(control).toContain(
      `data-state="${preserve ? 'checked' : 'unchecked'}"`
    )
  })
})

describe('Gemini health probe settings', () => {
  it('renders default 1-hour (3600s) interval, 5400s TTL, enabled switch, and Gemini snapshot row', () => {
    const html = renderHealthPane({ healthProbe: { enabled: true } })
    const toggle = html.match(
      /<button[^>]*aria-label="启用 Gemini 健康缓存"[^>]*>/
    )?.[0]
    expect(toggle).toBeDefined()
    expect(toggle).toContain('aria-checked="true"')

    const intervalInput = html.match(
      /<input[^>]*aria-label="Gemini 探测间隔"[^>]*>/
    )?.[0]
    expect(intervalInput).toBeDefined()
    expect(intervalInput).toContain('value="3600"')

    const ttlInput = html.match(
      /<input[^>]*aria-label="Gemini 缓存有效期"[^>]*>/
    )?.[0]
    expect(ttlInput).toBeDefined()
    expect(ttlInput).toContain('value="5400"')

    const modelInput = html.match(
      /<input[^>]*aria-label="Gemini 探测模型"[^>]*>/
    )?.[0]
    expect(modelInput).toBeDefined()
    expect(html).toContain('Gemini：暂无')
  })

  it('reflects custom Gemini health probe values', () => {
    const html = renderHealthPane({
      healthProbe: {
        enabled: true,
        gemini: {
          enabled: false,
          interval_sec: 7200,
          cache_ttl_sec: 10800,
          model: 'gemini-3-flash',
        },
      },
    })
    const toggle = html.match(
      /<button[^>]*aria-label="启用 Gemini 健康缓存"[^>]*>/
    )?.[0]
    expect(toggle).toContain('aria-checked="false"')

    const intervalInput = html.match(
      /<input[^>]*aria-label="Gemini 探测间隔"[^>]*>/
    )?.[0]
    expect(intervalInput).toContain('value="7200"')

    const ttlInput = html.match(
      /<input[^>]*aria-label="Gemini 缓存有效期"[^>]*>/
    )?.[0]
    expect(ttlInput).toContain('value="10800"')

    const modelInput = html.match(
      /<input[^>]*aria-label="Gemini 探测模型"[^>]*>/
    )?.[0]
    expect(modelInput).toContain('value="gemini-3-flash"')
  })
})
