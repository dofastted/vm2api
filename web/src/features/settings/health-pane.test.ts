import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { HealthPane } from './health-pane'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    params,
  }: {
    children: ReactNode
    params?: { tab?: string }
  }) =>
    createElement(
      'a',
      { href: params?.tab ? `/settings/${params.tab}` : '/settings' },
      children
    ),
}))

function renderHealthPane({
  compatibility = {},
  healthProbe,
  failover = {},
  probeStatus,
}: {
  compatibility?: Record<string, unknown>
  healthProbe?: Record<string, unknown>
  failover?: Record<string, unknown>
  probeStatus?: Record<string, unknown>
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  if (probeStatus) {
    client.setQueryData(['panel', 'health-probe'], probeStatus)
  }
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(HealthPane, {
          title: 'Health',
          failover,
          healthProbe,
          compatibility,
          onFailoverChange() {},
          onHealthProbeChange() {},
          onCompatibilityChange() {},
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
    expect(html).not.toContain('aria-label="不抬升"')
    const raiseBtn = html.match(
      /<button[^>]*>(?:(?!<\/button>)[\s\S])*?默认抬升(?:(?!<\/button>)[\s\S])*?<\/button>/
    )?.[0]
    const preserveBtn = html.match(
      /<button[^>]*>(?:(?!<\/button>)[\s\S])*?不改(?:(?!<\/button>)[\s\S])*?<\/button>/
    )?.[0]
    expect(raiseBtn).toBeDefined()
    expect(preserveBtn).toBeDefined()
    expect(raiseBtn).toContain(`aria-pressed="${!preserve}"`)
    expect(preserveBtn).toContain(`aria-pressed="${preserve}"`)
    expect(html).toContain('启用默认抬升与间隔补齐')
  })

  it('renders signature repair as read-only status with link to pool settings', () => {
    const offHtml = renderHealthPane({ failover: { signature_repair: false } })
    expect(offHtml).toContain('当前：已关闭')
    expect(offHtml).toContain('前往「账号池 → 重试与切号」调整')
    expect(offHtml).toContain('href="/settings/pool"')
    expect(offHtml).not.toContain('aria-label="签名修复"')

    const onHtml = renderHealthPane({ failover: { signature_repair: true } })
    expect(onHtml).toContain('当前：已开启')
  })
})

