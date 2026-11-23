import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { mapUpstreamError } from '../../src/lib/core/errors.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { classifyUpstreamResult, repairAnthropicRequest } from '../../src/lib/pool/upstream-error-policy.mjs'
import { prepareAnthropicRequest } from '../../src/lib/protocol/anthropic-policy.mjs'
import { applyMinMaxTokens } from '../../src/lib/protocol/min-max-tokens.mjs'
import { resetModelPolicy } from '../../src/lib/protocol/model-policy.mjs'
import { prepareCliHopBody, prepareOutboundEnvelope } from '../../src/lib/protocol/outbound-attempt.mjs'
import { MIN_THINKING_BUDGET, normalizeThinkingForModel } from '../../src/lib/protocol/thinking.mjs'
import { finalizeWorkerPayload } from '../../src/lib/transport/go-worker-client.mjs'

openDatabase({ dbPath: ':memory:' })
resetModelPolicy()
after(() => closeDatabase())

const MODEL = 'claude-haiku-4-5-20251001'
const ADAPTIVE_UNSUPPORTED = {
  status: 400,
  terminalState: 'rejected',
  body: {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'adaptive thinking is not supported on this model',
    },
  },
}

function makeHaikuAdaptiveRequest(maxTokens, extra = {}) {
  return {
    model: MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: 'hello' }],
    ...extra,
  }
}

function makeCandidate(id = '1') {
  return {
    ok: true,
    accountId: `account-${id}`,
    vmId: `vm-${id}`,
    selectionReason: 'round_robin',
    waitMs: 0,
    queueWaitMs: 0,
    schedulingMs: 0,
    exec: { homeDir: '' },
    release() {},
  }
}

function makeTestScheduler(candidates) {
  const cooldowns = []
  return {
    cooldowns,
    async selectAndReserve() {
      return candidates[0]
    },
    markSuccess() {},
    markCooldown(candidate, opts) {
      cooldowns.push({ candidate, opts })
    },
    releaseAccountSessions() {},
  }
}

test('adaptive retry on Haiku 4.5 bounds platform budget_tokens below caller max_tokens (2048, 4096, 4097, 8192)', () => {
  const cases = [
    [2048, 1024],
    [4096, 2048],
    [4097, 2048],
    [8192, 4096],
  ]
  for (const effort of [undefined, 'medium']) {
    for (const [maxTokens, expectedBudget] of cases) {
      const inbound = makeHaikuAdaptiveRequest(maxTokens, effort ? { output_config: { effort } } : {})
      const floored = applyMinMaxTokens(inbound, {})
      assert.equal(floored.max_tokens, maxTokens)

      const policy = classifyUpstreamResult(ADAPTIVE_UNSUPPORTED, { model: MODEL, requestBody: floored })
      assert.equal(policy.action, 'repair-and-retry')
      assert.equal(policy.reason, 'thinking_repairable')

      const retry = repairAnthropicRequest(floored, policy)
      assert.equal(retry.max_tokens, maxTokens)
      assert.equal(retry.thinking.type, 'enabled')
      assert.equal(retry.thinking.budget_tokens, expectedBudget)
      assert.ok(retry.thinking.budget_tokens >= MIN_THINKING_BUDGET)
      assert.ok(retry.thinking.budget_tokens < retry.max_tokens)

      const cragPayload = finalizeWorkerPayload({
        body: retry,
        reqHeaders: {},
        exec: {
          homeDir: '',
          vm: { claude: { mode: 'setup-token' } },
          workerStatus: { runtime_variant: 'crag-v2', capabilities: ['generation_controls_v3'] },
        },
        identity: null,
        routing: {},
        cliHop: true,
        cragPrint: true,
        repaired: true,
      }).body
      assert.equal(cragPayload.max_tokens, maxTokens)
      assert.equal(cragPayload.thinking.type, 'enabled')
      assert.equal(cragPayload.thinking.budget_tokens, expectedBudget)
      assert.ok(cragPayload.thinking.budget_tokens < cragPayload.max_tokens)

      const httpOutbound = prepareOutboundEnvelope({
        canonicalBody: floored,
        inbound: floored,
        identity: {},
        unofficial: true,
        stream: false,
      }).body
      assert.equal(httpOutbound.max_tokens, maxTokens)
      assert.equal(httpOutbound.thinking.type, 'enabled')
      assert.equal(httpOutbound.thinking.budget_tokens, expectedBudget)
      assert.ok(httpOutbound.thinking.budget_tokens < httpOutbound.max_tokens)
    }
  }
})

test('adaptive conversion on Haiku 4.5 rejects max_tokens <= 1024 instead of generating an invalid budget', () => {
  const genericRepairPolicy = classifyUpstreamResult(ADAPTIVE_UNSUPPORTED, {})
  assert.equal(genericRepairPolicy.reason, 'thinking_repairable')

  for (const maxTokens of [128, 512, 1024]) {
    const input = applyMinMaxTokens(makeHaikuAdaptiveRequest(maxTokens), {})
    assert.equal(input.max_tokens, maxTokens)

    const classified = classifyUpstreamResult(ADAPTIVE_UNSUPPORTED, { model: MODEL, requestBody: input })
    assert.equal(classified.scope, 'request')
    assert.equal(classified.action, 'stop')
    assert.equal(classified.reason, 'thinking_incompatible')
    assert.equal(classified.cooldownUntil, null)

    const before = structuredClone(input)
    for (const transform of [
      (body) => repairAnthropicRequest(body, genericRepairPolicy),
      (body) => normalizeThinkingForModel(body),
      (body) => prepareAnthropicRequest(body),
    ]) {
      assert.throws(
        () => transform(input),
        (err) =>
          err.status === 400 &&
          err.code === 'thinking_incompatible' &&
          err.body?.error?.code === 'thinking_incompatible' &&
          err.body?.error?.param === 'max_tokens' &&
          err.body?.error?.details?.retryable === false,
      )
      assert.deepEqual(input, before)
    }
  }
})

