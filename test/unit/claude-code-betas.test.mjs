import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BETA_OAUTH,
  BETA_CLAUDE_CODE,
  BETA_INTERLEAVED,
  BETA_CONTEXT_MANAGEMENT,
  HAIKU_BETA_HEADER,
  DEFAULT_BETA_HEADER,
  API_KEY_BETAS,
  defaultOfficialBetaHeader,
  joinBetas,
  stripOauthBeta,
  apiKeyBetaHeader,
  setupTokenBetaHeader,
  ensureMimicryBetas,
  ensureOauthBeta,
  withRequestProtocolBetas,
} from '../../src/lib/protocol/claude-code-betas.mjs'

test('defaultOfficialBetaHeader keeps the short header on legacy haiku only', () => {
  assert.equal(defaultOfficialBetaHeader('claude-haiku-4-5'), HAIKU_BETA_HEADER)
  assert.equal(defaultOfficialBetaHeader('claude-haiku-5'), DEFAULT_BETA_HEADER)
  assert.equal(defaultOfficialBetaHeader('claude-haiku-5-5'), DEFAULT_BETA_HEADER)
  assert.equal(defaultOfficialBetaHeader('sonnet'), DEFAULT_BETA_HEADER)
  assert.equal(defaultOfficialBetaHeader(''), DEFAULT_BETA_HEADER)
  assert.equal(defaultOfficialBetaHeader(), DEFAULT_BETA_HEADER)
})

test('joinBetas filters falsy and joins with comma', () => {
  assert.equal(joinBetas(['a', '', 'b', null, 'c']), 'a,b,c')
  assert.equal(joinBetas([]), '')
  assert.equal(joinBetas(), '')
  assert.equal(joinBetas(['a']), 'a')
})

test('stripOauthBeta removes oauth-2025-04-20 and trims whitespace', () => {
  assert.equal(stripOauthBeta(`${BETA_OAUTH},${BETA_INTERLEAVED}`), BETA_INTERLEAVED)
  assert.equal(
    stripOauthBeta(`${BETA_CLAUDE_CODE}, ${BETA_OAUTH} ,${BETA_INTERLEAVED}`),
    `${BETA_CLAUDE_CODE},${BETA_INTERLEAVED}`,
  )
  assert.equal(stripOauthBeta(BETA_OAUTH), '')
  assert.equal(stripOauthBeta(''), '')
  assert.equal(stripOauthBeta(), '')
  assert.equal(stripOauthBeta(BETA_CLAUDE_CODE), BETA_CLAUDE_CODE)
})

test('apiKeyBetaHeader strips oauth and falls back to API_KEY_BETAS when empty', () => {
  assert.equal(apiKeyBetaHeader(''), API_KEY_BETAS.join(','))
  assert.equal(apiKeyBetaHeader(), API_KEY_BETAS.join(','))
  assert.equal(apiKeyBetaHeader(BETA_OAUTH), API_KEY_BETAS.join(','))
  assert.equal(apiKeyBetaHeader(`${BETA_CLAUDE_CODE},${BETA_OAUTH}`), BETA_CLAUDE_CODE)
  assert.equal(apiKeyBetaHeader(`${BETA_CLAUDE_CODE},${BETA_INTERLEAVED}`), `${BETA_CLAUDE_CODE},${BETA_INTERLEAVED}`)
})

test('setupTokenBetaHeader uses the short haiku set only for legacy haiku', () => {
  assert.equal(setupTokenBetaHeader('claude-haiku-4-5'), HAIKU_BETA_HEADER)
  assert.equal(setupTokenBetaHeader('claude-haiku-5-5'), `${BETA_OAUTH},${BETA_INTERLEAVED},${BETA_CONTEXT_MANAGEMENT}`)
  assert.equal(setupTokenBetaHeader('claude-sonnet-5'), `${BETA_OAUTH},${BETA_INTERLEAVED},${BETA_CONTEXT_MANAGEMENT}`)
  assert.equal(setupTokenBetaHeader(''), `${BETA_OAUTH},${BETA_INTERLEAVED},${BETA_CONTEXT_MANAGEMENT}`)
})

test('ensureMimicryBetas appends missing required tokens without duplicating', () => {
  // Empty header gets all required tokens
  assert.equal(ensureMimicryBetas(''), DEFAULT_BETA_HEADER)
  // Header already has the full set is unchanged
  assert.equal(ensureMimicryBetas(DEFAULT_BETA_HEADER), DEFAULT_BETA_HEADER)
  // Partial header gets the missing tokens appended
  const partial = `${BETA_CLAUDE_CODE},${BETA_OAUTH}`
  const result = ensureMimicryBetas(partial)
  assert.ok(result.startsWith(partial))
  assert.ok(result.includes(BETA_INTERLEAVED))
  // No duplicates
  const parts = result.split(',')
  assert.equal(parts.length, new Set(parts).size)
})

test('ensureMimicryBetas accepts a custom required set', () => {
  const custom = `${BETA_CLAUDE_CODE},${BETA_OAUTH}`
  assert.equal(ensureMimicryBetas(BETA_CLAUDE_CODE, custom), custom)
  assert.equal(ensureMimicryBetas('', BETA_OAUTH), BETA_OAUTH)
})

