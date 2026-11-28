import type { UsageLogRow } from '@/types/panel-usage-logs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SummaryTab } from './summary-tab'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}))

function baseRow(overrides: Partial<UsageLogRow> = {}): UsageLogRow {
  return {
    id: 'log_1',
    requestId: 'req_1',
    createdAt: '2026-11-26T00:00:00.000Z',
    userId: null,
    userName: null,
    keyId: null,
    keyName: null,
    sessionId: null,
    clientSessionId: null,
    inboundDeviceId: null,
    upstreamStatus: 409,
    providerName: null,
    accountId: null,
    vmId: 'vm-11',
    vmName: 'Slot 11',
    model: 'claude-sonnet-4-6',
    originalModel: 'claude-sonnet-4-6',
    actualResponseModel: null,
    modelMismatch: 0,
    endpoint: '/v1/messages',
    protocol: 'anthropic.messages',
    method: 'POST',
    statusCode: 409,
    logMode: 'normal',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    cacheTtlApplied: null,
    totalTokens: 0,
    costUsd: null,
    actualCostUsd: null,
    groupCostMultiplier: null,
    costBreakdown: null,
    durationMs: 120,
    firstByteMs: null,
    ttftMs: null,
    generationMs: null,
    stopReason: null,
    attemptCount: 1,
    finalState: 'rejected',
    via: 'rust-kernel',
    stream: false,
    hasTools: false,
    serviceTier: null,
    upstreamServiceTier: null,
    speed: null,
    context1mApplied: null,
    reasoningEffort: null,
    errorClass: 'request',
    errorLabel: '请求格式',
    errorOwner: 'client',
    errorCode: 'partial_provider_output_nonretryable',
    errorMessage: 'Provider output interrupted',
    upstreamType: 'partial_provider_output_nonretryable',
    errorDetails: {
      upstream_type: 'partial_provider_output_nonretryable',
      retryable: false,
      prior_reason: 'client_cancelled',
      interrupted_at: 1795495209,
      retry_after_sec: 20,
      recovery_attempts: 1,
      max_recoveries: 2,
      recovery_exhausted: false,
    },
    jevState: null,
    blockedBy: null,
    blockedReason: null,
    userAgent: null,
    clientIp: null,
    apiKeyPresented: null,
    specialSettings: [],
    providerChain: [],
    ...overrides,
  }
}

describe('SummaryTab structured error diagnostics (#1845)', () => {
  it('renders upstreamType and #1705 errorDetails badges in normal mode', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SummaryTab row={baseRow()} scrollToRedirect={false} />
      </TooltipProvider>
    )
    expect(html).toContain('partial_provider_output_nonretryable')
    expect(html).toContain('prior_reason=client_cancelled')
    expect(html).toContain('retry_after_sec=20')
    expect(html).toContain('recovery_attempts=1')
    expect(html).toContain('max_recoveries=2')
    expect(html).toContain('recovery_exhausted=false')
  })

  it('renders risk audit card with disguised 429, gate_miss, JEV scores, and device/session', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SummaryTab
          row={baseRow({
            statusCode: 429,
            via: 'jev',
            finalState: 'policy_blocked',
            errorCode: 'policy_blocked',
            inboundDeviceId: 'dev-audit-01',
            clientSessionId: 'sess-audit-01',
            errorDetails: {
              gate_miss: true,
              risk_bucket: 'policy_suspect',
              jev_score_usage_policy: 0.91,
              jev_score_abuse: 0.12,
            },
          })}
          scrollToRedirect={false}
        />
      </TooltipProvider>
    )
    expect(html).toContain('风控与审核裁决')
    expect(html).toContain('429（伪装负载）')
    expect(html).toContain('内部裁决 jev')
    expect(html).toContain('前置放行后上游拒答（漏放）')
    expect(html).toContain('使用政策: 0.91')
    expect(html).toContain('破限与攻击: 0.12')
    expect(html).toContain('dev-audit-01')
    expect(html).toContain('sess-audit-01')
  })

  it('renders upstream 400 classification category and action badges in risk audit card', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SummaryTab
          row={baseRow({
            statusCode: 400,
            upstreamStatus: 400,
            via: 'go-worker-pool',
            finalState: 'upstream_error',
            errorCode: 'upstream_invalid_request',
            errorDetails: {
              risk_bucket: 'protocol',
              upstream_400_category: 'tool_pair_broken',
              upstream_400_action: 'session_10m',
              punishment: 'session_10m_400',
            },
          })}
          scrollToRedirect={false}
        />
      </TooltipProvider>
    )
    expect(html).toContain('400 分类：工具调用历史配对损坏')
    expect(html).toContain('已封锁会话 10 分钟')
  })
})