test('FailoverRunner stops cleanly without a second hop when Haiku adaptive retry has max_tokens = 1024', async () => {
  const scheduler = makeTestScheduler([makeCandidate('1')])
  const attempts = []
  const runner = new FailoverRunner({
    scheduler,
    attemptsRepo: {
      begin() {},
      complete(_reqId, attemptNo, row) {
        attempts.push({ attemptNo, ...row })
      },
    },
  })
  const input = applyMinMaxTokens(makeHaikuAdaptiveRequest(1024), {})
  const hops = []
  const result = await runner.run({
    requestId: 'haiku-1024-no-retry',
    model: MODEL,
    canonicalBody: input,
    applyAttempt: (body, _selected, extra) => {
      let next = body
      for (const policy of extra.repairs || []) next = repairAnthropicRequest(next, policy)
      return prepareCliHopBody(next, { repaired: extra.repaired })
    },
    callAttempt: ({ body }) => {
      hops.push(structuredClone(body))
      return { ...ADAPTIVE_UNSUPPORTED, upstreamExecutions: 1 }
    },
  })

  assert.equal(hops.length, 1)
  assert.equal(hops[0].thinking.type, 'adaptive')
  assert.equal(result.ok, false)
  assert.equal(result.status, 400)
  assert.equal(result.attemptCount, 1)
  assert.equal(result.body.error.code, 'thinking_incompatible')
  assert.equal(result.body.error.param, 'max_tokens')
  assert.equal(result.body.error.details.retryable, false)
  assert.match(result.body.error.message, /1024/)
  assert.deepEqual(scheduler.cooldowns, [])
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].action, 'stop')
  assert.equal(attempts[0].errorScope, 'request')

  const mapped = mapUpstreamError(result.status, result.body)
  assert.equal(mapped.status, 400)
  assert.equal(mapped.body.error.code, 'thinking_incompatible')
  assert.equal(mapped.body.error.param, 'max_tokens')
  assert.equal(mapped.body.error.details.retryable, false)
})

test('FailoverRunner repairs and retries Haiku adaptive thinking with valid bounded budgets for max_tokens = 2048, 4096, 4097', async () => {
  for (const [maxTokens, expectedBudget] of [
    [2048, 1024],
    [4096, 2048],
    [4097, 2048],
  ]) {
    const scheduler = makeTestScheduler([makeCandidate('1')])
    const runner = new FailoverRunner({ scheduler })
    const input = applyMinMaxTokens(makeHaikuAdaptiveRequest(maxTokens, { output_config: { effort: 'medium' } }), {})
    const hops = []
    const result = await runner.run({
      requestId: `haiku-retry-${maxTokens}`,
      model: MODEL,
      canonicalBody: input,
      applyAttempt: (body, _selected, extra) => {
        let next = body
        for (const policy of extra.repairs || []) next = repairAnthropicRequest(next, policy)
        return prepareCliHopBody(next, { repaired: extra.repaired })
      },
      callAttempt: ({ body, attemptNo }) => {
        hops.push(structuredClone(body))
        if (attemptNo === 1) return { ...ADAPTIVE_UNSUPPORTED, upstreamExecutions: 1 }
        assert.equal(body.max_tokens, maxTokens)
        assert.equal(body.thinking.type, 'enabled')
        assert.equal(body.thinking.budget_tokens, expectedBudget)
        assert.ok(body.thinking.budget_tokens >= MIN_THINKING_BUDGET && body.thinking.budget_tokens < body.max_tokens)
        return {
          ok: true,
          status: 200,
          terminalState: 'verified',
          upstreamExecutions: 1,
          body: {
            id: `msg_${maxTokens}`,
            type: 'message',
            role: 'assistant',
            model: MODEL,
            content: [{ type: 'text', text: 'hello' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        }
      },
    })

    assert.equal(result.ok, true)
    assert.equal(result.attemptCount, 2)
    assert.equal(hops.length, 2)
    assert.equal(hops[0].thinking.type, 'adaptive')
    assert.equal(hops[1].thinking.type, 'enabled')
    assert.equal(hops[1].thinking.budget_tokens, expectedBudget)
    assert.equal(hops[1].max_tokens, maxTokens)
    assert.deepEqual(scheduler.cooldowns, [])
  }
})

test('explicit caller budget_tokens and initial cli-hop passthrough remain unchanged', () => {
  const explicitEnabled = prepareAnthropicRequest({
    model: MODEL,
    max_tokens: 256,
    thinking: { type: 'enabled', budget_tokens: 200 },
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(explicitEnabled.thinking.type, 'enabled')
  assert.equal(explicitEnabled.thinking.budget_tokens, 200)
  assert.equal(explicitEnabled.max_tokens, 256)

  const explicitAdaptive = normalizeThinkingForModel({
    model: MODEL,
    max_tokens: 2048,
    thinking: { type: 'adaptive', budget_tokens: 1500 },
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(explicitAdaptive.thinking.type, 'enabled')
  assert.equal(explicitAdaptive.thinking.budget_tokens, 1500)
  assert.equal(explicitAdaptive.max_tokens, 2048)

  const cliHopInitial = prepareCliHopBody(makeHaikuAdaptiveRequest(1024))
  assert.equal(cliHopInitial.thinking.type, 'adaptive')
  assert.equal(cliHopInitial.max_tokens, 1024)
})
