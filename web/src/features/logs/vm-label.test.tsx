import type { UsageLogRow } from '@/types/panel-usage-logs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOGS_TABLE_COLUMNS } from '@/features/logs/column-visibility'
import { LogicTraceTab } from '@/features/logs/log-detail/logic-trace-tab'

function row(): UsageLogRow {
  return {
    id: 'log_1',
    requestId: 'req_1',
    createdAt: '2026-11-21T00:00:00.000Z',
    userId: null,
    userName: null,
    keyId: null,
    keyName: null,
    sessionId: null,
    clientSessionId: null,
    inboundDeviceId: null,
    providerName: 'slot-a',
    accountId: null,
    vmId: 'vm-1',
    vmName: 'slot-a',
    model: 'claude',
    originalModel: 'claude',
    actualResponseModel: null,
    modelMismatch: null,
    endpoint: '/v1/messages',
    protocol: 'anthropic',
    method: 'POST',
    statusCode: 200,
    logMode: 'normal',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    cacheTtlApplied: null,
    totalTokens: 0,
    costUsd: null,
    actualCostUsd: null,
    groupCostMultiplier: null,
    costBreakdown: null,
    durationMs: 10,
    firstByteMs: null,
    ttftMs: null,
    generationMs: null,
    stopReason: null,
    attemptCount: 1,
    finalState: 'success',
    via: null,
    stream: true,
    hasTools: false,
    serviceTier: null,
    upstreamServiceTier: null,
    speed: null,
    context1mApplied: null,
    reasoningEffort: null,
    errorClass: null,
    errorLabel: null,
    errorOwner: null,
    errorCode: null,
    errorMessage: null,
    jevState: null,
    blockedBy: null,
    blockedReason: null,
    userAgent: null,
    clientIp: null,
    apiKeyPresented: null,
    specialSettings: [],
    providerChain: [
      {
        attemptNumber: 1,
        vmId: 'vm-1',
        vmName: 'slot-a',
        accountId: null,
        providerName: null,
        model: 'claude',
        selectionReason: null,
        upstreamStatus: 200,
        errorScope: null,
        terminalState: 'success',
        action: null,
        downstreamCommitted: true,
        waitMs: null,
        queueWaitMs: null,
        schedulingMs: null,
        ttftMs: null,
        latencyMs: 10,
        startedAt: '2026-11-21T00:00:00.000Z',
        completedAt: '2026-11-21T00:00:00.010Z',
      },
    ],
  }
}

describe('request log virtual machine labels', () => {
  it('names the request log column and decision chain as virtual machines', () => {
    expect(LOGS_TABLE_COLUMNS.find((col) => col.id === 'provider')?.label).toBe(
      '虚拟机'
    )

    const html = renderToStaticMarkup(<LogicTraceTab row={row()} />)

    expect(html).toContain('1 台虚拟机')
    expect(html).not.toContain('供应商')
  })
})
