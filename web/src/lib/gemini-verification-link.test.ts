import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GeminiEnvironment } from '@/features/import/gemini-environments'
import { GeminiTestPanel } from '@/features/import/gemini-test-panel'
import { GeminiSlotStatus } from '@/features/vm/vm-rack-blade'
import { geminiEligibilityNotice } from './gemini-account-status'

const validation_url =
  'https://accounts.google.com/example-verification?fixture=synthetic'

describe('paid-tier verification link is an action, not an eligibility verdict', () => {
  it('keeps the official action available without claiming the account is blocked', () => {
    const notice = geminiEligibilityNotice({ validation_url })
    expect(notice?.validationUrl).toBe(validation_url)
    expect(notice?.advisory).toBe(true)
    expect(notice?.label).toContain('不代表当前账号不可用')
  })

  it('does not elevate advisory verification links into caution warnings on rack or test views', () => {
    const environment: GeminiEnvironment = {
      id: 'fixture-env',
      name: 'Fixture',
      proxy_id: 'fixture-proxy',
      auth_method: 'oauth',
      auth_state: 'authorized',
      proxy_ready: true,
      runtime_ready: true,
      billing_ready: false,
      kernel_version: '0.4.6',
      created_at: null,
      updated_at: null,
      models_discovered: true,
      models: ['gemini-4-neon'],
      account: {
        state: 'ok',
        checked_at: '2026-11-25T01:00:00Z',
        email: 'paid@example.test',
        project_id: 'proj-1',
        region: null,
        plan: 'Google AI Pro',
        expires_at: null,
        validation_url,
        quotas: [],
        credits: [],
      },
    }
    const rackHtml = renderToStaticMarkup(
      createElement(GeminiSlotStatus, {
        vm: { id: 'vm-gemini', gemini: environment } as Vm,
        inline: true,
      })
    )
    expect(rackHtml).not.toContain('var(--status-caution)')
    expect(rackHtml).toContain('>已发现 1 个模型</span>')
    expect(rackHtml).not.toContain('>Google 返回了账号核验链接')
    const panelHtml = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(GeminiTestPanel, { environment })
      )
    )
    expect(panelHtml).toContain(validation_url)
    expect(panelHtml).toContain('border-border bg-muted/40')
    expect(panelHtml).not.toContain('border-amber-500/40')
  })

  it('does not resurrect a stale action after a newer successful inference', () => {
    expect(
      geminiEligibilityNotice(
        { validation_url, checked_at: '2026-11-25T01:00:00Z' },
        {
          state: 'completed',
          finished_at: '2026-11-25T02:00:00Z',
        }
      )
    ).toBeNull()
    expect(
      geminiEligibilityNotice(
        { validation_url, checked_at: '2026-11-25T02:00:00Z' },
        {
          state: 'completed',
          finished_at: '2026-11-25T01:00:00Z',
        }
      )?.validationUrl
    ).toBe(validation_url)
    expect(
      geminiEligibilityNotice(
        { validation_url },
        {
          state: 'failed',
          finished_at: '2026-11-25T02:00:00Z',
        }
      )?.validationUrl
    ).toBe(validation_url)
  })

  it('does not display unsafe or missing URLs', () => {
    for (const url of [
      null,
      '',
      'http://accounts.google.com/check',
      'https://accounts.google.com.evil.test/check',
      'https://user@accounts.google.com/check',
      'https://accounts.google.com/check#fragment',
      'javascript:alert(1)',
    ]) {
      expect(geminiEligibilityNotice({ validation_url: url })).toBeNull()
    }
  })

  it('preserves blocking notices independently of link availability', () => {
    const blocking = geminiEligibilityNotice({
      eligibility: 'verification_required',
    })
    expect(blocking?.label).toContain('VALIDATION_REQUIRED')
    expect(blocking?.advisory).toBe(false)
    expect(
      geminiEligibilityNotice({
        eligibility: 'location_unsupported',
        validation_url,
      })?.validationUrl
    ).toBeNull()
  })
})