describe('Three-platform multi-model health probe settings', () => {
  it('renders independent Anthropic, OpenAI, and Google cards with all-models switches and legacy fallback', () => {
    const html = renderHealthPane({ healthProbe: { enabled: true } })

    expect(html).toContain('Anthropic 健康缓存')
    expect(html).toContain('OpenAI 健康缓存')
    expect(html).toContain('Google 健康缓存')

    // Legacy { enabled: true } activates Anthropic and Google (default gemini.enabled !== false), while OpenAI stays off with no model.
    const anthropicToggle = html.match(
      /<button[^>]*aria-label="启用 Anthropic 健康缓存"[^>]*>/
    )?.[0]
    expect(anthropicToggle).toContain('aria-checked="true"')

    const openaiToggle = html.match(
      /<button[^>]*aria-label="启用 OpenAI 健康缓存"[^>]*>/
    )?.[0]
    expect(openaiToggle).toContain('aria-checked="false"')

    const googleToggle = html.match(
      /<button[^>]*aria-label="启用 Google 健康缓存"[^>]*>/
    )?.[0]
    expect(googleToggle).toContain('aria-checked="true"')

    const googleInterval = html.match(
      /<input[^>]*aria-label="Google 探测间隔"[^>]*>/
    )?.[0]
    expect(googleInterval).toContain('value="3600"')

    const googleTtl = html.match(
      /<input[^>]*aria-label="Google 缓存有效期"[^>]*>/
    )?.[0]
    expect(googleTtl).toContain('value="5400"')

    for (const name of ['Anthropic', 'OpenAI', 'Google']) {
      expect(html).toContain(`aria-label="${name} 一键支持全部模型"`)
      expect(html).toContain(`aria-label="立即探测 ${name}"`)
      expect(html).toContain(`${name}：暂无`)
    }
  })

  it('reflects independent platform values, all_models badges, custom models, and per-model snapshots', () => {
    const html = renderHealthPane({
      healthProbe: {
        anthropic: {
          enabled: true,
          interval_sec: 300,
          cache_ttl_sec: 600,
          all_models: true,
          models: [],
        },
        openai: {
          enabled: true,
          interval_sec: 900,
          cache_ttl_sec: 1800,
          all_models: false,
          models: ['gpt-5.4', 'gpt-custom-preview'],
        },
        google: {
          enabled: false,
          interval_sec: 7200,
          cache_ttl_sec: 10800,
          all_models: false,
          models: ['gemini-3-flash'],
        },
      },
      probeStatus: {
        config: {},
        snapshot: null,
        catalog: {
          anthropic: [
            { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
            { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
          ],
          openai: [
            { id: 'gpt-5.4', label: 'GPT-5.4' },
            { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
          ],
          google: [
            { id: 'gemini-3-flash', label: 'Gemini 3 Flash', online: true },
            { id: 'gemini-4-neon', label: 'Gemini 4 Neon', online: false },
          ],
        },
        snapshots: {
          anthropic: {
            ok: true,
            at: '2026-11-28T00:00:00.000Z',
            stale: false,
            vm_id: 'vm-01',
            model: 'claude-haiku-4-5-20251001',
            error: null,
            age_ms: 1000,
            total_models: 2,
            ok_models: 1,
            failed_models: 1,
            stale_models: 0,
            models: [
              {
                ok: true,
                at: '2026-11-28T00:00:00.000Z',
                stale: false,
                vm_id: 'vm-01',
                model: 'claude-haiku-4-5-20251001',
                error: null,
                duration_ms: 320,
                age_ms: 1000,
              },
              {
                ok: false,
                at: '2026-11-28T00:00:01.000Z',
                stale: true,
                vm_id: 'vm-01',
                model: 'claude-sonnet-4-6',
                error: 'upstream_timeout',
                duration_ms: 5000,
                age_ms: 900,
              },
            ],
          },
          openai: {
            ok: true,
            at: '2026-11-28T00:00:00.000Z',
            stale: false,
            vm_id: 'vm-codex',
            model: 'gpt-5.4',
            error: null,
            age_ms: 1000,
            total_models: 1,
            ok_models: 1,
            failed_models: 0,
            stale_models: 0,
            models: [
              {
                ok: true,
                at: '2026-11-28T00:00:00.000Z',
                stale: false,
                vm_id: 'vm-codex',
                model: 'gpt-5.4',
                error: null,
                duration_ms: 410,
                age_ms: 1000,
              },
            ],
          },
          google: {
            ok: false,
            at: null,
            stale: true,
            vm_id: null,
            model: null,
            error: null,
            age_ms: null,
            total_models: 0,
            ok_models: 0,
            failed_models: 0,
            stale_models: 0,
            models: [],
          },
        },
      },
    })

    expect(html).toContain('已启用 2/3 平台')
    expect(
      html.match(
        /<button[^>]*aria-label="Anthropic 一键支持全部模型"[^>]*>/
      )?.[0]
    ).toContain('aria-checked="true"')
    expect(html).toContain('当前自动覆盖 2 个已启用模型')
    expect(html).toContain('claude-haiku-4-5-20251001')
    expect(html).toContain('claude-sonnet-4-6')
    expect(html).toContain('upstream_timeout')
    expect(html).toContain('可用 1/2')
    expect(html).toContain('gpt-custom-preview')
    expect(html).toContain('移除模型 gpt-custom-preview')
    expect(html).toContain('暂无在线槽位')
    expect(
      html.match(/<input[^>]*aria-label="OpenAI 探测间隔"[^>]*>/)?.[0]
    ).toContain('value="900"')
    expect(
      html.match(/<input[^>]*aria-label="Google 探测间隔"[^>]*>/)?.[0]
    ).toContain('value="7200"')
    expect(
      html.match(/<button[^>]*aria-label="启用 Google 健康缓存"[^>]*>/)?.[0]
    ).toContain('aria-checked="false"')
  })
})