test('ensureOauthBeta inserts oauth after claude-code when present', () => {
  // Already has oauth: unchanged (after trim)
  assert.equal(
    ensureOauthBeta(`${BETA_CLAUDE_CODE},${BETA_OAUTH},${BETA_INTERLEAVED}`),
    `${BETA_CLAUDE_CODE},${BETA_OAUTH},${BETA_INTERLEAVED}`,
  )
  // claude-code present but oauth missing: insert after claude-code
  assert.equal(
    ensureOauthBeta(`${BETA_CLAUDE_CODE},${BETA_INTERLEAVED}`),
    `${BETA_CLAUDE_CODE},${BETA_OAUTH},${BETA_INTERLEAVED}`,
  )
  // No claude-code: prepend oauth
  assert.equal(
    ensureOauthBeta(`${BETA_INTERLEAVED},${BETA_CONTEXT_MANAGEMENT}`),
    `${BETA_OAUTH},${BETA_INTERLEAVED},${BETA_CONTEXT_MANAGEMENT}`,
  )
  // Empty header stays empty
  assert.equal(ensureOauthBeta(''), '')
  assert.equal(ensureOauthBeta(), '')
})

test('request gates preserve caller opt-ins and remain isolated between requests', () => {
  const enabled = withRequestProtocolBetas(['caller-beta', 'caller-beta'], {
    model: 'claude-opus-5-5',
    thinking: { type: 'adaptive', display: 'updates', block_binding: {} },
    safeguards: [{ type: 'dangerous_tool_use' }],
    output_config: { effort: 'medium', format: { type: 'json_schema' }, task_budget: { total: 10 } },
    tools: [{ defer_loading: true, strict: true }],
    thread: { id: 'thread_1' },
    diagnostics: { previous_message_id: 'msg_1' },
    cache_control: { type: 'ephemeral', evict_on_complete: true },
    messages: [
      {
        role: 'system',
        clear_at: 0,
        content: [{ type: 'text', text: 'reminder', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      },
    ],
  })
  for (const beta of [
    'thinking-display-updates-2026-08-18',
    'dangerous-tool-use-2026-09-03',
    'thinking-binding-controls-2026-08-01',
    'effort-2025-11-24',
    'structured-outputs-2025-12-15',
    'task-budgets-2026-03-13',
    'advanced-tool-use-2025-11-20',
    'message-threads-2026-08-12',
    'cache-diagnosis-2026-04-07',
    'prompt-caching-evict-2026-05-12',
    'extended-cache-ttl-2025-04-11',
    'mid-conversation-system-clear-at-2026-08-21',
    'per-turn-control-2026-07-01',
    'mid-conversation-tool-changes-2026-07-01',
  ])
    assert.ok(enabled.includes(beta), beta)
  assert.equal(enabled.filter((beta) => beta === 'caller-beta').length, 1)
  assert.ok(!enabled.includes('timing-2026-09-09'))
  assert.deepEqual(withRequestProtocolBetas(['caller-beta'], { model: 'claude-sonnet-4-6' }), ['caller-beta'])
})

test('auto gets tool-changes because it is absent from the catalog and not per-turn', () => {
  const auto = withRequestProtocolBetas(['caller-beta'], { model: 'auto' })
  assert.deepEqual(auto, ['caller-beta', 'mid-conversation-tool-changes-2026-07-01'])
})
test('a cache scope adds prompt-caching-scope and a bare marker does not', () => {
  const scoped = withRequestProtocolBetas([], {
    system: [{ type: 'text', text: 'harness', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } }],
  })
  assert.ok(scoped.includes('prompt-caching-scope-2026-01-05'))
  const plain = withRequestProtocolBetas([], {
    system: [{ type: 'text', text: 'harness', cache_control: { type: 'ephemeral' } }],
  })
  assert.ok(!plain.includes('prompt-caching-scope-2026-01-05'))
})

test('explicit fallback requests arm only the corresponding server beta', () => {
  const defaultFallback = withRequestProtocolBetas([], { fallbacks: 'default' })
  assert.ok(defaultFallback.includes('server-side-fallback-2026-07-01'))
  assert.ok(!defaultFallback.includes('server-side-fallback-2026-06-01'))
  const explicitFallback = withRequestProtocolBetas([], {
    fallbacks: [{ model: 'claude-sonnet-5-5' }],
  })
  assert.ok(explicitFallback.includes('server-side-fallback-2026-06-01'))
  assert.ok(!explicitFallback.includes('server-side-fallback-2026-07-01'))
  assert.deepEqual(withRequestProtocolBetas([], { fallbacks: [] }), [])
  assert.deepEqual(withRequestProtocolBetas([], {}), [])
})

test('credit replay arms its beta only for an official bounded token', () => {
  const creditBeta = 'fallback-credit-2026-06-01'
  assert.ok(withRequestProtocolBetas([], { fallback_credit_token: 'credit' }).includes(creditBeta))
  assert.ok(withRequestProtocolBetas([], { fallback_credit_token: 'x'.repeat(2048) }).includes(creditBeta))
  for (const token of ['', 'x'.repeat(2049), null, 42]) {
    assert.ok(!withRequestProtocolBetas([], { fallback_credit_token: token }).includes(creditBeta))
  }
  assert.deepEqual(withRequestProtocolBetas([creditBeta], { fallback_credit_token: 'credit' }), [creditBeta])
  assert.deepEqual(withRequestProtocolBetas([], {}), [])
})
